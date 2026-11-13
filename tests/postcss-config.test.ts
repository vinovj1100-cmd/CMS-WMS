import { describe, expect, it } from "vitest"
import postcss, { type AcceptedPlugin } from "postcss"
import { getPostCssPlugins } from "next/dist/build/webpack/config/blocks/css/plugins"

describe("Next.js PostCSS configuration", () => {
  it("loads Tailwind and compiles the utilities used by the WMS", async () => {
    // Use Next's own loader: unsupported config extensions can otherwise leave
    // the @tailwind directives untouched while the build still succeeds.
    const plugins = await getPostCssPlugins(process.cwd(), undefined)
    // Next and the app use compatible PostCSS 8 versions with distinct TS types.
    const result = await postcss(plugins as unknown as AcceptedPlugin[]).process("@tailwind utilities;", { from: undefined })
    expect(result.css).toMatch(/\.flex\s*\{\s*display:\s*flex/)
    expect(result.css).not.toContain("@tailwind")
  })
})
