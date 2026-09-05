/** IndexedDB 轻封装：docs（流程图文档库）+ kv（应用元数据）。
 *  仅浏览器可用；vitest/node 下所有函数安全 no-op。 */

const DB_NAME = 'flow-app-db';
const DB_VER = 1;
export const DOCS_STORE = 'docs'; // keyPath: id
export const KV_STORE = 'kv'; // keyPath: key

const isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!isBrowser) return Promise.reject(new Error('indexedDB unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        db.createObjectStore(DOCS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(KV_STORE)) {
        db.createObjectStore(KV_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      })
  );
}

export function dbGet<T>(store: string, key: string): Promise<T | undefined> {
  if (!isBrowser) return Promise.resolve(undefined);
  return tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export function dbGetAll<T>(store: string): Promise<T[]> {
  if (!isBrowser) return Promise.resolve([]);
  return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
}

export function dbPut(store: string, value: unknown): Promise<void> {
  if (!isBrowser) return Promise.resolve();
  return tx(store, 'readwrite', (s) => s.put(value) as IDBRequest<IDBValidKey>).then(() => undefined);
}

export function dbDelete(store: string, key: string): Promise<void> {
  if (!isBrowser) return Promise.resolve();
  return tx(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>).then(() => undefined);
}

export async function dbClear(store: string): Promise<void> {
  if (!isBrowser) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
