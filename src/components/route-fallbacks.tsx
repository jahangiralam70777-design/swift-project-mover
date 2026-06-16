import { useEffect, useRef, useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { AlertTriangle, Loader2 } from "lucide-react";

// Instant navigation: never render a pending fallback between routes.
// Previous page stays on screen until the next route is ready (TanStack
// Router default behavior when no pending component is shown).
export function DefaultPendingFallback() {
  return null;
}

export function DefaultNotFoundFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center px-4">
      <div className="max-w-md text-center">
        <h2 className="text-lg font-semibold text-foreground">Not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page or resource you're looking for doesn't exist.
        </p>
        <div className="mt-4">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAYS_MS = [400, 1200, 3000];

function isNonRetryable(error: Error | undefined) {
  const msg = error?.message ?? "";
  return /Unauthorized|permission denied|Forbidden|not found|404|401|403/i.test(msg);
}

export function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const [attempts, setAttempts] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof console !== "undefined") {
      console.error("[route-error]", error);
    }
  }, [error]);

  // Silent auto-recovery: try a few times with exponential backoff before
  // showing the user-facing error. Skip for auth/permission errors.
  useEffect(() => {
    if (isNonRetryable(error)) return;
    if (attempts >= MAX_AUTO_RETRIES) return;
    setRecovering(true);
    const delay = AUTO_RETRY_DELAYS_MS[Math.min(attempts, AUTO_RETRY_DELAYS_MS.length - 1)];
    timerRef.current = setTimeout(async () => {
      try {
        await router.invalidate();
      } catch {
        // ignore — boundary will re-render with the next error if any
      }
      setAttempts((a) => a + 1);
      reset();
    }, delay);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setRecovering(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempts, error]);

  // While silently retrying, render a soft inline spinner — never the scary
  // "didn't load" panel. Keeps section-level failures from looking like crashes.
  if (recovering && attempts < MAX_AUTO_RETRIES && !isNonRetryable(error)) {
    return (
      <div
        className="flex min-h-[20vh] items-center justify-center px-4 py-8"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Reloading…</span>
      </div>
    );
  }

  const message = isNonRetryable(error)
    ? "You don't have permission to view this. Ask an admin if you think this is a mistake."
    : "Something went wrong loading this page. You can try again or head back home.";

  return (
    <div className="flex min-h-[40vh] items-center justify-center px-4 py-10">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-foreground">This section didn't load</h2>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={async () => {
              setAttempts(0);
              try {
                await router.invalidate();
              } catch {
                // ignore
              }
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

