"use client"

import * as React from "react"
import { KeyRound, UserCog, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { api } from "@/lib/api/client"
import { ROLE_LABELS, ROLES } from "@/lib/security/rbac"
import type { Role } from "@/lib/wms/types"
import { useApi, describeError } from "@/hooks/use-wms"
import {
  DataTable,
  ErrorState,
  LoadingState,
  PageHeader,
  StatCard,
  StatusBadge,
  formatDateTime,
  formatNumber,
} from "@/components/wms/primitives"
import type { Column } from "@/components/wms/primitives"

/**
 * User administration.
 *
 * Creating a user and changing a role both go through capability checks on the
 * server. New accounts start with `mustChangePassword`, and a role change or
 * deactivation revokes that user's live sessions so the change takes effect
 * immediately rather than at their next sign-in.
 */

interface UserRow {
  id: string
  username: string
  name: string
  email: string
  role: Role
  roleLabel: string
  permissionCount: number
  active: boolean
  mfaEnabled: boolean
  mustChangePassword: boolean
  failedAttempts: number
  lockedUntil: string | null
  lastLoginAt: string | null
  createdAt: string
}

export default function UsersPage() {
  const { toast } = useToast()
  const users = useApi<{ users: UserRow[] }>("/api/wms/admin/users")
  const [creating, setCreating] = React.useState(false)
  const [resetting, setResetting] = React.useState<UserRow | null>(null)
  const [busy, setBusy] = React.useState(false)

  const act = async (label: string, fn: () => Promise<unknown>, description?: string) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
      await users.refetch()
      toast({ variant: "success", title: label, description })
    } catch (error) {
      toast({ variant: "destructive", title: `${label} failed`, description: describeError(error) })
    } finally {
      setBusy(false)
    }
  }

  const toggleActive = (user: UserRow) =>
    act(
      user.active ? "User deactivated" : "User activated",
      () => users.mutate(() => api.patch(`/api/wms/admin/users/${user.id}`, { active: !user.active })),
      `${user.username} is now ${user.active ? "disabled" : "enabled"}.`,
    )

  const changeRole = (user: UserRow, role: Role) =>
    act(
      "Role updated",
      () => users.mutate(() => api.patch(`/api/wms/admin/users/${user.id}`, { role })),
      `${user.username} is now ${ROLE_LABELS[role]}. Their sessions were revoked.`,
    )

  if (users.initialising) return <LoadingState label="Loading users…" />

  const all = users.data?.users ?? []

  const columns: Column<UserRow>[] = [
    {
      key: "user",
      header: "User",
      render: (row) => (
        <div>
          <p className="font-medium text-gray-900 dark:text-white">{row.name}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">@{row.username}</p>
        </div>
      ),
    },
    { key: "email", header: "Email", render: (row) => <span className="text-xs">{row.email}</span> },
    {
      key: "role",
      header: "Role",
      render: (row) => (
        <Select value={row.role} onValueChange={(value) => changeRole(row, value as Role)} disabled={busy}>
          <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ROLES.map((role) => (
              <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    { key: "permissions", header: "Permissions", align: "right", render: (row) => formatNumber(row.permissionCount) },
    {
      key: "status",
      header: "Status",
      render: (row) => {
        if (row.lockedUntil && Date.now() < Date.parse(row.lockedUntil)) return <StatusBadge status="blocked" />
        if (!row.active) return <StatusBadge status="cancelled" />
        if (row.mustChangePassword) return <StatusBadge status="pending" />
        return <StatusBadge status="success" />
      },
    },
    { key: "lastLogin", header: "Last sign-in", render: (row) => <span className="text-xs">{formatDateTime(row.lastLoginAt)}</span> },
    {
      key: "actions",
      header: "",
      align: "right",
      render: (row) => (
        <div className="flex justify-end gap-1.5">
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setResetting(row)} title="Reset password">
            <KeyRound className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggleActive(row)}>
            {row.active ? "Deactivate" : "Activate"}
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Accounts, roles and access. Role changes revoke live sessions immediately."
        actions={
          <>
            <Button variant="outline" size="sm" onClick={users.refetch} disabled={users.loading}>Refresh</Button>
            <Button size="sm" onClick={() => setCreating(true)}>
              <UserCog className="mr-2 h-4 w-4" />
              New user
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Users" value={formatNumber(all.length)} icon={Users} />
        <StatCard label="Active" value={formatNumber(all.filter((u) => u.active).length)} tone="good" />
        <StatCard
          label="Must change password"
          value={formatNumber(all.filter((u) => u.mustChangePassword).length)}
          tone="warn"
        />
        <StatCard
          label="Locked"
          value={formatNumber(all.filter((u) => u.lockedUntil && Date.now() < Date.parse(u.lockedUntil)).length)}
          tone="bad"
        />
      </div>

      {users.error && <ErrorState message={describeError(users.error)} onRetry={users.refetch} />}

      <Card className="bg-white dark:bg-[#131317]">
        <CardHeader>
          <CardTitle className="text-base">Directory</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable columns={columns} rows={all} emptyMessage="No users." />
        </CardContent>
      </Card>

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreate={async (payload) => {
            await act("User created", () => users.mutate(() => api.post("/api/wms/admin/users", payload)), `${payload.username} must change their password at first sign-in.`)
            setCreating(false)
          }}
        />
      )}

      {resetting && (
        <ResetDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onSubmit={async (password) => {
            await act(
              "Password reset",
              () => users.mutate(() => api.patch(`/api/wms/admin/users/${resetting.id}`, { resetPassword: password })),
              `${resetting.username} must set a new password at next sign-in.`,
            )
            setResetting(null)
          }}
        />
      )}
    </div>
  )
}

function CreateDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (payload: { username: string; email: string; name: string; role: Role; password: string }) => Promise<void>
}) {
  const [username, setUsername] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [name, setName] = React.useState("")
  const [role, setRole] = React.useState<Role>("operator")
  const [password, setPassword] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const valid =
    username.trim().length >= 3 &&
    email.includes("@") &&
    name.trim().length >= 2 &&
    password.length >= 12 &&
    password === confirm

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid) return
    setSubmitting(true)
    setError(null)
    try {
      await onCreate({ username: username.trim(), email: email.trim(), name: name.trim(), role, password })
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title="New user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <Label htmlFor="u-name">Full name</Label>
          <Input id="u-name" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="u-username">Username</Label>
            <Input id="u-username" value={username} onChange={(event) => setUsername(event.target.value)} required className="font-mono" />
          </div>
          <div>
            <Label htmlFor="u-role">Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as Role)}>
              <SelectTrigger id="u-role"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ROLES.map((item) => (
                  <SelectItem key={item} value={item}>{ROLE_LABELS[item]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="u-email">Email</Label>
          <Input id="u-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </div>
        <div>
          <Label htmlFor="u-password">Temporary password</Label>
          <Input id="u-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} />
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            Minimum 12 characters, three of four character classes, no common words. They must change it at first sign-in.
          </p>
        </div>
        <div>
          <Label htmlFor="u-confirm">Confirm password</Label>
          <Input id="u-confirm" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
        </div>

        {password && confirm && password !== confirm && (
          <p className="text-xs text-red-600 dark:text-red-400">Passwords do not match.</p>
        )}
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!valid || submitting}>Create user</Button>
        </div>
      </form>
    </Modal>
  )
}

function ResetDialog({
  user,
  onClose,
  onSubmit,
}: {
  user: UserRow
  onClose: () => void
  onSubmit: (password: string) => Promise<void>
}) {
  const [password, setPassword] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (password.length < 12) return
    setSubmitting(true)
    try {
      await onSubmit(password)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={`Reset password for ${user.username}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Their other sessions are revoked and they must choose a new password at next sign-in.
        </p>
        <div>
          <Label htmlFor="reset-password">New temporary password</Label>
          <Input
            id="reset-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={12}
            autoComplete="new-password"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" disabled={password.length < 12 || submitting}>Reset password</Button>
        </div>
      </form>
    </Modal>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto space-y-4 rounded-lg bg-white p-5 shadow-xl dark:bg-[#131317]">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h2>
        {children}
      </div>
    </div>
  )
}
