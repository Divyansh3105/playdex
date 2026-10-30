import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, utilityProcess } from 'electron';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gameDetails } from './details.mjs';
import { loadPrefs, savePrefs, loadSettings, saveSettings } from './prefs.mjs';
import { exportRows, toCsv } from './export.mjs';

const ORIGIN = 'app://playdex/';
const PUBLIC = new URL('./public/', import.meta.url);
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'] }; // and /cover, below
// Only our own script runs; images from our cover cache or https CDNs; no other requests, forms or plugins.
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https:; base-uri 'none'; form-action 'none'";

// Covers, fetched once from the stores' image servers and kept in <userData>/covers, so they show offline too.
// Only these hosts: the URLs come from launcher files other users can edit.
// ponytail: no eviction; a few hundred covers is ~50 MB. Prune by age if libraries get huge.
const COVER_HOSTS = /(^|\.)(steamstatic\.com|epicgames\.com|gog\.com)$/;
const coverUrl = u => (typeof u === 'string' ? `${ORIGIN}cover?u=${encodeURIComponent(u)}` : u);
async function cover(u) {
  let url;
  try { url = new URL(u ?? ''); } catch { return null; }
  if (url.protocol !== 'https:' || !COVER_HOSTS.test(url.hostname)) return null;
  const file = path.join(app.getPath('userData'), 'covers', createHash('sha256').update(url.href).digest('hex'));
  try { return await fs.readFile(file); } catch { /* not cached yet */ }
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r?.ok || !r.headers.get('content-type')?.startsWith('image/')) return null;
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > 10 * 2 ** 20) return null;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`; // whole files only: another request may read it any moment
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, file).catch(() => fs.rm(tmp, { force: true }));
  return body;
}

let games = new Map(); // game id -> game from the last scan, with the launch/uninstall argv scan.mjs built and validated
/** @typedef {ReturnType<typeof import('./scan.mjs').scanAll>} Scan */
/** @type {Scan | null} */
let scanning = null;   // one scan at a time; parallel calls share it

// Scans run in scan-worker.mjs, started on first use and kept for the next scans.
/** @type {Electron.UtilityProcess | null} */
let worker = null;
/** @param {string} dir @returns {Scan} */
function scanInWorker(dir) {
  worker ??= utilityProcess.fork(fileURLToPath(new URL('./scan-worker.mjs', import.meta.url)), [], { serviceName: 'Playdex scanner' });
  const child = worker;
  return new Promise((resolve, reject) => {
    const exited = () => { worker = null; reject(new Error('The scanner stopped unexpectedly. Try Rescan.')); }; // next scan starts a new one
    child.once('exit', exited);
    child.once('message', m => {
      child.off('exit', exited);
      m.error ? reject(new Error(m.error)) : resolve(m.result);
    });
    child.postMessage(dir);
  });
}

// A real origin (instead of file://) so 'self' in the CSP means exactly our two files.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

// IPC must come from our page, not from anything the window might somehow end up showing.
const fromApp = e => e.senderFrame?.url.startsWith(ORIGIN) === true;

app.whenReady().then(() => {
  protocol.handle('app', async req => {
    const url = new URL(req.url);
    if (url.host === 'playdex' && url.pathname === '/cover') { // the image decoder sniffs the type, so none is sent
      const body = await cover(url.searchParams.get('u'));
      return body ? new Response(body) : new Response('Not found', { status: 404 }); // 404: the page tries its fallback
    }
    const file = url.host === 'playdex' && FILES[url.pathname];
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(new URL(file[0], PUBLIC)),
      { headers: { 'content-type': file[1], 'content-security-policy': CSP } });
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false)); // no camera, mic, etc.

  ipcMain.handle('scan', async e => {
    if (!fromApp(e)) throw new Error('Forbidden');
    // %APPDATA%\Playdex: holds config.json (Steam key).
    scanning ??= scanInWorker(app.getPath('userData')).finally(() => { scanning = null; });
    const result = await scanning;
    games = new Map(result.games.map(g => [g.id, g]));
    // Commands stay in this process; the page only sends back a game id. It just learns whether uninstall is possible.
    // Images go through the cover cache.
    return JSON.parse(JSON.stringify(result, (k, v) => (k === 'launch' ? undefined : k === 'uninstall' ? !!v
      : ['cover', 'fallback', 'hero'].includes(k) ? coverUrl(v) : v)));
  });

  const run = argv => {
    if (!argv) return false;
    spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' }) // no shell: args can't be reinterpreted
      .on('error', err => console.error('Launch failed:', err.message)) // missing exe must not crash the app
      .unref();
    return true;
  };
  ipcMain.handle('launch', (e, id) => {
    if (!fromApp(e)) throw new Error('Forbidden');
    return run(games.get(id)?.launch);
  });
  // Hands off to the store, which does the uninstalling (and asks first). Playdex never deletes game files.
  ipcMain.handle('uninstall', (e, id) => {
    if (!fromApp(e)) throw new Error('Forbidden');
    return run(games.get(id)?.uninstall);
  });

  // The last scan plus favorites, hidden and tags, saved where the user picks. The extension picks the format.
  ipcMain.handle('export', async e => {
    if (!fromApp(e)) throw new Error('Forbidden');
    if (!games.size) return null;
    const { canceled, filePath } = await dialog.showSaveDialog(/** @type {BrowserWindow} */ (BrowserWindow.fromWebContents(e.sender)), {
      defaultPath: `Playdex library ${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV (Excel, Google Sheets)', extensions: ['csv'] }, { name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    const rows = exportRows([...games.values()], await loadPrefs(app.getPath('userData')));
    await fs.writeFile(filePath, /\.json$/i.test(filePath) ? JSON.stringify(rows, null, 2) : toCsv(rows));
    return path.basename(filePath);
  });

  // Favorites, hidden games and tags. savePrefs() validates everything the page sends.
  ipcMain.handle('prefs-get', e => {
    if (!fromApp(e)) throw new Error('Forbidden');
    return loadPrefs(app.getPath('userData'));
  });
  ipcMain.handle('prefs-set', (e, prefs) => {
    if (!fromApp(e)) throw new Error('Forbidden');
    return savePrefs(app.getPath('userData'), prefs);
  });

  ipcMain.handle('details', (e, id) => {
    if (!fromApp(e)) throw new Error('Forbidden');
    const game = games.get(id);
    return game ? gameDetails(game) : null;
  });

  // The Settings window: the Steam Web API key and Steam ID in config.json. saveSettings() checks what the page sends.
  ipcMain.handle('settings-get', e => {
    if (!fromApp(e)) throw new Error('Forbidden');
    return loadSettings(app.getPath('userData'));
  });
  ipcMain.handle('settings-set', (e, s) => {
    if (!fromApp(e)) throw new Error('Forbidden');
    return saveSettings(app.getPath('userData'), s);
  });
  // A fixed address: the page can't open anything else.
  ipcMain.handle('open-key-page', e => {
    if (!fromApp(e)) throw new Error('Forbidden');
    return shell.openExternal('https://steamcommunity.com/dev/apikey');
  });

  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 640, minHeight: 480,
    title: 'Playdex', backgroundColor: '#0e1014', autoHideMenuBar: true,
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      sandbox: true, contextIsolation: true, nodeIntegration: false, // Electron defaults, pinned on purpose
    },
  });
  // The page never needs to go anywhere else or open windows.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadURL(ORIGIN);
});

app.on('window-all-closed', () => app.quit());
