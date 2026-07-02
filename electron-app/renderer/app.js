/* Renderer logic — talks to the main process only through window.r2sd (preload bridge). */

const $ = (id) => document.getElementById(id);

const state = {
  config: null,        // PublicConfig incl. platform setups
  platforms: [],
  roms: [],
  currentPlatformId: null,
  search: '',
  sort: 'name',
  genre: '',
  pinned: [],
  downloads: new Map(), // romId -> DownloadRecord
  progress: new Map(),  // romId -> latest download:event payload
  detailRom: null,
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

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
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
  const file = await window.r2sd.getAsset(romId, serverPath);
  if (file) img.src = 'file:///' + file.replace(/\\/g, '/');
}

async function reloadConfig() {
  state.config = await window.r2sd.getConfig();
  state.pinned = state.config.pinnedPlatforms || [];
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

  for (const p of platforms) {
    const isPinned = state.pinned.includes(p.id);
    const btn = document.createElement('button');
    btn.className = 'platform-item' + (p.id === state.currentPlatformId ? ' active' : '');
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
    count.textContent = p.rom_count;

    btn.append(pin, name, count);
    list.appendChild(btn);
  }
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
  if (state.genre) {
    roms = roms.filter((r) => romGenres(r).includes(state.genre));
  }
  const sorted = [...roms];
  const byName = (a, b) => (a.name || a.fs_name || '').localeCompare(b.name || b.fs_name || '');
  if (state.sort === 'size') {
    sorted.sort((a, b) => (b.fs_size_bytes || 0) - (a.fs_size_bytes || 0));
  } else if (state.sort === 'year') {
    sorted.sort((a, b) => (romYear(b) || 0) - (romYear(a) || 0) || byName(a, b));
  } else if (state.sort === 'rating') {
    sorted.sort((a, b) => (romRating(b) || 0) - (romRating(a) || 0) || byName(a, b));
  } else {
    sorted.sort(byName);
  }
  return sorted;
}

function updateGenreFilter() {
  const select = $('genre-filter');
  const genres = new Set();
  for (const rom of state.roms) for (const g of romGenres(rom)) genres.add(g);
  const current = state.genre;
  select.innerHTML = '<option value="">All genres</option>';
  for (const g of [...genres].sort()) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g;
    select.appendChild(opt);
  }
  select.value = genres.has(current) ? current : '';
  state.genre = select.value;
  select.style.display = genres.size ? '' : 'none';
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
  return document.querySelector(`.cover-wrap[data-rom-id="${romId}"]`);
}

/** Add/update/remove the progress bar overlay on a game card. */
function updateCardProgress(romId) {
  const wrap = coverWrapFor(romId);
  if (!wrap) return;
  const progress = state.progress.get(romId);
  let bar = wrap.querySelector('.dl-bar');
  if (!progress) {
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
  const pct = progress.percent ?? 0;
  bar.classList.toggle('indeterminate', progress.status === 'starting' || (progress.status === 'extracting' && !progress.percent));
  bar.querySelector('.dl-bar-fill').style.width = `${pct}%`;
}

function updateCardBadge(romId) {
  const wrap = coverWrapFor(romId);
  if (!wrap) return;
  let badge = wrap.querySelector('.dl-badge');
  if (state.downloads.has(romId)) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'dl-badge';
      badge.title = 'Installed — ready to play';
      badge.textContent = '▶';
      wrap.appendChild(badge);
    }
  } else {
    badge?.remove();
  }
}

function renderGrid() {
  const grid = $('game-grid');
  coverObserver.disconnect();
  grid.innerHTML = '';

  const roms = visibleRoms();
  $('grid-status').hidden = roms.length > 0;
  $('grid-status').textContent = state.roms.length
    ? 'No games match your filters.'
    : 'No games on this platform.';

  const frag = document.createDocumentFragment();
  for (const rom of roms) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.title = rom.fs_name || rom.name || '';
    card.addEventListener('click', () => openDetail(rom));

    const wrap = document.createElement('div');
    wrap.className = 'cover-wrap';
    wrap.dataset.romId = rom.id;
    wrap.dataset.coverPath = rom.path_cover_large || rom.path_cover_small || '';
    const img = document.createElement('img');
    img.className = 'game-cover';
    img.alt = '';
    wrap.appendChild(img);
    coverObserver.observe(wrap);

    if (state.downloads.has(rom.id)) {
      const badge = document.createElement('div');
      badge.className = 'dl-badge';
      badge.title = 'Installed — ready to play';
      badge.textContent = '▶';
      wrap.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'game-meta';
    const name = document.createElement('div');
    name.className = 'game-name';
    name.textContent = rom.name || rom.fs_name || 'Unknown';
    const size = document.createElement('div');
    size.className = 'game-size';
    const year = romYear(rom);
    size.textContent = [formatSize(rom.fs_size_bytes), year].filter(Boolean).join(' · ');
    meta.append(name, size);

    card.append(wrap, meta);
    frag.appendChild(card);
  }
  grid.appendChild(frag);

  // Restore progress overlays for in-flight downloads
  for (const romId of state.progress.keys()) updateCardProgress(romId);

  // Re-apply the gamepad focus ring after a re-render
  if (gp.active && gp.index >= 0) gpSetFocus(gp.index);
}

async function selectPlatform(platformId, refresh = false) {
  state.currentPlatformId = platformId;
  const platform = state.platforms.find((p) => p.id === platformId);
  $('platform-title').textContent = platform ? platform.name : 'Library';
  renderPlatforms();

  $('grid-status').hidden = false;
  $('grid-status').textContent = 'Loading…';
  $('game-grid').innerHTML = '';
  state.roms = [];

  try {
    const result = await window.r2sd.getRoms(platformId, { refresh });
    if (state.currentPlatformId !== platformId) return;
    state.roms = result.roms;
    setCacheStatus(result.fromCache, result.fetchedAt);
    updateGenreFilter();
    renderGrid();

    // Reconcile download records with what's actually on disk
    const changes = await window.r2sd.syncDownloads(platformId);
    await reloadDownloads();
    if (changes.added || changes.removed) {
      toast(`Library sync: ${changes.added} adopted, ${changes.removed} removed`);
    }
    for (const rom of state.roms) updateCardBadge(rom.id);
  } catch (err) {
    $('grid-status').textContent = `Failed to load games: ${err.message || err}`;
  }
}

// Progressive pages during a cold (uncached) load → render as they arrive
window.r2sd.onRomsProgress(({ platformId, page, loaded, total }) => {
  if (platformId !== state.currentPlatformId) return;
  state.roms.push(...page);
  updateGenreFilter();
  renderGrid();
  $('grid-status').hidden = false;
  $('grid-status').textContent = loaded < total
    ? `Loading library from server (first time only)… ${loaded} / ${total}`
    : '';
  if (loaded >= total) $('grid-status').hidden = true;
});

window.r2sd.onPlatformsUpdated(({ data, fetchedAt }) => {
  state.platforms = data;
  setCacheStatus(false, fetchedAt);
  renderPlatforms();
});

window.r2sd.onRomsUpdated(({ platformId, data, fetchedAt }) => {
  if (platformId !== state.currentPlatformId) return;
  state.roms = data;
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
    const rom = state.roms.find((r) => r.id === romId);
    const name = rom?.name || `ROM ${romId}`;
    if (status === 'complete') toast(`${name} downloaded`, 'success');
    if (status === 'extracted') toast(`${name} downloaded and installed`, 'success');
    if (status === 'error') toast(`${name}: ${event.message}`, 'error');
    if (status === 'cancelled') toast(`${name} cancelled`);
  } else {
    state.progress.set(romId, event);
  }

  updateCardProgress(romId);
  if (state.detailRom?.id === romId) refreshDetailActions();
});

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
  } else {
    toast(`Deleted ${rom.name || rom.fs_name}`, 'success');
  }
  await reloadDownloads();
  updateCardBadge(rom.id);
  refreshDetailActions();
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

  dlBtn.hidden = Boolean(progress || record);
  cancelBtn.hidden = !progress;
  deleteBtn.hidden = !record || Boolean(progress);
  // Shortcut maker: only for installed (extracted) PC games
  shortcutBtn.hidden = !(record && setup.autoExtract && !progress);
  bar.hidden = !progress;

  if (progress) {
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
  $('exe-shortcut').disabled = true;
  $('exe-steam').disabled = true;
  $('exe-list').innerHTML = '<p class="muted small">Scanning for executables…</p>';

  // Native "Add to Steam" only shown when a Steam install is found; the
  // "right-click → Add to Steam" tip is the Linux/Deck manual fallback.
  const [platform, steam] = await Promise.all([window.r2sd.getPlatform(), window.r2sd.steamStatus()]);
  $('exe-steam').hidden = !steam.found;
  $('exe-steamdeck-tip').hidden = !(platform === 'linux' && !steam.found);
  $('exe-modal').hidden = false;

  const exes = await window.r2sd.listExes(rom.id);
  if (!exes.length) {
    $('exe-list').innerHTML = '<p class="error small">No .exe files found in the installed folder.</p>';
    return;
  }
  $('exe-list').innerHTML = '';
  exes.forEach((exe, i) => {
    const label = document.createElement('label');
    label.className = 'exe-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'exe';
    radio.value = String(i);
    radio.addEventListener('change', () => {
      exeSelected = exe;
      $('exe-shortcut').disabled = false;
      $('exe-steam').disabled = false;
      document.querySelectorAll('.exe-option').forEach((el, j) => el.classList.toggle('selected', j === i));
    });
    const span = document.createElement('span');
    span.textContent = exe.relativePath;
    label.append(radio, span);
    $('exe-list').appendChild(label);
  });
}

function closeExePicker() {
  $('exe-modal').hidden = true;
  exePickerRom = null;
  exeSelected = null;
}

async function createShortcut() {
  if (!exeSelected || !exePickerRom) return;
  const res = await window.r2sd.createShortcut(exeSelected.path, exePickerRom.name || exePickerRom.fs_name);
  closeExePicker();
  if (res.error) toast(res.error, 'error');
  else toast('Desktop shortcut created', 'success');
}

async function addToSteam() {
  if (!exeSelected || !exePickerRom) return;
  const res = await window.r2sd.addToSteam(exeSelected.path, exePickerRom.name || exePickerRom.fs_name);
  if (res.error) {
    // Keep the picker open (e.g. Steam is running → user needs to quit it first)
    toast(res.error, 'error');
    return;
  }
  closeExePicker();
  if (res.alreadyPresent) toast('Already in your Steam library', 'success');
  else toast('Added to Steam — restart Steam to see it in your library', 'success');
}

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

    // Install-path field: used only when extracting
    const installRow = document.createElement('span');
    installRow.className = 'path-row';
    const installInput = document.createElement('input');
    installInput.type = 'text';
    installInput.className = 'pf-install';
    installInput.placeholder = 'Install path — extracted game folders go here';
    installInput.value = setup.installPaths[0] || '';
    installInput.addEventListener('input', markDirty);
    const installBrowse = document.createElement('button');
    installBrowse.className = 'icon-btn';
    installBrowse.innerHTML = '&#128193;';
    installBrowse.title = 'Browse';
    installBrowse.addEventListener('click', async () => {
      const picked = await window.r2sd.pickFolder(`Install path for ${p.name}`);
      if (picked) { installInput.value = picked; markDirty(); }
    });
    installRow.append(installInput, installBrowse);
    paths.appendChild(installRow);

    const extract = document.createElement('label');
    extract.className = 'pf-extract';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pf-autoextract';
    check.checked = setup.autoExtract;
    // Show only the field that applies to this platform's mode
    const applyMode = () => {
      folderRow.style.display = check.checked ? 'none' : '';
      installRow.style.display = check.checked ? '' : 'none';
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
  const platforms = {};
  for (const row of document.querySelectorAll('.pf-row')) {
    const id = row.dataset.platformId;
    platforms[id] = {
      folder: row.querySelector('.pf-folder').value.trim(),
      autoExtract: row.querySelector('.pf-autoextract').checked,
      installPaths: [row.querySelector('.pf-install').value.trim()].filter(Boolean),
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

async function openSettings() {
  const cfg = await window.r2sd.getConfig();
  window.r2sd.getVersion().then((v) => { $('cfg-version').textContent = v ? `v${v}` : ''; });
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
    password: $('cfg-password').value,
  });
  await reloadConfig();
  closeSettings();
  state.currentPlatformId = null;
  await loadPlatforms(true);
}

// ── Gamepad navigation (Steam Deck / controllers) ───────

const gp = { index: -1, raf: null, prev: {}, lastMove: 0, active: false };

function gpCards() {
  return [...document.querySelectorAll('#game-grid .game-card')];
}

function gpColumns() {
  const cols = getComputedStyle($('game-grid')).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, cols);
}

function gpSetFocus(i) {
  const cards = gpCards();
  if (!cards.length) { gp.index = -1; return; }
  gp.index = Math.max(0, Math.min(i, cards.length - 1));
  cards.forEach((c, j) => c.classList.toggle('gp-focus', j === gp.index));
  cards[gp.index].scrollIntoView({ block: 'nearest' });
}

function gpMove(dir) {
  const cards = gpCards();
  if (!cards.length) return;
  if (gp.index < 0) { gpSetFocus(0); return; }
  const cols = gpColumns();
  let i = gp.index;
  if (dir === 'left') i -= 1;
  else if (dir === 'right') i += 1;
  else if (dir === 'up') i -= cols;
  else if (dir === 'down') i += cols;
  if (i >= 0 && i < cards.length) gpSetFocus(i);
}

function gpActivate() {
  const cards = gpCards();
  if (gp.index >= 0 && cards[gp.index]) cards[gp.index].click();
}

function anyModalOpen() {
  return [...document.querySelectorAll('.modal')].some((m) => !m.hidden);
}

function gpBack() {
  closeExePicker();
  closeDetail();
  closeSettings();
  closePlatformsModal();
}

function gpPoll() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = [...pads].find((p) => p);
  if (pad) {
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

    if (!anyModalOpen() && now - gp.lastMove > 160) {
      let moved = true;
      if (up) gpMove('up');
      else if (down) gpMove('down');
      else if (left) gpMove('left');
      else if (right) gpMove('right');
      else moved = false;
      if (moved) gp.lastMove = now;
    }

    // Edge-triggered A/B
    if (a && !gp.prev.a) {
      if (anyModalOpen()) {
        const dl = $('btn-dl');
        if (!$('detail-modal').hidden && dl && !dl.hidden) dl.click();
      } else {
        gpActivate();
      }
    }
    if (b && !gp.prev.b && anyModalOpen()) gpBack();
    gp.prev = { a, b };
  }
  gp.raf = requestAnimationFrame(gpPoll);
}

function gpStart() {
  if (gp.raf) return;
  gp.active = true;
  gpPoll();
}
function gpStop() {
  if ([...navigator.getGamepads()].some((p) => p)) return;
  cancelAnimationFrame(gp.raf);
  gp.raf = null;
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
$('genre-filter').addEventListener('change', (e) => {
  state.genre = e.target.value;
  renderGrid();
});

$('btn-close-detail').addEventListener('click', closeDetail);
$('detail-backdrop').addEventListener('click', closeDetail);
$('btn-dl').addEventListener('click', () => state.detailRom && startDownloadFor(state.detailRom));
$('btn-dl-cancel').addEventListener('click', () => state.detailRom && window.r2sd.cancelDownload(state.detailRom.id));
$('btn-dl-delete').addEventListener('click', () => state.detailRom && deleteDownloadFor(state.detailRom));
$('btn-shortcut').addEventListener('click', () => state.detailRom && openExePicker(state.detailRom));
$('exe-cancel').addEventListener('click', closeExePicker);
$('exe-backdrop').addEventListener('click', closeExePicker);
$('exe-shortcut').addEventListener('click', createShortcut);
$('exe-steam').addEventListener('click', addToSteam);

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
  if (e.key === 'Escape') {
    closeExePicker();
    closeDetail();
    closeSettings();
    closePlatformsModal();
  }
});

// ── Boot ────────────────────────────────────────────────

(async function boot() {
  await reloadConfig();
  await reloadDownloads();
  const configured = await window.r2sd.isConfigured();
  if (!configured) {
    openSettings();
    return;
  }
  await loadPlatforms();
})();
