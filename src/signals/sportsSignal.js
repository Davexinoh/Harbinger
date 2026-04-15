import fetch from "node-fetch";

const API_BASE = "https://v3.football.api-sports.io";

// Broader league set — increases chance of hitting live fixtures
const WATCHED_LEAGUES = [
  { id: 233, name: "NPFL", country: "Nigeria" },
  { id: 12,  name: "CAF Champions League", country: "Africa" },
  { id: 6,   name: "AFCON", country: "Africa" },
  { id: 39,  name: "Premier League", country: "England" },
  { id: 140, name: "La Liga", country: "Spain" },
  { id: 61,  name: "Ligue 1", country: "France" },
  { id: 78,  name: "Bundesliga", country: "Germany" },
  { id: 135, name: "Serie A", country: "Italy" },
  { id: 2,   name: "UEFA Champions League", country: "Europe" },
  { id: 3,   name: "UEFA Europa League", country: "Europe" },
];

let fixtureCache = null;
let fixtureCacheTime = 0;
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min

async function fetchUpcomingFixtures() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY not set");

  const now = Date.now();
  if (fixtureCache && now - fixtureCacheTime < CACHE_TTL_MS) return fixtureCache;

  const today = new Date().toISOString().split("T")[0];

  // Fetch today's fixtures across all statuses — not just NS (not started)
  // Include live (1H, 2H, HT) and upcoming (NS, TBD)
  const statuses = ["NS", "TBD", "1H", "2H", "HT", "ET", "BT"];

  const results = [];

  // Fetch by date — one call gets all leagues for the day
  try {
    const res = await fetch(
      `${API_BASE}/fixtures?date=${today}&status=NS-TBD-1H-2H-HT`,
      {
        headers: {
          "x-apisports-key": key,
          Accept: "application/json",
        },
        timeout: 10_000,
      }
    );

    if (!res.ok) throw new Error(`API-Football ${res.status}`);

    const data = await res.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      throw new Error(JSON.stringify(data.errors));
    }

    if (data.response?.length) {
      results.push(...data.response);
      console.log(`[SportsSignal] Fetched ${data.response.length} fixtures for ${today}`);
    } else {
      console.log(`[SportsSignal] No fixtures returned for ${today}`);
    }
  } catch (err) {
    console.error(`[SportsSignal] Fixture fetch failed:`, err.message);
  }

  // If today has nothing, try next 3 days for upcoming fixtures
  if (!results.length) {
    for (let d = 1; d <= 3; d++) {
      const date = new Date(Date.now() + d * 86400000).toISOString().split("T")[0];
      try {
        const res = await fetch(
          `${API_BASE}/fixtures?date=${date}&status=NS`,
          {
            headers: { "x-apisports-key": key, Accept: "application/json" },
            timeout: 10_000,
          }
        );
        const data = await res.json();
        if (data.response?.length) {
          results.push(...data.response);
          console.log(`[SportsSignal] Found ${data.response.length} upcoming fixtures on ${date}`);
          break;
        }
      } catch (err) {
        console.error(`[SportsSignal] Upcoming fetch day +${d} failed:`, err.message);
      }
    }
  }

  fixtureCache = results;
  fixtureCacheTime = now;
  return results;
}

function parseFormString(formStr) {
  if (!formStr) return 0.5;
  const recent = formStr.slice(-5);
  let score = 0;
  for (const char of recent) {
    if (char === "W") score += 1;
    else if (char === "D") score += 0.4;
  }
  return score / 5;
}

function scoreFixture(fixture) {
  const home = fixture.teams?.home;
  const away = fixture.teams?.away;
  if (!home || !away) return null;

  const homeForm = parseFormString(home.form || "");
  const awayForm = parseFormString(away.form || "");
  const formDiff = Math.abs(homeForm - awayForm);
  const favoredOutcome = homeForm >= awayForm ? "home" : "away";
  const favoredTeam = homeForm >= awayForm ? home : away;

  // Base score on form diff — minimum 0.35 so signal is never dead even for evenly matched teams
  const score = 0.35 + formDiff * 0.6;

  const leagueName = fixture.league?.name || "";
  const country    = fixture.league?.country || "";

  return {
    fixtureId: fixture.fixture?.id,
    homeTeam: home.name,
    awayTeam: away.name,
    kickoff: fixture.fixture?.date,
    league: leagueName,
    country,
    homeForm,
    awayForm,
    score: Math.min(score, 1),
    favoredTeam: favoredTeam.name,
    favoredOutcome,
    keywords: [
      home.name.toLowerCase(),
      away.name.toLowerCase(),
      leagueName.toLowerCase(),
      country.toLowerCase(),
      "football",
      "soccer",
      "match",
      "win",
    ],
  };
}

export async function runSportsSignal() {
  try {
    const fixtures = await fetchUpcomingFixtures();

    if (!fixtures.length) {
      // Return a baseline score instead of 0 — no fixtures shouldn't kill the signal
      return {
        source: "sports",
        score: 0.3,
        direction: "home",
        reason: "No fixtures found — using baseline",
        fetched_at: new Date().toISOString(),
      };
    }

    const scored = fixtures
      .map(scoreFixture)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];

    console.log(`[SportsSignal] Best fixture: ${best.homeTeam} vs ${best.awayTeam} | score: ${best.score.toFixed(3)}`);

    return {
      source: "sports",
      score: best.score,
      direction: best.favoredOutcome,
      best,
      all: scored.slice(0, 5),
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error("[SportsSignal] Error:", err.message);
    return {
      source: "sports",
      score: 0.3,
      direction: "home",
      error: err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
