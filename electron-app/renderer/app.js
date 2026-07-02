/* Renderer logic — talks to the main process only through window.r2sd (preload bridge). */

const $ = (id) => document.getElementById(id);

const state = {
  platforms: [],
  roms: [],
  currentPlatformId: null,
  search: '',
  sort: 'name',
};

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

function setCacheStatus(fromCache, fetchedAt) {
  $('cache-status').textContent = fromCache
    ? `Cached ${formatAge(fetchedAt)} — refreshing…`
    : `Up to date`;
}

// ── Platforms ───────────────────────────────────────────

function renderPlatforms() {
  const list = $('platform-list');
  list.innerHTML = '';
  const withGames = state.platforms
    .filter((p) => (p.rom_count || 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!withGames.length) {
    list.innerHTML = '<p class="muted pad">No platforms found.</p>';
    return;
  }

  for (const p of withGames) {
    const btn = document.createElement('button');
    btn.className = 'platform-item' + (p.id === state.currentPlatformId ? ' active' : '');
    btn.addEventListener('click', () => selectPlatform(p.id));

    const name = document.createElement('span');
    name.textContent = p.name;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = p.rom_count;

    btn.append(name, count);
    list.appendChild(btn);
  }
}

async function loadPlatforms(refresh = false) {
  try {
    const result = await window.r2sd.getPlatforms({ refresh });
    state.platforms = result.platforms;
    setCacheStatus(result.fromCache, result.fetchedAt);
    renderPlatforms();

    // Auto-select first platform on initial load
    if (state.currentPlatformId === null) {
      const first = state.platforms
        .filter((p) => (p.rom_count || 0) > 0)
        .sort((a, b) => a.name.localeCompare(b.name))[0];
      if (first) selectPlatform(first.id);
    }
  } catch (err) {
    $('platform-list').innerHTML = `<p class="error pad">Failed to load platforms.<br>${err.message || err}</p>`;
  }
}

// ── Games ───────────────────────────────────────────────

function visibleRoms() {
  let roms = state.roms;
  if (state.search) {
    const q = state.search.toLowerCase();
    roms = roms.filter((r) => (r.name || r.fs_name || '').toLowerCase().includes(q));
  }
  const sorted = [...roms];
  if (state.sort === 'size') {
    sorted.sort((a, b) => (b.fs_size_bytes || 0) - (a.fs_size_bytes || 0));
  } else {
    sorted.sort((a, b) => (a.name || a.fs_name || '').localeCompare(b.name || b.fs_name || ''));
  }
  return sorted;
}

// Lazy cover loading: only fetch covers for cards that scroll into view.
// Observes the fixed-size wrapper (the img inside starts hidden).
const coverObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const wrap = entry.target;
      coverObserver.unobserve(wrap);
      const romId = Number(wrap.dataset.romId);
      const serverPath = wrap.dataset.coverPath;
      if (!serverPath) continue;
      window.r2sd.getCover(romId, serverPath).then((file) => {
        if (file) wrap.querySelector('img').src = 'file:///' + file.replace(/\\/g, '/');
      });
    }
  },
  { root: $('game-grid'), rootMargin: '400px' }
);

function renderGrid() {
  const grid = $('game-grid');
  coverObserver.disconnect();
  grid.innerHTML = '';

  const roms = visibleRoms();
  $('grid-status').hidden = roms.length > 0;
  $('grid-status').textContent = state.roms.length
    ? 'No games match your search.'
    : 'No games on this platform.';

  const frag = document.createDocumentFragment();
  for (const rom of roms) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.title = rom.fs_name || rom.name || '';

    const wrap = document.createElement('div');
    wrap.className = 'cover-wrap';
    wrap.dataset.romId = rom.id;
    wrap.dataset.coverPath = rom.path_cover_large || rom.path_cover_small || '';
    const img = document.createElement('img');
    img.className = 'game-cover';
    img.alt = '';
    wrap.appendChild(img);
    coverObserver.observe(wrap);

    const meta = document.createElement('div');
    meta.className = 'game-meta';
    const name = document.createElement('div');
    name.className = 'game-name';
    name.textContent = rom.name || rom.fs_name || 'Unknown';
    const size = document.createElement('div');
    size.className = 'game-size';
    size.textContent = formatSize(rom.fs_size_bytes);
    meta.append(name, size);

    card.append(wrap, meta);
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

async function selectPlatform(platformId, refresh = false) {
  state.currentPlatformId = platformId;
  const platform = state.platforms.find((p) => p.id === platformId);
  $('platform-title').textContent = platform ? platform.name : 'Library';
  renderPlatforms();

  $('grid-status').hidden = false;
  $('grid-status').textContent = 'Loading…';
  $('game-grid').innerHTML = '';
  state.roms = []; // progress events accumulate here during a cold load

  try {
    const result = await window.r2sd.getRoms(platformId, { refresh });
    if (state.currentPlatformId !== platformId) return; // user moved on
    state.roms = result.roms;
    setCacheStatus(result.fromCache, result.fetchedAt);
    renderGrid();
  } catch (err) {
    $('grid-status').textContent = `Failed to load games: ${err.message || err}`;
  }
}

// Progressive pages during a cold (uncached) load → render as they arrive
window.r2sd.onRomsProgress(({ platformId, page, loaded, total }) => {
  if (platformId !== state.currentPlatformId) return;
  state.roms.push(...page);
  renderGrid();
  $('grid-status').hidden = false;
  $('grid-status').textContent = loaded < total
    ? `Loading library from server (first time only)… ${loaded} / ${total}`
    : '';
  if (loaded >= total) $('grid-status').hidden = true;
});

// Background refreshes landing → update silently
window.r2sd.onPlatformsUpdated(({ data, fetchedAt }) => {
  state.platforms = data;
  setCacheStatus(false, fetchedAt);
  renderPlatforms();
});

window.r2sd.onRomsUpdated(({ platformId, data, fetchedAt }) => {
  if (platformId !== state.currentPlatformId) return;
  state.roms = data;
  setCacheStatus(false, fetchedAt);
  renderGrid();
});

// ── Settings ────────────────────────────────────────────

async function openSettings() {
  const cfg = await window.r2sd.getConfig();
  $('cfg-url').value = cfg.baseUrl;
  $('cfg-username').value = cfg.username;
  $('cfg-password').value = '';
  $('cfg-password').placeholder = cfg.hasPassword ? '(unchanged)' : '';
  $('cfg-test-result').textContent = '';
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
  if (res.ok) {
    result.className = 'small success';
    result.textContent = `Connected — RomM ${res.version || '(version unknown)'}`;
  } else {
    result.className = 'small error';
    result.textContent = res.error || 'Connection failed';
  }
}

async function saveSettings() {
  await window.r2sd.setConfig({
    baseUrl: $('cfg-url').value,
    username: $('cfg-username').value,
    password: $('cfg-password').value, // empty string keeps existing
  });
  closeSettings();
  state.currentPlatformId = null;
  await loadPlatforms(true);
}

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
$('btn-refresh').addEventListener('click', () => {
  if (state.currentPlatformId !== null) selectPlatform(state.currentPlatformId, true);
  loadPlatforms(true);
});
$('search').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderGrid();
});
$('sort').addEventListener('change', (e) => {
  state.sort = e.target.value;
  renderGrid();
});

// ── Boot ────────────────────────────────────────────────

(async function boot() {
  const configured = await window.r2sd.isConfigured();
  if (!configured) {
    openSettings();
    return;
  }
  await loadPlatforms();
})();
