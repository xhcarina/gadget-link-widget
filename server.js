import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative, extname, basename } from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic();

const CODE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.swift',
  '.kt', '.scala', '.vue', '.svelte', '.astro', '.mjs', '.cjs',
]);

const IMPORT_PATTERNS = [
  /import\s+.*?from\s+['"](.+?)['"]/g,
  /import\s+['"](.+?)['"]/g,
  /require\s*\(\s*['"](.+?)['"]\s*\)/g,
  /from\s+(\S+)\s+import/g,
];

async function walkDir(dirPath, baseDir = dirPath) {
  const entries = [];
  let items;
  try {
    items = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return entries;
  }

  const skipDirs = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build']);

  for (const item of items) {
    const fullPath = join(dirPath, item.name);
    const relPath = relative(baseDir, fullPath);

    if (item.isDirectory()) {
      if (skipDirs.has(item.name)) continue;
      entries.push({ name: item.name, path: relPath, type: 'directory', children: await walkDir(fullPath, baseDir) });
    } else {
      entries.push({ name: item.name, path: relPath, type: 'file' });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

// POST /api/scan - scan a folder and return file tree
app.post('/api/scan', async (req, res) => {
  try {
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'folderPath is required' });

    const info = await stat(folderPath);
    if (!info.isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });

    const tree = await walkDir(folderPath);
    res.json({ tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/file - read a file's contents
app.post('/api/file', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath is required' });

    const content = await readFile(filePath, 'utf-8');
    res.json({ content, extension: extname(filePath) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dependencies - analyze dependencies in a folder
app.post('/api/dependencies', async (req, res) => {
  try {
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'folderPath is required' });

    const deps = {};
    const externalDeps = new Set();

    async function scanFile(fullPath, relPath) {
      const ext = extname(fullPath);
      if (!CODE_EXTENSIONS.has(ext)) return;

      let content;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        return;
      }

      const fileDeps = [];
      for (const pattern of IMPORT_PATTERNS) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(content)) !== null) {
          const dep = match[1];
          if (dep.startsWith('.') || dep.startsWith('/')) {
            fileDeps.push(dep);
          } else {
            externalDeps.add(dep.split('/')[0]);
          }
        }
      }

      if (fileDeps.length > 0) {
        deps[relPath] = fileDeps;
      }
    }

    async function scanDir(dirPath, baseDir) {
      let items;
      try {
        items = await readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }
      const skipDirs = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build']);
      for (const item of items) {
        const fullPath = join(dirPath, item.name);
        const relPath = relative(baseDir, fullPath);
        if (item.isDirectory()) {
          if (!skipDirs.has(item.name)) await scanDir(fullPath, baseDir);
        } else {
          await scanFile(fullPath, relPath);
        }
      }
    }

    await scanDir(folderPath, folderPath);

    // Try to read package.json or requirements.txt for external deps
    let packageDeps = {};
    try {
      const pkg = JSON.parse(await readFile(join(folderPath, 'package.json'), 'utf-8'));
      packageDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch { /* no package.json */ }

    let requirementsTxt = [];
    try {
      const txt = await readFile(join(folderPath, 'requirements.txt'), 'utf-8');
      requirementsTxt = txt.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('==')[0].split('>=')[0].trim());
    } catch { /* no requirements.txt */ }

    res.json({
      internalDeps: deps,
      externalDeps: [...externalDeps],
      packageJsonDeps: packageDeps,
      requirementsTxtDeps: requirementsTxt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rewrite - LLM-powered code rewrite
app.post('/api/rewrite', async (req, res) => {
  try {
    const { code, annotations, fileName } = req.body;
    if (!code) return res.status(400).json({ error: 'code is required' });

    const annotatedLines = code.split('\n').map((line, i) => {
      const lineNum = i + 1;
      const annotation = annotations?.[lineNum];
      if (annotation === 'keep') return `@keep | ${line}`;
      if (annotation === 'edit') return `@edit | ${line}`;
      return `      | ${line}`;
    }).join('\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `You are a code refactoring assistant. Refactor the following code from file "${fileName || 'unknown'}".

Rules:
- Lines marked @keep MUST remain exactly as they are (do not change anything on those lines)
- Lines marked @edit should be refactored/improved
- Unmarked lines: use your judgment to improve if beneficial
- Fix naming consistency (use the dominant convention in the file)
- Clean up formatting and improve readability
- Remove dead code or unnecessary complexity
- Keep the same functionality

Return ONLY the refactored code, no explanations or markdown fences.

${annotatedLines}`
      }],
    });

    const rewritten = message.content[0].text;
    res.json({ rewritten });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/architecture - generate architecture wiki
app.post('/api/architecture', async (req, res) => {
  try {
    const { folderPath } = req.body;
    if (!folderPath) return res.status(400).json({ error: 'folderPath is required' });

    // Gather folder structure and key file contents
    const fileContents = [];
    let totalChars = 0;
    const MAX_CHARS = 80000;

    async function gatherFiles(dirPath, baseDir) {
      let items;
      try {
        items = await readdir(dirPath, { withFileTypes: true });
      } catch {
        return;
      }
      const skipDirs = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build']);
      for (const item of items) {
        if (totalChars > MAX_CHARS) return;
        const fullPath = join(dirPath, item.name);
        const relPath = relative(baseDir, fullPath);
        if (item.isDirectory()) {
          if (!skipDirs.has(item.name)) await gatherFiles(fullPath, baseDir);
        } else if (CODE_EXTENSIONS.has(extname(fullPath)) || ['package.json', 'requirements.txt', 'README.md', 'Cargo.toml', 'go.mod'].includes(basename(fullPath))) {
          try {
            const content = await readFile(fullPath, 'utf-8');
            if (content.length < 10000) {
              fileContents.push({ path: relPath, content });
              totalChars += content.length;
            } else {
              fileContents.push({ path: relPath, content: content.slice(0, 3000) + '\n... (truncated)' });
              totalChars += 3000;
            }
          } catch { /* skip unreadable files */ }
        }
      }
    }

    await gatherFiles(folderPath, folderPath);

    const filesContext = fileContents.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Analyze this codebase and generate an architecture wiki summary in Markdown.

Include these sections:
## Project Overview
Brief description of what this project does.

## Module Descriptions
Description of each major module/directory and its purpose.

## Data Flow
Text-based diagram showing how data flows through the system.

## Key Patterns & Conventions
Notable patterns, naming conventions, and architectural decisions.

## File Structure
Annotated file tree.

Here are the project files:

${filesContext}`
      }],
    });

    const wiki = message.content[0].text;
    res.json({ wiki });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/architecture-inline - generate wiki from uploaded file contents
app.post('/api/architecture-inline', async (req, res) => {
  try {
    const { files } = req.body;
    if (!files || Object.keys(files).length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const filesContext = Object.entries(files)
      .map(([name, content]) => `--- ${name} ---\n${content}`)
      .join('\n\n');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Analyze this codebase and generate an architecture wiki summary in Markdown.

Include these sections:
## Project Overview
Brief description of what this project does.

## Module Descriptions
Description of each major module/directory and its purpose.

## Data Flow
Text-based diagram showing how data flows through the system.

## Key Patterns & Conventions
Notable patterns, naming conventions, and architectural decisions.

## File Structure
Annotated file tree.

Here are the project files:

${filesContext}`
      }],
    });

    const wiki = message.content[0].text;
    res.json({ wiki });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Gadget Link Widget running at http://localhost:${PORT}`);
});
