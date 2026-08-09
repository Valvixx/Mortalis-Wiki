const CFG = window.WIKI_CONFIG;
const els = {
  tree: document.getElementById("tree"), search: document.getElementById("search"),
  content: document.getElementById("content"), title: document.getElementById("site-title"),
  status: document.getElementById("status"), sidebarToggle: document.getElementById("sidebar-toggle"),
  sidebar: document.getElementById("sidebar")
};

els.title.textContent = CFG.title;
const notesByKey = new Map();
const noteContentCache = new Map();
let allNotes = [];
let assetsByRelPath = new Map();
let assetsByBasename = new Map();
let activeSearchQuery = "";

function safeDecode(value) { try { return decodeURIComponent(value); } catch { return value; } }
function contentUrl(path) {
  // Обычный файл GitHub Pages: не требует запросов к API и не попадает под rate limit.
  return path.split("/").map(encodeURIComponent).join("/");
}
function escapeHtml(value) {
  const el = document.createElement("div"); el.textContent = String(value); return el.innerHTML;
}
function escapeAttr(value) { return escapeHtml(value).replace(/"/g, "&quot;"); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function setStatus(text, error = false) { els.status.textContent = text; els.status.classList.toggle("error", error); }

async function fetchFileTree() {
  const response = await fetch(contentUrl(`${CFG.contentDir}/index.json`));
  if (!response.ok) throw new Error(`Не удалось загрузить индекс хранилища (${response.status})`);
  const index = await response.json();
  assetsByRelPath = new Map(); assetsByBasename = new Map();
  (index.assets || []).forEach(path => {
    const relative = path.replace(new RegExp(`^${CFG.contentDir}/`, "i"), "");
    const lower = relative.toLowerCase();
    assetsByRelPath.set(lower, path);
    const basename = lower.split("/").pop();
    assetsByBasename.set(basename, [...(assetsByBasename.get(basename) || []), path]);
  });
  return index.notes || [];
}

function buildIndex(notes) {
  allNotes = notes.sort((a, b) => a.title.localeCompare(b.title, "ru"));
  notesByKey.clear();
  allNotes.forEach(note => { if (!notesByKey.has(note.title.toLowerCase())) notesByKey.set(note.title.toLowerCase(), note); });
}
function markedText(text, query) {
  const escaped = escapeHtml(text);
  if (!query) return escaped;
  return escaped.replace(new RegExp(escapeRegExp(query), "gi"), match => `<mark>${match}</mark>`);
}
function renderTree(query = "") {
  const filter = query.trim().toLowerCase();
  const visible = filter ? allNotes.filter(note => note.title.toLowerCase().includes(filter) || noteContentCache.get(note.path)?.includes(filter)) : allNotes;
  const groups = new Map();
  visible.forEach(note => groups.set(note.folder || "", [...(groups.get(note.folder || "") || []), note]));
  els.tree.innerHTML = filter ? `<div class="search-summary">Найдено записей: ${visible.length}</div>` : "";
  [...groups.keys()].sort((a, b) => a.localeCompare(b, "ru")).forEach(folder => {
    if (folder) { const heading = document.createElement("div"); heading.className = "tree-folder"; heading.textContent = folder; els.tree.appendChild(heading); }
    const list = document.createElement("ul"); list.className = "tree-list";
    groups.get(folder).forEach(note => {
      const link = document.createElement("a");
      link.href = `#/${encodeURIComponent(note.title)}`; link.dataset.key = note.title.toLowerCase();
      link.innerHTML = markedText(note.title, filter);
      const item = document.createElement("li"); item.appendChild(link); list.appendChild(item);
    });
    els.tree.appendChild(list);
  });
  if (!visible.length) els.tree.innerHTML += `<div class="tree-empty">Ничего не найдено.</div>`;
  highlightActive();
}
function highlightActive() {
  const current = safeDecode(location.hash.replace(/^#\/?/, "")).toLowerCase();
  els.tree.querySelectorAll("a").forEach(link => link.classList.toggle("active", link.dataset.key === current));
}

function resolveAssetPath(target) {
  const clean = safeDecode(target.trim()).replace(/^\.?\//, "");
  const lower = clean.toLowerCase();
  if (assetsByRelPath.has(lower)) return assetsByRelPath.get(lower);
  const byName = assetsByBasename.get(lower.split("/").pop());
  return byName?.[0] || `${CFG.contentDir}/${clean}`;
}
function stripFrontMatter(md) { return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""); }
function stripLeadingTitle(md, title) {
  const lines = md.split(/\r?\n/); let i = 0;
  while (!lines[i]?.trim()) i++;
  if (lines[i]?.match(/^#\s+/)?.[0] && lines[i].replace(/^#\s+/, "").trim().toLowerCase() === title.toLowerCase()) {
    lines.splice(i, 1); while (!lines[i]?.trim() && i < lines.length) lines.splice(i, 1);
  }
  return lines.join("\n");
}
function preprocessStandardImages(md) {
  return md.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, alt, path, title) => {
    if (/^([a-z]+:)?\/\//i.test(path) || path.startsWith("data:")) return whole;
    return `![${alt}](${contentUrl(resolveAssetPath(path))}${title || ""})`;
  });
}
function preprocessWikiLinks(md) {
  // Obsidian exports may escape brackets. Remove only those escapes before parsing links.
  md = md.replace(/\\([\[\]])/g, "$1");
  return md.replace(/!\[\[([^\]]+?)\]\]/g, (_, inner) => {
    const [targetPart, ...options] = inner.split("|").map(part => part.trim());
    const target = targetPart.split("#")[0];
    if (!/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(target)) return `> 📜 [[${target}]]`;
    const size = options.find(option => /^\d+(?:\s*x\s*\d+)?$/i.test(option));
    const [width, height] = size ? size.split(/\s*x\s*/i) : [];
    const alt = options.find(option => option !== size) || target.split("/").pop();
    return `<img src="${contentUrl(resolveAssetPath(target))}" alt="${escapeAttr(alt)}" loading="lazy"${width ? ` width="${width}"` : ""}${height ? ` height="${height}"` : ""}>`;
  }).replace(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const clean = target.trim(); const known = notesByKey.has(clean.toLowerCase());
    return `<a href="#/${encodeURIComponent(clean)}"${known ? "" : ' class="wiki-link-missing"'}>${escapeHtml((alias || clean).trim())}</a>`;
  });
}
function highlightSearchHits(query) {
  if (!query) return 0;
  const matcher = new RegExp(escapeRegExp(query), "gi"); let count = 0;
  const walker = document.createTreeWalker(els.content.querySelector(".note-body"), NodeFilter.SHOW_TEXT, {
    acceptNode(node) { return node.parentElement.closest("code, pre, script, style, mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
  });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(node => {
    matcher.lastIndex = 0; if (!matcher.test(node.nodeValue)) return;
    matcher.lastIndex = 0; const fragment = document.createDocumentFragment(); let start = 0;
    node.nodeValue.replace(matcher, (hit, offset) => {
      fragment.append(document.createTextNode(node.nodeValue.slice(start, offset)));
      const mark = document.createElement("mark"); mark.className = "search-hit"; mark.textContent = hit; fragment.append(mark);
      start = offset + hit.length; count++; return hit;
    });
    fragment.append(document.createTextNode(node.nodeValue.slice(start))); node.replaceWith(fragment);
  });
  const first = els.content.querySelector("mark.search-hit"); if (first) first.classList.add("current");
  return count;
}

async function loadNote(title) {
  const note = notesByKey.get(title.toLowerCase()); els.content.classList.add("loading");
  if (!note) { els.content.innerHTML = `<div class="not-found"><div class="note-eyebrow">Утрачено</div><h1 class="note-title">Страница не найдена</h1><p>Заметка «${escapeHtml(title)}» отсутствует в хранилище.</p></div>`; els.content.classList.remove("loading"); return; }
  try {
    const response = await fetch(contentUrl(note.path)); if (!response.ok) throw new Error(`Не удалось получить файл (${response.status})`);
    let md = await response.text(); noteContentCache.set(note.path, md.toLowerCase());
    md = preprocessWikiLinks(preprocessStandardImages(stripLeadingTitle(stripFrontMatter(md), note.title)));
    const body = marked.parse(md, { gfm: true, breaks: true, mangle: false, headerIds: true });
    const folder = note.folder ? note.folder.split("/").join(" / ") : "Запись";
    els.content.innerHTML = `<header class="note-banner"><div class="note-eyebrow">${escapeHtml(folder)}</div><h1 class="note-title">${escapeHtml(note.title)}</h1></header><div class="note-body">${body}</div>`;
    const hits = highlightSearchHits(activeSearchQuery);
    if (activeSearchQuery) els.content.querySelector(".note-banner").insertAdjacentHTML("afterend", `<div class="search-result-count">Совпадений в этой записи: ${hits}</div>`);
    document.title = `${note.title} — ${CFG.title}`;
  } catch (error) { els.content.innerHTML = `<div class="not-found"><h1 class="note-title">Ошибка загрузки</h1><p>${escapeHtml(error.message)}</p></div>`; }
  finally { els.content.classList.remove("loading"); highlightActive(); window.scrollTo({ top: 0, behavior: "auto" }); }
}

function route() {
  let title = safeDecode(location.hash.replace(/^#\/?/, ""));
  if (!title) { title = CFG.homeNote && notesByKey.has(CFG.homeNote.toLowerCase()) ? CFG.homeNote : allNotes[0]?.title || ""; if (title) { location.replace(`#/${encodeURIComponent(title)}`); return; } }
  loadNote(title);
}
window.addEventListener("hashchange", route);
els.search.addEventListener("input", event => { activeSearchQuery = event.target.value.trim(); renderTree(activeSearchQuery); if (location.hash) loadNote(safeDecode(location.hash.replace(/^#\/?/, ""))); });
els.sidebarToggle.addEventListener("click", () => els.sidebar.classList.toggle("open"));
els.content.addEventListener("click", () => els.sidebar.classList.remove("open"));

async function prefetchAllContent(notes, concurrency = 5) {
  let cursor = 0, done = 0;
  async function worker() { while (cursor < notes.length) { const note = notes[cursor++]; try { if (!noteContentCache.has(note.path)) { const r = await fetch(contentUrl(note.path)); if (r.ok) noteContentCache.set(note.path, (await r.text()).toLowerCase()); } } catch {} done++; } }
  await Promise.all(Array.from({ length: concurrency }, worker));
  setStatus(`${notes.length} заметок в хранилище — поиск по содержимому готов`);
  if (activeSearchQuery) renderTree(activeSearchQuery);
}
(async function init() {
  setStatus("Открываю хранилище…");
  try { const notes = await fetchFileTree(); if (!notes.length) throw new Error(`В папке «${CFG.contentDir}» не найдено заметок.`); buildIndex(notes); renderTree(); setStatus(`${notes.length} заметок в хранилище — подготавливаю поиск…`); route(); prefetchAllContent(allNotes); }
  catch (error) { setStatus(`Не удалось загрузить хранилище: ${error.message}`, true); els.content.innerHTML = `<div class="not-found"><h1 class="note-title">Портал не открылся</h1><p>${escapeHtml(error.message)}</p></div>`; }
})();
