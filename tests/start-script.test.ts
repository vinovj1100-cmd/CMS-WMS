import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, symlink, copyFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "wms-start-test-"))
  await mkdir(path.join(root, "scripts"), { recursive: true })
  await copyFile(path.join(process.cwd(), "scripts/start.mjs"), path.join(root, "scripts/start.mjs"))
  await copyFile(path.join(process.cwd(), "scripts/standalone-entry.mjs"), path.join(root, "scripts/standalone-entry.mjs"))
  await symlink(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "dir")
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("standalone start command", () => {
  it("fails with a useful instruction if the app has not been built", () => {
    expect(() => execFileSync(process.execPath, [path.join(root, "scripts/start.mjs")], { stdio: "pipe" }))
      .toThrow(/pnpm build/)
  })

  it("loads project env, copies browser assets, and anchors relative data to the project", async () => {
    await mkdir(path.join(root, ".next", "standalone", ".next", "server"), { recursive: true })
    await writeFile(path.join(root, ".next", "standalone", ".next", "server", "instrumentation.js"), "exports.register = async () => { process.env.WMS_START_VERIFIED = 'true' }")
    await mkdir(path.join(root, ".next", "static"), { recursive: true })
    await mkdir(path.join(root, "public"), { recursive: true })
    await writeFile(path.join(root, ".next", "static", "chunk.js"), "static asset")
    await writeFile(path.join(root, "public", "icon.svg"), "public asset")
    await writeFile(path.join(root, ".env"), "WMS_DATA_DIR=./my-data\nWMS_START_TEST_VALUE=loaded\n")
    await writeFile(
      path.join(root, ".next", "standalone", "server.js"),
      `process.chdir(__dirname); console.log('RESULT=' + JSON.stringify({ cwd: process.cwd(), dataDir: process.env.WMS_DATA_DIR, envValue: process.env.WMS_START_TEST_VALUE, verified: process.env.WMS_START_VERIFIED }));`,
    )

    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" }
    delete env.WMS_DATA_DIR
    delete env.WMS_START_TEST_VALUE
    const output = execFileSync(process.execPath, [path.join(root, "scripts/start.mjs")], {
      cwd: root,
      env,
      encoding: "utf8",
    })
    const resultLine = output.split("\n").find((line) => line.startsWith("RESULT="))
    expect(resultLine).toBeDefined()
    const result = JSON.parse(resultLine!.slice("RESULT=".length)) as Record<string, string>
    expect(result).toEqual({
      cwd: path.join(root, ".next", "standalone"),
      dataDir: path.join(root, "my-data"),
      envValue: "loaded",
      verified: "true",
    })
    expect(await readFile(path.join(root, ".next", "standalone", ".next", "static", "chunk.js"), "utf8")).toBe("static asset")
    expect(await readFile(path.join(root, ".next", "standalone", "public", "icon.svg"), "utf8")).toBe("public asset")
  })

  it("does not start the server when the production config gate fails", async () => {
    await mkdir(path.join(root, ".next", "standalone", ".next", "server"), { recursive: true })
    await mkdir(path.join(root, ".next", "static"), { recursive: true })
    await mkdir(path.join(root, "public"), { recursive: true })
    await writeFile(path.join(root, ".next", "standalone", ".next", "server", "instrumentation.js"), "exports.register = async () => { throw new Error('insecure config') }")
    await writeFile(path.join(root, ".next", "standalone", "server.js"), `require('node:fs').writeFileSync(${JSON.stringify(path.join(root, "server-started"))}, 'yes')`)

    expect(() => execFileSync(process.execPath, [path.join(root, "scripts/start.mjs")], { cwd: root, stdio: "pipe" }))
      .toThrow(/insecure config/)
    expect(existsSync(path.join(root, "server-started"))).toBe(false)
  })
})
