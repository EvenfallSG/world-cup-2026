// netlify/functions/scorers.js
//
// Runs on Netlify's server, not in the browser. This is what keeps the
// football-data.org API key private: it's read from an environment
// variable (set in Netlify's dashboard) and never sent to the browser.
//
// The front-end (index.html) calls THIS function at /.netlify/functions/scorers
// instead of calling football-data.org directly.

exports.handler = async function (event, context) {
  const API_KEY = process.env.FOOTBALL_API_KEY;

  // Basic CORS so the function can be called from the browser at all.
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (!API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "FOOTBALL_API_KEY is not set in Netlify environment variables." }),
    };
  }

  try {
    const res = await fetch("https://api.football-data.org/v4/competitions/WC/scorers?limit=10", {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: "Upstream API error", status: res.status, detail: errText }),
      };
    }

    const data = await res.json();

    const scorers = (data.scorers || []).map((s) => ({
      name: s.player && s.player.name,
      team: s.team && s.team.name,
      goals: s.goals,
      assists: s.assists != null ? s.assists : null,
      penalties: s.penalties != null ? s.penalties : null,
    }));

    return {
      statusCode: 200,
      headers: { ...headers, "Cache-Control": "public, max-age=1800" },
      body: JSON.stringify({ scorers, lastUpdated: new Date().toISOString() }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Function error", detail: String(err) }),
    };
  }
};
