// netlify/functions/set-result.js
//
// Runs on Netlify's server, not in the browser. This is what keeps result
// edits locked down: the front end never holds Firebase write authority —
// it only holds a short-lived session token (from admin-login.js), and
// THIS function is the only thing on earth that can actually write to
// /results in Firebase, using a service account that bypasses the public
// database rules entirely.
//
// The front end (index.html) calls THIS function at
// /.netlify/functions/set-result instead of writing to Firebase directly.
// Firebase's own rules are locked down so /results can ONLY be written by
// this function (using a service account), not by any client in the browser
// — so even someone who finds the DB URL and tries to write to it by hand
// (curl/fetch) is blocked at the database level, not just the UI level.
//
// The admin must first call admin-login.js to exchange their password for a
// short-lived session token, then send that token here on every result
// edit. This function never sees the raw password.
//
// Required Netlify environment variables (set in Site configuration →
// Environment variables, same place FOOTBALL_API_KEY already lives):
//   ADMIN_TOKEN_SECRET        - same value as used in admin-login.js
//   FIREBASE_SERVICE_ACCOUNT  - the full JSON key for a Firebase service
//                               account, pasted in as a single-line string
//   FIREBASE_DB_URL           - https://world-cup-2026-predictio-23e8f-default-rtdb.firebaseio.com

const admin = require("firebase-admin");
const { verifyToken } = require("./admin-login.js");

// Initialise the Admin SDK once per cold start, not on every request.
let appInitError = null;
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL,
    });
  } catch (err) {
    // Stash the error so every request gives a clear message instead of a
    // confusing crash, but don't throw at module load time.
    appInitError = err;
  }
}

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

exports.handler = async function (event) {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Method not allowed, use POST" }),
    };
  }

  if (appInitError) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Firebase Admin SDK failed to initialise. Check FIREBASE_SERVICE_ACCOUNT and FIREBASE_DB_URL env vars.",
        detail: String(appInitError),
      }),
    };
  }

  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_TOKEN_SECRET) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "ADMIN_TOKEN_SECRET is not set in Netlify environment variables." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const { token, matchId, value } = payload;

  if (!verifyToken(token, ADMIN_TOKEN_SECRET)) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: "Session expired or invalid — please log in again" }),
    };
  }

  if (!matchId || typeof matchId !== "string") {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "matchId is required" }),
    };
  }

  // value can be a score string ("2-1"), a team name, or "" to clear a result.
  const cleanValue = typeof value === "string" ? value.trim() : "";

  try {
    await admin.database().ref("results/" + matchId).set(cleanValue);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, matchId, value: cleanValue }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Firebase write failed", detail: String(err) }),
    };
  }
};
