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
// Delta's title is too long for a card, so it must be cut short, not widen its column.
const DELTA = "Delta's Very Long Journey Through the Forgotten Kingdoms";
const alpha = game('steam', 1, 'Alpha', { installed: true, uninstall: true, size: 10 * GB, drive: 'C:\\', playtime: 600, lastPlayed: Date.now() - 2 * 864e5 });
const GAMES = [
  alpha,
  game('epic', 'a2', 'Alpha'),
  game('gog', 3, 'Beta', { installed: true, size: 5 * GB, drive: 'C:\\', playtime: 0 }),
  game('epic', 'd4', DELTA),
  game('steam', 5, 'Gamma', { playtime: 90, lastPlayed: Date.now() - 300 * 864e5 }), // idle for 10 months
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
      launch: async () => true, uninstall: async () => true, exportLibrary: async () => null, openKeyPage: async () => {},
      settings: async () => ({ steamApiKey: '', steamId: '' }),
      saveSettings: async s => { // like prefs.mjs saveSettings(): rejects a malformed key
        if (s.steamApiKey && !/^[0-9a-f]{32}$/i.test(s.steamApiKey)) throw new Error('A Steam Web API key is 32 letters and digits.');
        return s;
      },
    };
  }, SCAN);
  await page.goto(PAGE);
  await page.locator('.card').first().waitFor();
});
afterEach(() => page.close());

// The main Library grid (not the Recently played row): one card per game, and each card's stores.
const names = () => page.locator('#games .name').allTextContents();
const stores = () => page.locator('#games .card').evaluateAll(cards => cards.map(c => [...c.querySelectorAll('.store')].map(s => s.textContent).join('+')));

test('header counts a game owned twice once, and once per store', async () => {
  assert.equal(await page.locator('#stats').textContent(), '4 gamesSteam 2Epic 2GOG 1');
  assert.equal(await page.locator('#dup-count').textContent(), '1');
});

test('Stats tab: totals, hours, share played, disk use, per store', async () => {
  await page.click('#tab-stats');
  const tiles = await page.locator('.tile').allInnerTexts();
  assert.deepEqual(tiles.map(t => t.replace(/\s+/g, ' ')), [
    '4 games', '2 installed',
    '12 h played in total',      // 600 + 90 + 0 min = 11.5 h, rounded
    '67% played (1 not yet)',    // Alpha and Gamma of the 3 tracked games (Epic doesn't count)
    '15.0 GB on disk',
    '2 Steam · 12 h played', '2 Epic · playtime not tracked', '1 GOG · 0 h played',
  ]);
  assert.deepEqual(await page.locator('.statlist .title .link').allTextContents(), ['Alpha', 'Gamma']); // most played
});

test('a game owned on two stores is one card; store filters, search and the Show menu filter it', async () => {
  assert.deepEqual(await names(), ['Alpha', 'Beta', DELTA, 'Gamma']);
  assert.deepEqual(await stores(), ['Steam+Epic', 'GOG', 'Epic', 'Steam']);
  await page.click('#filter-steam');
  assert.deepEqual(await stores(), ['Epic', 'GOG', 'Epic']);
  await page.click('#filter-steam');
  await page.fill('#q', 'ALP');
  assert.deepEqual(await stores(), ['Steam+Epic']);
  await page.fill('#q', 'deltas');
  assert.deepEqual(await names(), [DELTA]); // search ignores punctuation
  await page.fill('#q', '');
  await page.selectOption('#show', 'unplayed');
  assert.deepEqual(await names(), ['Beta']); // Epic games never count as not played
  await page.selectOption('#show', 'installed');
  assert.deepEqual(await names(), ['Alpha', 'Beta']);
});

test('Recently played row: installed games you played, only on the plain library', async () => {
  assert.deepEqual(await page.locator('.recent .name').allTextContents(), ['Alpha']);
  await page.fill('#q', 'a');
  assert.equal(await page.locator('.recent').count(), 0);
});

test('a long title keeps its card the width of the others', async () => {
  const widths = await page.locator('.card').evaluateAll(cards => cards.map(c => Math.round(c.getBoundingClientRect().width)));
  assert.equal(new Set(widths).size, 1, `card widths: ${widths}`);
});

test('installed games have a Play button; Library-only controls hide on other tabs', async () => {
  assert.equal(await page.locator('#games .quick').count(), 2); // Alpha (its Steam copy), Beta
  await page.locator('.cell').first().hover();
  await page.click('.quick >> nth=0');
  assert.equal(await page.textContent('#toast:popover-open'), 'Opening Alpha in Steam…');
  await page.click('#tab-stats');
  assert.deepEqual(await Promise.all(['#sort', '#show', '#pick'].map(s => page.isHidden(s))), [true, true, true]);
});

test('sort by playtime puts untracked (Epic) games last', async () => {
  await page.selectOption('#sort', 'playtime');
  assert.deepEqual(await names(), ['Alpha', 'Gamma', 'Beta', DELTA]);
});

test('Duplicates hint counts what the search leaves', async () => {
  await page.click('#tab-dups');
  assert.match(await page.textContent('.hint'), /^You own 1 games on more than one store/);
  await page.fill('#q', 'beta');
  assert.match(await page.textContent('.hint'), /^0 of the 1 games you own on more than one store match/);
});

test('keyboard shortcuts: / search, Esc clear, 1–4 tabs, arrow keys, P pick', async () => {
  await page.keyboard.press('/');
  await page.keyboard.type('gam');
  assert.deepEqual(await names(), ['Gamma']);
  await page.keyboard.press('Escape');
  assert.equal(await page.inputValue('#q'), '');
  assert.equal((await names()).length, 4);
  await page.keyboard.press('Escape'); // second Esc leaves the search box, so number keys switch tabs
  await page.keyboard.press('4');
  assert.equal(await page.getAttribute('#tab-stats', 'aria-selected'), 'true');
  await page.focus('#tab-stats');
  await page.keyboard.press('ArrowRight'); // wraps around
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'tab-library');
  await page.keyboard.press('End');
  assert.equal(await page.getAttribute('#tab-stats', 'aria-selected'), 'true');
  await page.keyboard.press('1');
  await page.keyboard.press('p');
  await page.locator('#details[open]').waitFor();
  assert.ok(['Alpha', 'Beta'].includes(await page.textContent('#details-title'))); // installed games first
});

test('details window: a button per store, Uninstall for installed copies; favorite applies to every copy', async () => {
  await page.locator('#games .card').first().click();
  assert.deepEqual(await page.locator('#details .stores button').allTextContents(),
    ['▶ Play · Steam', '⬇ Install · Epic', 'Uninstall from Steam…']);
  await page.click('text=☆ Favorite');
  assert.equal(await page.getAttribute('.toggle-btn >> nth=0', 'aria-pressed'), 'true');
  await page.click('#details-close');
  await page.selectOption('#show', 'favorites');
  assert.deepEqual(await stores(), ['Steam+Epic']);
  await page.click('#filter-steam');
  assert.deepEqual(await stores(), ['Epic']); // the Epic copy is a favorite too
  assert.equal(await page.locator('.card .fav').count(), 1);
});

test('a change that fails to save is undone on screen', async () => {
  await page.evaluate(() => { window.library.savePrefs = async () => { throw new Error('disk full'); }; });
  await page.locator('#games .card').first().click();
  await page.click('text=☆ Favorite');
  assert.equal(await page.textContent('#toast:popover-open'), 'Could not save your change.'); // above the details window
  assert.equal(await page.getAttribute('.toggle-btn >> nth=0', 'aria-pressed'), 'false');
});

test('Settings window: a malformed key is refused; a good one is saved and rescanned', async () => {
  await page.click('#settings');
  await page.fill('#steam-key', 'not-a-key');
  await page.click('#settings-save');
  await page.locator('#settings-status.bad').waitFor();
  assert.equal(await page.textContent('#settings-status'), 'A Steam Web API key is 32 letters and digits.');
  await page.fill('#steam-key', 'a'.repeat(32));
  await page.keyboard.press('Enter');
  await page.locator('#settings-status', { hasText: 'Done' }).waitFor();
  assert.equal(await page.textContent('#settings-status'), 'Done: 2 Steam games from your key.');
});

test('Show → Not played in 6 months: played games idle that long', async () => {
  await page.selectOption('#show', 'stale');
  assert.deepEqual(await names(), ['Gamma']); // Alpha was played 2 days ago
  assert.match(await page.textContent('#show option[value="stale"]'), /\(1\)$/);
});

test('"Same game as…" links two names into one game, and Unlink undoes it', async () => {
  await page.locator('#games .card', { hasText: 'Beta' }).click();
  await page.fill('#same-input', 'Gamma (Steam)');
  await page.press('#same-input', 'Enter');
  await page.locator('text=Linked by you · Unlink').waitFor();
  assert.deepEqual(await page.locator('#details .stores .play').allTextContents(), ['⬇ Install · Steam', '▶ Play · GOG']);
  assert.equal(await page.textContent('#dup-count'), '2');
  assert.deepEqual(await stores(), ['Steam+Epic', 'Steam+GOG', 'Epic']); // Alpha, Beta + Gamma, Delta
  await page.click('text=Linked by you · Unlink');
  await page.locator('#same-input').waitFor();
  assert.equal(await page.textContent('#dup-count'), '1');
  assert.equal((await names()).length, 4);
});
