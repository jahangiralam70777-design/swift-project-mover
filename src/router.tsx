import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import {
  DefaultErrorFallback,
  DefaultNotFoundFallback,
  DefaultPendingFallback,
} from "./components/route-fallbacks";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Reuse cached data across navigations — keeps page switches instant.
        staleTime: 60_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        // Auto-recover when the network comes back without forcing a refresh.
        refetchOnReconnect: "always",
        // 3 retries with exponential backoff (capped at 5s) — but skip retrying
        // on auth/permission errors where retrying is pointless.
        retry: (failureCount, error) => {
          const msg = (error as Error)?.message ?? "";
          if (/Unauthorized|permission denied|Forbidden|not found|404|401|403/i.test(msg)) {
            return false;
          }
          return failureCount < 3;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 5000),
      },
      mutations: {
        retry: 1,
        retryDelay: 1000,
      },
    },
  });


  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadDelay: 30,
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: DefaultErrorFallback,
    defaultNotFoundComponent: DefaultNotFoundFallback,
    defaultPendingComponent: DefaultPendingFallback,
    // Never flash a pending UI during navigation — keep the previous page
    // visible until the next route is ready.
    defaultPendingMs: 10_000,
    defaultPendingMinMs: 0,
  });

  return router;
};
