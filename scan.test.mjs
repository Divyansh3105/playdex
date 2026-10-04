import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, findDuplicates, dedupeWithinStores, parseLoginUsers, uriLaunch, gogLaunch, parseAppInfo } from './scan.mjs';

// Minimal appinfo.vdf v29 writer: header, entries (appid, size, 60-byte header, binary KeyValues), string table.
function appInfoFile(apps) {
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

test('reads name and type from Steam appinfo.vdf', () => {
  const buf = appInfoFile([[205930, 'Hitman: Sniper Challenge', 'Game'], [431960, 'Wallpaper Engine', 'Application'], [7, 'Steam Client', 'Config']]);
  const apps = parseAppInfo(buf, new Set(['205930', '431960']));
  assert.deepEqual(Object.fromEntries(apps), {
    205930: { name: 'Hitman: Sniper Challenge', type: 'Game' },
    431960: { name: 'Wallpaper Engine', type: 'Application' },
  });                                                                   // unwanted app 7 skipped
  assert.throws(() => parseAppInfo(Buffer.alloc(16), new Set()), /unsupported/);
  assert.throws(() => parseAppInfo(buf.subarray(0, buf.length - 3), new Set(['205930'])), /truncated/);
});

test('only exact launcher URI shapes are launchable', () => {
  assert.ok(uriLaunch('steam://rungameid/209000'));
  assert.ok(uriLaunch('com.epicgames.launcher://apps/ns1%3Aabc123%3AWombat?action=launch&silent=true'));
  assert.ok(uriLaunch('goggalaxy://openGameView/gog_1207659001'));
  for (const bad of [
    'steam://rungameid/1,C:\\evil.exe',                                        // explorer.exe comma switch
    'com.epicgames.launcher://apps/a%3Ab%3Ac?action=uninstall',                 // different action
    'com.epicgames.launcher://apps/a"%3Ab%3Ac?action=launch&silent=true',       // quote injection
    'com.epicgames.launcher://apps/a/../x%3Ab%3Ac?action=launch&silent=true',   // path tricks
    'file:///C:/evil.exe', 'C:\\evil.exe', 'goggalaxy://openGameView/gog_1 /x', 'steam://rungameid/1\n',
  ]) assert.equal(uriLaunch(bad), null, bad);
});

test('GOG direct launch only for a real install folder of that game', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goggame-'));
  fs.writeFileSync(path.join(dir, 'goggame-123.info'), '{}');
  assert.deepEqual(gogLaunch('G.exe', '123', dir), ['G.exe', '/command=runGame', '/gameId=123', `/path=${dir}`]);
  assert.equal(gogLaunch('G.exe', '456', dir), null);          // folder belongs to another game
  assert.equal(gogLaunch('G.exe', '1 /x', dir), null);         // non-numeric id
  assert.equal(gogLaunch('G.exe', '123', 'relative\\dir'), null);
  assert.equal(gogLaunch(null, '123', dir), null);             // Galaxy not installed
  fs.rmSync(dir, { recursive: true });
});

test('picks the most recent Steam account, else the first', () => {
  const user = (id, recent) => `"${id}"\n{\n\t"AccountName"\t\t"x"\n\t"MostRecent"\t\t"${recent}"\n}\n`;
  assert.equal(parseLoginUsers(`"users"\n{\n${user('76561190000000001', 0)}${user('76561190000000002', 1)}}`), '76561190000000002');
  assert.equal(parseLoginUsers(`"users"\n{\n"76561190000000003"\n{\n"AccountName" "y"\n}\n}`), '76561190000000003');
  assert.equal(parseLoginUsers('"users"\n{\n}'), undefined);
});

test('normalize strips symbols, editions and store suffixes', () => {
  assert.equal(normalize('Batman™: Arkham Origins'), 'batman arkham origins');
  assert.equal(normalize('Disco Elysium - The Final Cut'), 'disco elysium');
  assert.equal(normalize('The Witcher 3: Wild Hunt - Game of the Year Edition'), 'the witcher 3 wild hunt');
  assert.equal(normalize('The Outer Worlds - Amazon Prime'), 'the outer worlds');
  assert.equal(normalize('Ultimate Zombie Defense'), 'ultimate zombie defense');
  assert.equal(normalize('Ultimate DOOM, The'), normalize('The Ultimate Doom'));
  assert.notEqual(normalize('Cats, Dogs'), normalize('Dogs Cats'));
  assert.notEqual(normalize('Mortal Shell Tech Beta'), normalize('Mortal Shell'));
});

test('same game twice in one store counts once, keeping the best copy', () => {
  const g = (store, title, extra = {}) => ({ store, title, key: normalize(title), ...extra });
  const out = dedupeWithinStores([
    g('gog', 'Fallout - Amazon Luna', { cover: 'x' }), g('gog', 'Fallout', { cover: 'y' }),
    g('gog', 'Mafia II - Amazon Prime', { installed: true }), g('gog', 'Mafia II'), g('gog', 'Mafia II'),
    g('gog', 'Thief', { cover: 'z' }), g('gog', 'Thief - Amazon Prime'),
    g('steam', 'Fallout'), // other store: kept, that's a cross-store duplicate
  ]);
  const pick = (s, k) => out.find(x => x.store === s && x.key === k).title;
  assert.equal(out.length, 4);
  assert.equal(pick('gog', 'fallout'), 'Fallout');                    // plainest title
  assert.equal(pick('gog', 'mafia ii'), 'Mafia II - Amazon Prime');   // installed wins
  assert.equal(pick('gog', 'thief'), 'Thief');                        // has cover
});

test('duplicates need two different stores', () => {
  const g = (store, title) => ({ store, title, key: normalize(title) });
  const dups = findDuplicates([
    g('steam', 'Alan Wake'), g('epic', 'Alan Wake™'),
    g('gog', 'Thief'), g('gog', 'Thief - Amazon Prime'), // same store twice: not a cross-store duplicate
    g('steam', 'Portal'),
  ]);
  assert.deepEqual(dups.map(d => d.title), ['Alan Wake']);
  assert.equal(dups[0].games.length, 2);
});
