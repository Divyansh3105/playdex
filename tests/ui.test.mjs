// End-to-end tests of the page (public/), in Microsoft Edge through Playwright, with a fake window.library in place
// of the Electron preload. Edge ships with Windows and GitHub's Windows runners, so there's no browser to download.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const PAGE = new URL('../public/index.html', import.meta.url).href;
const GB = 2 ** 30;
const game = (store, id, title, more) => ({ id: `${store}:${id}`, store, key: title.toLowerCase(), title, cover: null,
  installed: false, size: null, drive: null, playtime: null, lastPlayed: null, uninstall: false, ...more });

// Alpha is owned twice (Steam + Epic). Epic never tracks playtime. Beta is tracked but never played.
const alpha = game('steam', 1, 'Alpha', { installed: true, size: 10 * GB, drive: 'C:\\', playtime: 600, lastPlayed: Date.now() - 2 * 864e5 });
const GAMES = [
  alpha,
  game('epic', 'a2', 'Alpha'),
  game('gog', 3, 'Beta', { installed: true, size: 5 * GB, drive: 'C:\\', playtime: 0 }),
  game('epic', 'd4', 'Delta'),
  game('steam', 5, 'Gamma', { playtime: 90 }),
];
const SCAN = { games: GAMES, duplicates: [{ title: 'Alpha', games: [GAMES[0], GAMES[1]] }], errors: {}, notes: [],
  drives: [{ root: 'C:\\', total: 100 * GB, free: 50 * GB }] };

let browser, page;
before(async () => { browser = await chromium.launch({ channel: 'msedge' }); });
after(() => browser?.close());
beforeEach(async () => {
  page = await browser.newPage();
  await page.addInitScript(scan => {
    window.library = {
      scan: async () => scan,
      prefs: async () => ({ favorites: [], hidden: [], tags: {} }),
      savePrefs: async p => p,
      details: async () => ({ description: 'Fake description' }),
      launch: async () => true, uninstall: async () => true, exportLibrary: async () => null, openSettings() {},
    };
  }, SCAN);
  await page.goto(PAGE);
  await page.locator('.card').first().waitFor();
});
afterEach(() => page.close());

const names = () => page.locator('.card .name').allTextContents();
const stores = () => page.locator('.card .badge').allTextContents();

test('header counts a game owned twice once, and once per store', async () => {
  assert.equal(await page.locator('#stats').textContent(), '4 gamesSteam 2Epic 2GOG 1');
  assert.equal(await page.locator('#dup-count').textContent(), '1');
});

test('Stats tab: totals, hours, share played, disk use', async () => {
  await page.click('#tab-stats');
  const tiles = await page.locator('.tile').allInnerTexts();
  assert.deepEqual(tiles.map(t => t.replace(/\s+/g, ' ')), [
    '4 games', '2 installed',
    '12 h played in total',      // 600 + 90 + 0 min = 11.5 h, rounded
    '67% played (1 not yet)',    // Alpha and Gamma of the 3 tracked games (Epic doesn't count)
    '15.0 GB on disk',
  ]);
  assert.deepEqual(await page.locator('.statlist .title .link').allTextContents(), ['Alpha', 'Gamma']); // most played
});

test('store chips, search and the Show menu filter the library', async () => {
  assert.deepEqual(await names(), ['Alpha', 'Alpha', 'Beta', 'Delta', 'Gamma']);
  await page.click('.chip.steam');
  assert.deepEqual(await stores(), ['Epic', 'GOG', 'Epic']);
  await page.click('.chip.steam');
  await page.fill('#q', 'ALP');
  assert.deepEqual(await stores(), ['Steam', 'Epic']);
  await page.fill('#q', '');
  await page.selectOption('#show', 'unplayed');
  assert.deepEqual(await names(), ['Beta']); // Epic games never count as not played
  await page.selectOption('#show', 'installed');
  assert.deepEqual(await names(), ['Alpha', 'Beta']);
});

test('sort by playtime puts untracked (Epic) games last', async () => {
  await page.selectOption('#sort', 'playtime');
  assert.deepEqual(await names(), ['Alpha', 'Gamma', 'Beta', 'Alpha', 'Delta']);
  assert.deepEqual(await stores(), ['Steam', 'Steam', 'GOG', 'Epic', 'Epic']);
});

test('keyboard shortcuts: / search, Esc clear, 1–4 tabs, P pick', async () => {
  await page.keyboard.press('/');
  await page.keyboard.type('gam');
  assert.deepEqual(await names(), ['Gamma']);
  await page.keyboard.press('Escape');
  assert.equal(await page.inputValue('#q'), '');
  assert.equal((await names()).length, 5);
  await page.keyboard.press('Escape'); // second Esc leaves the search box, so number keys switch tabs
  await page.keyboard.press('4');
  assert.equal(await page.getAttribute('#tab-stats', 'aria-selected'), 'true');
  await page.keyboard.press('1');
  await page.keyboard.press('p');
  await page.locator('#details[open]').waitFor();
  assert.ok(['Alpha', 'Beta'].includes(await page.textContent('#details-title'))); // installed games first
});

test('favorite a game from its details window', async () => {
  await page.locator('.card').first().click();
  await page.click('text=☆ Favorite');
  assert.equal(await page.getAttribute('.toggle-btn >> nth=0', 'aria-pressed'), 'true');
  await page.click('#details-close');
  await page.selectOption('#show', 'favorites');
  assert.deepEqual(await stores(), ['Steam']);
  assert.equal(await page.locator('.card .fav').count(), 1);
});
