"use client";

/**
 * Development-only service worker guard.
 *
 * The production build writes `public/sw.js`, which then sits on disk and is
 * served statically by `next dev` as well. So a worker registered during a
 * production run keeps controlling localhost afterwards and answers navigations
 * from a precache full of the *old* build's hashed chunks. The symptom is a page
 * that fails to load for no visible reason, and clearing it is not obvious.
 *
 * `predev` deletes the file so nothing new registers, and this unregisters
 * anything already installed and drops its caches.
 *
 * Compiled out of production builds: `process.env.NODE_ENV` is statically
 * replaced, so the whole body is dead code that the bundler removes. It must
 * never run in production, where unregistering would break the PWA.
 */

import { useEffect } from "react";

export function DevServiceWorkerGuard() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    void (async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      if (registrations.length === 0) return;

      await Promise.all(registrations.map((registration) => registration.unregister()));

      // The precache outlives the registration, so clear it too.
      if (typeof caches !== "undefined") {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }

      // A console message is the right channel here: it explains a reload the
      // user did not ask for, in development only.
      console.info(
        "[focus-log] Removed a stale service worker left over from a production build, and cleared its caches. Reloading once.",
      );
      window.location.reload();
    })();
  }, []);

  return null;
}
