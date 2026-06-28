// netlify/functions/reset-knockout.js
//
// Runs on Netlify's server, same security model as set-result.js: the front
// end never holds Firebase write authority directly, only a short-lived
// admin session token (from admin-login.js). This function is the only
// thing that can wipe bracket predictions, and only after verifying that
// token server-side.
//
// PURPOSE: the June 28 knockout reset. The group stage is over and its
// final standings are frozen for the historical record. The knockout
// bracket (M73-M104) now uses the REAL qualified teams (computed from
// actual results, not any player's guesses) instead of each player's own
// private, possibly-wrong predicted bracket. That means every existing
// M73-M104 prediction in the database was made against a bracket that no
// longer exists — it has to be cleared so players start the knockout
// bracket fresh, against the real teams.
//
// Two modes, always called with { token, mode }:
//   mode: "preview"  - read-only. Returns counts of what WOULD be backed up
//                       and wiped, without writing or deleting anything.
//                       Safe to call repeatedly, e.g. to show an admin a
//                       confirmation screen before they commit.
//   mode: "commit"   - 1) snapshots every M73-M104 prediction key to
//                       /predictionsBackup/{timestamp}/predictions so the
//                       pre-reset state is fully recoverable, then
//                       2) deletes those same keys from /predictions.
//                       Quick Picks keys (QP_WIN, QP_RUN, QP_3RD, QP_4TH,
//                       GOLDEN_BOOT, MVP) and all group-stage keys (A1-L6,
//                       MODE) are NEVER touched by this function — only
//                       M73 through M104 are in scope, matching exactly
//                       what the new real-slot bracket replaces.
//
// Required Netlify environment variables (same ones set-result.js already
// uses — no new configuration needed):
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

// Matches M73 through M104 specifically (the full knockout match-id range),
// at the end of a "<playerId>-M<number>" key. Deliberately narrow — this
// must never match QP_*, GOLDEN_BOOT, MVP, MODE, or any group-stage id.
const KO_KEY_RE = /-(M(7[3-9]|8[0-9]|9[0-9]|10[0-4]))$/;

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

  const { token, mode } = payload;

  if (!verifyToken(token, ADMIN_TOKEN_SECRET)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Session expired or invalid — please log in again" }) };
  }

  if (mode !== "preview" && mode !== "commit") {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "mode must be \"preview\" or \"commit\"" }) };
  }

  try {
    const db = admin.database();
    const predsSnap = await db.ref("predictions").once("value");
    const allPreds = predsSnap.val() || {};

    const koKeys = Object.keys(allPreds).filter((k) => KO_KEY_RE.test(k));
    const koEntries = {};
    koKeys.forEach((k) => { koEntries[k] = allPreds[k]; });

    if (mode === "preview") {
      // Read-only — report what a commit would do, touch nothing.
      const alreadyHasBackup = await db.ref("predictionsBackup").once("value");
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          mode: "preview",
          totalPredictionKeys: Object.keys(allPreds).length,
          knockoutKeysFound: koKeys.length,
          sampleKeys: koKeys.slice(0, 10),
          existingBackupSnapshots: alreadyHasBackup.exists() ? Object.keys(alreadyHasBackup.val()).length : 0,
        }),
      };
    }

    // mode === "commit": snapshot first, then delete. If the snapshot
    // write fails, we throw before touching /predictions at all, so a
    // failed backup can never be followed by a wipe.
    const timestamp = Date.now().toString();
    await db.ref("predictionsBackup/" + timestamp).set({
      reason: "knockout-reset-2026-06-28",
      takenAt: new Date().toISOString(),
      keyCount: koKeys.length,
      predictions: koEntries,
    });

    // Delete each knockout key individually rather than rewriting the whole
    // /predictions node, so any group-stage or Quick Picks keys written by
    // a player between the backup read and now are never clobbered.
    const deleteUpdates = {};
    koKeys.forEach((k) => { deleteUpdates[k] = null; });
    await db.ref("predictions").update(deleteUpdates);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        mode: "commit",
        backupSnapshot: timestamp,
        knockoutKeysWiped: koKeys.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Reset operation failed", detail: String(err) }),
    };
  }
};
