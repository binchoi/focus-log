import axios from "axios";

// Function to fetch summary data and update local storage with g_id -> title mapping
export async function fetchSummary(credentials) {
  const accessToken = await getAccessToken(credentials);

  try {
    // Fetch data from the 'goals' sheet
    const goalsResponse = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${credentials.spreadsheetId}/values/goals!A:B`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    // Fetch data from the 'summary' sheet
    const summaryResponse = await axios.get(
      `https://sheets.googleapis.com/v4/spreadsheets/${credentials.spreadsheetId}/values/summary!A:B`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    // Extract data from responses
    const goalsData = goalsResponse.data.values || [];
    const summaryData = summaryResponse.data.values || [];

    // Create a mapping of g_id -> title from the 'goals' sheet
    const goalsMap = {};
    goalsData.slice(1).forEach(([g_id, title]) => {
      if (g_id && title) {
        goalsMap[g_id] = title;
      }
    });

    // Save the mapping to local storage
    localStorage.setItem("goalsMap", JSON.stringify(goalsMap));

    // Process summary data to include titles
    const filteredGoals = summaryData
      .slice(1) // Exclude header row
      .filter(row => row[0] && row[1]) // Filter out rows with empty g_id or total_duration
      .map(([g_id, total_duration]) => ({
        g_id,
        title: goalsMap[g_id] || "Unknown Goal", // Use cached title or fallback
        total_duration,
      }));

    return filteredGoals;
  } catch (error) {
    console.error("Error fetching summary:", error.response?.data || error.message);
    throw new Error("Failed to fetch summary from Google Sheets");
  }
}

// Function to get a title by g_id from local storage
export function getTitleByGid(g_id) {
    const goalsMap = JSON.parse(localStorage.getItem("goalsMap")) || {};
    return goalsMap[g_id] || "Unknown Goal";
  }


// Helper function to format datetime to "MM/DD/YYYY HH:mm:ss"
function formatDateTime(datetime) {
    const date = new Date(datetime); // Ensure it's a Date object
    const options = {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false, // Use 24-hour format
    };

    // Format the date using Intl.DateTimeFormat
    const formattedDate = new Intl.DateTimeFormat("en-US", options).format(date);

    // Fix formatting for Google Sheets (MM/DD/YYYY HH:mm:ss)
    const [month, day, year] = formattedDate.split(",")[0].split("/");
    const time = formattedDate.split(",")[1].trim();
    return `${month}/${day}/${year} ${time}`;
}

// Function to append log data to Google Sheets
export async function appendLog(g_id, start, end) {
    const credentials = JSON.parse(localStorage.getItem("credentials"));
    const accessToken = await getAccessToken(credentials);
  
    // Format the start and end times
    const formattedStart = formatDateTime(start);
    const formattedEnd = formatDateTime(end);

    console.log(formattedStart);
  
    try {
      await axios.post(
        `https://sheets.googleapis.com/v4/spreadsheets/${credentials.spreadsheetId}/values/logs!A:C:append?valueInputOption=RAW`,
        {
          range: "logs!A:C", // Specify the range for appending
          majorDimension: "ROWS", // Data is appended row-wise
          values: [[formattedStart, formattedEnd, g_id]], // Append formatted data
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log("Log appended successfully");
    } catch (error) {
      console.error("Error appending log:", error.response?.data || error.message);
      throw new Error("Failed to append log to Google Sheets");
    }
  }
      

// Function to generate an OAuth 2.0 access token using the service account JSON
async function getAccessToken({ privateKey, clientEmail }) {
  const now = Math.floor(Date.now() / 1000); // Current time in seconds
  const payload = {
    iss: clientEmail, // Issuer: Service account email
    scope: "https://www.googleapis.com/auth/spreadsheets", // Scope for Google Sheets API
    aud: "https://oauth2.googleapis.com/token", // Audience
    exp: now + 3600, // Expiration time (1 hour from now)
    iat: now, // Issued at time
  };

  // Create a JWT token manually
  const header = { alg: "RS256", typ: "JWT" };
  const base64Encode = (obj) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const unsignedToken =
    base64Encode(header) + "." + base64Encode(payload);

  // Sign the token using the private key
  const signature = await signWithPrivateKey(unsignedToken, privateKey);
  const jwt = unsignedToken + "." + signature;

  // Exchange the JWT for an access token
  try {
    const response = await axios.post(
      "https://oauth2.googleapis.com/token",
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    return response.data.access_token; // Return the access token
  } catch (error) {
    console.error("Error fetching access token:", error.response?.data || error.message);
    throw new Error("Failed to fetch access token");
  }
}

// Helper function to sign data with a private key
async function signWithPrivateKey(data, privateKey) {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    str2ab(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(data)
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Helper function to convert PEM private key string to ArrayBuffer
function str2ab(pem) {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem.replace(/\\n/g, "\n").replace(pemHeader, "").replace(pemFooter, "").replace(/\s/g, "");
  const binaryDerString = atob(pemContents);
  const binaryDer = new Uint8Array(binaryDerString.length).map((_, i) =>
    binaryDerString.charCodeAt(i)
  );
  return binaryDer.buffer;
}
