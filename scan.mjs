// Reads owned + installed games from each launcher's local files. No logins, read-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

// Writable per-user folder for config.json + caches (the installed app folder is read-only). Set by scanAll().
let dataDir;
const dataFile = name => path.join(dataDir, name);
// Absolute paths, so a stray explorer.exe/reg.exe in the working folder can't be picked up instead.
const SYSTEM = process.env.SystemRoot ?? 'C:\\Windows';
const EXPLORER = path.join(SYSTEM, 'explorer.exe');

// ---------- launching ----------
// Launch data comes from launcher files that every Windows user on this PC can write
// (C:\ProgramData\Epic and \GOG.com), so it is untrusted: only exact, known URI shapes get through.
// No commas, quotes or spaces, which explorer.exe would otherwise parse as its own switches.
const SAFE_URIS = [
  /^steam:\/\/(rungameid|install)\/\d+$/,
  /^com\.epicgames\.launcher:\/\/apps\/[\w-]+%3A[\w-]+%3A[\w-]+\?action=launch&silent=true$/,
  /^goggalaxy:\/\/openGameView\/gog_\d+$/,
];

/** argv to run, or null if the URI isn't one we expect. */
export const uriLaunch = uri => (SAFE_URIS.some(re => re.test(uri)) ? [EXPLORER, uri] : null);

/** Run an installed GOG game through Galaxy (keeps cloud saves + playtime), or null if anything looks off. */
export function gogLaunch(galaxyExe, productId, dir) {
  if (!galaxyExe || !/^\d+$/.test(productId) || typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  // Every GOG install has this file; checking it rejects paths that don't point at this game's folder.
  if (!fs.existsSync(path.join(dir, `goggame-${productId}.info`))) return null;
  return [galaxyExe, '/command=runGame', `/gameId=${productId}`, `/path=${dir}`];
}

function regValue(key, name) {
  try {
    const out = execFileSync(path.join(SYSTEM, 'System32', 'reg.exe'), ['query', key, '/v', name],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.match(new RegExp(`${name}\\s+REG_SZ\\s+(.+)`))[1].trim();
  } catch { return undefined; }
}

// ---------- duplicate matching ----------

const SUFFIX = /\s*[-:–]?\s*(\(?(game of the year|goty|definitive|complete|enhanced|deluxe|digital deluxe|gold|ultimate|special|standard|anniversary)\s+edition\)?|(the\s+)?(final|director['’]?s)\s+cut|goty|amazon (prime|luna))$/;

export function normalize(title) {
  let t = title.toLowerCase().replace(/[™®©]/g, '').trim()
    .replace(/^(.+),\s*(the|a|an)$/, '$2 $1'); // catalog style: "Ultimate DOOM, The" -> "the ultimate doom"
  for (let prev; prev !== t; ) { prev = t; t = t.replace(SUFFIX, '').trim(); }
  return t.replace(/&/g, ' and ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// One entry per game per store. GOG lists Amazon Prime/Luna giveaways next to the normal product
// ("Fallout" + "Fallout - Amazon Luna"), which otherwise counts the same game twice.
// Keep the installed copy, else one with a cover, else the plainest (shortest) title.
export function dedupeWithinStores(games) {
  const best = (a, b) => (!!b.installed - !!a.installed) || (!!b.cover - !!a.cover) || (a.title.length - b.title.length);
  return [...Map.groupBy(games, g => `${g.store}:${g.key}`).values()].map(list => list.sort(best)[0]);
}

// ponytail: exact match on normalized title; fuzzy matching if real libraries show misses
export function findDuplicates(games) {
  return [...Map.groupBy(games, g => g.key).values()]
    .filter(list => new Set(list.map(g => g.store)).size > 1)
    .map(list => ({ title: list[0].title, games: list }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ---------- Steam ----------

const steamRoot = () => regValue('HKCU\\Software\\Valve\\Steam', 'SteamPath') ?? 'C:/Program Files (x86)/Steam';

function readJson(file) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}; }
  catch { return null; } // corrupt file
}

// Steam's own app database, appcache/appinfo.vdf: name + type ("Game", "DLC", "Application", "Tool"…) for every
// app it knows, including delisted ones the store API no longer returns. Binary KeyValues, format v29
// (key names live in a string table at the end of the file). Returns appid -> { name, type } for `wanted` ids.
export function parseAppInfo(buf, wanted) {
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x07564429) throw new Error(`unsupported appinfo.vdf format 0x${magic.toString(16)}`);
  const tableAt = Number(buf.readBigUInt64LE(8));
  const cstr = pos => { // NUL-terminated string -> [text, next position]
    const end = buf.indexOf(0, pos);
    if (end < 0) throw new Error('appinfo.vdf: truncated string');
    return [buf.toString('utf8', pos, end), end + 1];
  };
  const strings = [];
  for (let n = buf.readUInt32LE(tableAt), p = tableAt + 4, s; n--; ) { [s, p] = cstr(p); strings.push(s); }

  // Object.create(null): keys come from a file that may be writable by other users, so no __proto__ tricks.
  const readKV = pos => {
    const read = () => {
      const obj = Object.create(null);
      for (;;) {
        const type = buf[pos++];
        if (type === 0x08) return obj;
        const key = strings[buf.readUInt32LE(pos)];
        pos += 4;
        if (type === 0x00) obj[key] = read();
        else if (type === 0x01) [obj[key], pos] = cstr(pos);
        else if (type === 0x02 || type === 0x03 || type === 0x04 || type === 0x06) pos += 4; // int32/float/ptr/color
        else if (type === 0x07 || type === 0x0a) pos += 8;                                   // uint64/int64
        else throw new Error(`appinfo.vdf: unknown value type ${type}`);
      }
    };
    return read();
  };

  const apps = new Map();
  // Entry: appid, size, then 60 bytes of header (state, update time, token, 2 hashes, change number), then KeyValues.
  for (let off = 16; off < tableAt; ) {
    const appid = String(buf.readUInt32LE(off));
    if (appid === '0') break;
    const size = buf.readUInt32LE(off + 4);
    if (wanted.has(appid)) {
      const common = readKV(off + 68).appinfo?.common;
      if (common) apps.set(appid, { name: common.name, type: common.type });
    }
    off += 8 + size;
  }
  return apps;
}

function steamInstalled(root) {
  const vdf = fs.readFileSync(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8');
  const installed = new Map(); // appid -> name
  for (const [, lib] of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
    const dir = path.join(lib.replace(/\\\\/g, '\\'), 'steamapps');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(f => /^appmanifest_\d+\.acf$/.test(f))) {
      const acf = fs.readFileSync(path.join(dir, f), 'utf8');
      installed.set(acf.match(/"appid"\s+"(\d+)"/)[1], acf.match(/"name"\s+"([^"]+)"/)?.[1]);
    }
  }
  return installed;
}

// Steam ID of the most recently logged-in account in config/loginusers.vdf (first one if none is marked).
export function parseLoginUsers(vdf) {
  const users = [...vdf.matchAll(/"(\d{17})"\s*\{([^}]*)\}/g)];
  return (users.find(([, , body]) => /"mostrecent"\s+"1"/i.test(body)) ?? users[0])?.[1];
}

// Exact owned list (appid -> name) via the official Web API. Key from https://steamcommunity.com/dev/apikey
async function steamOwnedViaApi(root, { steamApiKey, steamId }) {
  if (!/^[0-9a-f]{32}$/i.test(steamApiKey)) throw new Error("steamApiKey in config.json doesn't look like a Steam key (32 letters/digits)");
  steamId ??= parseLoginUsers(fs.readFileSync(path.join(root, 'config/loginusers.vdf'), 'utf8'));
  if (!/^\d{17}$/.test(steamId)) throw new Error('no valid Steam ID; add "steamId" (17 digits) to config.json');
  const r = await fetch('https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/'
    + `?key=${steamApiKey}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1`,
    { signal: AbortSignal.timeout(15000) });
  if (r.status === 401 || r.status === 403) throw new Error('key was rejected');
  if (!r.ok) throw new Error(`Steam returned HTTP ${r.status}`);
  const games = (await r.json()).response?.games;
  if (!games) throw new Error('no games returned; check steamId');
  return new Map(games.map(g => [String(g.appid), g.name]));
}

// Without a key: Steam keeps a library-art folder per app in your library; appinfo.vdf says which are games.
function steamOwnedFromCache(root, installed) {
  const cacheDir = path.join(root, 'appcache/librarycache');
  const cached = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).map(n => n.match(/^\d+/)?.[0]).filter(Boolean) : [];
  const ids = [...new Set([...installed.keys(), ...cached])];
  const info = parseAppInfo(fs.readFileSync(path.join(root, 'appcache/appinfo.vdf')), new Set(ids));
  return new Map(ids
    // Same as Steam's library list: games and applications (e.g. Wallpaper Engine); no DLC, tools or configs
    .filter(id => ['game', 'application'].includes(info.get(id)?.type?.toLowerCase()))
    .map(id => [id, info.get(id).name]));
}

async function scanSteam(notes) {
  const root = steamRoot();
  const installed = steamInstalled(root);
  let config = readJson(dataFile('config.json'));
  if (!config) { notes.push('config.json is not valid JSON, so it was ignored.'); config = {}; }
  let owned;
  if (config.steamApiKey) {
    try { owned = await steamOwnedViaApi(root, config); }
    catch (e) { notes.push(`Steam API: ${e.message}. Using Steam's local cache instead.`); }
  }
  owned ??= steamOwnedFromCache(root, installed);
  const art = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps`;
  return [...owned].map(([id, title]) => ({
    id: `steam:${id}`, store: 'steam', title, installed: installed.has(id),
    cover: `${art}/${id}/library_600x900.jpg`,
    fallback: `${art}/${id}/header.jpg`,
    launch: uriLaunch(installed.has(id) ? `steam://rungameid/${id}` : `steam://install/${id}`),
  }));
}

// ---------- Epic ----------

function scanEpic() {
  const base = 'C:/ProgramData/Epic/EpicGamesLauncher/Data';
  const installed = new Set();
  const manifests = path.join(base, 'Manifests');
  if (fs.existsSync(manifests)) {
    for (const f of fs.readdirSync(manifests).filter(f => f.endsWith('.item'))) {
      installed.add(JSON.parse(fs.readFileSync(path.join(manifests, f), 'utf8')).CatalogItemId);
    }
  }
  // catcache.bin = base64 JSON of the catalog entries for your library
  const catalog = JSON.parse(Buffer.from(fs.readFileSync(path.join(base, 'Catalog/catcache.bin'), 'utf8'), 'base64').toString('utf8'));
  return catalog
    // Same as Epic's Library tab: games plus creator/mod kits (filed as engines + applications, e.g.
    // "Hogwarts Legacy Creator Kit"). Not DLC (has a main game), Unreal Engine (engines only) or Twinmotion (software).
    .filter(i => {
      const cats = new Set(i.categories?.map(c => c.path));
      return !i.mainGameItem?.id && (cats.has('games') || (cats.has('engines') && cats.has('applications')));
    })
    .map(i => {
      const img = ['DieselGameBoxTall', 'DieselGameBox', 'Thumbnail'].map(t => i.keyImages?.find(k => k.type === t)).find(Boolean);
      return {
        // Epic's cache stores ™/® as a literal "?" ("Apex Legends?"), so drop "?" glued to the end of a word
        // ponytail: also eats a real trailing "?" in a title; rare enough to ignore
        id: `epic:${i.id}`, store: 'epic', title: i.title.replace(/(?<=\w)\?(?=[\s:]|$)/g, ''), installed: installed.has(i.id),
        cover: img && `${img.url}?w=360&h=480&resize=1`,
        launch: uriLaunch(`com.epicgames.launcher://apps/${i.namespace}%3A${i.id}%3A${i.releaseInfo?.[0]?.appId}?action=launch&silent=true`),
      };
    });
}

// ---------- GOG ----------

function scanGog() {
  const src = 'C:/ProgramData/GOG.com/Galaxy/storage/galaxy-2.0.db';
  if (!fs.existsSync(src)) throw new Error('GOG Galaxy not found');
  // Copy first: Galaxy keeps the live DB open, and SQLite on Windows fails on very long paths.
  const tmp = path.join(os.tmpdir(), 'playdex-gog');
  fs.mkdirSync(tmp, { recursive: true });
  for (const ext of ['', '-wal', '-shm']) {
    if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, path.join(tmp, 'galaxy-2.0.db' + ext));
  }
  const db = new DatabaseSync(path.join(tmp, 'galaxy-2.0.db'));
  try {
    const piece = type => `(select value from GamePieces where releaseKey = lr.releaseKey
      and gamePieceTypeId = (select id from GamePieceTypes where type = '${type}'))`;
    // HKLM is admin-only, so the Galaxy exe location is trusted (unlike the DB).
    const galaxyDir = regValue('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths', 'client');
    const galaxyExe = galaxyDir && path.join(galaxyDir, 'GalaxyClient.exe');
    const exe = galaxyExe && fs.existsSync(galaxyExe) ? galaxyExe : null;
    const installed = new Map(db.prepare('select productId, installationPath from InstalledBaseProducts').all()
      .map(r => [`gog_${r.productId}`, r.installationPath]));
    // Galaxy's own flags decide what its "Owned games" list shows: no DLC, nothing it hides (Amazon Prime/Luna
    // claim stubs, bundle entries, superseded releases like "Ultimate DOOM, The"). Same count as Galaxy.
    return db.prepare(`select lr.releaseKey as key, ${piece('title')} as title, ${piece('originalImages')} as images
      from (select distinct l.releaseKey from LibraryReleases l join ReleaseProperties p on p.releaseKey = l.releaseKey
            where l.releaseKey like 'gog_%' and p.isDlc = 0 and p.isVisibleInLibrary = 1) lr`).all()
      .filter(r => r.title)
      .map(r => ({
        id: `gog:${r.key}`, store: 'gog', title: JSON.parse(r.title).title, installed: installed.has(r.key),
        cover: JSON.parse(r.images ?? '{}').verticalCover ?? undefined,
        // installed: run it directly; otherwise (or if the install looks wrong) open its page in Galaxy to install
        launch: (installed.has(r.key) && gogLaunch(exe, r.key.slice(4), installed.get(r.key)))
          || uriLaunch(`goggalaxy://openGameView/${r.key}`),
      }));
  } finally { db.close(); }
}

// ---------- all ----------

export async function scanAll(dir) {
  dataDir = dir;
  const games = [], errors = {}, notes = [];
  for (const [store, scan] of Object.entries({ steam: scanSteam, epic: scanEpic, gog: scanGog })) {
    try { games.push(...await scan(notes)); } catch (e) { errors[store] = e.message; }
  }
  for (const g of games) g.key = normalize(g.title);
  const unique = dedupeWithinStores(games).sort((a, b) => a.title.localeCompare(b.title));
  return { games: unique, duplicates: findDuplicates(unique), errors, notes };
}
