import { hashPassword } from "@/lib/security/password"
import { buildCatalogue, buildUsers, buildOperations, DEMO_USERS } from "./seed-data"
import type { DatabaseSnapshot } from "../types"
import { clone, EMPTY_SNAPSHOT } from "./index"

/**
 * Demo dataset.
 *
 * Deterministic by design: every ID, quantity and timestamp is derived from a
 * seeded PRNG, so two developers get byte-identical warehouses and tests can
 * assert against exact numbers.
 *
 * Gated by `WMS_SEED_DEMO_DATA`, which defaults to **off** in production so a
 * real deployment never ships with demo credentials or demo stock.
 */

/** Re-exported so callers have a single import path for the demo dataset. */
export { DEMO_USERS } from "./seed-data"

/**
 * Assembles the full demo warehouse.
 *
 * Async because user passwords are scrypt-hashed. The catalogue is built first
 * (warehouses → zones → locations → SKUs), then operational history is layered
 * on top so the movement ledger and inventory balances agree.
 */
export async function buildSeedSnapshot(): Promise<DatabaseSnapshot> {
  const snapshot: DatabaseSnapshot = clone(EMPTY_SNAPSHOT)

  buildCatalogue(snapshot)

  const users = buildUsers()
  snapshot.users = await Promise.all(
    users.map(async (user, index) => {
      const demo = DEMO_USERS[index]
      if (!demo) return user
      const { hash, salt } = await hashPassword(demo.password)
      return { ...user, passwordHash: hash, passwordSalt: salt }
    }),
  )

  buildOperations(snapshot)

  return snapshot
}
