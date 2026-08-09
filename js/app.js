// ============================================================
//  Mortalis — движок вики поверх Obsidian-хранилища
//  Всё работает на статике: GitHub API отдаёт список файлов,
//  raw.githubusercontent.com — их содержимое.
// ============================================================

const CFG = window.WIKI_CONFIG;

const els = {
  tree: document.getElementById("tree"),
  search: document.getElementById("search"),
  content: document.getElementById("content"),
  title: document.getElementById("site-title"),
  status: document.getElementById("status"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  sidebar: document.getElementById("sidebar"),
};

els.title.textContent = CFG.title;

// notesByKey: "имя заметки в нижнем регистре" -> { path, relative, title, folder }
const notesByKey = new Map();
let allNotes = []; // отсортированный список для сайдбара/поиска

// Полнотекстовый индекс: путь заметки -> содержимое в нижнем регистре
const noteContentCache = new Map();

// Индекс не-md файлов (картинки и т.п.) для резолва вложений Obsidian
let assetsByRelPath = new Map(); // "images/pic.png" (нижний регистр, относительно contentDir) -> полный путь в репо
let assetsByBasename = new Map(); // "pic.png" -> [полные пути]

// ---------- 1. Получаем список файлов через GitHub Trees API ----------

async function fetchFileTree() {
  const url = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/git/trees/${CFG.branch}?recursive=1`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GitHub API вернул ${res.status}`);
  }
  const data = await res.json();
  const prefix = CFG.contentDir.replace(/\/$/, "") + "/";

  const blobs = data.tree.filter(
    (item) => item.type === "blob" && item.path.startsWith(prefix)
  );

  assetsByRelPath = new Map();
  assetsByBasename = new Map();

  const mdEntries = [];

  for (const item of blobs) {
    const relative = item.path.slice(prefix.length);
    if (relative.toLowerCase().endsWith(".md")) {
      mdEntries.push({ item, relative });
    } else {
      const lowerRel = relative.toLowerCase();
      assetsByRelPath.set(lowerRel, item.path);
      const basename = lowerRel.split("/").pop();
      if (!assetsByBasename.has(basename)) assetsByBasename.set(basename, []);
      assetsByBasename.get(basename).push(item.path);
    }
  }

  return mdEntries.map(({ item, relative }) => {
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
    ? allNotes.filter((n) => {
        if (n.title.toLowerCase().includes(filter)) return true;
        const cached = noteContentCache.get(n.path);
        return cached ? cached.includes(filter) : false;
      })
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
    empty.textContent = "Ничего не найдено во тьме";
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

// ---------- 3. Резолв путей к файлам и вставка изображений ----------

function rawUrl(path) {
  return `https://raw.githubusercontent.com/${CFG.owner}/${CFG.repo}/${CFG.branch}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function isImagePath(path) {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path);
}

// Находит реальный путь ассета (картинки) в репозитории по тому, как он
// упомянут в заметке — будь то просто "pic.png" или "images/sub/pic.png".
function resolveAssetPath(target) {
  const clean = decodeURIComponent(target.trim()).replace(/^\.?\//, "");
  const lower = clean.toLowerCase();

  if (assetsByRelPath.has(lower)) return assetsByRelPath.get(lower);

  if (lower.includes("/")) {
    for (const [relPath, fullPath] of assetsByRelPath) {
      if (relPath === lower || relPath.endsWith("/" + lower)) return fullPath;
    }
  }

  const basename = lower.split("/").pop();
  const candidates = assetsByBasename.get(basename);
  if (candidates && candidates.length > 0) return candidates[0];

  // fallback — вдруг файл лежит прямо в корне content/
  return `${CFG.contentDir}/${clean}`;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

function stripFrontMatter(md) {
  const match = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? md.slice(match[0].length) : md;
}

// Если первая строка заметки — это "# Название", совпадающее с заголовком
// баннера, убираем её, чтобы название не дублировалось.
function stripLeadingTitle(md, title) {
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i < lines.length) {
    const m = lines[i].trim().match(/^#\s+(.*)$/);
    if (m && m[1].trim().toLowerCase() === title.trim().toLowerCase()) {
      lines.splice(i, 1);
      while (lines[i] !== undefined && lines[i].trim() === "") lines.splice(i, 1);
      return lines.join("\n");
    }
  }
  return md;
}

// Обычные markdown-картинки ![alt](путь) — тоже резолвим через хранилище,
// если это не внешняя ссылка.
function preprocessStandardImages(md) {
  return md.replace(/!\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (whole, alt, path, title) => {
    if (/^([a-z]+:)?\/\//i.test(path) || path.startsWith("data:")) return whole;
    const assetPath = resolveAssetPath(path);
    const url = rawUrl(assetPath);
    return `![${alt}](${url}${title || ""})`;
  });
}

// Обсидиановские [[Wiki Links]] и ![[Embeds]] (в т.ч. с размером картинки
// вида ![[pic.png|300]] или ![[pic.png|300x200]]).
function preprocessWikiLinks(md) {
  md = md.replace(/!\[\[([^\]]+?)\]\]/g, (whole, inner) => {
    const segments = inner.split("|").map((s) => s.trim());
    const target = segments[0].split("#")[0];
    const rest = segments.slice(1);

    if (isImagePath(target)) {
      const assetPath = resolveAssetPath(target);
      const url = rawUrl(assetPath);
      let width = null;
      let height = null;
      let alt = target.split("/").pop();

      for (const part of rest) {
        const sizeMatch = part.match(/^(\d+)(?:\s*x\s*(\d+))?$/i);
        if (sizeMatch) {
          width = sizeMatch[1];
          height = sizeMatch[2] || null;
        } else if (part) {
          alt = part;
        }
      }

      const attrs = [`src="${url}"`, `alt="${escapeAttr(alt)}"`, `loading="lazy"`];
      if (width) attrs.push(`width="${width}"`);
      if (height) attrs.push(`height="${height}"`);
      return `<img ${attrs.join(" ")} />`;
    }

    // встраивание другой заметки — просто заметная ссылка-цитата на неё
    return `> 📜 [[${target}]]`;
  });

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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- 4. Загрузка и рендер заметки ----------

async function loadNote(title) {
  const key = title.toLowerCase();
  const note = notesByKey.get(key);

  els.content.classList.add("loading");

  if (!note) {
    els.content.innerHTML = `
      <div class="not-found">
        <div class="note-eyebrow">Утрачено</div>
        <h1 class="note-title">Страница поглощена тьмой</h1>
        <p>Заметка «${escapeHtml(title)}» не найдена в хранилище.</p>
      </div>`;
    els.content.classList.remove("loading");
    return;
  }

  try {
    const res = await fetch(rawUrl(note.path));
    if (!res.ok) throw new Error(`Не удалось получить файл (${res.status})`);
    let md = await res.text();
    if (!noteContentCache.has(note.path)) {
      noteContentCache.set(note.path, md.toLowerCase());
    }

    md = stripFrontMatter(md);
    md = stripLeadingTitle(md, note.title);
    md = preprocessStandardImages(md);
    md = preprocessWikiLinks(md);

    const html = marked.parse(md, { mangle: false, headerIds: true });

    const eyebrow = note.folder ? note.folder.split("/").join(" / ") : "Запись";

    els.content.innerHTML = `
      <header class="note-banner">
        <div class="note-eyebrow">${escapeHtml(eyebrow)}</div>
        <h1 class="note-title">${escapeHtml(note.title)}</h1>
      </header>
      <div class="note-body">${html}</div>
    `;
    document.title = `${note.title} — ${CFG.title}`;
  } catch (err) {
    els.content.innerHTML = `<div class="not-found"><h1 class="note-title">Ошибка</h1><p>${escapeHtml(err.message)}</p></div>`;
  } finally {
    els.content.classList.remove("loading");
    highlightActive();
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

// ---------- 5. Роутинг ----------

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

// ---------- 6. Фоновая индексация всех текстов для полнотекстового поиска ----------

async function prefetchAllContent(notes, concurrency = 6) {
  let cursor = 0;
  let done = 0;
  const total = notes.length;

  async function worker() {
    while (cursor < notes.length) {
      const note = notes[cursor++];
      if (!noteContentCache.has(note.path)) {
        try {
          const res = await fetch(rawUrl(note.path));
          if (res.ok) {
            const text = await res.text();
            noteContentCache.set(note.path, text.toLowerCase());
          }
        } catch (e) {
          // тихо пропускаем — заметка останется доступной только по названию
        }
      }
      done++;
      if (done % 4 === 0 || done === total) {
        setStatus(`${total} заметок в хранилище — индексирую тексты для поиска… ${done}/${total}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  setStatus(`${total} заметок в хранилище — поиск по всему тексту готов`);
  if (els.search.value.trim()) renderTree(els.search.value);
}

// ---------- 7. Старт ----------

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
    prefetchAllContent(allNotes);
  } catch (err) {
    setStatus(
      `Не удалось связаться с GitHub API: ${err.message}. Проверьте owner/repo/branch в js/config.js.`,
      true
    );
    els.content.innerHTML = `
      <div class="not-found">
        <h1 class="note-title">Портал не открылся</h1>
        <p>${escapeHtml(err.message)}</p>
        <p>Проверьте <code>owner</code>, <code>repo</code> и <code>branch</code> в файле <code>js/config.js</code>.</p>
      </div>`;
  }
})();
