// The Export button: the library as rows for a CSV or JSON file. Pure, so it's tested without Electron.
const COLUMNS = ['store', 'title', 'installed', 'playtimeMinutes', 'lastPlayed', 'sizeBytes', 'drive', 'favorite', 'hidden', 'tags'];

/** One row per store copy. playtimeMinutes is null where the store doesn't tell us (Epic). */
export function exportRows(games, prefs) {
  const fav = new Set(prefs.favorites), hidden = new Set(prefs.hidden);
  return games.map(g => ({
    store: g.store, title: g.title, installed: !!g.installed,
    playtimeMinutes: g.playtime ?? null, lastPlayed: g.lastPlayed ? new Date(g.lastPlayed).toISOString() : null,
    sizeBytes: g.size ?? null, drive: g.drive ?? null,
    favorite: fav.has(g.id), hidden: hidden.has(g.id), tags: prefs.tags[g.id] ?? [],
  }));
}

// Spreadsheet apps run a cell starting with = + - @ as a formula. Titles and tags come from launcher files and
// the user, so such cells get a leading ' (shown as plain text).
const cell = v => {
  let s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** CSV with a BOM, so Excel reads ™ and accents as UTF-8. */
export const toCsv = rows => '﻿' + [COLUMNS, ...rows.map(r => COLUMNS.map(c => r[c]))]
  .map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
