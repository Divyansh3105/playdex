// Game details for the details window: what the scan found locally (GOG, Epic), completed on demand from
// the Steam store (Steam games, and Epic games whose local entry has no real description).
import { normalize } from './scan.mjs';

const STEAM = 'https://store.steampowered.com/api';
const cache = new Map(); // game id -> details promise, for this session

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Steam text is HTML-ish: drop tags, decode entities. Rendered with textContent, so this is for looks, not safety. */
export function plainText(s) {
  if (typeof s !== 'string') return undefined;
  return s.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  }).trim() || undefined;
}

/** The search result that is this exact game ("Maneater", not the first hit "Maneater 2"). */
export const exactHit = (items, title) => items?.find(i => normalize(i.name ?? '') === normalize(title));

const getJson = async url => (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();

async function steamDetails(appid) {
  const d = (await getJson(`${STEAM}/appdetails?appids=${appid}&l=english&filters=basic,developers,publishers,release_date,genres`))?.[appid];
  if (!d?.success) return {};
  return {
    description: plainText(d.data.short_description),
    developers: d.data.developers, publishers: d.data.publishers,
    released: d.data.release_date?.date || undefined,
    genres: d.data.genres?.map(g => g.description),
  };
}

async function steamDetailsByTitle(title) {
  const hit = exactHit((await getJson(`${STEAM}/storesearch/?term=${encodeURIComponent(title)}&l=english&cc=US`))?.items, title);
  return hit ? { ...(await steamDetails(String(hit.id))), source: 'Description from the Steam store page' } : {};
}

/** Local info first; online fields only fill gaps. Offline or not on Steam: whatever we have locally. */
export function gameDetails(game) {
  if (!cache.has(game.id)) {
    cache.set(game.id, (async () => {
      const local = Object.fromEntries(Object.entries(game.info ?? {}).filter(([, v]) => v != null && v.length !== 0));
      try {
        if (game.store === 'steam') return { ...(await steamDetails(game.id.slice(6))), ...local };
        if (!local.description) return { ...(await steamDetailsByTitle(game.title)), ...local };
      } catch {
        cache.delete(game.id); // offline: try again next time
        return { ...local, offline: true };
      }
      return local;
    })());
  }
  return cache.get(game.id);
}
