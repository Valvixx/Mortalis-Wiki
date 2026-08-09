// ============================================================
//  Тёмный гримуар — движок вики поверх Obsidian-хранилища
//  Всё работает на статике: GitHub API отдаёт список файлов,
//  raw.githubusercontent.com — их содержимое.
// ============================================================

const CFG = window.WIKI_CONFIG;

const els = {
  tree: document.getElementById("tree"),
  search: document.getElementById("search"),
  content: document.getElementById("content"),
  title: document.getElementById("site-title"),
  crumbs: document.getElementById("crumbs"),
  status: document.getElementById("status"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  sidebar: document.getElementById("sidebar"),
};

els.title.textContent = CFG.title;

// notesByKey: "имя заметки в нижнем регистре" -> { path, title, folder }
const notesByKey = new Map();
let allNotes = []; // отсортированный список для сайдбара/поиска

// ---------- 1. Получаем список файлов через GitHub Trees API ----------

async function fetchFileTree() {
  const url = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/git/trees/${CFG.branch}?recursive=1`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GitHub API вернул ${res.status}`);
  }
  const data = await res.json();
  const prefix = CFG.contentDir.replace(/\/$/, "") + "/";

  const mdFiles = data.tree.filter(
    (item) =>
      item.type === "blob" &&
      item.path.startsWith(prefix) &&
      item.path.toLowerCase().endsWith(".md")
  );

  return mdFiles.map((item) => {
    const relative = item.path.slice(prefix.length); // напр. "Заклинания/Огненный шар.md"
    const parts = relative.split("/");
    const filename = parts[parts.length - 1];
    const title = filename.replace(/\.md$/i, "");
    const folder = parts.slice(0, -1).join("/"); // "" если в корне
    return { path: item.path, relative, title, folder };
  });
}

// ---------- 2. Строим индекс и дерево для сайдбара ----------

function buildIndex(notes) {
  allNotes = notes.sort((a, b) => a.title.localeCompare(b.title, "ru"));

  notesByKey.clear();
  for (const note of allNotes) {
    const key = note.title.toLowerCase();
    if (!notesByKey.has(key)) {
      notesByKey.set(key, note);
    }
  }
}

function renderTree(filterText = "") {
  const filter = filterText.trim().toLowerCase();
  const filtered = filter
    ? allNotes.filter((n) => n.title.toLowerCase().includes(filter))
    : allNotes;

  // группируем по папкам
  const byFolder = new Map();
  for (const note of filtered) {
    const folder = note.folder || "";
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(note);
  }

  const folders = [...byFolder.keys()].sort((a, b) => a.localeCompare(b, "ru"));

  els.tree.innerHTML = "";

  for (const folder of folders) {
    if (folder) {
      const heading = document.createElement("div");
      heading.className = "tree-folder";
      heading.textContent = folder;
      els.tree.appendChild(heading);
    }
    const list = document.createElement("ul");
    list.className = "tree-list";
    for (const note of byFolder.get(folder)) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#/${encodeURIComponent(note.title)}`;
      a.textContent = note.title;
      a.dataset.key = note.title.toLowerCase();
      li.appendChild(a);
      list.appendChild(li);
    }
    els.tree.appendChild(list);
  }

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "Ничего не найдено";
    els.tree.appendChild(empty);
  }

  highlightActive();
}

function highlightActive() {
  const current = decodeURIComponent(location.hash.replace(/^#\/?/, "")).toLowerCase();
  els.tree.querySelectorAll("a").forEach((a) => {
    a.classList.toggle("active", a.dataset.key === current);
  });
}

// ---------- 3. Загрузка и рендер заметки ----------

function rawUrl(path) {
  return `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function stripFrontMatter(md) {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? md.slice(match[0].length) : md;
}

// Преобразуем обсидиановские [[Wiki Links]] и ![[Embeds]] в обычный markdown
// ДО того, как это уйдёт в marked — так проще всего.
function preprocessWikiLinks(md) {
  // Встраивание изображений: ![[image.png]]
  md = md.replace(/!\[\[([^\]|#]+?)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const clean = target.trim();
    if (/\.(png|jpe?g|gif|webp|svg)$/i.test(clean)) {
      const url = rawUrl(`${CFG.contentDir}/${clean}`);
      return `![${alias || clean}](${url})`;
    }
    // встраивание другой заметки — просто ссылка-цитата на неё
    return `> 📜 [[${clean}]]`;
  });

  // Обычные вики-ссылки: [[Заметка]] или [[Заметка|Текст]]
  md = md.replace(/\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) => {
    const clean = target.trim();
    const label = (alias || clean).trim();
    const known = notesByKey.has(clean.toLowerCase());
    const href = `#/${encodeURIComponent(clean)}`;
    const missingClass = known ? "" : ' class="wiki-link-missing"';
    return `<a href="${href}"${missingClass}>${label}</a>`;
  });

  return md;
}

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

async function loadNote(title) {
  const key = title.toLowerCase();
  const note = notesByKey.get(key);

  els.content.classList.add("loading");

  if (!note) {
    els.content.innerHTML = `
      <div class="not-found">
        <h1>Страница утеряна во тьме</h1>
        <p>Заметка «${escapeHtml(title)}» не найдена в хранилище.</p>
      </div>`;
    els.crumbs.textContent = "";
    els.content.classList.remove("loading");
    return;
  }

  try {
    const res = await fetch(rawUrl(note.path));
    if (!res.ok) throw new Error(`Не удалось получить файл (${res.status})`);
    let md = await res.text();
    md = stripFrontMatter(md);
    md = preprocessWikiLinks(md);

    const html = marked.parse(md, { mangle: false, headerIds: true });
    els.content.innerHTML = html;
    els.crumbs.textContent = note.folder ? `${note.folder} / ${note.title}` : note.title;
    document.title = `${note.title} — ${CFG.title}`;
  } catch (err) {
    els.content.innerHTML = `<div class="not-found"><h1>Ошибка</h1><p>${escapeHtml(err.message)}</p></div>`;
  } finally {
    els.content.classList.remove("loading");
    highlightActive();
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- 4. Роутинг ----------

function currentTitleFromHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  return decodeURIComponent(raw);
}

function route() {
  let title = currentTitleFromHash();
  if (!title) {
    title = CFG.homeNote || (allNotes[0] && allNotes[0].title) || "";
    if (title) {
      location.replace(`#/${encodeURIComponent(title)}`);
      return; // hashchange вызовет route() снова
    }
  }
  loadNote(title);
}

window.addEventListener("hashchange", route);

els.search.addEventListener("input", (e) => renderTree(e.target.value));

els.sidebarToggle.addEventListener("click", () => {
  els.sidebar.classList.toggle("open");
});

els.content.addEventListener("click", () => {
  els.sidebar.classList.remove("open");
});

// ---------- 5. Старт ----------

(async function init() {
  setStatus("Пробуждаю хранилище…");
  try {
    const notes = await fetchFileTree();
    if (notes.length === 0) {
      setStatus(
        `В папке «${CFG.contentDir}» не найдено ни одной .md заметки. Проверьте config.js и наличие файлов.`,
        true
      );
      renderTree();
      return;
    }
    buildIndex(notes);
    renderTree();
    setStatus(`${notes.length} заметок в хранилище`);
    route();
  } catch (err) {
    setStatus(
      `Не удалось связаться с GitHub API: ${err.message}. Проверьте owner/repo/branch в js/config.js.`,
      true
    );
    els.content.innerHTML = `
      <div class="not-found">
        <h1>Портал не открылся</h1>
        <p>${escapeHtml(err.message)}</p>
        <p>Проверьте <code>owner</code>, <code>repo</code> и <code>branch</code> в файле <code>js/config.js</code>.</p>
      </div>`;
  }
})();
