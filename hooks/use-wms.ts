"use client"

import * as React from "react"

import { api, ApiRequestError } from "@/lib/api/client"

/**
 * Data fetching + mutation state for WMS screens.
 *
 * Deliberately small: one `data` value, one `error`, one `loading` flag, plus a
 * `refetch` and a `mutate` that optimistically refreshes after a write. Enough
 * for an internal tool, and no cache-invalidation machinery to get wrong.
 */
export interface UseApiResult<T> {
  data: T | null
  error: ApiRequestError | Error | null
  loading: boolean
  /** True between the initial mount and the first settled response. */
  initialising: boolean
  refetch: () => Promise<void>
  /** Runs a write, then refreshes the underlying query. */
  mutate: <R>(fn: () => Promise<R>) => Promise<R>
  /** Set by `mutate` while a write is in flight. */
  submitting: boolean
}

export function useApi<T>(path: string | null, options?: { refreshKey?: string | number }): UseApiResult<T> {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<ApiRequestError | Error | null>(null)
  const [loading, setLoading] = React.useState(path !== null)
  const [submitting, setSubmitting] = React.useState(false)
  const [tick, setTick] = React.useState(0)

  const { refreshKey } = options ?? {}

  const load = React.useCallback(async () => {
    if (!path) return
    setLoading(true)
    setError(null)
    try {
      const result = await api.get<T>(path)
      setData(result)
    } catch (err) {
      setError(err as Error)
    } finally {
      setLoading(false)
    }
  }, [path])

  React.useEffect(() => {
    void load()
  }, [load, tick, refreshKey])

  const refetch = React.useCallback(async () => {
    setTick((t) => t + 1)
  }, [])

  const mutate = React.useCallback(
    async <R,>(fn: () => Promise<R>): Promise<R> => {
      setSubmitting(true)
      setError(null)
      try {
        const result = await fn()
        await load()
        return result
      } finally {
        setSubmitting(false)
      }
    },
    [load],
  )

  return { data, error, loading, initialising: loading && data === null, refetch, mutate, submitting }
}

/** Toast-friendly error text: prefers the server's message, falls back sensibly. */
export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message
  if (error instanceof Error) return error.message
  return "Something went wrong. Please try again."
}
