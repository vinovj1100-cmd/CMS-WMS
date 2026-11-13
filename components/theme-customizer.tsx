"use client"

import * as React from "react"
import { Check, Palette, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { useSidebarState, type MenuState } from "@/components/app-shell/sidebar-context"
import { cn } from "@/lib/utils"

type BaseColor = "neutral" | "slate" | "zinc" | "stone" | "brand"

const BASE_COLORS: Record<BaseColor, { label: string; light: string; dark: string }> = {
  neutral: { label: "Neutral", light: "0 0% 100%", dark: "0 0% 3.9%" },
  slate: { label: "Slate", light: "0 0% 100%", dark: "222.2 84% 4.9%" },
  zinc: { label: "Zinc", light: "0 0% 100%", dark: "240 10% 3.9%" },
  stone: { label: "Stone", light: "0 0% 100%", dark: "20 14.3% 4.1%" },
  brand: { label: "Warehouse", light: "210 40% 98%", dark: "217 33% 8%" },
}

const RADII = [0.25, 0.5, 0.75, 1]

const STORAGE_KEY = "wms:theme-customizer"

interface CustomizerState {
  baseColor: BaseColor
  radius: number
  menuState: MenuState
}

const DEFAULT_STATE: CustomizerState = {
  baseColor: "brand",
  radius: 0.5,
  menuState: "full",
}

function readStoredState(): CustomizerState {
  if (typeof window === "undefined") return DEFAULT_STATE
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const parsed = JSON.parse(raw) as Partial<CustomizerState>
    return {
      baseColor: parsed.baseColor && parsed.baseColor in BASE_COLORS ? parsed.baseColor : DEFAULT_STATE.baseColor,
      radius: typeof parsed.radius === "number" ? parsed.radius : DEFAULT_STATE.radius,
      menuState: parsed.menuState ?? DEFAULT_STATE.menuState,
    }
  } catch {
    return DEFAULT_STATE
  }
}

/**
 * Slide-over panel that rewrites the design-token CSS custom properties at
 * runtime. Values are persisted to `localStorage` and re-applied on load so the
 * operator's preference survives a refresh or a new deployment.
 */
export function ThemeCustomizer() {
  const sidebar = useSidebarState()
  const [open, setOpen] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)
  const [state, setState] = React.useState<CustomizerState>(DEFAULT_STATE)

  React.useEffect(() => {
    setMounted(true)
    setState(readStoredState())
  }, [])

  // Apply tokens to the document root whenever state changes.
  React.useEffect(() => {
    if (!mounted || typeof document === "undefined") return

    const root = document.documentElement
    const colors = BASE_COLORS[state.baseColor]

    root.style.setProperty("--radius", `${state.radius}rem`)
    root.style.setProperty("--background", colors.light)
    root.style.setProperty("--popover", colors.light)
    root.style.setProperty("--card", colors.light)

    root.classList.toggle("customizer-dark-bg", state.baseColor === "brand")

    if (state.baseColor === "brand") {
      root.style.setProperty("--primary", "217 91% 60%")
      root.style.setProperty("--primary-foreground", "222.2 47.4% 11.2%")
      root.style.setProperty("--ring", "217 91% 60%")
    } else {
      root.style.removeProperty("--primary")
      root.style.removeProperty("--primary-foreground")
      root.style.removeProperty("--ring")
    }
  }, [mounted, state.baseColor, state.radius])

  // Push the chosen menu density into the sidebar.
  React.useEffect(() => {
    if (!mounted) return
    sidebar?.setMenuStateFromCustomizer(state.menuState)
  }, [mounted, state.menuState, sidebar])

  // Persist + escape-to-close.
  React.useEffect(() => {
    if (!mounted) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* private mode — preference simply won't persist */
    }
  }, [mounted, state])

  React.useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Customize appearance"
        className="fixed bottom-6 right-6 z-50 flex h-11 w-11 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition-transform hover:scale-105 hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <Palette className="h-5 w-5" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-[80] bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Appearance customizer"
            className="fixed right-0 top-0 z-[90] flex h-full w-[20rem] flex-col border-l border-gray-200 bg-white shadow-2xl dark:border-[#1F1F23] dark:bg-[#0F0F12]"
          >
            <header className="flex h-14 items-center justify-between border-b border-gray-200 px-4 dark:border-[#1F1F23]">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Appearance</h2>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setOpen(false)}>
                <X className="h-4 w-4" />
                <span className="sr-only">Close customizer</span>
              </Button>
            </header>

            <div className="flex-1 space-y-6 overflow-y-auto p-4">
              <section className="space-y-3">
                <Label className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Base color</Label>
                <div className="grid grid-cols-5 gap-2">
                  {(Object.keys(BASE_COLORS) as BaseColor[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setState((prev) => ({ ...prev, baseColor: key }))}
                      title={BASE_COLORS[key].label}
                      className={cn(
                        "flex h-10 items-center justify-center rounded-md border-2 transition-colors",
                        state.baseColor === key
                          ? "border-blue-600 dark:border-blue-400"
                          : "border-gray-200 hover:border-gray-300 dark:border-[#1F1F23]",
                      )}
                    >
                      <span
                        className="h-6 w-6 rounded-full border border-gray-200 dark:border-gray-700"
                        style={{ background: `hsl(${BASE_COLORS[key].light})` }}
                      />
                      <span className="sr-only">{BASE_COLORS[key].label}</span>
                      {state.baseColor === key && <Check className="sr-only" />}
                    </button>
                  ))}
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <Label className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Corner radius
                </Label>
                <div className="grid grid-cols-4 gap-2">
                  {RADII.map((radius) => (
                    <button
                      key={radius}
                      type="button"
                      onClick={() => setState((prev) => ({ ...prev, radius }))}
                      className={cn(
                        "flex h-14 flex-col items-center justify-center gap-1 border-2 bg-gray-50 text-[11px] text-gray-600 transition-colors dark:bg-[#1F1F23] dark:text-gray-300",
                        state.radius === radius
                          ? "border-blue-600 dark:border-blue-400"
                          : "border-transparent hover:border-gray-300",
                      )}
                      style={{ borderRadius: `${radius}rem` }}
                    >
                      {radius}
                    </button>
                  ))}
                </div>
              </section>

              <Separator />

              <section className="space-y-3">
                <Label className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Sidebar density
                </Label>
                <div className="grid grid-cols-3 gap-2">
                  {(["full", "collapsed", "hidden"] as MenuState[]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setState((prev) => ({ ...prev, menuState: value }))}
                      className={cn(
                        "rounded-md border px-2 py-2 text-xs capitalize transition-colors",
                        state.menuState === value
                          ? "border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300"
                          : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-[#1F1F23] dark:text-gray-300 dark:hover:bg-[#1F1F23]",
                      )}
                    >
                      {value}
                    </button>
                  ))}
                </div>
              </section>
            </div>

            <footer className="border-t border-gray-200 p-4 dark:border-[#1F1F23]">
              <Button
                variant="outline"
                className="w-full"
                onClick={() => {
                  setState(DEFAULT_STATE)
                  try {
                    window.localStorage.removeItem(STORAGE_KEY)
                  } catch {
                    /* ignore */
                  }
                }}
              >
                Reset to defaults
              </Button>
            </footer>
          </aside>
        </>
      )}
    </>
  )
}
