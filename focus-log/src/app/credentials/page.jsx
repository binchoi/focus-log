"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CredentialsPage() {
  const [privateKey, setPrivateKey] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const router = useRouter();

  const handleSave = () => {
    if (!privateKey || !clientEmail || !spreadsheetId) {
      alert("Please fill in all fields.");
      return;
    }

    const credentials = { privateKey, clientEmail, spreadsheetId };
    localStorage.setItem("credentials", JSON.stringify(credentials));
    alert("Credentials saved!");
    router.push("/"); // Redirect to Home Page
  };

  return (
    <div className="credentials-container">
      <header>
        <h1 className="credentials-title">Google Sheets Credentials</h1>
        <p className="credentials-description">
          Please enter your Google Sheets credentials to proceed.
        </p>
      </header>
      <form className="credentials-form" onSubmit={(e) => e.preventDefault()}>
        <textarea
          placeholder="Private Key"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          className="input-field textarea-field"
        />
        <input
          type="text"
          placeholder="Client Email"
          value={clientEmail}
          onChange={(e) => setClientEmail(e.target.value)}
          className="input-field"
        />
        <input
          type="text"
          placeholder="Spreadsheet ID"
          value={spreadsheetId}
          onChange={(e) => setSpreadsheetId(e.target.value)}
          className="input-field"
        />
        <button onClick={handleSave} className="btn save-btn">
          Save Credentials
        </button>
      </form>
    </div>
  );
}
