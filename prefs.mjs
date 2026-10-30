// Favorites, hidden games, tags and "same game" links, saved in <userData>/library.json (%APPDATA%\Playdex on Windows).
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
  // same: game id -> the key of the game you said it is (one game, a different name on another store)
  const sameSrc = p && typeof p.same === 'object' && !Array.isArray(p.same) ? p.same : {};
  const same = Object.fromEntries(Object.entries(sameSrc).slice(0, MAX_IDS)
    .filter(([id, key]) => ID.test(id) && typeof key === 'string' && /^[^\u0000-\u001f\u007f]{1,200}$/.test(key)));
  return { favorites: ids(p?.favorites), hidden: ids(p?.hidden), tags, same };
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

// ---------- settings: config.json (Steam Web API key and Steam ID) ----------
// Read by scan.mjs; written by the Settings window. Other keys a user added by hand are kept.
const configIn = dir => path.join(dir, 'config.json');
const readConfig = async dir => {
  try { const c = JSON.parse(await fs.readFile(configIn(dir), 'utf8')); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; }
  catch { return {}; } // missing or broken: scan.mjs reports a broken file
};

/** The Steam key and ID for the Settings window ('' when not set). */
export async function loadSettings(dir) {
  const c = await readConfig(dir);
  return { steamApiKey: typeof c.steamApiKey === 'string' ? c.steamApiKey : '', steamId: typeof c.steamId === 'string' ? c.steamId : '' };
}

/** Saves what the page sends after checking its shape; throws a message the page can show. '' removes a value. */
export async function saveSettings(dir, s) {
  const key = typeof s?.steamApiKey === 'string' ? s.steamApiKey.trim() : '';
  const id = typeof s?.steamId === 'string' ? s.steamId.trim() : '';
  if (key && !/^[0-9a-f]{32}$/i.test(key)) throw new Error('A Steam Web API key is 32 letters and digits.');
  if (id && !/^\d{17}$/.test(id)) throw new Error('A Steam ID is 17 digits.');
  const c = await readConfig(dir);
  key ? (c.steamApiKey = key) : delete c.steamApiKey;
  id ? (c.steamId = id) : delete c.steamId;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${configIn(dir)}.tmp`, JSON.stringify(c, null, 2) + '\n');
  await fs.rename(`${configIn(dir)}.tmp`, configIn(dir));
  return { steamApiKey: key, steamId: id };
}

/** @type {Promise<unknown>} */
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
