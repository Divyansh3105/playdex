// Runs scans in an Electron utility process, so reading launcher files never stalls the window.
// It stays up between scans, so scan.mjs's caches (GOG install sizes) last the whole session.
import { scanAll } from './scan.mjs';

process.parentPort.on('message', async ({ data: dir }) => {
  try { process.parentPort.postMessage({ result: await scanAll(dir) }); }
  catch (e) { process.parentPort.postMessage({ error: e.message }); }
});
