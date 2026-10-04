# Playdex

A desktop app (Electron) that shows all your Steam, Epic and GOG games in one place, and finds games you own on more than one store.

![Playdex library: every Steam, Epic and GOG game in one cover grid, with store badges and per-store counts](docs/screenshot-library.jpg)

![Game details: description, developer, release date and genres, with an Install button for each store that owns the game](docs/screenshot-details.jpg)

```
npm install
npm start        # run from source
npm run dist     # build the installer: dist\Playdex Setup <version>.exe
```

Release installers are built by GitHub Actions (`.github/workflows/release.yml`) when a release is published:
it runs the tests, checks the tag matches `package.json`, builds, and attaches the installer with its SHA-256.

The installer is per-user (no admin needed), lets you choose the folder, and adds Start menu + desktop shortcuts.
Settings live in `%APPDATA%\Playdex` and are kept on uninstall.

**The installer isn't code-signed.** Windows SmartScreen will warn ("Windows protected your PC" → More info → Run anyway),
and on PCs with **Smart App Control** turned on Windows blocks it entirely. Signing the installer fixes both
(see "Code signing" below). Until then, use `npm start` on those PCs.

## Where the data comes from (read-only, no logins)

| Store | Owned games | Installed games |
|---|---|---|
| Steam | `appcache/librarycache` folders; name + type from Steam's own `appcache/appinfo.vdf` | `steamapps/appmanifest_*.acf` |
| Epic | `C:\ProgramData\Epic\EpicGamesLauncher\Data\Catalog\catcache.bin` | `...\Data\Manifests\*.item` |
| GOG | Galaxy's `galaxy-2.0.db` (copied to temp before reading) | same DB |

**Counting** matches what each launcher's library shows:
- Steam: apps of type Game or Application (e.g. Wallpaper Engine), including delisted games; no DLC, tools or test configs.
- Epic: games plus creator/mod kits (e.g. Hogwarts Legacy Creator Kit); no DLC, Unreal Engine or Twinmotion.
- GOG: Galaxy's own `isDlc` / `isVisibleInLibrary` flags, so Amazon Prime/Luna claim stubs, bundle entries and
  superseded releases are left out, just like in Galaxy.

The header total counts a game you own on several stores once; each store badge counts its own copy.

## Optional: exact Steam library

Without a key, Playdex reads Steam's local library cache, which normally matches your Steam library.
If it's ever off (e.g. a game you own but have never opened in the Steam client), use the official API:

1. Get a free key at https://steamcommunity.com/dev/apikey (any domain name works, e.g. `localhost`).
2. In the app, click **Settings**. Explorer opens `%APPDATA%\Playdex\config.json`; paste your key and save:
   ```json
   { "steamApiKey": "YOUR_32_CHARACTER_KEY" }
   ```
3. Click **Rescan**.

Your Steam ID is read from Steam's `config/loginusers.vdf`. To use a different account, add `"steamId": "7656119…"`.
`config.json` is git-ignored. Don't share the key, because it acts on your behalf with the Steam Web API.
If the key fails, the app falls back to the local cache and shows why.

## Game details

Clicking a game opens its details: description, developer, publisher, release date and genres, with a
Play/Install button for every store you own it on.

- GOG: all from Galaxy's local database, offline.
- Steam: fetched from the Steam store when you open the game.
- Epic: Epic's local description when it has a real one; otherwise the Steam store page of the same game
  (exact title match only, and labelled as such).

Opening details sends that game's Steam app id or title to `store.steampowered.com`; nothing else leaves your PC.

## Launching

The buttons in the details window open the game through its own launcher (`steam://`, `com.epicgames.launcher://`).
Installed GOG games start directly via `GalaxyClient.exe /command=runGame`, which keeps cloud saves and playtime.
Uninstalled ones open their page in Galaxy.

## Security

- **No network server.** The page talks to the app over Electron IPC (`preload.cjs` exposes only `scan` and `launch`),
  and the main process ignores IPC that doesn't come from the app's own page.
- The page runs sandboxed with context isolation and no Node access. It can't navigate away or open windows,
  all permission requests (camera, mic…) are denied, and it's served from `app://playdex/` with a strict
  Content Security Policy: only `app.js` runs, images load only over https, and no referrer is sent.
- Epic's and GOG's data folders are writable by every Windows user, so their contents are treated as untrusted:
  launch commands only accept exact URI shapes (`uriLaunch`), GOG installs must contain their `goggame-<id>.info`,
  and nothing runs through a shell. The page only sends a game id; launch commands never leave the main process.
- Remaining risk: another user who can edit Galaxy's database could point an installed game at a different folder
  that has a matching `.info` file. Galaxy itself trusts that database too, so this app adds no new risk there.

- The packaged exe has Electron's hardening fuses set: it can't be run as a plain Node.js runtime
  (`ELECTRON_RUN_AS_NODE`), ignores `NODE_OPTIONS` and `--inspect`, and refuses to start if its `app.asar` was modified.

## Code signing

To sign, add a certificate to electron-builder (`win.signtoolOptions` or Azure Artifact Signing via `win.azureSignOptions`),
then `npm run dist`. A signed installer passes Smart App Control and builds SmartScreen reputation over time.

`npm test` covers title matching, de-duplication, Steam ID detection and launch validation.

## License

[MIT](LICENSE) © 2026 Divyansh Garg
