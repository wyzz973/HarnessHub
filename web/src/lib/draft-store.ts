/**
 * Where the composer's drafts are kept between reloads (2026-11-12). sessionStorage first, as before: it is written at once, so even the
 * keystroke just before a reload is kept. A draft larger than its few megabytes (the Gateway takes a message of 32 MiB) goes to IndexedDB,
 * whose quota is the disk's, and its sessionStorage copy is removed so that no older, smaller one is read in its place. A draft stays this
 * tab's either way: its IndexedDB key starts with a tab identity kept in sessionStorage, which a reload keeps and a new tab does not have.
 *
 * IndexedDB is read once when the page opens (`load`), so a draft is read at once; its writes are gathered for at most `WRITE_MS`, and a page
 * that is hidden or closed writes at once. A write that fails everywhere says so once through `onFailure`; the draft is still in the page.
 */
const DATABASE = "harnesshub-drafts", STORE = "drafts", TAB_KEY = "harnesshub:draft-tab", WRITE_MS = 300;
/** Drafts of tabs not seen for this long are removed when a page opens: a closed tab's drafts are not read again. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;

interface Row { readonly key: string; readonly tab: string; readonly value: string; readonly savedAt: number }

function tabIdentity(): string {
  try {
    const known = sessionStorage.getItem(TAB_KEY);
    if (known !== null && /^[a-z0-9-]{8,64}$/u.test(known)) return known;
    const made = crypto.randomUUID(); sessionStorage.setItem(TAB_KEY, made); return made;
  } catch { return "tab-" + Math.random().toString(36).slice(2, 12); }
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed")); });
}
function open(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    let opening: IDBOpenDBRequest;
    try { opening = indexedDB.open(DATABASE, 1); } catch { resolve(null); return; }
    opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE, { keyPath: "key" }); };
    opening.onsuccess = () => resolve(opening.result);
    opening.onerror = () => resolve(null);
    opening.onblocked = () => resolve(null);
  });
}

export class DraftStore {
  private readonly loaded = new Map<string, string>();
  private readonly pending = new Map<string, string | null>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failed = false;
  private constructor(private readonly database: IDBDatabase | null, private readonly tab: string, private readonly onFailure: () => void, private readonly onSaved: () => void) {}

  /** Opens the store and reads this tab's drafts; never rejects (without IndexedDB it keeps them in sessionStorage). */
  static async load(onFailure: () => void, onSaved: () => void): Promise<DraftStore> {
    const tab = tabIdentity(), database = typeof indexedDB === "undefined" ? null : await open();
    const store = new DraftStore(database, tab, onFailure, onSaved);
    if (database !== null) {
      try {
        const rows = await request(database.transaction(STORE, "readonly").objectStore(STORE).getAll()) as Row[], now = Date.now(), stale: string[] = [];
        for (const row of rows) {
          if (row.tab === tab) store.loaded.set(row.key.slice(tab.length + 1), row.value);
          else if (now - row.savedAt > KEEP_MS) stale.push(row.key);
        }
        if (stale.length) { const removing = database.transaction(STORE, "readwrite").objectStore(STORE); for (const key of stale) removing.delete(key); }
      } catch { /* Nothing read: the page starts without saved drafts. */ }
    }
    if (typeof window !== "undefined") { window.addEventListener("pagehide", () => store.flush()); document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") store.flush(); }); }
    return store;
  }
  /** The draft saved under `key` (this tab's), or null: sessionStorage's copy when there is one, else the larger one IndexedDB keeps. */
  read(key: string): string | null {
    try { const kept = sessionStorage.getItem(key); if (kept !== null) return kept; } catch { /* not readable here */ }
    if (this.pending.has(key)) return this.pending.get(key) ?? null;
    return this.loaded.get(key) ?? null;
  }
  /**
   * Keeps `value` under `key` within WRITE_MS; null removes it. The first write that waits sets the time and later ones join it (a page that
   * re-renders all the time, a reply streaming, would otherwise put a write that waits for quiet off for ever).
   */
  write(key: string, value: string | null): void {
    if (value !== null) {
      try { sessionStorage.setItem(key, value); this.saved(); if (!this.loaded.has(key) && !this.pending.has(key)) return; value = null; }
      catch { try { sessionStorage.removeItem(key); } catch { /* nothing kept there */ } }
    } else { try { sessionStorage.removeItem(key); } catch { /* nothing kept there */ } }
    // A draft that fit in sessionStorage removes the larger IndexedDB copy it replaces (`value` null then); one that did not goes to IndexedDB.
    if (this.database === null) { if (value !== null) this.failure(); return; }
    this.pending.set(key, value);
    this.timer ??= setTimeout(() => this.flush(), WRITE_MS);
  }
  /** Writes what waits now. */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending.size === 0) return;
    const writes = [...this.pending.entries()]; this.pending.clear();
    for (const [key, value] of writes) { if (value === null) this.loaded.delete(key); else this.loaded.set(key, value); }
    if (this.database === null) return;
    try {
      const transaction = this.database.transaction(STORE, "readwrite"), store = transaction.objectStore(STORE), savedAt = Date.now();
      for (const [key, value] of writes) { if (value === null) store.delete(this.tab + ":" + key); else store.put({ key: this.tab + ":" + key, tab: this.tab, value, savedAt } satisfies Row); }
      transaction.oncomplete = () => { if (writes.some(([, value]) => value !== null)) this.saved(); };
      transaction.onerror = () => this.failure(); transaction.onabort = () => this.failure();
    } catch { this.failure(); }
  }
  private saved(): void { if (this.failed) { this.failed = false; this.onSaved(); } }
  /** Said once until a write succeeds again. */
  private failure(): void { if (!this.failed) { this.failed = true; this.onFailure(); } }
}
