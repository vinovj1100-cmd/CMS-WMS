import type { Metadata } from "next"
import { Suspense } from "react"
import { Boxes, ClipboardCheck, ShieldCheck, Truck } from "lucide-react"

import { LoginForm } from "@/components/auth/login-form"

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to the warehouse management system.",
}

/**
 * Sign-in screen.
 *
 * `LoginForm` reads the `next` query param, so it needs a Suspense boundary —
 * without one Next refuses to statically render the page.
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-screen bg-white dark:bg-[#0F0F12]">
      <div className="hidden w-1/2 flex-col justify-between bg-gradient-to-br from-slate-900 via-blue-950 to-slate-900 p-12 text-white lg:flex">
        <div>
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-white/10">
              <Boxes className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold">WMS</span>
          </div>

          <h1 className="mt-16 text-4xl font-bold leading-tight">
            Every unit accounted for, from dock to dispatch.
          </h1>
          <p className="mt-4 max-w-md text-lg leading-relaxed text-slate-300">
            Receiving, putaway, inventory control, wave picking, packing, shipping, cycle counts and returns — with
            an operational audit history.
          </p>
        </div>

        <ul className="space-y-4 text-sm text-slate-300">
          <li className="flex items-start gap-3">
            <Truck className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-400" />
            <span>Scan-driven receiving and putaway with FEFO lot control</span>
          </li>
          <li className="flex items-start gap-3">
            <ClipboardCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-400" />
            <span>Travel-sequenced pick paths that never double back down an aisle</span>
          </li>
          <li className="flex items-start gap-3">
            <ShieldCheck className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-400" />
            <span>Role-based permissions, rate limiting and an operational audit history</span>
          </li>
        </ul>
      </div>

      <div className="flex w-full items-center justify-center p-8 lg:w-1/2">
        <Suspense fallback={<div className="text-sm text-gray-500">Loading sign-in…</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  )
}
