/**
 * Navigation fallback served by the service worker when a route is not in the
 * precache and the network is unreachable.
 *
 * In practice this is rarely seen: the shell is precached and all data lives in
 * IndexedDB, so the real app works offline. This exists so a cold navigation to
 * an uncached URL degrades to something honest instead of the browser's error.
 */

import Link from "next/link";

export const metadata = { title: "Offline · Focus Log" };

export default function OfflinePage() {
  return (
    <div className="mx-auto grid min-h-dvh max-w-md place-items-center px-6 text-center">
      <div>
        <span className="relative mx-auto inline-grid h-10 w-10 place-items-center">
          <span className="absolute inset-0 rounded-full border border-ink-600" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink-500" />
        </span>

        <h1 className="mt-6 font-display text-3xl text-cream-50">No connection</h1>
        <p className="mt-3 leading-relaxed text-cream-400">
          This particular page hasn&rsquo;t been cached yet. Your goals, sessions and any running
          timer are stored on this device and are safe.
        </p>

        <Link
          href="/"
          className="mt-6 inline-flex h-11 items-center rounded-lg border border-ink-600 bg-ink-800 px-5 text-sm text-cream-200 transition-colors hover:bg-ink-700"
        >
          Back to Today
        </Link>
      </div>
    </div>
  );
}
