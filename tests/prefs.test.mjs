import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanPrefs, loadPrefs, savePrefs } from '../prefs.mjs';

test('cleanPrefs keeps well-formed data only', () => {
  const p = cleanPrefs({
    favorites: ['steam:100', 'steam:100', 'epic:a1b2', 'nope:1', 'steam:1 2', 42, null],
    hidden: 'steam:100',                                       // not a list
    tags: {
      'gog:gog_1': ['  Co-op ', 'co-op', 'Co-op', 'x'.repeat(50), '', 7, 'Line\nbreak\u0007'],
      'evil:1': ['x'],                                         // bad id
      'steam:5': 'not a list',
      'steam:6': [],                                           // nothing left: dropped
    },
  });
  assert.deepEqual(p.favorites, ['steam:100', 'epic:a1b2']);
  assert.deepEqual(p.hidden, []);
  assert.deepEqual(Object.keys(p.tags), ['gog:gog_1']);
  assert.deepEqual(p.tags['gog:gog_1'], ['Co-op', 'co-op', 'x'.repeat(32), 'Line break']);
  assert.deepEqual(cleanPrefs(null), { favorites: [], hidden: [], tags: {} });
  assert.deepEqual(cleanPrefs({ tags: ['a'] }).tags, {});
});

test('cleanPrefs: no prototype tricks, size limits', () => {
  const p = cleanPrefs(JSON.parse('{"tags": {"__proto__": ["x"], "steam:1": ["a"]}}'));
  assert.deepEqual(Object.keys(p.tags), ['steam:1']);
  assert.equal({}.x, undefined);
  assert.equal(cleanPrefs({ tags: { 'steam:1': Array.from({ length: 50 }, (_, i) => `t${i}`) } }).tags['steam:1'].length, 20);
});

test('save then load round-trips; saves are cleaned and atomic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playdex-prefs-'));
  assert.deepEqual(await loadPrefs(dir), { favorites: [], hidden: [], tags: {} }); // first run
  await Promise.all([ // overlapping saves: last one wins, no .tmp left behind
    savePrefs(dir, { favorites: ['steam:1'], hidden: [], tags: {} }),
    savePrefs(dir, { favorites: ['steam:1', 'bad'], hidden: ['epic:x'], tags: { 'gog:gog_2': ['RPG'] } }),
  ]);
  assert.deepEqual(await loadPrefs(dir), { favorites: ['steam:1'], hidden: ['epic:x'], tags: { 'gog:gog_2': ['RPG'] } });
  assert.deepEqual(fs.readdirSync(dir), ['library.json']);
});

test('an unreadable file is kept as a backup, not overwritten', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playdex-prefs-'));
  fs.writeFileSync(path.join(dir, 'library.json'), '{ broken');
  assert.deepEqual(await loadPrefs(dir), { favorites: [], hidden: [], tags: {} });
  const backup = fs.readdirSync(dir).find(f => f.startsWith('library.json.bad-'));
  assert.ok(backup);
  assert.equal(fs.readFileSync(path.join(dir, backup), 'utf8'), '{ broken');
});
