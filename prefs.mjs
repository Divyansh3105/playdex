// Favorites, hidden games and tags, saved in <userData>/library.json (%APPDATA%\Playdex on Windows).
// Keyed by game id (one store's copy), so you can hide the Epic copy of a game and keep the Steam one.
import fs from 'node:fs/promises';
import path from 'node:path';

const ID = /^(steam|epic|gog):[\w-]{1,64}$/;
const MAX_IDS = 10000, MAX_TAGS = 20, TAG_LEN = 32;

/** Keep only well-formed data. It comes from the page, and from a file other programs could edit. */
export function cleanPrefs(p) {
  const ids = list => [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && ID.test(id)))].slice(0, MAX_IDS);
  const src = p && typeof p.tags === 'object' && !Array.isArray(p.tags) ? p.tags : {};
  // Keys must match ID, so "__proto__" and friends never get through.
  const tags = Object.fromEntries(Object.entries(src).slice(0, MAX_IDS)
    .filter(([id, list]) => ID.test(id) && Array.isArray(list))
    .map(([id, list]) => [id, [...new Set(list.filter(t => typeof t === 'string')
      .map(t => t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, TAG_LEN)).filter(Boolean))].slice(0, MAX_TAGS)])
    .filter(([, list]) => list.length));
  return { favorites: ids(p?.favorites), hidden: ids(p?.hidden), tags };
}

const fileIn = dir => path.join(dir, 'library.json');

export async function loadPrefs(dir) {
  let text;
  try { text = await fs.readFile(fileIn(dir), 'utf8'); } catch { return cleanPrefs({}); } // first run
  try { return cleanPrefs(JSON.parse(text)); }
  catch {
    // Unreadable: keep it as a backup instead of silently overwriting it on the next save.
    await fs.rename(fileIn(dir), `${fileIn(dir)}.bad-${Date.now()}`).catch(() => {});
    return cleanPrefs({});
  }
}

let queue = Promise.resolve(); // saves run one at a time, in order

export function savePrefs(dir, prefs) {
  const clean = cleanPrefs(prefs);
  const save = async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${fileIn(dir)}.tmp`, JSON.stringify(clean, null, 2));
    await fs.rename(`${fileIn(dir)}.tmp`, fileIn(dir)); // atomic: a crash mid-save can't leave half a file
    return clean;
  };
  queue = queue.then(save, save);
  return queue;
}
