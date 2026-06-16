import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { useMemo, useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  ArrowLeft,
  Search,
  Download,
  Loader2,
  BadgeCheck,
  Crown,
  ShieldCheck,
  Shield,
  Activity,
  GraduationCap,
  Filter as FilterIcon,
  MoreHorizontal,
  Eye,
  ShieldOff,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Trash2,
  RotateCcw,
} from "lucide-react";
import {
  adminListUsers,
  adminSetUserStatus,
  adminVerifyUser,
  adminSoftDeleteUser,
  adminHardDeleteUser,
  adminRestoreUser,
} from "@/lib/admin-users.functions";
import { verifyAdminAccess } from "@/lib/admin-verify.functions";
import { getRoleDisplayName } from "@/lib/role-display";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { UserCommandDrawer } from "@/components/admin/users/UserCommandDrawer";

const statusEnum = z.enum(["active", "suspended", "pending", "deleted"]);
const roleEnum = z.enum(["admin", "moderator", "student"]);
const dateEnum = z.enum(["24h", "7d", "30d", "lifetime"]);
const sortEnum = z.enum(["recent", "name", "logins", "usage", "lastLogin"]);

const searchSchema = z.object({
  status: fallback(statusEnum.optional(), undefined),
  role: fallback(roleEnum.optional(), undefined),
  verified: fallback(z.boolean().optional(), undefined),
  dateRange: fallback(dateEnum.optional(), undefined),
  q: fallback(z.string().max(200), "").default(""),
  sort: fallback(sortEnum, "recent").default("recent"),
  page: fallback(z.number().int().min(1), 1).default(1),
  pageSize: fallback(z.number().int().min(10).max(100), 25).default(25),
  title: fallback(z.string().max(80), "").default(""),
});

export const Route = createFileRoute("/admin/users/list")({
  validateSearch: zodValidator(searchSchema),
  component: AdminUsersListPage,
  head: () => ({
    meta: [
      { title: "User Drilldown · CA Aspire BD Admin" },
      {
        name: "description",
        content: "Filtered drilldown of users across status, role, verification and activity.",
      },
    ],
  }),
});

type Row = {
  id: string;
  display_name: string;
  level: string;
  status: string;
  email: string | null;
  email_verified: boolean;
  roles: string[];
  last_login_at: string | null;
  total_login_count: number | null;
  total_usage_seconds: number | null;
  created_at: string;
};

function AdminUsersListPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: "/admin/users/list" });
  const [q, setQ] = useState(search.q);
  const [drawerUser, setDrawerUser] = useState<Row | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: "soft-delete" | "hard-delete"; user: Row }
    | null
  >(null);
  const [confirmText, setConfirmText] = useState("");
  const qc = useQueryClient();

  // Server-verified role for RBAC (super_admin gates hard delete)
  const verifyFn = useServerFn(verifyAdminAccess);
  const access = useQuery({
    queryKey: ["admin-verify-access"],
    queryFn: () => verifyFn(),
    staleTime: 60_000,
  });
  const isSuperAdmin = access.data?.role === "super_admin";

  const listFn = useServerFn(adminListUsers);
  const queryKey = ["admin-users-drilldown", search] as const;
  const { data, isFetching, error } = useQuery({
    queryKey,
    queryFn: () =>
      listFn({
        data: {
          search: search.q || undefined,
          status: search.status,
          role: search.role,
          verified: search.verified,
          dateRange: search.dateRange,
          page: search.page,
          pageSize: search.pageSize,
        },
      }),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

  // Invalidate every user-related query so KPI cards + drilldown stay in sync.
  function invalidateAll() {
    qc.invalidateQueries({ queryKey: ["admin-users-drilldown"] });
    qc.invalidateQueries({ queryKey: ["admin-user-stats"] });
    qc.invalidateQueries({ queryKey: ["admin-user-trends"] });
    qc.invalidateQueries({ queryKey: ["admin", "users"] });
  }

  const setStatusFn = useServerFn(adminSetUserStatus);
  const verifyUserFn = useServerFn(adminVerifyUser);
  const softDeleteFn = useServerFn(adminSoftDeleteUser);
  const hardDeleteFn = useServerFn(adminHardDeleteUser);
  const restoreFn = useServerFn(adminRestoreUser);

  const setStatus = useMutation({
    mutationFn: (v: { id: string; status: "active" | "suspended" | "pending" }) =>
      setStatusFn({ data: v }),
    onSuccess: (_d, v) => {
      toast.success(`User ${v.status === "active" ? "reactivated" : v.status}`);
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const verifyUser = useMutation({
    mutationFn: (id: string) => verifyUserFn({ data: { id } }),
    onSuccess: () => {
      toast.success("User verified");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const softDelete = useMutation({
    mutationFn: (id: string) => softDeleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("User removed");
      invalidateAll();
      setConfirm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const hardDelete = useMutation({
    mutationFn: (v: { id: string; confirmName: string }) => hardDeleteFn({ data: v }),
    onSuccess: () => {
      toast.success("User permanently deleted");
      invalidateAll();
      setConfirm(null);
      setConfirmText("");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const restore = useMutation({
    mutationFn: (id: string) => restoreFn({ data: { id } }),
    onSuccess: () => {
      toast.success("User restored");
      invalidateAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });


  const rows: Row[] = (data?.rows ?? []) as Row[];
  const sorted = useMemo(() => {
    const arr = [...rows];
    switch (search.sort) {
      case "name":
        arr.sort((a, b) => a.display_name.localeCompare(b.display_name));
        break;
      case "logins":
        arr.sort((a, b) => (b.total_login_count ?? 0) - (a.total_login_count ?? 0));
        break;
      case "usage":
        arr.sort((a, b) => (b.total_usage_seconds ?? 0) - (a.total_usage_seconds ?? 0));
        break;
      case "lastLogin":
        arr.sort(
          (a, b) =>
            new Date(b.last_login_at ?? 0).getTime() - new Date(a.last_login_at ?? 0).getTime(),
        );
        break;
      default:
        arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    }
    return arr;
  }, [rows, search.sort]);

  const total = data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / search.pageSize));

  function update(patch: Partial<typeof search>) {
    navigate({ search: (prev) => ({ ...prev, ...patch, page: patch.page ?? 1 }) });
  }

  function exportCsv() {
    const header = [
      "id",
      "name",
      "email",
      "level",
      "status",
      "verified",
      "roles",
      "logins",
      "usage_seconds",
      "last_login_at",
      "created_at",
    ];
    const lines = [header.join(",")].concat(
      sorted.map((r) =>
        [
          r.id,
          csv(r.display_name),
          csv(r.email ?? ""),
          csv(r.level),
          csv(r.status),
          r.email_verified ? "yes" : "no",
          csv((r.roles ?? []).join("|")),
          r.total_login_count ?? 0,
          r.total_usage_seconds ?? 0,
          r.last_login_at ?? "",
          r.created_at,
        ].join(","),
      ),
    );
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `users-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const heading = search.title || buildTitle(search);

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 p-4 lg:p-6">
      <header className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 sm:flex sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-1">
          <Link
            to="/admin/users"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors group"
          >
            <ArrowLeft className="h-4 w-4 transition-transform group-hover:-translate-x-0.5" />
            Back to User Management
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground md:text-3xl truncate">
              {heading}
            </h1>
            <span className="px-2.5 py-0.5 rounded-full bg-secondary border border-border text-xs font-semibold text-secondary-foreground tabular-nums">
              {isFetching ? "…" : `${total.toLocaleString()} total`}
            </span>
          </div>
          {summarizeFilters(search) && (
            <p className="text-xs text-muted-foreground truncate">{summarizeFilters(search)}</p>
          )}
        </div>
        <Button size="sm" variant="outline" className="rounded-xl h-9 shrink-0" onClick={exportCsv}>
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
      </header>

      <section className="sticky top-0 z-20 rounded-2xl border border-border bg-card/95 backdrop-blur shadow-card p-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") update({ q });
            }}
            onBlur={() => {
              if (q !== search.q) update({ q });
            }}
            placeholder="Search name, email, or user id…"
            className="rounded-xl pl-10 bg-background border-border focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="h-6 w-px bg-border hidden md:block" />
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={search.status ?? "all"}
            onValueChange={(v) =>
              update({ status: v === "all" ? undefined : (v as z.infer<typeof statusEnum>) })
            }
          >
            <SelectTrigger className="rounded-xl w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="suspended">Suspended</SelectItem>
              <SelectItem value="deleted">Deleted</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={search.role ?? "all"}
            onValueChange={(v) =>
              update({ role: v === "all" ? undefined : (v as z.infer<typeof roleEnum>) })
            }
          >
            <SelectTrigger className="rounded-xl w-[140px]">
              <SelectValue placeholder="Role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="moderator">Moderator</SelectItem>
              <SelectItem value="student">Student</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={
              search.verified === true ? "yes" : search.verified === false ? "no" : "all"
            }
            onValueChange={(v) =>
              update({ verified: v === "all" ? undefined : v === "yes" })
            }
          >
            <SelectTrigger className="rounded-xl w-[160px]">
              <SelectValue placeholder="Verified" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any verification</SelectItem>
              <SelectItem value="yes">Verified</SelectItem>
              <SelectItem value="no">Unverified</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={search.dateRange ?? "all"}
            onValueChange={(v) =>
              update({ dateRange: v === "all" ? undefined : (v as z.infer<typeof dateEnum>) })
            }
          >
            <SelectTrigger className="rounded-xl w-[140px]">
              <SelectValue placeholder="Date" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any date</SelectItem>
              <SelectItem value="24h">Active last 24h</SelectItem>
              <SelectItem value="7d">Active last 7 days</SelectItem>
              <SelectItem value="30d">Active last 30 days</SelectItem>
              <SelectItem value="lifetime">Lifetime</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={search.sort}
            onValueChange={(v) => update({ sort: v as z.infer<typeof sortEnum> })}
          >
            <SelectTrigger className="rounded-xl w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Newest first</SelectItem>
              <SelectItem value="lastLogin">Latest login</SelectItem>
              <SelectItem value="logins">Most logins</SelectItem>
              <SelectItem value="usage">Most usage</SelectItem>
              <SelectItem value="name">Name (A–Z)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>


      <section className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
        <div className="max-h-[calc(100vh-22rem)] min-h-[320px] overflow-auto">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-border bg-muted text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <th className="px-6 py-3.5 text-left font-semibold">User</th>
                <th className="px-6 py-3.5 text-left font-semibold min-w-[200px]">Email</th>
                <th className="px-4 py-3.5 text-left font-semibold w-[110px]">Level</th>
                <th className="px-4 py-3.5 text-left font-semibold w-[140px]">Status</th>
                <th className="px-4 py-3.5 text-left font-semibold w-[240px]">Role</th>
                <th className="px-6 py-3.5 text-left font-semibold w-[180px]">Last Login</th>
                <th className="px-4 py-3.5 w-[64px] text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isFetching && sorted.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center text-muted-foreground">
                    <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading users…
                  </td>
                </tr>
              )}
              {!isFetching && sorted.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-10 text-center text-muted-foreground">
                    No users match these filters.
                  </td>
                </tr>
              )}
              {sorted.map((u) => {
                const isTargetAdmin = (u.roles ?? []).some(
                  (r) => r === "admin" || r === "super_admin",
                );
                const initials = u.display_name
                  .split(" ")
                  .map((n) => n[0])
                  .slice(0, 2)
                  .join("")
                  .toUpperCase();
                const bgGradient =
                  u.status === "active"
                    ? "from-primary to-accent"
                    : u.status === "pending"
                      ? "from-amber-500 to-orange-400"
                      : u.status === "suspended"
                        ? "from-rose-500 to-red-400"
                        : "from-muted-foreground to-muted";
                return (
                  <tr
                    key={u.id}
                    className="group cursor-pointer hover:bg-muted/20 transition-colors"
                    onClick={() => setDrawerUser(u)}
                  >
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-full bg-gradient-to-tr ${bgGradient} flex items-center justify-center text-white text-sm font-semibold shadow-inner shrink-0`}>
                          {initials}
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-foreground">{u.display_name}</div>
                          <div className="text-[10px] font-mono text-muted-foreground uppercase tracking-tight">
                            {u.id.slice(0, 8)}…
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                        {u.email ?? "—"}
                        {u.email_verified && <BadgeCheck className="h-3.5 w-3.5 text-emerald-400" />}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <LevelBadge level={u.level} />
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {(() => {
                          const roles = u.roles ?? [];
                          const primary = pickPrimaryRole(roles);
                          const extras = roles.filter((r) => r !== primary);
                          if (!primary) {
                            return <RoleBadge role="student" />;
                          }
                          return (
                            <>
                              <RoleBadge role={primary} />
                              {extras.map((r) => (
                                <RoleBadge key={r} role={r} subtle />
                              ))}
                            </>
                          );
                        })()}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="text-xs text-muted-foreground">{fmtDateTime(u.last_login_at)}</div>
                      <div className="text-[10px] text-muted-foreground/70">
                        {(u.total_login_count ?? 0).toLocaleString()} logins total
                      </div>
                    </td>
                    <td
                      className="px-6 py-4 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 rounded-lg opacity-60 group-hover:opacity-100 transition-opacity"
                            aria-label="User actions"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuLabel className="text-[11px]">
                            {u.display_name}
                          </DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setDrawerUser(u)}>
                            <Eye className="mr-2 h-3.5 w-3.5" /> View full profile
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {!u.email_verified ? (
                            <DropdownMenuItem
                              onSelect={() => verifyUser.mutate(u.id)}
                              disabled={verifyUser.isPending}
                            >
                              <CheckCircle2 className="mr-2 h-3.5 w-3.5 text-emerald-400" />
                              Verify user
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem disabled>
                              <XCircle className="mr-2 h-3.5 w-3.5" /> Already verified
                            </DropdownMenuItem>
                          )}
                          {u.status !== "suspended" ? (
                            <DropdownMenuItem
                              onSelect={() =>
                                setStatus.mutate({ id: u.id, status: "suspended" })
                              }
                              disabled={setStatus.isPending}
                            >
                              <ShieldOff className="mr-2 h-3.5 w-3.5 text-amber-400" />
                              Suspend / Ban
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onSelect={() =>
                                setStatus.mutate({ id: u.id, status: "active" })
                              }
                              disabled={setStatus.isPending}
                            >
                              <ShieldCheck className="mr-2 h-3.5 w-3.5 text-emerald-400" />
                              Reactivate / Unban
                            </DropdownMenuItem>
                          )}
                          {u.status !== "pending" && u.status !== "deleted" && (
                            <DropdownMenuItem
                              onSelect={() =>
                                setStatus.mutate({ id: u.id, status: "pending" })
                              }
                              disabled={setStatus.isPending}
                            >
                              <ShieldAlert className="mr-2 h-3.5 w-3.5 text-amber-400" />
                              Move to Pending
                            </DropdownMenuItem>
                          )}
                          {u.status === "deleted" && (
                            <DropdownMenuItem
                              onSelect={() => restore.mutate(u.id)}
                              disabled={restore.isPending}
                            >
                              <RotateCcw className="mr-2 h-3.5 w-3.5" /> Restore user
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() => setConfirm({ kind: "soft-delete", user: u })}
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" /> Remove (soft delete)
                          </DropdownMenuItem>
                          {isSuperAdmin && (
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              disabled={isTargetAdmin}
                              onSelect={() => {
                                setConfirmText("");
                                setConfirm({ kind: "hard-delete", user: u });
                              }}
                            >
                              <Trash2 className="mr-2 h-3.5 w-3.5" />
                              {isTargetAdmin
                                ? "Delete (protected admin)"
                                : "Permanently delete"}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border/40 px-6 py-3 text-xs text-muted-foreground">
          <div>
            Page <span className="font-medium text-foreground">{search.page}</span> of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="rounded-lg h-8"
              disabled={search.page <= 1}
              onClick={() => update({ page: search.page - 1 })}
            >
              <ArrowLeft className="h-3 w-3 mr-1" /> Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-lg h-8"
              disabled={search.page >= totalPages}
              onClick={() => update({ page: search.page + 1 })}
            >
              Next <ArrowLeft className="h-3 w-3 ml-1 rotate-180" />
            </Button>
          </div>
        </div>
      </section>
      {error && <p className="text-xs text-destructive">{(error as Error).message}</p>}

      <UserCommandDrawer
        user={
          drawerUser
            ? {
                id: drawerUser.id,
                display_name: drawerUser.display_name,
                email: drawerUser.email,
                status: drawerUser.status,
                level: drawerUser.level,
                roles: drawerUser.roles,
                created_at: drawerUser.created_at,
                last_login_at: drawerUser.last_login_at,
                total_login_count: drawerUser.total_login_count ?? 0,
                email_verified: drawerUser.email_verified,
              }
            : null
        }
        onClose={() => setDrawerUser(null)}
      />

      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o) {
            setConfirm(null);
            setConfirmText("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "hard-delete"
                ? "Permanently delete user?"
                : "Remove user?"}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  {confirm?.kind === "hard-delete"
                    ? "This permanently deletes the auth record and profile. This action cannot be undone."
                    : "The user will be soft-deleted and signed out everywhere. You can restore them later."}
                </p>
                {confirm && (
                  <p className="font-medium text-foreground">
                    {confirm.user.display_name} · {confirm.user.email ?? confirm.user.id.slice(0, 8)}
                  </p>
                )}
                {confirm?.kind === "hard-delete" && confirm && (
                  <div className="space-y-1">
                    <p className="text-xs">
                      Type <span className="font-mono text-foreground">{confirm.user.display_name}</span> to confirm.
                    </p>
                    <Input
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      placeholder={confirm.user.display_name}
                      className="rounded-lg"
                    />
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                (confirm?.kind === "hard-delete" &&
                  confirmText !== confirm.user.display_name) ||
                softDelete.isPending ||
                hardDelete.isPending
              }
              onClick={(e) => {
                e.preventDefault();
                if (!confirm) return;
                if (confirm.kind === "soft-delete") {
                  softDelete.mutate(confirm.user.id);
                } else {
                  hardDelete.mutate({
                    id: confirm.user.id,
                    confirmName: confirmText,
                  });
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {confirm?.kind === "hard-delete" ? "Delete forever" : "Remove user"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}


function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; dot: string; label: string }> = {
    active: {
      cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-500/40 ring-1 ring-inset ring-emerald-500/15",
      dot: "bg-emerald-500 dark:bg-emerald-400",
      label: "Active",
    },
    pending: {
      cls: "bg-amber-500/15 text-amber-800 dark:text-amber-200 border-amber-500/40 ring-1 ring-inset ring-amber-500/15",
      dot: "bg-amber-500 dark:bg-amber-400",
      label: "Pending",
    },
    suspended: {
      cls: "bg-rose-500/15 text-rose-700 dark:text-rose-200 border-rose-500/40 ring-1 ring-inset ring-rose-500/15",
      dot: "bg-rose-500 dark:bg-rose-400",
      label: "Suspended",
    },
    deleted: {
      cls: "bg-muted text-muted-foreground border-border",
      dot: "bg-muted-foreground",
      label: "Deleted",
    },
  };
  const s = map[status] ?? map.deleted;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-tight border whitespace-nowrap ${s.cls}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${s.dot} ${status === "active" ? "animate-pulse" : ""}`}
      />
      {s.label}
    </span>
  );
}

const ROLE_PRIORITY = ["super_admin", "admin", "moderator", "teacher", "student"];

function pickPrimaryRole(roles: string[]): string | undefined {
  for (const r of ROLE_PRIORITY) {
    if (roles.includes(r)) return r;
  }
  return roles[0];
}

type RoleStyle = {
  cls: string;
  subtleCls: string;
  Icon: typeof Crown;
};

const ROLE_STYLES: Record<string, RoleStyle> = {
  super_admin: {
    cls: "bg-amber-500/20 text-amber-800 dark:text-amber-200 border-amber-500/50 ring-1 ring-inset ring-amber-500/20",
    subtleCls: "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30",
    Icon: Crown,
  },
  admin: {
    cls: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 border-indigo-500/45 ring-1 ring-inset ring-indigo-500/15",
    subtleCls: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
    Icon: ShieldCheck,
  },
  moderator: {
    cls: "bg-sky-500/15 text-sky-700 dark:text-sky-200 border-sky-500/45 ring-1 ring-inset ring-sky-500/15",
    subtleCls: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25",
    Icon: Shield,
  },
  teacher: {
    cls: "bg-violet-500/15 text-violet-700 dark:text-violet-200 border-violet-500/45 ring-1 ring-inset ring-violet-500/15",
    subtleCls: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/25",
    Icon: Activity,
  },
  student: {
    cls: "bg-slate-500/15 text-slate-700 dark:text-slate-200 border-slate-500/35 ring-1 ring-inset ring-slate-500/10",
    subtleCls: "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/25",
    Icon: GraduationCap,
  },
};

function RoleBadge({ role, subtle = false }: { role: string; subtle?: boolean }) {
  const style = ROLE_STYLES[role] ?? ROLE_STYLES.student;
  const { Icon } = style;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-tight border whitespace-nowrap ${
        subtle ? style.subtleCls : style.cls
      }`}
    >
      <Icon className="h-3 w-3" strokeWidth={2.5} />
      {getRoleDisplayName(role)}
    </span>
  );
}

function LevelBadge({ level }: { level: number | string | null | undefined }) {
  const display = level === null || level === undefined || level === "" ? "—" : String(level);
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold border border-border bg-muted text-foreground tabular-nums">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Lv</span>
      {display}
    </span>
  );
}

function fmtDateTime(iso: string | null) {
  if (!iso) return "Never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function csv(v: string) {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function buildTitle(s: z.infer<typeof searchSchema>) {
  if (s.verified === true) return "Verified users";
  if (s.verified === false) return "Unverified users";
  if (s.role === "admin") return "Administrators";
  if (s.role === "moderator") return "Moderators";
  if (s.status === "active") return "Active users";
  if (s.status === "pending") return "Pending users";
  if (s.status === "suspended") return "Suspended users";
  if (s.status === "deleted") return "Deleted users";
  if (s.dateRange === "24h") return "Active in last 24 hours";
  if (s.dateRange === "7d") return "Active in last 7 days";
  if (s.dateRange === "30d") return "Active in last 30 days";
  return "All users";
}

function summarizeFilters(s: z.infer<typeof searchSchema>) {
  const parts: string[] = [];
  if (s.status) parts.push(`status: ${s.status}`);
  if (s.role) parts.push(`role: ${s.role}`);
  if (s.verified === true) parts.push("verified");
  if (s.verified === false) parts.push("unverified");
  if (s.dateRange) parts.push(`active: ${s.dateRange}`);
  if (s.q) parts.push(`search: "${s.q}"`);
  return parts.join(" · ");
}
