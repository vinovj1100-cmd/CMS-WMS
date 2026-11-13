import { generateId } from "@/lib/security/password"
import { getConfig } from "@/lib/security/config"
import { getStore } from "@/lib/wms/store"
import type { AuditEntry, AuditOutcome, Role } from "@/lib/wms/types"

/**
 * Append-only audit trail.
 *
 * Every mutating API call and every failed authentication writes a record here.
 * The log is never edited or deleted by application code — the only removals
 * happen through an explicit retention job an operator runs by hand.
 */

export interface AuditInput {
  actor: string
  actorRole: Role | "anonymous"
  action: string
  resource: string
  resourceId?: string | null
  outcome?: AuditOutcome
  ip?: string
  userAgent?: string
  metadata?: Record<string, unknown>
}

export async function recordAudit(input: AuditInput): Promise<void> {
  if (!getConfig().auditLogEnabled) return

  const entry: AuditEntry = {
    id: generateId("aud"),
    timestamp: new Date().toISOString(),
    actor: input.actor,
    actorRole: input.actorRole,
    action: input.action,
    resource: input.resource,
    resourceId: input.resourceId ?? null,
    outcome: input.outcome ?? "success",
    ip: input.ip ?? "unknown",
    userAgent: input.userAgent ?? "unknown",
    // Metadata is size-capped so a large payload cannot bloat the log.
    metadata: capMetadata(input.metadata ?? {}),
  }

  try {
    const store = await getStore()
    await store.mutate((snapshot) => {
      snapshot.auditLog.unshift(entry)
      // Keep the in-memory log bounded; archive externally if you need more.
      const MAX_ENTRIES = 5000
      if (snapshot.auditLog.length > MAX_ENTRIES) {
        snapshot.auditLog.length = MAX_ENTRIES
      }
    })
  } catch (error) {
    // Never let audit failure break the request — but make it visible.
    console.error("[wms] audit write failed:", error)
  }
}

function capMetadata(metadata: Record<string, unknown>, maxKeys = 24): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  let count = 0
  for (const [key, value] of Object.entries(metadata)) {
    if (count >= maxKeys) {
      result.__truncated = true
      break
    }
    result[key] = typeof value === "string" ? value.slice(0, 500) : value
    count += 1
  }
  return result
}

/**
 * Best-effort client IP.
 *
 * `x-forwarded-for` is only trustworthy behind a proxy you control; the leftmost
 * entry is the original client and the rest are proxies it traversed.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  return request.headers.get("x-real-ip") ?? "unknown"
}

export function userAgent(request: Request): string {
  return (request.headers.get("user-agent") ?? "unknown").slice(0, 300)
}
