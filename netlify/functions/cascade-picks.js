// netlify/functions/cascade-picks.js
//
// Cascades correct bracket picks forward into the next round after each KO round completes.
// Called by the admin after all results for a given round are in.
//
// Logic per player per next-round match:
//   - Look at the two feeder matches (e.g. M89 feeds from M74 winner + M77 winner)
//   - For each feeder: did this player pick the team that actually won?
//     YES → write that team as their pick for the next-round match (carry forward)
//     NO  → clear their pick for the next-round match (they must re-pick)
//   - Either way the pick remains editable until that match's own kickoff
//
// Modes:
//   "preview"  — read-only, returns counts of what WOULD be carried/cleared
//   "commit"   — writes the cascaded picks to /predictions in Firebase
//
// Body: { token, mode, round }
//   round: "r16" | "qf" | "sf"
//     r16 = cascade R32 results → populate R16 picks
//     qf  = cascade R16 results → populate QF picks
//     sf  = cascade QF results  → populate SF picks

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
    appInitError = err.message;
  }
}

// Official bracket structure — mirrors index.html
const R32 = [
  {id:"M73",s1:"2A",s2:"2B"}, {id:"M74",s1:"1E",s2:"T1"}, {id:"M75",s1:"1F",s2:"2C"},
  {id:"M76",s1:"1C",s2:"2F"}, {id:"M77",s1:"1I",s2:"T2"}, {id:"M78",s1:"2E",s2:"2I"},
  {id:"M79",s1:"1A",s2:"T3"}, {id:"M80",s1:"1L",s2:"T4"}, {id:"M81",s1:"1D",s2:"T5"},
  {id:"M82",s1:"1G",s2:"T6"}, {id:"M83",s1:"2K",s2:"2L"}, {id:"M84",s1:"1H",s2:"2J"},
  {id:"M85",s1:"1B",s2:"T7"}, {id:"M86",s1:"1J",s2:"2H"}, {id:"M87",s1:"1K",s2:"T8"},
  {id:"M88",s1:"2D",s2:"2G"}
];
const R16 = [
  {id:"M89",f1:"M74",f2:"M77"}, {id:"M90",f1:"M73",f2:"M75"},
  {id:"M91",f1:"M76",f2:"M78"}, {id:"M92",f1:"M79",f2:"M80"},
  {id:"M93",f1:"M83",f2:"M84"}, {id:"M94",f1:"M81",f2:"M82"},
  {id:"M95",f1:"M86",f2:"M88"}, {id:"M96",f1:"M85",f2:"M87"}
];
const QF = [
  {id:"M97",f1:"M89",f2:"M90"}, {id:"M98",f1:"M93",f2:"M94"},
  {id:"M99",f1:"M91",f2:"M92"}, {id:"M100",f1:"M95",f2:"M96"}
];
const SF = [
  {id:"M101",f1:"M97",f2:"M98"},
  {id:"M102",f1:"M99",f2:"M100"}
];

// Which set of matches to cascade INTO, given a round
const ROUND_CONFIG = {
  r16: { sourceMatches: R32, targetMatches: R16,  label: "R32 → R16" },
  qf:  { sourceMatches: R16, targetMatches: QF,   label: "R16 → QF"  },
  sf:  { sourceMatches: QF,  targetMatches: SF,   label: "QF → SF"   },
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  if (appInitError) {
    return { statusCode: 500, body: JSON.stringify({ error: "Firebase init failed: " + appInitError }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) }; }

  const { token, mode, round } = body;

  // Auth check
  let tokenOk = false;
  try { tokenOk = verifyToken(token); } catch {}
  if (!tokenOk) {
    return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
  }

  if (!["preview", "commit"].includes(mode)) {
    return { statusCode: 400, body: JSON.stringify({ error: "mode must be preview or commit" }) };
  }
  if (!ROUND_CONFIG[round]) {
    return { statusCode: 400, body: JSON.stringify({ error: "round must be r16, qf, or sf" }) };
  }

  const db = admin.database();
  const { sourceMatches, targetMatches, label } = ROUND_CONFIG[round];

  try {
    // 1. Read actual results
    const resultsSnap = await db.ref("/results").get();
    const results = resultsSnap.val() || {};

    // 2. Check all source matches have results — warn if incomplete
    const missingResults = sourceMatches.filter(m => !results[m.id]);

    // 3. Read all predictions
    const predsSnap = await db.ref("/predictions").get();
    const preds = predsSnap.val() || {};

    // 4. Read all players
    const playersSnap = await db.ref("/players").get();
    const players = Object.values(playersSnap.val() || {});

    // 5. Build cascade plan
    // For each target match, we know which two source matches feed it (f1, f2).
    // The actual winner of f1 and f2 are in results[f1] / results[f2].
    // A KO result is stored as "Winner|score[|pens]" — extract just the team name.
    const koWinner = (resultVal) => {
      if (!resultVal) return null;
      // Format: "TeamName|2-1" or "TeamName|1-1|4-3pens"
      return resultVal.split("|")[0].trim() || null;
    };

    const writes = {};   // key -> value to write (or null to clear)
    let carriedCount = 0;
    let clearedCount = 0;
    let skippedCount = 0; // source result not in yet

    players.forEach(player => {
      const pid = player.id;
      targetMatches.forEach(target => {
        // What did the actual results say for the two feeder matches?
        const actualWinnerF1 = koWinner(results[target.f1]);
        const actualWinnerF2 = koWinner(results[target.f2]);

        if (!actualWinnerF1 || !actualWinnerF2) {
          // Source result not in yet — skip this target match for this player
          skippedCount++;
          return;
        }

        // What did this player pick for the two feeder matches?
        const playerPickF1 = preds[pid + "-" + target.f1] || null;
        const playerPickF2 = preds[pid + "-" + target.f2] || null;

        // Determine which team (if any) this player correctly called through
        // into this target match slot
        let carryTeam = null;
        if (playerPickF1 === actualWinnerF1) carryTeam = actualWinnerF1;
        else if (playerPickF2 === actualWinnerF2) carryTeam = actualWinnerF2;
        // If player correctly picked BOTH feeders (both teams are now in this match),
        // their existing target pick (if any) is kept if it matches one of the two — otherwise
        // we carry the f1 winner as a default (they can re-pick freely anyway).
        // Actually: if both picks were correct, their existing target pick may already be valid.
        // Check existing target pick first.
        const existingTargetPick = preds[pid + "-" + target.id] || null;
        const bothCorrect = playerPickF1 === actualWinnerF1 && playerPickF2 === actualWinnerF2;
        if (bothCorrect) {
          if (existingTargetPick === actualWinnerF1 || existingTargetPick === actualWinnerF2) {
            // Their existing pick is valid — leave it untouched
            skippedCount++; // not a "carry" or "clear", just leave it
            return;
          }
          // They picked both correctly but their downstream pick is stale/missing — carry f1 winner as default
          carryTeam = actualWinnerF1;
        }

        if (carryTeam) {
          // Only write if different from what's already there
          if (preds[pid + "-" + target.id] !== carryTeam) {
            writes[pid + "-" + target.id] = carryTeam;
            carriedCount++;
          } else {
            skippedCount++; // already correct, no write needed
          }
        } else {
          // Player's pick was wrong (their team was eliminated) — clear target pick
          if (preds[pid + "-" + target.id]) {
            writes[pid + "-" + target.id] = null; // null = delete
            clearedCount++;
          } else {
            skippedCount++; // already empty, no write needed
          }
        }
      });
    });

    if (mode === "preview") {
      return {
        statusCode: 200,
        body: JSON.stringify({
          label,
          round,
          playersCount: players.length,
          missingResults: missingResults.map(m => m.id),
          carriedCount,
          clearedCount,
          skippedCount,
          totalWrites: Object.keys(writes).length,
        }),
      };
    }

    // commit: write all cascaded picks to Firebase
    // Deletes (null values) need to be handled via remove(), sets via set()
    const writeOps = Object.entries(writes).map(([key, val]) => {
      const ref = db.ref("/predictions/" + encodeURIComponent(key).replace(/%2D/g, "-"));
      return val === null ? ref.remove() : ref.set(val);
    });
    await Promise.all(writeOps);

    // Backup snapshot of what we changed
    const timestamp = Date.now();
    await db.ref("/cascadeBackup/" + timestamp).set({
      round,
      label,
      timestamp: new Date(timestamp).toISOString(),
      writes,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        label,
        round,
        carriedCount,
        clearedCount,
        skippedCount,
        totalWritten: Object.keys(writes).length,
        backupKey: timestamp,
      }),
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
