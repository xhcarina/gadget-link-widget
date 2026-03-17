// State
const state = {
  folderPath: '',
  currentFile: null,
  currentCode: '',
  annotations: {},
  rewrittenCode: null,
  uploadedFiles: {},
};

// Binary file extensions to skip
const BINARY_EXTS = new Set([
  'png','jpg','jpeg','gif','bmp','ico','svg','webp','mp3','mp4','wav',
  'avi','mov','zip','tar','gz','rar','7z','exe','dll','so','dylib',
  'pdf','doc','docx','xls','xlsx','ppt','pptx','woff','woff2','ttf',
  'eot','otf','class','jar','pyc','o','obj',
]);

function isBinaryFile(name) {
  const ext = name.split('.').pop().toLowerCase();
  return BINARY_EXTS.has(ext);
}

// DOM Elements
const folderInput = document.getElementById('folder-input');
const scanBtn = document.getElementById('scan-btn');
const fileTree = document.getElementById('file-tree');
const codeArea = document.getElementById('code-area');
const currentFileLabel = document.getElementById('current-file-label');
const clearAnnotationsBtn = document.getElementById('clear-annotations-btn');

const tabs = document.querySelectorAll('.tab');
const tabContents = document.querySelectorAll('.tab-content');

const runDepsBtn = document.getElementById('run-deps-btn');
const depsResult = document.getElementById('deps-result');
const runRewriteBtn = document.getElementById('run-rewrite-btn');
const rewriteResult = document.getElementById('rewrite-result');
const rewriteControls = document.getElementById('rewrite-controls');
const acceptBtn = document.getElementById('accept-btn');
const rejectBtn = document.getElementById('reject-btn');
const runWikiBtn = document.getElementById('run-wiki-btn');
const wikiResult = document.getElementById('wiki-result');

// ---- Utility ----
async function api(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Request failed');
  }
  return res.json();
}

function setLoading(container, message) {
  container.innerHTML = `<span class="spinner"></span><span class="loading-text">${message}</span>`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- Tab Switching ----
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ---- Folder Scanning (server mode) ----
scanBtn.addEventListener('click', scanFolder);
folderInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') scanFolder();
});

async function scanFolder() {
  const path = folderInput.value.trim();
  if (!path) return;
  state.folderPath = path;
  fileTree.innerHTML = '<div class="placeholder">Scanning...</div>';
  try {
    const data = await api('/api/scan', { folderPath: path });
    renderTree(data.tree, fileTree, path);
  } catch (err) {
    fileTree.innerHTML = `<div class="placeholder" style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  }
}

function renderTree(items, container, basePath, depth = 0) {
  container.innerHTML = '';
  renderTreeItems(items, container, basePath, depth);
}

function renderTreeItems(items, container, basePath, depth) {
  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'tree-item';
    el.style.paddingLeft = `${8 + depth * 14}px`;

    if (item.type === 'directory') {
      el.innerHTML = `<span class="icon">&#9654;</span><span class="name">${escapeHtml(item.name)}</span>`;
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-children';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = childContainer.classList.toggle('open');
        el.querySelector('.icon').innerHTML = isOpen ? '&#9660;' : '&#9654;';
      });
      container.appendChild(el);
      renderTreeItems(item.children, childContainer, basePath, depth + 1);
      container.appendChild(childContainer);
    } else {
      el.innerHTML = `<span class="icon">&#128196;</span><span class="name">${escapeHtml(item.name)}</span>`;
      const fullPath = basePath + '/' + item.path;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.tree-item.active').forEach(i => i.classList.remove('active'));
        el.classList.add('active');
        loadFile(fullPath, item.path);
      });
      container.appendChild(el);
    }
  }
}

// ---- File Loading (server mode) ----
async function loadFile(fullPath, relPath) {
  try {
    const data = await api('/api/file', { filePath: fullPath });
    state.currentFile = { path: fullPath, relPath };
    state.currentCode = data.content;
    state.annotations = {};
    state.rewrittenCode = null;
    rewriteControls.classList.add('hidden');
    currentFileLabel.textContent = relPath;
    renderCode(data.content, data.extension);
  } catch (err) {
    codeArea.innerHTML = `<div class="placeholder" style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// ---- Load local (uploaded/pasted) file ----
function loadLocalFile(filename, content) {
  const ext = '.' + filename.split('.').pop();
  state.currentFile = { path: filename, relPath: filename };
  state.currentCode = content;
  state.annotations = {};
  state.rewrittenCode = null;
  rewriteControls.classList.add('hidden');
  currentFileLabel.textContent = filename;
  renderCode(content, ext);
}

// ---- Code Rendering ----
function renderCode(code, extension) {
  const lines = code.split('\n');

  // Limit highlighting to files under 5000 lines for performance
  const lang = extensionToLang(extension);
  let highlightedLines;
  if (lang && hljs.getLanguage(lang) && lines.length < 5000) {
    const highlighted = hljs.highlight(code, { language: lang }).value;
    highlightedLines = splitHighlightedLines(highlighted);
  } else {
    highlightedLines = lines.map(l => escapeHtml(l));
  }

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const annotation = state.annotations[lineNum];
    const lineClass = annotation ? ` annotated-${annotation}` : '';
    const badge = annotation
      ? `<span class="annotation-badge ${annotation}">${annotation === 'keep' ? 'K' : 'E'}</span>`
      : '';
    rows.push(
      `<tr class="code-line${lineClass}" data-line="${lineNum}">` +
      `<td class="gutter" data-line="${lineNum}"><span class="line-num">${lineNum}</span>${badge}</td>` +
      `<td class="code-cell">${highlightedLines[i] || ''}</td></tr>`
    );
  }

  codeArea.innerHTML = `<table class="code-table">${rows.join('')}</table>`;

  // Use event delegation instead of per-gutter listeners
  codeArea.onclick = (e) => {
    const gutter = e.target.closest('.gutter');
    if (gutter) {
      toggleAnnotation(parseInt(gutter.dataset.line));
    }
  };
}

function splitHighlightedLines(highlighted) {
  const parts = highlighted.split('\n');
  const lines = [];
  let openTags = [];

  for (let i = 0; i < parts.length; i++) {
    let line = openTags.join('') + parts[i];

    // Track open/close span tags in this part
    const newOpenTags = [...openTags];
    const tagRegex = /<\/?span[^>]*>/g;
    let match;
    while ((match = tagRegex.exec(parts[i])) !== null) {
      if (match[0].startsWith('</')) {
        newOpenTags.pop();
      } else {
        newOpenTags.push(match[0]);
      }
    }

    // Close all open tags at end of line
    for (let j = newOpenTags.length - 1; j >= 0; j--) {
      line += '</span>';
    }

    openTags = newOpenTags;
    lines.push(line);
  }
  return lines;
}

function toggleAnnotation(lineNum) {
  const current = state.annotations[lineNum];
  if (!current) {
    state.annotations[lineNum] = 'keep';
  } else if (current === 'keep') {
    state.annotations[lineNum] = 'edit';
  } else {
    delete state.annotations[lineNum];
  }
  if (state.currentCode) {
    const ext = state.currentFile?.path?.match(/\.[^.]+$/)?.[0] || '';
    renderCode(state.currentCode, ext);
  }
}

clearAnnotationsBtn.addEventListener('click', () => {
  state.annotations = {};
  if (state.currentCode) {
    const ext = state.currentFile?.path?.match(/\.[^.]+$/)?.[0] || '';
    renderCode(state.currentCode, ext);
  }
});

function extensionToLang(ext) {
  const map = {
    '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript',
    '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
    '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
    '.cs': 'csharp', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.scala': 'scala',
    '.html': 'html', '.css': 'css', '.scss': 'scss',
    '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
    '.md': 'markdown', '.sh': 'bash', '.bash': 'bash',
    '.sql': 'sql', '.xml': 'xml', '.vue': 'xml', '.svelte': 'xml',
  };
  return map[ext] || null;
}

// ---- Paste Code ----
const pasteBtn = document.getElementById('paste-btn');
const pasteModal = document.getElementById('paste-modal');
const pasteModalClose = document.getElementById('paste-modal-close');
const pasteFilename = document.getElementById('paste-filename');
const pasteTextarea = document.getElementById('paste-textarea');
const pasteSubmit = document.getElementById('paste-submit');

pasteBtn.addEventListener('click', () => {
  pasteModal.classList.remove('hidden');
  pasteTextarea.focus();
});

pasteModalClose.addEventListener('click', () => pasteModal.classList.add('hidden'));
pasteModal.addEventListener('click', (e) => {
  if (e.target === pasteModal) pasteModal.classList.add('hidden');
});

pasteSubmit.addEventListener('click', () => {
  const code = pasteTextarea.value;
  const filename = pasteFilename.value.trim() || 'untitled.js';
  if (!code) return;

  state.uploadedFiles[filename] = code;
  loadLocalFile(filename, code);
  renderUploadedFileTree();
  pasteModal.classList.add('hidden');
  pasteTextarea.value = '';
  pasteFilename.value = '';
});

// ---- File Upload ----
const uploadFilesBtn = document.getElementById('upload-files-btn');
const uploadFilesInput = document.getElementById('upload-files-input');

uploadFilesBtn.addEventListener('click', () => uploadFilesInput.click());

uploadFilesInput.addEventListener('change', (e) => {
  handleFileList(e.target.files);
  uploadFilesInput.value = '';
});

// ---- Folder Upload ----
const uploadFolderBtn = document.getElementById('upload-folder-btn');
const uploadFolderInput = document.getElementById('upload-folder-input');

uploadFolderBtn.addEventListener('click', () => uploadFolderInput.click());

uploadFolderInput.addEventListener('change', (e) => {
  handleFileList(e.target.files);
  uploadFolderInput.value = '';
});

async function handleFileList(files) {
  if (!files.length) return;

  const statusEl = document.createElement('div');
  statusEl.className = 'placeholder';
  statusEl.textContent = `Loading ${files.length} file(s)...`;
  fileTree.appendChild(statusEl);

  let loaded = 0;
  const MAX_FILE_SIZE = 500 * 1024; // 500KB per file

  for (const file of files) {
    // Skip binary files and large files
    if (isBinaryFile(file.name)) continue;
    if (file.size > MAX_FILE_SIZE) continue;
    if (file.size === 0) continue;

    try {
      const text = await file.text();
      // Use webkitRelativePath for folder uploads (preserves directory structure)
      const name = file.webkitRelativePath || file.name;
      state.uploadedFiles[name] = text;
      loaded++;
    } catch {
      // skip unreadable files
    }
  }

  statusEl.remove();

  if (loaded === 0) {
    fileTree.innerHTML += '<div class="placeholder" style="color:var(--orange)">No readable text files found</div>';
    return;
  }

  renderUploadedFileTree();

  // Auto-load first file
  const firstName = Object.keys(state.uploadedFiles)[0];
  if (firstName) {
    loadLocalFile(firstName, state.uploadedFiles[firstName]);
  }
}

function renderUploadedFileTree() {
  const filenames = Object.keys(state.uploadedFiles);
  if (filenames.length === 0) return;

  const existing = document.getElementById('uploaded-section');
  if (existing) existing.remove();

  // Clear the placeholder if present
  const placeholder = fileTree.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const section = document.createElement('div');
  section.id = 'uploaded-section';
  section.innerHTML = '<div class="tree-section-header">Uploaded / Pasted</div>';

  // Group files by directory
  const dirs = {};
  const rootFiles = [];

  for (const name of filenames) {
    const parts = name.split('/');
    if (parts.length === 1) {
      rootFiles.push(name);
    } else {
      const dir = parts[0];
      if (!dirs[dir]) dirs[dir] = [];
      dirs[dir].push(name);
    }
  }

  // Render directories
  for (const [dir, dirFiles] of Object.entries(dirs).sort()) {
    const dirEl = document.createElement('div');
    dirEl.className = 'tree-item';
    dirEl.style.paddingLeft = '8px';
    dirEl.innerHTML = `<span class="icon">&#9654;</span><span class="name">${escapeHtml(dir)}</span>`;

    const childContainer = document.createElement('div');
    childContainer.className = 'tree-children';

    dirEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = childContainer.classList.toggle('open');
      dirEl.querySelector('.icon').innerHTML = isOpen ? '&#9660;' : '&#9654;';
    });

    for (const fullName of dirFiles.sort()) {
      const shortName = fullName.split('/').slice(1).join('/');
      const fileEl = document.createElement('div');
      fileEl.className = 'tree-item';
      fileEl.style.paddingLeft = '22px';
      fileEl.innerHTML = `<span class="icon">&#128196;</span><span class="name">${escapeHtml(shortName)}</span>`;
      fileEl.addEventListener('click', (e) => {
        e.stopPropagation();
        document.querySelectorAll('.tree-item.active').forEach(i => i.classList.remove('active'));
        fileEl.classList.add('active');
        loadLocalFile(fullName, state.uploadedFiles[fullName]);
      });
      childContainer.appendChild(fileEl);
    }

    section.appendChild(dirEl);
    section.appendChild(childContainer);
  }

  // Render root-level files
  for (const name of rootFiles.sort()) {
    const el = document.createElement('div');
    el.className = 'tree-item';
    el.style.paddingLeft = '8px';
    el.innerHTML = `<span class="icon">&#128196;</span><span class="name">${escapeHtml(name)}</span>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.tree-item.active').forEach(i => i.classList.remove('active'));
      el.classList.add('active');
      loadLocalFile(name, state.uploadedFiles[name]);
    });
    section.appendChild(el);
  }

  fileTree.appendChild(section);
}

// ---- Drag & Drop ----
codeArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  codeArea.style.outline = '2px dashed var(--accent)';
});

codeArea.addEventListener('dragleave', () => {
  codeArea.style.outline = '';
});

codeArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  codeArea.style.outline = '';

  // Handle dropped items (files or folders via DataTransferItem)
  if (e.dataTransfer.items) {
    const entries = [];
    for (const item of e.dataTransfer.items) {
      if (item.kind === 'file') {
        const entry = item.webkitGetAsEntry?.();
        if (entry) {
          entries.push(entry);
        } else {
          // Fallback: just get the file
          const file = item.getAsFile();
          if (file && !isBinaryFile(file.name) && file.size < 500 * 1024) {
            try {
              const text = await file.text();
              state.uploadedFiles[file.name] = text;
            } catch {}
          }
        }
      }
    }

    if (entries.length > 0) {
      await processEntries(entries, '');
    }
  } else if (e.dataTransfer.files.length > 0) {
    await handleFileList(e.dataTransfer.files);
    return;
  }

  renderUploadedFileTree();
  const firstName = Object.keys(state.uploadedFiles)[0];
  if (firstName) loadLocalFile(firstName, state.uploadedFiles[firstName]);
});

async function processEntries(entries, basePath) {
  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise(resolve => entry.file(resolve));
      const name = basePath ? `${basePath}/${file.name}` : file.name;
      if (!isBinaryFile(file.name) && file.size < 500 * 1024 && file.size > 0) {
        try {
          const text = await file.text();
          state.uploadedFiles[name] = text;
        } catch {}
      }
    } else if (entry.isDirectory) {
      const dirName = basePath ? `${basePath}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      const subEntries = await new Promise(resolve => reader.readEntries(resolve));
      await processEntries(subEntries, dirName);
    }
  }
}

// ---- Dependency Checker ----
runDepsBtn.addEventListener('click', async () => {
  const hasUploaded = Object.keys(state.uploadedFiles).length > 0;
  if (!state.folderPath && !hasUploaded) {
    depsResult.innerHTML = '<div class="placeholder" style="color:var(--orange)">Scan a folder or upload files first</div>';
    return;
  }

  if (!state.folderPath && hasUploaded) {
    // Client-side dependency analysis
    const deps = {};
    const externalDeps = new Set();
    const importPatterns = [
      /import\s+.*?from\s+['"](.+?)['"]/g,
      /import\s+['"](.+?)['"]/g,
      /require\s*\(\s*['"](.+?)['"]\s*\)/g,
      /from\s+(\S+)\s+import/g,
    ];
    for (const [name, content] of Object.entries(state.uploadedFiles)) {
      const fileDeps = [];
      for (const pattern of importPatterns) {
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
      if (fileDeps.length > 0) deps[name] = fileDeps;
    }
    renderDeps({
      internalDeps: deps,
      externalDeps: [...externalDeps],
      packageJsonDeps: {},
      requirementsTxtDeps: [],
    });
    return;
  }

  setLoading(depsResult, 'Analyzing dependencies...');
  runDepsBtn.disabled = true;
  try {
    const data = await api('/api/dependencies', { folderPath: state.folderPath });
    renderDeps(data);
  } catch (err) {
    depsResult.innerHTML = `<div class="placeholder" style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    runDepsBtn.disabled = false;
  }
});

function renderDeps(data) {
  let html = '';

  const internalEntries = Object.entries(data.internalDeps);
  if (internalEntries.length > 0) {
    html += '<div class="dep-section"><h3>Internal Dependencies</h3>';
    for (const [file, deps] of internalEntries) {
      html += `<div class="dep-file"><span class="dep-file-name">${escapeHtml(file)}</span>`;
      html += '<ul class="dep-list">';
      for (const dep of deps) html += `<li>${escapeHtml(dep)}</li>`;
      html += '</ul></div>';
    }
    html += '</div>';
  }

  if (data.externalDeps.length > 0) {
    html += '<div class="dep-section"><h3>External Packages (from imports)</h3>';
    html += '<ul class="dep-ext-list">';
    for (const dep of data.externalDeps.sort()) html += `<li>${escapeHtml(dep)}</li>`;
    html += '</ul></div>';
  }

  const pkgEntries = Object.entries(data.packageJsonDeps);
  if (pkgEntries.length > 0) {
    html += '<div class="dep-section"><h3>package.json Dependencies</h3>';
    html += '<ul class="dep-ext-list">';
    for (const [name, version] of pkgEntries) {
      html += `<li>${escapeHtml(name)} <span style="color:var(--text-muted)">${escapeHtml(version)}</span></li>`;
    }
    html += '</ul></div>';
  }

  if (data.requirementsTxtDeps.length > 0) {
    html += '<div class="dep-section"><h3>requirements.txt</h3>';
    html += '<ul class="dep-ext-list">';
    for (const dep of data.requirementsTxtDeps) html += `<li>${escapeHtml(dep)}</li>`;
    html += '</ul></div>';
  }

  if (!html) html = '<div class="placeholder">No dependencies found</div>';
  depsResult.innerHTML = html;
}

// ---- LLM Rewrite ----
runRewriteBtn.addEventListener('click', async () => {
  if (!state.currentCode) {
    rewriteResult.innerHTML = '<div class="placeholder" style="color:var(--orange)">Open a file first</div>';
    return;
  }
  setLoading(rewriteResult, 'Calling Claude API for rewrite...');
  runRewriteBtn.disabled = true;
  rewriteControls.classList.add('hidden');
  try {
    const data = await api('/api/rewrite', {
      code: state.currentCode,
      annotations: state.annotations,
      fileName: state.currentFile?.relPath || 'unknown',
    });
    state.rewrittenCode = data.rewritten;
    renderDiff(state.currentCode, data.rewritten);
    rewriteControls.classList.remove('hidden');
  } catch (err) {
    rewriteResult.innerHTML = `<div class="placeholder" style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    runRewriteBtn.disabled = false;
  }
});

function renderDiff(original, rewritten) {
  const origLines = original.split('\n');
  const newLines = rewritten.split('\n');
  const maxLen = Math.max(origLines.length, newLines.length);
  const parts = [];

  for (let i = 0; i < maxLen; i++) {
    const origLine = origLines[i];
    const newLine = newLines[i];
    if (origLine === undefined) {
      parts.push(`<div class="diff-line-add">+ ${escapeHtml(newLine)}</div>`);
    } else if (newLine === undefined) {
      parts.push(`<div class="diff-line-remove">- ${escapeHtml(origLine)}</div>`);
    } else if (origLine === newLine) {
      parts.push(`<div class="diff-line-same">  ${escapeHtml(origLine)}</div>`);
    } else {
      parts.push(`<div class="diff-line-remove">- ${escapeHtml(origLine)}</div>`);
      parts.push(`<div class="diff-line-add">+ ${escapeHtml(newLine)}</div>`);
    }
  }

  rewriteResult.innerHTML = `<div class="diff-view">${parts.join('')}</div>`;
}

acceptBtn.addEventListener('click', () => {
  if (state.rewrittenCode !== null) {
    state.currentCode = state.rewrittenCode;
    state.rewrittenCode = null;
    state.annotations = {};
    rewriteControls.classList.add('hidden');
    // Also update uploadedFiles if this was an uploaded file
    if (state.currentFile && state.uploadedFiles[state.currentFile.relPath]) {
      state.uploadedFiles[state.currentFile.relPath] = state.currentCode;
    }
    const ext = state.currentFile?.path?.match(/\.[^.]+$/)?.[0] || '';
    renderCode(state.currentCode, ext);
    rewriteResult.innerHTML = '<div class="placeholder" style="color:var(--green)">Changes accepted! Code updated in editor.</div>';
  }
});

rejectBtn.addEventListener('click', () => {
  state.rewrittenCode = null;
  rewriteControls.classList.add('hidden');
  rewriteResult.innerHTML = '<div class="placeholder">Changes rejected. Original code preserved.</div>';
});

// ---- Architecture Wiki ----
runWikiBtn.addEventListener('click', async () => {
  const hasUploaded = Object.keys(state.uploadedFiles).length > 0;
  if (!state.folderPath && !hasUploaded) {
    wikiResult.innerHTML = '<div class="placeholder" style="color:var(--orange)">Scan a folder or upload files first</div>';
    return;
  }

  setLoading(wikiResult, 'Generating architecture wiki with Claude...');
  runWikiBtn.disabled = true;
  try {
    let data;
    if (!state.folderPath && hasUploaded) {
      data = await api('/api/architecture-inline', { files: state.uploadedFiles });
    } else {
      data = await api('/api/architecture', { folderPath: state.folderPath });
    }
    wikiResult.innerHTML = renderMarkdown(data.wiki);
  } catch (err) {
    wikiResult.innerHTML = `<div class="placeholder" style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    runWikiBtn.disabled = false;
  }
});

function renderMarkdown(md) {
  return md
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${escapeHtml(code.trim())}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    .replace(/^(?!<[huplo])((?!<).+)$/gm, '<p>$1</p>');
}
