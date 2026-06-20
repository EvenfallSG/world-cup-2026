// netlify/functions/admin-login.js
//
// Verifies the admin password ONCE and returns a signed, time-limited
// session token. The front end stores this token in memory (not
// localStorage) for the rest of the session and sends it to set-result.js
// on every result edit, instead of sending the raw password on every
// keystroke.
//
// The token is a simple HMAC-signed string: "expiry.signature" — no extra
// npm package needed beyond Node's built-in crypto module. It can't be
// forged without ADMIN_TOKEN_SECRET, which only this function and
// set-result.js ever see (both server-side env vars).
//
// Required Netlify environment variables:
//   ADMIN_PASSWORD       - the real admin password, plain string
//   ADMIN_TOKEN_SECRET    - any long random string, used only to sign tokens
//                           (not the password itself — generate this once
//                           and never reuse it as a real password anywhere)

const crypto = require("crypto");

const SESSION_HOURS = 12; // admin stays logged in for 12 hours, then re-enters password

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function signToken(expiry, secret) {
  const sig = crypto.createHmac("sha256", secret).update(String(expiry)).digest("hex");
  return expiry + "." + sig;
}

// Exported so set-result.js can verify tokens the same way.
function verifyToken(token, secret) {
  if (!token || typeof token !== "string" || token.indexOf(".") === -1) return false;
  const [expiryStr, sig] = token.split(".");
  const expiry = parseInt(expiryStr, 10);
  if (!expiry || isNaN(expiry)) return false;
  if (Date.now() > expiry) return false; // expired
  const expectedSig = crypto.createHmac("sha256", secret).update(String(expiry)).digest("hex");
  // Timing-safe comparison
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed, use POST" }) };
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
  const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET;
  if (!ADMIN_PASSWORD || !ADMIN_TOKEN_SECRET) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "ADMIN_PASSWORD or ADMIN_TOKEN_SECRET not set in Netlify environment variables." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (!payload.password || payload.password !== ADMIN_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "Wrong admin password" }) };
  }

  const expiry = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const token = signToken(expiry, ADMIN_TOKEN_SECRET);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, token, expiresAt: expiry }),
  };
};

exports.verifyToken = verifyToken;

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

// netlify/functions/sync-results.js
//
// This is the SERVER-SIDE replacement for the syncLiveScores() function that
// used to run in the browser (index.html). It does the exact same thing —
// fetch openfootball/worldcup.json, match teams to our match IDs, write any
// new results — but it runs on Netlify's schedule, with no code in the
// browser ever touching Firebase write access.
//
// Why this matters: before this function existed, the front end called
// Firebase directly to write results, which meant /results in the database
// had to allow public writes — the exact same hole that let someone forge
// an admin password bypass. Moving the sync here means Firebase rules can
// finally say "no one writes to /results except our trusted server", with
// zero exceptions, because nothing in the browser needs write access to
// /results anymore — not admin edits (set-result.js), and not this sync.
//
// This function is triggered on a schedule (see the `schedule` export at
// the bottom) rather than by an HTTP request, so there is no password or
// token to manage here at all — Netlify's own internal scheduler is the
// only thing that ever invokes it.
//
// Required Netlify environment variables (same ones set-result.js uses):
//   FIREBASE_SERVICE_ACCOUNT  - the full JSON key for a Firebase service account
//   FIREBASE_DB_URL           - https://world-cup-2026-predictio-23e8f-default-rtdb.firebaseio.com

const admin = require("firebase-admin");

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

// ---- Match data, copied verbatim from index.html (GM / R32 / R16 / QF / SF) ----
// IMPORTANT: if the group fixtures or bracket structure in index.html ever
// change, this copy needs the same edit, or the two will drift out of sync.
const GM = [
  {id:"A1",t1:"Mexico",t2:"South Africa",g:"A"},{id:"A2",t1:"South Korea",t2:"Czechia",g:"A"},
  {id:"A3",t1:"Mexico",t2:"Czechia",g:"A"},{id:"A4",t1:"South Korea",t2:"South Africa",g:"A"},
  {id:"A5",t1:"Mexico",t2:"South Korea",g:"A"},{id:"A6",t1:"Czechia",t2:"South Africa",g:"A"},
  {id:"B1",t1:"Canada",t2:"Bosnia-Herzegovina",g:"B"},{id:"B2",t1:"Qatar",t2:"Switzerland",g:"B"},
  {id:"B3",t1:"Canada",t2:"Qatar",g:"B"},{id:"B4",t1:"Switzerland",t2:"Bosnia-Herzegovina",g:"B"},
  {id:"B5",t1:"Canada",t2:"Switzerland",g:"B"},{id:"B6",t1:"Bosnia-Herzegovina",t2:"Qatar",g:"B"},
  {id:"C1",t1:"Brazil",t2:"Morocco",g:"C"},{id:"C2",t1:"Haiti",t2:"Scotland",g:"C"},
  {id:"C3",t1:"Brazil",t2:"Scotland",g:"C"},{id:"C4",t1:"Morocco",t2:"Haiti",g:"C"},
  {id:"C5",t1:"Brazil",t2:"Haiti",g:"C"},{id:"C6",t1:"Morocco",t2:"Scotland",g:"C"},
  {id:"D1",t1:"United States",t2:"Paraguay",g:"D"},{id:"D2",t1:"Australia",t2:"Turkiye",g:"D"},
  {id:"D3",t1:"United States",t2:"Australia",g:"D"},{id:"D4",t1:"Turkiye",t2:"Paraguay",g:"D"},
  {id:"D5",t1:"United States",t2:"Turkiye",g:"D"},{id:"D6",t1:"Paraguay",t2:"Australia",g:"D"},
  {id:"E1",t1:"Germany",t2:"Curacao",g:"E"},{id:"E2",t1:"Ivory Coast",t2:"Ecuador",g:"E"},
  {id:"E3",t1:"Germany",t2:"Ecuador",g:"E"},{id:"E4",t1:"Curacao",t2:"Ivory Coast",g:"E"},
  {id:"E5",t1:"Germany",t2:"Ivory Coast",g:"E"},{id:"E6",t1:"Ecuador",t2:"Curacao",g:"E"},
  {id:"F1",t1:"Netherlands",t2:"Japan",g:"F"},{id:"F2",t1:"Sweden",t2:"Tunisia",g:"F"},
  {id:"F3",t1:"Netherlands",t2:"Tunisia",g:"F"},{id:"F4",t1:"Japan",t2:"Sweden",g:"F"},
  {id:"F5",t1:"Netherlands",t2:"Sweden",g:"F"},{id:"F6",t1:"Tunisia",t2:"Japan",g:"F"},
  {id:"G1",t1:"Belgium",t2:"Egypt",g:"G"},{id:"G2",t1:"Iran",t2:"New Zealand",g:"G"},
  {id:"G3",t1:"Belgium",t2:"New Zealand",g:"G"},{id:"G4",t1:"Egypt",t2:"Iran",g:"G"},
  {id:"G5",t1:"Belgium",t2:"Iran",g:"G"},{id:"G6",t1:"Egypt",t2:"New Zealand",g:"G"},
  {id:"H1",t1:"Spain",t2:"Cape Verde",g:"H"},{id:"H2",t1:"Saudi Arabia",t2:"Uruguay",g:"H"},
  {id:"H3",t1:"Spain",t2:"Saudi Arabia",g:"H"},{id:"H4",t1:"Cape Verde",t2:"Uruguay",g:"H"},
  {id:"H5",t1:"Spain",t2:"Uruguay",g:"H"},{id:"H6",t1:"Cape Verde",t2:"Saudi Arabia",g:"H"},
  {id:"I1",t1:"France",t2:"Senegal",g:"I"},{id:"I2",t1:"Iraq",t2:"Norway",g:"I"},
  {id:"I3",t1:"France",t2:"Norway",g:"I"},{id:"I4",t1:"Senegal",t2:"Iraq",g:"I"},
  {id:"I5",t1:"France",t2:"Iraq",g:"I"},{id:"I6",t1:"Norway",t2:"Senegal",g:"I"},
  {id:"J1",t1:"Argentina",t2:"Algeria",g:"J"},{id:"J2",t1:"Austria",t2:"Jordan",g:"J"},
  {id:"J3",t1:"Argentina",t2:"Jordan",g:"J"},{id:"J4",t1:"Algeria",t2:"Austria",g:"J"},
  {id:"J5",t1:"Argentina",t2:"Austria",g:"J"},{id:"J6",t1:"Algeria",t2:"Jordan",g:"J"},
  {id:"K1",t1:"Colombia",t2:"Uzbekistan",g:"K"},{id:"K2",t1:"Portugal",t2:"Congo DR",g:"K"},
  {id:"K3",t1:"Colombia",t2:"Congo DR",g:"K"},{id:"K4",t1:"Uzbekistan",t2:"Portugal",g:"K"},
  {id:"K5",t1:"Colombia",t2:"Portugal",g:"K"},{id:"K6",t1:"Congo DR",t2:"Uzbekistan",g:"K"},
  {id:"L1",t1:"England",t2:"Croatia",g:"L"},{id:"L2",t1:"Ghana",t2:"Panama",g:"L"},
  {id:"L3",t1:"England",t2:"Panama",g:"L"},{id:"L4",t1:"Croatia",t2:"Ghana",g:"L"},
  {id:"L5",t1:"England",t2:"Ghana",g:"L"},{id:"L6",t1:"Panama",t2:"Croatia",g:"L"}
];

const R32 = [
  {id:"M73",s1:"2A",s2:"2B",d:"Jun 28"},{id:"M74",s1:"1E",s2:"T1",d:"Jun 28"},
  {id:"M75",s1:"1F",s2:"2C",d:"Jun 29"},{id:"M76",s1:"1C",s2:"2F",d:"Jun 29"},
  {id:"M77",s1:"1I",s2:"T2",d:"Jun 29"},{id:"M78",s1:"2E",s2:"2I",d:"Jun 30"},
  {id:"M79",s1:"1A",s2:"T3",d:"Jun 30"},{id:"M80",s1:"1L",s2:"T4",d:"Jun 30"},
  {id:"M81",s1:"1D",s2:"T5",d:"Jul 1"}, {id:"M82",s1:"1G",s2:"T6",d:"Jul 1"},
  {id:"M83",s1:"2K",s2:"2L",d:"Jul 1"}, {id:"M84",s1:"1H",s2:"2J",d:"Jul 2"},
  {id:"M85",s1:"1B",s2:"T7",d:"Jul 2"}, {id:"M86",s1:"1J",s2:"2H",d:"Jul 2"},
  {id:"M87",s1:"1K",s2:"T8",d:"Jul 3"}, {id:"M88",s1:"2D",s2:"2G",d:"Jul 3"}
];
const R16 = [
  {id:"M89",f1:"M74",f2:"M77",d:"Jul 4"},{id:"M90",f1:"M73",f2:"M75",d:"Jul 4"},
  {id:"M91",f1:"M76",f2:"M78",d:"Jul 5"},{id:"M92",f1:"M79",f2:"M80",d:"Jul 5"},
  {id:"M93",f1:"M83",f2:"M84",d:"Jul 6"},{id:"M94",f1:"M81",f2:"M82",d:"Jul 6"},
  {id:"M95",f1:"M86",f2:"M88",d:"Jul 7"},{id:"M96",f1:"M85",f2:"M87",d:"Jul 7"}
];
const QF = [
  {id:"M97",f1:"M89",f2:"M90",d:"Jul 9"}, {id:"M98",f1:"M93",f2:"M94",d:"Jul 10"},
  {id:"M99",f1:"M91",f2:"M92",d:"Jul 10"},{id:"M100",f1:"M95",f2:"M96",d:"Jul 11"}
];
const SF = [
  {id:"M101",f1:"M97",f2:"M98",d:"Jul 14"},{id:"M102",f1:"M99",f2:"M100",d:"Jul 15"}
];

// ---- Team name normalisation (openfootball naming differs slightly from ours) ----
const TN = {
  "Bosnia & Herzegovina": "Bosnia-Herzegovina",
  "Czech Republic":       "Czechia",
  "Curaçao":              "Curacao",
  "DR Congo":             "Congo DR",
  "Turkey":               "Turkiye",
  "USA":                  "United States",
  "South Korea":          "South Korea",
  "Ivory Coast":          "Ivory Coast",
};
const norm = (t) => TN[t] || t;

async function fetchAndApplySync() {
  const res = await fetch(
    "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json"
  );
  if (!res.ok) {
    throw new Error("openfootball fetch failed: " + res.status);
  }
  const data = await res.json();
  const matches = data.matches || [];

  // Read current results so we only write what's changed (same as before).
  const snapshot = await admin.database().ref("results").once("value");
  const results = snapshot.val() || {};

  const gmLookup = {};
  GM.forEach((m) => {
    gmLookup[m.t1 + "|" + m.t2] = m.id;
    gmLookup[m.t2 + "|" + m.t1] = m.id;
  });

  const updates = {};

  matches.forEach((m) => {
    if (!m.score) return;
    const sc = m.score;
    const ft = sc.ft;
    if (!ft) return;

    const t1 = norm(m.team1);
    const t2 = norm(m.team2);

    if (m.group) {
      const id = gmLookup[t1 + "|" + t2] || gmLookup[t2 + "|" + t1];
      if (id) {
        const gm = GM.find((x) => x.id === id);
        if (gm && gm.t1 === t2) {
          updates[id] = ft[1] + "-" + ft[0];
        } else {
          updates[id] = ft[0] + "-" + ft[1];
        }
      }
    } else {
      const round = (m.round || "").toLowerCase();
      let winner = null;
      if (sc.p) {
        winner = sc.p[0] > sc.p[1] ? t1 : t2;
      } else if (ft[0] !== ft[1]) {
        winner = ft[0] > ft[1] ? t1 : t2;
      }
      if (winner && !t1.match(/^[0-9W]/) && !t2.match(/^[0-9W]/)) {
        const roundMap = {
          "round of 32": R32,
          "round of 16": R16,
          "quarter-final": QF,
          "quarter-finals": QF,
          "semi-final": SF,
          "semi-finals": SF,
          "third place": [{ id: "M103" }],
          "third-place": [{ id: "M103" }],
          final: [{ id: "M104" }],
        };
        let bucket = null;
        for (const [k, v] of Object.entries(roundMap)) {
          if (round.includes(k)) {
            bucket = v;
            break;
          }
        }
        if (bucket) {
          const unfilled = bucket.find((bm) => !updates[bm.id] && !results[bm.id]);
          if (unfilled) updates[unfilled.id] = winner;
        }
      }
    }
  });

  const toWrite = {};
  Object.entries(updates).forEach(([k, v]) => {
    if (results[k] !== v) toWrite[k] = v;
  });

  if (Object.keys(toWrite).length > 0) {
    await Promise.all(
      Object.entries(toWrite).map(([k, v]) => admin.database().ref("results/" + k).set(v))
    );
  }

  return { written: toWrite, count: Object.keys(toWrite).length };
}

exports.handler = async function () {
  if (appInitError) {
    console.error("Firebase Admin SDK init failed:", appInitError);
    return { statusCode: 500, body: JSON.stringify({ error: String(appInitError) }) };
  }
  try {
    const result = await fetchAndApplySync();
    console.log("sync-results: wrote", result.count, "updates");
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error("sync-results failed:", err);
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};

// The actual cron schedule for this function is declared in netlify.toml
// (not here) — see the [functions."sync-results"] section in that file.
// This keeps the function itself as a plain, ordinary handler with no
// dependency on the @netlify/functions helper package.
