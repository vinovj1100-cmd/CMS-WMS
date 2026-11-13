import type { NextResponse } from "next/server"
import { stringifyCookie } from "next/dist/compiled/@edge-runtime/cookies"

import { getConfig } from "./config"

/**
 * Next 14's cookie serializer predates the Partitioned attribute. In the
 * explicitly enabled, HTTPS-only development preview, add it after all cookies
 * have been set so modern browsers can keep the iframe's cookies isolated per
 * top-level site. Never enable this for production or sensitive data.
 */
export function partitionPreviewCookies(response: NextResponse): NextResponse {
  if (!getConfig().previewEmbedding) return response

  const cookies = response.cookies.getAll()
  response.headers.delete("set-cookie")
  for (const cookie of cookies) {
    response.headers.append("set-cookie", `${stringifyCookie(cookie)}; Partitioned`)
  }
  return response
}
