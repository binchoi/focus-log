"use client";

/**
 * Install section for Settings.
 *
 * Exists because the automatic prompt is easy to miss and, once dismissed, never
 * returns — so there was no way to install afterwards. This is the durable route.
 *
 * It never renders a button it cannot honour: on iOS, macOS Safari and Firefox no
 * install event is ever fired, so those get the real manual steps (or an honest
 * "this browser can't") rather than a control that does nothing.
 */

import { useState, useSyncExternalStore } from "react";
import { Check, Download, MonitorDown, Share, TriangleAlert } from "lucide-react";
import {
  getInstallState,
  getServerInstallState,
  installGuidance,
  promptInstall,
  subscribeToInstallState,
} from "@lib/pwa/install";
import { Alert, Button, Panel } from "@/components/ui";

export function InstallSection() {
  const state = useSyncExternalStore(
    subscribeToInstallState,
    getInstallState,
    getServerInstallState,
  );

  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);

  const guidance = installGuidance(state, state.platform);
  const installed = state.standalone || state.justInstalled;

  return (
    <section className="rise mt-12" style={{ "--i": 4 } as React.CSSProperties}>
      <h2 className="font-display text-2xl text-cream-50">Install</h2>
      <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-cream-400">
        Run Focus Log in its own window, off your home screen or dock. It works
        without a connection either way — installing just removes the browser
        chrome and makes it quicker to start a session.
      </p>

      <Panel className="mt-4 p-5">
        {installed ? (
          <div className="flex items-start gap-3">
            <Check size={18} className="mt-0.5 shrink-0 text-success" />
            <div>
              <p className="text-sm text-cream-50">
                {state.standalone ? "Running as an installed app." : "Installed."}
              </p>
              {guidance.steps.length > 0 && (
                <p className="mt-1 text-sm text-cream-400">{guidance.steps[0]}</p>
              )}
            </div>
          </div>
        ) : guidance.unsupported ? (
          <Alert tone="warn">
            <span className="flex items-start gap-2.5">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" />
              <span>{guidance.unsupported}</span>
            </span>
          </Alert>
        ) : guidance.showButton ? (
          <Button
            variant="primary"
            onClick={() => {
              void (async () => {
                setBusy(true);
                const outcome = await promptInstall();
                setBusy(false);
                if (outcome === "dismissed") setDeclined(true);
              })();
            }}
            disabled={busy}
          >
            <MonitorDown size={15} />
            {busy ? "Waiting for the browser…" : "Install Focus Log"}
          </Button>
        ) : (
          <div>
            <p className="flex items-center gap-2 text-sm text-cream-50">
              {state.platform === "ios" ? (
                <Share size={15} className="shrink-0 text-cream-400" />
              ) : (
                <Download size={15} className="shrink-0 text-cream-400" />
              )}
              {guidance.heading}
            </p>
            <ol className="mt-3 space-y-2">
              {guidance.steps.map((step, index) => (
                <li key={step} className="flex gap-3 text-sm text-cream-400">
                  <span className="num shrink-0 text-cream-600">{index + 1}.</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/*
          Outside the branches above on purpose. A prompt event cannot be reused,
          so answering it flips canPrompt to false and the component re-renders
          into the guidance branch — which would take this message with it and the
          user would get no acknowledgement at all.
        */}
        {declined && !installed && (
          <p className="mt-3 text-sm text-cream-600">
            Not installed. You can come back to this any time.
          </p>
        )}
      </Panel>
    </section>
  );
}
