/* eslint-disable @typescript-eslint/no-explicit-any */

export type AccountRevocationReason = "deleted" | "banned" | "suspended" | "missing";

export async function publishAccountRevocation(
  supabaseAdmin: any,
  input: {
    userId: string;
    reason: AccountRevocationReason;
    actorId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const marker = `revoked:${input.reason}:${Date.now()}`;
  const writes = [
    supabaseAdmin.from("account_status_events").insert({
      user_id: input.userId,
      reason: input.reason,
      created_by: input.actorId ?? null,
      metadata: input.metadata ?? {},
      created_at: now,
    }),
    supabaseAdmin.from("user_sessions").upsert(
      {
        user_id: input.userId,
        active_session_id: marker,
        user_agent: `admin:${input.reason}`,
        updated_at: now,
      },
      { onConflict: "user_id" },
    ),
  ];

  const results = await Promise.allSettled(writes);
  for (const result of results) {
    if (result.status === "fulfilled" && result.value?.error) {
      console.warn("[account-revocation] publish warning", result.value.error.message);
    } else if (result.status === "rejected") {
      console.warn("[account-revocation] publish warning", result.reason);
    }
  }
}