import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Test configuration.
 *
 * Tests run in Node (not jsdom) because everything under test is server-side
 * domain logic: services, security primitives and the store adapters. The `@/*`
 * alias mirrors tsconfig so tests import exactly what the app imports.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      // Production cost is 32768; at that setting hashing the five seeded users
      // takes longer than the rest of the suite. 4096 still exercises the real
      // scrypt code path.
      WMS_SCRYPT_N: "4096",
      WMS_STORAGE_DRIVER: "memory",
      WMS_SEED_DEMO_DATA: "false",
      WMS_SESSION_SECRET: "test-secret-with-at-least-32-characters-long",
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
