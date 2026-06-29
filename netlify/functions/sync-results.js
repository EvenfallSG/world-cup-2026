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
//
// ---- BUGFIX (this version) ----
// The previous version matched knockout winners to match IDs by "find the
// first match in this round that doesn't have a result yet" — completely
// independent of which two teams the winner actually played. Since this
// function runs every 30 minutes, a single real result (e.g. Canada's R32
// win) got reassigned to a NEW "first unfilled" match ID on every single
// run, eventually stamping the same winner across M73, M74, M75, M76, M77,
// M78, M79 in sequence — none of which Canada played in (except M73). This
// version instead resolves each round's REAL team-name pairs first (R32 via
// the same getRealSlots()-equivalent logic index.html uses; R16+ via the
// previous round's now-known results), then matches the feed's winner to a
// match ID only when the winner's name is actually one of that match's two
// real teams. No identity match -> no write, full stop.

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

// ---- Match data, copied verbatim from index.html (GT / GM / R32 / R16 / QF / SF /
// THIRD_SLOTS / TSLOT_PARTNER_GROUP / THIRD_COMBINATIONS) ----
// IMPORTANT: if any of this ever changes in index.html, this copy needs the same
// edit, or the two will drift out of sync. (Same caveat as before — unchanged by
// this bugfix — but at least now a drift produces a wrong-or-missing result
// instead of a wrong result silently cascading across multiple matches.)
const GT = {
  A:["Mexico","South Africa","South Korea","Czechia"],
  B:["Canada","Bosnia-Herzegovina","Qatar","Switzerland"],
  C:["Brazil","Morocco","Haiti","Scotland"],
  D:["United States","Paraguay","Australia","Turkiye"],
  E:["Germany","Curacao","Ivory Coast","Ecuador"],
  F:["Netherlands","Japan","Sweden","Tunisia"],
  G:["Belgium","Egypt","Iran","New Zealand"],
  H:["Spain","Cape Verde","Saudi Arabia","Uruguay"],
  I:["France","Senegal","Iraq","Norway"],
  J:["Argentina","Algeria","Austria","Jordan"],
  K:["Colombia","Uzbekistan","Portugal","Congo DR"],
  L:["England","Croatia","Ghana","Panama"]
};

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
  {id:"M73",s1:"2A",s2:"2B"},{id:"M74",s1:"1E",s2:"T1"},
  {id:"M75",s1:"1F",s2:"2C"},{id:"M76",s1:"1C",s2:"2F"},
  {id:"M77",s1:"1I",s2:"T2"},{id:"M78",s1:"2E",s2:"2I"},
  {id:"M79",s1:"1A",s2:"T3"},{id:"M80",s1:"1L",s2:"T4"},
  {id:"M81",s1:"1D",s2:"T5"},{id:"M82",s1:"1G",s2:"T6"},
  {id:"M83",s1:"2K",s2:"2L"},{id:"M84",s1:"1H",s2:"2J"},
  {id:"M85",s1:"1B",s2:"T7"},{id:"M86",s1:"1J",s2:"2H"},
  {id:"M87",s1:"1K",s2:"T8"},{id:"M88",s1:"2D",s2:"2G"}
];
const R16 = [
  {id:"M89",f1:"M74",f2:"M77"},{id:"M90",f1:"M73",f2:"M75"},
  {id:"M91",f1:"M76",f2:"M78"},{id:"M92",f1:"M79",f2:"M80"},
  {id:"M93",f1:"M83",f2:"M84"},{id:"M94",f1:"M81",f2:"M82"},
  {id:"M95",f1:"M86",f2:"M88"},{id:"M96",f1:"M85",f2:"M87"}
];
const QF = [
  {id:"M97",f1:"M89",f2:"M90"},{id:"M98",f1:"M93",f2:"M94"},
  {id:"M99",f1:"M91",f2:"M92"},{id:"M100",f1:"M95",f2:"M96"}
];
const SF = [
  {id:"M101",f1:"M97",f2:"M98"},{id:"M102",f1:"M99",f2:"M100"}
];

const THIRD_SLOTS = [
  {slot:"T1", allowed:"ABCDF"}, {slot:"T2", allowed:"CDFGH"},
  {slot:"T3", allowed:"CEFHI"}, {slot:"T4", allowed:"EHIJK"},
  {slot:"T5", allowed:"BEFIJ"}, {slot:"T6", allowed:"AEHIJ"},
  {slot:"T7", allowed:"EFGIJ"}, {slot:"T8", allowed:"DEIJL"}
];
const TSLOT_PARTNER_GROUP = {T1:"E", T2:"I", T3:"A", T4:"L", T5:"D", T6:"G", T7:"B", T8:"K"};
const THIRD_COMBINATIONS = {
  "BDEFIJKL": {A:"E", B:"J", D:"B", E:"D", G:"I", I:"F", K:"L", L:"K"}
};

function assignThirds(thirds) {
  const qualifyingGroups = thirds.map(t => t.group).slice().sort().join("");
  const combo = THIRD_COMBINATIONS[qualifyingGroups];
  if (combo) {
    const result = {};
    Object.keys(TSLOT_PARTNER_GROUP).forEach(tslot => {
      const oneGroup = TSLOT_PARTNER_GROUP[tslot];
      const thirdGroup = combo[oneGroup];
      const match = thirds.find(t => t.group === thirdGroup);
      result[tslot] = match ? match.team : null;
    });
    return result;
  }
  const result = {};
  const used = new Array(thirds.length).fill(false);
  function bt(slotIdx) {
    if (slotIdx === THIRD_SLOTS.length) return true;
    const slot = THIRD_SLOTS[slotIdx];
    for (let i = 0; i < thirds.length; i++) {
      if (used[i]) continue;
      if (slot.allowed.indexOf(thirds[i].group) === -1) continue;
      used[i] = true;
      result[slot.slot] = thirds[i].team;
      if (bt(slotIdx + 1)) return true;
      used[i] = false;
      delete result[slot.slot];
    }
    return false;
  }
  if (!bt(0)) {
    THIRD_SLOTS.forEach((s, i) => { result[s.slot] = thirds[i] ? thirds[i].team : null; });
  }
  return result;
}

function calcRealStandings(results) {
  const st = {};
  Object.keys(GT).forEach(g => {
    st[g] = GT[g].map(t => ({team:t, pts:0, played:0, w:0, d:0, l:0, gf:0, ga:0}));
  });
  GM.forEach(m => {
    const sc = results[m.id];
    if (!sc || !sc.includes("-")) return;
    const parts = sc.split("-");
    const gf = parseInt(parts[0]), ga = parseInt(parts[1]);
    if (isNaN(gf) || isNaN(ga)) return;
    const t1 = st[m.g].find(t => t.team === m.t1);
    const t2 = st[m.g].find(t => t.team === m.t2);
    if (!t1 || !t2) return;
    t1.gf += gf; t1.ga += ga; t1.played++;
    t2.gf += ga; t2.ga += gf; t2.played++;
    if (gf > ga) { t1.pts += 3; t1.w++; t2.l++; }
    else if (gf < ga) { t2.pts += 3; t2.w++; t1.l++; }
    else { t1.pts++; t2.pts++; t1.d++; t2.d++; }
  });
  const q = {};
  const thirds = [];
  Object.keys(st).forEach(g => {
    st[g].sort((a, b) => {
      if (b.pts !== a.pts) return b.pts - a.pts;
      const gdb = b.gf - b.ga, gda = a.gf - a.ga;
      if (gdb !== gda) return gdb - gda;
      return b.gf - a.gf;
    });
    q[g] = {first: st[g][0] ? st[g][0].team : null, second: st[g][1] ? st[g][1].team : null};
    if (st[g][2] && st[g][2].played > 0) thirds.push({team: st[g][2].team, group: g, pts: st[g][2].pts, gf: st[g][2].gf, ga: st[g][2].ga});
  });
  thirds.sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    const gdb = b.gf - b.ga, gda = a.gf - a.ga;
    if (gdb !== gda) return gdb - gda;
    return b.gf - a.gf;
  });
  const bestThirds = thirds.slice(0, 8);
  return {qualified: q, bestThirds: bestThirds};
}

function getRealSlots(results) {
  const {qualified, bestThirds} = calcRealStandings(results);
  const slots = {};
  Object.keys(qualified).forEach(g => {
    slots["1" + g] = qualified[g].first;
    slots["2" + g] = qualified[g].second;
  });
  if (bestThirds.length === 8) {
    const assigned = assignThirds(bestThirds);
    Object.keys(assigned).forEach(k => { slots[k] = assigned[k]; });
  } else {
    for (let i = 1; i <= 8; i++) slots["T" + i] = null;
  }
  return slots;
}

// Resolves a knockout match id (R32/R16/QF/SF/M103/M104) to its two real team names,
// given current `results` (which may include knockout winners from earlier rounds
// already written in this same run via `liveResults`). Returns {t1, t2} with nulls
// for any side not yet determined.
function resolveKOTeams(mid, slots, liveResults) {
  const r32 = R32.find(m => m.id === mid);
  if (r32) return {t1: slots[r32.s1] || null, t2: slots[r32.s2] || null};
  const m = R16.find(x => x.id === mid) || QF.find(x => x.id === mid) || SF.find(x => x.id === mid);
  if (m) return {t1: liveResults[m.f1] || null, t2: liveResults[m.f2] || null};
  if (mid === "M104") return {t1: liveResults["M101"] || null, t2: liveResults["M102"] || null};
  if (mid === "M103") {
    // Bronze final: the two SF LOSERS, not winners. Need both SF matches' team pairs
    // and their winners to figure out who lost.
    const sf1 = SF.find(x => x.id === "M101"), sf2 = SF.find(x => x.id === "M102");
    const sf1Teams = resolveKOTeams("M101", slots, liveResults);
    const sf2Teams = resolveKOTeams("M102", slots, liveResults);
    const sf1Winner = liveResults["M101"], sf2Winner = liveResults["M102"];
    const loserOf = (teams, winner) => {
      if (!winner || !teams.t1 || !teams.t2) return null;
      if (winner === teams.t1) return teams.t2;
      if (winner === teams.t2) return teams.t1;
      return null;
    };
    return {t1: loserOf(sf1Teams, sf1Winner), t2: loserOf(sf2Teams, sf2Winner)};
  }
  return {t1: null, t2: null};
}

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

const ROUND_BUCKETS = {
  "round of 32": R32,
  "round of 16": R16,
  "quarter-final": QF,
  "quarter-finals": QF,
  "semi-final": SF,
  "semi-finals": SF,
  "third place": [{id: "M103"}],
  "third-place": [{id: "M103"}],
  "final": [{id: "M104"}],
};

async function fetchAndApplySync() {
  const res = await fetch(
    "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json"
  );
  if (!res.ok) {
    throw new Error("openfootball fetch failed: " + res.status);
  }
  const data = await res.json();
  const matches = data.matches || [];

  const snapshot = await admin.database().ref("results").once("value");
  const results = snapshot.val() || {};

  // liveResults starts as a copy of the DB's current results and accumulates any
  // new writes from THIS run, so later rounds (which depend on earlier winners) can
  // resolve correctly even if multiple rounds advance within a single sync run.
  const liveResults = Object.assign({}, results);
  const slots = getRealSlots(results); // group-stage standings don't change once frozen

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
      return;
    }

    // Knockout match. Only proceed once both sides are REAL team names (not
    // placeholder codes like "W73" or "1A" — those mean the feed itself doesn't
    // know who's playing yet).
    if (t1.match(/^[0-9W]/) || t2.match(/^[0-9W]/)) return;

    let winner = null;
    const wentToPens = !!sc.p;
    if (sc.p) {
      winner = sc.p[0] > sc.p[1] ? t1 : t2;
    } else if (ft[0] !== ft[1]) {
      winner = ft[0] > ft[1] ? t1 : t2;
    }
    if (!winner) return; // draw with no penalty shootout recorded — nothing to write yet

    // Stored result format: "Winner|winnerScore-loserScore[|pens]" — always the 90-minute
    // (ft) score regardless of whether extra time was played; "pens" appended only if
    // penalties decided it. winner === t1 vs t2 tells us which side of `ft` is the winner's.
    const winnerScore = winner === t1 ? ft[0] : ft[1];
    const loserScore = winner === t1 ? ft[1] : ft[0];
    const resultString = winner + "|" + winnerScore + "-" + loserScore + (wentToPens ? "|pens" : "");

    const round = (m.round || "").toLowerCase();
    let bucket = null;
    for (const [k, v] of Object.entries(ROUND_BUCKETS)) {
      if (round.includes(k)) { bucket = v; break; }
    }
    if (!bucket) return;

    // THE FIX: match by team identity, not "first empty slot in the round".
    // For each candidate match id in this round, resolve its real two teams and
    // only assign the winner if it's genuinely one of those two teams AND the
    // other side matches the feed's other team too (defends against e.g. two
    // different R32 matches both featuring a team named identically in error).
    for (const bm of bucket) {
      if (updates[bm.id] || liveResults[bm.id]) continue; // already has/getting a result
      const teams = resolveKOTeams(bm.id, slots, liveResults);
      if (!teams.t1 || !teams.t2) continue; // not yet resolved on our side — can't match
      const teamsMatch =
        (teams.t1 === t1 && teams.t2 === t2) || (teams.t1 === t2 && teams.t2 === t1);
      if (!teamsMatch) continue;
      updates[bm.id] = resultString;
      // liveResults keeps the BARE winner name (not the "Winner|score" string) so that
      // resolveKOTeams()'s downstream equality checks against team names keep working
      // when resolving later rounds within this same sync run.
      liveResults[bm.id] = winner;
      break;
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

// Exposed for automated testing only — not used by the Netlify handler itself.
exports.__test_fetchAndApplySync = fetchAndApplySync;
exports.__test_getRealSlots = getRealSlots;
exports.__test_resolveKOTeams = resolveKOTeams;
exports.__test_GM = GM;

// The actual cron schedule for this function is declared in netlify.toml
// (not here) — see the [functions."sync-results"] section in that file.
// This keeps the function itself as a plain, ordinary handler with no
// dependency on the @netlify/functions helper package.
