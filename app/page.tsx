import { redirect } from "next/navigation"

// Keep the redirect server-side in production rather than prerendering an
// error shell that depends on client JavaScript to navigate.
export const dynamic = "force-dynamic"

export default function Home() {
  redirect("/wms")
}
