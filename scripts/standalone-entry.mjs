#!/usr/bin/env node
/**
 * Fail closed before binding a production port. Next 14 may defer its own
 * instrumentation hook until the first request, so invoke the built hook
 * explicitly before starting the standalone server. Also used by the container.
 */
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const output = process.env.WMS_STANDALONE_DIR || path.dirname(fileURLToPath(import.meta.url))
process.env.NODE_ENV = "production"
// A build-phase marker must never disable runtime validation.
if (process.env.NEXT_PHASE === "phase-production-build") delete process.env.NEXT_PHASE

const require = createRequire(import.meta.url)
const instrumentation = await require(path.join(output, ".next", "server", "instrumentation.js"))
if (typeof instrumentation.register !== "function") {
  throw new Error("Standalone instrumentation hook is missing; rebuild the application.")
}
try {
  await instrumentation.register()
} catch (error) {
  console.error(`WMS startup aborted: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
await import(pathToFileURL(path.join(output, "server.js")).href)
