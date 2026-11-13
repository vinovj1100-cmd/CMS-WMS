"use client"

import type { ReactNode } from "react"

import Sidebar from "./sidebar"
import TopNav from "./top-nav"
import { ThemeCustomizer } from "../theme-customizer"
import { Toaster } from "@/components/ui/toaster"
import { SidebarProvider, useRequiredSidebarState } from "@/components/app-shell/sidebar-context"

interface LayoutProps {
  children: ReactNode
}

/** Width the main column should be pushed over for the current sidebar mode. */
function getMarginLeft(menuState: "full" | "collapsed" | "hidden", isHovered: boolean, isMobile: boolean) {
  // Mobile renders the sidebar as an overlay, so the content never shifts.
  if (isMobile || menuState === "hidden") return "0"
  // A collapsed sidebar temporarily expands while hovered ("peek" mode).
  if (menuState === "collapsed") return isHovered ? "16rem" : "4rem"
  return "16rem"
}

function Shell({ children }: LayoutProps) {
  const { menuState, isHovered, isMobile } = useRequiredSidebarState()

  return (
    <div className="flex h-screen bg-white dark:bg-[#0F0F12]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-blue-600 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white"
      >
        Skip to main content
      </a>

      <Sidebar />

      <div
        className="w-full flex flex-1 flex-col transition-[margin] duration-300 ease-in-out min-w-0"
        style={{ marginLeft: getMarginLeft(menuState, isHovered, isMobile) }}
      >
        <header className="h-16 border-b border-gray-200 dark:border-[#1F1F23] flex-shrink-0">
          <TopNav />
        </header>
        <main
          id="main-content"
          className="flex-1 overflow-auto p-3 sm:p-6 bg-white dark:bg-[#0F0F12] min-w-0"
        >
          {children}
        </main>
      </div>

      <ThemeCustomizer />
      <Toaster />
    </div>
  )
}

export default function Layout({ children }: LayoutProps) {
  return (
    <SidebarProvider>
      <Shell>{children}</Shell>
    </SidebarProvider>
  )
}
