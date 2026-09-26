// Tiny IndexedDB wrapper for draft photos (too large for localStorage).
const DB = 'dcr-drafts';
const STORE = 'photos';

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out?.result ?? out);
      t.onerror = () => reject(t.error);
    });
  } catch {
    return null; // Private mode or blocked storage: drafts simply are not kept.
  }
}

export const photoStore = {
  put: (rec) => tx('readwrite', (s) => s.put(rec)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
  all: async () => (await tx('readonly', (s) => s.getAll())) ?? [],
};
