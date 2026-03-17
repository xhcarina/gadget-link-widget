// State
const state = {
  folderPath: '',
  currentFile: null,       // { path, relPath }
  currentCode: '',
  annotations: {},         // { lineNumber: 'keep' | 'edit' }
  rewrittenCode: null,
};

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

// ---- Folder Scanning ----
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
  for (const item of items) {
    const el = document.createElement('div');

    if (item.type === 'directory') {
      el.className = 'tree-item';
      el.style.paddingLeft = `${8 + depth * 14}px`;
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
      el.className = 'tree-item';
      el.style.paddingLeft = `${8 + depth * 14}px`;
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

function renderTreeItems(items, container, basePath, depth) {
  for (const item of items) {
    const el = document.createElement('div');

    if (item.type === 'directory') {
      el.className = 'tree-item';
      el.style.paddingLeft = `${8 + depth * 14}px`;
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
      el.className = 'tree-item';
      el.style.paddingLeft = `${8 + depth * 14}px`;
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

// ---- File Loading ----
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

function renderCode(code, extension) {
  const lines = code.split('\n');
  const lang = extensionToLang(extension);

  let highlighted;
  if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(code, { language: lang }).value;
  } else {
    highlighted = escapeHtml(code);
  }

  const highlightedLines = splitHighlightedLines(highlighted, lines.length);

  let html = '<table class="code-table">';
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const annotation = state.annotations[lineNum];
    const lineClass = annotation ? `annotated-${annotation}` : '';
    const badgeHtml = annotation
      ? `<span class="annotation-badge ${annotation}">${annotation === 'keep' ? 'K' : 'E'}</span>`
      : '';

    html += `<tr class="code-line ${lineClass}" data-line="${lineNum}">`;
    html += `<td class="gutter" data-line="${lineNum}"><span class="line-num">${lineNum}</span>${badgeHtml}</td>`;
    html += `<td class="code-cell">${highlightedLines[i] || ''}</td>`;
    html += `</tr>`;
  }
  html += '</table>';

  codeArea.innerHTML = html;

  // Attach gutter click handlers
  codeArea.querySelectorAll('.gutter').forEach(gutter => {
    gutter.addEventListener('click', () => {
      const line = parseInt(gutter.dataset.line);
      toggleAnnotation(line);
    });
  });
}

function splitHighlightedLines(highlighted, lineCount) {
  // Split highlighted HTML into lines while preserving tags
  const lines = [];
  let openTags = [];
  let current = '';

  const parts = highlighted.split('\n');
  for (let i = 0; i < parts.length; i++) {
    let line = '';
    // Re-open any unclosed tags from previous lines
    for (const tag of openTags) {
      line += tag;
    }
    line += parts[i];

    // Track open/close tags
    const tagRegex = /<\/?span[^>]*>/g;
    let match;
    const newOpenTags = [...openTags];
    const tempPart = parts[i];
    while ((match = tagRegex.exec(tempPart)) !== null) {
      if (match[0].startsWith('</')) {
        newOpenTags.pop();
      } else {
        newOpenTags.push(match[0]);
      }
    }

    // Close any remaining open tags at end of line
    for (let j = newOpenTags.length - 1; j >= openTags.length ? false : true; j--) {
      // simplification: close all open tags at line end
    }
    // Close unclosed tags for this line
    const unclosed = newOpenTags.length;
    for (let j = 0; j < unclosed - openTags.length; j++) {
      // These tags were opened in this line and not closed
    }

    // Just close all tags at end of each line for safety
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
  // Re-render
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

// ---- Dependency Checker ----
runDepsBtn.addEventListener('click', async () => {
  if (!state.folderPath) {
    depsResult.innerHTML = '<div class="placeholder" style="color:var(--orange)">Scan a folder first</div>';
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

  // Internal dependencies
  const internalEntries = Object.entries(data.internalDeps);
  if (internalEntries.length > 0) {
    html += '<div class="dep-section"><h3>Internal Dependencies</h3>';
    for (const [file, deps] of internalEntries) {
      html += `<div class="dep-file"><span class="dep-file-name">${escapeHtml(file)}</span>`;
      html += '<ul class="dep-list">';
      for (const dep of deps) {
        html += `<li>${escapeHtml(dep)}</li>`;
      }
      html += '</ul></div>';
    }
    html += '</div>';
  }

  // External deps from scanning
  if (data.externalDeps.length > 0) {
    html += '<div class="dep-section"><h3>External Packages (from imports)</h3>';
    html += '<ul class="dep-ext-list">';
    for (const dep of data.externalDeps.sort()) {
      html += `<li>${escapeHtml(dep)}</li>`;
    }
    html += '</ul></div>';
  }

  // package.json deps
  const pkgEntries = Object.entries(data.packageJsonDeps);
  if (pkgEntries.length > 0) {
    html += '<div class="dep-section"><h3>package.json Dependencies</h3>';
    html += '<ul class="dep-ext-list">';
    for (const [name, version] of pkgEntries) {
      html += `<li>${escapeHtml(name)} <span style="color:var(--text-muted)">${escapeHtml(version)}</span></li>`;
    }
    html += '</ul></div>';
  }

  // requirements.txt
  if (data.requirementsTxtDeps.length > 0) {
    html += '<div class="dep-section"><h3>requirements.txt</h3>';
    html += '<ul class="dep-ext-list">';
    for (const dep of data.requirementsTxtDeps) {
      html += `<li>${escapeHtml(dep)}</li>`;
    }
    html += '</ul></div>';
  }

  if (!html) {
    html = '<div class="placeholder">No dependencies found</div>';
  }

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

  // Simple line-by-line diff
  const maxLen = Math.max(origLines.length, newLines.length);
  let html = '<div class="diff-view">';

  for (let i = 0; i < maxLen; i++) {
    const origLine = origLines[i];
    const newLine = newLines[i];

    if (origLine === undefined) {
      html += `<div class="diff-line-add">+ ${escapeHtml(newLine)}</div>`;
    } else if (newLine === undefined) {
      html += `<div class="diff-line-remove">- ${escapeHtml(origLine)}</div>`;
    } else if (origLine === newLine) {
      html += `<div class="diff-line-same">  ${escapeHtml(origLine)}</div>`;
    } else {
      html += `<div class="diff-line-remove">- ${escapeHtml(origLine)}</div>`;
      html += `<div class="diff-line-add">+ ${escapeHtml(newLine)}</div>`;
    }
  }

  html += '</div>';
  rewriteResult.innerHTML = html;
}

acceptBtn.addEventListener('click', () => {
  if (state.rewrittenCode !== null) {
    state.currentCode = state.rewrittenCode;
    state.rewrittenCode = null;
    state.annotations = {};
    rewriteControls.classList.add('hidden');
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
  if (!state.folderPath) {
    wikiResult.innerHTML = '<div class="placeholder" style="color:var(--orange)">Scan a folder first</div>';
    return;
  }
  setLoading(wikiResult, 'Generating architecture wiki with Claude...');
  runWikiBtn.disabled = true;
  try {
    const data = await api('/api/architecture', { folderPath: state.folderPath });
    wikiResult.innerHTML = renderMarkdown(data.wiki);
  } catch (err) {
    wikiResult.innerHTML = `<div class="placeholder" style="color:var(--red)">Error: ${escapeHtml(err.message)}</div>`;
  } finally {
    runWikiBtn.disabled = false;
  }
});

function renderMarkdown(md) {
  // Simple markdown renderer
  let html = md
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
    })
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // List items
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>')
    // Wrap consecutive <li> in <ul>
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    // Paragraphs (lines that aren't tags)
    .replace(/^(?!<[huplo])((?!<).+)$/gm, '<p>$1</p>');

  return html;
}
