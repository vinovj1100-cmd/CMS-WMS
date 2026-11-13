"use client"

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

export type MenuState = "full" | "collapsed" | "hidden"

interface SidebarContextValue {
  /** Current desktop sidebar width mode. */
  menuState: MenuState
  /** True while the pointer is inside the sidebar (used to peek when collapsed). */
  isHovered: boolean
  /** True when the viewport is below the desktop breakpoint. */
  isMobile: boolean
  /** Whether the mobile drawer is open. */
  isMobileMenuOpen: boolean
  toggleMenuState: () => void
  setMenuState: (state: MenuState) => void
  setMenuStateFromCustomizer: (state: MenuState) => void
  setIsHovered: (value: boolean) => void
  setIsMobile: (value: boolean) => void
  setIsMobileMenuOpen: (value: boolean) => void
  toggleMobileMenu: () => void
}

const SidebarContext = createContext<SidebarContextValue | null>(null)

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [menuState, setMenuState] = useState<MenuState>("full")
  const [isHovered, setIsHovered] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  const toggleMenuState = useCallback(() => {
    setMenuState((prev) => {
      if (isMobile) return prev
      if (prev === "full") return "collapsed"
      if (prev === "collapsed") return "hidden"
      return "full"
    })
  }, [isMobile])

  const setMenuStateFromCustomizer = useCallback(
    (state: MenuState) => {
      if (!isMobile) setMenuState(state)
    },
    [isMobile],
  )

  const toggleMobileMenu = useCallback(() => setIsMobileMenuOpen((prev) => !prev), [])

  const value = useMemo<SidebarContextValue>(
    () => ({
      menuState,
      isHovered,
      isMobile,
      isMobileMenuOpen,
      toggleMenuState,
      setMenuState,
      setMenuStateFromCustomizer,
      setIsHovered,
      setIsMobile,
      setIsMobileMenuOpen,
      toggleMobileMenu,
    }),
    [menuState, isHovered, isMobile, isMobileMenuOpen, toggleMenuState, setMenuStateFromCustomizer, toggleMobileMenu],
  )

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
}

/**
 * Reads sidebar UI state. Returns `null` when used outside of a {@link SidebarProvider}
 * so callers can degrade gracefully instead of throwing.
 */
export function useSidebarState(): SidebarContextValue | null {
  return useContext(SidebarContext)
}

/** Same as {@link useSidebarState} but throws when the provider is missing. */
export function useRequiredSidebarState(): SidebarContextValue {
  const ctx = useContext(SidebarContext)
  if (!ctx) {
    throw new Error("useRequiredSidebarState must be used within a <SidebarProvider>")
  }
  return ctx
}
