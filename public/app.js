const STORES = { steam: 'Steam', epic: 'Epic', gog: 'GOG' };
const state = { tab: 'library', q: '', stores: new Set(Object.keys(STORES)), installed: false };
let data = null;

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null));
  return e;
};

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').classList.remove('show'), 2500);
}

async function launch(g) {
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

const card = g => el('button', { className: 'card', title: `${g.title} (${STORES[g.store]})`, onclick: () => launch(g) },
  cover(g),
  el('span', { className: 'action', textContent: actionLabel(g) }),
  el('span', { className: 'meta' },
    el('span', { className: 'name', textContent: g.title }),
    g.installed ? el('span', { className: 'dot', title: 'Installed' }) : null,
    el('span', { className: `badge ${g.store}`, textContent: STORES[g.store] })));

const dupRow = d => el('div', { className: 'dup' },
  cover(d.games.find(g => g.cover) ?? d.games[0]),
  el('div', {},
    el('h3', { textContent: d.title }),
    el('div', { className: 'stores' }, ...d.games.map(g => el('button', {
      className: `badge ${g.store}${g.installed ? ' installed' : ''}`,
      title: `${actionLabel(g)} via ${STORES[g.store]}`,
      textContent: STORES[g.store] + (g.installed ? ' · installed' : ''),
      onclick: () => launch(g),
    })))));

function render() {
  const { games, duplicates, errors, notes } = data;
  // A game owned on two stores counts once in the total, and once in each store's badge.
  $('stats').replaceChildren(`${new Set(games.map(g => g.key)).size} games`, ...Object.entries(STORES).map(([s, name]) =>
    el('span', { className: `badge ${s}`, title: errors[s] ?? '',
      textContent: errors[s] ? `${name}: not found` : `${name} ${games.filter(g => g.store === s).length}` })));
  $('dup-count').textContent = duplicates.length;
  $('tab-library').setAttribute('aria-selected', state.tab === 'library');
  $('tab-dups').setAttribute('aria-selected', state.tab === 'dups');

  const q = state.q.trim().toLowerCase();
  const match = g => state.stores.has(g.store) && (!state.installed || g.installed) && g.title.toLowerCase().includes(q);
  const problems = [...Object.entries(errors).map(([s, m]) => `${STORES[s]}: ${m}`), ...notes];
  const errorNote = problems.length ? el('p', { className: 'errors', textContent: problems.join(' · ') }) : null;

  if (state.tab === 'library') {
    const list = games.filter(match);
    $('view').replaceChildren(...[errorNote, list.length
      ? el('div', { className: 'grid' }, ...list.map(card))
      : el('p', { className: 'empty', textContent: 'No games match.' })].filter(Boolean));
  } else {
    const list = duplicates.filter(d => d.games.some(match));
    $('view').replaceChildren(
      el('p', { className: 'hint', textContent: duplicates.length
        ? `You own ${duplicates.length} games on more than one store. Click a store to open the game there.`
        : 'No games owned on more than one store.' }),
      el('div', { className: 'dups' }, ...list.map(dupRow)));
  }
}

async function load() {
  $('view').replaceChildren(el('p', { className: 'empty',
    textContent: 'Scanning your launchers…' }));
  try {
    data = await window.library.scan();
    render();
  } catch (e) {
    $('view').replaceChildren(el('p', { className: 'empty', textContent: `Scan failed: ${e.message}` }));
  }
}

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
$('tab-library').onclick = () => { state.tab = 'library'; if (data) render(); };
$('tab-dups').onclick = () => { state.tab = 'dups'; if (data) render(); };
$('q').oninput = e => { state.q = e.target.value; if (data) render(); };
$('installed').onchange = e => { state.installed = e.target.checked; if (data) render(); };
$('rescan').onclick = load;
$('settings').onclick = () => {
  window.library.openSettings();
  toast('Add your Steam API key to config.json, save it, then click Rescan.');
};
load();
