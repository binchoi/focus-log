"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function CredentialsPage() {
  const [privateKey, setPrivateKey] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const router = useRouter();

  // Handle JSON file upload
  const handleFileUpload = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = JSON.parse(e.target.result);
        if (json.private_key && json.client_email) {
          setPrivateKey(json.private_key);
          setClientEmail(json.client_email);
        //   alert("Service account credentials loaded successfully!");
        } else {
          alert("Invalid JSON file. Please upload a valid service account file.");
        }
      } catch (err) {
        alert("Error reading JSON file. Ensure it is formatted correctly.");
      }
    };
    reader.readAsText(file);
  };

  // Save credentials to local storage
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
        {/* File Upload Input */}
        <label htmlFor="json-upload" className="file-upload-label">
          Upload Service Account JSON [optional]
        </label>
        <input
          type="file"
          id="json-upload"
          accept=".json"
          onChange={handleFileUpload}
          className="file-upload-input"
        />

        {/* Private Key Field */}
        <input
          type="password" // Hidden field
          placeholder="Private Key"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          className="input-field"
        />

        {/* Client Email Field */}
        <input
          type="password" // Hidden field
          placeholder="Client Email"
          value={clientEmail}
          onChange={(e) => setClientEmail(e.target.value)}
          className="input-field"
        />

        {/* Spreadsheet ID Field */}
        <input
          type="text"
          placeholder="Spreadsheet ID"
          value={spreadsheetId}
          onChange={(e) => setSpreadsheetId(e.target.value)}
          className="input-field"
        />

        {/* Save Button */}
        <button onClick={handleSave} className="btn save-btn">
          Save Credentials
        </button>
      </form>
    </div>
  );
}
