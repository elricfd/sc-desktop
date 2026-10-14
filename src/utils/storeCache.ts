/** electron-store re-reads and re-decrypts config on every get(), and settings are hot-path: cache it,
 * drop on any write via same instance; only plain top-level keys cached, dot-paths go to original */

interface CacheableStore {
    get(key: string, defaultValue?: unknown): unknown;
    set(...args: unknown[]): void;
    delete(key: string): void;
    clear(): void;
    store: Record<string, unknown>;
}

export function installStoreReadCache<T extends CacheableStore>(store: T): T {
    let cache: Record<string, unknown> | null = null;

    const originalGet = store.get.bind(store);
    const originalSet = store.set.bind(store);
    const originalDelete = store.delete.bind(store);
    const originalClear = store.clear.bind(store);

    const invalidate = (): void => {
        cache = null;
    };

    const readAll = (): Record<string, unknown> => {
        if (cache === null) cache = { ...store.store };
        return cache;
    };

    store.get = (key: string, defaultValue?: unknown): unknown => {
        if (typeof key !== 'string' || key.includes('.')) {
            return originalGet(key, defaultValue);
        }

        const all = readAll();
        const value = all[key];
        return value === undefined ? defaultValue : value;
    };

    store.set = (...args: unknown[]): void => {
        invalidate();
        originalSet(...args);
    };

    store.delete = (key: string): void => {
        invalidate();
        originalDelete(key);
    };

    store.clear = (): void => {
        invalidate();
        originalClear();
    };

    return store;
}
