// Builds small fake Steam / Epic / GOG data folders in the same formats the real launchers use,
// so the scanners can be tested without the real launchers (e.g. on GitHub Actions).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

/** Minimal appinfo.vdf v29: header, entries (appid, size, 60-byte header, binary KeyValues), string table. */
export function appInfoFile(apps) {
  const strings = ['appinfo', 'common', 'name', 'type', 'gameid'];
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const key = k => u32(strings.indexOf(k));
  const str = (k, v) => Buffer.concat([Buffer.from([1]), key(k), Buffer.from(v + '\0')]);
  const entries = apps.map(([id, name, type]) => {
    const kv = Buffer.concat([
      Buffer.from([0]), key('appinfo'), Buffer.from([0]), key('common'),
      str('name', name), str('type', type), Buffer.from([2]), key('gameid'), u32(id), // int32 value, skipped
      Buffer.from([8, 8, 8]),
    ]);
    return Buffer.concat([u32(id), u32(60 + kv.length), Buffer.alloc(60), kv]);
  });
  const body = Buffer.concat([...entries, u32(0)]);
  const head = Buffer.alloc(16);
  head.writeUInt32LE(0x07564429, 0); head.writeUInt32LE(1, 4); head.writeBigUInt64LE(BigInt(16 + body.length), 8);
  const table = Buffer.concat([u32(strings.length), ...strings.map(s => Buffer.from(s + '\0'))]);
  return Buffer.concat([head, body, table]);
}

/**
 * Steam folder. apps: { id, name, type, inLibrary = true, installed?: { size }, playtime?, lastPlayed? (unix s) }.
 * An app with no `type` is left out of appinfo.vdf (Steam has no info for it).
 */
export function makeSteam(root, apps, accountId = 12345) {
  const steamId = String(76561197960265728n + BigInt(accountId));
  write(path.join(root, 'steamapps/libraryfolders.vdf'),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root.replace(/\\/g, '\\\\')}"\n\t}\n}\n`);
  for (const a of apps) {
    if (a.inLibrary !== false) fs.mkdirSync(path.join(root, 'appcache/librarycache', String(a.id)), { recursive: true });
    if (a.installed) {
      write(path.join(root, `steamapps/appmanifest_${a.id}.acf`), `"AppState"\n{\n\t"appid"\t\t"${a.id}"\n\t"name"\t\t"${a.name}"\n`
        + `\t"installdir"\t\t"${a.name}"\n\t"SizeOnDisk"\t\t"${a.installed.size}"\n}\n`);
    }
  }
  write(path.join(root, 'appcache/appinfo.vdf'), appInfoFile(apps.filter(a => a.type).map(a => [a.id, a.name, a.type])));
  write(path.join(root, 'config/loginusers.vdf'), `"users"\n{\n\t"${steamId}"\n\t{\n\t\t"MostRecent"\t\t"1"\n\t}\n}\n`);
  const played = apps.filter(a => a.playtime != null)
    .map(a => `\t\t\t\t\t"${a.id}"\n\t\t\t\t\t{\n\t\t\t\t\t\t"LastPlayed"\t\t"${a.lastPlayed ?? 0}"\n\t\t\t\t\t\t"Playtime"\t\t"${a.playtime}"\n\t\t\t\t\t}\n`).join('');
  write(path.join(root, `userdata/${accountId}/config/localconfig.vdf`),
    `"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"apps"\n\t\t\t\t{\n${played}\t\t\t\t}\n\t\t\t}\n\t\t}\n\t}\n}\n`);
}

/** Epic Data folder. items: catalog entries (as in catcache.bin); installs: { CatalogItemId, InstallLocation, InstallSize }. */
export function makeEpic(dir, items, installs = []) {
  write(path.join(dir, 'Catalog/catcache.bin'), Buffer.from(JSON.stringify(items)).toString('base64'));
  installs.forEach((m, i) => write(path.join(dir, `Manifests/${i}.item`), JSON.stringify(m)));
}

/** An Epic catalog entry with sensible defaults. */
export const epicItem = (id, title, extra = {}) => ({
  id, title, namespace: `ns${id}`, description: title, developer: 'Dev', mainGameItem: { namespace: '', id: '' },
  categories: [{ path: 'games' }, { path: 'applications' }], releaseInfo: [{ appId: `App${id}` }], keyImages: [], ...extra,
});

/**
 * GOG Galaxy database with the tables Playdex reads.
 * releases: { key, title, dlc?, visible = true, minutes?, lastPlayed? ('YYYY-MM-DD HH:MM:SS'), installDir?, summary?, meta? }
 */
export function makeGog(file, releases) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    create table GamePieceTypes (id integer primary key, type text);
    create table GamePieces (releaseKey text, gamePieceTypeId integer, value text);
    create table LibraryReleases (id integer primary key, userId integer, releaseKey text);
    create table ReleaseProperties (releaseKey text, isDlc integer, isVisibleInLibrary integer, gameId text);
    create table InstalledBaseProducts (productId integer, installationPath text);
    create table GameTimes (userId integer, releaseKey text, minutesInGame integer);
    create table LastPlayedDates (userId integer, gameReleaseKey text, lastPlayedDate text);
    insert into GamePieceTypes (id, type) values (1, 'title'), (2, 'originalImages'), (3, 'summary'), (4, 'meta');`);
  const piece = db.prepare('insert into GamePieces values (?, ?, ?)');
  for (const r of releases) {
    db.prepare('insert into LibraryReleases (userId, releaseKey) values (1, ?)').run(r.key);
    db.prepare('insert into ReleaseProperties values (?, ?, ?, ?)').run(r.key, r.dlc ? 1 : 0, r.visible === false ? 0 : 1, r.key);
    piece.run(r.key, 1, JSON.stringify({ title: r.title }));
    piece.run(r.key, 2, JSON.stringify({ verticalCover: `https://images.gog.com/${r.key}.webp` }));
    if (r.summary) piece.run(r.key, 3, JSON.stringify({ summary: r.summary }));
    if (r.meta) piece.run(r.key, 4, JSON.stringify(r.meta));
    if (r.minutes != null) db.prepare('insert into GameTimes values (1, ?, ?)').run(r.key, r.minutes);
    if (r.lastPlayed) db.prepare('insert into LastPlayedDates values (1, ?, ?)').run(r.key, r.lastPlayed);
    if (r.installDir) db.prepare('insert into InstalledBaseProducts values (?, ?)').run(Number(r.key.slice(4)), r.installDir);
  }
  db.close();
}
