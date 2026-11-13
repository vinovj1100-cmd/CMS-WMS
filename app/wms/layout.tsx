import type { Metadata } from "next"
import type React from "react"

import { WmsShell } from "@/components/wms/wms-shell"

export const metadata: Metadata = {
  title: "Warehouse Operations",
  description: "Receiving, putaway, inventory, picking, packing and shipping.",
}

export default function WmsLayout({ children }: { children: React.ReactNode }) {
  return <WmsShell>{children}</WmsShell>
}
