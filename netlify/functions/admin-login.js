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
