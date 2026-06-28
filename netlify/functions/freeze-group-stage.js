// netlify/functions/freeze-group-stage.js
//
// Runs on Netlify's server, same security model as reset-knockout.js: the
// front end never holds Firebase write authority directly, only a
// short-lived admin session token (from admin-login.js).
//
// PURPOSE: freeze the Group Stage Champions podium (top 3 Full Bracket
// players by group-stage score) as a permanent historical record, separate
// from the live, ongoing knockout-stage leaderboard. The group stage can no
// longer change (every match is locked), so this is just turning an
// always-true live computation into a written-down fact — but writing it
// down means it stays correct even if a future admin action, bug, or stray
// edit ever touched old results.
//
// The actual ranking math (who's 1st/2nd/3rd, their scores) is computed
// CLIENT-SIDE by calcAllScores() — same function the live leaderboard
// already uses — and passed in as the podium array. This function doesn't
// re-derive scores itself; it just persists what the client computed, the
// same way a screenshot doesn't re-render the page, it just saves the
// pixels. That's fine here because group-stage scores are public, already
// visible to everyone in the live leaderboard, and not security-sensitive —
// the only thing worth protecting is *that a write happens at all* (so a
// random visitor can't freeze a fake podium), which the admin token covers.
//
// Two modes, always called with { token, mode, podium }:
//   mode: "preview" - read-only. Returns whether a snapshot already exists
//                     and, if so, what it contains. Doesn't write anything.
//   mode: "commit"  - writes podium to /groupStageFinal, but ONLY if no
//                     snapshot already exists there. Once frozen, this
//                     function refuses to overwrite it — re-running the
//                     reset-knockout-style "preview then commit" flow can
//                     never accidentally re-freeze with different data.
//                     (If a genuine correction is ever needed, that's a
//                     deliberate manual edit in Firebase, not a button.)
//
// Required Netlify environment variables (same ones already in use):
//   ADMIN_TOKEN_SECRET
//   FIREBASE_SERVICE_ACCOUNT
//   FIREBASE_DB_URL

const admin = require("firebase-admin");
const { verifyToken } = require("./admin-login.js");

let appInitError = null;
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DB_URL,
    });
  } catch (err) {
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
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed, use POST" }) };
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: "ADMIN_TOKEN_SECRET is not set in Netlify environment variables." }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { token, mode, podium } = payload;

  if (!verifyToken(token, ADMIN_TOKEN_SECRET)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired or invalid — please log in again" }) };
  }

  if (mode !== "preview" && mode !== "commit") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "mode must be \"preview\" or \"commit\"" }) };
  }

  try {
    const db = admin.database();
    const existingSnap = await db.ref("groupStageFinal").once("value");
    const existing = existingSnap.val();

    if (mode === "preview") {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          mode: "preview",
          alreadyFrozen: !!existing,
          existing: existing || null,
        }),
      };
    }

    // mode === "commit"
    if (existing) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: "Group Stage is already frozen — refusing to overwrite.",
          existing,
        }),
      };
    }

    if (!Array.isArray(podium) || podium.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "podium array is required for commit" }) };
    }

    const record = {
      frozenAt: new Date().toISOString(),
      podium, // [{id, name, total, breakdown}, ...] as computed client-side by calcAllScores
    };
    await db.ref("groupStageFinal").set(record);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, mode: "commit", saved: record }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Freeze operation failed", detail: String(err) }),
    };
  }
};
