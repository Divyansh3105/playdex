import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportRows, toCsv } from '../export.mjs';

test('export rows and CSV', () => {
  const rows = exportRows([
    { id: 'steam:1', store: 'steam', title: 'Half, "Game"', installed: true, playtime: 90, lastPlayed: 0, size: 2048, drive: 'D:\\' },
    { id: 'epic:a', store: 'epic', title: '=HYPERLINK("http://x")', installed: false, playtime: null },
  ], { favorites: ['steam:1'], hidden: ['epic:a'], tags: { 'steam:1': ['co-op', '@home'] } });
  assert.deepEqual(rows[1], { store: 'epic', title: '=HYPERLINK("http://x")', installed: false, playtimeMinutes: null,
    lastPlayed: null, sizeBytes: null, drive: null, favorite: false, hidden: true, tags: [] });
  const lines = toCsv(rows).split('\r\n');
  assert.equal(lines[0], '\uFEFFstore,title,installed,playtimeMinutes,lastPlayed,sizeBytes,drive,favorite,hidden,tags');
  assert.equal(lines[1], 'steam,"Half, ""Game""",true,90,,2048,D:\\,true,false,co-op; @home');
  assert.equal(lines[2], `epic,"'=HYPERLINK(""http://x"")",false,,,,,false,true,`); // formula neutralized
  assert.equal(lines[3], '');
});
