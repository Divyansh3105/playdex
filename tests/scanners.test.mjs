// End-to-end scanner tests on fake launcher data. Each sample entry stands for a rule that was worked out
// against real libraries (counts matching Steam, Epic and GOG Galaxy), so a change that breaks one fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from '../scan.mjs';
import { makeSteam, makeEpic, epicItem, makeGog } from './fixtures.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playdex-fixture-'));
const paths = {
  steam: path.join(tmp, 'Steam'),
  epic: path.join(tmp, 'Epic'),
  gog: path.join(tmp, 'GOG', 'galaxy-2.0.db'),
  galaxyExe: path.join(tmp, 'GOG', 'GalaxyClient.exe'),
};
const gogInstall = path.join(tmp, 'GOG Games', 'Fallout');

makeSteam(paths.steam, [
  { id: 100, name: 'Half Game', type: 'Game', installed: { size: 5e9 }, playtime: 600, lastPlayed: 1774886983 },
  { id: 101, name: 'Wallpaper App', type: 'Application' },          // Steam lists software too
  { id: 102, name: 'Half Game - Soundtrack', type: 'DLC' },         // DLC: not a game
  { id: 103, name: 'Steamworks Redist', type: 'Tool', installed: { size: 1e6 } }, // tool: not a game
  { id: 104, name: 'Delisted Classic', type: 'Game' },              // gone from the store, still owned
  { id: 105, name: 'Destiny Two', type: 'game' },                   // lowercase type, also on Epic
  { id: 106, name: 'Unknown App' },                                 // no appinfo entry: skipped
]);

makeEpic(paths.epic, [
  epicItem('a1', 'Destiny Two™'),
  epicItem('a2', 'Apex Legends?', { description: 'You?re the legend' }), // Epic's broken ™ and ’
  epicItem('a3', 'Big Game: Extra Pack', { mainGameItem: { namespace: 'ns', id: 'a9' } }), // DLC
  epicItem('a4', 'Hogwarts-like Creator Kit', { categories: [{ path: 'engines' }, { path: 'applications' }] }),
  epicItem('a5', 'Unreal Engine', { categories: [{ path: 'engines' }, { path: 'engines/ue5' }] }),
  epicItem('a6', 'Twinmotion 2025', { categories: [{ path: 'software' }, { path: 'applications' }] }),
], [{ CatalogItemId: 'a2', InstallLocation: path.join(tmp, 'Epic Games', 'Apex'), InstallSize: 7e9 }]);

fs.mkdirSync(gogInstall, { recursive: true });
fs.writeFileSync(path.join(gogInstall, 'goggame-1.info'), '{}');
fs.writeFileSync(path.join(gogInstall, 'game.bin'), Buffer.alloc(4096));
fs.mkdirSync(path.dirname(paths.galaxyExe), { recursive: true });
fs.writeFileSync(paths.galaxyExe, '');
makeGog(paths.gog, [
  { key: 'gog_1', title: 'Fallout', minutes: 87, lastPlayed: '2024-12-15 07:22:03', installDir: gogInstall,
    summary: 'War never changes.', meta: { developers: ['Interplay'], releaseDate: 875664000 } },
  { key: 'gog_2', title: 'Fallout - Amazon Luna', visible: false },  // claim stub Galaxy hides
  { key: 'gog_3', title: 'Fallout - Bonus Content', dlc: true },     // DLC
  { key: 'gog_4', title: 'Ultimate DOOM, The', visible: false },     // superseded release Galaxy hides
  { key: 'gog_5', title: 'Mafia II' },
  { key: 'gog_6', title: 'Mafia II' },                               // same title twice in one store: counts once
  { key: 'gog_7', title: 'Mafia II (Classic)' },                     // a different product: counts
]);

const result = await scanAll(path.join(tmp, 'appdata'), paths);
const by = store => result.games.filter(g => g.store === store);
const titles = store => by(store).map(g => g.title).sort();
const find = title => result.games.find(g => g.title === title);

test('no scanner errors or notes on healthy data', () => {
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.notes, []);
});

test('Steam: games and applications, including delisted; no DLC, tools or unknown apps', () => {
  assert.deepEqual(titles('steam'), ['Delisted Classic', 'Destiny Two', 'Half Game', 'Wallpaper App']);
});

test('Epic: games and creator kits; no DLC, Unreal Engine or Twinmotion; "?" damage repaired', () => {
  assert.deepEqual(titles('epic'), ['Apex Legends', 'Destiny Two™', 'Hogwarts-like Creator Kit']);
  assert.equal(find('Apex Legends').info.description, 'You’re the legend');
  assert.equal(find('Destiny Two™').info.description, undefined); // description that only repeats the title
});

test('GOG: Galaxy\'s own DLC/visibility flags; same title counted once; different editions kept', () => {
  assert.deepEqual(titles('gog'), ['Fallout', 'Mafia II', 'Mafia II (Classic)']);
});

test('installed state and launch commands', () => {
  assert.equal(find('Half Game').installed, true);
  assert.deepEqual(find('Half Game').launch.slice(1), ['steam://rungameid/100']);
  assert.deepEqual(find('Delisted Classic').launch.slice(1), ['steam://install/104']);
  assert.equal(find('Apex Legends').installed, true);
  assert.match(find('Apex Legends').launch[1], /^com\.epicgames\.launcher:\/\/apps\/nsa2%3Aa2%3AAppa2\?action=launch/);
  assert.deepEqual(find('Fallout').launch, [paths.galaxyExe, '/command=runGame', '/gameId=1', `/path=${gogInstall}`]);
  assert.deepEqual(find('Mafia II').launch.slice(1), [`goggalaxy://openGameView/${find('Mafia II').id.slice(4)}`]);
});

test('playtime: Steam and GOG known, Epic unknown', () => {
  assert.equal(find('Half Game').playtime, 600);
  assert.equal(find('Half Game').lastPlayed, 1774886983000);
  assert.equal(find('Delisted Classic').playtime, 0);          // tracked, never played
  assert.equal(find('Fallout').playtime, 87);
  assert.equal(find('Fallout').lastPlayed, Date.UTC(2024, 11, 15, 7, 22, 3));
  assert.equal(find('Apex Legends').playtime, null);           // Epic doesn't tell us
});

test('GOG details from Galaxy\'s database', () => {
  assert.equal(find('Fallout').info.description, 'War never changes.');
  assert.deepEqual(find('Fallout').info.developers, ['Interplay']);
});

test('cross-store duplicates', () => {
  assert.deepEqual(result.duplicates.map(d => d.games.map(g => g.store).sort()), [['epic', 'steam']]);
});

test('a missing launcher only affects its own store', async () => {
  const r = await scanAll(path.join(tmp, 'appdata'), { ...paths, epic: path.join(tmp, 'nope') });
  assert.ok(r.errors.epic);
  assert.equal(r.games.filter(g => g.store === 'steam').length, 4);
  assert.equal(r.games.filter(g => g.store === 'gog').length, 3);
});

test('a broken config.json is reported and ignored', async () => {
  fs.mkdirSync(path.join(tmp, 'broken'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'broken', 'config.json'), '{ not json');
  const r = await scanAll(path.join(tmp, 'broken'), paths);
  assert.match(r.notes.join(' '), /config\.json is not valid JSON/);
  assert.equal(r.games.filter(g => g.store === 'steam').length, 4);
});
