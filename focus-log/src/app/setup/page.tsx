"use client";

/**
 * Onboarding.
 *
 * Validates the spreadsheet *before* saving anything, so a typo or an unshared
 * sheet is caught here rather than silently producing a permanently blank app
 * later — which is exactly what the old flow did.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, FileKey, Loader2, TriangleAlert, X } from "lucide-react";
import { SheetsClient, extractSpreadsheetId, isValidSpreadsheetId } from "@lib/sheets/client";
import {
  CredentialError,
  ServiceAccountTokenProvider,
  importSigningKey,
  parseServiceAccountJson,
  saveCredentials,
  type ServiceAccountJson,
} from "@lib/auth/credentials";
import { validateConnection, type ValidationReport } from "@lib/auth/validate";
import { Alert, Button, Field, Input, Panel, cn } from "@/components/ui";

export default function SetupPage() {
  const router = useRouter();

  const [serviceAccount, setServiceAccount] = useState<ServiceAccountJson | undefined>();
  const [fileName, setFileName] = useState("");
  const [sheetInput, setSheetInput] = useState("");
  const [report, setReport] = useState<ValidationReport | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const spreadsheetId = extractSpreadsheetId(sheetInput);
  const idLooksValid = isValidSpreadsheetId(spreadsheetId);
  const canTest = serviceAccount !== undefined && idLooksValid;

  async function handleFile(file: File | undefined) {
    setError(undefined);
    setReport(undefined);
    if (!file) return;
    try {
      const parsed = parseServiceAccountJson(await file.text());
      setServiceAccount(parsed);
      setFileName(file.name);
    } catch (cause) {
      setServiceAccount(undefined);
      setFileName("");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleTest() {
    if (!serviceAccount) return;
    setBusy(true);
    setError(undefined);
    setReport(undefined);
    try {
      // Imported only to build a client for the test; nothing is stored until
      // the user presses Save.
      const key = await importSigningKey(serviceAccount.private_key);
      setReport(
        await validateConnection(
          new SheetsClient({
            spreadsheetId,
            tokens: new ServiceAccountTokenProvider({
              clientEmail: serviceAccount.client_email,
              privateKey: key,
            }),
          }),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    if (!serviceAccount) return;
    setBusy(true);
    setError(undefined);
    try {
      await saveCredentials({ serviceAccount, spreadsheetId });
      // The key is now imported non-extractable and only the CryptoKey is
      // persisted. Drop our in-memory copy of the JSON too.
      setServiceAccount(undefined);
      router.push("/");
    } catch (cause) {
      setError(
        cause instanceof CredentialError
          ? cause.message
          : `Could not save credentials: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-[680px] flex-col justify-center px-5 py-12 md:px-8">
      <header className="rise" style={{ "--i": 0 } as React.CSSProperties}>
        <span className="relative inline-grid h-10 w-10 place-items-center">
          <span className="absolute inset-0 rounded-full border border-ember-500/40" />
          <span className="h-2.5 w-2.5 rounded-full bg-ember-500 shadow-[0_0_14px_3px_var(--color-ember-500)]" />
        </span>
        <h1 className="mt-5 font-display text-[2.75rem] leading-tight text-cream-50">
          Connect your ledger
        </h1>
        <p className="mt-3 max-w-prose leading-relaxed text-cream-400">
          focus-log keeps your data in a Google Spreadsheet that you own. Everything runs in this
          browser — there is no server, and nothing is sent anywhere else.
        </p>
      </header>

      <div className="rise mt-9 space-y-4" style={{ "--i": 1 } as React.CSSProperties}>
        {/* --- step 1 --- */}
        <Panel className="p-5">
          <Step n={1} title="Prepare the spreadsheet" />
          <p className="mt-2 text-sm leading-relaxed text-cream-400">
            Follow <code className="rounded bg-ink-800 px-1.5 py-0.5 text-xs">sheet-template/SETUP.md</code>{" "}
            — create a spreadsheet with <code className="text-cream-200">goals</code>,{" "}
            <code className="text-cream-200">sessions</code> and{" "}
            <code className="text-cream-200">meta</code> tabs and import the matching CSV into each.
            Then share it with your service account as an Editor.
          </p>
        </Panel>

        {/* --- step 2 --- */}
        <Panel className="p-5">
          <Step n={2} title="Service account key" />
          <label
            htmlFor="key-file"
            className={cn(
              "mt-3 flex cursor-pointer items-center gap-3 rounded-lg border border-dashed px-4 py-4 transition-colors",
              serviceAccount
                ? "border-success/40 bg-success/5"
                : "border-ink-600 hover:border-ink-500 hover:bg-ink-850",
            )}
          >
            {serviceAccount ? (
              <Check size={18} className="shrink-0 text-success" />
            ) : (
              <FileKey size={18} className="shrink-0 text-cream-600" />
            )}
            <span className="min-w-0">
              <span className="block text-sm text-cream-50">
                {serviceAccount ? fileName : "Choose your service account JSON"}
              </span>
              <span className="block truncate text-xs text-cream-600">
                {serviceAccount?.client_email ?? "The .json file Google generated for you"}
              </span>
            </span>
          </label>
          <input
            id="key-file"
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={(event) => void handleFile(event.target.files?.[0])}
            aria-describedby="key-help"
          />
          <p id="key-help" className="mt-2.5 text-xs leading-relaxed text-cream-600">
            The private key is imported so that it can sign requests but can never be read back out
            of this browser, and the file itself is never stored. You will not be asked to sign in
            again.
          </p>
        </Panel>

        {/* --- step 3 --- */}
        <Panel className="p-5">
          <Step n={3} title="Point at the spreadsheet" />
          <Field
            label="Spreadsheet URL or ID"
            htmlFor="sheet-id"
            className="mt-3"
            hint={
              sheetInput && !idLooksValid ? (
                <span className="text-warn">That doesn&rsquo;t look like a spreadsheet ID yet.</span>
              ) : (
                "Paste the whole URL — the ID is extracted for you."
              )
            }
          >
            <Input
              id="sheet-id"
              value={sheetInput}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              onChange={(event) => {
                setSheetInput(event.target.value);
                setReport(undefined);
              }}
            />
          </Field>
        </Panel>
      </div>

      <div className="rise mt-6 flex flex-wrap gap-2" style={{ "--i": 2 } as React.CSSProperties}>
        <Button variant="outline" size="lg" onClick={() => void handleTest()} disabled={!canTest || busy}>
          {busy && !report ? <Loader2 size={15} className="animate-spin" /> : null}
          {busy && !report ? "Checking…" : "Test connection"}
        </Button>
        <Button
          variant="primary"
          size="lg"
          onClick={() => void handleSave()}
          disabled={!report?.ok || busy}
        >
          Save and start
        </Button>
      </div>

      {error && (
        <Alert tone="danger" className="mt-5">
          {error}
        </Alert>
      )}

      {report && (
        <section className="rise mt-6" aria-live="polite">
          <h2 className="font-display text-xl text-cream-50">
            {report.ok ? "Everything checks out" : "Needs attention"}
          </h2>
          <ul className="mt-3 space-y-1.5">
            {report.checks.map((check) => (
              <li
                key={check.label}
                className={cn(
                  "flex gap-3 rounded-lg border px-3.5 py-2.5 text-sm",
                  check.status === "ok" && "border-ink-700 bg-ink-900/60",
                  check.status === "warning" && "border-warn/30 bg-warn/5",
                  check.status === "error" && "border-danger/35 bg-danger/5",
                )}
              >
                <span className="mt-0.5 shrink-0">
                  {check.status === "ok" ? (
                    <Check size={15} className="text-success" />
                  ) : check.status === "warning" ? (
                    <TriangleAlert size={15} className="text-warn" />
                  ) : (
                    <X size={15} className="text-danger" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-cream-50">{check.label}</span>
                  <span className="block text-cream-400">{check.detail}</span>
                  {check.fix && <span className="mt-1 block text-xs text-ember-300">{check.fix}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Step({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="num grid h-6 w-6 shrink-0 place-items-center rounded-full border border-ink-600 text-xs text-cream-400">
        {n}
      </span>
      <h2 className="font-display text-lg text-cream-50">{title}</h2>
    </div>
  );
}
