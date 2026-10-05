# Playdex privacy policy

Last updated: 5 October 2026

Playdex collects no personal data. It has no accounts, analytics, ads or tracking, and the developer receives nothing from your PC.

## What stays on your PC

- Your game list, which Playdex reads from the Steam, Epic Games and GOG Galaxy files already on your PC.
- Your favorites, hidden games, tags and settings, saved in Playdex's own folder (`%APPDATA%\Playdex`).
- Files you export (CSV or JSON), saved only where you choose.

## What Playdex downloads

Playdex connects only to the stores, and only to show your games:

- **Cover images** from the Steam, Epic Games and GOG image servers.
- **Game details** (description, developer, release date, genres) from the Steam Store when you open a game. It sends the game's Steam ID, or its title if it doesn't have one.
- **Your Steam library**, only if you add your own Steam Web API key and Steam ID to `config.json`. Playdex sends them to Steam's official API (`api.steampowered.com`) to list the games you own. The key stays in `config.json` on your PC and goes only to Steam.

These requests go directly from your PC to Valve, Epic and GOG, and their own privacy policies cover them.
Playdex has no server of its own.

## Uninstalling

Uninstalling removes the app but keeps your settings in `%APPDATA%\Playdex`. Delete that folder to remove them too.
If you installed Playdex from the Microsoft Store, Windows removes that data when you uninstall.

## Contact

Open an issue at https://github.com/Divyansh3105/playdex/issues.
