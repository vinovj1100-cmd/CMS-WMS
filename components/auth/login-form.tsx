"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Eye, EyeOff, Lock, ShieldCheck, User, Warehouse } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, ApiRequestError } from "@/lib/api/client"

/**
 * Sign-in form.
 *
 * Flow: fetch a CSRF token, then post credentials with that token in a header.
 * The server sets an HttpOnly session cookie — the token is never used as an
 * auth credential, only to prove the request came from this origin.
 *
 * `next` comes from the middleware redirect so operators land back where they
 * were headed. It is validated against an allowlist before use, because a
 * reflected `next` is an open redirect.
 */

const DEMO_ACCOUNTS = [
  { role: "Administrator", username: "admin", password: "Wms!Owner2026" },
  { role: "Warehouse Manager", username: "manager", password: "Wms!Manager2026" },
  { role: "Supervisor", username: "supervisor", password: "Wms!Supervisor2026" },
  { role: "Operator", username: "operator", password: "Wms!Operator2026" },
  { role: "Read-only", username: "viewer", password: "Wms!Viewer2026" },
]

/** Only same-origin paths are accepted as a redirect target. */
function safeRedirectTarget(value: string | null): string {
  if (!value) return "/wms"
  // Must start with a single slash and not be a protocol-relative URL.
  if (!value.startsWith("/") || value.startsWith("//")) return "/wms"
  return value
}

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const target = safeRedirectTarget(searchParams.get("next"))

  const [username, setUsername] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [csrfReady, setCsrfReady] = React.useState(false)

  // Pull a CSRF token before the user can submit. Without it the server would
  // reject the login as a possible cross-site request.
  React.useEffect(() => {
    let cancelled = false
    void api
      .get("/api/auth/session")
      .then(() => {
        if (!cancelled) setCsrfReady(true)
      })
      .catch(() => {
        // If this fails the submit will report the real error; don't block the form.
        if (!cancelled) setCsrfReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return

    setSubmitting(true)
    setError(null)

    try {
      await api.post("/api/auth/login", { username: username.trim(), password })
      router.replace(target)
      router.refresh()
    } catch (err) {
      if (err instanceof ApiRequestError) {
        setError(err.message)
      } else {
        setError("Could not reach the server. Check your connection and try again.")
      }
      // Clearing the password means a retry starts clean and it is not left
      // sitting in the DOM after a failure.
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  const fillDemo = (account: (typeof DEMO_ACCOUNTS)[number]) => {
    setUsername(account.username)
    setPassword(account.password)
    setError(null)
  }

  return (
    <div className="w-full max-w-md">
      <div className="mb-8 flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-blue-600 text-white">
          <Warehouse className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Warehouse Management</h1>
          <p className="text-sm text-gray-500">Sign in to continue</p>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-5" noValidate>
        {error && (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="username">Username</Label>
          <div className="relative">
            <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              id="username"
              name="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="operator"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              maxLength={64}
              className="pl-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••••••"
              autoComplete="current-password"
              required
              maxLength={128}
              className="pl-9 pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <Button type="submit" className="w-full" disabled={submitting || !csrfReady}>
          {submitting ? "Signing in…" : csrfReady ? "Sign in" : "Preparing…"}
        </Button>

        <p className="flex items-start gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-600 dark:text-green-400" />
          Sessions use HttpOnly cookies and rate limits. Repeated failures lock the account; sign-in events are
          recorded when auditing is enabled.
        </p>
      </form>

      <details className="mt-8 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-[#1F1F23] dark:bg-[#131317]">
        <summary className="cursor-pointer text-xs font-medium text-gray-600 dark:text-gray-300">
          Demo accounts
        </summary>
        <p className="mt-2 text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">
          Created in an empty store when <code className="font-mono">WMS_SEED_DEMO_DATA</code> is enabled. Disabling
          seeding later does not remove existing demo accounts. Use these credentials for evaluation only.
        </p>
        <ul className="mt-2 space-y-1">
          {DEMO_ACCOUNTS.map((account) => (
            <li key={account.username}>
              <button
                type="button"
                onClick={() => fillDemo(account)}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs transition-colors hover:bg-white dark:hover:bg-[#1F1F23]"
              >
                <span className="text-gray-600 dark:text-gray-300">{account.role}</span>
                <span className="font-mono text-gray-500 dark:text-gray-400">{account.username}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}
