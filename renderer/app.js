/* Renderer logic — talks to the main process only through window.r2sd (preload bridge). */

const $ = (id) => document.getElementById(id);

// Crisp inline-SVG icons (the unicode ⬇ rendered thin and line-like)
const ICON = {
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11"/><path d="M7 10l5 5 5-5"/><path d="M4 20h16"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>',
  cancel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
};

const state = {
  config: null,        // PublicConfig incl. platform setups
  platforms: [],
  roms: [],
  romById: new Map(),   // romId -> rom (kept in sync with state.roms via setRoms)
  cardEls: new Map(),   // romId -> rendered .game-card element (rebuilt by renderGrid)
  currentPlatformId: null,
  search: '',
  sort: 'name',
  sortDir: 'asc', // 'asc' | 'desc'
  genre: '',
  pinned: [],
  theme: 'oled-limited',
  view: 'grid',
  installedOnly: false, // toolbar filter: only games present on disk
  downloads: new Map(), // romId -> DownloadRecord
  progress: new Map(),  // romId -> latest download:event payload (active download)
  queue: [],            // [{ romId, romName, status: 'active'|'queued' }]
  detailRom: null,
};

function queueStatusFor(romId) {
  const e = state.queue.find((q) => q.romId === romId);
  return e ? e.status : null;
}

/** Replace the rom list (and its id index) in one place. */
function setRoms(roms) {
  state.roms = roms;
  state.romById = new Map(roms.map((r) => [r.id, r]));
}
function addRoms(roms) {
  state.roms.push(...roms);
  for (const r of roms) state.romById.set(r.id, r);
}

// Color themes — applied by setting CSS variables on :root (ported from the
// Python app's palette). Programmatic style is allowed under our CSP.
const THEMES = [
  { id: 'oled-limited', name: 'OLED Limited', desc: 'Steam Deck orange', dot: '#ff6b00', vars: { '--bg': '#0d0d0d', '--bg-panel': '#161616', '--bg-card': '#1e1e1e', '--bg-hover': '#262626', '--accent': '#ff6b00', '--accent-dim': 'rgba(255,107,0,0.15)', '--text': '#f0f0f0', '--text-muted': '#8a8a8a', '--border': '#2a2a2a' } },
  { id: 'oled-black', name: 'OLED Black', desc: 'Pure black', dot: '#000000', vars: { '--bg': '#000000', '--bg-panel': '#0a0a0a', '--bg-card': '#121212', '--bg-hover': '#1c1c1c', '--accent': '#ff6b00', '--accent-dim': 'rgba(255,107,0,0.15)', '--text': '#f0f0f0', '--text-muted': '#7a7a7a', '--border': '#1e1e1e' } },
  { id: 'classic-white', name: 'Classic White', desc: 'Clean light', dot: '#ffffff', vars: { '--bg': '#f4f4f5', '--bg-panel': '#ffffff', '--bg-card': '#ffffff', '--bg-hover': '#eaeaea', '--accent': '#2563eb', '--accent-dim': 'rgba(37,99,235,0.12)', '--text': '#1a1a1a', '--text-muted': '#6b7280', '--border': '#d4d4d8' } },
  { id: 'monochrome', name: 'Monochrome', desc: 'Black & white', dot: '#888888', vars: { '--bg': '#0d0d0d', '--bg-panel': '#161616', '--bg-card': '#1e1e1e', '--bg-hover': '#2a2a2a', '--accent': '#cfcfcf', '--accent-dim': 'rgba(207,207,207,0.15)', '--text': '#f0f0f0', '--text-muted': '#8a8a8a', '--border': '#333333' } },
  { id: 'steam-blue', name: 'Steam Blue', desc: 'Classic Steam', dot: '#66c0f4', vars: { '--bg': '#1b2838', '--bg-panel': '#171a21', '--bg-card': '#2a3f5a', '--bg-hover': '#34495e', '--accent': '#66c0f4', '--accent-dim': 'rgba(102,192,244,0.15)', '--text': '#e6eef5', '--text-muted': '#8fa3b8', '--border': '#33475b' } },
  { id: 'purple-haze', name: 'Purple Haze', desc: 'Deep purple', dot: '#a855f7', vars: { '--bg': '#12091c', '--bg-panel': '#1a0f28', '--bg-card': '#241535', '--bg-hover': '#2f1c45', '--accent': '#a855f7', '--accent-dim': 'rgba(168,85,247,0.18)', '--text': '#f0e9f7', '--text-muted': '#9a86ad', '--border': '#3a2450' } },
  { id: 'matrix-green', name: 'Matrix Green', desc: 'Retro hacker', dot: '#00ff41', vars: { '--bg': '#000000', '--bg-panel': '#050805', '--bg-card': '#0a120a', '--bg-hover': '#0f1c0f', '--accent': '#00ff41', '--accent-dim': 'rgba(0,255,65,0.15)', '--text': '#c8ffc8', '--text-muted': '#5a8a5a', '--border': '#123512' } },
  { id: 'crimson-red', name: 'Crimson Red', desc: 'Bold red', dot: '#ef4444', vars: { '--bg': '#1a0d0d', '--bg-panel': '#211010', '--bg-card': '#2e1717', '--bg-hover': '#3a1e1e', '--accent': '#ef4444', '--accent-dim': 'rgba(239,68,68,0.18)', '--text': '#f7e9e9', '--text-muted': '#ad8686', '--border': '#4a2424' } },
  { id: 'ocean-teal', name: 'Ocean Teal', desc: 'Cool waters', dot: '#2dd4bf', vars: { '--bg': '#07201e', '--bg-panel': '#0a2a27', '--bg-card': '#0f3833', '--bg-hover': '#154842', '--accent': '#2dd4bf', '--accent-dim': 'rgba(45,212,191,0.15)', '--text': '#e0f5f2', '--text-muted': '#7ba8a2', '--border': '#1c4a44' } },
  { id: 'sunset-gold', name: 'Sunset Gold', desc: 'Warm gold', dot: '#fbbf24', vars: { '--bg': '#1c1408', '--bg-panel': '#241a0b', '--bg-card': '#322510', '--bg-hover': '#3f2f15', '--accent': '#fbbf24', '--accent-dim': 'rgba(251,191,36,0.16)', '--text': '#f7f0e0', '--text-muted': '#ad9d7b', '--border': '#4a3820' } },
];

function applyTheme(id) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  for (const [k, v] of Object.entries(t.vars)) document.documentElement.style.setProperty(k, v);
  state.theme = t.id;
}

function renderThemeGrid() {
  const grid = $('theme-grid');
  grid.innerHTML = '';
  for (const t of THEMES) {
    const el = document.createElement('div');
    el.className = 'theme-swatch' + (t.id === state.theme ? ' active' : '');
    const dot = document.createElement('span');
    dot.className = 'theme-dot';
    dot.style.background = t.dot;
    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'theme-name';
    name.textContent = t.name;
    const desc = document.createElement('div');
    desc.className = 'theme-desc';
    desc.textContent = t.desc;
    info.append(name, desc);
    el.append(dot, info);
    el.addEventListener('click', async () => {
      applyTheme(t.id);
      renderThemeGrid();
      await window.r2sd.setConfig({ theme: t.id });
    });
    grid.appendChild(el);
  }
}

function applyView() {
  const grid = $('game-grid');
  grid.classList.toggle('list-view', state.view === 'list');
  const btn = $('btn-view');
  btn.innerHTML = state.view === 'list' ? '&#9638;' : '&#9776;'; // ▦ (to grid) / ☰ (to list)
  btn.title = state.view === 'list' ? 'Switch to grid view' : 'Switch to list view';
  // Same size, different layout: the resize observer won't notice
  if (vg.bottom) { vgMeasure(); vgUpdate(true); }
}

// ── Helpers ─────────────────────────────────────────────

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatAge(fetchedAt) {
  const mins = Math.round((Date.now() - fetchedAt) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

let lastFetchedAt = 0;
function setCacheStatus(fromCache, fetchedAt) {
  lastFetchedAt = fetchedAt;
  $('cache-status').textContent = fromCache
    ? `Cached ${formatAge(fetchedAt)} — refreshing…`
    : `Up to date`;
}
function setCacheRefreshFailed(error) {
  const el = $('cache-status');
  // Compact the common cases; the full message is in the tooltip.
  const short = /401|403/.test(error) ? 'check your login in Settings'
    : /fetch failed|ENOTFOUND|ECONNREFUSED|timed? ?out/i.test(error) ? 'server unreachable'
    : 'refresh failed';
  el.textContent = `Cached ${formatAge(lastFetchedAt)} — ${short}`;
  el.title = error;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/** A toast that stays until dismissed, with action buttons: [{ label, fn }]. */
function stickyToast(message, actions, kind = '') {
  const el = document.createElement('div');
  el.className = `toast sticky ${kind}`;
  const text = document.createElement('span'); text.textContent = message; el.appendChild(text);
  const row = document.createElement('div'); row.className = 'toast-actions';
  for (const a of actions) {
    const b = document.createElement('button'); b.className = 'secondary'; b.textContent = a.label;
    b.addEventListener('click', () => { el.remove(); a.fn?.(); });
    row.appendChild(b);
  }
  el.appendChild(row);
  $('toasts').appendChild(el);
  return el;
}

function romYear(rom) {
  const ts = rom.metadatum?.first_release_date;
  return ts ? new Date(ts).getFullYear() : null;
}

function romGenres(rom) {
  return rom.metadatum?.genres || [];
}

function romRating(rom) {
  return rom.metadatum?.average_rating ?? null;
}

function platformSetup(platformId) {
  return state.config?.platforms?.[String(platformId)]
    ?? { folder: '', autoExtract: false, installPaths: [] };
}

async function setAssetSrc(img, romId, serverPath) {
  if (!serverPath) return;
  const url = await window.r2sd.getAsset(romId, serverPath); // r2sd-asset://covers/<file>
  if (url) img.src = url;
}

async function reloadConfig() {
  state.config = await window.r2sd.getConfig();
  state.pinned = state.config.pinnedPlatforms || [];
  state.theme = state.config.theme || 'oled-limited';
  state.view = state.config.view === 'list' ? 'list' : 'grid';
  state.installedOnly = state.config.installedOnly === true;
  applyTheme(state.theme);
  applyView();
  applyInstalledFilterButton();
}

/** Installed-game count per platform (from the download records). */
function installedCounts() {
  const counts = new Map();
  for (const r of state.downloads.values()) counts.set(r.platformId, (counts.get(r.platformId) || 0) + 1);
  return counts;
}

function applyInstalledFilterButton() {
  const btn = $('btn-installed');
  btn.classList.toggle('active', state.installedOnly);
  btn.title = state.installedOnly ? 'Showing installed games only (click to show all)' : 'Show installed games only';
}

/** The filter and the "Installed" sort both depend on the download records,
 *  so a change in what's on disk must re-run the grid, not just patch badges. */
function installedStateAffectsLayout() {
  return state.installedOnly || state.sort === 'installed';
}

async function reloadDownloads() {
  const records = await window.r2sd.listDownloads();
  state.downloads = new Map(records.map((r) => [r.romId, r]));
}

// ── Platforms (with pinning) ────────────────────────────

function sortedPlatforms() {
  const withGames = state.platforms.filter((p) => (p.rom_count || 0) > 0);
  const pinned = withGames.filter((p) => state.pinned.includes(p.id));
  const rest = withGames.filter((p) => !state.pinned.includes(p.id));
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [...pinned.sort(byName), ...rest.sort(byName)];
}

function renderPlatforms() {
  const list = $('platform-list');
  list.innerHTML = '';
  const platforms = sortedPlatforms();

  if (!platforms.length) {
    list.innerHTML = '<p class="muted pad">No platforms found.</p>';
    return;
  }

  const installed = state.installedOnly ? installedCounts() : null;
  for (const p of platforms) {
    const isPinned = state.pinned.includes(p.id);
    const btn = document.createElement('button');
    btn.className = 'platform-item' + (p.id === state.currentPlatformId ? ' active' : '');
    const installedHere = installed ? (installed.get(p.id) || 0) : 0;
    if (installed && installedHere === 0) btn.classList.add('no-installed');
    btn.addEventListener('click', () => selectPlatform(p.id));

    const pin = document.createElement('span');
    pin.className = 'pin-btn' + (isPinned ? ' pinned' : '');
    pin.textContent = isPinned ? '★' : '☆';
    pin.title = isPinned ? 'Unpin platform' : 'Pin to top';
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePin(p.id);
    });

    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = p.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = installed ? String(installedHere) : p.rom_count;
    count.title = installed ? `${installedHere} installed of ${p.rom_count}` : '';

    btn.append(pin, name, count);
    list.appendChild(btn);
  }
  // The list is rebuilt from scratch, so a controller ring living on one of the
  // old buttons went with it — put it back on the same position.
  if (gp.active && gp.zone === 'sidebar') gpRefocus();
}

async function togglePin(platformId) {
  state.pinned = state.pinned.includes(platformId)
    ? state.pinned.filter((id) => id !== platformId)
    : [...state.pinned, platformId];
  renderPlatforms();
  await window.r2sd.setConfig({ pinnedPlatforms: state.pinned });
}

async function loadPlatforms(refresh = false) {
  try {
    const result = await window.r2sd.getPlatforms({ refresh });
    state.platforms = result.platforms;
    setCacheStatus(result.fromCache, result.fetchedAt);
    renderPlatforms();

    if (state.currentPlatformId === null) {
      const first = sortedPlatforms()[0];
      if (first) selectPlatform(first.id);
    }
  } catch (err) {
    const list = $('platform-list');
    list.innerHTML = '';
    const msg = document.createElement('p');
    msg.className = 'error pad';
    msg.append('Failed to load platforms.', document.createElement('br'), String(err.message || err));
    list.appendChild(msg);
  }
}

// ── Games ───────────────────────────────────────────────

function visibleRoms() {
  let roms = state.roms;
  if (state.search) {
    const q = state.search.toLowerCase();
    roms = roms.filter((r) => (r.name || r.fs_name || '').toLowerCase().includes(q));
  }
  if (state.genre) {
    roms = roms.filter((r) => romGenres(r).includes(state.genre));
  }
  if (state.installedOnly) {
    roms = roms.filter((r) => state.downloads.has(r.id));
  }
  // Compute each rom's sort key once (Schwartzian transform) rather than
  // inside the comparator — sorting 5,000 roms by year used to construct a
  // Date object per comparison, ~60k times per keystroke.
  const keyFn = {
    name: () => 0,
    added: (r) => (r.created_at ? Date.parse(r.created_at) || 0 : 0),
    size: (r) => r.fs_size_bytes || 0,
    year: (r) => romYear(r) || 0,
    rating: (r) => romRating(r) || 0,
    installed: (r) => (state.downloads.has(r.id) ? 1 : 0),
  }[state.sort] || (() => 0);
  const dir = state.sortDir === 'desc' ? -1 : 1;
  const keyed = roms.map((r) => ({ r, k: keyFn(r), n: r.name || r.fs_name || '' }));
  keyed.sort((a, b) => {
    const c = (a.k - b.k) * dir;
    return c !== 0 ? c : (state.sort === 'name' ? dir : 1) * NAME_COLLATOR.compare(a.n, b.n);
  });
  return keyed.map((x) => x.r);
}
const NAME_COLLATOR = new Intl.Collator();

// ── Custom dropdown ─────────────────────────────────────
// Native <select> popups aren't composited by gamescope (Steam Deck Game Mode),
// so they're flaky. This is an in-page replacement: a trigger button + a menu of
// divs. Same idea as a <select>: .dataset.value holds the value, onChange fires
// on pick. Options are {value, label}.
function initDropdown(id, onChange) {
  const el = $(id);
  el._menu = el.querySelector('.dropdown-menu');
  el._label = el.querySelector('.dropdown-label');
  el._onChange = onChange;
  el.querySelector('.dropdown-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = el.classList.contains('open');
    closeAllDropdowns();
    if (!wasOpen) { el.classList.add('open'); el._menu.hidden = false; }
  });
}
function setDropdownOptions(id, options, value) {
  const el = $(id);
  el._menu.innerHTML = '';
  for (const o of options) {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.dataset.value = o.value;
    item.textContent = o.label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllDropdowns();
      if (getDropdownValue(id) !== String(o.value)) {
        setDropdownValue(id, o.value);
        if (el._onChange) el._onChange(o.value);
      }
    });
    el._menu.appendChild(item);
  }
  const has = options.some((o) => String(o.value) === String(value));
  setDropdownValue(id, has ? value : (options[0] ? options[0].value : ''));
}
function setDropdownValue(id, value) {
  const el = $(id);
  el.dataset.value = String(value);
  const items = [...el._menu.children];
  const match = items.find((c) => c.dataset.value === String(value));
  if (el._label) el._label.textContent = match ? match.textContent : '';
  items.forEach((c) => c.classList.toggle('selected', c.dataset.value === String(value)));
}
function getDropdownValue(id) { return $(id).dataset.value; }
function closeAllDropdowns() {
  document.querySelectorAll('.dropdown.open').forEach((d) => {
    d.classList.remove('open');
    if (d._menu) d._menu.hidden = true;
  });
}
document.addEventListener('click', closeAllDropdowns);

function updateGenreFilter() {
  const el = $('genre-filter');
  const genres = new Set();
  for (const rom of state.roms) for (const g of romGenres(rom)) genres.add(g);
  const options = [{ value: '', label: 'All genres' }, ...[...genres].sort().map((g) => ({ value: g, label: g }))];
  setDropdownOptions('genre-filter', options, genres.has(state.genre) ? state.genre : '');
  state.genre = getDropdownValue('genre-filter');
  el.style.display = genres.size ? '' : 'none';
}

const coverObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const wrap = entry.target;
      coverObserver.unobserve(wrap);
      setAssetSrc(wrap.querySelector('img'), Number(wrap.dataset.romId), wrap.dataset.coverPath);
    }
  },
  { root: $('game-grid'), rootMargin: '400px' }
);

function coverWrapFor(romId) {
  return cardFor(romId)?.querySelector('.cover-wrap') || null;
}

/** Add/update/remove the progress bar overlay on a game card. */
function updateCardProgress(romId) {
  const wrap = coverWrapFor(romId);
  if (!wrap) return;
  const progress = state.progress.get(romId);
  const qs = queueStatusFor(romId);
  let bar = wrap.querySelector('.dl-bar');
  if (!progress && !qs) {
    bar?.remove();
    updateCardBadge(romId);
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'dl-bar';
    bar.innerHTML = '<div class="dl-bar-fill"></div>';
    wrap.appendChild(bar);
  }
  if (progress) {
    const pct = progress.percent ?? 0;
    bar.classList.toggle('indeterminate', progress.status === 'starting' || (progress.status === 'extracting' && !progress.percent));
    bar.querySelector('.dl-bar-fill').style.width = `${pct}%`;
  } else {
    // Queued but not started — subtle indeterminate bar
    bar.classList.add('indeterminate');
    bar.querySelector('.dl-bar-fill').style.width = '30%';
  }
}

/** Green Play/installed badge. For extractable PC games it's a clickable Play
 *  button (launches the default exe, or opens the exe picker to choose one). */
function makeBadge(rom) {
  if (!state.downloads.has(rom.id)) return null;
  const badge = document.createElement('div');
  badge.className = 'dl-badge';
  badge.innerHTML = ICON.play;
  if (platformSetup(rom.platform_id).autoExtract) {
    badge.classList.add('playable');
    const rec = state.downloads.get(rom.id);
    badge.title = rec && rec.defaultExe ? 'Play' : 'Play (choose executable)';
    badge.addEventListener('click', (e) => { e.stopPropagation(); playGame(rom); });
  } else {
    badge.title = 'Installed';
  }
  return badge;
}

function updateCardBadge(romId) {
  const wrap = coverWrapFor(romId);
  if (!wrap) return;
  wrap.querySelector('.dl-badge')?.remove();
  const rom = state.romById.get(romId);
  if (rom) { const b = makeBadge(rom); if (b) wrap.appendChild(b); }
  // Keep the list-view "Installed" label in sync
  const statusEl = cardFor(romId)?.querySelector('.list-status');
  if (statusEl) statusEl.textContent = state.downloads.has(romId) ? 'Installed' : '';
}

function cardFor(romId) {
  return state.cardEls.get(romId) || null;
}

/** Build (or rebuild) the state-driven quick-action button for one rom. */
function buildCardActions(rom) {
  const actions = document.createElement('div');
  actions.className = 'card-actions';
  const qs = queueStatusFor(rom.id);
  const downloaded = state.downloads.has(rom.id);
  const mkBtn = (icon, title, cls, handler) => {
    const b = document.createElement('button');
    b.className = 'card-action-btn ' + cls;
    b.title = title;
    b.innerHTML = icon;
    b.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
    actions.appendChild(b);
  };
  if (qs) {
    mkBtn(ICON.cancel, qs === 'queued' ? 'Remove from queue' : 'Cancel download', 'danger', () => window.r2sd.cancelDownload(rom.id));
  } else if (downloaded) {
    mkBtn(ICON.trash, 'Delete from disk', 'danger', () => deleteDownloadFor(rom));
  } else {
    mkBtn(ICON.download, 'Download', 'accent', () => quickDownload(rom));
  }
  return actions;
}

function updateCardActions(romId) {
  const card = cardFor(romId);
  if (!card) return;
  const rom = state.romById.get(romId);
  if (!rom) return;
  card.querySelector('.card-actions')?.remove();
  card.appendChild(buildCardActions(rom));
}

/** Queue a download from a tile/menu using the platform's default install path. */
function startDownloadWith(rom, installPath) {
  window.r2sd.startDownload(
    { id: rom.id, name: rom.name || rom.fs_name, fsName: rom.fs_name, platformId: rom.platform_id, size: rom.fs_size_bytes || 0 },
    installPath || ''
  );
  // Optimistic: reflect queued state until the queue:update event lands
  if (!queueStatusFor(rom.id)) {
    state.queue.push({ romId: rom.id, romName: rom.name || rom.fs_name, status: state.queue.length ? 'queued' : 'active' });
  }
  updateCardProgress(rom.id);
  updateCardActions(rom.id);
  renderQueueBar();
}

function quickDownload(rom) {
  const setup = platformSetup(rom.platform_id);
  const paths = (setup.autoExtract && Array.isArray(setup.installPaths)) ? setup.installPaths : [];
  // More than one install path → ask which one (buttons, not a native <select>,
  // which is finicky under gamescope).
  if (paths.length > 1) { openInstallPathPicker(rom, paths); return; }
  startDownloadWith(rom, '');
}

let installPathRom = null;
function openInstallPathPicker(rom, paths) {
  installPathRom = rom;
  $('installpath-game').textContent = rom.name || rom.fs_name;
  const list = $('installpath-list');
  list.innerHTML = '';
  paths.forEach((p) => {
    const btn = document.createElement('button');
    btn.className = 'exe-option installpath-option';
    btn.textContent = p;
    btn.addEventListener('click', () => {
      $('installpath-modal').hidden = true;
      startDownloadWith(rom, p);
    });
    list.appendChild(btn);
  });
  $('installpath-modal').hidden = false;
}
function closeInstallPathPicker() { $('installpath-modal').hidden = true; installPathRom = null; }

// ── Right-click context menu ────────────────────────────

function showContextMenu(e, rom) {
  e.preventDefault();
  const menu = $('ctx-menu');
  menu.innerHTML = '';
  const item = (label, handler, danger) => {
    const d = document.createElement('div');
    d.className = 'ctx-item' + (danger ? ' danger' : '');
    d.textContent = label;
    d.addEventListener('click', () => { hideContextMenu(); handler(); });
    menu.appendChild(d);
  };

  item('Details…', () => openDetail(rom));
  const progress = state.progress.get(rom.id);
  const downloaded = state.downloads.has(rom.id);
  const setup = platformSetup(rom.platform_id);
  if (progress) {
    item('Cancel download', () => window.r2sd.cancelDownload(rom.id), true);
  } else if (downloaded) {
    if (setup.autoExtract) {
      item('▶ Play', () => playGame(rom));
      item('Choose executable…', () => openExePicker(rom));
      item('Add to Steam / Shortcut…', () => openExePicker(rom));
    }
    item('Saves & Folders…', () => openFoldersModal(rom));
    item('Delete from disk', () => deleteDownloadFor(rom), true);
  } else {
    item('Download', () => quickDownload(rom));
  }

  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 6) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 6) + 'px';
}

function hideContextMenu() {
  $('ctx-menu').hidden = true;
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);
window.addEventListener('blur', hideContextMenu);

function buildCard(rom) {
  const card = document.createElement('div');
  card.className = 'game-card';
  card.dataset.romId = rom.id;
  card.title = rom.fs_name || rom.name || '';
  card.addEventListener('click', () => openDetail(rom));
  card.addEventListener('contextmenu', (e) => showContextMenu(e, rom));

  const wrap = document.createElement('div');
  wrap.className = 'cover-wrap';
  wrap.dataset.romId = rom.id;
  wrap.dataset.coverPath = rom.path_cover_large || rom.path_cover_small || '';
  const img = document.createElement('img');
  img.className = 'game-cover';
  img.alt = '';
  wrap.appendChild(img);
  coverObserver.observe(wrap);

  const badge = makeBadge(rom);
  if (badge) wrap.appendChild(badge);

  const meta = document.createElement('div');
  meta.className = 'game-meta';
  const name = document.createElement('div');
  name.className = 'game-name';
  name.textContent = rom.name || rom.fs_name || 'Unknown';
  const size = document.createElement('div');
  size.className = 'game-size';
  const year = romYear(rom);
  size.textContent = [formatSize(rom.fs_size_bytes), year].filter(Boolean).join(' · ');
  // Genres line — only rendered visibly in list view (CSS-gated)
  const genresLine = document.createElement('div');
  genresLine.className = 'game-genres';
  genresLine.textContent = romGenres(rom).slice(0, 4).join(' · ');
  meta.append(name, size, genresLine);

  // Right-hand columns for list view: rating + installed status
  const listCols = document.createElement('div');
  listCols.className = 'list-cols';
  const ratingEl = document.createElement('span');
  ratingEl.className = 'list-rating';
  const rating = romRating(rom);
  if (rating) ratingEl.textContent = `★ ${Math.round(rating)}`;
  const statusEl = document.createElement('span');
  statusEl.className = 'list-status';
  if (state.downloads.has(rom.id)) statusEl.textContent = 'Installed';
  listCols.append(ratingEl, statusEl);

  card.append(wrap, meta, listCols, buildCardActions(rom));
  state.cardEls.set(rom.id, card);
  return card;
}

// ── Windowed grid ───────────────────────────────────────
// Only the rows on screen (plus a buffer) exist as cards; two spacers keep the
// scroll height of the whole list. A 5,000-game platform used to build 5,000
// cards — every card, cover observer and listener — on every platform switch,
// filter change and cold-load page; now it builds a few dozen. Every card is
// the same height (fixed-ratio cover, name clamped to 2 lines, one-line meta),
// so row positions are plain arithmetic.
//
// Cards are cached per render so covers don't reload while scrolling; the
// cache is state.cardEls, which the badge/progress helpers already use, so a
// cached card that is off screen stays up to date.
const VG_BUFFER_ROWS = 4;
const VG_CACHE_MAX = 1500;
const vg = { items: [], cols: 1, pitch: 0, gap: 0, first: -1, last: -1, raf: 0, top: null, bottom: null };

function vgSpacer() {
  const d = document.createElement('div');
  d.className = 'vg-spacer';
  d.hidden = true;
  return d;
}

/** Columns and row pitch as currently laid out (zoom, window size, grid/list view). */
function vgMeasure() {
  const grid = $('game-grid');
  const cs = getComputedStyle(grid);
  vg.cols = grid.classList.contains('list-view') ? 1 : Math.max(1, cs.gridTemplateColumns.split(' ').filter(Boolean).length);
  vg.gap = parseFloat(cs.rowGap) || 0;
  const sample = grid.querySelector('.game-card');
  if (sample) vg.pitch = sample.getBoundingClientRect().height + vg.gap;
}

/** Show items[start..end) between the spacers, reusing cached cards. */
function vgRender(start, end) {
  const grid = $('game-grid');
  for (const card of grid.querySelectorAll(':scope > .game-card')) {
    const wrap = card.querySelector('.cover-wrap');
    if (wrap) coverObserver.unobserve(wrap);
    card.remove();
  }
  const frag = document.createDocumentFragment();
  // The grid remembers its own position (gp.gridIndex): gp.index also counts
  // buttons in whatever window is open, and a window closed with the mouse
  // leaves it pointing at "button #2" — which is not card #2.
  const focusedId = gp.active && gp.zone === 'grid' && !anyModalOpen() ? vg.items[gp.gridIndex]?.id : undefined;
  for (let i = start; i < end; i++) {
    const rom = vg.items[i];
    let card = state.cardEls.get(rom.id);
    const fresh = !card;
    if (fresh) card = buildCard(rom);
    card.classList.toggle('gp-focus', rom.id === focusedId);
    const wrap = card.querySelector('.cover-wrap');
    if (wrap && !wrap.querySelector('img')?.getAttribute('src')) coverObserver.observe(wrap);
    frag.appendChild(card);
    if (fresh && (state.progress.has(rom.id) || queueStatusFor(rom.id))) queueMicrotask(() => updateCardProgress(rom.id));
  }
  grid.insertBefore(frag, vg.bottom);
  // Bound the cache: forget cards far from view (they rebuild on demand)
  if (state.cardEls.size > VG_CACHE_MAX) {
    const keep = new Set(vg.items.slice(start, end).map((r) => r.id));
    for (const id of state.cardEls.keys()) {
      if (state.cardEls.size <= VG_CACHE_MAX / 2) break;
      if (!keep.has(id)) state.cardEls.delete(id);
    }
  }
}

/** Bring the rendered window in line with the scroll position. `atScroll`
 *  is the position to lay out for (and restore) when the grid was just
 *  emptied — at that moment the browser has clamped scrollTop to 0. */
function vgUpdate(force = false, atScroll = null) {
  const grid = $('game-grid');
  if (!vg.bottom || vg.bottom.parentNode !== grid) return; // before the first render
  const n = vg.items.length;
  if (!n) { vgRender(0, 0); vg.top.hidden = vg.bottom.hidden = true; vg.first = vg.last = -1; return; }
  if (!vg.pitch) {
    // First paint: render one screenful to learn the row height, then place properly
    vgRender(0, Math.min(n, vg.cols * 8));
    vgMeasure();
    if (!vg.pitch) return;
    force = true;
  }
  const rows = Math.ceil(n / vg.cols);
  const padTop = parseFloat(getComputedStyle(grid).paddingTop) || 0;
  const y = Math.max(0, (atScroll ?? grid.scrollTop) - padTop);
  const first = Math.max(0, Math.floor(y / vg.pitch) - VG_BUFFER_ROWS);
  const last = Math.min(rows - 1, Math.ceil((y + grid.clientHeight) / vg.pitch) + VG_BUFFER_ROWS);
  if (!force && first === vg.first && last === vg.last) return;
  vg.first = first; vg.last = last;
  // Spacer + the gap after it = exactly the rows it stands in for
  const above = first * vg.pitch - vg.gap;
  const below = (rows - 1 - last) * vg.pitch - vg.gap;
  vg.top.hidden = above <= 0; vg.top.style.height = `${Math.max(0, above)}px`;
  vg.bottom.hidden = below <= 0; vg.bottom.style.height = `${Math.max(0, below)}px`;
  vgRender(first * vg.cols, Math.min(n, (last + 1) * vg.cols));
  if (atScroll !== null) grid.scrollTop = atScroll; // the browser clamps it if the list got shorter
}

/** Scroll just enough for item i's row to be on screen, and render it. */
function vgEnsureVisible(i) {
  const grid = $('game-grid');
  if (!vg.pitch || i < 0) return;
  const padTop = parseFloat(getComputedStyle(grid).paddingTop) || 0;
  const rowTop = padTop + Math.floor(i / vg.cols) * vg.pitch;
  const rowBottom = rowTop + vg.pitch - vg.gap;
  if (rowTop < grid.scrollTop) grid.scrollTop = rowTop - vg.gap;
  else if (rowBottom > grid.scrollTop + grid.clientHeight) grid.scrollTop = rowBottom - grid.clientHeight + vg.gap;
  vgUpdate();
}

function vgSchedule() {
  if (vg.raf) return;
  vg.raf = requestAnimationFrame(() => { vg.raf = 0; vgUpdate(); });
}

function renderGrid() {
  const grid = $('game-grid');
  // Emptying the grid lets the browser clamp scrollTop to 0; a redraw (filter,
  // background refresh, finished download) must not throw you back to the top.
  const keepScroll = grid.scrollTop;
  coverObserver.disconnect();
  grid.innerHTML = '';
  state.cardEls = new Map();
  vg.top = vgSpacer(); vg.bottom = vgSpacer();
  grid.append(vg.top, vg.bottom);

  const roms = visibleRoms();
  $('grid-status').hidden = roms.length > 0;
  $('grid-status').textContent = !state.roms.length
    ? 'No games on this platform.'
    : state.installedOnly && !state.search && !state.genre
      ? 'Nothing installed on this platform yet — turn off the installed filter (✓) to browse.'
      : state.installedOnly ? 'No installed games match your filters.' : 'No games match your filters.';

  vg.items = roms;
  vg.first = vg.last = -1;
  vgMeasure();
  vgUpdate(true, keepScroll);

  // Re-apply the gamepad focus ring after a re-render (grid only — the other
  // zones keep a reference to their element, which survives a grid re-render)
  // (not while a window is open: a background refresh must not pull the ring off it)
  if (gp.active && gp.zone === 'grid' && !anyModalOpen() && gp.gridIndex >= 0) gpSetFocus(Math.min(gp.gridIndex, roms.length - 1));
}

$('game-grid').addEventListener('scroll', vgSchedule, { passive: true });
// Window size, UI zoom, or grid/list view changed: new columns / row height
new ResizeObserver(() => { vgMeasure(); vgUpdate(true); }).observe($('game-grid'));

async function selectPlatform(platformId, refresh = false) {
  state.currentPlatformId = platformId;
  const platform = state.platforms.find((p) => p.id === platformId);
  $('platform-title').textContent = platform ? platform.name : 'Library';
  renderPlatforms();

  setRoms([]);
  $('game-grid').scrollTop = 0; // a new platform starts at the top
  renderGrid();
  $('grid-status').hidden = false;
  $('grid-status').textContent = 'Loading…';

  try {
    const result = await window.r2sd.getRoms(platformId, { refresh });
    if (state.currentPlatformId !== platformId) return;
    setRoms(result.roms);
    // Reconcile download records with what's on disk BEFORE rendering, so the
    // cards are built with the right badges in one pass. (Rendering first and
    // then patching every card was O(n²) on a 5,000-game platform: a DOM query
    // plus an array scan per rom.)
    const changes = await window.r2sd.syncDownloads(platformId);
    await reloadDownloads();
    if (state.currentPlatformId !== platformId) return;
    setCacheStatus(result.fromCache, result.fetchedAt);
    updateGenreFilter();
    renderGrid();
    if (state.installedOnly) renderPlatforms(); // counts may have changed after the sync
    if (changes.added || changes.removed || changes.moved) {
      const parts = [];
      if (changes.added) parts.push(`${changes.added} found`);
      if (changes.moved) parts.push(`${changes.moved} moved (settings kept)`);
      if (changes.removed) parts.push(`${changes.removed} removed`);
      toast(`Library sync: ${parts.join(', ')}`);
    }
  } catch (err) {
    $('grid-status').textContent = `Failed to load games: ${err.message || err}`;
  }
}

// Progressive pages during a cold (uncached) load → render as they arrive
window.r2sd.onRomsProgress(({ platformId, page, loaded, total }) => {
  if (platformId !== state.currentPlatformId) return;
  addRoms(page);
  updateGenreFilter();
  renderGrid(); // cheap now: only the rows on screen are built
  $('grid-status').hidden = false;
  $('grid-status').textContent = loaded < total
    ? `Loading library from server (first time only)… ${loaded} / ${total}`
    : '';
  if (loaded >= total) $('grid-status').hidden = true;
});

window.r2sd.onRefreshFailed(({ platformId, error }) => {
  if (platformId !== undefined && platformId !== state.currentPlatformId) return;
  setCacheRefreshFailed(error || 'refresh failed');
});

window.r2sd.onCloudEvent((e) => {
  if (e.action === 'uploaded') toast(`${e.gameName}: saves uploaded to RomM`, 'success');
  else if (e.action === 'unscoped') toast(`${e.gameName}: not synced — no save locations known. Saves & Folders… → What syncs… to set them.`, 'error');
  else if (e.action === 'error') toast(`${e.gameName}: cloud save upload failed — ${e.error}`, 'error');
  else if (e.action === 'conflict') {
    // Not uploaded: RomM got a newer save from another device while this one was
    // playing too. Stays up until handled — the user picks which one to keep.
    stickyToast(`${e.gameName}: saves NOT uploaded — RomM also has newer saves from another device. Choose which to keep in Saves & Folders.`, [
      { label: 'Saves & Folders…', fn: () => openFoldersModal({ id: e.romId, name: e.gameName }) },
      { label: 'Later' },
    ], 'error');
  }
});

// "Ask after playing": the game exited and its saves changed since the last RomM sync
window.r2sd.onCloudSuggest((e) => {
  const game = { id: e.romId, name: e.gameName };
  if (e.suggest === 'conflict') {
    stickyToast(`${e.gameName}: saves changed here and on RomM (from ${e.remoteFrom || 'another device'}) — choose which to keep.`, [
      { label: 'Saves & Folders…', fn: () => openFoldersModal(game) },
      { label: 'Not now' },
    ], 'error');
    return;
  }
  const what = e.state === 'local-only' ? "aren't on RomM yet" : 'changed since the last RomM sync';
  stickyToast(`${e.gameName}: your saves ${what} (${e.files} file${e.files === 1 ? '' : 's'}, ${formatSize(e.bytes)}). Upload them?`, [
    { label: 'Upload to RomM', fn: async () => {
      const res = await window.r2sd.cloudUpload(e.romId, e.root);
      if (res.error) toast(`${e.gameName}: upload failed — ${res.error}`, 'error');
      else toast(`${e.gameName}: saves uploaded to RomM`, 'success');
      if (state.detailRom?.id === e.romId) refreshDetailCloud();
    } },
    { label: 'Not now' },
    { label: "Don't ask for this game", fn: async () => {
      await window.r2sd.setCloudAsk(e.romId, false);
      toast(`${e.gameName}: won't ask again — upload any time from its dialog`, 'success');
    } },
  ], 'success');
});

window.r2sd.onUpdateAvailable((info) => {
  stickyToast(`RomM2SteamDeck ${info.latest} is available (you have ${info.current})`, [
    { label: 'Open release', fn: () => window.r2sd.openReleasePage(info.url) },
    { label: 'Skip this version', fn: () => window.r2sd.skipUpdate(info.latest) },
    { label: 'Later' },
  ], 'success');
});

window.r2sd.onPlatformsUpdated(({ data, fetchedAt }) => {
  state.platforms = data;
  setCacheStatus(false, fetchedAt);
  renderPlatforms();
});

window.r2sd.onRomsUpdated(({ platformId, data, fetchedAt }) => {
  if (platformId !== state.currentPlatformId) return;
  setRoms(data);
  setCacheStatus(false, fetchedAt);
  updateGenreFilter();
  renderGrid();
});

// ── Downloads ───────────────────────────────────────────

window.r2sd.onDownloadEvent(async (event) => {
  const { romId, status } = event;
  const terminal = ['complete', 'extracted', 'error', 'cancelled'].includes(status);

  if (terminal) {
    state.progress.delete(romId);
    await reloadDownloads();
    const rom = state.romById.get(romId);
    const name = rom?.name || `ROM ${romId}`;
    if (status === 'complete') toast(`${name} downloaded`, 'success');
    if (status === 'extracted') toast(`${name} downloaded and installed`, 'success');
    if (status === 'error') toast(`${name}: ${event.message}`, 'error');
    if (status === 'cancelled') toast(`${name} cancelled`);
  } else {
    state.progress.set(romId, event);
  }

  updateCardProgress(romId);
  updateCardActions(romId);
  renderQueueBar();
  if (state.detailRom?.id === romId) refreshDetailActions();
  if (terminal && installedStateAffectsLayout()) { renderGrid(); renderPlatforms(); }
});

// Queue composition changes (serial queue in the main process)
window.r2sd.onQueueUpdate((payload) => {
  const prevIds = new Set(state.queue.map((q) => q.romId));
  state.queue = payload.items || [];
  const nowIds = new Set(state.queue.map((q) => q.romId));
  // Refresh any tile whose queue membership changed
  for (const id of new Set([...prevIds, ...nowIds])) {
    updateCardActions(id);
    updateCardProgress(id);
  }
  renderQueueBar();
});

function renderQueueBar() {
  const bar = $('dl-statusbar');
  if (!state.queue.length) { bar.hidden = true; return; }
  bar.hidden = false;

  const active = state.queue.find((q) => q.status === 'active') || state.queue[0];
  const queuedCount = state.queue.filter((q) => q.status === 'queued').length;
  const prog = active ? state.progress.get(active.romId) : null;

  $('dl-sb-title').textContent = active ? active.romName : '';
  const mini = $('dl-sb-mini');
  const fill = $('dl-sb-mini-fill');
  const indeterminate = !prog || prog.status === 'starting' || (prog.status === 'extracting' && !prog.percent);
  mini.classList.toggle('indeterminate', indeterminate);
  fill.style.width = (prog?.percent ?? 0) + '%';
  const label = prog?.status === 'extracting' ? 'extracting…' : prog?.status === 'downloading' ? `${prog.percent}%` : 'starting…';
  $('dl-sb-count').textContent = `${label}${queuedCount ? ` · ${queuedCount} queued` : ''}`;

  // Expanded list
  const list = $('dl-sb-list');
  list.innerHTML = '';
  for (const q of state.queue) {
    const row = document.createElement('div');
    row.className = 'dl-sb-item';
    const name = document.createElement('div');
    name.className = 'dl-sb-item-name';
    name.textContent = q.romName;
    row.appendChild(name);
    if (q.status === 'active') {
      const p = state.progress.get(q.romId);
      const b = document.createElement('div');
      b.className = 'dl-sb-item-bar';
      const f = document.createElement('div');
      f.style.width = (p?.percent ?? 0) + '%';
      b.appendChild(f);
      row.appendChild(b);
    } else {
      const s = document.createElement('div');
      s.className = 'dl-sb-item-status';
      s.textContent = 'Queued';
      row.appendChild(s);
    }
    const cancel = document.createElement('button');
    cancel.className = 'card-action-btn danger';
    cancel.textContent = '✕';
    cancel.title = q.status === 'queued' ? 'Remove from queue' : 'Cancel';
    cancel.addEventListener('click', () => window.r2sd.cancelDownload(q.romId));
    row.appendChild(cancel);
    list.appendChild(row);
  }
}

function startDownloadFor(rom) {
  const installSelect = $('detail-install-path');
  const installPath = installSelect.hidden ? '' : installSelect.value;
  window.r2sd.startDownload(
    { id: rom.id, name: rom.name || rom.fs_name, fsName: rom.fs_name, platformId: rom.platform_id, size: rom.fs_size_bytes || 0 },
    installPath
  );
  state.progress.set(rom.id, { romId: rom.id, status: 'starting', percent: 0 });
  updateCardProgress(rom.id);
  refreshDetailActions();
}

async function deleteDownloadFor(rom) {
  const record = state.downloads.get(rom.id);
  const target = record?.filePath || '(tracking record only)';
  if (!confirm(`Delete ${rom.name || rom.fs_name} from disk?\n\n${target}`)) return;
  const result = await window.r2sd.deleteDownload(rom.id);
  if (result.error) {
    toast(result.error, 'error');
  } else if (result.steamRemoved && result.steamRemoved.length) {
    toast(`Deleted ${rom.name || rom.fs_name} (and removed from Steam)`, 'success');
  } else if (result.steamSkipped) {
    toast(`Deleted ${rom.name || rom.fs_name} — its Steam shortcut was left (close Steam to remove it)`, 'success');
  } else {
    toast(`Deleted ${rom.name || rom.fs_name}`, 'success');
  }
  await reloadDownloads();
  updateCardBadge(rom.id);
  updateCardActions(rom.id);
  refreshDetailActions();
  if (installedStateAffectsLayout()) { renderGrid(); renderPlatforms(); }
}

// ── Game detail modal ───────────────────────────────────

function addFact(container, label, value) {
  if (!value) return;
  const l = document.createElement('span');
  l.className = 'fact-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'fact-value';
  v.textContent = value;
  container.append(l, v);
}

function refreshDetailActions() {
  const rom = state.detailRom;
  if (!rom) return;

  const setup = platformSetup(rom.platform_id);
  const progress = state.progress.get(rom.id);
  const record = state.downloads.get(rom.id);

  const dlBtn = $('btn-dl');
  const cancelBtn = $('btn-dl-cancel');
  const deleteBtn = $('btn-dl-delete');
  const shortcutBtn = $('btn-shortcut');
  const playBtn = $('btn-play');
  const statusEl = $('detail-dl-status');
  const bar = $('detail-dl-bar');
  const installSelect = $('detail-install-path');

  // Install path chooser: only for auto-extract platforms with multiple paths
  installSelect.hidden = true;
  if (!record && !progress && setup.autoExtract && setup.installPaths.length > 1) {
    installSelect.innerHTML = '';
    for (const p of setup.installPaths) {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = p;
      installSelect.appendChild(opt);
    }
    installSelect.hidden = false;
  }

  const inQueue = queueStatusFor(rom.id);
  dlBtn.hidden = Boolean(inQueue || record);
  cancelBtn.hidden = !inQueue;
  deleteBtn.hidden = !record || Boolean(inQueue);
  // Shortcut maker + Play: only for installed (extracted) PC games
  shortcutBtn.hidden = !(record && setup.autoExtract && !inQueue);
  playBtn.hidden = !(record && setup.autoExtract && !inQueue);
  $('btn-folders').hidden = !(record && record.filePath && !inQueue);
  playBtn.textContent = record && record.defaultExe ? '▶ Play' : '▶ Play…';
  // What Play actually runs — and a way back to the picker when it's the wrong exe
  const exeRow = $('detail-exe-row');
  const showExe = Boolean(record && record.defaultExe && setup.autoExtract && !inQueue);
  exeRow.hidden = !showExe;
  if (showExe) {
    const full = record.defaultExe;
    const rel = record.filePath && full.startsWith(record.filePath) ? full.slice(record.filePath.length).replace(/^[\\/]+/, '') : full;
    const el = $('detail-exe-path');
    el.textContent = rel;
    el.title = full;
  }
  bar.hidden = !progress;

  if (inQueue === 'queued' && !progress) {
    statusEl.textContent = 'Queued — waiting for the current download';
  } else if (progress) {
    const pct = progress.percent ?? 0;
    bar.classList.toggle('indeterminate', progress.status === 'starting' || (progress.status === 'extracting' && !progress.percent));
    bar.querySelector('.dl-bar-fill').style.width = `${pct}%`;
    if (progress.status === 'downloading') {
      const extra = progress.inlineExtract ? ' · extracting as it downloads' : '';
      statusEl.textContent = `${formatSize(progress.downloaded)} / ${formatSize(progress.total)} (${pct}%)${extra}`;
    } else if (progress.status === 'extracting') {
      statusEl.textContent = `Extracting… ${pct}%`;
    } else {
      statusEl.textContent = 'Starting…';
    }
  } else if (record) {
    statusEl.textContent = record.filePath ? `Installed: ${record.filePath}` : 'Downloaded';
  } else {
    statusEl.textContent = '';
  }
}

/**
 * The "RomM saves" line in a game's dialog: where this game's saves stand
 * against RomM, with the one action that makes sense right now. Shown for
 * installed PC games with a save place of their own (a per-game prefix, or
 * the Windows profile once the game's save locations are known), whatever
 * the cloud-saves mode — it is the manual control.
 */
const CLOUD_LINE = {
  'in-sync': { text: 'In sync', cls: 'ok' },
  'local-newer': { text: 'Changed here since the last sync', cls: 'warn', action: 'upload' },
  'local-only': { text: 'Not on RomM yet', cls: 'warn', action: 'upload' },
  'remote-newer': { text: 'RomM has newer saves', cls: 'warn', action: 'download' },
  'remote-only': { text: 'On RomM, none here yet', cls: 'warn', action: 'download' },
  conflict: { text: 'Changed here and on RomM', cls: 'bad', action: 'choose' },
};
async function refreshDetailCloud() {
  const rom = state.detailRom;
  const row = $('detail-cloud-row');
  const rec = rom && state.downloads.get(rom.id);
  if (!rom || !rec || !platformSetup(rom.platform_id).autoExtract || queueStatusFor(rom.id)) { row.hidden = true; return; }
  const st = await window.r2sd.cloudOwnStatus(rom.id);
  if (state.detailRom?.id !== rom.id) return; // another game's dialog by now
  const line = st.ok && !st.unscoped ? CLOUD_LINE[st.state] : null;
  row.hidden = !line;
  if (!line) return;
  const stateEl = $('detail-cloud-state');
  stateEl.className = `detail-cloud-state ${line.cls}`;
  const when = st.remote?.updatedAt ? new Date(st.remote.updatedAt).toLocaleString() : '';
  stateEl.textContent = line.text + (st.state === 'remote-newer' || st.state === 'remote-only'
    ? ` (${[st.remote?.fromDevice ? `from ${st.remote.fromDevice}` : '', when].filter(Boolean).join(', ')})`
    : '');
  const btn = $('btn-cloud-action');
  btn.hidden = !line.action;
  btn.textContent = { upload: 'Upload save', download: 'Download save', choose: 'Choose…' }[line.action] || '';
  btn.title = {
    upload: 'Upload this game\'s saves to RomM as the newest version (RomM keeps the last 5)',
    download: 'Restore the newest RomM save here (asks first)',
    choose: 'Both sides changed — pick which to keep in Saves & Folders',
  }[line.action] || '';
  btn.onclick = async () => {
    if (line.action === 'choose') { openFoldersModal(rom); return; }
    btn.disabled = true;
    try {
      const res = line.action === 'upload' ? await window.r2sd.cloudUpload(rom.id, st.root) : await window.r2sd.cloudDownload(rom.id, st.root);
      if (res.cancelled) return;
      if (res.error) toast(res.error, 'error');
      else toast(line.action === 'upload' ? `${rom.name || rom.fs_name}: saves uploaded to RomM` : `${rom.name || rom.fs_name}: saves restored from RomM`, 'success');
    } finally {
      btn.disabled = false;
      refreshDetailCloud();
    }
  };
}

function openDetail(rom) {
  state.detailRom = rom;
  $('detail-name').textContent = rom.name || rom.fs_name || 'Unknown';

  const facts = $('detail-facts');
  facts.innerHTML = '';
  const md = rom.metadatum || {};
  addFact(facts, 'Released', romYear(rom));
  addFact(facts, 'Genres', romGenres(rom).join(', '));
  addFact(facts, 'Rating', romRating(rom) ? `${Math.round(romRating(rom))} / 100` : '');
  addFact(facts, 'Companies', (md.companies || []).slice(0, 3).join(', '));
  addFact(facts, 'Players', md.player_count);
  addFact(facts, 'Size', formatSize(rom.fs_size_bytes));
  addFact(facts, 'File', rom.fs_name);

  $('detail-summary').textContent = rom.summary || '';

  const cover = document.querySelector('#detail-modal .detail-cover img');
  cover.removeAttribute('src');
  setAssetSrc(cover, rom.id, rom.path_cover_large || rom.path_cover_small || '');

  const shots = $('detail-screenshots');
  shots.innerHTML = '';
  for (const shotPath of (rom.merged_screenshots || []).slice(0, 8)) {
    const img = document.createElement('img');
    img.alt = '';
    shots.appendChild(img);
    setAssetSrc(img, rom.id, shotPath);
  }

  refreshDetailActions();
  $('detail-cloud-row').hidden = true;
  refreshDetailCloud();

  const modal = $('detail-modal');
  modal.hidden = false;
  modal.querySelector('.detail-card').scrollTop = 0;
}

function closeDetail() {
  $('detail-modal').hidden = true;
  state.detailRom = null;
}

// ── Exe picker / desktop shortcut ───────────────────────

let exeSelected = null;
let exePickerRom = null;

async function openExePicker(rom) {
  exePickerRom = rom;
  exeSelected = null;
  const hadDefault = Boolean(state.downloads.get(rom.id)?.defaultExe);
  $('exe-title').textContent = hadDefault ? 'Change Executable' : 'Choose Executable';
  $('exe-subtitle').textContent = hadDefault
    ? 'Pick the executable this game launches with. ★ is the current one.'
    : 'Pick the executable this game launches with. You can change it later from the game\'s details.';
  $('exe-clear').hidden = !hadDefault;
  $('exe-shortcut').disabled = true;
  $('exe-steam').disabled = true;
  $('exe-play').disabled = true;
  $('exe-setdefault').disabled = true;
  $('exe-list').innerHTML = '<p class="muted small">Scanning for executables…</p>';

  // Native "Add to Steam" only shown when a Steam install is found; the
  // "right-click → Add to Steam" tip is the Linux/Deck manual fallback.
  const [platform, steam, fg] = await Promise.all([window.r2sd.getPlatform(), window.r2sd.steamStatus(), window.r2sd.faugusStatus()]);
  $('exe-steam').hidden = !steam.found;
  const faugusActive = platform === 'linux' && fg.found && fg.enabled;
  $('exe-faugus-tip').hidden = !faugusActive;
  $('exe-steamdeck-tip').hidden = !(platform === 'linux' && !steam.found && !faugusActive);
  // On Linux these are Windows .exe games — offer "Run with Proton". If we can
  // drive SteamClient live (Decky/CEF) the checkbox sets it automatically; if not,
  // fall back to the manual Compatibility tip.
  $('exe-proton-check').hidden = !(platform === 'linux' && steam.found);
  $('exe-proton-tip').hidden = !(platform === 'linux' && steam.found && !steam.canEditLive);
  $('exe-modal').hidden = false;

  const exes = await window.r2sd.listExes(rom.id);
  if (!exes.length) {
    $('exe-list').innerHTML = '<p class="error small">No .exe files found in the installed folder.</p>';
    return;
  }
  const currentDefault = state.downloads.get(rom.id)?.defaultExe;
  const enableActions = () => {
    $('exe-shortcut').disabled = false;
    $('exe-steam').disabled = false;
    $('exe-play').disabled = false;
    $('exe-setdefault').disabled = false;
  };
  $('exe-list').innerHTML = '';
  exes.forEach((exe, i) => {
    const isDefault = exe.path === currentDefault;
    const label = document.createElement('label');
    label.className = 'exe-option' + (isDefault ? ' selected' : '');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'exe';
    radio.value = String(i);
    if (isDefault) { radio.checked = true; exeSelected = exe; }
    radio.addEventListener('change', () => {
      exeSelected = exe;
      enableActions();
      document.querySelectorAll('.exe-option').forEach((el, j) => el.classList.toggle('selected', j === i));
    });
    const span = document.createElement('span');
    span.textContent = exe.relativePath;
    label.append(radio, span);
    if (isDefault) {
      const tag = document.createElement('span');
      tag.className = 'exe-default-tag';
      tag.textContent = '★ default';
      label.appendChild(tag);
    }
    $('exe-list').appendChild(label);
  });
  if (exeSelected) enableActions(); // a default was pre-selected
}

function closeExePicker() {
  $('exe-modal').hidden = true;
  exePickerRom = null;
  exeSelected = null;
}

async function createShortcut() {
  if (!exeSelected || !exePickerRom) return;
  const res = await window.r2sd.createShortcut(exePickerRom.id, exeSelected.path, exePickerRom.name || exePickerRom.fs_name);
  closeExePicker();
  if (res.error) toast(res.error, 'error');
  else toast(res.appMenu ? 'Added to your app menu (runs through Faugus)' : 'Desktop shortcut created', 'success');
}

async function setDefaultFromPicker() {
  if (!exeSelected || !exePickerRom) return;
  const rom = exePickerRom;
  const res = await window.r2sd.setDefaultExe(rom.id, exeSelected.path);
  await reloadDownloads();
  if (res && res.error) toast(res.error, 'error');
  else toast(`Play now runs ${exeSelected.relativePath}`, 'success');
  // The game may already be in Faugus under the old exe — the main process
  // repoints that entry so it keeps its prefix (and its saves).
  if (res && res.faugus) {
    if (res.faugus.error) toast(`Faugus not updated: ${res.faugus.error}`, 'error');
    else toast(`Updated ${res.faugus.gameId} in Faugus — same prefix, so your saves stay put`, 'success');
  }
  updateCardBadge(rom.id);
  if (state.detailRom?.id === rom.id) refreshDetailActions();
  openExePicker(rom); // refresh the ★ default marker
}

async function clearDefaultFromPicker() {
  if (!exePickerRom) return;
  const rom = exePickerRom;
  await window.r2sd.setDefaultExe(rom.id, '');
  await reloadDownloads();
  closeExePicker();
  toast('Cleared — Play will ask which executable to use', 'success');
  updateCardBadge(rom.id);
  if (state.detailRom?.id === rom.id) refreshDetailActions();
}

function launchToast(rom, res) {
  if (res.error) { toast(res.error, 'error'); return; }
  const name = rom.name || rom.fs_name;
  if (res.via !== 'faugus') toast(`Launching ${name}…`, 'success');
  else if (res.faugusRegistered) toast(`Added ${name} to Faugus with its own prefix — launching…`, 'success');
  else toast(`Launching ${name} via Faugus Launcher…`, 'success');
  if (res.faugusRegisterError) toast(`${res.faugusRegisterError}. Ran in the shared prefix this time.`, 'error');
  const c = res.cloud;
  if (!c || c.action === 'none') return;
  const from = c.from ? ` from ${c.from}` : '';
  if (c.action === 'restored') toast(`Restored newer saves${from} (RomM)`, 'success');
  else if (c.action === 'seeded') toast(res.via === 'faugus' ? `New prefix seeded with your RomM saves${from}` : `Restored your RomM saves${from}`, 'success');
  else if (c.action === 'unscoped') toast('Cloud saves: no save locations known for this game yet — Saves & Folders… → What syncs… to set them', 'error');
  else if (c.action === 'uploaded') toast('Uploaded your latest saves to RomM before launching', 'success');
  else if (c.action === 'conflict') toast('Saves differ from RomM on both sides — not synced. Use Saves & Folders… to choose.', 'error');
  else if (c.action === 'error') toast(`Cloud saves: ${c.error}`, 'error');
}

async function playFromPicker() {
  if (!exeSelected || !exePickerRom) return;
  const rom = exePickerRom;
  const exe = exeSelected;
  closeExePicker();
  const res = await window.r2sd.launchGame(rom.id, exe.path, rom.path_cover_large || rom.path_cover_small || ''); // also sets as default
  launchToast(rom, res);
  await reloadDownloads();
  if (state.detailRom?.id === rom.id) refreshDetailActions();
}

/** Play a downloaded game: launch its default exe, or pick one first. */
async function playGame(rom) {
  const rec = state.downloads.get(rom.id);
  if (rec && rec.defaultExe) {
    launchToast(rom, await window.r2sd.launchGame(rom.id, undefined, rom.path_cover_large || rom.path_cover_small || ''));
  } else {
    openExePicker(rom); // no default yet — choose an exe, then Play from the picker
  }
}

async function addToSteam() {
  if (!exeSelected || !exePickerRom) return;
  const proton = !$('exe-proton-check').hidden && $('exe-proton').checked;
  const coverPath = exePickerRom.path_cover_large || exePickerRom.path_cover_small || '';
  const res = await window.r2sd.addToSteam(exePickerRom.id, exeSelected.path, exePickerRom.name || exePickerRom.fs_name, proton, coverPath);
  if (res.error) {
    // Keep the picker open (e.g. Steam is running → user needs to quit it first)
    toast(res.error, 'error');
    return;
  }
  closeExePicker();
  let msg = res.alreadyPresent ? 'Already in your Steam library'
    : res.live ? 'Added to Steam — it will appear in your library shortly'
    : 'Added to Steam — restart Steam to see it in your library';
  const done = [];
  if (res.nameLive) done.push('named');
  if (res.artworkLive) done.push('cover art set');
  if (proton && res.protonLive) done.push('Proton Experimental set');
  if (done.length) msg += ' · ' + done.join(', ');
  if (proton && !res.protonLive) msg += ' · set Proton in Properties → Compatibility';
  toast(msg, 'success');
}

// ── Game folders modal ──────────────────────────────────
// Install dir + the Windows-side user folders (Documents, Saved Games,
// AppData…) inside whichever Proton prefix the game runs in. Paths come from
// the main process and are re-validated there on open.

let foldersRom = null;
async function openFoldersModal(rom) {
  foldersRom = rom;
  $('folders-game').textContent = rom.name || rom.fs_name;
  const list = $('folders-list');
  list.innerHTML = '<p class="folders-empty">Looking up folders…</p>';
  $('folders-modal').hidden = false;

  const info = await window.r2sd.gameFolders(rom.id);
  if (foldersRom?.id !== rom.id) return;
  list.innerHTML = '';
  const addGroup = (label, root, items, saveActions = false) => {
    const g = document.createElement('div');
    const l = document.createElement('div'); l.className = 'folders-group-label'; l.textContent = label;
    g.appendChild(l);
    if (root) { const r = document.createElement('div'); r.className = 'folders-group-root'; r.textContent = root; r.title = root; g.appendChild(r); }
    const row = document.createElement('div'); row.className = 'folders-group-items';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'secondary folder-btn';
      b.textContent = it.label;
      b.title = it.path;
      b.addEventListener('click', async () => {
        const res = await window.r2sd.openGameFolder(rom.id, it.path);
        if (res.error) toast(res.error, 'error');
      });
      row.appendChild(b);
    }
    g.appendChild(row);
    if (saveActions) {
      const actions = document.createElement('div');
      actions.className = 'folders-group-actions';
      const mk = (label, title, fn) => {
        const b = document.createElement('button');
        b.className = 'secondary'; b.textContent = label; b.title = title;
        b.addEventListener('click', async () => {
          b.disabled = true;
          try { await fn(); } finally { b.disabled = false; }
        });
        actions.appendChild(b);
      };
      mk('Back up saves…', 'Zip this prefix\'s Documents / Saved Games / AppData to a folder you choose', async () => {
        const res = await window.r2sd.backupSaves(rom.id, root);
        if (res.cancelled) return;
        if (res.error) toast(res.error, 'error');
        else toast(`Saves backed up: ${res.file}`, 'success');
      });
      mk('Restore saves…', 'Extract a saves backup (.zip) into this prefix, overwriting same-named files', async () => {
        const res = await window.r2sd.restoreSaves(rom.id, root);
        if (res.cancelled) return;
        if (res.error) toast(res.error, 'error');
        else toast(`Saves restored (${res.folders.join(', ')})${res.skipped ? ` — ${res.skipped} files outside this game's save locations left out` : ''}`, 'success');
      });
      mk('What syncs…', 'The files a backup or cloud sync would include, and what is excluded as config', () => openSyncsModal(rom, root));
      g.appendChild(actions);

      // Cloud (RomM) row: status + upload/download
      const cloudRow = document.createElement('div');
      cloudRow.className = 'folders-cloud';
      cloudRow.textContent = 'RomM: checking…';
      g.appendChild(cloudRow);
      const cloudActions = document.createElement('div');
      cloudActions.className = 'folders-group-actions';
      const cmk = (label, title, fn) => {
        const b = document.createElement('button');
        b.className = 'secondary'; b.textContent = label; b.title = title;
        b.addEventListener('click', async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } });
        cloudActions.appendChild(b);
        return b;
      };
      const refreshCloud = async () => {
        const st = await window.r2sd.cloudStatus(rom.id, root);
        if (foldersRom?.id !== rom.id) return;
        cloudRow.innerHTML = '';
        if (!st.ok) { cloudRow.textContent = `RomM: ${st.error}`; return; }
        const label = {
          nothing: ['No saves here or on RomM', ''], 'remote-only': ['RomM has saves, nothing local yet', 'warn'],
          'local-only': ['Not on RomM yet', 'warn'], 'in-sync': ['In sync with RomM', 'ok'],
          'local-newer': ['Local is newer than RomM', 'warn'], 'remote-newer': ['RomM is newer than local', 'warn'],
          conflict: ['Both changed since last sync — choose', 'bad'],
        }[st.state] || [st.state, ''];
        const s = document.createElement('span'); s.className = 'state ' + label[1]; s.textContent = label[0];
        cloudRow.appendChild(s);
        if (st.remote) {
          const when = new Date(st.remote.updatedAt);
          cloudRow.append(` · latest on RomM ${when.toLocaleString()}${st.remote.fromDevice ? ` from ${st.remote.fromDevice}` : ''} (${formatSize(st.remote.size)}, ${st.remote.versions} version${st.remote.versions === 1 ? '' : 's'})`);
        }
        if (st.local) cloudRow.append(` · local ${st.local.files} files, ${formatSize(st.local.bytes)}${st.local.excludedConfig ? `, ${st.local.excludedConfig} config files excluded` : ''}`);
        if (st.unscoped) cloudRow.append(' · no save locations known yet (What syncs…)');
        else if (!st.own) cloudRow.append(' · shared prefix: manual only');
      };
      cmk('Upload to RomM', 'Zip this prefix\'s saves and store them in your RomM account (keeps the last 5 versions)', async () => {
        const res = await window.r2sd.cloudUpload(rom.id, root);
        if (res.error) toast(res.error, 'error'); else toast(`Uploaded ${res.files} files (${formatSize(res.bytes)}) to RomM`, 'success');
        await refreshCloud();
      });
      cmk('Download from RomM', 'Restore the latest RomM save into this prefix', async () => {
        const res = await window.r2sd.cloudDownload(rom.id, root);
        if (res.cancelled) return;
        if (res.error) toast(res.error, 'error'); else toast('Saves restored from RomM', 'success');
        await refreshCloud();
      });
      cmk('History…', 'The versions RomM keeps (the last 5) — restore an older one', () => openHistoryModal(rom, root, refreshCloud));
      g.appendChild(cloudActions);
      refreshCloud();
    }
    list.appendChild(g);
  };
  if (info.gameFolder) addGroup('Game', null, [{ label: 'Game folder (install)', path: info.gameFolder }]);
  for (const p of info.prefixes) if (p.folders.length) addGroup(p.label, p.root, p.folders, true);
  if (!info.gameFolder && !info.prefixes.length) {
    list.innerHTML = '<p class="folders-empty">No folders found yet.</p>';
  } else if (!info.prefixes.length) {
    const hint = document.createElement('p');
    hint.className = 'folders-empty';
    hint.textContent = info.exe
      ? 'No Windows-side folders yet — they appear after the game has been run once (through Faugus or Steam).'
      : 'Pick a default executable (Play… or Add to Steam…) to locate this game\'s Windows-side save and config folders.';
    list.appendChild(hint);
  }
}
function closeFoldersModal() { $('folders-modal').hidden = true; foldersRom = null; }

// ── Cloud save history modal ────────────────────────────

let historyCtx = null;
async function openHistoryModal(rom, root, onChanged) {
  historyCtx = { rom, root, onChanged };
  $('history-game').textContent = `${rom.name || rom.fs_name} — ${root}`;
  $('history-list').innerHTML = '<div class="history-empty">Asking RomM…</div>';
  $('history-modal').hidden = false;
  await renderHistory();
}
async function renderHistory() {
  if (!historyCtx) return;
  const { rom, root } = historyCtx;
  const res = await window.r2sd.cloudHistory(rom.id, root);
  if (!historyCtx || historyCtx.rom.id !== rom.id) return;
  const list = $('history-list');
  list.innerHTML = '';
  const empty = (text) => { const d = document.createElement('div'); d.className = 'history-empty'; d.textContent = text; list.appendChild(d); };
  if (!res.ok) { empty(`RomM: ${res.error}`); return; }
  if (!res.versions.length) { empty('No saves for this game on RomM yet.'); return; }
  for (const v of res.versions) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const info = document.createElement('div');
    info.className = 'info';
    const when = document.createElement('div');
    when.className = 'when';
    const label = new Date(v.createdAt).toLocaleString();
    when.textContent = label;
    const tag = (text, cls) => { const t = document.createElement('span'); t.className = `tag ${cls}`; t.textContent = text; when.appendChild(t); };
    if (v.latest) tag('Latest', 'latest');
    if (v.current) tag('On this device', 'here');
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [v.fromDevice ? `from ${v.fromDevice}` : 'from an unknown device', formatSize(v.size)].join(' · ');
    info.append(when, meta);
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = 'Restore';
    // The newest version that is also what's here already: nothing to do
    btn.disabled = v.latest && v.current;
    btn.title = btn.disabled ? 'Already the current save here and on RomM' : 'Put this version back here, and make it the newest on RomM';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await window.r2sd.cloudRestoreVersion(rom.id, root, v.saveId, label);
        if (r.cancelled) return;
        if (r.error) {
          toast(r.error, 'error');
        } else {
          const actions = [{ label: 'OK' }];
          if (r.backup) actions.unshift({ label: 'Show backup', fn: () => window.r2sd.showSaveBackup(r.backup) });
          stickyToast(`Restored the save from ${label}${r.reuploaded ? ' — it is now the newest on RomM' : ''}.${r.backup ? ' Your previous saves were backed up first.' : ''}`, actions, 'success');
        }
        await renderHistory();
        historyCtx?.onChanged?.();
      } finally { btn.disabled = false; }
    });
    row.append(info, btn);
    list.appendChild(row);
  }
}
function closeHistoryModal() { $('history-modal').hidden = true; historyCtx = null; }

// ── What syncs modal ────────────────────────────────────

let syncsCtx = null;
async function openSyncsModal(rom, root) {
  syncsCtx = { rom, root };
  $('syncs-game').textContent = `${rom.name || rom.fs_name} — ${root}`;
  $('syncs-list').innerHTML = '<div class="f">Scanning…</div>';
  $('syncs-modal').hidden = false;
  await renderSyncs();
}
async function renderSyncs() {
  if (!syncsCtx) return;
  const { rom, root } = syncsCtx;
  const p = await window.r2sd.savesPreview(rom.id, root);
  if (!syncsCtx || syncsCtx.rom.id !== rom.id) return;
  const list = $('syncs-list');
  list.innerHTML = '';
  if (!p.ok) { list.textContent = p.error; return; }
  $('syncs-summary').textContent = p.unscoped
    ? 'Nothing will sync until this game\'s save locations are known.'
    : `${p.included.length} files, ${formatSize(p.totalBytes)} will sync · ${p.excluded.filter((e) => e.reason === 'config').length} config files excluded · ${p.excluded.filter((e) => e.reason === 'junk').length} temp/system files skipped`;
  $('syncs-include').checked = p.includeConfig;
  $('syncs-patterns').value = p.patterns.join('\n');
  // Windows: the real profile holds everything, so only the game's own locations are read
  $('syncs-paths-section').hidden = !p.scoped;
  if (p.scoped) {
    if (document.activeElement !== $('syncs-paths')) $('syncs-paths').value = p.savePaths.join('\n');
    $('syncs-paths-note').textContent = p.savePaths.length
      ? `Source: ${p.savePathsNote || 'unknown'}`
      : 'None yet — Look up checks for a Steam-emulator app id and the PCGamingWiki save-location database; a restore from RomM or a backup also teaches them.';
  }
  const add = (cls, text, why) => { const d = document.createElement('div'); d.className = 'f ' + cls; d.textContent = text; d.title = text; if (why) { const w = document.createElement('span'); w.className = 'why'; w.textContent = why; d.appendChild(w); } list.appendChild(d); };
  const h = (t) => { const d = document.createElement('div'); d.className = 'h'; d.textContent = t; list.appendChild(d); };
  h('Included');
  if (!p.included.length) add('x', '(nothing yet)');
  for (const f of p.included.slice(0, 400)) add('', `${f.rel}  (${formatSize(f.size)})`);
  if (p.included.length > 400) add('x', `… and ${p.included.length - 400} more`);
  const cfg = p.excluded.filter((e) => e.reason === 'config');
  h('Excluded as config (per-device settings)');
  if (!cfg.length) add('x', '(none)');
  for (const f of cfg.slice(0, 200)) add('x', f.rel, `matches ${f.pattern}`);
}
function closeSyncsModal() { $('syncs-modal').hidden = true; syncsCtx = null; }

// ── Platform folders modal ──────────────────────────────

function pathSep(sample) {
  return sample.includes('\\') ? '\\' : '/';
}

function markDirty() {
  $('pf-dirty').textContent = '● Unsaved changes';
}
function clearDirty() {
  $('pf-dirty').textContent = '';
}

function buildPlatformRows() {
  const rows = $('pf-rows');
  rows.innerHTML = '';
  const platforms = sortedPlatforms();
  for (const p of platforms) {
    const setup = platformSetup(p.id);
    const row = document.createElement('div');
    row.className = 'pf-row';
    row.dataset.platformId = p.id;
    row.dataset.fsSlug = p.fs_slug || '';

    const name = document.createElement('div');
    name.className = 'pf-name';
    name.innerHTML = '';
    const nm = document.createElement('div');
    nm.textContent = p.name;
    const ct = document.createElement('div');
    ct.className = 'count';
    ct.textContent = `${p.rom_count} games`;
    name.append(nm, ct);

    const paths = document.createElement('div');
    paths.className = 'pf-paths';

    // Download-folder field: used only when NOT extracting
    const folderRow = document.createElement('span');
    folderRow.className = 'path-row';
    const folderInput = document.createElement('input');
    folderInput.type = 'text';
    folderInput.className = 'pf-folder';
    folderInput.placeholder = 'Download folder (e.g. roms/' + (p.fs_slug || 'slug') + ')';
    folderInput.value = setup.folder;
    folderInput.addEventListener('input', markDirty);
    const folderBrowse = document.createElement('button');
    folderBrowse.className = 'icon-btn';
    folderBrowse.innerHTML = '&#128193;';
    folderBrowse.title = 'Browse';
    folderBrowse.addEventListener('click', async () => {
      const picked = await window.r2sd.pickFolder(`Folder for ${p.name}`);
      if (picked) { folderInput.value = picked; markDirty(); }
    });
    folderRow.append(folderInput, folderBrowse);
    paths.appendChild(folderRow);

    // Install-path list: used only when extracting. Supports multiple paths
    // (e.g. C:\Games and D:\Games) — the download picker lets you choose which.
    const installList = document.createElement('div');
    installList.className = 'pf-install-list';
    const makeInstallRow = (value) => {
      const r = document.createElement('span');
      r.className = 'path-row';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'pf-install';
      inp.placeholder = 'Install path (e.g. C:\\Games or D:\\Games)';
      inp.value = value || '';
      inp.addEventListener('input', markDirty);
      const browse = document.createElement('button');
      browse.className = 'icon-btn';
      browse.innerHTML = '&#128193;';
      browse.title = 'Browse';
      browse.addEventListener('click', async () => {
        const picked = await window.r2sd.pickFolder(`Install path for ${p.name}`);
        if (picked) { inp.value = picked; markDirty(); }
      });
      const remove = document.createElement('button');
      remove.className = 'icon-btn';
      remove.innerHTML = '&#10005;';
      remove.title = 'Remove this path';
      remove.addEventListener('click', () => { r.remove(); markDirty(); });
      r.append(inp, browse, remove);
      return r;
    };
    const addPathBtn = document.createElement('button');
    addPathBtn.className = 'secondary pf-add-path';
    addPathBtn.textContent = '+ Add install path';
    addPathBtn.addEventListener('click', () => { installList.insertBefore(makeInstallRow(''), addPathBtn); markDirty(); });
    const initialPaths = setup.installPaths.length ? setup.installPaths : [''];
    for (const v of initialPaths) installList.appendChild(makeInstallRow(v));
    installList.appendChild(addPathBtn);
    paths.appendChild(installList);

    const extract = document.createElement('label');
    extract.className = 'pf-extract';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pf-autoextract';
    check.checked = setup.autoExtract;
    // Show only the field(s) that apply to this platform's mode
    const applyMode = () => {
      folderRow.style.display = check.checked ? 'none' : '';
      installList.style.display = check.checked ? '' : 'none';
    };
    applyMode();
    check.addEventListener('change', () => { applyMode(); markDirty(); });
    extract.append(check, document.createTextNode('Extract'));

    row.append(name, paths, extract);
    rows.appendChild(row);
  }
}

async function openPlatformsModal() {
  await reloadConfig();
  $('pf-base').value = state.config.basePath || '';
  $('pf-staging').value = state.config.stagingPath || '';
  buildPlatformRows();
  clearDirty();
  $('platforms-modal').hidden = false;
}

function closePlatformsModal() {
  $('platforms-modal').hidden = true;
}

async function savePlatformsModal() {
  // Start from what's saved: the dialog only lists platforms that currently
  // have games, and a platform that is briefly empty (a server rescan) or
  // missing from a failed refresh must not lose its folders on Save.
  const platforms = { ...(state.config?.platforms || {}) };
  for (const row of document.querySelectorAll('.pf-row')) {
    const id = row.dataset.platformId;
    platforms[id] = {
      folder: row.querySelector('.pf-folder').value.trim(),
      autoExtract: row.querySelector('.pf-autoextract').checked,
      installPaths: [...new Set([...row.querySelectorAll('.pf-install')].map((i) => i.value.trim()).filter(Boolean))],
    };
  }
  await window.r2sd.setConfig({
    platforms,
    basePath: $('pf-base').value.trim(),
    stagingPath: $('pf-staging').value.trim(),
  });
  await reloadConfig();
  clearDirty();
  toast('Platform folders saved', 'success');
}

function autofillPlatformFolders() {
  const base = $('pf-base').value.trim().replace(/[\\/]+$/, '');
  if (!base) { toast('Set a base folder first', 'error'); return; }
  const sep = pathSep(base);
  let filled = 0;
  for (const row of document.querySelectorAll('.pf-row')) {
    const input = row.querySelector('.pf-folder');
    const slug = row.dataset.fsSlug;
    if (!input.value.trim() && slug) {
      input.value = `${base}${sep}${slug}`;
      filled++;
    }
  }
  toast(`Filled ${filled} empty folder${filled === 1 ? '' : 's'}`);
}

// ── Settings ────────────────────────────────────────────

const UI_SCALE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: '100', label: '100%' },
  { value: '125', label: '125%' },
  { value: '150', label: '150%' },
  { value: '175', label: '175%' },
  { value: '200', label: '200%' },
];

/** Reflect the main process's effective zoom in the Settings dropdown + hint. */
function renderUiScale(info) {
  setDropdownValue('cfg-uiscale', info.scale);
  const pct = Math.round(info.zoom * 100);
  $('cfg-uiscale-hint').textContent = info.scale === 'auto'
    ? (info.deck ? `Steam Deck detected — ${pct}%` : `${pct}%`)
    : 'Ctrl + / Ctrl − to step, Ctrl 0 for Auto';
}

const FAUGUS_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
];
const FAUGUS_PREFIX_OPTIONS = [
  { value: 'per-game', label: 'Per game' },
  { value: 'shared', label: 'Shared (default)' },
];
const CLOUD_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask after playing' },
  { value: 'auto', label: 'Auto' },
];

const UPDATE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
];

const PLAY_WINDOW_OPTIONS = [
  { value: 'minimize', label: 'Minimize R2SD' },
  { value: 'stay', label: 'Stay open' },
];

const PLAY_WORKSPACE_OPTIONS = [
  { value: 'off', label: 'Leave to Hyprland' },
  { value: 'fullscreen', label: 'Own workspace, fullscreen' },
  { value: 'workspace', label: 'Own workspace' },
];

async function renderPlayWindowSetting(cfg) {
  setDropdownValue('cfg-playwindow', cfg.playWindow || 'minimize');
  $('cfg-playwindow-hint').textContent = cfg.playWindow === 'stay'
    ? 'R2SD stays where it is; the controller is ignored until the game exits'
    : 'Gets R2SD out of the way while the game runs, then brings it back';
  const desk = await window.r2sd.getDesktop();
  $('cfg-playworkspace-row').hidden = !desk.hyprland;
  if (desk.hyprland) {
    setDropdownValue('cfg-playworkspace', cfg.playWorkspace || 'off');
    $('cfg-playworkspace-hint').textContent = {
      fullscreen: 'The game opens on a fresh workspace and goes fullscreen; R2SD gets focus back when it exits',
      workspace: 'The game opens on a fresh workspace; window size is left alone',
      off: 'Your compositor places the game window (use this if you have tiling off)',
    }[cfg.playWorkspace || 'off'];
    $('cfg-playwindow-row').hidden = cfg.playWorkspace !== 'off'; // minimize is meaningless on Hyprland when the game gets its own workspace
  } else {
    $('cfg-playwindow-row').hidden = false;
  }
}

function renderUpdateSetting(cfg) {
  setDropdownValue('cfg-updates', cfg.updateCheck || 'auto');
  $('cfg-updates-hint').textContent = cfg.updateCheck === 'off'
    ? 'Never asks GitHub for a newer release'
    : (cfg.updateCheckedAt ? `Checks GitHub daily · last ${new Date(cfg.updateCheckedAt).toLocaleDateString()}` : 'Checks GitHub daily on startup');
}

/** Faugus / prefix rows are Linux only; cloud saves shows on Linux and Windows. */
async function renderFaugusSetting(cfg) {
  const [platform, fg] = await Promise.all([window.r2sd.getPlatform(), window.r2sd.faugusStatus()]);
  $('cfg-faugus-row').hidden = platform !== 'linux';
  $('cfg-faugusprefix-row').hidden = platform !== 'linux';
  $('cfg-cloud-row').hidden = platform !== 'linux' && platform !== 'win32';
  setDropdownValue('cfg-cloud', cfg.cloudSaves || 'off');
  if (platform === 'win32') {
    $('cfg-cloud-hint').textContent = {
      auto: 'Restore before Play, upload after the game exits — games with known save locations',
      ask: 'When a game exits with changed saves, offers to upload them — games with known save locations',
    }[cfg.cloudSaves] || "Upload/download by hand from a game's dialog or Saves & Folders…";
    return;
  }
  if (platform !== 'linux') return;
  $('cfg-cloud-hint').textContent = cfg.cloudSaves !== 'off' && cfg.faugusPrefix === 'shared'
    ? 'Needs Prefix: Per game'
    : {
      auto: 'Restore before Play, upload after — per-game prefixes only',
      ask: 'When a game exits with changed saves, offers to upload them — per-game prefixes only',
    }[cfg.cloudSaves] || "Upload/download by hand from a game's dialog or Saves & Folders…";
  setDropdownValue('cfg-faugus', cfg.faugus || 'auto');
  setDropdownValue('cfg-faugusprefix', cfg.faugusPrefix || 'per-game');
  $('cfg-faugusprefix-hint').textContent = cfg.faugusPrefix === 'shared'
    ? 'All games share ~/Faugus/default'
    : 'Each game gets its own prefix and appears in Faugus\'s library';
  // "Run with Faugus" for any .exe on the system, straight from the file manager
  const fhRow = $('cfg-filehandler-row');
  fhRow.hidden = !(fg.found && fg.canInstallHandler);
  if (!fhRow.hidden) {
    $('btn-filehandler').textContent = fg.fileHandler ? 'Remove from file manager' : 'Add to file manager';
    $('cfg-filehandler-hint').textContent = fg.fileHandler
      ? 'Right-click any .exe → Open With → "Run with Faugus (R2SD)"'
      : 'Adds "Run with Faugus (R2SD)" to the Open With menu for .exe files';
  }
  const how = { binary: 'system package', appimage: 'AppImage', flatpak: 'Flatpak' }[fg.method] || '';
  $('cfg-faugus-hint').textContent = !fg.found
    ? 'Not installed — Play will point you to Add to Steam'
    : (cfg.faugus === 'off' ? `Installed (${how}), not used` : `Installed (${how}) — Play runs Windows games through it`);
}

async function openSettings() {
  const cfg = await window.r2sd.getConfig();
  window.r2sd.getUiScaleInfo().then(renderUiScale);
  renderFaugusSetting(cfg);
  renderUpdateSetting(cfg);
  renderPlayWindowSetting(cfg);
  window.r2sd.getVersion().then((v) => { $('cfg-version').textContent = v ? `v${v}` : ''; });
  $('cfg-url').value = cfg.baseUrl;
  $('cfg-username').value = cfg.username;
  $('cfg-password').value = '';
  if (cfg.passwordNeedsReentry) {
    $('cfg-password').placeholder = 'Re-enter your password';
    $('cfg-test-result').className = 'small error';
    $('cfg-test-result').textContent = 'Your saved password couldn’t be read on this device — please re-enter it and Save.';
  } else {
    $('cfg-password').placeholder = cfg.hasPassword ? '(unchanged)' : '';
    $('cfg-test-result').className = 'small';
    $('cfg-test-result').textContent = '';
  }
  // "Add R2SD to Steam" only makes sense when a Steam install is found.
  window.r2sd.steamStatus().then((s) => { $('btn-add-self-steam').hidden = !s.found; });
  $('settings-modal').hidden = false;
}

function closeSettings() {
  $('settings-modal').hidden = true;
}

async function testConnection() {
  const result = $('cfg-test-result');
  result.className = 'small';
  result.textContent = 'Testing…';
  const res = await window.r2sd.testConnection({
    baseUrl: $('cfg-url').value,
    username: $('cfg-username').value,
    password: $('cfg-password').value,
  });
  if (res.ok && res.loginChecked === false) {
    // Reachable, but no password to try: the heartbeat alone can't vouch for the login
    result.className = 'small';
    result.textContent = `Server reachable — RomM ${res.version || '(version unknown)'}. Enter the password to check your login.`;
  } else if (res.ok) {
    result.className = 'small success';
    result.textContent = `Connected and signed in — RomM ${res.version || '(version unknown)'}`;
  } else {
    result.className = 'small error';
    result.textContent = res.error || 'Connection failed';
  }
}

async function saveSettings() {
  await window.r2sd.setConfig({
    baseUrl: $('cfg-url').value,
    username: $('cfg-username').value,
    password: $('cfg-password').value,
  });
  await reloadConfig();
  closeSettings();
  state.currentPlatformId = null;
  await loadPlatforms(true);
}

// ── Gamepad navigation (Steam Deck / controllers) ───────

// Polled on a fixed 50 ms timer, not requestAnimationFrame: with
// backgroundThrottling off, a rAF loop kept the renderer busy every frame for
// as long as a controller was connected (always, on the Deck). 20 Hz is
// indistinguishable for menu navigation.
//
// The controller can reach everything the mouse can. Focus lives in one of a
// few "zones", and what the d-pad does depends on which one holds it:
//
//   sidebar  ←→  grid  (up from the top row) ↑ toolbar
//   a modal or an open dropdown takes over entirely while it is up
//
// A activates, B backs out (menu → modal → nothing), LB/RB jump platforms.
const GP_POLL_MS = 50;
const gp = { zone: 'grid', index: -1, gridIndex: -1, ctl: null, timer: null, prev: {}, lastMove: 0, active: false };

/** The grid zone walks the whole (filtered, sorted) game list — not just the
 *  cards that happen to exist right now; see the windowed grid. */
function gpCards() {
  return vg.items;
}

function gpColumns() {
  return vg.cols;
}

const gpVisible = (el) => !!el && !el.disabled && el.getClientRects().length > 0;

function gpSidebarItems() {
  return [...document.querySelectorAll('#platform-list .platform-item')].filter(gpVisible);
}

/** Search box, genre/sort dropdowns (their trigger button) and the icon buttons. */
function gpToolbarItems() {
  const out = [];
  for (const el of document.querySelectorAll('#toolbar .toolbar-controls > *')) {
    const target = el.classList.contains('dropdown') ? el.querySelector('.dropdown-trigger') : el;
    if (gpVisible(target)) out.push(target);
  }
  return out;
}

/** The items of an open dropdown menu, if any — they outrank everything else. */
function gpOpenMenuItems() {
  const open = document.querySelector('.dropdown.open .dropdown-menu:not([hidden])');
  return open ? [...open.querySelectorAll('.dropdown-item')].filter(gpVisible) : [];
}

/** The window on top. Windows stack (History over Saves & Folders over a
 *  game's details); the first open one in page order is often the one
 *  underneath, which left the d-pad driving a window you couldn't see. */
function gpOpenModalCard() {
  for (const [id] of MODAL_LAYERS) {
    const m = $(id);
    if (m && !m.hidden) return m.querySelector('.modal-card');
  }
  return null;
}

/** Everything clickable/typable in the open modal, in reading order. */
function gpModalControls() {
  const card = gpOpenModalCard();
  if (!card) return [];
  return [...card.querySelectorAll('button, input, select, textarea')].filter(gpVisible);
}

/** What the d-pad is driving right now: the zone plus its elements. */
function gpTargets() {
  const menu = gpOpenMenuItems();
  if (menu.length) return { zone: 'menu', items: menu };
  if (gpOpenModalCard()) return { zone: 'modal', items: gpModalControls() };
  if (gp.zone === 'sidebar') return { zone: 'sidebar', items: gpSidebarItems() };
  if (gp.zone === 'toolbar') return { zone: 'toolbar', items: gpToolbarItems() };
  return { zone: 'grid', items: gpCards() };
}

function gpClearFocus() {
  for (const el of document.querySelectorAll('.gp-focus, .gp-focus-ctl')) el.classList.remove('gp-focus', 'gp-focus-ctl');
}

/** Highlight items[i] and remember it, so a re-render can find it again. */
function gpFocus(zone, items, i) {
  gpClearFocus();
  if (!items.length) { gp.index = -1; gp.ctl = null; return; }
  gp.index = Math.max(0, Math.min(i, items.length - 1));
  if (zone === 'grid') {
    // items are roms: scroll that row into view (which builds its card), then ring it
    gp.ctl = null;
    gp.gridIndex = gp.index;
    vgEnsureVisible(gp.index);
    cardFor(items[gp.index].id)?.classList.add('gp-focus');
    return;
  }
  const el = items[gp.index];
  gp.ctl = el;
  el.classList.add('gp-focus-ctl');
  el.scrollIntoView({ block: 'nearest' });
}

/** Re-apply the ring after a zone's elements were rebuilt (same position). */
function gpRefocus() {
  if (gp.index < 0) return;
  const { zone, items } = gpTargets();
  if (items.length) gpFocus(zone, items, gp.index);
}

/** Grid-only helper kept for the re-render hook. */
function gpSetFocus(i) {
  gp.zone = 'grid';
  gpFocus('grid', gpCards(), i);
}

/** Follow the remembered element across re-renders / async modal content. */
function gpSyncIndex(zone, items) {
  if (zone === 'grid') return gp.gridIndex; // its own position, whatever window came and went
  if (gp.ctl) {
    const at = items.indexOf(gp.ctl);
    if (at >= 0) return at;
  }
  return gp.index;
}

function gpEnterZone(zone, i = 0) {
  gp.zone = zone;
  const { items } = gpTargets();
  gpFocus(zone, items, i);
}

/** A modal just opened: start on its primary action, not on the close button. */
function gpEnterModal() {
  const items = gpModalControls();
  if (!items.length) return;
  const primary = items.findIndex((el) => el.classList.contains('primary'));
  gpFocus('modal', items, primary >= 0 ? primary : 0);
}

function gpMove(dir) {
  const { zone, items } = gpTargets();
  if (!items.length) return;
  const i = gpSyncIndex(zone, items);
  if (i < 0) { gpFocus(zone, items, 0); return; }

  if (zone === 'grid') {
    const cols = gpColumns();
    if (dir === 'left' && i % cols === 0) { gpEnterZone('sidebar', 0); return; }
    if (dir === 'up' && i < cols) { gpEnterZone('toolbar', 0); return; }
    const next = dir === 'left' ? i - 1 : dir === 'right' ? i + 1 : dir === 'up' ? i - cols : i + cols;
    if (next >= 0 && next < items.length) gpFocus(zone, items, next);
    return;
  }
  if (zone === 'sidebar') {
    if (dir === 'right') { gpEnterZone('grid', Math.max(0, gp.gridIndex || 0)); return; }
    if (dir === 'up' || dir === 'down') gpFocus(zone, items, i + (dir === 'down' ? 1 : -1));
    return;
  }
  if (zone === 'toolbar') {
    if (dir === 'down') { gpEnterZone('grid', Math.max(0, gp.gridIndex || 0)); return; }
    if (dir === 'left' || dir === 'right') gpFocus(zone, items, i + (dir === 'right' ? 1 : -1));
    return;
  }
  // menu / modal: one linear list, either axis walks it
  const step = dir === 'down' || dir === 'right' ? 1 : -1;
  gpFocus(zone, items, i + step);
}

function gpActivate() {
  const { zone, items } = gpTargets();
  const i = gpSyncIndex(zone, items);
  const el = items[i];
  if (!el) return;
  if (zone === 'grid') { gp.gridIndex = i; openDetail(el); setTimeout(gpEnterModal, 60); return; }
  // A text box wants the keyboard, not a click (the Deck's on-screen keyboard follows focus)
  if (el.tagName === 'INPUT' && /text|search|password|number/.test(el.type)) { el.focus(); return; }
  if (el.tagName === 'TEXTAREA') { el.focus(); return; }
  const wasModal = zone === 'modal' ? gpOpenModalCard() : null;
  el.click();
  // Clicking may have opened a menu, swapped the modal, or closed it
  setTimeout(() => {
    const card = gpOpenModalCard();
    if (zone === 'modal' && card && card !== wasModal) { gpEnterModal(); return; }
    if (zone === 'modal' && !card) { gpEnterZone('grid', gp.gridIndex || 0); return; }
    const t = gpTargets();
    gpFocus(t.zone, t.items, t.zone === zone ? gp.index : 0);
  }, 60);
}

function anyModalOpen() {
  return [...document.querySelectorAll('.modal')].some((m) => !m.hidden);
}

/**
 * Close only the window on top. Windows open on top of each other (What
 * syncs… over Saves & Folders over a game's details), and backing out should
 * go one step, like a browser's Back — not straight to the grid. Listed
 * top-most first; returns false when nothing was open.
 */
const MODAL_LAYERS = [
  ['history-modal', () => closeHistoryModal()],
  ['syncs-modal', () => closeSyncsModal()],
  ['exe-modal', () => closeExePicker()],
  ['folders-modal', () => closeFoldersModal()],
  ['installpath-modal', () => closeInstallPathPicker()],
  ['theme-modal', () => { $('theme-modal').hidden = true; }],
  ['platforms-modal', () => closePlatformsModal()],
  ['settings-modal', () => closeSettings()],
  ['detail-modal', () => closeDetail()],
];
function closeTopModal() {
  for (const [id, close] of MODAL_LAYERS) {
    if (!$(id).hidden) { close(); return true; }
  }
  return false;
}

function gpBack() {
  if (gpOpenMenuItems().length) { closeAllDropdowns(); gpEnterZone(gp.zone, gp.index); return; }
  if (!closeTopModal()) return;
  // Back in the window underneath, or on the grid when that was the last one
  if (anyModalOpen()) gpEnterModal();
  else gpEnterZone('grid', gp.gridIndex || 0);
}

/** LB / RB: straight to the previous or next platform, from anywhere. */
function gpPlatformStep(delta) {
  const items = gpSidebarItems();
  if (!items.length) return;
  const at = items.findIndex((el) => el.classList.contains('active'));
  const next = items[Math.max(0, Math.min((at < 0 ? 0 : at) + delta, items.length - 1))];
  if (next && next !== items[at]) next.click();
}

// A game launched from Play gets the controller; R2SD must not. Set/cleared by
// the main process around the game's lifetime (game:running / game:exited).
// Untracked launches (bare-exe Faugus, i.e. no exit signal) stay "running"
// until the user brings R2SD back to the front.
let gameRunning = null; // null | 'tracked' | 'untracked'
window.r2sd.onGameRunning((e) => { gameRunning = e.exitTracked ? 'tracked' : 'untracked'; gp.prev = { a: true, b: true }; });
window.r2sd.onGameExited(() => { gameRunning = null; gp.prev = { a: true, b: true }; });
window.addEventListener('focus', () => { if (gameRunning === 'untracked') gameRunning = null; gp.prev = { a: true, b: true }; });

/** Only a focused, visible R2SD with no game running reads the controller. */
function gpMayRead() {
  return !gameRunning && document.visibilityState === 'visible' && document.hasFocus();
}

function gpPoll() {
  if (!gpMayRead()) { gp.prev = { a: true, b: true }; return; } // held buttons don't fire on return either
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = [...pads].find((p) => p);
  if (!pad) return;
  const now = performance.now();
  const axH = pad.axes[0] || 0;
  const axV = pad.axes[1] || 0;
  const btn = (n) => pad.buttons[n] && pad.buttons[n].pressed;
  const up = btn(12) || axV < -0.5;
  const down = btn(13) || axV > 0.5;
  const left = btn(14) || axH < -0.5;
  const right = btn(15) || axH > 0.5;
  const a = btn(0);
  const b = btn(1);
  const lb = btn(4);
  const rb = btn(5);

  if (now - gp.lastMove > 160) {
    let moved = true;
    if (up) gpMove('up');
    else if (down) gpMove('down');
    else if (left) gpMove('left');
    else if (right) gpMove('right');
    else moved = false;
    if (moved) gp.lastMove = now;
  }

  // Edge-triggered buttons
  if (a && !gp.prev.a) gpActivate();
  if (b && !gp.prev.b) gpBack();
  if (lb && !gp.prev.lb && !anyModalOpen()) gpPlatformStep(-1);
  if (rb && !gp.prev.rb && !anyModalOpen()) gpPlatformStep(1);
  gp.prev = { a, b, lb, rb };
}

function gpStart() {
  if (gp.timer) return;
  gp.active = true;
  gp.timer = setInterval(gpPoll, GP_POLL_MS);
}
function gpStop() {
  if ([...navigator.getGamepads()].some((p) => p)) return;
  clearInterval(gp.timer);
  gp.timer = null;
  gp.active = false;
}

window.addEventListener('gamepadconnected', gpStart);
window.addEventListener('gamepaddisconnected', gpStop);

// ── Wire up UI ──────────────────────────────────────────

$('btn-settings').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', closeSettings);
$('btn-test').addEventListener('click', testConnection);
$('btn-save').addEventListener('click', saveSettings);
$('btn-clear-cache').addEventListener('click', async () => {
  await window.r2sd.clearCache();
  $('cfg-test-result').className = 'small success';
  $('cfg-test-result').textContent = 'Cache cleared.';
});
$('btn-quit').addEventListener('click', () => { window.r2sd.quitApp(); });
$('btn-filehandler').addEventListener('click', async () => {
  const btn = $('btn-filehandler');
  const enable = btn.textContent.startsWith('Add');
  btn.disabled = true;
  try {
    const res = await window.r2sd.setFaugusFileHandler(enable);
    if (res.error) toast(res.error, 'error');
    else toast(enable ? 'Added — right-click an .exe and choose Open With' : 'Removed from the file manager', 'success');
    renderFaugusSetting(await window.r2sd.getConfig());
  } finally { btn.disabled = false; }
});
initDropdown('cfg-uiscale', async (value) => { renderUiScale(await window.r2sd.setUiScale(value)); });
initDropdown('cfg-faugus', async (value) => { renderFaugusSetting(await window.r2sd.setConfig({ faugus: value })); });
setDropdownOptions('cfg-faugus', FAUGUS_OPTIONS, 'auto');
initDropdown('cfg-faugusprefix', async (value) => { renderFaugusSetting(await window.r2sd.setConfig({ faugusPrefix: value })); });
setDropdownOptions('cfg-faugusprefix', FAUGUS_PREFIX_OPTIONS, 'per-game');
initDropdown('cfg-cloud', async (value) => { renderFaugusSetting(await window.r2sd.setConfig({ cloudSaves: value })); });
setDropdownOptions('cfg-cloud', CLOUD_OPTIONS, 'off');
initDropdown('cfg-updates', async (value) => { renderUpdateSetting(await window.r2sd.setConfig({ updateCheck: value })); });
initDropdown('cfg-playwindow', async (value) => { renderPlayWindowSetting(await window.r2sd.setConfig({ playWindow: value })); });
initDropdown('cfg-playworkspace', async (value) => { renderPlayWindowSetting(await window.r2sd.setConfig({ playWorkspace: value })); });
setDropdownOptions('cfg-playworkspace', PLAY_WORKSPACE_OPTIONS, 'off');
setDropdownOptions('cfg-playwindow', PLAY_WINDOW_OPTIONS, 'minimize');
setDropdownOptions('cfg-updates', UPDATE_OPTIONS, 'auto');
$('btn-check-updates').addEventListener('click', async () => {
  const btn = $('btn-check-updates');
  btn.disabled = true;
  try {
    const res = await window.r2sd.checkForUpdate();
    if (!res.ok) toast(`Update check failed: ${res.error}`, 'error');
    else if (res.newer) {
      stickyToast(`RomM2SteamDeck ${res.latest} is available (you have ${res.current})`, [
        { label: 'Open release', fn: () => window.r2sd.openReleasePage(res.url) },
        { label: 'Later' },
      ], 'success');
    } else toast(`You're on the latest release (${res.current})`, 'success');
    renderUpdateSetting(await window.r2sd.getConfig());
  } finally { btn.disabled = false; }
});
setDropdownOptions('cfg-uiscale', UI_SCALE_OPTIONS, 'auto');
window.r2sd.onUiScaleChanged(renderUiScale); // keyboard shortcuts change it too
$('btn-add-self-steam').addEventListener('click', async () => {
  const btn = $('btn-add-self-steam');
  const out = $('cfg-test-result');
  btn.disabled = true;
  out.className = 'small';
  out.textContent = 'Adding to Steam…';
  const res = await window.r2sd.addSelfToSteam();
  btn.disabled = false;
  if (res.error) {
    out.className = 'small error';
    out.textContent = res.error;
    return;
  }
  out.className = 'small success';
  // Best case: the Game Mode overlay fix was applied live via SteamClient (Decky/CEF).
  if (res.launchOptionLive) {
    out.textContent = 'Added to Steam and applied the Game Mode fix automatically — launch it any time.';
    return;
  }
  // Otherwise, point to the manual Launch Option (the reliable route when the
  // SteamClient bridge isn't available — Steam reverts direct file edits).
  const tip = ' For Game Mode: in Steam → Properties → Launch Options set  env LD_PRELOAD= %command%';
  if (res.repaired) out.textContent = 'Updated the R2SD Steam shortcut.' + tip;
  else if (res.alreadyPresent) out.textContent = 'RomM2SteamDeck is already in your Steam library.' + tip;
  else if (res.live) out.textContent = 'Added to Steam — it will appear shortly.' + tip;
  else out.textContent = 'Added to Steam — restart Steam to see it.' + tip;
});
$('btn-refresh').addEventListener('click', () => {
  if (state.currentPlatformId !== null) selectPlatform(state.currentPlatformId, true);
  loadPlatforms(true);
});
// Header Exit — shown on Linux, where Game Mode has no window chrome to close.
$('btn-exit').addEventListener('click', () => window.r2sd.quitApp());
window.r2sd.getPlatform().then((p) => { if (p === 'linux') $('btn-exit').hidden = false; });
// Debounced: each keystroke used to rebuild every card immediately, so typing
// a 5-letter word on a 5,000-game platform meant five full grid rebuilds.
let searchTimer = null;
$('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGrid, 120);
});
// Sensible default direction when a sort field is chosen
const SORT_DEFAULT_DIR = { name: 'asc', added: 'desc', size: 'desc', year: 'desc', rating: 'desc', installed: 'desc' };

function updateSortDirButton() {
  const btn = $('btn-sortdir');
  btn.innerHTML = state.sortDir === 'asc' ? '&#9650;' : '&#9660;'; // ▲ / ▼
  btn.title = state.sortDir === 'asc' ? 'Ascending (click for descending)' : 'Descending (click for ascending)';
}

initDropdown('sort', (value) => {
  state.sort = value;
  state.sortDir = SORT_DEFAULT_DIR[state.sort] || 'asc';
  updateSortDirButton();
  renderGrid();
});
setDropdownOptions('sort', [
  { value: 'name', label: 'Name' },
  { value: 'added', label: 'Date Added' },
  { value: 'size', label: 'Size' },
  { value: 'year', label: 'Release Year' },
  { value: 'rating', label: 'Rating' },
  { value: 'installed', label: 'Installed first' },
], state.sort);
$('btn-sortdir').addEventListener('click', () => {
  state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  updateSortDirButton();
  renderGrid();
});
updateSortDirButton();
initDropdown('genre-filter', (value) => {
  state.genre = value;
  renderGrid();
});
$('btn-installed').addEventListener('click', async () => {
  state.installedOnly = !state.installedOnly;
  applyInstalledFilterButton();
  renderGrid();
  renderPlatforms();
  await window.r2sd.setConfig({ installedOnly: state.installedOnly });
});
$('btn-view').addEventListener('click', async () => {
  state.view = state.view === 'list' ? 'grid' : 'list';
  applyView();
  await window.r2sd.setConfig({ view: state.view });
});
$('btn-theme').addEventListener('click', () => { renderThemeGrid(); $('theme-modal').hidden = false; });
$('theme-close').addEventListener('click', () => { $('theme-modal').hidden = true; });
$('theme-backdrop').addEventListener('click', () => { $('theme-modal').hidden = true; });

$('btn-close-detail').addEventListener('click', closeDetail);
$('detail-backdrop').addEventListener('click', closeDetail);
$('btn-dl').addEventListener('click', () => state.detailRom && startDownloadFor(state.detailRom));
$('btn-dl-cancel').addEventListener('click', () => state.detailRom && window.r2sd.cancelDownload(state.detailRom.id));
$('btn-dl-delete').addEventListener('click', () => state.detailRom && deleteDownloadFor(state.detailRom));
$('btn-shortcut').addEventListener('click', () => state.detailRom && openExePicker(state.detailRom));
$('btn-folders').addEventListener('click', () => state.detailRom && openFoldersModal(state.detailRom));
$('folders-close').addEventListener('click', closeFoldersModal);
$('folders-backdrop').addEventListener('click', closeFoldersModal);
$('syncs-close').addEventListener('click', closeSyncsModal);
$('history-close').addEventListener('click', closeHistoryModal);
$('history-backdrop').addEventListener('click', closeHistoryModal);
$('syncs-backdrop').addEventListener('click', closeSyncsModal);
$('syncs-include').addEventListener('change', async (e) => {
  if (!syncsCtx) return;
  await window.r2sd.setIncludeConfig(syncsCtx.rom.id, e.target.checked);
  await renderSyncs();
});
$('syncs-patterns-save').addEventListener('click', async () => {
  const patterns = $('syncs-patterns').value.split('\n').map((s) => s.trim()).filter(Boolean);
  await window.r2sd.setSaveExcludes(patterns);
  toast('Config-file patterns saved', 'success');
  await renderSyncs();
});
$('syncs-patterns-reset').addEventListener('click', async () => {
  await window.r2sd.setSaveExcludes(null);
  toast('Config-file patterns reset to defaults', 'success');
  await renderSyncs();
});
$('syncs-paths-save').addEventListener('click', async () => {
  if (!syncsCtx) return;
  const paths = $('syncs-paths').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const clean = await window.r2sd.setSavePaths(syncsCtx.rom.id, paths);
  toast(clean.length ? `Save locations saved (${clean.length})` : 'Save locations cleared', 'success');
  $('syncs-paths').blur();
  await renderSyncs();
});
$('syncs-paths-detect').addEventListener('click', async () => {
  if (!syncsCtx) return;
  const btn = $('syncs-paths-detect');
  btn.disabled = true; btn.textContent = 'Looking up…';
  try {
    const res = await window.r2sd.detectSavePaths(syncsCtx.rom.id);
    if (!res.ok) toast(res.error, 'error');
    else if (!res.found.length) toast('No known save locations for this game — add them by hand, or restore a save from RomM to learn them', 'error');
    else toast(`Found ${res.found.length} save location${res.found.length === 1 ? '' : 's'}`, 'success');
  } finally { btn.disabled = false; btn.textContent = 'Look up'; }
  $('syncs-paths').blur();
  await renderSyncs();
});
$('exe-cancel').addEventListener('click', closeExePicker);
$('exe-backdrop').addEventListener('click', closeExePicker);
$('installpath-cancel').addEventListener('click', closeInstallPathPicker);
$('installpath-backdrop').addEventListener('click', closeInstallPathPicker);
$('exe-shortcut').addEventListener('click', createShortcut);
$('exe-steam').addEventListener('click', addToSteam);
$('exe-play').addEventListener('click', playFromPicker);
$('exe-setdefault').addEventListener('click', setDefaultFromPicker);
$('exe-clear').addEventListener('click', clearDefaultFromPicker);
$('btn-change-exe').addEventListener('click', () => state.detailRom && openExePicker(state.detailRom));
$('btn-play').addEventListener('click', () => state.detailRom && playGame(state.detailRom));

$('btn-platforms').addEventListener('click', () => { closeSettings(); openPlatformsModal(); });
$('pf-close').addEventListener('click', closePlatformsModal);
$('platforms-backdrop').addEventListener('click', closePlatformsModal);
$('pf-save').addEventListener('click', savePlatformsModal);
$('pf-autofill').addEventListener('click', () => { autofillPlatformFolders(); markDirty(); });
$('pf-base').addEventListener('input', markDirty);
$('pf-staging').addEventListener('input', markDirty);
$('pf-base-browse').addEventListener('click', async () => {
  const picked = await window.r2sd.pickFolder('Base folder for ROMs');
  if (picked) { $('pf-base').value = picked; markDirty(); }
});
$('pf-staging-browse').addEventListener('click', async () => {
  const picked = await window.r2sd.pickFolder('Staging folder for archives');
  if (picked) { $('pf-staging').value = picked; markDirty(); }
});

document.addEventListener('keydown', (e) => {
  // UI scale: Ctrl+= / Ctrl+- step, Ctrl+0 back to Auto (persisted; the
  // Settings dropdown follows via onUiScaleChanged).
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    if (e.key === '=' || e.key === '+') { e.preventDefault(); window.r2sd.stepUiScale(1); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); window.r2sd.stepUiScale(-1); return; }
    if (e.key === '0') { e.preventDefault(); window.r2sd.setUiScale('auto'); return; }
  }
  if (e.key === 'Escape') {
    // Same as the controller's B: an open menu first, then one window at a time
    if (document.querySelector('.dropdown.open')) { closeAllDropdowns(); return; }
    hideContextMenu();
    closeTopModal();
  }
});

// ── Boot ────────────────────────────────────────────────

$('dl-sb-toggle').addEventListener('click', () => {
  const list = $('dl-sb-list');
  list.hidden = !list.hidden;
  $('dl-sb-toggle').innerHTML = list.hidden ? '&#9650;' : '&#9660;';
  $('dl-sb-toggle').title = list.hidden ? 'Show queue' : 'Hide queue';
});

(async function boot() {
  await reloadConfig();
  await reloadDownloads();
  try {
    const q = await window.r2sd.getQueue();
    state.queue = q.items || [];
    renderQueueBar();
  } catch { /* no queue yet */ }
  const configured = await window.r2sd.isConfigured();
  if (!configured) {
    openSettings();
    return;
  }
  await loadPlatforms();
})();
