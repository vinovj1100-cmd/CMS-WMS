import type { DatabaseSnapshot } from "../../types"
import { clone, EMPTY_SNAPSHOT, Mutex, type Store } from "../index"

/**
 * In-memory adapter. Data lives on `globalThis` so it survives Next.js
 * hot-reloads within a dev server, but is lost on restart.
 *
 * Suitable for: unit tests, demos, single-process preview deployments.
 * Not suitable for: multi-instance production (state is per-process).
 */
export class MemoryStore implements Store {
  readonly driver = "memory"
  private readonly mutex = new Mutex()

  private get holder(): { snapshot: DatabaseSnapshot } {
    const g = globalThis as unknown as { __wmsMemory?: { snapshot: DatabaseSnapshot } }
    if (!g.__wmsMemory) {
      g.__wmsMemory = { snapshot: clone(EMPTY_SNAPSHOT) }
    }
    return g.__wmsMemory
  }

  async read(): Promise<DatabaseSnapshot> {
    return clone(this.holder.snapshot)
  }

  async write(snapshot: DatabaseSnapshot): Promise<void> {
    await this.mutex.run(() => {
      this.holder.snapshot = clone(snapshot)
    })
  }

  async mutate<T>(mutator: (snapshot: DatabaseSnapshot) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      // The mutator works on a live reference; we persist a clone afterwards so
      // callers cannot keep mutating the stored state behind our back.
      const result = await mutator(this.holder.snapshot)
      this.holder.snapshot = clone(this.holder.snapshot)
      return result
    })
  }

  async reset(): Promise<void> {
    await this.mutex.run(() => {
      this.holder.snapshot = clone(EMPTY_SNAPSHOT)
    })
  }
}
