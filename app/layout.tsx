import type React from "react"
import type { Metadata, Viewport } from "next"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "WMS — Warehouse Management System",
    template: "%s · WMS",
  },
  description:
    "Open-source warehouse management system: inbound receiving, putaway, inventory control, wave picking, packing, shipping, cycle counts and full audit trail.",
  applicationName: "WMS",
  keywords: [
    "warehouse management system",
    "WMS",
    "inventory",
    "receiving",
    "putaway",
    "picking",
    "packing",
    "shipping",
    "cycle count",
    "supply chain",
  ],
  authors: [{ name: "CMS-WMS Contributors" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    url: siteUrl,
    siteName: "WMS",
    title: "WMS — Warehouse Management System",
    description: "Receiving, putaway, inventory, picking, packing and shipping in one place.",
  },
  twitter: {
    card: "summary_large_image",
    title: "WMS — Warehouse Management System",
    description: "Receiving, putaway, inventory, picking, packing and shipping in one place.",
  },
  robots: {
    // This is an authenticated back-office application: nothing should be indexed.
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
  icons: {
    icon: [
      { url: "/icon-light-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-dark-32x32.png", sizes: "32x32", type: "image/png", media: "(prefers-color-scheme: dark)" },
    ],
    apple: "/apple-icon.png",
  },
  manifest: "/manifest.webmanifest",
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f12" },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
