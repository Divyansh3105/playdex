import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalize, findDuplicates, dedupeWithinStores, parseLoginUsers, uriLaunch, gogLaunch, parseAppInfo, parseVdf, steamPlaytimes } from './scan.mjs';

test('text VDF: nesting, escapes, unbalanced input, no prototype tricks', () => {
  const v = parseVdf('"a" { "b" "1" "c" { "d" "say \\"hi\\"" } } "e" "2"');
  assert.equal(v.a.b, '1');
  assert.equal(v.a.c.d, 'say "hi"');
  assert.equal(v.e, '2');
  assert.doesNotThrow(() => parseVdf('} } "x" { "y" "1"')); // stray / missing braces don't crash
  assert.equal(Object.getPrototypeOf(parseVdf('"__proto__" { "polluted" "yes" }').__proto__), null);
  assert.equal({}.polluted, undefined);
});

test('Steam playtime and last played from localconfig.vdf', () => {
  const t = steamPlaytimes(`"UserLocalConfigStore" { "Software" { "valve" { "Steam" { "apps" {
    "730" { "LastPlayed" "1774886983" "Playtime" "1186" }
    "7" { "cloud" { "last_sync_state" "synchronized" } }
    "480" { "Playtime" "oops" }
    "x1" { "Playtime" "5" }
  } } } } }`); // note lowercase "valve": Steam's key case varies
  assert.deepEqual(t.get('730'), { playtime: 1186, lastPlayed: 1774886983000 });
  assert.deepEqual(t.get('7'), { playtime: 0, lastPlayed: undefined });
  assert.deepEqual(t.get('480'), { playtime: 0, lastPlayed: undefined }); // garbage -> 0, not NaN
  assert.equal(t.has('x1'), false);                                      // non-numeric app ids ignored
  assert.equal(steamPlaytimes('').size, 0);
});
import { plainText, exactHit } from './details.mjs';
import { appInfoFile } from './tests/fixtures.mjs';

test('Steam description text: tags stripped, entities decoded, junk left alone', () => {
  assert.equal(plainText('Rock &amp; roll &quot;hero&quot; &#39;s <b>best</b> &#x2014; ever'), `Rock & roll "hero" 's best — ever`);
  assert.equal(plainText('&#99999999; &bogus; ok'), '&#99999999; &bogus; ok'); // out-of-range / unknown: kept as text
  assert.equal(plainText('<br>'), undefined);
  assert.equal(plainText(null), undefined);
});

test('Steam search uses the exact game, not the first hit', () => {
  const items = [{ id: 3603000, name: 'Maneater 2' }, { id: 629820, name: 'Maneater' }];
  assert.equal(exactHit(items, 'Maneater').id, 629820);
  assert.equal(exactHit(items, 'Maneater™').id, 629820);
  assert.equal(exactHit(items, 'Hogwarts Legacy Creator Kit'), undefined);
  assert.equal(exactHit(undefined, 'x'), undefined);
});

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
  assert.ok(uriLaunch('steam://uninstall/209000'));
  assert.ok(uriLaunch('com.epicgames.launcher://store/library'));
  for (const bad of [
    'com.epicgames.launcher://store/library?x=1', 'steam://uninstall/1 2',
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
