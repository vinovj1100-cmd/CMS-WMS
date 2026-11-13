import type { CollectionName, DatabaseSnapshot } from "../types"

/**
 * Persistence contract.
 *
 * Two adapters ship with the app (`memory`, `file`). Pointing this at Postgres
 * means implementing the same four methods — the service layer never touches a
 * driver directly, so swapping storage is a one-file change.
 */
export interface Store {
  readonly driver: string
  read(): Promise<DatabaseSnapshot>
  write(snapshot: DatabaseSnapshot): Promise<void>
  /**
   * Apply `mutator` to the snapshot and persist the result under a lock.
   * Serialising here is what keeps concurrent API calls from clobbering each
   * other's writes when the adapter is process-local.
   */
  mutate<T>(mutator: (snapshot: DatabaseSnapshot) => T | Promise<T>): Promise<T>
  reset(): Promise<void>
}

export const EMPTY_SNAPSHOT: DatabaseSnapshot = {
  warehouses: [],
  zones: [],
  locations: [],
  skus: [],
  suppliers: [],
  customers: [],
  users: [],
  sessions: [],
  inventory: [],
  movements: [],
  purchaseOrders: [],
  inboundShipments: [],
  putawayTasks: [],
  salesOrders: [],
  waves: [],
  pickTasks: [],
  packRecords: [],
  shipments: [],
  cycleCounts: [],
  adjustments: [],
  replenishmentTasks: [],
  returns: [],
  auditLog: [],
  sequences: {},
}

/**
 * Serialisation queue. Every adapter funnels `mutate` through this so that
 * read-modify-write cycles never interleave.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    // Keep the chain alive even if `fn` rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** Deep-clone helper. Structured clone is available on every runtime we target. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let storePromise: Promise<Store> | null = null

/**
 * Returns the process-wide store, creating it (and seeding it) on first use.
 * Cached on `globalThis` so Next.js hot-reloads do not wipe in-flight data.
 */
export async function getStore(): Promise<Store> {
  const g = globalThis as unknown as { __wmsStore?: Promise<Store> }
  if (g.__wmsStore) return g.__wmsStore
  if (storePromise) return storePromise

  storePromise = (async () => {
    const { getConfig } = await import("@/lib/security/config")
    const config = getConfig()

    const store: Store =
      config.storageDriver === "file"
        ? new (await import("./adapters/file")).FileStore(config.dataDir)
        : new (await import("./adapters/memory")).MemoryStore()

    const snapshot = await store.read()
    const isEmpty =
      snapshot.warehouses.length === 0 && snapshot.skus.length === 0 && snapshot.users.length === 0

    if (isEmpty && config.seedDemoData) {
      // Async because demo passwords are scrypt-hashed.
      const { buildSeedSnapshot } = await import("./seed")
      await store.write(await buildSeedSnapshot())
    }

    return store
  })()

  g.__wmsStore = storePromise
  return storePromise
}

/** Test helper — drops the cached store so the next call reseeds. */
export function __resetStoreCache(): void {
  storePromise = null
  ;(globalThis as unknown as { __wmsStore?: Promise<Store> }).__wmsStore = undefined
}

export function collectionNames(): CollectionName[] {
  return Object.keys(EMPTY_SNAPSHOT).filter((k): k is CollectionName => k !== "sequences")
}
