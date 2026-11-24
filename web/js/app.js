import { escapeHtml, highlightLine, languageLabel } from "./highlight.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

// 同一份页面跑两个客户端：命令方块不显示提词器，提词器独立客户端只跑提词器。
// 标记由 index.html 底部的内联脚本按 ?app=prompter 设好，早于本文件执行。
const PROMPTER_ONLY = document.documentElement.dataset.app === "prompter";

const MAX_RENDER_LINES = 12000;
const MAX_HIGHLIGHT_CHARS = 320000;
const MAX_SYMBOL_ROWS = 550;

const state = {
  version: "0.1.0",
  appRoot: "",
  root: "",
  rootName: "",
  tree: null,
  files: [],
  filesByPath: new Map(),
  favorites: [],
  notes: {},
  prompts: { items: [], pending: [], capture: { enabled: false, minLength: 40 } },
  promptsLoaded: false,
  promptId: "",
  promptDraft: null,
  promptQuery: "",
  promptTimer: null,
  promptCheckTimer: null,
  recent: [],
  api: null,
  release: null,
  safety: null,
  newPaths: new Set(),
  filter: { q: "", kind: "all", newOnly: false, favOnly: false, scope: "" },
  indexFilter: { q: "", kind: "all" },
  expanded: new Set(),
  favCollapsed: new Set(),
  treeInitialized: false,
  view: "welcome",
  lastContentView: null,
  currentPath: "",
  currentLine: 0,
  currentFile: null,
  folderPath: "",
  index: null,
  indexStale: false,
  sync: { kind: "waiting", text: "正在连接…" },
  modalOnClose: null,
  apiTimer: null,
  favSaveTimer: null,
  favRevision: 0,
  // 正在改名的分类：记在这里，列表被重新绘制时仍能把输入框原样画回去，
  // 否则保存回包触发的重绘会把刚弹出来的输入框冲掉（打不了字）。
  renamingId: "",
  renameDraft: "",
  dragData: null,
  refreshing: false,
  theme: document.documentElement.dataset.theme === "night" ? "night" : "day",
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function icon(name, className = "") {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatClock() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function basename(path) {
  return String(path || "").split("/").filter(Boolean).pop() || "";
}

function dirname(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function uid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return Math.random().toString(36).slice(2, 14);
}

function kindIcon(kind, language = "") {
  if (kind === "docs") return "book";
  if (kind === "config") return "braces";
  if (kind === "code") return "code";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(String(language).toLowerCase())) return "file";
  return "file";
}

function apiError(message, status = 0, code = "") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function request(path, options = {}) {
  const init = { cache: "no-store", ...options };
  init.headers = { ...(options.headers || {}) };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers["Content-Type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw apiError("无法连接本地服务，请确认命令方块仍在运行");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const info = payload?.error;
    throw apiError(info?.message || `请求失败（HTTP ${response.status}）`, response.status, info?.code || "");
  }
  return payload;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function toast(message, type = "ok", duration = 2800) {
  const layer = $("#toastLayer");
  const node = document.createElement("div");
  node.className = `toast ${type === "ok" ? "" : `is-${type}`}`;
  node.innerHTML = `${icon(type === "error" ? "alert" : type === "warn" ? "alert" : "check")}<span>${escapeHtml(message)}</span>`;
  layer.appendChild(node);
  while (layer.children.length > 3) layer.firstElementChild.remove();
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(5px)";
    node.style.transition = "opacity .18s, transform .18s";
    setTimeout(() => node.remove(), 200);
  }, duration);
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function openModal(inner, { drawer = false, onClose = null } = {}) {
  const layer = $("#modalLayer");
  layer.innerHTML = inner;
  layer.hidden = false;
  layer.classList.toggle("is-drawer", drawer);
  state.modalOnClose = onClose;
  layer.onclick = (event) => {
    if (event.target === layer) closeModal();
  };
  const focusable =
    layer.querySelector("input:not([type=hidden]):not([disabled]), textarea") ||
    layer.querySelector("button, select");
  if (focusable) {
    setTimeout(() => {
      try { focusable.focus({ preventScroll: true }); } catch { /* noop */ }
    }, 30);
  }
}

function closeModal() {
  const layer = $("#modalLayer");
  if (layer.hidden) return;
  layer.hidden = true;
  layer.innerHTML = "";
  layer.classList.remove("is-drawer");
  layer.onclick = null;
  const callback = state.modalOnClose;
  state.modalOnClose = null;
  if (callback) callback();
}

function askConfirm(title, message, confirmLabel = "确认") {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value);
    };
    openModal(
      `<div class="modal-card confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <div class="modal-head">
          <div class="modal-head-copy"><span class="eyebrow">PLEASE CONFIRM</span><h2 id="confirmTitle">${escapeHtml(title)}</h2></div>
          <button class="modal-close" type="button" data-close aria-label="关闭">${icon("close")}</button>
        </div>
        <div class="confirm-body">${message}</div>
        <div class="modal-foot">
          <span class="spacer"></span>
          <button class="small-btn" type="button" data-cancel>取消</button>
          <button class="danger-btn" type="button" data-confirm>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`,
      { onClose: () => { if (!settled) { settled = true; resolve(false); } } },
    );
    $("#modalLayer [data-close]")?.addEventListener("click", () => finish(false));
    $("#modalLayer [data-cancel]")?.addEventListener("click", () => finish(false));
    $("#modalLayer [data-confirm]")?.addEventListener("click", () => finish(true));
  });
}

// ---------------------------------------------------------------------------
// State / global render
// ---------------------------------------------------------------------------

function applyState(payload) {
  if (!payload) return;
  state.version = payload.version || state.version;
  state.appRoot = payload.appRoot || "";
  state.root = payload.root?.path || "";
  state.rootName = payload.root?.name || (state.root ? basename(state.root) : "");
  state.favorites = Array.isArray(payload.favorites) ? payload.favorites : [];
  // 换根或重新拉状态时，正在改名的输入框属于上一个根，直接作废。
  state.renamingId = "";
  state.renameDraft = "";
  state.notes = payload.notes && typeof payload.notes === "object" ? payload.notes : {};
  state.recent = Array.isArray(payload.recent) ? payload.recent : [];
  state.api = payload.api || null;
  state.safety = payload.safety || null;
}

function rootIncludesApp() {
  if (!state.root || !state.appRoot) return false;
  return state.root === state.appRoot || state.appRoot.startsWith(state.root.replace(/\/$/, "") + "/");
}

function sourcePathFor(relativePath) {
  if (!relativePath) return null;
  if (state.root === state.appRoot) return relativePath;
  if (state.root && state.appRoot.startsWith(state.root.replace(/\/$/, "") + "/")) {
    return `${state.appRoot.slice(state.root.replace(/\/$/, "").length + 1)}/${relativePath}`;
  }
  return null;
}

function updateVersion() {
  for (const id of ["welcomeVersion", "statusVersion"]) {
    const node = document.getElementById(id);
    if (node) node.textContent = state.version;
  }
  const pill = $("#versionPill");
  if (pill) pill.textContent = `v${state.version}`;
}

function updateRootUI() {
  $("#rootName").textContent = state.rootName || "未打开文件夹";
  $("#rootChip").title = state.root ? `${state.root} · 点击切换` : "选择文件夹";
  const title = $("#workspaceTitle");
  if (title) title.textContent = "文件";
}

function updateWelcome() {
  $("#welcomeFiles").textContent = state.tree?.counts?.files ?? "—";
}

function renderAll() {
  updateVersion();
  updateRootUI();
  updateWelcome();
  renderFavorites();
  renderTree();
  renderStatus();
  renderApi();
  renderPie();
}

function setSync(kind, text) {
  state.sync = { kind, text };
  const node = $("#syncStatus");
  if (!node) return;
  node.className = "sync-status" + (kind === "ok" ? " is-ok" : kind === "syncing" ? " is-syncing" : "");
  node.innerHTML = `<span class="status-dot ${kind === "ok" ? "is-ok" : kind === "syncing" ? "is-checking" : "is-warn"}"></span><span>${escapeHtml(text)}</span>`;
}

function renderStatus() {
  const counts = state.tree?.counts;
  if (counts) {
    $("#statusCounts").textContent = `${counts.files} 文件 / ${counts.dirs} 目录`;
    const excluded = state.tree.excluded || {};
    $("#statusExcluded").textContent = `已排除 ${excluded.dirs || 0} 目录 · ${excluded.files || 0} 文件`;
  } else {
    $("#statusCounts").textContent = "— 文件";
    $("#statusExcluded").textContent = "—";
  }
  const newCount = state.newPaths.size;
  const statusNew = $("#statusNew");
  statusNew.hidden = newCount === 0;
  statusNew.querySelector("span:last-child").textContent = `新增 ${newCount}`;
  const jump = $("#newJump");
  jump.hidden = newCount === 0;
  $("#newJumpText").textContent = `${newCount} 个新增文件`;
  jump.classList.toggle("is-active", state.filter.newOnly);
  $("#newFilterBtn").classList.toggle("is-active", state.filter.newOnly);
  $("#favFilterBtn").classList.toggle("is-active", state.filter.favOnly);
  const visible = filteredFiles().length;
  $("#explorerCount").textContent = `${visible} / ${state.files.length} 文件`;
  $("#newFilterBtn").title = newCount ? `${newCount} 个新增文件` : "没有新增文件";
}

// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------

function favoriteCategories() {
  return Array.isArray(state.favorites) ? state.favorites : [];
}

function favoriteEntry(path) {
  for (const category of favoriteCategories()) {
    for (const item of category.items || []) {
      if (item.path === path) return { category, item };
    }
  }
  return null;
}

function isFavorited(path) {
  return Boolean(favoriteEntry(path));
}

function favoritePathSets() {
  const files = new Set();
  const folders = [];
  for (const category of favoriteCategories()) {
    for (const item of category.items || []) {
      if (item.kind === "folder") folders.push(item.path);
      else files.add(item.path);
    }
  }
  return { files, folders };
}

function isUnderFavorite(path) {
  const sets = favoritePathSets();
  if (sets.files.has(path)) return true;
  return sets.folders.some((folder) => path === folder || path.startsWith(folder.replace(/\/$/, "") + "/"));
}

function saveFavoritesSoon() {
  clearTimeout(state.favSaveTimer);
  state.favSaveTimer = setTimeout(persistFavorites, 300);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function persistFavorites() {
  if (!state.root) return;
  const revision = ++state.favRevision;
  const rootAtRequest = state.root;
  const categories = JSON.parse(JSON.stringify(state.favorites));
  try {
    const result = await request("/api/favorites", {
      method: "POST",
      body: { categories, root: rootAtRequest },
    });
    if (rootAtRequest !== state.root) return;
    if (revision === state.favRevision) {
      state.favorites = result.categories || [];
      renderFavorites();
      renderTree();
    }
  } catch (error) {
    toast(error.message || "收藏夹保存失败", "error");
    try {
      const result = await request("/api/favorites");
      state.favorites = result.categories || [];
      renderFavorites();
      renderTree();
    } catch { /* keep local view */ }
  }
}

function ensureCategory() {
  if (favoriteCategories().length) return favoriteCategories()[0].id;
  const category = { id: uid(), name: "常用", items: [] };
  state.favorites.push(category);
  renderFavorites();
  return category.id;
}

function toggleFavorite(path, kind, name = basename(path)) {
  if (!path) return;
  const existing = favoriteEntry(path);
  if (existing) {
    for (const category of favoriteCategories()) {
      category.items = (category.items || []).filter((item) => item.path !== path);
    }
    saveFavoritesSoon();
    renderFavorites();
    renderTree();
    updateFavButton();
    toast("已取消收藏");
    return;
  }
  const categoryId = ensureCategory();
  const category = favoriteCategories().find((item) => item.id === categoryId);
  if (!category.items.some((item) => item.path === path)) {
    category.items.push({ path, kind, name });
  }
  saveFavoritesSoon();
  renderFavorites();
  renderTree();
  updateFavButton();
  toast("已加入收藏夹");
}

function addFavoriteToCategory(categoryId, path, kind, name = basename(path), index = null) {
  const category = favoriteCategories().find((item) => item.id === categoryId);
  if (!category) return false;
  if ((category.items || []).some((item) => item.path === path)) {
    toast("这个条目已在当前分类中", "warn");
    return false;
  }
  category.items = category.items || [];
  const insertAt = index === null ? category.items.length : clamp(index, 0, category.items.length);
  category.items.splice(insertAt, 0, { path, kind, name });
  saveFavoritesSoon();
  renderFavorites();
  renderTree();
  toast(kind === "folder" ? "文件夹已收藏" : "文件已收藏");
  return true;
}

function removeFavorite(categoryId, path) {
  const category = favoriteCategories().find((item) => item.id === categoryId);
  if (!category) return;
  category.items = (category.items || []).filter((item) => item.path !== path);
  saveFavoritesSoon();
  renderFavorites();
  renderTree();
  updateFavButton();
}

function renderFavorites() {
  const container = $("#favoritesList");
  if (!container) return;
  // 每次重绘记一代。旧输入框被重绘摘掉时会触发一次 blur，
  // 靠这个代数把「重绘导致的失焦」和「用户真的点走了」分开。
  const gen = (state.favRenderGen = (state.favRenderGen || 0) + 1);
  const categories = favoriteCategories();
  if (!categories.length) {
    container.innerHTML = `
      <div class="fav-inline-empty">
        ${icon("star")}
        <strong>还没有收藏分类</strong>
        <span>新建分类后，把文件或文件夹从中间栏拖进来。<br>分类和条目都可以拖动排序。</span>
      </div>
      <button class="fav-new-category" type="button" data-add-category>${icon("plus")}新建第一个分类</button>`;
    renderPie();
    return;
  }
  container.innerHTML = categories.map((category) => {
    const collapsed = state.favCollapsed.has(category.id);
    const items = category.items || [];
    const itemHTML = items.length
      ? items.map((item) => {
          const selected = state.currentPath === item.path ? " is-selected" : "";
          return `<div class="fav-item${selected}" draggable="true" data-cat-id="${escapeHtml(category.id)}" data-path="${escapeHtml(item.path)}" data-kind="${escapeHtml(item.kind || "file")}" title="${escapeHtml(item.path)}">
            ${icon(item.kind === "folder" ? "folder" : kindIcon(item.kind, "file"))}
            <span class="fav-item-name">${escapeHtml(item.name || basename(item.path))}</span>
            <button class="fav-item-remove" type="button" data-fav-remove="${escapeHtml(category.id)}" data-path="${escapeHtml(item.path)}" aria-label="移出收藏">${icon("close")}</button>
          </div>`;
        }).join("")
      : `<div class="fav-empty-slot">拖入文件或文件夹</div>`;
    return `<section class="fav-category${collapsed ? " is-collapsed" : ""}" data-cat-id="${escapeHtml(category.id)}">
      <div class="fav-head" draggable="true" data-drag-cat="${escapeHtml(category.id)}">
        <span class="fav-grip" aria-hidden="true">${icon("grip")}</span>
        <button class="fav-chevron" type="button" data-toggle-cat="${escapeHtml(category.id)}" aria-label="折叠分类">${icon("chevron-down")}</button>
        ${state.renamingId === category.id
          ? `<input class="fav-category-input" type="text" maxlength="40" value="${escapeHtml(state.renameDraft)}" aria-label="分类名称">`
          : `<span class="fav-name" title="双击重命名">${escapeHtml(category.name)}</span>`}
        <span class="fav-count">${items.length}</span>
        <span class="fav-actions">
          <button class="fav-action" type="button" data-rename-cat="${escapeHtml(category.id)}" title="重命名">${icon("pencil")}</button>
          <button class="fav-action" type="button" data-delete-cat="${escapeHtml(category.id)}" title="删除分类">${icon("trash")}</button>
        </span>
      </div>
      <div class="fav-items" data-drop-cat="${escapeHtml(category.id)}">${itemHTML}</div>
    </section>`;
  }).join("") + `<button class="fav-new-category" type="button" data-add-category>${icon("plus")}新建分类</button>`;
  if (state.renamingId) mountRenameInput(gen);
  renderPie();
}

// 在刚画出来的列表里认出那个输入框，接管回车 / Esc / 失焦。
function mountRenameInput(gen) {
  const input = $("#favoritesList .fav-category-input");
  if (!input) return;
  const id = state.renamingId;
  input.focus();
  input.select();
  input.addEventListener("input", () => { state.renameDraft = input.value; });
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    state.renamingId = "";
    const category = favoriteCategories().find((item) => item.id === id);
    const next = input.value.trim();
    if (save && category && next) {
      category.name = next.slice(0, 40);
      saveFavoritesSoon();
    }
    state.renameDraft = "";
    renderFavorites();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); commit(true); }
    if (event.key === "Escape") { event.preventDefault(); commit(false); }
  });
  // 列表重绘会把旧输入框从文档里摘掉，这也会触发一次 blur。
  // 那不是「用户点走了」，不能据此提交，否则改名状态会被重绘自己清掉。
  input.addEventListener("blur", () => {
    if (gen !== state.favRenderGen || !input.isConnected) return;
    // 整个窗口被切走（比如去看别的 App）不算改名结束：保持输入框，回来还能接着打。
    if (!document.hasFocus()) return;
    commit(true);
  });
}

function addCategory() {
  const category = { id: uid(), name: "新分类", items: [] };
  state.favorites.push(category);
  saveFavoritesSoon();
  startRenameCategory(category.id);
}

function startRenameCategory(categoryId) {
  const category = favoriteCategories().find((item) => item.id === categoryId);
  if (!category) return;
  state.renamingId = categoryId;
  state.renameDraft = category.name;
  renderFavorites();
}

function toggleCategoryCollapse(categoryId) {
  if (state.favCollapsed.has(categoryId)) state.favCollapsed.delete(categoryId);
  else state.favCollapsed.add(categoryId);
  try {
    localStorage.setItem("command-block:collapsed", JSON.stringify([...state.favCollapsed]));
  } catch { /* noop */ }
  renderFavorites();
}

async function deleteCategory(categoryId) {
  const category = favoriteCategories().find((item) => item.id === categoryId);
  if (!category) return;
  const ok = await askConfirm(
    "删除分类？",
    `将删除分类 <strong>${escapeHtml(category.name)}</strong> 及其中的 ${category.items?.length || 0} 个收藏。项目文件不会被删除。`,
    "删除分类",
  );
  if (!ok) return;
  state.favorites = favoriteCategories().filter((item) => item.id !== categoryId);
  saveFavoritesSoon();
  renderFavorites();
  renderTree();
}

// ---------------------------------------------------------------------------
// Size map · 扇形图（看大小占比，不改变文件树）
// ---------------------------------------------------------------------------
// 三个统计范围：
//   cur  = 当前。起点默认是根目录；右侧 1/2/3 是「从当前文件所在文件夹往上数几层」，
//          1 = 当前文件所处文件夹，不点就固定在根目录。换根文件夹时永远回到根。
//   fav  = 收藏夹。按收藏分类分片，点进去看该分类内部的下一级。
//   drop = 直接拖入。没有入口按钮，只有一句提示；应用内的文件夹和访达里的文件夹都能拖。
// 点任意一片 = 统计它的下一级；当前文件落在哪一片，那一片就被推出来并标注。

const PIE_SLOTS = 6;   // 最多 6 片，剩下的并成「其他」

const pieState = {
  mode: "cur",
  level: 0,      // 0 = 根；1/2/3 = 上溯层数
  base: "",      // 已经钻到哪一层（相对起点），空 = 起点
  drop: null,    // { path, name, files:[{path,size}], total, count, truncated }
  hover: "",
  busy: false,
};

function clampPie(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatPercent(value) {
  const pct = (Number(value) || 0) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/** 当前应当高亮的路径：正在看的文件 > 目录筛选 > 文件夹视图。 */
function pieFocusPath() {
  return state.currentPath || state.filter.scope || state.folderPath || "";
}

/** 选了「上溯几层」之后，统计起点落在哪个目录（相对根目录）。 */
function pieStartPath() {
  if (pieState.mode !== "cur" || !pieState.level) return "";
  const from = pieFocusPath();
  if (!from) return "";
  const parts = from.split("/").filter(Boolean);
  const keep = parts.length - pieState.level;
  if (keep <= 0) return "";
  return parts.slice(0, keep).join("/");
}

function pieBasePath() {
  if (pieState.mode === "drop") return pieState.base;
  return pieState.base || pieStartPath();
}

/** 每个统计范围各自的一份「文件清单」，统一成 { path, size, raw }。 */
function pieEntries() {
  if (pieState.mode === "drop") {
    if (!pieState.drop) return [];
    return pieState.drop.files.map((file) => ({ path: file.path, size: file.size || 0, raw: "" }));
  }
  if (pieState.mode === "fav") {
    const out = [];
    const seen = new Set();
    for (const category of favoriteCategories()) {
      for (const item of category.items || []) {
        const key = `${category.id}|${item.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (item.kind === "folder") {
          const prefix = item.path.replace(/\/$/, "") + "/";
          for (const file of state.files) {
            if (file.path === item.path) { out.push({ path: `${category.id}/${file.path}`, size: file.size || 0, raw: file.path }); continue; }
            if (file.path.startsWith(prefix)) out.push({ path: `${category.id}/${file.path}`, size: file.size || 0, raw: file.path });
          }
        } else {
          const file = state.filesByPath.get(item.path);
          out.push({ path: `${category.id}/${item.path}`, size: file ? file.size || 0 : 0, raw: item.path });
        }
      }
    }
    return out;
  }
  return state.files.map((file) => ({ path: file.path, size: file.size || 0, raw: file.path }));
}

/** 自打开以来被改过的文件（青点那份数据，来自 effects.js）。 */
function changedPathSet() {
  const source = window.cbChangedPaths;
  if (typeof source !== "function") return new Set();
  try { return new Set(source() || []); } catch { return new Set(); }
}

function pieSliceLabel(segment) {
  if (pieState.mode === "fav") {
    const category = favoriteCategories().find((item) => item.id === segment);
    if (category) return category.name;
  }
  return basename(segment);
}

/** 把文件清单按「再下一级」聚合成若干片。 */
function pieAggregate() {
  const base = pieBasePath();
  const prefix = base ? base.replace(/\/$/, "") + "/" : "";
  const entries = pieEntries();
  const changed = changedPathSet();
  const buckets = new Map();
  let total = 0;
  let count = 0;
  let changedCount = 0;

  for (const entry of entries) {
    const path = entry.path;
    if (prefix && !path.startsWith(prefix)) continue;
    const rest = prefix ? path.slice(prefix.length) : path;
    if (!rest) continue;
    const cut = rest.indexOf("/");
    const name = cut === -1 ? rest : rest.slice(0, cut);
    const key = prefix + name;
    let node = buckets.get(key);
    if (!node) {
      // 收藏夹模式下这一级是分类 id，图例要显示分类名。
      node = { key, name: pieState.mode === "fav" ? pieSliceLabel(name) : name, size: 0, count: 0, changed: 0, isDir: cut !== -1 };
      buckets.set(key, node);
    }
    node.size += entry.size;
    node.count += 1;
    total += entry.size;
    count += 1;
    const raw = entry.raw || (pieState.mode === "fav" ? path.slice(path.indexOf("/") + 1) : path);
    if (changed.has(raw)) {
      node.changed += 1;
      changedCount += 1;
    }
  }

  const list = [...buckets.values()].sort((a, b) => b.size - a.size || b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));

  // 当前文件落在哪一片（钻进去之后就是「再下一级」里的那一片）
  const focus = pieFocusPath();
  let currentKey = "";
  if (focus && (!prefix || focus.startsWith(prefix))) {
    const rest = prefix ? focus.slice(prefix.length) : focus;
    const head = rest.split("/")[0];
    if (head && head !== rest) currentKey = prefix + head;
  }

  let slices = list;
  if (list.length > PIE_SLOTS + 1) {
    const head = list.slice(0, PIE_SLOTS);
    const tail = list.slice(PIE_SLOTS);
    // 当前文件那一片如果排在第 6 名之外，就把它换进来、挤掉最小的一片，
    // 这样「当前在扇形哪个位置」永远指向一片真实存在的小扇形，而不是永远落在「其他」。
    let current = currentKey ? list.find((node) => node.key === currentKey) : null;
    let displaced = null;
    if (current && !head.includes(current)) {
      displaced = head.pop();
      head.push(current);
    }
    let size = 0, items = 0, hits = 0;
    for (const node of tail) {
      if (node === current) continue;
      size += node.size; items += node.count; hits += node.changed;
    }
    if (displaced && displaced !== current) {
      size += displaced.size; items += displaced.count; hits += displaced.changed;
    }
    slices = head.concat([{ key: "", name: "其他", size, count: items, changed: hits, isDir: false, rest: true }]);
  }

  return { base, slices, total, count, changedCount, currentKey, entries: entries.length };
}

function pieArcPath(cx, cy, outer, inner, from, to) {
  const point = (angle, radius) => [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  const large = to - from > Math.PI ? 1 : 0;
  const [x0, y0] = point(from, outer);
  const [x1, y1] = point(to, outer);
  const [x2, y2] = point(to, inner);
  const [x3, y3] = point(from, inner);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${outer} ${outer} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} L${x2.toFixed(2)} ${y2.toFixed(2)} A${inner} ${inner} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)} Z`;
}

function renderPieSvg(data) {
  const svg = $("#pieSvg");
  if (!svg) return;
  const { slices, total } = data;
  const cx = 100, cy = 100, outer = 88, inner = 58;
  if (!slices.length || total <= 0) {
    svg.innerHTML = `<circle class="pie-ring-empty" cx="${cx}" cy="${cy}" r="${(outer + inner) / 2}" fill="none" stroke-width="${outer - inner}"/>`;
    return;
  }
  let angle = -Math.PI / 2;
  const gap = slices.length > 1 ? 0.016 : 0;
  const parts = [];
  // 占比极小的片在圆环上只有一条线、甚至被间隔吃掉，会整片消失（比如一堆 .app 旁边的 web）。
  // 给每片留一个最小可见角，剩下的角度再按真实占比分配。
  const minShare = slices.length > 1 ? Math.min(0.014, 0.5 / slices.length) : 0;
  const free = Math.max(0, 1 - minShare * slices.length);
  const spans = slices.map((slice) => {
    const share = total > 0 ? slice.size / total : 1 / slices.length;
    return (minShare + share * free) * Math.PI * 2;
  });
  // 只有一片（100%）时用两段半圆拼成一个整环：单段弧的起点终点几乎重合，
  // SVG 会把它画成一条看不见的细缝。
  const single = slices.length === 1;
  slices.forEach((slice, index) => {
    const span = spans[index];
    const from = angle + gap;
    const to = angle + span - gap;
    angle += span;
    if (to <= from) return;
    const mid = (from + to) / 2;
    const isCurrent = (Boolean(slice.key) && slice.key === data.currentKey) || Boolean(slice.hasCurrent);
    const slot = (index % PIE_SLOTS) + 1;
    const classes = ["pie-slice"];
    if (slice.rest) classes.push("is-rest");
    else classes.push(`is-slot-${slot}`);
    if (isCurrent) classes.push("is-current");
    // 位移方向写成单位向量，CSS 用 --k 控制「推出多远」：当前片固定推出，悬浮再加一点。
    const ux = Math.cos(mid).toFixed(3);
    const uy = Math.sin(mid).toFixed(3);
    const dot = slice.changed
      ? `<circle class="pie-changed-mark" cx="${(cx + Math.cos(mid) * (inner + 7)).toFixed(2)}" cy="${(cy + Math.sin(mid) * (inner + 7)).toFixed(2)}" r="3.2"/>`
      : "";
    const arc = single
      ? `<path class="pie-arc" fill-rule="evenodd" d="M${cx} ${cy - outer}A${outer} ${outer} 0 1 1 ${cx} ${cy + outer}A${outer} ${outer} 0 1 1 ${cx} ${cy - outer}ZM${cx} ${cy - inner}A${inner} ${inner} 0 1 0 ${cx} ${cy + inner}A${inner} ${inner} 0 1 0 ${cx} ${cy - inner}Z"/>`
      : `<path class="pie-arc" d="${pieArcPath(cx, cy, outer, inner, from, to)}"/>`;
    // 很窄的片在图上只是一条缝，「当前在哪」看不出来。所以在最外圈按真实角度
    // 画一段固定宽度的指针弧：位置是真的，面积不放大、比例不编造。
    const here = isCurrent
      ? `<path class="pie-here" d="${pieArcPath(cx, cy, outer + 9, outer + 3.5, mid - 0.055, mid + 0.055)}"/>`
      : "";
    parts.push(`<g class="${classes.join(" ")}" data-key="${escapeHtml(slice.key)}" style="--ux:${ux};--uy:${uy}">
      <title>${escapeHtml(slice.name)} · ${formatBytes(slice.size)} · ${slice.count} 个文件 · ${formatPercent(slice.size / total)}${slice.changed ? ` · ${slice.changed} 个改过` : ""}</title>
      ${arc}
      ${dot}
      ${here}
    </g>`);
  });
  svg.innerHTML = parts.join("");
}

function setPieHover(key) {
  const next = key || "";
  if (next === pieState.hover) return;
  pieState.hover = next;
  const svg = $("#pieSvg");
  if (svg) {
    $$(".pie-slice", svg).forEach((node) => node.classList.toggle("is-hover", Boolean(next) && node.dataset.key === next));
  }
  $$("#pieLegend [data-pie-key]").forEach((row) => row.classList.toggle("is-hover", Boolean(next) && row.dataset.pieKey === next));
}

function renderPieCenter(data) {
  const box = $("#pieCenter");
  if (!box) return;
  if (!data.slices.length) {
    const message = !state.root && pieState.mode !== "drop"
      ? "还没有打开文件夹"
      : pieState.mode === "fav"
        ? "收藏夹里还没有可统计的文件"
        : pieState.mode === "drop" && !pieState.drop
          ? "把文件夹拖进来"
          : "这里没有可统计的文本文件";
    box.innerHTML = `<span class="pie-center-empty">${escapeHtml(message)}</span>`;
    return;
  }
  box.innerHTML = `<strong>${formatBytes(data.total)}</strong><span class="pie-center-sub">${data.count} 个文件</span>`;
}

function renderPieTrail(data) {
  const box = $("#pieTrail");
  if (!box) return;
  const base = data.base;
  if (!base) {
    box.innerHTML = "";
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const parts = base.split("/").filter(Boolean);
  const rootLabel = pieState.mode === "drop" ? (pieState.drop?.name || "拖入") : (state.rootName || "根");
  let html = `<button class="pie-crumb" type="button" data-pie-base="">${escapeHtml(rootLabel)}</button>`;
  let walked = "";
  parts.forEach((part, index) => {
    walked = walked ? `${walked}/${part}` : part;
    html += `<span class="pie-crumb-sep">/</span>`;
    if (index === parts.length - 1) html += `<span class="pie-crumb is-current">${escapeHtml(pieSliceLabel(part))}</span>`;
    else html += `<button class="pie-crumb" type="button" data-pie-base="${escapeHtml(walked)}">${escapeHtml(pieSliceLabel(part))}</button>`;
  });
  box.innerHTML = html;
}

function renderPieLevels() {
  const box = $("#pieLevels");
  if (!box) return;
  if (pieState.mode !== "cur") { box.hidden = true; return; }
  const focus = pieFocusPath();
  const parts = focus ? focus.split("/").filter(Boolean) : [];
  const maxLevel = Math.min(4, parts.length);
  if (!maxLevel) { box.hidden = true; return; }
  box.hidden = false;
  const chips = [`<button class="pie-level${pieState.level === 0 ? " is-active" : ""}" type="button" data-pie-level="0" title="根目录">根</button>`];
  for (let level = 1; level <= maxLevel; level += 1) {
    const title = level === 1 ? "当前文件所在的文件夹" : `从当前文件的文件夹再往上 ${level - 1} 层`;
    chips.push(`<button class="pie-level${pieState.level === level ? " is-active" : ""}" type="button" data-pie-level="${level}" title="${title}">${level}</button>`);
  }
  box.innerHTML = `<span class="pie-level-label">起点</span>${chips.join("")}`;
}

function renderPieLegend(data) {
  const box = $("#pieLegend");
  if (!box) return;
  if (!data.slices.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = data.slices.map((slice, index) => {
    const slot = (index % PIE_SLOTS) + 1;
    const drillable = slice.key && slice.isDir;
    return `<button class="pie-legend-row ${slice.rest ? "is-rest" : `is-slot-${slot}`}${(slice.key && slice.key === data.currentKey) || slice.hasCurrent ? " is-current" : ""}" type="button" data-pie-key="${escapeHtml(slice.key)}" ${drillable ? "" : "data-pie-leaf"} title="${escapeHtml(slice.name)} · ${slice.count} 个文件">
      <span class="pie-swatch"></span>
      <span class="pie-legend-name">${escapeHtml(slice.name)}</span>
      ${slice.changed ? `<span class="pie-legend-dot" title="这里有打开后被改过的文件"></span>` : ""}
      <span class="pie-legend-pct">${formatPercent(slice.size / data.total)}</span>
      <span class="pie-legend-size">${escapeHtml(formatBytes(slice.size))}</span>
    </button>`;
  }).join("");
}

function renderPie() {
  const panel = $("#piePanel");
  if (!panel) return;
  const stage = $("#pieStage");
  const data = pieAggregate();

  // 三个模式的按钮状态
  $$("#pieModes [data-pie-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.pieMode === pieState.mode);
    if (button.dataset.pieMode === "drop") button.hidden = !pieState.drop;
  });

  const hint = $("#pieHint");
  if (hint) {
    if (pieState.mode === "drop") {
      hint.textContent = `已拖入 ${pieState.drop?.name || ""}${pieState.drop?.truncated ? "（文件过多，只统计前 12000 个）" : ""} · 再拖一个可以换`;
      hint.hidden = false;
    } else if (pieState.mode === "fav" && !favoriteCategories().length) {
      hint.textContent = "收藏夹是空的：先从文件栏拖几个文件进来";
      hint.hidden = false;
    } else {
      hint.textContent = "把文件夹直接拖到这里，看它的大小占比";
      hint.hidden = false;
    }
  }

  const flag = $("#pieFlag");
  if (flag) flag.hidden = !data.changedCount;

  if (stage) stage.classList.toggle("is-empty", data.slices.length === 0);

  renderPieSvg(data);
  renderPieCenter(data);
  renderPieTrail(data);
  renderPieLevels();
  renderPieLegend(data);
}

function pieDrill(key) {
  if (!key) return;
  const data = pieAggregate();
  const slice = data.slices.find((item) => item.key === key);
  if (!slice || slice.rest || !slice.isDir) return;
  pieState.base = key;
  pieState.hover = "";
  renderPie();
}

function resetPie({ keepDrop = true } = {}) {
  pieState.base = "";
  pieState.hover = "";
  if (!keepDrop) { pieState.drop = null; if (pieState.mode === "drop") pieState.mode = "cur"; }
  renderPie();
}

/** 扫描一个外部文件夹（访达拖入），后台只读扫描，返回文件清单。 */
async function loadDroppedFolder(absPath) {
  if (!absPath || pieState.busy) return;
  pieState.busy = true;
  const hint = $("#pieHint");
  if (hint) hint.textContent = "正在统计这个文件夹…";
  try {
    const data = await request("/api/folder-stats", { method: "POST", body: { path: absPath } });
    pieState.drop = {
      path: data.path,
      name: data.name || basename(data.path),
      files: data.files || [],
      total: data.total || 0,
      count: data.count || 0,
      truncated: Boolean(data.truncated),
    };
    pieState.mode = "drop";
    pieState.base = "";
    toast(`已统计 ${pieState.drop.name}：${pieState.drop.count} 个文件`);
    renderPie();
  } catch (error) {
    toast(error.message, "error");
    renderPie();
  } finally {
    pieState.busy = false;
  }
}

/** 应用内拖进来的文件夹：不用再扫一遍盘，直接把现有清单切一份出来。 */
function useLocalFolderAsDrop(relPath) {
  const prefix = relPath ? relPath.replace(/\/$/, "") + "/" : "";
  const files = state.files
    .filter((file) => !prefix || file.path.startsWith(prefix))
    .map((file) => ({ path: prefix ? file.path.slice(prefix.length) : file.path, size: file.size || 0 }));
  pieState.drop = {
    path: relPath,
    name: basename(relPath) || state.rootName,
    files,
    total: files.reduce((sum, file) => sum + file.size, 0),
    count: files.length,
    truncated: false,
  };
  pieState.mode = "drop";
  pieState.base = "";
  renderPie();
}

/** 左栏被拖窄之后，先撤掉字节数那一列（只留名称 + 百分比），不重算数据。 */
function bindPieResize() {
  const panel = $("#piePanel");
  if (!panel || typeof ResizeObserver !== "function") return;
  const sync = () => {
    const narrow = panel.clientWidth < 262;
    if (panel.classList.contains("is-narrow") !== narrow) panel.classList.toggle("is-narrow", narrow);
  };
  sync();
  new ResizeObserver(sync).observe(panel);
}

function fileUrlToPath(raw) {
  let text = String(raw || "").trim().split("\n")[0].trim();
  if (!text) return "";
  if (/^file:\/\//i.test(text)) {
    text = text.replace(/^file:\/\//i, "");
    if (text.startsWith("localhost/")) text = text.slice("localhost".length);
    try { text = decodeURIComponent(text); } catch { /* 保留原样 */ }
    return text.replace(/\/$/, "") || "/";
  }
  if (text.startsWith("/")) return text.replace(/\/$/, "");
  return "";
}

function bindPieEvents() {
  const panel = $("#piePanel");
  if (!panel) return;

  // 整个窗口禁止拖放导航：把文件夹拖进窗口时，浏览器默认会跳到 file:// 目录页。
  document.addEventListener("dragover", (event) => { event.preventDefault(); });
  document.addEventListener("drop", (event) => { event.preventDefault(); });

  panel.addEventListener("click", (event) => {
    const mode = event.target.closest("[data-pie-mode]");
    if (mode) {
      const next = mode.dataset.pieMode;
      if (next === pieState.mode) return;
      pieState.mode = next;
      pieState.base = "";
      pieState.hover = "";
      if (next === "drop" && !pieState.drop) { pieState.mode = "cur"; return; }
      renderPie();
      return;
    }
    const level = event.target.closest("[data-pie-level]");
    if (level) {
      pieState.level = Number(level.dataset.pieLevel) || 0;
      pieState.base = "";
      renderPie();
      return;
    }
    const crumb = event.target.closest("[data-pie-base]");
    if (crumb) {
      pieState.base = crumb.dataset.pieBase || "";
      renderPie();
      return;
    }
    const key = event.target.closest("[data-pie-key]");
    if (key) {
      if (key.hasAttribute("data-pie-leaf")) return;
      pieDrill(key.dataset.pieKey);
      return;
    }
    const slice = event.target.closest("[data-key]");
    if (slice) pieDrill(slice.dataset.key);
  });

  panel.addEventListener("mouseover", (event) => {
    const target = event.target.closest("[data-key], [data-pie-key]");
    if (!target) return;
    setPieHover(target.dataset.key || target.dataset.pieKey || "");
  });
  panel.addEventListener("mouseleave", () => setPieHover(""));

  // 拖入：应用内的文件夹 + 访达里的文件夹
  panel.addEventListener("dragover", (event) => {
    event.preventDefault();
    try { event.dataTransfer.dropEffect = "copy"; } catch { /* noop */ }
    panel.classList.add("is-drop");
  });
  panel.addEventListener("dragleave", (event) => {
    if (!panel.contains(event.relatedTarget)) panel.classList.remove("is-drop");
  });
  panel.addEventListener("drop", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    panel.classList.remove("is-drop");
    // 1) 应用内从文件栏拖过来的文件夹
    const drag = state.dragData;
    if (drag && drag.type === "tree" && drag.kind === "folder") {
      state.dragData = null;
      clearDropIndicators();
      useLocalFolderAsDrop(drag.path);
      return;
    }
    // 2) 访达 / 桌面拖过来的文件夹：先看 dataTransfer 里的真实路径
    const dt = event.dataTransfer;
    const candidates = [
      fileUrlToPath(dt?.getData?.("text/uri-list")),
      fileUrlToPath(dt?.getData?.("text/plain")),
    ].filter(Boolean);
    if (candidates.length) {
      await loadDroppedFolder(candidates[0]);
      return;
    }
    // 3) Electron 里路径由 preload 的 webUtils 读出，先等它一拍
    const fallback = document.documentElement.dataset.cbDropPath || "";
    if (fallback) {
      delete document.documentElement.dataset.cbDropPath;
      await loadDroppedFolder(fallback);
      return;
    }
    toast("读不到这个文件夹的路径：从访达拖文件夹进来，或从左边文件栏拖一个文件夹", "warn", 4200);
  });
}

function bindColumnResize() {
  const layout = $(".layout");
  if (!layout) return;
  const grips = $$(".col-grip");
  let widths = null;
  try {
    const raw = JSON.parse(localStorage.getItem("command-block:cols") || "null");
    if (Array.isArray(raw) && raw.length === 2) widths = raw.map(Number);
  } catch { /* 没有保存过 */ }
  const apply = (w1, w2) => {
    const width = window.innerWidth || 1280;
    const maxOne = Math.max(190, Math.round(width * 0.40));
    const maxTwo = Math.max(220, Math.round(width * 0.50));
    const first = clampPie(w1, 190, maxOne);
    const second = clampPie(w2, 220, maxTwo);
    layout.style.gridTemplateColumns = `${first}px ${second}px minmax(320px, 1fr)`;
    // 拖动条骑在两条分界线上：白天两栏之间有 10px 空隙，夜晚是 1px 霓虹线，
    // 所以位置按当前实际 gap 算，不写死。
    const gap = parseFloat(getComputedStyle(layout).columnGap) || 0;
    const gripOne = layout.querySelector('[data-grip="1"]');
    const gripTwo = layout.querySelector('[data-grip="2"]');
    if (gripOne) gripOne.style.left = `${Math.round(first + gap / 2 - 4)}px`;
    if (gripTwo) gripTwo.style.left = `${Math.round(first + gap + second + gap / 2 - 4)}px`;
    return [first, second];
  };
  if (widths) apply(widths[0], widths[1]);
  else {
    const box = layout.getBoundingClientRect();
    apply(Math.round(box.width * 0.185), Math.round(box.width * 0.21));
  }

  const save = (w1, w2) => {
    try { localStorage.setItem("command-block:cols", JSON.stringify([Math.round(w1), Math.round(w2)])); } catch { /* noop */ }
  };

  grips.forEach((grip) => {
    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      const columns = getComputedStyle(layout).gridTemplateColumns.split(" ").map((value) => parseFloat(value));
      const startX = event.clientX;
      const start1 = columns[0];
      const start2 = columns[1];
      const index = Number(grip.dataset.grip);
      grip.setPointerCapture(event.pointerId);
      grip.classList.add("is-active");
      document.body.classList.add("is-resizing");
      const move = (moveEvent) => {
        const delta = moveEvent.clientX - startX;
        if (index === 1) apply(start1 + delta, start2);
        else apply(start1, start2 + delta);
      };
      const up = () => {
        grip.classList.remove("is-active");
        document.body.classList.remove("is-resizing");
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        const [w1, w2] = getComputedStyle(layout).gridTemplateColumns.split(" ").map((value) => parseFloat(value));
        save(w1, w2);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    });
    grip.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const columns = getComputedStyle(layout).gridTemplateColumns.split(" ").map((value) => parseFloat(value));
      const delta = event.key === "ArrowRight" ? 16 : -16;
      const index = Number(grip.dataset.grip);
      const next = index === 1 ? apply(columns[0] + delta, columns[1]) : apply(columns[0], columns[1] + delta);
      save(next[0], next[1]);
    });
  });

  window.addEventListener("resize", () => {
    const columns = getComputedStyle(layout).gridTemplateColumns.split(" ").map((value) => parseFloat(value));
    apply(columns[0], columns[1]);
  });
}

// ---------------------------------------------------------------------------
// Tree data
// ---------------------------------------------------------------------------

function allDirectories() {
  const dirs = new Set();
  for (const file of state.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join("/"));
  }
  return dirs;
}

function initialExpanded() {
  const dirs = allDirectories();
  if (state.files.length <= 170) return new Set(dirs);
  return new Set([...dirs].filter((dir) => !dir.includes("/")));
}

function expandAncestors(path) {
  const parts = String(path || "").split("/");
  for (let i = 1; i < parts.length; i += 1) {
    state.expanded.add(parts.slice(0, i).join("/"));
  }
}

function loadCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem("command-block:collapsed") || "[]");
    if (Array.isArray(raw)) state.favCollapsed = new Set(raw);
  } catch { /* noop */ }
}

function filteredFiles() {
  const query = state.filter.q.trim().toLowerCase();
  const scope = state.filter.scope;
  const kind = state.filter.kind;
  const sets = favoritePathSets();
  return state.files.filter((file) => {
    if (scope && !(file.path === scope || file.path.startsWith(scope.replace(/\/$/, "") + "/"))) return false;
    if (query && !file.path.toLowerCase().includes(query)) return false;
    if (kind !== "all") {
      if (kind === "other") {
        if (["code", "docs", "config"].includes(file.kind)) return false;
      } else if (file.kind !== kind) return false;
    }
    if (state.filter.newOnly && !state.newPaths.has(file.path)) return false;
    if (state.filter.favOnly) {
      if (!sets.files.has(file.path) && !sets.folders.some((folder) => file.path.startsWith(folder.replace(/\/$/, "") + "/"))) return false;
    }
    return true;
  });
}

function fileRow(file, { flat = false } = {}) {
  const selected = state.currentPath === file.path ? " is-selected" : "";
  const isNew = state.newPaths.has(file.path);
  const fav = isFavorited(file.path);
  const note = state.notes?.[file.path]?.text || "";
  const name = flat ? file.name : file.name;
  return `<div class="tree-row is-file${selected}${flat ? " is-flat" : ""}" data-path="${escapeHtml(file.path)}" data-kind="file" draggable="true" role="treeitem" tabindex="0" title="${escapeHtml(file.path)}">
    ${flat ? "" : `<span class="tree-chevron is-empty"></span>`}
    ${icon(kindIcon(file.kind, file.language))}
    <span class="tree-name">${escapeHtml(name)}</span>
    ${flat ? `<span class="tree-flat-path">${escapeHtml(file.dir || "")}</span>` : ""}
    <span class="tree-tail">${note ? `<span class="tree-note" title="${escapeHtml(note)}"></span>` : ""}${isNew ? `<span class="tree-badge">新</span>` : ""}<button class="tree-action${fav ? " is-starred" : ""}" type="button" data-action="fav" title="${fav ? "取消收藏" : "加入收藏"}">${icon("star")}</button></span>
  </div>`;
}

function folderRow(path, depthUnused = 0) {
  const expanded = state.expanded.has(path);
  const selected = state.filter.scope === path ? " is-selected" : "";
  const fav = isFavorited(path);
  const name = basename(path);
  return `<div class="tree-row is-dir${expanded ? " is-expanded" : ""}${selected}" data-path="${escapeHtml(path)}" data-kind="folder" draggable="true" role="treeitem" tabindex="0" title="${escapeHtml(path)}">
    <span class="tree-chevron">${icon("chevron")}</span>
    ${icon(expanded ? "folder-open" : "folder")}
    <span class="tree-name">${escapeHtml(name)}</span>
    <span class="tree-tail"><button class="tree-action${fav ? " is-starred" : ""}" type="button" data-action="fav" title="${fav ? "取消收藏" : "加入收藏"}">${icon("star")}</button></span>
  </div>`;
}

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i];
      const path = parts.slice(0, i + 1).join("/");
      if (!node.dirs.has(name)) node.dirs.set(name, { name, path, dirs: new Map(), files: [] });
      node = node.dirs.get(name);
    }
    node.files.push(file);
  }
  return root;
}

function sortTree(node) {
  node.files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  node.dirs = new Map(dirs.map((dir) => [dir.name, dir]));
  for (const dir of node.dirs.values()) sortTree(dir);
}

function renderNode(node) {
  let html = "";
  for (const dir of node.dirs.values()) {
    html += folderRow(dir.path);
    if (state.expanded.has(dir.path)) {
      html += `<div class="tree-children">${renderNode(dir)}</div>`;
    }
  }
  for (const file of node.files) html += fileRow(file);
  return html;
}

function renderTree() {
  const treeRoot = $("#fileTree");
  const visible = filteredFiles();
  const empty = $("#treeEmpty");
  const loading = $("#treeLoading");
  loading.hidden = true;
  if (!state.tree) {
    treeRoot.innerHTML = "";
    empty.hidden = false;
    empty.querySelector("p").textContent = "尚未读取文件夹";
    empty.querySelector("button").hidden = true;
    return;
  }
  const flat = Boolean(state.filter.q.trim() || state.filter.newOnly || state.filter.favOnly);
  const newBanner = state.filter.newOnly && state.newPaths.size
    ? `<div class="new-banner">${icon("spark")}<span>正在查看 ${state.newPaths.size} 个新增文件</span><button type="button" data-action="ack-new">全部标为已读</button></div>`
    : "";
  if (!visible.length) {
    treeRoot.innerHTML = newBanner;
    empty.hidden = false;
    empty.querySelector("p").textContent = state.files.length ? "没有匹配的文件" : "文件夹里没有可显示的文件";
    empty.querySelector("button").hidden = false;
    return;
  }
  empty.hidden = true;
  if (flat) {
    const rows = visible.map((file) => fileRow(file, { flat: true })).join("");
    treeRoot.innerHTML = `${newBanner}<div class="tree-group"><div class="tree-group-head"><span>${state.filter.newOnly ? "新增文件" : state.filter.favOnly ? "已收藏" : "搜索结果"}</span><span class="line"></span><span>${visible.length}</span></div>${rows}</div>`;
    return;
  }
  const projectFiles = visible.filter((file) => !file.self);
  const selfFiles = visible.filter((file) => file.self);
  const renderGroup = (files, label) => {
    if (!files.length) return "";
    const node = buildTree(files);
    sortTree(node);
    return `<section class="tree-group"><div class="tree-group-head"><span>${escapeHtml(label)}</span><span class="line"></span><span>${files.length}</span></div>${renderNode(node)}</section>`;
  };
  let html = newBanner;
  html += renderGroup(projectFiles, state.filter.scope ? `目录 · ${state.filter.scope}` : "项目文件");
  html += renderGroup(selfFiles, "命令方块自身 · 防递归分组");
  treeRoot.innerHTML = html;
}

function toggleFolder(path) {
  if (state.expanded.has(path)) state.expanded.delete(path);
  else state.expanded.add(path);
  renderTree();
}

function revealSelectedRow() {
  requestAnimationFrame(() => {
    const row = $("#fileTree .tree-row.is-selected");
    if (!row) return;
    const scroller = $("#treeScroll");
    const rowBox = row.getBoundingClientRect();
    const scrollerBox = scroller.getBoundingClientRect();
    if (rowBox.top < scrollerBox.top) scroller.scrollTop += rowBox.top - scrollerBox.top - 8;
    else if (rowBox.bottom > scrollerBox.bottom) scroller.scrollTop += rowBox.bottom - scrollerBox.bottom + 8;
  });
}

function selectedFromTree(event) {
  const row = event.target.closest(".tree-row");
  if (!row) return null;
  return { row, path: row.dataset.path, kind: row.dataset.kind };
}

// ---------------------------------------------------------------------------
// Tree / favourites interaction
// ---------------------------------------------------------------------------

function bindTreeEvents() {
  const tree = $("#fileTree");

  tree.addEventListener("click", async (event) => {
    const ack = event.target.closest('[data-action="ack-new"]');
    if (ack) {
      await acknowledgeNew();
      return;
    }
    const favButton = event.target.closest('[data-action="fav"]');
    const selected = selectedFromTree(event);
    if (!selected) return;
    if (favButton) {
      event.stopPropagation();
      toggleFavorite(selected.path, selected.kind);
      return;
    }
    if (selected.kind === "folder") {
      toggleFolder(selected.path);
    } else {
      await openFile(selected.path, 0, { push: true });
    }
  });

  tree.addEventListener("dblclick", async (event) => {
    const selected = selectedFromTree(event);
    if (!selected) return;
    if (selected.kind === "folder") {
      event.preventDefault();
      await openFolder(selected.path, { push: true });
    }
  });

  tree.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const selected = selectedFromTree(event);
    if (!selected) return;
    event.preventDefault();
    if (selected.kind === "folder") toggleFolder(selected.path);
    else await openFile(selected.path, 0, { push: true });
  });

  tree.addEventListener("dragstart", (event) => {
    const row = event.target.closest(".tree-row");
    if (!row) return;
    state.dragData = {
      type: "tree",
      path: row.dataset.path,
      kind: row.dataset.kind,
      name: basename(row.dataset.path),
    };
    row.classList.add("is-dragging");
    try {
      event.dataTransfer.effectAllowed = "copyMove";
      event.dataTransfer.setData("text/plain", row.dataset.path);
    } catch { /* noop */ }
  });

  tree.addEventListener("dragend", () => {
    state.dragData = null;
    tree.querySelectorAll(".is-dragging").forEach((node) => node.classList.remove("is-dragging"));
    clearDropIndicators();
  });
}

function clearDropIndicators() {
  $$(".fav-category.is-dragover", $("#favoritesList")).forEach((node) => node.classList.remove("is-dragover"));
  $$(".fav-drop-line", $("#favoritesList")).forEach((node) => node.remove());
  $$(".tree-row.is-drop-target", $("#fileTree")).forEach((node) => node.classList.remove("is-drop-target"));
  $$(".fav-head.is-drop-target", $("#favoritesList")).forEach((node) => node.classList.remove("is-drop-target"));
}

function dropIndexFor(container, clientY) {
  const items = $$(".fav-item", container);
  for (let i = 0; i < items.length; i += 1) {
    const rect = items[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return items.length;
}

function moveFavoriteItem(fromCategoryId, path, toCategoryId, index) {
  const source = favoriteCategories().find((cat) => cat.id === fromCategoryId);
  const target = favoriteCategories().find((cat) => cat.id === toCategoryId);
  if (!source || !target) return false;
  const sourceIndex = (source.items || []).findIndex((item) => item.path === path);
  if (sourceIndex < 0) return false;
  if (source.id === target.id && sourceIndex === index) return false;
  if (target.id !== source.id && (target.items || []).some((item) => item.path === path)) {
    toast("目标分类中已有这个条目", "warn");
    return false;
  }
  const [item] = source.items.splice(sourceIndex, 1);
  let insertAt = clamp(index, 0, target.items.length);
  if (source.id === target.id && sourceIndex < insertAt) insertAt -= 1;
  target.items.splice(insertAt, 0, item);
  saveFavoritesSoon();
  renderFavorites();
  renderTree();
  return true;
}

function reorderCategory(sourceId, targetId, before = true) {
  const from = favoriteCategories().findIndex((cat) => cat.id === sourceId);
  const to = favoriteCategories().findIndex((cat) => cat.id === targetId);
  if (from < 0 || to < 0 || from === to) return false;
  const [category] = state.favorites.splice(from, 1);
  let insertAt = favoriteCategories().findIndex((cat) => cat.id === targetId);
  if (!before) insertAt += 1;
  state.favorites.splice(clamp(insertAt, 0, state.favorites.length), 0, category);
  saveFavoritesSoon();
  renderFavorites();
  return true;
}

function bindFavoriteEvents() {
  const list = $("#favoritesList");

  list.addEventListener("click", async (event) => {
    const add = event.target.closest("[data-add-category]");
    if (add) { addCategory(); return; }
    const toggle = event.target.closest("[data-toggle-cat]");
    if (toggle) { toggleCategoryCollapse(toggle.dataset.toggleCat); return; }
    const rename = event.target.closest("[data-rename-cat]");
    if (rename) { startRenameCategory(rename.dataset.renameCat); return; }
    const del = event.target.closest("[data-delete-cat]");
    if (del) { await deleteCategory(del.dataset.deleteCat); return; }
    const remove = event.target.closest("[data-fav-remove]");
    if (remove) {
      event.stopPropagation();
      removeFavorite(remove.dataset.favRemove, remove.dataset.path);
      return;
    }
    const item = event.target.closest(".fav-item");
    if (item) {
      if (item.dataset.kind === "folder") await openFolder(item.dataset.path, { push: true });
      else await openFile(item.dataset.path, 0, { push: true });
      return;
    }
    const head = event.target.closest(".fav-head");
    if (head && !event.target.closest("button")) {
      toggleCategoryCollapse(head.closest(".fav-category").dataset.catId);
    }
  });

  list.addEventListener("dblclick", (event) => {
    const name = event.target.closest(".fav-name");
    if (!name) return;
    const category = name.closest(".fav-category");
    if (category) startRenameCategory(category.dataset.catId);
  });

  list.addEventListener("dragstart", (event) => {
    const head = event.target.closest(".fav-head");
    const item = event.target.closest(".fav-item");
    if (item) {
      state.dragData = {
        type: "favorite",
        path: item.dataset.path,
        kind: item.dataset.kind,
        name: basename(item.dataset.path),
        fromCategory: item.dataset.catId,
      };
      item.classList.add("is-dragging");
      try {
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData("text/plain", item.dataset.path);
      } catch { /* noop */ }
      return;
    }
    if (head) {
      state.dragData = { type: "category", categoryId: head.dataset.dragCat };
      head.closest(".fav-category")?.classList.add("is-dragging");
      try {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", "category");
      } catch { /* noop */ }
    }
  });

  list.addEventListener("dragend", () => {
    clearDropIndicators();
    state.dragData = null;
    list.querySelectorAll(".is-dragging").forEach((node) => node.classList.remove("is-dragging"));
  });

  list.addEventListener("dragover", (event) => {
    if (!state.dragData) return;
    const category = event.target.closest(".fav-category");
    if (!category) return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = state.dragData.type === "category" ? "move" : "copy"; } catch { /* noop */ }
    clearDropIndicators();
    category.classList.add("is-dragover");
    if (state.dragData.type === "category") {
      const head = event.target.closest(".fav-head");
      if (head) head.classList.add("is-drop-target");
      return;
    }
    const items = category.querySelector(".fav-items");
    if (!items) return;
    const index = dropIndexFor(items, event.clientY);
    const reference = $$(".fav-item", items)[index] || null;
    const line = document.createElement("div");
    line.className = "fav-drop-line";
    if (reference) items.insertBefore(line, reference);
    else items.appendChild(line);
  });

  list.addEventListener("drop", (event) => {
    if (!state.dragData) return;
    event.preventDefault();
    const category = event.target.closest(".fav-category");
    if (!category) {
      if (state.dragData.type === "tree") {
        const categoryId = ensureCategory();
        addFavoriteToCategory(categoryId, state.dragData.path, state.dragData.kind, state.dragData.name);
      }
      clearDropIndicators();
      state.dragData = null;
      return;
    }
    const categoryId = category.dataset.catId;
    const drag = state.dragData;
    if (drag.type === "category") {
      reorderCategory(drag.categoryId, categoryId, true);
    } else {
      const items = category.querySelector(".fav-items");
      const index = items ? dropIndexFor(items, event.clientY) : 0;
      if (drag.type === "tree") {
        addFavoriteToCategory(categoryId, drag.path, drag.kind, drag.name, index);
      } else if (drag.type === "favorite") {
        moveFavoriteItem(drag.fromCategory, drag.path, categoryId, index);
      }
    }
    clearDropIndicators();
    state.dragData = null;
  });

  list.addEventListener("dragleave", (event) => {
    if (!list.contains(event.relatedTarget)) clearDropIndicators();
  });
}

// ---------------------------------------------------------------------------
// File viewer
// ---------------------------------------------------------------------------

function fileHash(path, line = 0) {
  return `#/file?path=${encodeURIComponent(path)}${line ? `&line=${Number(line)}` : ""}`;
}

function folderHash(path) {
  return `#/folder?path=${encodeURIComponent(path || "")}`;
}

function setHash(hash, { push = false } = {}) {
  if (location.hash === hash) return;
  if (push) history.pushState(null, "", hash);
  else history.replaceState(null, "", hash);
}

function setActiveView(view) {
  $("#welcome").hidden = view !== "welcome";
  $("#fileView").hidden = view !== "file";
  $("#folderView").hidden = view !== "folder";
  $("#indexView").hidden = view !== "index";
  const promptView = $("#promptView");          // 命令方块里整块提词器已被摘掉
  if (promptView) promptView.hidden = view !== "prompt";
  const inFiles = view === "welcome" || view === "file" || view === "folder";
  $("#tabFiles").classList.toggle("is-active", inFiles);
  $("#tabIndex").classList.toggle("is-active", view === "index");
  const tabPrompt = $("#tabPrompt");
  if (tabPrompt) tabPrompt.classList.toggle("is-active", view === "prompt");
}

function showWelcome({ push = false } = {}) {
  state.view = "welcome";
  setActiveView("welcome");
  setHash("#/", { push });
  updateWelcome();
}

function updateFavButton() {
  const button = $("#favFileBtn");
  if (!button) return;
  const fav = state.currentPath && isFavorited(state.currentPath);
  button.classList.toggle("is-starred", Boolean(fav));
  button.querySelector("span").textContent = fav ? "已收藏" : "收藏";
}

function renderCrumbs(path) {
  const crumbs = $("#fileCrumbs");
  const parts = path.split("/").filter(Boolean);
  let html = `<button class="crumb" type="button" data-folder="">${escapeHtml(state.rootName || "工作区")}</button>`;
  let current = "";
  parts.forEach((part, index) => {
    current = current ? `${current}/${part}` : part;
    html += `<span class="crumb-sep">/</span>`;
    if (index === parts.length - 1) {
      html += `<span class="crumb is-current">${escapeHtml(part)}</span>`;
    } else {
      html += `<button class="crumb" type="button" data-folder="${escapeHtml(current)}">${escapeHtml(part)}</button>`;
    }
  });
  crumbs.innerHTML = html;
}

function codeLineHTML(line, number, language, highlight) {
  const clean = line.replace(/\r$/, "");
  const content = highlight ? highlightLine(clean, language) : escapeHtml(clean);
  return `<div class="code-line" data-line="${number}" id="L${number}"><span class="line-no" data-line="${number}">${number}</span><span class="line-code">${content}</span></div>`;
}

function scrollToLine(line) {
  const scroll = $("#codeScroll");
  if (!scroll) return;
  $$(".code-line.is-active", $("#codeLines")).forEach((node) => node.classList.remove("is-active"));
  if (!line) {
    scroll.scrollTop = 0;
    return;
  }
  const target = document.getElementById(`L${line}`);
  if (!target) return;
  target.classList.add("is-active");
  const top = target.offsetTop - scroll.clientHeight / 2 + target.offsetHeight / 2;
  scroll.scrollTop = Math.max(0, top);
}

function renderFile(data, { line = 0, preserveScroll = false } = {}) {
  const scrollTop = preserveScroll ? $("#codeScroll")?.scrollTop || 0 : 0;
  state.currentFile = data;
  state.currentPath = data.path;
  $("#fileLoading").hidden = true;
  $("#codeWrap").hidden = false;
  $("#fileLang").textContent = languageLabel(data.language);
  $("#fileMeta").textContent = `${formatBytes(data.size)} · ${data.lines || 0} 行 · ${formatDate(data.mtime)}`;
  $("#filePath").textContent = data.path;
  renderCrumbs(data.path);
  updateFavButton();
  renderNoteStrip(data.path, data);

  const notices = [];
  if (data.binary) notices.push(`${icon("alert")} 这是二进制文件，命令方块只读模式不显示其内容。`);
  if (data.truncated) notices.push(`${icon("alert")} 文件超过 2 MB，仅读取了前 2 MB。`);
  const notice = $("#fileNotice");
  notice.hidden = notices.length === 0;
  notice.innerHTML = notices.join("");

  if (data.binary) {
    $("#codeLines").innerHTML = `<div class="code-empty">${icon("file")}<strong>无法预览二进制文件</strong><span>${escapeHtml(data.path)} · ${escapeHtml(formatBytes(data.size))}</span></div>`;
    scrollToLine(0);
    return;
  }

  const rawLines = String(data.content || "").split("\n");
  if (rawLines.length && rawLines[rawLines.length - 1] === "") rawLines.pop();
  if (!rawLines.length) rawLines.push("");
  const truncatedRender = rawLines.length > MAX_RENDER_LINES;
  const lines = truncatedRender ? rawLines.slice(0, MAX_RENDER_LINES) : rawLines;
  const highlight = data.content.length <= MAX_HIGHLIGHT_CHARS && !truncatedRender;
  if (truncatedRender) {
    notice.hidden = false;
    notice.innerHTML += `${icon("alert")} 文件较大，仅渲染前 ${MAX_RENDER_LINES} 行；完整文本仍保留在只读源文件中。`;
  }
  const html = lines.map((content, index) => codeLineHTML(content, index + 1, data.language, highlight)).join("");
  $("#codeLines").innerHTML = html;
  const maxScroll = $("#codeScroll").scrollHeight;
  $("#codeScroll").scrollTop = preserveScroll ? Math.min(scrollTop, maxScroll) : 0;
  state.currentLine = line;
  if (line) scrollToLine(line);
}

async function openFile(path, line = 0, { push = true, force = false, preserveScroll = false, silent = false } = {}) {
  if (!path) return;
  const same = state.currentFile && state.currentFile.path === path;
  const previousView = state.view;
  if (previousView === "file" || previousView === "folder") {
    state.lastContentView = previousView === "file"
      ? { type: "file", path: state.currentPath, line: state.currentLine }
      : { type: "folder", path: state.folderPath };
  }
  state.view = "file";
  setActiveView("file");
  state.currentPath = path;
  state.currentLine = Number(line) || 0;
  expandAncestors(path);
  renderTree();
  renderPie();
  revealSelectedRow();
  setHash(fileHash(path, state.currentLine), { push });
  if (same && !force) {
    updateFavButton();
    if (state.currentLine) scrollToLine(state.currentLine);
    else $("#codeScroll").scrollTop = 0;
    return;
  }
  $("#fileLoading").hidden = false;
  $("#codeWrap").hidden = true;
  $("#fileNotice").hidden = true;
  $("#fileLang").textContent = "…";
  $("#fileMeta").textContent = "正在读取文件…";
  $("#filePath").textContent = path;
  renderCrumbs(path);
  updateFavButton();
  try {
    const data = await request(`/api/file?path=${encodeURIComponent(path)}`);
    if (state.currentPath !== path) return;
    state.lastContentView = { type: "file", path, line: state.currentLine };
    renderFile(data, { line: state.currentLine, preserveScroll });
  } catch (error) {
    $("#fileLoading").hidden = true;
    $("#codeWrap").hidden = false;
    $("#codeLines").innerHTML = `<div class="code-empty">${icon("alert")}<strong>无法打开这个文件</strong><span>${escapeHtml(error.message)}</span></div>`;
    if (!silent) toast(error.message, "error");
    if (!state.currentFile) showWelcome({ push: false });
  }
}

async function reloadCurrentFile() {
  if (!state.currentPath) return;
  await openFile(state.currentPath, state.currentLine, {
    force: true,
    push: false,
    preserveScroll: true,
    silent: true,
  });
  toast("已重新读取文件");
}

// ---------------------------------------------------------------------------
// Folder view
// ---------------------------------------------------------------------------

function folderContents(path) {
  const prefix = path ? path.replace(/\/$/, "") + "/" : "";
  const dirs = new Map();
  const files = [];
  let totalSize = 0;
  for (const file of state.files) {
    if (!file.path.startsWith(prefix)) continue;
    totalSize += file.size;
    const rest = file.path.slice(prefix.length);
    const parts = rest.split("/");
    if (parts.length > 1) {
      const name = parts[0];
      const dirPath = prefix + name;
      if (!dirs.has(dirPath)) dirs.set(dirPath, { path: dirPath, name, count: 0, size: 0 });
      const dir = dirs.get(dirPath);
      dir.count += 1;
      dir.size += file.size;
    } else {
      files.push(file);
    }
  }
  return {
    dirs: [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    files: files.sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    totalSize,
  };
}

function renderFolder() {
  const path = state.folderPath;
  const contents = folderContents(path);
  const title = path ? basename(path) : state.rootName || "工作区";
  $("#folderTitle").textContent = title;
  $("#folderMeta").textContent = `${contents.files.length} 个直属文件 · ${contents.dirs.length} 个子目录 · ${formatBytes(contents.totalSize)}`;
  const rows = [];
  for (const dir of contents.dirs) {
    rows.push(`<div class="folder-row is-dir" data-path="${escapeHtml(dir.path)}" data-kind="folder">
      ${icon("folder")}
      <span class="folder-row-name">${escapeHtml(dir.name)}</span>
      <span class="folder-row-path">${escapeHtml(dir.path)}</span>
      <span class="folder-row-meta">${dir.count} 文件</span>
    </div>`);
  }
  for (const file of contents.files) {
    rows.push(`<div class="folder-row is-file" data-path="${escapeHtml(file.path)}" data-kind="file">
      ${icon(kindIcon(file.kind, file.language))}
      <span class="folder-row-name">${escapeHtml(file.name)}</span>
      <span class="folder-row-path">${escapeHtml(file.path)}</span>
      <span class="folder-row-meta">${escapeHtml(formatBytes(file.size))}</span>
    </div>`);
  }
  $("#folderList").innerHTML = rows.length
    ? rows.join("")
    : `<div class="folder-empty">这个目录下没有可显示文件。</div>`;
}

async function openFolder(path = "", { push = true } = {}) {
  if (state.view === "file") state.lastContentView = { type: "file", path: state.currentPath, line: state.currentLine };
  state.view = "folder";
  state.folderPath = path;
  setActiveView("folder");
  setHash(folderHash(path), { push });
  renderFolder();
  renderPie();
}

// ---------------------------------------------------------------------------
// Feature index
// ---------------------------------------------------------------------------

function symbolKindGroup(kind) {
  if (kind === "function") return "function";
  if (kind === "class" || kind === "type" || kind === "impl") return "class";
  if (kind === "method") return "method";
  if (kind === "section") return "section";
  return "other";
}

const SYMBOL_KIND_LABEL = {
  function: "FN",
  class: "CLS",
  method: "MTH",
  section: "DOC",
  type: "TYPE",
  impl: "IMPL",
};

function renderIndexStats() {
  const index = state.index;
  if (!index) {
    $("#indexStats").innerHTML = "";
    return;
  }
  const missing = index.missingTotal || 0;
  $("#indexStats").innerHTML = `
    <div class="index-stat"><strong>${index.symbolsTotal || 0}</strong><span>功能条目${index.truncated ? " · 已截断" : ""}</span></div>
    <div class="index-stat"><strong>${index.filesIndexed || 0}</strong><span>已索引文件</span></div>
    <div class="index-stat"><strong>${index.refsTotal || 0}</strong><span>本地相对引用</span></div>
    <div class="index-stat ${missing ? "is-bad" : "is-good"}"><strong>${missing}</strong><span>未解析引用</span></div>`;
}

function renderIndexSymbols() {
  const container = $("#symbolList");
  if (!state.index) {
    container.innerHTML = "";
    $("#symbolEmpty").hidden = false;
    $("#symbolCount").textContent = "—";
    return;
  }
  const query = state.indexFilter.q.trim().toLowerCase();
  const kind = state.indexFilter.kind;
  const symbols = (state.index.symbols || []).filter((symbol) => {
    if (kind !== "all" && symbolKindGroup(symbol.kind) !== kind) return false;
    if (!query) return true;
    return `${symbol.name} ${symbol.file} ${symbol.detail}`.toLowerCase().includes(query);
  });
  const shown = symbols.slice(0, MAX_SYMBOL_ROWS);
  $("#symbolCount").textContent = `${symbols.length}${symbols.length > shown.length ? " · 显示前 " + shown.length : ""}`;
  $("#symbolEmpty").hidden = symbols.length > 0;
  if (!symbols.length) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = shown.map((symbol) => `<button class="symbol-row" type="button" data-path="${escapeHtml(symbol.file)}" data-line="${symbol.line}">
    <span class="symbol-kind is-${escapeHtml(symbolKindGroup(symbol.kind))}">${escapeHtml(SYMBOL_KIND_LABEL[symbol.kind] || symbol.kind)}</span>
    <span class="symbol-name">${escapeHtml(symbol.name)}</span>
    <span class="symbol-detail">${escapeHtml(symbol.detail || "")}</span>
    <span class="symbol-file">${escapeHtml(symbol.file)}</span>
    <span class="symbol-line">${symbol.line}</span>
  </button>`).join("") + (symbols.length > shown.length ? `<div class="index-limit">为保持流畅，仅显示前 ${shown.length} 条；请用搜索缩小范围。</div>` : "");
}

function renderIndexRefs() {
  const index = state.index;
  if (!index) return;
  const missing = index.missing || [];
  $("#refCount").textContent = index.refsTotal ? `${index.refsTotal} 引用` : "—";
  $("#refSummary").innerHTML = `<span class="ref-pill">检查本地相对引用 ${index.refsTotal || 0}</span><span class="ref-pill ${missing.length ? "is-bad" : "is-ok"}">未解析 ${missing.length}</span>`;
  if (!missing.length) {
    $("#missingList").innerHTML = `<div class="refs-ok">${icon("check")}<span>本地相对 import / require 均能找到对应文件。</span></div>`;
    return;
  }
  $("#missingList").innerHTML = missing.map((item) => `<button class="missing-row" type="button" data-path="${escapeHtml(item.file)}" data-line="${item.line}">
    <span class="missing-spec">${escapeHtml(item.spec)}</span>
    <span class="missing-file">${escapeHtml(item.file)}:${item.line} → ${escapeHtml(item.target || "")}</span>
  </button>`).join("");
}

function renderIndex() {
  $("#indexLoading").hidden = true;
  $("#indexBody").hidden = false;
  renderIndexStats();
  renderIndexSymbols();
  renderIndexRefs();
}

async function loadIndex(force = false, { silent = false } = {}) {
  if (!state.tree) return;
  if (!force && state.index && !state.indexStale) {
    renderIndex();
    return;
  }
  $("#indexLoading").hidden = false;
  $("#indexBody").hidden = true;
  try {
    const data = await request(`/api/index${force ? "?refresh=1" : ""}`);
    state.index = data;
    state.indexStale = false;
    renderIndex();
  } catch (error) {
    $("#indexLoading").hidden = true;
    $("#indexBody").hidden = false;
    if (!silent) toast(error.message, "error");
  }
}

async function openIndex({ push = true } = {}) {
  if (state.view === "file" || state.view === "folder") {
    state.lastContentView = state.view === "file"
      ? { type: "file", path: state.currentPath, line: state.currentLine }
      : { type: "folder", path: state.folderPath };
  }
  state.view = "index";
  setActiveView("index");
  setHash("#/index", { push });
  await loadIndex(false);
}

// ---------------------------------------------------------------------------
// New files / watching
// ---------------------------------------------------------------------------

async function acknowledgeNew() {
  try {
    await request("/api/new/ack", { method: "POST", body: {} });
    state.newPaths.clear();
    for (const file of state.files) file.new = false;
    if (state.tree) {
      state.tree.newCount = 0;
      state.tree.newFiles = [];
    }
    state.filter.newOnly = false;
    renderTree();
    renderStatus();
    toast("新增文件已全部标记为已读");
  } catch (error) {
    toast(error.message, "error");
  }
}

function toggleNewFilter() {
  if (!state.newPaths.size) {
    toast("目前没有新增文件", "warn");
    return;
  }
  state.filter.newOnly = !state.filter.newOnly;
  if (state.filter.newOnly) {
    state.filter.scope = "";
    state.filter.q = "";
    state.filter.kind = "all";
    state.filter.favOnly = false;
    if ($("#fileSearch")) $("#fileSearch").value = "";
  }
  syncFilterControls();
  renderTree();
  renderStatus();
}

function syncFilterControls() {
  $$("#filterRow [data-kind]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.kind === state.filter.kind);
  });
  $("#newFilterBtn").classList.toggle("is-active", state.filter.newOnly);
  $("#favFilterBtn").classList.toggle("is-active", state.filter.favOnly);
  const scopeBar = $("#scopeBar");
  scopeBar.hidden = !state.filter.scope;
  $("#scopePath").textContent = state.filter.scope || "";
  $("#searchClear").hidden = !state.filter.q;
}

function applyTree(tree, { initial = false, announceNew = false } = {}) {
  const previousNew = state.newPaths.size;
  const previousSignature = state.tree?.signature;
  state.tree = tree;
  state.files = tree.files || [];
  state.filesByPath = new Map(state.files.map((file) => [file.path, file]));
  state.newPaths = new Set(tree.newFiles || []);
  state.rootName = tree.rootName || state.rootName;
  if (!state.treeInitialized || initial) {
    state.expanded = initialExpanded();
    state.treeInitialized = true;
  }
  if (state.currentPath) expandAncestors(state.currentPath);
  if (tree.signature && previousSignature && tree.signature !== previousSignature) state.indexStale = true;
  renderTree();
  renderStatus();
  updateWelcome();
  updateRootUI();
  renderPie();
  if (announceNew && state.newPaths.size > previousNew) {
    toast(`新增 ${state.newPaths.size - previousNew} 个文件`, "ok");
  }
}

async function loadTree({ force = false, initial = false, announceNew = false } = {}) {
  if (!state.root) return;
  $("#treeLoading").hidden = false;
  try {
    const tree = await request(`/api/tree${force ? "?refresh=1" : ""}`);
    applyTree(tree, { initial, announceNew });
    setSync("ok", `已同步 ${formatClock()}`);
  } catch (error) {
    $("#treeLoading").hidden = true;
    setSync("warn", "同步失败");
    toast(error.message, "error");
  }
}

let watchTimer = null;
function scheduleWatchRefresh() {
  if (!state.root) return;
  setSync("syncing", "同步中…");
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    if (state.refreshing) return;
    state.refreshing = true;
    const previousMtime = state.currentFile?.mtime;
    try {
      const tree = await request("/api/tree");
      applyTree(tree, { announceNew: true });
      if (state.view === "file" && state.currentPath && state.currentFile) {
        const meta = state.filesByPath.get(state.currentPath);
        if (meta && meta.mtime !== previousMtime) {
          await openFile(state.currentPath, state.currentLine, {
            force: true,
            push: false,
            preserveScroll: true,
            silent: true,
          });
          toast("当前文件已同步更新");
        }
      }
      setSync("ok", `已同步 ${formatClock()}`);
    } catch {
      setSync("warn", "连接中断，重试中…");
    } finally {
      state.refreshing = false;
    }
  }, 260);
}

function connectEvents() {
  if (!window.EventSource) {
    setSync("warn", "浏览器不支持自动同步");
    return;
  }
  const source = new EventSource("/api/events");
  source.addEventListener("hello", () => setSync("ok", `已同步 ${formatClock()}`));
  source.addEventListener("tree", () => scheduleWatchRefresh());
  // 外部（如虚幻客户端）请求把当前窗口跳转到某个文件，复用同一个窗口
  source.addEventListener("focus", (event) => {
    try {
      const data = JSON.parse(event.data);
      openFile(data.path, Number(data.line) || 0, { force: true, push: true });
    } catch (e) { /* 忽略非法的 focus 事件 */ }
  });
  source.addEventListener("api-status", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (state.api && data?.state) {
        state.api.status = data;
        renderApi();
      }
    } catch { /* noop */ }
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) setSync("warn", "自动同步已断开");
    else setSync("syncing", "正在重连…");
  };
}

async function rescan() {
  if (!state.root) return;
  const button = $("#rescanBtn");
  button.disabled = true;
  button.classList.add("is-spinning");
  setSync("syncing", "重新扫描…");
  try {
    const tree = await request("/api/rescan", { method: "POST", body: {} });
    if (!state.treeInitialized) state.expanded = initialExpanded();
    applyTree(tree, { announceNew: true });
    setSync("ok", `已同步 ${formatClock()}`);
    toast("扫描完成");
  } catch (error) {
    toast(error.message, "error");
    setSync("warn", "扫描失败");
  } finally {
    button.disabled = false;
    button.classList.remove("is-spinning");
  }
}

// ---------------------------------------------------------------------------
// API settings
// ---------------------------------------------------------------------------

function apiDotClass(status) {
  const value = status?.state;
  if (value === "ok") return "is-ok";
  if (value === "auth" || value === "offline" || value === "error" || value === "endpoint") return "is-bad";
  if (value === "checking") return "is-checking";
  return "is-unchecked";
}

function apiVisual() {
  const api = state.api;
  if (!api || !api.baseUrl) return { dot: "is-unchecked", text: "API 未配置", detail: "还没有填写 API 地址" };
  if (!api.hasKey) return { dot: "is-unchecked", text: "API 未配置", detail: "填写 API Key 后才能监测外部服务" };
  const status = api.status || {};
  const map = {
    ok: ["is-ok", "API 已连接"],
    checking: ["is-checking", "API 检测中"],
    auth: ["is-bad", "API 认证失败"],
    offline: ["is-bad", "API 无法连接"],
    endpoint: ["is-bad", "API 地址异常"],
    error: ["is-bad", "API 检测失败"],
    unchecked: ["is-unchecked", "API 待检测"],
  };
  const [dot, text] = map[status.state] || map.unchecked;
  return { dot, text, detail: status.message || text };
}

function renderApi() {
  const visual = apiVisual();
  $("#apiChipText").textContent = visual.text;
  $("#statusApiText").textContent = visual.text;
  $("#apiDot").className = `status-dot ${visual.dot}`;
  $("#statusApiDot").className = `status-dot ${visual.dot}`;
  $("#apiChip").title = `${visual.detail}${state.api?.status?.latency ? ` · ${state.api.status.latency} ms` : ""}`;
  $("#statusApi").title = $("#apiChip").title;
}

function apiStatusCard(status = state.api?.status) {
  if (!state.api?.baseUrl) {
    return `<div class="api-status-card" id="apiStatusCard"><span class="status-dot is-unchecked"></span><div><strong>尚未配置 API</strong><span>填写接口地址后可以检测连接状态。API 密钥只保存在本机。</span></div></div>`;
  }
  if (!state.api.hasKey) {
    return `<div class="api-status-card" id="apiStatusCard"><span class="status-dot is-unchecked"></span><div><strong>尚未填写 API Key</strong><span>本地服务可能不需要密钥；填写后才能监测云端接口。</span></div></div>`;
  }
  const visual = apiVisual();
  const cls = visual.dot === "is-ok" ? "is-ok" : visual.dot === "is-bad" ? "is-bad" : "";
  const checked = status?.checkedAt ? ` · ${formatDate(status.checkedAt)}` : "";
  return `<div class="api-status-card ${cls}" id="apiStatusCard"><span class="status-dot ${visual.dot}"></span><div><strong>${escapeHtml(visual.text)}</strong><span>${escapeHtml(status?.message || visual.detail || "")}${escapeHtml(checked)}</span></div></div>`;
}

async function testApi({ silent = false } = {}) {
  if (!state.api) return null;
  if (!state.api.baseUrl) {
    if (!silent) toast("请先填写 API 地址", "warn");
    return null;
  }
  if (!state.api.hasKey && !state.api.baseUrl.includes("127.0.0.1") && !state.api.baseUrl.includes("localhost")) {
    if (!silent) toast("请先填写 API Key", "warn");
    return null;
  }
  state.api.status = { state: "checking", message: "正在连接…", checkedAt: Date.now(), latency: null };
  renderApi();
  const card = $("#apiStatusCard");
  if (card) card.outerHTML = apiStatusCard();
  try {
    const result = await request("/api/api/test", { method: "POST", body: {} });
    state.api.status = result;
    renderApi();
    const nextCard = $("#apiStatusCard");
    if (nextCard) nextCard.outerHTML = apiStatusCard(result);
    if (!silent) toast(result.state === "ok" ? "API 连接正常" : result.message, result.state === "ok" ? "ok" : "warn");
    return result;
  } catch (error) {
    state.api.status = { state: "error", message: error.message, checkedAt: Date.now() };
    renderApi();
    if (!silent) toast(error.message, "error");
    return null;
  }
}

function startApiMonitor() {
  if (state.apiTimer) clearInterval(state.apiTimer);
  state.apiTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!state.api?.autoCheck || !state.api?.hasKey) return;
    testApi({ silent: true });
  }, 5 * 60 * 1000);
}

function openApiModal() {
  if (!state.api) return;
  const api = state.api;
  openModal(
    `<form class="modal-card" id="apiForm" role="dialog" aria-modal="true" aria-labelledby="apiTitle">
      <div class="modal-head">
        <div class="modal-head-copy"><span class="eyebrow">OPENAI-COMPATIBLE</span><h2 id="apiTitle">API 接入</h2><p>填写一个兼容 OpenAI 的接口，命令方块只做连接检测，不会自动发送代码或调用模型。</p></div>
        <button class="modal-close" type="button" data-close aria-label="关闭">${icon("close")}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label for="apiBase">Base URL</label>
          <input class="text-input mono" id="apiBase" name="baseUrl" value="${escapeHtml(api.baseUrl || "")}" placeholder="https://api.deepseek.com/v1" spellcheck="false">
          <p class="hint">会访问 <code>Base URL + /models</code> 检查连接与密钥。</p>
        </div>
        <div class="field">
          <label for="apiModel">默认模型</label>
          <input class="text-input mono" id="apiModel" name="model" value="${escapeHtml(api.model || "")}" placeholder="deepseek-chat" spellcheck="false">
        </div>
        <div class="field">
          <label for="apiKey">API Key</label>
          <div class="input-with-action">
            <input class="text-input mono" id="apiKey" name="apiKey" type="password" autocomplete="off" placeholder="${api.hasKey ? `已保存 ${escapeHtml(api.maskedKey || "")}，留空则不修改` : "sk-…"}" spellcheck="false">
            <button class="small-btn" type="button" id="apiReveal">显示</button>
          </div>
          <p class="hint">密钥写入本机配置目录（文件权限 600），不会进入项目文件，也不会出现在页面源码或文件镜像里。</p>
        </div>
        <label class="check-row"><input type="checkbox" id="apiAutoCheck" ${api.autoCheck ? "checked" : ""}><span>每 5 分钟自动检测一次连接状态（页面打开时）</span></label>
        ${apiStatusCard(api.status)}
        <div id="apiFormError" class="modal-error" hidden></div>
        <div class="safety-note"><strong>只读边界：</strong>扫描会排除 <code>.env</code>、密钥、证书、日志、缓存、构建产物和符号链接；API 功能不会读取或上传项目文件。</div>
      </div>
      <div class="modal-foot">
        <button class="ghost-btn" type="button" id="apiTestBtn">${icon("api")}测试连接</button>
        ${api.hasKey ? `<button class="small-btn" type="button" id="apiClearKey">清除密钥</button>` : ""}
        <span class="spacer"></span>
        <button class="small-btn" type="button" data-close>取消</button>
        <button class="primary-btn" type="submit">保存配置</button>
      </div>
    </form>`,
  );
  bindApiModal();
}

function setApiFormError(message = "") {
  const node = $("#apiFormError");
  if (!node) return;
  node.hidden = !message;
  node.textContent = message;
}

function collectApiForm() {
  return {
    baseUrl: $("#apiBase")?.value.trim() || "",
    model: $("#apiModel")?.value.trim() || "",
    autoCheck: Boolean($("#apiAutoCheck")?.checked),
    apiKey: $("#apiKey")?.value || "",
  };
}

async function saveApiFields(payload, { silent = false } = {}) {
  const result = await request("/api/api", { method: "POST", body: payload });
  state.api = { ...result, status: result.status || state.api?.status };
  renderApi();
  if ($("#apiStatusCard")) {
    const card = $("#apiStatusCard");
    if (card) card.outerHTML = apiStatusCard();
  }
  if (!silent) toast("API 配置已保存");
  return result;
}

function bindApiModal() {
  $("#modalLayer [data-close]")?.addEventListener("click", closeModal);
  $("#apiReveal")?.addEventListener("click", () => {
    const input = $("#apiKey");
    const button = $("#apiReveal");
    if (!input || !button) return;
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.textContent = show ? "隐藏" : "显示";
  });
  $("#apiForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("#apiForm button[type=submit]");
    submit.disabled = true;
    setApiFormError("");
    try {
      const payload = collectApiForm();
      await saveApiFields(payload);
      startApiMonitor();
      if (state.api.autoCheck && state.api.hasKey) await testApi({ silent: true });
      if ($("#apiKey")) $("#apiKey").value = "";
    } catch (error) {
      setApiFormError(error.message);
    } finally {
      submit.disabled = false;
    }
  });
  $("#apiTestBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    setApiFormError("");
    try {
      await saveApiFields(collectApiForm(), { silent: true });
      await testApi();
    } catch (error) {
      setApiFormError(error.message);
    } finally {
      button.disabled = false;
    }
  });
  $("#apiClearKey")?.addEventListener("click", async () => {
    const payload = { ...collectApiForm(), clearKey: true };
    try {
      await saveApiFields(payload, { silent: true });
      toast("API 密钥已清除");
      openApiModal();
    } catch (error) {
      setApiFormError(error.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Root picker
// ---------------------------------------------------------------------------

function openRootModal() {
  const current = state.root || "";
  const recents = state.recent
    .filter((item) => item && item.path)
    .map((item) => `<button class="recent-row" type="button" data-open-root="${escapeHtml(item.path)}">
      ${icon("folder")}
      <span class="recent-path">${escapeHtml(item.path)}</span>
      ${icon("chevron", "recent-chevron")}
    </button>`).join("");
  openModal(
    `<form class="modal-card" id="rootForm" role="dialog" aria-modal="true" aria-labelledby="rootTitle">
      <div class="modal-head">
        <div class="modal-head-copy"><span class="eyebrow">READ-ONLY WORKSPACE</span><h2 id="rootTitle">打开文件夹</h2><p>命令方块只读取这个文件夹，不会修改、移动或删除里面任何文件。</p></div>
        <button class="modal-close" type="button" data-close aria-label="关闭">${icon("close")}</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label for="rootPath">文件夹绝对路径</label>
          <div class="input-with-action">
            <input class="text-input mono" id="rootPath" value="${escapeHtml(current)}" placeholder="~/Projects/我的项目" spellcheck="false" autocomplete="off">
            <button class="small-btn" type="button" id="pickFolderBtn">系统选择</button>
          </div>
          <p class="hint">支持 ~ 开头。点击“系统选择”会弹出 macOS 文件夹选择器。</p>
        </div>
        <div id="rootError" class="modal-error" hidden></div>
        ${recents ? `<div class="recent-list"><div class="eyebrow" style="padding:8px 2px 4px">最近打开</div>${recents}</div>` : ""}
        <div class="safety-note"><strong>自动排除：</strong>.env 与密钥、日志、缓存、构建产物、依赖目录、符号链接。若命令方块自身在所选目录内，会单独分组，避免递归。</div>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="small-btn" type="button" data-close>取消</button>
        <button class="primary-btn" type="submit">${icon("folder-open")}打开此文件夹</button>
      </div>
    </form>`,
  );
  bindRootModal();
}

function setRootError(message = "") {
  const node = $("#rootError");
  if (!node) return;
  node.hidden = !message;
  node.textContent = message;
}

function bindRootModal() {
  $("#modalLayer [data-close]")?.addEventListener("click", closeModal);
  $("#rootForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const path = $("#rootPath")?.value.trim();
    if (!path) return;
    await switchRoot(path);
  });
  $("#pickFolderBtn")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "选择中…";
    try {
      const result = await request("/api/pick-folder", { method: "POST", body: {} });
      if (result.cancelled) return;
      if (result.unsupported) {
        toast("当前系统不支持原生选择器，请直接粘贴路径", "warn");
        return;
      }
      if (result.error) {
        toast(result.error, "warn");
        return;
      }
      $("#rootPath").value = result.path;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
  $("#modalLayer [data-open-root]")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-open-root]");
    if (!button) return;
    await switchRoot(button.dataset.openRoot);
  });
}

async function switchRoot(path) {
  clearTimeout(state.favSaveTimer);
  state.favSaveTimer = null;
  setRootError("");
  const submit = $("#rootForm button[type=submit]");
  if (submit) {
    submit.disabled = true;
    submit.dataset.label = submit.textContent;
    submit.textContent = "读取中…";
  }
  try {
    const result = await request("/api/root", { method: "POST", body: { path } });
    applyState(result.state);
    state.currentPath = "";
    state.currentLine = 0;
    state.currentFile = null;
    state.folderPath = "";
    state.lastContentView = null;
    state.index = null;
    state.indexStale = false;
    state.filter = { q: "", kind: "all", newOnly: false, favOnly: false, scope: "" };
    state.treeInitialized = false;
    state.expanded = new Set();
    if ($("#fileSearch")) $("#fileSearch").value = "";
    syncFilterControls();
    applyTree(result.tree, { initial: true });
    // 换根文件夹后，扇形图永远回到「根目录」这一档，不保留上一个项目的钻取位置。
    pieState.level = 0;
    pieState.base = "";
    pieState.hover = "";
    closeModal();
    showWelcome({ push: false });
    renderAll();
    setSync("ok", `已同步 ${formatClock()}`);
    toast(`已打开 ${basename(path)}`);
  } catch (error) {
    setRootError(error.message);
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.textContent = submit.dataset.label || "打开此文件夹";
    }
  }
}

// ---------------------------------------------------------------------------
// Release announcement
// ---------------------------------------------------------------------------

function releaseSection(section, index) {
  const items = section.items || [];
  const rows = items.map((item) => {
    const link = item.link
      ? `<a class="task-link" href="#" data-source-path="${escapeHtml(item.link.path)}" data-source-line="${Number(item.link.line) || 1}">${icon("file")}${escapeHtml(item.link.label || "查看源码")}</a>`
      : "";
    return `<li class="task-item">
      <span class="task-check">${icon("check")}</span>
      <span class="task-id">${escapeHtml(item.task || "")}</span>
      <span class="task-copy"><strong>${escapeHtml(item.title || "")}</strong>${item.desc ? `<p>${escapeHtml(item.desc)}</p>` : ""}</span>
      ${link}
    </li>`;
  }).join("");
  return `<details class="release-section" ${index < 4 ? "open" : ""}>
    <summary class="release-section-head">${icon("chevron")}<h3>${escapeHtml(section.title || "")}</h3><span class="count">${items.length} 项</span></summary>
    <ul class="task-list">${rows}</ul>
  </details>`;
}

function renderRelease(release) {
  const sections = release.sections || [];
  const candidates = release.candidates || [];
  const notes = release.notes || [];
  const sourceHint = rootIncludesApp()
    ? ""
    : `<div class="release-note" style="margin:8px 0 12px">当前工作区未包含命令方块源码，任务旁的“查看源码”会提示无法跳转。把工作区切换到 <code>${escapeHtml(state.appRoot)}</code> 即可查看。</div>`;
  const body = `
    <div class="drawer-head">
      <div class="drawer-title-row">
        <div style="flex:1">
          <span class="eyebrow">RELEASE NOTES</span>
          <h2>更新公告</h2>
          <p>${escapeHtml(release.summary || "")}</p>
        </div>
        <button class="modal-close" type="button" data-close aria-label="关闭">${icon("close")}</button>
      </div>
      <div class="release-meta">
        <span class="badge">v${escapeHtml(release.version || state.version)}</span>
        <span class="badge" style="background:var(--surface-2);color:var(--muted);border-color:var(--line)">${escapeHtml(release.releasedAt || "—")}</span>
        <span class="release-tools">
          <button class="small-btn" type="button" data-release-expand>展开全部</button>
          <button class="small-btn" type="button" data-release-collapse>收起全部</button>
          <button class="small-btn" type="button" data-copy-requirement>${icon("copy")}复制需求原文</button>
        </span>
      </div>
    </div>
    <div class="drawer-body">
      ${sourceHint}
      ${sections.map(releaseSection).join("")}
      <section class="release-section">
        <div class="release-section-head" style="padding-top:16px">${icon("layers")}<h3>候选与未做项</h3><span class="count">${candidates.length}</span></div>
        <div class="candidate-grid">${candidates.map((item) => `<div class="candidate"><code>${escapeHtml(item.id || "")}</code>${escapeHtml(item.title || "")}</div>`).join("")}</div>
        ${notes.map((note) => `<p class="release-note" style="margin-top:9px">${escapeHtml(note)}</p>`).join("")}
      </section>
      <details class="requirement-block">
        <summary>${icon("chevron")}本轮【用户需求】原文（可直接复制）</summary>
        <pre class="requirement-pre" id="releaseRequirement">${escapeHtml(release.requirement || "需求原文文件未找到。")}</pre>
        <button class="small-btn" type="button" data-copy-requirement>${icon("copy")}复制需求原文</button>
      </details>
    </div>
    <div class="release-footer"><span>命令方块 · Command Block</span><span>·</span><span>只读本地工具</span><span class="spacer"></span><span>v${escapeHtml(release.version || state.version)}</span></div>`;
  openModal(`<aside class="drawer" role="dialog" aria-modal="true" aria-label="更新公告">${body}</aside>`, { drawer: true });
  bindReleaseModal();
}

function bindReleaseModal() {
  $("#modalLayer [data-close]")?.addEventListener("click", closeModal);
  $$("#modalLayer [data-release-expand]").forEach((button) => button.addEventListener("click", () => {
    $$("#modalLayer details").forEach((details) => { details.open = true; });
  }));
  $$("#modalLayer [data-release-collapse]").forEach((button) => button.addEventListener("click", () => {
    $$("#modalLayer details").forEach((details) => { details.open = false; });
  }));
  $$("#modalLayer [data-copy-requirement]").forEach((button) => button.addEventListener("click", async () => {
    const text = state.release?.requirement || "";
    const ok = await copyText(text);
    toast(ok ? "需求原文已复制" : "复制失败，请手动选择文本", ok ? "ok" : "error");
  }));
}

async function openRelease() {
  if (!state.release) {
    try {
      state.release = await request("/api/release");
    } catch (error) {
      toast(error.message, "error");
      return;
    }
  }
  renderRelease(state.release);
}

// ---------------------------------------------------------------------------
// Routes / bindings / boot
// ---------------------------------------------------------------------------

async function applyRoute() {
  const hash = location.hash || "#/";
  const [pathPart, queryPart] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(queryPart || "");
  closeModal();
  if (pathPart === "/index") {
    await openIndex({ push: false });
    return;
  }
  if (pathPart === "/prompt") {
    // 旧书签可能还停在 #/prompt；命令方块里提词器已搬走，回欢迎页。
    if (PROMPTER_ONLY) await openPrompt({ push: false });
    else showWelcome({ push: false });
    return;
  }
  if (pathPart === "/release") {
    await openRelease();
    return;
  }
  if (pathPart === "/folder") {
    await openFolder(params.get("path") || "", { push: false });
    return;
  }
  if (pathPart === "/file") {
    const path = params.get("path") || "";
    const line = Number(params.get("line")) || 0;
    if (path) {
      await openFile(path, line, { push: false });
      return;
    }
  }
  showWelcome({ push: false });
}

// ---------------------------------------------------------------------------
// Theme（白天 / 夜晚）
// ---------------------------------------------------------------------------

/** 夜晚模式是另一套视觉语言（街机 HUD），只换皮不换结构。
 *  不落盘：打开时的主题由 boot.js 按「当下钟点」定（她 2026-11-09 定），
 *  这里只管本次会话内的切换 —— 若还写本地键，下次打开会有旧值把钟点覆盖掉。 */
function applyTheme(theme) {
  const next = theme === "night" ? "night" : "day";
  state.theme = next;
  document.documentElement.dataset.theme = next;
  const button = $("#themeBtn");
  if (button) {
    button.title = next === "night" ? "切回白天模式" : "切到夜晚模式";
    button.setAttribute("aria-pressed", next === "night" ? "true" : "false");
    const label = $("#themeBtnText");
    if (label) label.textContent = next === "night" ? "白天" : "夜晚";
  }
}

function bindGlobalEvents() {
  $("#noteEditBtn").addEventListener("click", openNoteEditor);
  // 提词器的事件只在独立客户端里绑；命令方块已把那块 DOM 摘掉。
  $("#rootChip").addEventListener("click", openRootModal);
  $("#openFolderBtn").addEventListener("click", openRootModal);
  $("#addCategoryBtn").addEventListener("click", addCategory);
  $("#themeBtn")?.addEventListener("click", () => applyTheme(state.theme === "night" ? "day" : "night"));
  $("#releaseBtn").addEventListener("click", openRelease);
  $("#apiChip").addEventListener("click", openApiModal);
  $("#statusApi").addEventListener("click", openApiModal);
  $("#tabFiles").addEventListener("click", async () => {
    if (state.view === "index") {
      const last = state.lastContentView;
      if (last?.type === "file") await openFile(last.path, last.line || 0, { push: true });
      else if (last?.type === "folder") await openFolder(last.path, { push: true });
      else showWelcome({ push: true });
    } else {
      showWelcome({ push: true });
    }
  });
  $("#tabIndex").addEventListener("click", () => openIndex({ push: true }));
  $("#welcomeIndexBtn").addEventListener("click", () => openIndex({ push: true }));
  $("#rescanBtn").addEventListener("click", rescan);
  $("#newJump").addEventListener("click", toggleNewFilter);
  $("#statusNew").addEventListener("click", toggleNewFilter);
  $("#newFilterBtn").addEventListener("click", toggleNewFilter);
  $("#favFilterBtn").addEventListener("click", () => {
    state.filter.favOnly = !state.filter.favOnly;
    if (state.filter.favOnly) {
      state.filter.newOnly = false;
      state.filter.scope = "";
    }
    syncFilterControls();
    renderTree();
    renderStatus();
  });
  $("#scopeClear").addEventListener("click", () => {
    state.filter.scope = "";
    syncFilterControls();
    renderTree();
    renderStatus();
  });
  $("#clearFiltersBtn").addEventListener("click", () => {
    state.filter = { q: "", kind: "all", newOnly: false, favOnly: false, scope: "" };
    if ($("#fileSearch")) $("#fileSearch").value = "";
    syncFilterControls();
    renderTree();
    renderStatus();
  });
  $("#filterRow").addEventListener("click", (event) => {
    const button = event.target.closest("[data-kind]");
    if (!button) return;
    state.filter.kind = button.dataset.kind;
    syncFilterControls();
    renderTree();
    renderStatus();
  });
  $("#fileSearch").addEventListener("input", (event) => {
    state.filter.q = event.target.value;
    syncFilterControls();
    renderTree();
    renderStatus();
  });
  $("#searchClear").addEventListener("click", () => {
    state.filter.q = "";
    $("#fileSearch").value = "";
    syncFilterControls();
    renderTree();
    renderStatus();
    $("#fileSearch").focus();
  });
  $("#favFileBtn").addEventListener("click", () => {
    if (state.currentPath) toggleFavorite(state.currentPath, "file", basename(state.currentPath));
  });
  $("#reloadFileBtn").addEventListener("click", reloadCurrentFile);
  $("#fileCrumbs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-folder]");
    if (!button) return;
    openFolder(button.dataset.folder || "", { push: true });
  });
  $("#codeLines").addEventListener("click", (event) => {
    const lineNode = event.target.closest(".code-line");
    if (!lineNode) return;
    const line = Number(lineNode.dataset.line);
    if (!line) return;
    $$(".code-line.is-active", $("#codeLines")).forEach((node) => node.classList.remove("is-active"));
    lineNode.classList.add("is-active");
    state.currentLine = line;
    if (state.currentPath) setHash(fileHash(state.currentPath, line), { push: false });
  });
  $("#folderList").addEventListener("click", async (event) => {
    const row = event.target.closest(".folder-row");
    if (!row) return;
    if (row.dataset.kind === "folder") await openFolder(row.dataset.path, { push: true });
    else await openFile(row.dataset.path, 0, { push: true });
  });
  $("#folderScopeBtn").addEventListener("click", () => {
    state.filter.scope = state.folderPath;
    state.filter.q = "";
    if ($("#fileSearch")) $("#fileSearch").value = "";
    syncFilterControls();
    renderTree();
    renderStatus();
    toast("文件栏已按这个目录筛选");
    $("#fileSearch").focus();
  });
  $("#indexRefreshBtn").addEventListener("click", () => loadIndex(true));
  $("#indexSearch").addEventListener("input", (event) => {
    state.indexFilter.q = event.target.value;
    renderIndexSymbols();
  });
  $("#indexKinds").addEventListener("click", (event) => {
    const button = event.target.closest("[data-symbol-kind]");
    if (!button) return;
    state.indexFilter.kind = button.dataset.symbolKind;
    $$("#indexKinds [data-symbol-kind]").forEach((node) => node.classList.toggle("is-active", node === button));
    renderIndexSymbols();
  });
  $("#symbolList").addEventListener("click", async (event) => {
    const row = event.target.closest("[data-path]");
    if (!row) return;
    await openFile(row.dataset.path, Number(row.dataset.line) || 1, { push: true });
  });
  $("#missingList").addEventListener("click", async (event) => {
    const row = event.target.closest("[data-path]");
    if (!row) return;
    await openFile(row.dataset.path, Number(row.dataset.line) || 1, { push: true });
  });
  $("#modalLayer").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
  });
  document.addEventListener("keydown", (event) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (state.view === "index") $("#indexSearch")?.focus();
      else $("#fileSearch")?.focus();
      return;
    }
    if (modifier && event.key.toLowerCase() === "b") {
      event.preventDefault();
      const first = $("#favoritesList .fav-item, #favoritesList [data-add-category]");
      if (first) first.focus();
      return;
    }
    if (event.key === "Escape") {
      if (!$("#modalLayer").hidden) { closeModal(); return; }
      if (document.activeElement === $("#fileSearch")) {
        state.filter.q = "";
        $("#fileSearch").value = "";
        syncFilterControls();
        renderTree();
        renderStatus();
      }
    }
  });
  $("#modalLayer").addEventListener("click", async (event) => {
    const link = event.target.closest("[data-source-path]");
    if (!link) return;
    event.preventDefault();
    const relative = link.dataset.sourcePath;
    const line = Number(link.dataset.sourceLine) || 1;
    const resolved = sourcePathFor(relative);
    if (!resolved) {
      toast("当前工作区未包含插件源码，无法跳转。请先切换工作区到插件目录。", "warn");
      return;
    }
    if (!state.filesByPath.has(resolved)) {
      toast(`文件不在当前镜像中：${resolved}`, "warn");
      return;
    }
    closeModal();
    await openFile(resolved, line, { push: true });
  });
  window.addEventListener("popstate", () => { applyRoute(); });
  window.addEventListener("blur", () => clearDropIndicators());
}

// ---------------------------------------------------------------------------
// File purpose notes
// ---------------------------------------------------------------------------

function noteTextFor(path) {
  return state.notes?.[path]?.text || "";
}

/** 从文件正文里抽开头那段注释，当作「这个文件自己怎么说」。 */
function headerNoteFor(data) {
  const content = String(data?.content || "");
  if (!content) return "";
  const lines = content.split("\n").slice(0, 40);
  const out = [];
  let started = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (started) break;
      continue;
    }
    if (!started) {
      const skip =
        line.startsWith("#!") ||
        line.startsWith("# -*-") ||
        line.startsWith("// @") ||
        line.startsWith("<") ||
        /^(import|from|package|using|namespace|export)\b/.test(line) ||
        /^["']use strict["'];?$/.test(line);
      if (skip) continue;
    }
    let text = "";
    if (line.startsWith("#")) text = line.replace(/^#+\s?/, "");
    else if (line.startsWith("//")) text = line.replace(/^\/+\s?/, "");
    else if (line.startsWith("/*") || line.startsWith("*")) text = line.replace(/^\/?\*+\s?/, "").replace(/\*\/$/, "");
    else if (line.startsWith('"""') || line.startsWith("'''")) text = line.slice(3).replace(/["']{3}$/, "");
    if (!text) {
      if (started) break;
      continue;
    }
    if (/^(TODO|FIXME|Copyright|Licen[cs]e|SPDX)/i.test(text)) continue;
    started = true;
    out.push(text.trim());
    if (out.join(" ").length > 110 || out.length >= 3) break;
  }
  const joined = out.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 130 ? `${joined.slice(0, 130)}…` : joined;
}

function renderNoteStrip(path, data = null) {
  const strip = $("#noteStrip");
  if (!strip) return;
  strip.dataset.path = path || "";
  const note = noteTextFor(path);
  const auto = note ? "" : headerNoteFor(data || state.currentFile);
  const text = $("#noteText");
  if (!text) return;
  const badge = $("#noteBadge");
  if (note) {
    text.textContent = note;
    text.classList.remove("is-empty", "is-auto");
    if (badge) badge.textContent = "用途";
  } else if (auto) {
    text.textContent = `文件自带注释：${auto}`;
    text.classList.remove("is-empty");
    text.classList.add("is-auto");
    if (badge) badge.textContent = "自动";
  } else {
    text.textContent = "还没有写这个文件是干什么的";
    text.classList.add("is-empty");
    text.classList.remove("is-auto");
    if (badge) badge.textContent = "用途";
  }
  const label = $("#noteEditBtn span");
  if (label) label.textContent = note ? "改说明" : "写说明";
}

function openNoteEditor() {
  const path = state.currentPath;
  if (!path) return;
  const note = noteTextFor(path);
  openModal(`
    <div class="modal-card note-card" role="dialog" aria-modal="true" aria-labelledby="noteTitle">
      <div class="modal-head">
        <div class="modal-head-copy">
          <span class="eyebrow">FILE PURPOSE</span>
          <h2 id="noteTitle">这个文件是干什么的</h2>
          <p>${escapeHtml(path)}</p>
        </div>
        <button class="modal-close" type="button" data-close aria-label="关闭">${icon("close")}</button>
      </div>
      <div class="modal-body">
        <textarea id="noteInput" class="note-input" rows="6" spellcheck="false" placeholder="例：负责判断群里什么时候开口，顺序是 @ → 引用 → 关键词。">${escapeHtml(note)}</textarea>
        <p class="modal-error" id="noteError" hidden></p>
        <p class="note-hint">说明只存在命令方块自己的配置里，不会改这个文件。</p>
      </div>
      <div class="modal-foot">
        <span class="spacer"></span>
        <button class="small-btn" type="button" data-close>取消</button>
        <button class="primary-btn" type="button" id="noteSave">保存说明</button>
      </div>
    </div>
  `);
  $("#modalLayer [data-close]")?.addEventListener("click", closeModal);
  const save = async () => {
    const text = $("#noteInput").value.trim();
    const button = $("#noteSave");
    button.disabled = true;
    button.textContent = "保存中…";
    try {
      const data = await request("/api/notes", { method: "POST", body: { path, text } });
      state.notes = data.notes || {};
      renderNoteStrip(path);
      renderTree();
      closeModal();
      toast(text ? "用途说明已保存" : "已清除这条说明");
    } catch (error) {
      const box = $("#noteError");
      if (box) {
        box.hidden = false;
        box.textContent = error.message;
      }
      button.disabled = false;
      button.textContent = "保存说明";
    }
  };
  $("#noteSave").addEventListener("click", save);
  $("#noteInput").addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      save();
    }
  });
}

// ---------------------------------------------------------------------------
// Prompter
// ---------------------------------------------------------------------------

// 三大类与六段的中文标签（与 importer.js / 顶栏 tc-groups / tc-segments 完全对应）。
// 导入时纯代码归类，归类不准可以在详情里点一下改。
const PROMPT_CATEGORY_LABELS = {
  todo: "待办",
  idea: "想法",
  done: "已完成",
  ai_done: "AI转正",
  invalid: "失效",
};
const PROMPT_SEGMENTS = ["应用场景", "背景", "前端", "后端", "数据来源", "前端排版"];

function promptCategoryLabel(cat) {
  return PROMPT_CATEGORY_LABELS[cat] || "待办";
}

function promptList() {
  return Array.isArray(state.prompts?.items) ? state.prompts.items : [];
}

function promptById(id) {
  return promptList().find((item) => item.id === id) || null;
}

function visiblePrompts() {
  const q = state.promptQuery.trim().toLowerCase();
  if (!q) return promptList();
  // 逐字原文 63 行：搜索定位需求，优先标题、优先待办和想法。
  // 分三档打分：标题命中 > 原文/标签命中；同档内待办/想法排前，稳定保留原顺序。
  const items = promptList();
  const rank = (item) => {
    const inTitle = (item.title || "").toLowerCase().includes(q);
    const inBody = [item.text, (item.tags || []).join(" ")].join(" ").toLowerCase().includes(q);
    if (!inTitle && !inBody) return -1;
    let score = inTitle ? 100 : 0;                       // 标题优先
    if (item.category === "todo" || item.category === "idea") score += 10; // 待办/想法优先
    return score;
  };
  return items
    .map((item, i) => ({ item, i, s: rank(item) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map((x) => x.item);
}

function blankPrompt() {
  return {
    id: "",
    title: "",
    text: "",
    tags: [],
    notes: "",
    aiOutput: "",
    linkedFiles: [],
    scores: {},
    archived: false,
    updatedAt: 0,
    health: { total: 0, max: 15, level: "weak", levelText: "太薄，AI 只能靠猜", dims: [], advice: [] },
  };
}

function currentDraft() {
  if (state.promptDraft) return state.promptDraft;
  return state.promptId ? promptById(state.promptId) : null;
}

async function loadPrompts({ silent = false } = {}) {
  try {
    const data = await request("/api/prompts");
    state.prompts = data || { items: [], pending: [], capture: {} };
    state.promptsLoaded = true;
    if (state.view === "prompt") renderPrompts();
  } catch (error) {
    if (!silent) toast(error.message, "error");
  }
}

async function openPrompt({ push = true } = {}) {
  state.view = "prompt";
  setActiveView("prompt");
  setHash("#/prompt", { push });
  if (!state.promptsLoaded) await loadPrompts({ silent: true });
  if (!state.promptDraft && !state.promptId && promptList().length) {
    state.promptId = promptList()[0].id;
  }
  renderPrompts();
}

function selectPrompt(id) {
  const item = promptById(id);
  if (!item) return;
  state.promptId = id;
  state.promptDraft = JSON.parse(JSON.stringify(item));
  renderPrompts();
  // 让三视图同步「正在改动的位置」（逐字原文 57 行：就地切换显示）
  window.dispatchEvent(new CustomEvent("ticiqi:prompt-selected", { detail: { id } }));
}

function newPrompt() {
  state.promptId = "";
  state.promptDraft = blankPrompt();
  renderPrompts();
  setTimeout(() => $("#pfText")?.focus(), 60);
}

function renderPrompts() {
  if (state.view !== "prompt") return;
  // 状态统计栏（#promptStats：N条需求/平均体检分/N条待采纳/已开启剪贴板同步）已按主人
  // 2026-11-18 规则删除——非用户点击、使用的纯展示噪音。剪贴板开关状态由活按钮自己表达。
  const captureBtn = $("#promptCaptureBtn");
  if (captureBtn) {
    captureBtn.classList.toggle("is-on", Boolean(state.prompts.capture?.enabled));
    const label = $("#promptCaptureText");
    if (label) label.textContent = state.prompts.capture?.enabled ? "同步中 · 点击关闭" : "剪贴板同步";
  }
  renderPromptPending();
  renderPromptList();
  renderPromptDetail();
  // 通知星图 / 文件夹主视图：需求库变了就重绘（views.js 独立脚本，不 import）
  try { window.dispatchEvent(new Event("ticiqi:prompts-changed")); } catch (_) { /* 老环境 */ }
  installPrompterBridge();
}

// 给 views.js（星图 / 文件夹主视图）用的只读桥：不暴露 app.js 内部，只给需要的几个能力。
function installPrompterBridge() {
  window.cbPrompter = {
    items: () => promptList(),
    get: (id) => promptById(id),
    select: (id) => selectPrompt(id),
    open: () => openPrompt({ push: false }),
    toast: (msg) => toast(msg, "ok"),
    saveStar: async (id, x, y) => {
      const it = promptById(id);
      if (!it) return;
      try {
        await request("/api/prompts", {
          method: "POST",
          body: {
            id: it.id, title: it.title || "", text: it.text || "",
            aiOutput: it.aiOutput || "", notes: it.notes || "",
            linkedFiles: it.linkedFiles || [], archived: Boolean(it.archived),
            category: it.category, segment: it.segment, star: { x, y },
          },
        });
        it.star = { x, y };
        toast("星图位置已保存", "ok");
      } catch (e) { toast("星图位置保存失败", "error"); }
    },
    // 父级/同级/子级（逐字原文 61 行）。层级按 分类→六段 推导，与 views.js 一致。
    relatives: (id) => {
      const items = promptList();
      const me = items.find((x) => x.id === id);
      if (!me) return null;
      const sameCat = items.filter((x) => (x.category || "todo") === (me.category || "todo"));
      const idx = sameCat.findIndex((x) => x.id === id);
      const children = sameCat.filter((x) => (x.segment || "") === (me.segment || "") && x.id !== id);
      return {
        parent: sameCat[0] && sameCat[0].id !== id ? sameCat[0] : null,
        prev: idx > 0 ? sameCat[idx - 1] : null,
        next: idx >= 0 && idx < sameCat.length - 1 ? sameCat[idx + 1] : null,
        child: children.length ? children[0] : null,
      };
    },
    // 打开关联文件/文件夹（57/61 行"都附带可打开的文件和文件夹"）
    // 走项目已有的原生通道 cbNative.reveal（app.js 详情里关联文件用的同一个），不造新接口。
    openFile: async (path) => {
      if (!path) return;
      if (window.cbNative && window.cbNative.reveal) {
        const shown = await window.cbNative.reveal(path);
        if (!shown || !shown.ok) toast("这个文件不在当前文件夹里", "warn");
      } else {
        toast("关联文件：" + path, "ok");
      }
    },
  };
}

function renderPromptPending() {
  const box = $("#promptPending");
  if (!box) return;
  const pending = state.prompts?.pending || [];
  box.hidden = pending.length === 0;
  if (!pending.length) {
    box.innerHTML = "";
    return;
  }
  // 紧凑单行（主人 2026-11-18：待采纳区不许占半个屏）：一条一行，文本单行截断，按钮内联。
  box.innerHTML = `
    <div class="pending-list pending-compact">
      ${pending
        .map(
          (item) => `<article class="pending-item pending-row">
        <span class="pending-text" title="${escapeHtml(String(item.text || "").replace(/"/g, '&quot;').slice(0, 300))}">${escapeHtml(String(item.text || "").replace(/\s+/g, " ").slice(0, 110))}${String(item.text || "").length > 110 ? "…" : ""}</span>
        <span class="pending-meta">${Number(item.length) || 0}字</span>
        <button class="small-btn" type="button" data-dismiss="${escapeHtml(item.id)}">忽略</button>
        <button class="small-btn is-strong" type="button" data-accept="${escapeHtml(item.id)}">存为需求</button>
      </article>`
        )
        .join("")}
    </div>`;
}

function renderPromptList() {
  const box = $("#promptList");
  if (!box) return;
  const items = visiblePrompts();
  if (!items.length) {
    box.innerHTML = `<div class="prompt-empty">${icon("spark")}<p>${promptList().length ? "没有匹配的需求" : "还没有存过需求"}</p><span>${promptList().length ? "换个关键词试试" : "点右上角「新建需求」，或打开剪贴板同步"}</span></div>`;
    return;
  }
  box.innerHTML = items
    .map((item) => {
      const level = item.health?.level || "weak";
      const isActive = item.id === state.promptId ? " is-active" : "";
      const summary = String(item.text || "").replace(/\s+/g, " ").slice(0, 76);
      const cat = item.category || "todo";
      const seg = item.segment || "";
      return `<button class="prompt-card${isActive}" type="button" data-prompt="${escapeHtml(item.id)}">
        <span class="prompt-card-top">
          <span class="prompt-score is-${level}">${item.health?.total ?? 0}</span>
          <span class="prompt-card-title">${escapeHtml(item.title || "未命名需求")}</span>
        </span>
        <span class="prompt-card-tags">
          <span class="pcat cat-${escapeHtml(cat)}">${promptCategoryLabel(cat)}</span>
          ${seg ? `<span class="pseg">${escapeHtml(seg)}</span>` : ""}
        </span>
        <span class="prompt-card-line">${escapeHtml(summary)}</span>
        <span class="prompt-card-meta">${formatDate(item.updatedAt)}${item.archived ? " · 已归档" : ""}</span>
      </button>`;
    })
    .join("");
}

function renderHealth(health) {
  const box = $("#pfHealth");
  if (!box) return;
  const h = health || {};
  const dims = Array.isArray(h.dims) ? h.dims : [];
  box.innerHTML = `
    <div class="health-head">
      <span class="health-score is-${h.level || "weak"}"><strong>${h.total ?? 0}</strong><small>/${h.max || 15}</small></span>
      <div class="health-copy">
        <strong>规则体检 · ${escapeHtml(h.levelText || "")}</strong>
        <span>本地数关键词和结构，不联网、不调用模型。它只说明写没写全，不代表 AI 会做对。</span>
      </div>
    </div>
    <div class="health-dims">
      ${dims
        .map(
          (dim) => `<div class="health-dim">
        <span class="dim-label">${escapeHtml(dim.label)}</span>
        <span class="dim-bar"><i style="width:${Math.round(((Number(dim.value) || 0) / (Number(dim.max) || 3)) * 100)}%"></i></span>
        <span class="dim-value">${Number(dim.value) || 0}/${Number(dim.max) || 3}</span>
      </div>`
        )
        .join("")}
    </div>
    ${(h.advice || []).length ? `<ul class="health-advice">${h.advice.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>` : ""}
  `;
}

function renderLinked(files) {
  const box = $("#pfLinked");
  if (!box) return;
  box.innerHTML = files.length
    ? files
        .map(
          (path) => `<span class="linked-chip">
        <button type="button" class="linked-open" data-open="${escapeHtml(path)}">${icon("file")}${escapeHtml(path)}</button>
        <button type="button" class="linked-remove" data-remove="${escapeHtml(path)}" aria-label="移除关联">${icon("close")}</button>
      </span>`
        )
        .join("")
    : `<span class="linked-empty">还没有关联文件。关联后点一下就能跳到那个文件的只读页。</span>`;
}

function fillFileDatalist() {
  const list = $("#promptFileList");
  if (!list) return;
  list.innerHTML = state.files
    .slice(0, 800)
    .map((file) => `<option value="${escapeHtml(file.path)}"></option>`)
    .join("");
}

function renderPromptDetail() {
  const box = $("#promptDetail");
  if (!box) return;
  const draft = currentDraft();
  if (!draft) {
    box.innerHTML = `<div class="prompt-placeholder">${icon("spark")}
      <h2>选一条需求，或新建一条</h2>
      <p>提词器不生成需求，只负责存、体检、和文件对上号。</p>
      <button class="primary-btn" type="button" id="promptBlankBtn">${icon("plus")}新建需求</button>
    </div>`;
    $("#promptBlankBtn")?.addEventListener("click", newPrompt);
    return;
  }
  box.innerHTML = `
    <div class="prompt-form">
      <div class="prompt-form-head">
        <input id="pfTitle" class="prompt-title-input" type="text" value="${escapeHtml(draft.title || "")}" placeholder="给这条需求起个名字" spellcheck="false">
        <div class="prompt-form-actions">
          <button class="subtle-btn" id="pfCopy" type="button">${icon("copy")}<span>复制原文</span></button>
          <button class="primary-btn" id="pfSave" type="button">保存</button>
        </div>
      </div>
      <label class="prompt-field">
        <span class="field-label">需求原文 <em>贴整段，不要摘要</em></span>
        <textarea id="pfText" class="prompt-text" rows="14" spellcheck="false" placeholder="把准备发给 AI 的整段话贴进来">${escapeHtml(draft.text || "")}</textarea>
      </label>
      <div class="prompt-health" id="pfHealth"></div>
      <div class="prompt-class">
        <span class="field-label">自动归类 <em>导入时按规则分，可在这里改</em></span>
        <div class="class-row">
          <select id="pfCategory" class="class-select" aria-label="三大类">
            ${["todo", "idea", "done", "ai_done", "invalid"].map((c) => `<option value="${c}"${draft.category === c ? " selected" : ""}>${promptCategoryLabel(c)}</option>`).join("")}
          </select>
          <select id="pfSegment" class="class-select" aria-label="六段">
            <option value="">未归段</option>
            ${PROMPT_SEGMENTS.map((s) => `<option value="${escapeHtml(s)}"${draft.segment === s ? " selected" : ""}>${escapeHtml(s)}</option>`).join("")}
          </select>
          <span class="class-coord" id="pfCoord"></span>
        </div>
        <div class="class-preview" id="pfStarPreview" aria-hidden="true"></div>
      </div>
      <div class="prompt-grid">
        <label class="prompt-field">
          <span class="field-label">AI 回复 / 摘要片段</span>
          <textarea id="pfAi" class="prompt-small" rows="6" spellcheck="false" placeholder="把模型回答或推理片段贴在这里，回头比较这条需求好不好用">${escapeHtml(draft.aiOutput || "")}</textarea>
        </label>
        <label class="prompt-field">
          <span class="field-label">我的备注</span>
          <textarea id="pfNotes" class="prompt-small" rows="6" spellcheck="false" placeholder="这次哪里没说清，下次怎么改">${escapeHtml(draft.notes || "")}</textarea>
        </label>
      </div>
      <div class="prompt-field">
        <span class="field-label">关联文件 <em>点文件名跳到只读页</em></span>
        <div class="linked-files" id="pfLinked"></div>
        <div class="linked-add">
          <input id="pfLinkInput" list="promptFileList" type="text" placeholder="输入文件路径，例：xuhbot/bot.js" spellcheck="false">
          <datalist id="promptFileList"></datalist>
          <button class="small-btn" id="pfLinkAdd" type="button">关联</button>
        </div>
      </div>
      <div class="prompt-form-foot">
        <span class="prompt-meta">${draft.updatedAt ? `上次保存 ${formatDate(draft.updatedAt)}` : "还没有保存过"}</span>
        <span class="spacer"></span>
        <button class="subtle-btn" id="pfArchive" type="button">${draft.archived ? "取消归档" : "归档"}</button>
        <button class="danger-btn" id="pfDelete" type="button">删除</button>
      </div>
    </div>`;
  renderHealth(draft.health);
  renderLinked(draft.linkedFiles || []);
  fillFileDatalist();

  const catSel = $("#pfCategory");
  const segSel = $("#pfSegment");
  catSel?.addEventListener("change", () => updateClass());
  segSel?.addEventListener("change", () => updateClass());
  renderClassInfo(draft);
}

// 在详情里把「星图坐标」画成一个小预览点：归一化坐标 (x,y)∈[-1,1] 映射到 100% 方框。
// 星图画布还没做，这里先用文字面板给出坐标读数 + 预览，证明已自动分配到位。
function renderClassInfo(draft) {
  const coord = $("#pfCoord");
  const preview = $("#pfStarPreview");
  if (!coord || !preview) return;
  const cat = draft.category || "todo";
  const seg = draft.segment || "";
  const star = draft.star && typeof draft.star.x === "number" ? draft.star : null;
  coord.innerHTML = `<span class="cat-chip cat-${escapeHtml(cat)}">${promptCategoryLabel(cat)}</span>${
    seg ? ` · <span class="seg-chip">${escapeHtml(seg)}</span>` : ""
  } · 星图 (${star ? star.x + ", " + star.y : "未分配"})`;
  preview.innerHTML = star
    ? `<span class="class-dot" style="left:${(star.x + 1) / 2 * 100}%;top:${(star.y + 1) / 2 * 100}%"></span>`
    : "";
}

// 在文字面板里改大类 / 段落：改动记到当前 draft，已存过的就直接落库（后端按
// category/segment 重算星图坐标），未存过的先挂着、保存时一并带上。
async function updateClass() {
  const draft = state.promptDraft;
  if (!draft) return;
  draft.category = $("#pfCategory")?.value || "todo";
  draft.segment = $("#pfSegment")?.value || "";
  renderClassInfo(draft);
  if (!draft.id) return; // 新建未保存：等保存时再带上去
  try {
    const saved = await request("/api/prompts", {
      method: "POST",
      body: {
        id: draft.id,
        title: draft.title || "",
        text: draft.text || "",
        aiOutput: draft.aiOutput || "",
        notes: draft.notes || "",
        linkedFiles: draft.linkedFiles || [],
        archived: Boolean(draft.archived),
        category: draft.category,
        segment: draft.segment,
      },
    });
    draft.star = saved.star || draft.star;
    renderClassInfo(draft);
    renderPromptList();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function savePromptDraft() {
  const draft = state.promptDraft;
  if (!draft) return;
  const text = $("#pfText")?.value || "";
  if (!text.trim()) {
    toast("需求原文不能为空", "warn");
    return;
  }
  const button = $("#pfSave");
  if (button) {
    button.disabled = true;
    button.textContent = "保存中…";
  }
  try {
    const saved = await request("/api/prompts", {
      method: "POST",
      body: {
        id: draft.id || "",
        title: $("#pfTitle")?.value.trim() || "",
        text,
        aiOutput: $("#pfAi")?.value || "",
        notes: $("#pfNotes")?.value || "",
        linkedFiles: draft.linkedFiles || [],
        archived: Boolean(draft.archived),
      },
    });
    state.promptId = saved.id;
    state.promptDraft = null;
    await loadPrompts({ silent: true });
    renderPrompts();
    toast("需求已保存");
  } catch (error) {
    toast(error.message, "error");
    if (button) {
      button.disabled = false;
      button.textContent = "保存";
    }
  }
}

async function toggleCapture() {  const enabled = !state.prompts?.capture?.enabled;
  try {
    const data = await request("/api/prompts/capture", { method: "POST", body: { enabled } });
    state.prompts.capture = data.capture || state.prompts.capture;
    renderPrompts();
    toast(
      enabled
        ? "已开始看剪贴板：复制一段需求，这里就会多一条待采纳"
        : "已停止同步剪贴板",
      enabled ? "ok" : "info",
      3600
    );
  } catch (error) {
    toast(error.message, "error");
  }
}

async function doImportFile(file) {
  const button = $("#promptImportBtn");
  const label = button?.querySelector("span");
  const prevText = label ? label.textContent : "导入需求";
  if (button) button.disabled = true;
  if (label) label.textContent = "导入中…";
  try {
    const text = await file.text();
    if (!text.trim()) {
      toast("文件是空的", "warn");
      return;
    }
    const result = await request("/api/import", { method: "POST", body: { text } });
    await loadPrompts({ silent: true });
    renderPrompts();
    if (result.created > 0) {
      toast(`已导入 ${result.created} 条需求，自动归段并分配星图坐标`, "ok", 4000);
    } else {
      toast(result.message || "没有新增需求（可能都已存在）", "info", 4000);
    }
  } catch (error) {
    toast(error.message || "导入失败", "error");
  } finally {
    if (button) button.disabled = false;
    if (label) label.textContent = prevText;
  }
}

function bindPromptEvents() {
  $("#tabPrompt")?.addEventListener("click", () => openPrompt({ push: true }));
  $("#promptNewBtn").addEventListener("click", newPrompt);
  $("#promptCaptureBtn").addEventListener("click", toggleCapture);

  // 导入入口：点按钮弹系统文件框，选 txt / md 后读文本交给后端自动归类 + 分配星图坐标。
  $("#promptImportBtn")?.addEventListener("click", () => $("#promptImportFile")?.click());
  $("#promptImportFile")?.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ""; // 允许重复选同一文件
    if (!file) return;
    await doImportFile(file);
  });
  $("#promptSearch").addEventListener("input", (event) => {
    state.promptQuery = event.target.value;
    renderPromptList();
  });
  $("#promptList").addEventListener("click", (event) => {
    const card = event.target.closest("[data-prompt]");
    if (card) selectPrompt(card.dataset.prompt);
  });
  $("#promptPending").addEventListener("click", async (event) => {
    const accept = event.target.closest("[data-accept]");
    const dismiss = event.target.closest("[data-dismiss]");
    try {
      if (accept) {
        const item = await request("/api/prompts/accept", { method: "POST", body: { id: accept.dataset.accept } });
        state.promptId = item.id;
        state.promptDraft = null;
        await loadPrompts({ silent: true });
        toast(item.splitted ? `已自动拆成 ${item.created} 条需求存进库` : "已存进需求库");
      } else if (dismiss) {
        await request("/api/prompts/dismiss", { method: "POST", body: { id: dismiss.dataset.dismiss } });
        await loadPrompts({ silent: true });
      }
    } catch (error) {
      toast(error.message, "error");
    }
  });

  const detail = $("#promptDetail");
  detail.addEventListener("click", async (event) => {
    if (event.target.closest("#pfSave")) {
      await savePromptDraft();
      return;
    }
    if (event.target.closest("#pfCopy")) {
      const text = $("#pfText")?.value || "";
      if (text.trim()) {
        await copyText(text);
        toast("需求原文已复制");
      }
      return;
    }
    if (event.target.closest("#pfArchive")) {
      if (!state.promptDraft) return;
      state.promptDraft.archived = !state.promptDraft.archived;
      await savePromptDraft();
      return;
    }
    if (event.target.closest("#pfDelete")) {
      const draft = state.promptDraft;
      if (!draft) return;
      if (!draft.id) {
        state.promptDraft = null;
        renderPrompts();
        return;
      }
      const ok = await askConfirm("删除这条需求？", "<p>只删命令方块里的存档，不动项目文件。</p>", "删除");
      if (!ok) return;
      try {
        await request("/api/prompts/delete", { method: "POST", body: { id: draft.id } });
        state.promptDraft = null;
        state.promptId = "";
        await loadPrompts({ silent: true });
        toast("已删除");
      } catch (error) {
        toast(error.message, "error");
      }
      return;
    }
    if (event.target.closest("#pfLinkAdd")) {
      const input = $("#pfLinkInput");
      const path = (input?.value || "").trim().replace(/^\.?\//, "");
      if (!path || !state.promptDraft) return;
      if (!state.filesByPath.has(path)) {
        toast("这个路径不在当前镜像里", "warn");
        return;
      }
      if (!state.promptDraft.linkedFiles.includes(path)) {
        state.promptDraft.linkedFiles.push(path);
      }
      input.value = "";
      renderLinked(state.promptDraft.linkedFiles);
      return;
    }
    const remove = event.target.closest("[data-remove]");
    if (remove) {
      state.promptDraft.linkedFiles = state.promptDraft.linkedFiles.filter((p) => p !== remove.dataset.remove);
      renderLinked(state.promptDraft.linkedFiles);
      return;
    }
    const open = event.target.closest("[data-open]");
    if (open) {
      // 独立客户端没有文件视图，改为在系统文件管理器里定位到它。
      if (PROMPTER_ONLY) {
        const shown = await window.cbNative?.reveal?.(open.dataset.open);
        if (!shown?.ok) toast("这个文件不在当前文件夹里", "warn");
      } else {
        await openFile(open.dataset.open, 0, { push: true });
      }
    }
  });

  detail.addEventListener("input", (event) => {
    const draft = state.promptDraft;
    if (!draft) return;
    if (event.target.id === "pfTitle") draft.title = event.target.value;
    if (event.target.id === "pfAi") draft.aiOutput = event.target.value;
    if (event.target.id === "pfNotes") draft.notes = event.target.value;
    if (event.target.id === "pfText") {
      draft.text = event.target.value;
      clearTimeout(state.promptCheckTimer);
      state.promptCheckTimer = setTimeout(async () => {
        const text = draft.text;
        if (!text.trim()) {
          renderHealth(null);
          return;
        }
        try {
          const data = await request("/api/prompts/check", { method: "POST", body: { text } });
          if (state.promptDraft === draft) {
            draft.health = data.health;
            renderHealth(data.health);
          }
        } catch {
          /* 体检失败不打断输入 */
        }
      }, 550);
    }
  });
}

// 提词器独立客户端的启动：只绑需求库事件、只拉需求库数据。
// 不加载文件树、不连文件监控、不跑 API 监测——它不是命令方块的第二个网页窗口。
async function initPrompterOnly() {
  bindPromptEvents();
  try {
    // 关联文件的候选清单来自文件树；只取数据，不渲染树、不连文件监控。
    const [tree] = await Promise.all([
      request("/api/tree").catch(() => null),
      openPrompt({ push: false }),
    ]);
    if (tree) {
      state.files = tree.files || [];
      state.filesByPath = new Map(state.files.map((file) => [file.path, file]));
      fillFileDatalist();
    }
  } catch (error) {
    toast(error.message, "error", 6000);
  }
}

async function init() {
  if (PROMPTER_ONLY) return initPrompterOnly();
  loadCollapsed();
  applyTheme(state.theme);
  bindGlobalEvents();
  bindTreeEvents();
  bindFavoriteEvents();
  bindPieEvents();
  bindPieResize();
  bindColumnResize();
  // effects.js 打完青点后回调这里，扇形图上那些「有改动」的标记才会跟着变。
  window.cbPieRefresh = renderPie;
  try {
    const [statePayload, release] = await Promise.all([
      request("/api/state"),
      request("/api/release").catch(() => null),
    ]);
    applyState(statePayload);
    state.release = release;
    updateVersion();
    renderAll();
    if (state.root) {
      await loadTree({ initial: true });
      if (state.tree) setSync("ok", `已同步 ${formatClock()}`);
      if (location.hash && location.hash !== "#/") await applyRoute();
      else {
        history.replaceState(null, "", "#/");
        showWelcome({ push: false });
      }
      connectEvents();
      startApiMonitor();
      if (state.api?.autoCheck && state.api?.hasKey) {
        setTimeout(() => testApi({ silent: true }), 1600);
      }
    } else {
      setActiveView("welcome");
      showWelcome({ push: false });
      setSync("warn", "未打开文件夹");
    }
  } catch (error) {
    $("#treeLoading").hidden = true;
    setSync("warn", "无法连接本地服务");
    setActiveView("welcome");
    toast(error.message, "error", 6000);
  }
}

init();
