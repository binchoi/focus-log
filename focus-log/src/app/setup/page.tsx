"use client";

/**
 * Onboarding. Validates the spreadsheet *before* saving anything, so a typo or
 * an unshared sheet is caught here rather than silently producing a permanently
 * blank app later.
 */

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SheetsClient, isValidSpreadsheetId } from "@lib/sheets/client";
import {
  CredentialError,
  ServiceAccountTokenProvider,
  parseServiceAccountJson,
  saveCredentials,
  importSigningKey,
  type ServiceAccountJson,
} from "@lib/auth/credentials";
import { validateConnection, type ValidationReport } from "@lib/auth/validate";
import { useApp } from "../providers";

/** Pulls the id out of a pasted spreadsheet URL, or passes an id straight through. */
export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const fromUrl = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(trimmed);
  return fromUrl?.[1] ?? trimmed;
}

export default function SetupPage() {
  const router = useRouter();
  const { refreshCredentials } = useApp();

  const [serviceAccount, setServiceAccount] = useState<ServiceAccountJson | undefined>();
  const [fileName, setFileName] = useState("");
  const [sheetInput, setSheetInput] = useState("");
  const [report, setReport] = useState<ValidationReport | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const spreadsheetId = extractSpreadsheetId(sheetInput);
  const canTest = serviceAccount !== undefined && isValidSpreadsheetId(spreadsheetId);

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
      // Import the key just to build a client for the test; it is not stored
      // until the user presses Save.
      const key = await importSigningKey(serviceAccount.private_key);
      const client = new SheetsClient({
        spreadsheetId,
        tokens: new ServiceAccountTokenProvider({
          clientEmail: serviceAccount.client_email,
          privateKey: key,
        }),
      });
      setReport(await validateConnection(client));
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
      // The PEM has now been imported non-extractable and only the CryptoKey is
      // stored. Drop our in-memory copy of the JSON too.
      setServiceAccount(undefined);
      await refreshCredentials();
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
    <main className="setup-container">
      <h1>Connect focus-log</h1>
      <p className="setup-lead">
        focus-log stores your data in a Google Spreadsheet you own. This runs entirely in your
        browser — there is no server.
      </p>

      <ol className="setup-steps">
        <li>
          <h2>1. Create your spreadsheet</h2>
          <p>
            Follow <code>sheet-template/SETUP.md</code> in the repository: create a spreadsheet with{" "}
            <code>goals</code>, <code>sessions</code> and <code>meta</code> tabs, and import the
            matching CSV into each. Then share it with your service account&rsquo;s email as an
            Editor.
          </p>
        </li>

        <li>
          <h2>2. Service account key</h2>
          <label htmlFor="key-file" className="setup-label">
            Upload your service account JSON
          </label>
          <input
            id="key-file"
            type="file"
            accept="application/json,.json"
            onChange={(event) => void handleFile(event.target.files?.[0])}
            aria-describedby="key-help"
          />
          <p id="key-help" className="setup-help">
            The private key is imported so that it can sign requests but can never be read back out
            of this browser, and the file itself is never stored. You will not have to sign in
            again.
          </p>
          {serviceAccount && (
            <p className="setup-ok" role="status">
              Loaded {fileName} — {serviceAccount.client_email}
            </p>
          )}
        </li>

        <li>
          <h2>3. Spreadsheet</h2>
          <label htmlFor="sheet-id" className="setup-label">
            Spreadsheet URL or ID
          </label>
          <input
            id="sheet-id"
            type="text"
            value={sheetInput}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            onChange={(event) => {
              setSheetInput(event.target.value);
              setReport(undefined);
            }}
            className="input-field"
            aria-describedby="sheet-help"
          />
          <p id="sheet-help" className="setup-help">
            Paste the whole URL — the ID is extracted for you.
            {sheetInput && !isValidSpreadsheetId(spreadsheetId) && (
              <span className="setup-warn"> That doesn&rsquo;t look like a spreadsheet ID yet.</span>
            )}
          </p>
        </li>
      </ol>

      <div className="setup-actions">
        <button type="button" onClick={() => void handleTest()} disabled={!canTest || busy}>
          {busy ? "Checking…" : "Test connection"}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={!report?.ok || busy}
          className="btn save-btn"
        >
          Save and start
        </button>
      </div>

      {error && (
        <p className="setup-error" role="alert">
          {error}
        </p>
      )}

      {report && (
        <section className="setup-report" aria-live="polite">
          <h2>{report.ok ? "Everything checks out" : "Needs attention"}</h2>
          <ul>
            {report.checks.map((check) => (
              <li key={check.label} className={`check check-${check.status}`}>
                <strong>
                  {check.status === "ok" ? "✓" : check.status === "warning" ? "!" : "✗"} {check.label}
                </strong>
                <span>{check.detail}</span>
                {check.fix && <em>{check.fix}</em>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
