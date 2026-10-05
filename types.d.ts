// Types for the page <-> main process contract (preload.cjs). Only for `npm run typecheck`; nothing ships it.

type Store = 'steam' | 'epic' | 'gog';

/** One store's copy of a game, as the page receives it from a scan. */
interface Game {
  id: string;              // "<store>:<store's own id>"
  store: Store;
  key: string;             // normalized title: copies of one game on different stores share it
  title: string;
  cover?: string | null;
  fallback?: string;
  installed: boolean;
  size?: number | null;    // bytes
  drive?: string | null;   // "C:\"
  playtime?: number | null; // minutes; 0 = tracked, never played; null/undefined = not tracked (Epic)
  lastPlayed?: number | null; // ms since epoch
  uninstall: boolean;      // the main process keeps the command; the page only learns whether there is one
}

interface ScanResult {
  games: Game[];
  duplicates: { title: string; games: Game[] }[];
  drives: { root: string; free?: number; total?: number }[];
  errors: Partial<Record<Store, string>>;
  notes: string[];
}

interface Details {
  description?: string;
  developers?: string[];
  publishers?: string[];
  genres?: string[];
  released?: string;
  source?: string;
  offline?: boolean;
}

interface SavedPrefs {
  favorites: string[];
  hidden: string[];
  tags: Record<string, string[]>;
}

/** window.library, from preload.cjs. */
interface Library {
  scan(): Promise<ScanResult>;
  launch(id: string): Promise<boolean>;
  uninstall(id: string): Promise<boolean>;
  exportLibrary(): Promise<string | null>; // file name, or null if cancelled
  details(id: string): Promise<Details | null>;
  prefs(): Promise<SavedPrefs>;
  savePrefs(prefs: SavedPrefs): Promise<SavedPrefs>;
  openSettings(): Promise<void>;
}

interface Window { library: Library }
