/// <reference lib="webworker" />

/**
 * Service worker.
 *
 * Scope is deliberately narrow: make the app shell open instantly with no
 * network, and never touch the API or credentials.
 *
 * Two rules matter most:
 *
 *  1. **Sheets and OAuth are NetworkOnly.** Caching them would mean serving
 *     stale focus data as though it were current, and could park an access token
 *     in the Cache API where it has no business being. The local IndexedDB store
 *     is already the offline source of truth (see src/lib/store/db.ts), so there
 *     is nothing to gain and real correctness to lose.
 *
 *  2. **Background Sync is deliberately absent.** Draining the outbox with the
 *     app closed would need the JWT signing duplicated in here, which means a
 *     second copy of the credential path that can silently rot. The timer only
 *     runs while the app is open, so the page-driven sync in
 *     src/lib/sync/triggers.ts covers real usage.
 */

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      // Never cache Google. See rule 1 above.
      matcher: ({ url }) =>
        url.hostname === "sheets.googleapis.com" || url.hostname === "oauth2.googleapis.com",
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();
