/** The part of `Storage` the lessons use; tests pass an in-memory one. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

/** `localStorage` (kept by Electron in userData), or memory when it is unavailable. */
export function browserStore(): KeyValueStore {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // access can throw when storage is disabled
  }
  return memoryStore();
}

export function readJson<T>(store: KeyValueStore, key: string, fallback: T): T {
  try {
    const raw = store.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(store: KeyValueStore, key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`[lessons] could not save ${key}`, e);
  }
}
