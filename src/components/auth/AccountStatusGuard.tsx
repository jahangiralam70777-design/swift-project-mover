import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAppStore } from "@/stores/app-store";
import { clearClientAuthStorage, signOut } from "@/lib/auth-client";

/**
 * Real-time account status enforcement.
 *
 * Forces the current device (and all other open tabs) to sign out the moment:
 *  - the profile row is deleted or soft-deleted (`deleted_at` set / status=suspended)
 *  - a new active row appears in `user_bans` for the user
 *  - the underlying `auth.users` row is gone (permanent_delete)
 *  - Supabase fires `USER_DELETED` / `SIGNED_OUT` from another source
 *  - any other tab broadcasts a forced-logout event
 *
 * Detection layers (defence in depth):
 *  1. Supabase realtime channels on `profiles` + `user_bans`
 *  2. `supabase.auth.onAuthStateChange` listener
 *  3. Periodic 2s probe → `auth.getUser()` + `is_user_banned` RPC
 *  4. Probe on tab focus / online / route change
 *  5. Cross-tab BroadcastChannel + `storage` event sync
 *
 * No page refresh is required — the user lands on /login immediately.
 */

const LOGOUT_BROADCAST_KEY = "edumaster.force_logout";
const LOGOUT_CHANNEL = "edumaster-account-status";

type LogoutReason = "deleted" | "banned" | "missing";

export function AccountStatusGuard() {
  const user = useAppStore((s) => s.user);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const routerLocation = useRouterState({ select: (s) => s.location.pathname });
  const kickedRef = useRef(false);

  useEffect(() => {
    if (!user?.id) {
      kickedRef.current = false;
      return;
    }
    const uid = user.id;
    let stopped = false;

    const broadcast = (reason: LogoutReason) => {
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(
            LOGOUT_BROADCAST_KEY,
            JSON.stringify({ uid, reason, ts: Date.now() }),
          );
        }
      } catch {
        /* ignore quota errors */
      }
      try {
        bc?.postMessage({ uid, reason });
      } catch {
        /* ignore */
      }
    };

    const forceLogout = async (reason: LogoutReason, fromBroadcast = false) => {
      if (kickedRef.current || stopped) return;
      kickedRef.current = true;
      console.warn(
        `[AccountStatusGuard] force logout uid=${uid} reason=${reason} broadcast=${fromBroadcast}`,
      );
      if (!fromBroadcast) broadcast(reason);
      await queryClient.cancelQueries().catch(() => undefined);
      queryClient.clear();
      try {
        await signOut();
      } catch (e) {
        console.warn("[AccountStatusGuard] signOut failed", e);
      }
      clearClientAuthStorage({ all: true });
      useAppStore.setState((state) => ({
        user: null,
        sessionReady: true,
        authLoading: false,
        authError: null,
        authVersion: Math.max(state.authVersion + 1, Date.now()),
        quizRuntime: { active: false, score: 0, answered: 0 },
      }));
      const message =
        reason === "banned"
          ? "Your account has been banned by an administrator."
          : reason === "deleted"
            ? "Your account has been removed by an administrator."
            : "Your session is no longer valid. Please sign in again.";
      toast.error(message, { duration: 8000 });
      try {
        navigate({ to: "/login", replace: true });
      } catch {
        if (typeof window !== "undefined") window.location.replace("/login");
      }
    };

    // --- Cross-tab sync ---
    let bc: BroadcastChannel | null = null;
    try {
      bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(LOGOUT_CHANNEL) : null;
    } catch {
      bc = null;
    }
    if (bc) {
      bc.onmessage = (evt) => {
        const data = evt.data as { uid?: string; reason?: LogoutReason } | null;
        if (data?.uid === uid && data.reason) void forceLogout(data.reason, true);
      };
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LOGOUT_BROADCAST_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue) as { uid?: string; reason?: LogoutReason };
        if (parsed.uid === uid && parsed.reason) void forceLogout(parsed.reason, true);
      } catch {
        /* ignore */
      }
    };
    if (typeof window !== "undefined") window.addEventListener("storage", onStorage);

    // --- Supabase auth state listener (catches USER_DELETED / SIGNED_OUT
    // originating outside this guard). Fire-and-forget per Supabase guidance
    // to avoid deadlocking the auth state machine.
    const { data: authSub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        // Another tab signed out, or the session was revoked. Don't double
        // toast — just navigate.
        if (kickedRef.current) return;
        kickedRef.current = true;
        try {
          navigate({ to: "/login", replace: true });
        } catch {
          if (typeof window !== "undefined") window.location.replace("/login");
        }
      } else if ((event as string) === "USER_DELETED") {
        void forceLogout("deleted");
      }
    });

    // --- Realtime DB triggers ---
    const channel = supabase
      .channel(`account-status-${uid}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "profiles", filter: `id=eq.${uid}` },
        (payload) => {
          const next = payload.new as { deleted_at?: string | null; status?: string | null } | null;
          if (!next) return;
          if (next.deleted_at) void forceLogout("deleted");
          else if (next.status === "suspended" || next.status === "deleted") {
            void forceLogout("banned");
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "profiles", filter: `id=eq.${uid}` },
        () => void forceLogout("deleted"),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "user_bans", filter: `user_id=eq.${uid}` },
        () => void forceLogout("banned"),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "user_bans", filter: `user_id=eq.${uid}` },
        (payload) => {
          const next = payload.new as { lifted_at?: string | null; ends_at?: string | null } | null;
          if (
            !next?.lifted_at &&
            (!next?.ends_at || new Date(next.ends_at).getTime() > Date.now())
          ) {
            void forceLogout("banned");
          }
        },
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "account_status_events",
          filter: `user_id=eq.${uid}`,
        },
        (payload) => {
          const next = payload.new as { reason?: LogoutReason | "suspended" | null } | null;
          void forceLogout(
            next?.reason === "banned" || next?.reason === "suspended" ? "banned" : "deleted",
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "user_sessions", filter: `user_id=eq.${uid}` },
        (payload) => {
          const sid =
            (payload.new as { active_session_id?: string | null } | null)?.active_session_id ?? "";
          if (sid.startsWith("revoked:banned") || sid.startsWith("revoked:suspended")) {
            void forceLogout("banned");
          } else if (sid.startsWith("revoked:")) void forceLogout("deleted");
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "user_sessions", filter: `user_id=eq.${uid}` },
        () => void forceLogout("deleted"),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          console.log(`[AccountStatusGuard] realtime subscribed uid=${uid}`);
        }
      });

    // --- Periodic probe (covers missed realtime events + permanent_delete
    // where the local JWT is still technically valid) ---
    const probe = async () => {
      if (stopped || kickedRef.current) return;
      try {
        // getUser() revalidates with the Auth server (vs getSession()).
        const { data, error } = await supabase.auth.getUser();
        if (error || !data?.user) {
          const msg = (error?.message ?? "").toLowerCase();
          if (
            !data?.user ||
            msg.includes("user_not_found") ||
            msg.includes("not found") ||
            msg.includes("user from sub claim")
          ) {
            void forceLogout("deleted");
            return;
          }
          return; // transient — try again next tick
        }
        // Profile presence check — covers soft delete edge cases that the
        // realtime channel missed (e.g. session was offline).
        const { data: prof } = await supabase
          .from("profiles")
          .select("id,deleted_at,status")
          .eq("id", uid)
          .maybeSingle();
        if (!prof) {
          void forceLogout("deleted");
          return;
        }
        const p = prof as { deleted_at: string | null; status: string | null };
        if (p.deleted_at) {
          void forceLogout("deleted");
          return;
        }
        if (p.status === "suspended" || p.status === "deleted") {
          void forceLogout("banned");
          return;
        }
        // Ban probe via SECURITY DEFINER RPC.
        const { data: banned } = await (
          supabase as unknown as {
            rpc: (
              n: string,
              a: Record<string, unknown>,
            ) => Promise<{ data: boolean | null; error: unknown }>;
          }
        ).rpc("is_user_banned", { _user_id: uid });
        if (banned === true) {
          void forceLogout("banned");
          return;
        }
        const { data: event } = await supabase
          .from("account_status_events")
          .select("reason")
          .eq("user_id", uid)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (event?.reason === "banned" || event?.reason === "suspended") {
          void forceLogout("banned");
        } else if (event?.reason === "deleted" || event?.reason === "missing") {
          void forceLogout("deleted");
        }
      } catch {
        /* network blip — try again next tick */
      }
    };

    const PROBE_MS = 2_000;
    const interval = window.setInterval(probe, PROBE_MS);
    const onFocus = () => void probe();
    const onOnline = () => void probe();
    const onVisible = () => {
      if (document.visibilityState === "visible") void probe();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    const initial = window.setTimeout(() => void probe(), 250);

    return () => {
      stopped = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisible);
      try {
        bc?.close();
      } catch {
        /* ignore */
      }
      try {
        authSub.subscription.unsubscribe();
      } catch {
        /* ignore */
      }
      void supabase.removeChannel(channel);
    };
  }, [user?.id, navigate, queryClient]);

  // Probe on route change — guarantees the very next protected page nav
  // re-validates without waiting for the 10s interval.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.auth.getUser();
        if (cancelled) return;
        if (error || !data?.user) {
          const msg = (error?.message ?? "").toLowerCase();
          if (!data?.user || msg.includes("not found") || msg.includes("user_not_found")) {
            // Synthesise a logout the same way the main probe does.
            try {
              await signOut();
            } catch {
              /* noop */
            }
            toast.error("Your session is no longer valid. Please sign in again.", {
              duration: 8000,
            });
            try {
              navigate({ to: "/login", replace: true });
            } catch {
              window.location.replace("/login");
            }
          }
        }
      } catch {
        /* network blip */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routerLocation, user?.id, navigate]);

  return null;
}
