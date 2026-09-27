// Tiny IndexedDB wrapper for draft photos (too large for localStorage).
// Every call gives up after a few seconds: a blocked or broken database must never
// freeze the app — drafts are a convenience, not a requirement.
const DB = 'dcr-drafts';
const STORE = 'photos';
const TIMEOUT_MS = 4000;

let dbPromise;
function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  }).catch((e) => { dbPromise = null; throw e; });
  return dbPromise;
}

function withTimeout(promise) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS))]);
}

async function tx(mode, fn) {
  try {
    return await withTimeout((async () => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const out = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(out?.result ?? out);
        t.onerror = () => reject(t.error);
      });
    })());
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
