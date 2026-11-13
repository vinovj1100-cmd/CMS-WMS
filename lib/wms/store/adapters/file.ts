import { promises as fs } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"

import type { DatabaseSnapshot } from "../../types"
import { clone, EMPTY_SNAPSHOT, Mutex, type Store } from "../index"

/**
 * JSON-on-disk adapter.
 *
 * Writes are atomic: the payload goes to a temp file in the same directory and
 * is then `rename`d over the target, which POSIX guarantees to be atomic. A
 * crash mid-write therefore leaves either the old file or the new file, never a
 * truncated one. The previous generation is kept as `.bak` so an operator can
 * roll back a bad mutation by hand.
 */
export class FileStore implements Store {
  readonly driver = "file"
  private readonly mutex = new Mutex()
  private readonly file: string

  constructor(dataDir: string) {
    this.file = path.resolve(dataDir, "wms.json")
  }

  async read(): Promise<DatabaseSnapshot> {
    try {
      const raw = await fs.readFile(this.file, "utf8")
      const parsed = JSON.parse(raw) as Partial<DatabaseSnapshot>
      // Merge onto the empty shape so a snapshot written by an older schema
      // still yields every collection.
      return { ...clone(EMPTY_SNAPSHOT), ...parsed }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return clone(EMPTY_SNAPSHOT)
      throw new Error(`WMS: could not read data file ${this.file}: ${(error as Error).message}`)
    }
  }

  async write(snapshot: DatabaseSnapshot): Promise<void> {
    await this.mutex.run(() => this.persist(snapshot))
  }

  async mutate<T>(mutator: (snapshot: DatabaseSnapshot) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const snapshot = await this.readUnsafe()
      const result = await mutator(snapshot)
      await this.persist(snapshot)
      return result
    })
  }

  async reset(): Promise<void> {
    await this.mutex.run(async () => {
      await fs.rm(this.file, { force: true })
    })
  }

  private async readUnsafe(): Promise<DatabaseSnapshot> {
    try {
      const raw = await fs.readFile(this.file, "utf8")
      return { ...clone(EMPTY_SNAPSHOT), ...(JSON.parse(raw) as Partial<DatabaseSnapshot>) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(EMPTY_SNAPSHOT)
      throw error
    }
  }

  private async persist(snapshot: DatabaseSnapshot): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })

    const tmp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`
    const json = JSON.stringify(snapshot, null, 2)

    await fs.writeFile(tmp, json, { encoding: "utf8", mode: 0o600 })
    try {
      await fs.copyFile(this.file, `${this.file}.bak`)
    } catch {
      // First write — nothing to back up.
    }
    await fs.rename(tmp, this.file)
  }
}
