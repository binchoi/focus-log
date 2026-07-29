"use client";

/**
 * PWA glue: persistent storage, the offline banner, and the install prompt.
 *
 * Requesting persistent storage matters more here than in most apps: the outbox
 * of unsynced sessions lives in IndexedDB, and without the persistence grant the
 * browser may evict it under storage pressure — silently discarding work that
 * has not reached the spreadsheet yet.
 */

import { useEffect, useState } from "react";
import { Download, WifiOff, X } from "lucide-react";
import { Button, cn } from "@/components/ui";
import { useApp } from "./providers";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "focus-log.install_dismissed";

export function PwaBits() {
  return (
    <>
      <PersistStorage />
      <OfflineBanner />
      <InstallPrompt />
    </>
  );
}

/** Asks the browser not to evict our IndexedDB. Fire-and-forget. */
function PersistStorage() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return;
    void (async () => {
      try {
        if (await navigator.storage.persisted()) return;
        await navigator.storage.persist();
      } catch {
        // Not supported, or the user declined. The app still works; the queue is
        // just theoretically evictable under storage pressure.
      }
    })();
  }, []);

  return null;
}

/**
 * Offline banner.
 *
 * Deliberately reassuring rather than alarming: offline is a supported state, and
 * the honest message is "your work is safe", not "something is wrong".
 */
function OfflineBanner() {
  const { status } = useApp();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-700 bg-ink-850/95 backdrop-blur-xl"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-2.5 text-sm">
        <WifiOff size={15} className="shrink-0 text-cream-400" />
        <span className="text-cream-200">
          Offline — everything is saved on this device
          {status.pending > 0 && (
            <>
              {". "}
              <span className="num">{status.pending}</span> change
              {status.pending === 1 ? "" : "s"} will upload when you reconnect
            </>
          )}
          .
        </span>
      </div>
    </div>
  );
}

/**
 * Install prompt. Only shown once the browser has actually fired
 * beforeinstallprompt, so it never appears where installing is impossible.
 */
function InstallPrompt() {
  const [event, setEvent] = useState<InstallPromptEvent | undefined>();
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY) === "1") return undefined;

    const onPrompt = (native: Event) => {
      native.preventDefault(); // keep the browser's own mini-infobar away
      setEvent(native as InstallPromptEvent);
      setHidden(false);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  function dismiss() {
    setHidden(true);
    localStorage.setItem(DISMISSED_KEY, "1");
  }

  if (!event || hidden) return null;

  return (
    <div
      className={cn(
        "panel fixed bottom-4 right-4 z-40 w-[min(22rem,calc(100vw-2rem))] p-4",
        "animate-[rise_0.35s_var(--ease-instrument)]",
      )}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss install prompt"
        className="absolute right-3 top-3 rounded p-1 text-cream-600 transition-colors hover:bg-ink-800 hover:text-cream-50"
      >
        <X size={14} />
      </button>

      <h2 className="pr-6 font-display text-lg text-cream-50">Install Focus Log</h2>
      <p className="mt-1.5 text-sm leading-relaxed text-cream-400">
        Run it in its own window and start a session without opening a browser tab. Works offline.
      </p>

      <div className="mt-4 flex gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void (async () => {
              await event.prompt();
              await event.userChoice;
              dismiss();
            })();
          }}
        >
          <Download size={14} />
          Install
        </Button>
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}
