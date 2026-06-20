# Sports Prediction Apps — Project Brief
> Last updated: June 20, 2026 (session 3)
> For Victor Manggunio (EvenfallSG)
 
---
 
## PROJECT PORTFOLIO
 
| Project | Status | Notes |
|---|---|---|
| **FIFA World Cup 2026 Predictor** | 🟢 Live, in active use | Tournament running now through July 19, 2026 |
| **English Premier League Predictor** | 💡 Idea stage | Not started — see [Future Projects](#future-projects) |
| **Euros Predictor** | 💡 Idea stage | Not started — see [Future Projects](#future-projects) |
 
Whether the EPL/Euros tools become standalone sites (their own repo each, like WC2026) or a single shared platform with switchable tournaments is **not yet decided**. Don't assume shared code or shared infra until that's actually chosen.
 
---
 
# PART 1 — FIFA WORLD CUP 2026 PREDICTOR (LIVE)
 
## LIVE SITE
**URL:** https://wcpred2026.netlify.app
**GitHub repo:** https://github.com/EvenfallSG/world-cup-2026
**Main file:** `index.html` (single-file app, ~2,340 lines)
 
---
 
## TECH STACK
| Layer | What |
|---|---|
| Frontend | React 18 (CDN, no build step) |
| Styling | Tailwind CSS (CDN) + custom CSS |
| Fonts | Bebas Neue + Inter (Google Fonts) |
| Database | Firebase Realtime Database (REST API, no SDK) |
| Hosting | Netlify (paid Basic plan, auto-deploy from GitHub) |
| Serverless | Netlify Functions (`netlify/functions/scorers.js`) — proxies football-data.org |
| Live scorer data | football-data.org (free tier) |
| Live match results | openfootball/worldcup.json (GitHub raw JSON, auto-synced) |
 
### Firebase credentials
```
DB URL: https://world-cup-2026-predictio-23e8f-default-rtdb.firebaseio.com
Project: world-cup-2026-predictio-23e8f
Rules: { "rules": { ".read": true, ".write": true } }
```
**Critical:** the URL must include `-default-rtdb` — without it, nothing saves.
 
### football-data.org API key
- Stored as Netlify environment variable `FOOTBALL_API_KEY` — **never** in client-side code
- Accessed only via the serverless proxy at `/.netlify/functions/scorers` — the front end calls this endpoint, never football-data.org directly
- Free tier, World Cup competition included, no billing attached
### How data saves
- Uses Firebase REST API (`fetch` PUT/GET requests) — no SDK, no module import errors
- Each prediction saves as its **own individual key** (`fbSetKey`) to prevent player-vs-player clobbering
- Background poll every **8 seconds** with merge logic — edits made in the last 15 seconds are protected from being overwritten by poll data
- Tournament state (`players`, `predictions`, `results`, `tournamentStarted`) stored at root of DB
---
 
## APP FEATURES (FULLY BUILT)
 
### Player management
- Unlimited players
- Setup screen: organiser adds names, needs 3+ to start tournament
- Self-registration stays open through the **entire group stage** (closes when the knockout stage kicks off, not a fixed calendar date)
- Login by name selection (no password needed)
- **3-digit PIN protection (optional, per-player):**
  - New/untouched players are prompted to set a PIN before they can start picking
  - Existing players with picks already in can set one or skip (skipping = read-only until they do)
  - Wrong PIN → offered read-only view instead of a lockout
  - PIN is a soft "stop friends fat-fingering your picks" measure, explicitly not a real password
- Participant sidebar (desktop) / dropdown selector (mobile): click/select any player to view their picks in read-only mode, split into "Full Bracket" and "Quick Picks" sections
### Two play modes (chosen at first login)
1. **Full Bracket** — predict all 72 group scores + full knockout bracket
2. **Quick Picks** — casual mode: just pick Champion, Runner-up, 3rd, 4th, Golden Boot, MVP
3. **🎲 C.B.F. Button ("Clueless But FOMO")** — one-tap randomiser that sets mode to Quick Picks and randomly fills all six picks for players who just want in with zero effort
Mode is **re-derived defensively** from actual picks made (`effectiveMode`), not just the stored flag — protects against a stale MODE flag if someone switches paths mid-flow.
 
### Group Stage
- All 72 matches across 12 groups (A–L), 4 teams each
- Score-based predictions (format: "2-1")
- Input validation with error messages, real-time red-border highlighting on invalid format
- **Two browsing views:** chronological (by date, grouped by calendar day in the viewer's local time) or by group
- **Per-match kickoff locking:** each group match locks automatically at its real-world kickoff time (official FIFA schedule, stored in UTC, converted to each viewer's local time)
- **Live score comparison:** once an actual result is in, predicted score is colour-coded against it — ✅ exact, 🟡 correct result, ❌ miss
### Auto-calculated standings
- FIFA 2026 rules: 3pts win, 1pt draw, 0pts loss
- Tiebreakers: Goal Difference → Goals Scored
- Top 2 per group qualify (green), bottom 2 eliminated (red)
- Calculated per-player based on their own score predictions, **and** separately from actual results (Results tab)
### Bracket (Official FIFA Appendix A structure)
**Match numbers follow official FIFA 2026 bracket (M73–M104):**
 
| Round | Matches | Dates |
|---|---|---|
| Round of 32 | M73–M88 (16 matches) | Jun 28 – Jul 3 |
| Round of 16 | M89–M96 (8 matches) | Jul 4–7 |
| Quarter Finals | M97–M100 (4 matches) | Jul 9–11 |
| Semi Finals | M101–M102 (2 matches) | Jul 14–15 |
| Bronze Final | M103 | Jul 18 |
| Final | M104 | Jul 19 |
 
**Key logic:**
- Teams auto-populate from the player's own group stage predictions
- 8 best third-placed teams fill R32 slots using **official Appendix A group constraints** (e.g. M74 slot only accepts 3rd from groups A/B/C/D/F), resolved via a backtracking constraint solver
- Validated winner resolver: stale picks (from changed upstream results) auto-clear
- Display order is the **official pathway flow** so adjacent matches visually feed the next round, with an SVG overlay drawing connector lines/arrows between rounds (measures real DOM positions live, redraws on resize)
- **Mirrored layout**: Pathway 1 (left) → Final (centre, vertically aligned to the SF row) ← Pathway 2 (right)
- **Whole bracket locks** (all KO picks, Quick Picks, awards) at one shared cutoff: kickoff of the first Round of 32 match (Jun 28)
- **Mobile view:** separate stacked, round-by-round list (no horizontal scroll needed) with a round-jump pill selector — desktop keeps the horizontal-scroll mirrored bracket
**Pathway 1 (left side):**
```
M74+M77 → M89 ┐
M73+M75 → M90 ┘→ M97 ┐
M83+M84 → M93 ┐       ├→ M101 ┐
M81+M82 → M94 ┘→ M98 ┘        ├→ M104 FINAL
```
**Pathway 2 (right side):**
```
M76+M78 → M91 ┐
M79+M80 → M92 ┘→ M99  ┐
M86+M88 → M95 ┐        ├→ M102 ┘
M85+M87 → M96 ┘→ M100 ┘
```
 
### Centre column (Final + Podium)
- **M104 FINAL** — Jul 19, larger gold-bordered card
- **M103 BRONZE FINAL** — Jul 18 (auto-fills with the two SF losers)
- **PODIUM panel** showing Champion (gold), Runner-up (silver), 3rd Place (bronze, from M103 winner), Golden Boot pick, MVP pick
### Special predictions
- **Golden Boot** (text input) — shared between Quick Picks tab and Groups tab
- **Tournament MVP** (text input) — same
- Both lock at the same knockout-stage cutoff as the bracket
### Scoring engine (built — was "not yet calculated" in the old brief)
| Category | Points |
|---|---|
| Group stage — exact score | 3 |
| Group stage — correct result (W/D/L) | 1 |
| Knockout — correct match winner | 2 |
| Quick Pick — Champion | 5 |
| Quick Pick — Runner-up | 3 |
| Quick Pick — 3rd place | 2 |
| Quick Pick — 4th place | 1 |
| Golden Boot / MVP (either mode) | 3 each |
 
- Full Bracket players' Champion/Runner-up/3rd are derived from their M104/M103 bracket picks (no double data entry)
- Quick Pick players are scored only on their 6 picks — defensive logic prevents stray keys leaking extra points
- Per-player breakdown tracked (group exact / group outcome / KO correct / QP points / award points) and shown on the leaderboard and admin results screen
### Live Leaderboard
- Purple "🏆 Leaderboard" button → full-screen ranked table
- **Split into two boards:** Full Bracket and Quick Picks (different point ceilings, so not ranked together)
- Medal icons for top 3, scoring legend shown at the top
- Clicking a player's name (when logged in) jumps straight to their picks, read-only
- Auto-updates every 8 seconds
- Designed for TV/projector display
### Results tab (admin-gated)
- Password-gated admin mode (`ADMIN_PASSWORD`, currently plaintext in the front-end — flagged as a known gap, see Limitations)
- **Auto-sync** from `openfootball/worldcup.json` on load and every 30 minutes — pulls in completed group and knockout results automatically, with team-name normalisation between the two datasets
- Manual override always available to admin alongside auto-sync
- Shows actual group standings (computed from real results, same layout as the player-facing standings view) and a live mini-leaderboard preview
- "Sync now" manual refresh button + sync status indicator
### News ticker (new)
- Fixed bottom bar, rotates every 5 seconds through:
  - Most recent completed group result
  - Next upcoming kickoff (viewer's local time)
  - Leaderboard leader (Full Bracket and Quick Picks separately), plus a "tight race" callout when the gap is ≤3 points
  - **Live Golden Boot race** — real tournament top scorer(s) via football-data.org through the Netlify function proxy, refreshed every 30 minutes
- Dismissible per session, dot indicators show position in rotation
### "What's New" notice
- Dismissible banner on the login screen, version-stamped so it reappears once whenever the content changes (`WHATS_NEW_VERSION` constant)
---
 
## VISUAL DESIGN
 
### Style direction
"Stadium at night, FIFA official, classy — not garish"
 
### Colours
- Background: deep navy `#091a36` → teal-green `#0a4438`, with cyan/amber radial glow accents
- Accent: amber/gold `#fbbf24` for active tabs, titles, highlights
- Cards: frosted glass (`rgba(255,255,255,0.96)` + backdrop blur)
- Qualified teams: gradient green sweep
- Bracket round headers: deep blue with white caps lettering
### Typography
- **Display:** Bebas Neue (Google Fonts) — title only
- **Body/UI:** Inter (Google Fonts)
- Title: letterspaced, gold-tinted text-shadow glow
### UI polish
- Cards: deep shadow, border with light glass effect
- Tabs: gold gradient active state with lift transform
- Bracket match cards: hover lift + deeper shadow
- Bracket scrollbar: custom blue-to-green gradient
- Emoji flags rendered for every team via Unicode regional indicators (including England/Scotland subdivision flags)
- All buttons/inputs: smooth 150ms transitions
---
 
## DEPLOYMENT
 
### Current workflow
1. Edit `index.html` locally or via GitHub web editor
2. Commit to `main` branch
3. Netlify auto-deploys (~1-2 mins)
4. Hard refresh browser: **Cmd+Shift+R**
### Common issues & fixes
| Problem | Cause | Fix |
|---|---|---|
| Site shows old version | Browser cache | Cmd+Shift+R or incognito window |
| Deploys skipping | Netlify free plan build credits exceeded | Upgraded to paid ✅ OR drag-drop folder to Deploys page |
| White page / syntax error | JS syntax error in index.html | Check browser Console tab for line number |
| Data not saving | Wrong Firebase URL (missing `-default-rtdb`) | Fixed ✅ |
| Inputs resetting while typing | Poll overwriting live state | Fixed with merge logic + 15s protection ✅ |
| Bracket showing wrong teams | Stale picks propagating downstream | Fixed with validated resolver ✅ |
| Site went blank after a feature add | Hook declared after the code that reads it (`topScorers` read before init) | Fixed — state must be declared before any hook/memo that references it ✅ |
| GitHub editor commits an empty file | Paste didn't fully take in the web editor | Re-open the file, re-paste, check the line count shown before committing |
 
---
 
## TOURNAMENT DATA
 
### Groups
```
A: Mexico, South Africa, South Korea, Czechia
B: Canada, Bosnia-Herzegovina, Qatar, Switzerland
C: Brazil, Morocco, Haiti, Scotland
D: United States, Paraguay, Australia, Turkiye
E: Germany, Curacao, Ivory Coast, Ecuador
F: Netherlands, Japan, Sweden, Tunisia
G: Belgium, Egypt, Iran, New Zealand
H: Spain, Cape Verde, Saudi Arabia, Uruguay
I: France, Senegal, Iraq, Norway
J: Argentina, Algeria, Austria, Jordan
K: Colombia, Uzbekistan, Portugal, Congo DR
L: England, Croatia, Ghana, Panama
```
 
### Key dates
- Tournament opened: **June 11** (Mexico vs South Africa)
- Self-registration: open through entire group stage, closes when knockouts begin
- Round of 32: June 28 – July 3
- Round of 16: July 4–7
- Quarter Finals: July 9–11
- Semi Finals: July 14–15
- Bronze Final: July 18
- **FINAL: July 19**
---
 
## FIREBASE DATA STRUCTURE
```json
{
  "tournamentStarted": true,
  "players": {
    "TIMESTAMP_ID": { "id": "TIMESTAMP_ID", "name": "PlayerName", "pin": "123" }
  },
  "predictions": {
    "PLAYERID-MATCHID": "score or team name",
    "PLAYERID-A1": "2-1",
    "PLAYERID-M89": "Brazil",
    "PLAYERID-GOLDEN_BOOT": "Mbappe",
    "PLAYERID-MVP": "Vinicius Jr",
    "PLAYERID-MODE": "full or quick",
    "PLAYERID-QP_WIN": "Brazil",
    "PLAYERID-QP_RUN": "Argentina",
    "PLAYERID-QP_3RD": "France",
    "PLAYERID-QP_4TH": "Germany"
  },
  "results": {
    "A1": "2-1",
    "M89": "Brazil",
    "QP_WIN": "Brazil",
    "GOLDEN_BOOT": "Mbappe",
    "MVP": "Vinicius Jr"
  }
}
```
 
---
 
## KNOWN LIMITATIONS / FUTURE IDEAS
- **Admin password is plaintext in the public `index.html`** — anyone who reads the source can find `ADMIN_PASSWORD`. Low real-world risk for a friends-group app, but worth moving server-side eventually (e.g. via a Netlify function, like the scorer proxy)
- Third-place slot assignment uses backtracking against the official constraint matrix — should match the real FIFA allocation correctly, but hasn't been cross-checked against every one of the 495 possible combinations
- No rate-limit handling if football-data.org's free tier is hit hard — currently low-risk given the 30-minute refresh interval
- Could add: bonus points for correct scores in knockout matches (currently win/loss only), group winner prediction bonus, "most goals in tournament" side bet
---
 
## HOW TO RESUME IN A NEW CHAT
 
Paste this at the start of a new conversation:
 
> "I'm continuing work on my FIFA World Cup 2026 Predictor app. It's a single-file React app (no build step) deployed at wcpred2026.netlify.app via GitHub repo EvenfallSG/world-cup-2026. Firebase Realtime Database at world-cup-2026-predictio-23e8f-default-rtdb.firebaseio.com (public read/write rules). The app has: group stage score predictions for all 72 matches, auto-calculated FIFA standings, a mirrored bracket following official Appendix A structure (M73–M104) with Bronze Final, podium panel, Quick Picks mode with a C.B.F. randomiser, PIN-protected picks, a full scoring engine, a split (Full Bracket / Quick Picks) leaderboard, an admin Results tab with auto-sync from openfootball.json plus a live Golden Boot ticker via a football-data.org Netlify function proxy, and a mobile-specific stacked bracket view. The latest index.html is attached. I need help with: [YOUR NEXT TASK]"
 
Then attach the `index.html` file.
 
---
 
# PART 2 — FUTURE PROJECTS
 
These are **ideas only** — nothing has been built, scoped in detail, or architecturally decided. Treat anything below as a starting conversation, not a spec.
 
## English Premier League Predictor
- Status: idea stage, not started
- Open questions to resolve before building anything:
  - Predict the full 380-match season, or just a slice (e.g. one matchweek at a time, top-4 race, relegation picks)?
  - Live data source for an ongoing league (very different problem from a one-off tournament bracket — no knockout structure, no fixed end date, fixtures rescheduled regularly)
  - Whether this reuses any WC2026 patterns (Firebase REST approach, PIN system, ticker) or starts fresh
## Euros Predictor
- Status: idea stage, not started
- Likely the closest in structure to WC2026 (group stage + knockout bracket), so probably the easier of the two to adapt from existing WC2026 patterns once it's time to build
- Open questions:
  - Which Euros — timing/edition isn't specified yet
  - Group/bracket sizes differ from the World Cup format, so the bracket logic (slot constraints, third-place rules) would need to be re-derived from that tournament's actual format, not copied as-is
## Shared platform question (undecided)
Before starting either of the above, worth deciding:
- **Separate repos/sites** (simplest, fully independent, easiest to reason about — same pattern as WC2026) **vs.**
- **One shared app** with a tournament switcher (more reuse, but real-time data shapes, lock rules, and bracket logic differ enough between a league and a knockout tournament that a lot of "shared" code may end up branching per-tournament anyway)
No commitment either way yet — flag this explicitly at the start of whichever project gets picked up first.
 
---
 
*Originally built in a single session by Victor Manggunio (EvenfallSG) and Claude Sonnet, June 2026. Brief updated session 3 to reflect PIN protection, scoring engine, live ticker, admin sync, and mobile bracket view added since.*
 
