"use client"

import * as React from "react"

/**
 * SSR-safe media query hook.
 *
 * Returns `defaultValue` during the server render and the first client render so
 * the markup matches (no hydration mismatch), then subscribes to the real
 * `matchMedia` result. Reading `window.innerWidth` directly in render crashes
 * prerendering with "window is not defined".
 */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  const [matches, setMatches] = React.useState(defaultValue)

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return

    const mql = window.matchMedia(query)
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)

    setMatches(mql.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}

/** Convenience: viewport narrower than the small breakpoint (640px). */
export function useIsSmallScreen(): boolean {
  return useMediaQuery("(max-width: 639px)", false)
}
