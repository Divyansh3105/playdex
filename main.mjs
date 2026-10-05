import { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanAll } from './scan.mjs';
import { gameDetails } from './details.mjs';
import { loadPrefs, savePrefs } from './prefs.mjs';
import { exportRows, toCsv } from './export.mjs';

const ORIGIN = 'app://playdex/';
const PUBLIC = new URL('./public/', import.meta.url);
const FILES = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'] }; // nothing else is served
// Only our own script runs; images only from https CDNs; no other requests, forms or plugins.
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src https:; base-uri 'none'; form-action 'none'";

let games = new Map(); // game id -> game from the last scan, with the launch/uninstall argv scan.mjs built and validated
/** @type {ReturnType<typeof scanAll> | null} */
let scanning = null;   // one scan at a time; parallel calls share it

// A real origin (instead of file://) so 'self' in the CSP means exactly our two files.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);

// IPC must come from our page, not from anything the window might somehow end up showing.
const fromApp = e => e.senderFrame?.url.startsWith(ORIGIN) === true;

app.whenReady().then(() => {
  protocol.handle('app', async req => {
    const url = new URL(req.url);
    const file = url.host === 'playdex' && FILES[url.pathname];
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(new URL(file[0], PUBLIC)),
      { headers: { 'content-type': file[1], 'content-security-policy': CSP } });
  });

  session.defaultSession.setPermissionRequestHandler((_wc, _permission, done) => done(false)); // no camera, mic, etc.

  ipcMain.handle('scan', async e => {
    if (!fromApp(e)) throw new Error('Forbidden');
    // %APPDATA%\Playdex: holds config.json (Steam key).
    scanning ??= scanAll(app.getPath('userData')).finally(() => { scanning = null; });
    const result = await scanning;
    games = new Map(result.games.map(g => [g.id, g]));
    // Commands stay in this process; the page only sends back a game id. It just learns whether uninstall is possible.
    return JSON.parse(JSON.stringify(result, (k, v) => (k === 'launch' ? undefined : k === 'uninstall' ? !!v : v)));
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

  // Show config.json in Explorer (creating an empty one first) so users can paste a Steam API key.
  ipcMain.handle('open-settings', async e => {
    if (!fromApp(e)) throw new Error('Forbidden');
    const file = path.join(app.getPath('userData'), 'config.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{\n  "steamApiKey": ""\n}\n', { flag: 'wx' }).catch(() => {}); // never overwrite
    shell.showItemInFolder(file);
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
