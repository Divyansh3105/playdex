const STORES = { steam: 'Steam', epic: 'Epic', gog: 'GOG' };
const byStore = (a, b) => Object.keys(STORES).indexOf(a.store) - Object.keys(STORES).indexOf(b.store); // always Steam, Epic, GOG
const TABS = ['library', 'dups', 'disk', 'stats']; // in order: keys 1–4
const state = { tab: 'library', q: '', stores: new Set(Object.keys(STORES)), show: 'all', sort: 'name' };
try { if (localStorage.sort in { name: 1, recent: 1, playtime: 1, installed: 1 }) state.sort = localStorage.sort; } catch { /* storage unavailable */ }
/** @type {ScanResult} */
let data = /** @type {any} */ (null); // set by load() before anything reads it
let playedKeys = new Set(); // keys of games played on any store, so a copy of a game you played elsewhere isn't "not played"
let visible = [], lastPick = null; // the Library list on screen, for "What should I play?"

// ---------- favorites, hidden, tags ----------
// Saved by the main process (which validates them); keyed by game id, i.e. one store's copy.
let prefs = { favorites: new Set(), hidden: new Set(), tags: new Map() };
const toPrefs = p => ({ favorites: new Set(p.favorites), hidden: new Set(p.hidden), tags: new Map(Object.entries(p.tags)) });
async function savePrefs() {
  try {
    prefs = toPrefs(await window.library.savePrefs({
      favorites: [...prefs.favorites], hidden: [...prefs.hidden], tags: Object.fromEntries(prefs.tags),
    }));
  } catch { toast('Could not save your change.'); }
  render();
}
const allTags = () => [...new Set([...prefs.tags.values()].flat())].sort((a, b) => a.localeCompare(b));

/** What the Show menu lets through. Hidden games only appear under Show → Hidden. */
function shown(g) {
  if (state.show === 'hidden') return prefs.hidden.has(g.id);
  if (prefs.hidden.has(g.id)) return false;
  if (state.show === 'installed') return g.installed;
  if (state.show === 'favorites') return prefs.favorites.has(g.id);
  if (state.show === 'unplayed') return notPlayed(g);
  if (state.show.startsWith('tag:')) return prefs.tags.get(g.id)?.includes(state.show.slice(4)) ?? false;
  return true;
}

function renderShowMenu() {
  const count = test => data.games.filter(test).length;
  const options = [['all', 'All games'], ['installed', `Installed (${count(g => g.installed)})`],
    ['unplayed', `Not played (${count(g => notPlayed(g) && !prefs.hidden.has(g.id))})`],
    ['favorites', `Favorites (${count(g => prefs.favorites.has(g.id))})`], ['hidden', `Hidden (${count(g => prefs.hidden.has(g.id))})`]];
  const tags = allTags().map(t => [`tag:${t}`, `${t} (${count(g => prefs.tags.get(g.id)?.includes(t))})`]);
  if (![...options, ...tags].some(([v]) => v === state.show)) state.show = 'all'; // e.g. its last tag was removed
  const opt = ([value, label]) => el('option', { value, textContent: label });
  $('show').replaceChildren(...options.map(opt), ...(tags.length ? [el('optgroup', { label: 'Tags' }, ...tags.map(opt))] : []));
  $('show').value = state.show;
}

/** Favorite / hide buttons and the tag editor in the details window. */
function prefsControls(g) {
  const box = el('div', { className: 'mine' });
  const draw = () => {
    const tags = prefs.tags.get(g.id) ?? [];
    const toggle = (kind, on, label) => {
      const b = el('button', { className: 'toggle-btn', textContent: label, onclick: async () => {
        on ? prefs[kind].delete(g.id) : prefs[kind].add(g.id); // prefs[kind]: savePrefs() replaces the sets
        await savePrefs(); draw();
      } });
      b.setAttribute('aria-pressed', on);
      return b;
    };
    const full = tags.length >= 20;
    const input = el('input', { className: 'tag-input', maxLength: 32, disabled: full, placeholder: full ? 'Tag limit reached' : 'Add a tag…', ariaLabel: 'Add a tag' });
    input.setAttribute('list', 'tag-suggestions');
    input.onkeydown = async e => {
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const t = input.value.trim();
      if (!t || tags.includes(t)) { input.value = ''; return; }
      prefs.tags.set(g.id, [...tags, t]);
      await savePrefs(); draw();
      box.querySelector('.tag-input')?.focus();
    };
    const remove = t => async () => {
      const rest = tags.filter(x => x !== t);
      rest.length ? prefs.tags.set(g.id, rest) : prefs.tags.delete(g.id);
      await savePrefs(); draw();
    };
    const fav = prefs.favorites.has(g.id), hidden = prefs.hidden.has(g.id);
    box.replaceChildren(
      el('div', { className: 'mine-row' },
        toggle('favorites', fav, fav ? '★ Favorite' : '☆ Favorite'),
        toggle('hidden', hidden, hidden ? 'Hidden · Unhide' : 'Hide from library')),
      el('div', { className: 'tags' },
        ...tags.map(t => el('span', { className: 'tag' }, t, el('button', { textContent: '×', ariaLabel: `Remove tag ${t}`, title: 'Remove tag', onclick: remove(t) }))),
        input),
      el('datalist', { id: 'tag-suggestions' }, ...allTags().filter(t => !tags.includes(t)).map(t => el('option', { value: t }))));
  };
  draw();
  return box;
}

/** @type {{ (id: 'details'): HTMLDialogElement, (id: 'q'): HTMLInputElement, (id: 'sort' | 'show'): HTMLSelectElement, (id: 'pick'): HTMLButtonElement, (id: string): HTMLElement }} */
const $ = /** @type {any} */ (id => document.getElementById(id));
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null));
  return e;
};

let toastTimer;
function toast(msg, ms = 2500) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), ms);
}

async function launch(g) {
  $('details').close(); // toasts can't show above an open modal
  const ok = await window.library.launch(g.id);
  toast(ok ? `Opening ${g.title} in ${STORES[g.store]}…` : 'Could not launch. Try Rescan.');
}

function cover(g) {
  const ph = el('div', { className: 'ph', textContent: g.title });
  if (!g.cover) return ph;
  const img = el('img', { src: g.cover, alt: '', loading: 'lazy' });
  img.onerror = () => { if (g.fallback && img.src !== g.fallback) img.src = g.fallback; else img.replaceWith(ph); };
  return img;
}

const actionLabel = g => g.installed ? '▶ Play' : g.store === 'gog' ? 'Open in GOG Galaxy' : '⬇ Install';

// ---------- playtime ----------
// playtime: minutes; 0 = store tracks it but never played; null = store doesn't tell us (Epic).
const hours = m => (m < 1 ? '< 1 min' : m < 60 ? `${m} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`);
const hoursLong = m => (m < 60 ? hours(m) : `${Math.floor(m / 60)} h ${m % 60} min`);
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function ago(ms) {
  const days = Math.round((ms - Date.now()) / 864e5);
  if (Math.abs(days) < 31) return rtf.format(days, 'day');
  if (Math.abs(days) < 365) return rtf.format(Math.round(days / 30.4), 'month');
  return rtf.format(Math.round(days / 365), 'year');
}
const played = g => g.playtime > 0 || g.lastPlayed;
const notPlayed = g => g.playtime != null && !playedKeys.has(g.key); // Epic (unknown playtime) never counts as not played
const playLine = g => g.playtime == null ? '' : !played(g) ? 'Not played' : [hours(g.playtime), g.lastPlayed && ago(g.lastPlayed)].filter(Boolean).join(' · ');

// Scan order is A–Z, and sort() is stable, so ties stay alphabetical. Unknown playtime (Epic) sorts last.
const SORTS = {
  name: null,
  recent: (a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0),
  playtime: (a, b) => (b.playtime ?? -1) - (a.playtime ?? -1),
  installed: (a, b) => b.installed - a.installed,
};

// ---------- details window ----------
// Opens instantly with what the scan knows; the description fills in when it arrives.
async function openDetails(g) {
  const dlg = $('details');
  dlg.dataset.id = g.id; // a slow answer for a game you've since closed must not overwrite the current one
  const copies = data.games.filter(x => x.key === g.key).sort(byStore); // same game on other stores
  const body = el('div', { className: 'body' }, el('p', { className: 'loading', textContent: 'Loading details…' }));
  $('details-content').replaceChildren(
    el('div', { className: 'art' }, cover(g)),
    el('div', { className: 'info' },
      el('h2', { id: 'details-title', textContent: g.title }),
      el('div', { className: 'stores' }, ...copies.map(c => el('button', {
        className: `play ${c.store}`, textContent: `${actionLabel(c)} · ${STORES[c.store]}`, onclick: () => launch(c),
      }))),
      prefsControls(g),
      body));
  if (!dlg.open) dlg.showModal();

  const d = await window.library.details(g.id).catch(() => null);
  if (dlg.dataset.id !== g.id || !dlg.open) return;
  const date = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/ (\d{4})$/, ', $1');
  const facts = [
    ['Playtime', g.playtime == null ? `Not tracked by ${STORES[g.store]}` : played(g) ? hoursLong(g.playtime) : 'Not played'],
    ['Last played', g.lastPlayed && `${date(g.lastPlayed)} (${ago(g.lastPlayed)})`],
    ['Size on disk', g.installed && `${fmtBytes(g.size)}${g.drive ? ` on ${g.drive}` : ''}`],
    ['Developer', d?.developers], ['Publisher', d?.publishers], ['Released', d?.released], ['Genres', d?.genres],
  ].filter(([, v]) => v?.length).map(([k, v]) => {
    const list = [].concat(v); // GOG can list every regional distributor as a publisher
    const text = list.slice(0, 3).join(', ') + (list.length > 3 ? ` +${list.length - 3} more` : '');
    return el('div', {}, el('dt', { textContent: k }), el('dd', { textContent: text, title: list.join(', ') }));
  });
  body.replaceChildren(...[
    facts.length ? el('dl', {}, ...facts) : null,
    el('p', { className: 'desc', textContent: d?.description ?? (d?.offline ? 'Could not load a description (offline?).' : 'No description available.') }),
    d?.source ? el('p', { className: 'source', textContent: d.source }) : null,
  ].filter(Boolean));
}

const card = g => el('button', { className: 'card', title: `${g.title} (${STORES[g.store]})`, onclick: () => openDetails(g) },
  cover(g),
  el('span', { className: 'action', textContent: 'Details' }),
  el('span', { className: 'meta' },
    prefs.favorites.has(g.id) ? el('span', { className: 'fav', textContent: '★', title: 'Favorite' }) : null,
    el('span', { className: 'name', textContent: g.title }),
    g.installed ? el('span', { className: 'dot', title: 'Installed' }) : null,
    el('span', { className: `badge ${g.store}`, textContent: STORES[g.store] })),
  el('span', { className: 'sub', textContent: playLine(g) }));

const dupRow = d => el('div', { className: 'dup' },
  cover(d.games.find(g => g.cover) ?? d.games[0]),
  el('div', {},
    el('h3', {}, el('button', { className: 'link', textContent: d.title, title: 'Show details', onclick: () => openDetails(d.games[0]) })),
    el('div', { className: 'stores' }, ...d.games.toSorted(byStore).map(g => el('button', {
      className: `badge ${g.store}${g.installed ? ' installed' : ''}`,
      title: `${actionLabel(g)} via ${STORES[g.store]}`,
      textContent: STORES[g.store] + (g.installed ? ' · installed' : ''),
      onclick: () => launch(g),
    })))));

// ---------- disk space ----------
// Binary units, like Windows Explorer, so drive numbers match what Windows shows.
const fmtBytes = b => (b == null ? 'size unknown' : b >= 2 ** 40 ? `${(b / 2 ** 40).toFixed(2)} TB`
  : b >= 2 ** 30 ? `${(b / 2 ** 30).toFixed(1)} GB` : `${b > 0 ? Math.max(1, Math.round(b / 2 ** 20)) : 0} MB`);
const sum = list => list.reduce((t, g) => t + (g.size ?? 0), 0);
const bar = (...parts) => el('div', { className: 'bar' }, // parts: [className, fraction 0..1, tooltip]
  ...parts.map(([cls, f, tip]) => { const s = el('span', { className: cls, title: tip }); s.style.width = `${Math.max(0, Math.min(1, f)) * 100}%`; return s; }));

// A row in the Disk space and Stats lists. The whole row opens the details; the title is a button for the keyboard.
const listRow = (g, value, fraction, ...rest) => el('div', { className: 'diskrow', title: 'Show details', onclick: () => openDetails(g) },
  cover(g),
  el('span', { className: 'title' }, el('button', { className: 'link', textContent: g.title }), el('span', { className: `badge ${g.store}`, textContent: STORES[g.store] })),
  bar(['games', fraction]),
  el('span', { className: 'size', textContent: value }),
  ...rest);

// The store does the uninstalling and asks first; Epic and GOG Galaxy only open where the button is.
const UNINSTALL_HINT = {
  steam: 'Steam will ask you to confirm.',
  epic: 'Your Epic library is opening: click ⋯ on the game, then Uninstall.',
  gog: 'GOG Galaxy is opening the game: click the settings icon next to Play, then Manage installation → Uninstall.',
};
async function uninstall(g) {
  const ok = await window.library.uninstall(g.id).catch(() => false);
  toast(ok ? `${g.title}: ${UNINSTALL_HINT[g.store]}` : 'Could not open the uninstaller. Try Rescan.', 7000);
}
const uninstallButton = g => (g.uninstall ? el('button', { className: 'uninstall', textContent: 'Uninstall…',
  title: `Uninstall with ${STORES[g.store]}`, onclick: e => { e.stopPropagation(); uninstall(g); } }) : el('span'));

function diskView(match) {
  const { games, drives } = data;
  const installed = games.filter(g => g.installed);
  const shown = installed.filter(match).sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
  if (!installed.length) return [el('p', { className: 'empty', textContent: 'No installed games found.' })];

  const driveCards = drives.map(d => {
    const ours = sum(installed.filter(g => g.drive === d.root));
    if (!d.total) return el('div', { className: 'drive' }, el('strong', { textContent: d.root }), ` Playdex games: ${fmtBytes(ours)}`);
    // Recorded install sizes can exceed what's really used (stale records, compressed folders): clamp.
    const used = d.total - (d.free ?? 0), games = Math.min(ours, used), other = used - games;
    return el('div', { className: 'drive' },
      el('div', { className: 'drive-head' }, el('strong', { textContent: d.root }),
        el('span', { textContent: `${fmtBytes(d.free)} free of ${fmtBytes(d.total)}` })),
      bar(['games', games / d.total, `Games: ${fmtBytes(ours)}`], ['other', other / d.total, `Everything else: ${fmtBytes(other)}`]),
      el('div', { className: 'legend' }, el('span', { className: 'key games' }), `Games ${fmtBytes(ours)}`,
        el('span', { className: 'key other' }), `Everything else ${fmtBytes(other)}`, el('span', { className: 'key free' }), 'Free'));
  });

  // The same game installed from two stores: an easy way to get space back.
  const twice = [...Map.groupBy(installed, g => g.key).values()].filter(l => l.length > 1).map(l => {
    const copies = l.toSorted(byStore);
    return el('p', { className: 'warn' }, el('strong', { textContent: copies[0].title }),
      ` is installed from ${copies.map(g => `${STORES[g.store]} (${fmtBytes(g.size)})`).join(' and ')}. `
      + `Removing one copy frees about ${fmtBytes(Math.min(...copies.map(g => g.size ?? 0)))}.`);
  });

  const totals = Object.entries(STORES).map(([s, name]) => [name, installed.filter(g => g.store === s)]).filter(([, l]) => l.length)
    .map(([name, l]) => `${name} ${fmtBytes(sum(l))} (${l.length} game${l.length > 1 ? 's' : ''})`).join(' · ');
  const max = Math.max(1, ...shown.map(g => g.size ?? 0));
  const row = g => listRow(g, fmtBytes(g.size), (g.size ?? 0) / max,
    el('span', { className: 'where', textContent: g.drive ?? '' }), uninstallButton(g));

  return [
    el('div', { className: 'drives' }, ...driveCards),
    ...twice,
    el('p', { className: 'hint', textContent: `Installed: ${fmtBytes(sum(installed))} in ${installed.length} games — ${totals}` }),
    shown.length ? el('div', { className: 'disklist' }, ...shown.map(row)) : el('p', { className: 'empty', textContent: 'No installed games match.' }),
  ];
}

// ---------- stats ----------
// Games count once however many stores you own them on, like the header total.
function statsView(list) {
  if (!list.length) return [el('p', { className: 'empty', textContent: 'No games match.' })];
  const keys = l => new Set(l.map(g => g.key));
  const installed = list.filter(g => g.installed);
  const minutes = l => l.reduce((t, g) => t + (g.playtime ?? 0), 0);
  const tracked = keys(list.filter(g => g.playtime != null)), done = keys(list.filter(played));
  const playedCount = [...tracked].filter(k => done.has(k)).length;
  const tile = (value, label) => el('div', { className: 'tile' }, el('strong', { textContent: value }), el('span', { textContent: label }));
  const h = m => `${Math.round(m / 60).toLocaleString('en')} h`;
  const perStore = Object.entries(STORES).map(([s, name]) => [s, name, list.filter(g => g.store === s)]).filter(([, , l]) => l.length)
    .map(([s, name, l]) => `${name} ${l.length} game${l.length > 1 ? 's' : ''} · ${s === 'epic' ? 'playtime not tracked' : h(minutes(l))}`).join('  |  ');
  const top = list.filter(g => g.playtime > 0).sort(SORTS.playtime).slice(0, 10);
  return [
    el('div', { className: 'tiles' },
      tile(keys(list).size.toLocaleString('en'), 'games'),
      tile(keys(installed).size.toLocaleString('en'), 'installed'),
      tile(h(minutes(list)), 'played in total'),
      tile(tracked.size ? `${Math.round(100 * playedCount / tracked.size)}%` : '–', `played (${tracked.size - playedCount} not yet)`),
      tile(fmtBytes(sum(installed)), 'on disk')),
    el('p', { className: 'hint', textContent: perStore }),
    ...(top.length ? [el('h2', { className: 'section', textContent: 'Most played' }), el('div', { className: 'disklist statlist' },
      ...top.map(g => listRow(g, hours(g.playtime), g.playtime / top[0].playtime,
        el('span', { className: 'where', textContent: g.lastPlayed ? ago(g.lastPlayed) : '' }))))] : []),
  ];
}

function render() {
  const { games, duplicates, errors, notes } = data;
  // A game owned on two stores counts once in the total, and once in each store's badge.
  $('stats').replaceChildren(`${new Set(games.map(g => g.key)).size} games`, ...Object.entries(STORES).map(([s, name]) =>
    el('span', { className: `badge ${s}`, title: errors[s] ?? '',
      textContent: errors[s] ? `${name}: not found` : `${name} ${games.filter(g => g.store === s).length}` })));
  $('dup-count').textContent = String(duplicates.length);
  for (const t of TABS) $(`tab-${t}`).setAttribute('aria-selected', String(state.tab === t));
  // Sort and Show apply to the Library tab. Duplicates (A–Z), Disk space (largest first) and Stats count every copy.
  $('sort').disabled = $('show').disabled = $('pick').disabled = state.tab !== 'library';
  renderShowMenu();

  const q = state.q.trim().toLowerCase();
  const match = g => state.stores.has(g.store) && g.title.toLowerCase().includes(q);
  const problems = [...Object.entries(errors).map(([s, m]) => `${STORES[s]}: ${m}`), ...notes];
  const errorNote = problems.length ? el('p', { className: 'errors', textContent: problems.join(' · ') }) : null;

  if (state.tab === 'library') {
    const list = visible = games.filter(g => match(g) && shown(g));
    if (SORTS[state.sort]) list.sort(SORTS[state.sort]);
    const empty = { favorites: 'No favorites yet. Open a game and click ☆ Favorite.', hidden: 'No hidden games.' }[state.show] ?? 'No games match.';
    $('view').replaceChildren(...[errorNote, list.length
      ? el('div', { className: 'grid' }, ...list.map(card))
      : el('p', { className: 'empty', textContent: empty })].filter(Boolean));
  } else if (state.tab === 'disk') {
    $('view').replaceChildren(...[errorNote, ...diskView(match)].filter(Boolean));
  } else if (state.tab === 'stats') {
    $('view').replaceChildren(...[errorNote, ...statsView(games.filter(match))].filter(Boolean));
  } else {
    const list = duplicates.filter(d => d.games.some(match));
    $('view').replaceChildren(
      el('p', { className: 'hint', textContent: duplicates.length
        ? `You own ${duplicates.length} games on more than one store. Click a store to open the game there.`
        : 'No games owned on more than one store.' }),
      el('div', { className: 'dups' }, ...list.map(dupRow)));
  }
}

// quiet: an auto-refresh, which keeps the current view on screen until the new scan is ready.
let lastScan = 0;
async function load(quiet = false) {
  lastScan = Date.now();
  if (!quiet) $('view').replaceChildren(el('p', { className: 'empty', textContent: 'Scanning your launchers…' }));
  try {
    const [scan, saved] = await Promise.all([window.library.scan(), window.library.prefs().catch(() => null)]);
    data = scan;
    playedKeys = new Set(scan.games.filter(played).map(g => g.key));
    if (saved) prefs = toPrefs(saved);
    else if (!quiet) toast('Could not load your favorites and tags.');
    render();
  } catch (e) {
    if (quiet) toast('Could not refresh the library.');
    else $('view').replaceChildren(el('p', { className: 'empty', textContent: `Scan failed: ${e.message}` }));
  }
}
// Auto-refresh: back in the window (say, after installing or uninstalling in a launcher), rescan quietly.
// ponytail: refocus only, at most every 15 s; watch the launchers' folders if changes while focused matter.
window.onfocus = () => { if (data && Date.now() - lastScan > 15e3) load(true); };

for (const [s, name] of Object.entries(STORES)) {
  const chip = el('button', { className: `chip ${s}`, textContent: name });
  chip.setAttribute('aria-pressed', 'true');
  chip.onclick = () => {
    state.stores.has(s) ? state.stores.delete(s) : state.stores.add(s);
    chip.setAttribute('aria-pressed', state.stores.has(s));
    if (data) render();
  };
  $('chips').append(chip);
}
const setTab = t => { state.tab = t; if (data) render(); };
for (const t of TABS) $(`tab-${t}`).onclick = () => setTab(t);
$('q').oninput = () => { state.q = $('q').value; if (data) render(); };
$('show').onchange = () => { state.show = $('show').value; if (data) render(); };
$('sort').value = state.sort;
$('sort').onchange = () => {
  state.sort = $('sort').value;
  try { localStorage.sort = state.sort; } catch { /* storage unavailable: just not remembered */ }
  if (data) render();
};
// A random game from what the Library shows (filters, search, Show menu), installed ones first, not the last pick again.
$('pick').onclick = () => {
  const installed = visible.filter(g => g.installed);
  let pool = installed.length ? installed : visible;
  if (pool.length > 1) pool = pool.filter(g => g.id !== lastPick);
  if (!pool.length) return toast('No games to pick from. Try another filter.');
  const g = pool[Math.floor(Math.random() * pool.length)];
  lastPick = g.id;
  openDetails(g);
};
$('rescan').onclick = () => load();
$('export').onclick = async () => {
  const name = await window.library.exportLibrary().catch(() => false); // null: cancelled
  if (name) toast(`Saved ${name}`);
  else if (name === false) toast('Could not save the file.');
};

const SHORTCUTS = '/ or Ctrl+F search · Esc clear · 1–4 tabs · P pick a game · F5 rescan';
document.onkeydown = e => {
  const key = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey, target = /** @type {Element} */ (e.target);
  if (e.key === 'F5') { e.preventDefault(); load(); return; }
  if ($('details').open) return; // the window is modal; Esc closes it natively
  if (target === $('q') && e.key === 'Escape') {
    if ($('q').value) { $('q').value = ''; $('q').dispatchEvent(new Event('input')); } else $('q').blur();
    e.preventDefault();
    return;
  }
  if ((ctrl && key === 'f') || (e.key === '/' && !target.matches('input, select, textarea'))) {
    e.preventDefault();
    $('q').focus(); $('q').select();
    return;
  }
  if (ctrl || e.altKey || target.matches('input, select, textarea')) return;
  if (TABS[+e.key - 1]) setTab(TABS[+e.key - 1]);
  else if (key === 'p' && state.tab === 'library') $('pick').click();
  else if (e.key === '?') toast(SHORTCUTS, 6000);
};
$('details-close').onclick = () => $('details').close();
$('details').onclick = e => { if (e.target === $('details')) $('details').close(); }; // click on the backdrop
$('settings').onclick = () => {
  window.library.openSettings();
  toast('Add your Steam API key to config.json, save it, then click Rescan.');
};
load();
