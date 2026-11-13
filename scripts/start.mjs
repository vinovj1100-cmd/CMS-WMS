#!/usr/bin/env node
/**
 * Start Next.js standalone output from the project root.
 *
 * Next does not copy public/ or .next/static into its standalone bundle. Copy
 * both before starting so `pnpm build && pnpm start` serves a complete app.
 * The generated server changes cwd to .next/standalone, so resolve the data
 * directory against the project root first and load the root's .env files.
 */
import { access, cp, mkdir } from "node:fs/promises"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const output = path.join(root, ".next", "standalone")
const server = path.join(output, "server.js")

try {
  await access(server)
} catch {
  console.error("Standalone build not found. Run `pnpm build` before `pnpm start`.")
  process.exit(1)
}

// Resolve @next/env from Next's own dependencies (works with pnpm's strict
// module layout) and use the same production .env precedence as Next.js.
const require = createRequire(import.meta.url)
const nextRequire = createRequire(require.resolve("next/package.json"))
nextRequire("@next/env").loadEnvConfig(root, false)

await mkdir(path.join(output, ".next"), { recursive: true })
await cp(path.join(root, ".next", "static"), path.join(output, ".next", "static"), { recursive: true })
await cp(path.join(root, "public"), path.join(output, "public"), { recursive: true })

// Preserve the intended location when server.js changes the working directory.
process.env.WMS_DATA_DIR = path.resolve(root, process.env.WMS_DATA_DIR || "./data")
process.env.WMS_STANDALONE_DIR = output
await import("./standalone-entry.mjs")
