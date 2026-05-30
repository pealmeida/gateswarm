/**
 * Model & Response Cache — IndexedDB with LRU eviction
 */

import type { CacheEntry } from './types.js';

const DB_NAME = 'moma-cache';
const DB_VERSION = 1;
const MODELS_STORE = 'models';
const RESPONSES_STORE = 'responses';
const MAX_RESPONSE_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RESPONSES = 100;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MODELS_STORE)) {
        db.createObjectStore(MODELS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(RESPONSES_STORE)) {
        const store = db.createObjectStore(RESPONSES_STORE, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ─── Model Cache ────────────────────────────────────────

export class ModelCache {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    this.db = await openDB();
  }

  async getModel(key: string): Promise<ArrayBuffer | null> {
    if (!this.db) return null;
    const tx = this.db.transaction(MODELS_STORE, 'readonly');
    const store = tx.objectStore(MODELS_STORE);
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async setModel(key: string, value: ArrayBuffer, size?: number): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(MODELS_STORE, 'readwrite');
    const store = tx.objectStore(MODELS_STORE);
    const entry: CacheEntry<ArrayBuffer> = { key, value, timestamp: Date.now(), size: size ?? value.byteLength };
    return new Promise((resolve, reject) => {
      const req = store.put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async isCached(key: string): Promise<boolean> {
    const model = await this.getModel(key);
    return model !== null;
  }

  async getCacheSize(): Promise<number> {
    if (!this.db) return 0;
    const tx = this.db.transaction(MODELS_STORE, 'readonly');
    const store = tx.objectStore(MODELS_STORE);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const entries: CacheEntry<any>[] = req.result ?? [];
        resolve(entries.reduce((sum, e) => sum + (e.size ?? 0), 0));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async evictLRU(neededBytes: number): Promise<void> {
    if (!this.db) return;
    // Simple LRU: delete oldest entries until we have enough space
    const tx = this.db.transaction(MODELS_STORE, 'readwrite');
    const store = tx.objectStore(MODELS_STORE);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const entries: CacheEntry<any>[] = (req.result ?? []).sort(
          (a, b) => a.timestamp - b.timestamp
        );
        let freed = 0;
        for (const entry of entries) {
          if (freed >= neededBytes) break;
          store.delete(entry.key);
          freed += entry.size ?? 0;
        }
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }
}

// ─── Response Cache ─────────────────────────────────────

export class ResponseCache {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    this.db = await openDB();
  }

  async get(prompt: string): Promise<string | null> {
    if (!this.db) return null;
    const key = this.hashKey(prompt);
    const tx = this.db.transaction(RESPONSES_STORE, 'readonly');
    const store = tx.objectStore(RESPONSES_STORE);
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => {
        const entry = req.result as CacheEntry<string> | undefined;
        if (!entry) return resolve(null);
        // Check expiration
        if (Date.now() - entry.timestamp > MAX_RESPONSE_AGE_MS) {
          resolve(null);
          return;
        }
        resolve(entry.value);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async set(prompt: string, response: string): Promise<void> {
    if (!this.db) return;
    const key = this.hashKey(prompt);
    const tx = this.db.transaction(RESPONSES_STORE, 'readwrite');
    const store = tx.objectStore(RESPONSES_STORE);

    // Enforce max entries
    await this.enforceMaxEntries(store);

    const entry: CacheEntry<string> = {
      key,
      value: response,
      timestamp: Date.now(),
      size: response.length * 2, // rough UTF-16 size
    };

    return new Promise((resolve, reject) => {
      const req = store.put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async enforceMaxEntries(store: IDBObjectStore): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const entries: CacheEntry<string>[] = (req.result ?? []).sort(
          (a, b) => a.timestamp - b.timestamp
        );
        // Delete oldest if over limit
        while (entries.length >= MAX_RESPONSES) {
          const oldest = entries.shift();
          if (oldest) store.delete(oldest.key);
        }
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  private hashKey(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32-bit int
    }
    return `resp_${Math.abs(hash).toString(36)}`;
  }
}
