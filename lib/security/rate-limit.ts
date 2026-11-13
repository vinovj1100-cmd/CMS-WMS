/**
 * In-process rate limiter (token bucket).
 *
 * Good enough for a single instance and for brute-force protection on the login
 * endpoint, where the key is the username+IP pair rather than raw throughput.
 * For a multi-instance deployment swap the backing map for Redis — the
 * `consume` signature is already async so the call sites will not change.
 */

interface Bucket {
  tokens: number
  updatedAt: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  limit: number
  /** Milliseconds until at least one token is available. */
  retryAfterMs: number
}

export interface RateLimitOptions {
  /** Maximum burst size. */
  limit: number
  /** Window over which `limit` tokens refill, in milliseconds. */
  windowMs: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly refillPerMs: number
  private lastSweep = Date.now()

  constructor(private readonly options: RateLimitOptions) {
    this.refillPerMs = options.limit / options.windowMs
  }

  consume(key: string, cost = 1): RateLimitResult {
    const now = Date.now()
    this.sweep(now)

    const existing = this.buckets.get(key)
    const tokens = existing
      ? Math.min(this.options.limit, existing.tokens + (now - existing.updatedAt) * this.refillPerMs)
      : this.options.limit

    const allowed = tokens >= cost
    const remainingTokens = allowed ? tokens - cost : tokens

    this.buckets.set(key, { tokens: remainingTokens, updatedAt: now })

    const deficit = allowed ? 0 : cost - remainingTokens
    const retryAfterMs = allowed ? 0 : Math.ceil(deficit / this.refillPerMs)

    return {
      allowed,
      remaining: Math.max(0, Math.floor(remainingTokens)),
      limit: this.options.limit,
      retryAfterMs,
    }
  }

  /** Forgets a key entirely — used to clear the counter after a successful login. */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  size(): number {
    return this.buckets.size
  }

  /** Drops buckets that refilled to capacity so the map cannot grow without bound. */
  private sweep(now: number): void {
    const SWEEP_INTERVAL_MS = 60_000
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return
    this.lastSweep = now

    for (const [key, bucket] of this.buckets) {
      const tokens = Math.min(this.options.limit, bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs)
      if (tokens >= this.options.limit) this.buckets.delete(key)
    }
  }
}

/** Held on globalThis so hot reloads do not reset an attacker's attempt count. */
function singleton<T>(key: string, create: () => T): T {
  const g = globalThis as unknown as Record<string, T | undefined>
  if (!g[key]) g[key] = create()
  return g[key] as T
}

/** Login attempts: keyed by username+IP, refills over the lockout window. */
export function loginLimiter(maxAttempts: number, windowMs: number): RateLimiter {
  return singleton(`wms:limiter:login:${maxAttempts}:${windowMs}`, () =>
    new RateLimiter({ limit: maxAttempts, windowMs }),
  )
}

/** General API throttle: keyed by IP. */
export function apiLimiter(): RateLimiter {
  return singleton("wms:limiter:api", () => new RateLimiter({ limit: 240, windowMs: 60_000 }))
}

/** Test helper. */
export function __resetRateLimiters(): void {
  const g = globalThis as unknown as Record<string, unknown>
  for (const key of Object.keys(g)) {
    if (key.startsWith("wms:limiter:")) delete g[key]
  }
}
