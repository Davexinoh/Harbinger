import fetch from "node-fetch";

const API_BASE = "https://v3.football.api-sports.io";

// African leagues and major tournaments Bayse covers
const WATCHED_LEAGUES = [
  { id: 233, name: "Nigerian Professional Football League", country: "Nigeria" },
  { id: 12, name: "CAF Champions League", country: "Africa" },
  { id: 6, name: "Africa Cup of Nations", country: "Africa" },
  { id: 39, name: "Premier League", country: "England" }, // globally traded
];

let fixtureCache = null;
let fixtureCacheTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — API-Football free tier is precious

async function fetchUpcomingFixtures() {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) throw new Error("API_FOOTBALL_KEY not set");

  const now = Date.now();
  if (fixtureCache && now - fixtureCacheTime < CACHE_TTL_MS) return fixtureCache;

  const today = new Date().toISOString().split("T")[0];
  const leagueIds = WATCHED_LEAGUES.map((l) => l.id);

  // Fetch fixtures for each league — we only have 100 req/day so be conservative
  const results = [];
  for (const leagueId of leagueIds.slice(0, 2)) {
    // limit to 2 leagues per tick to preserve quota
    try {
      const res = await fetch(
        `${API_BASE}/fixtures?league=${leagueId}&date=${today}&status=NS`,
        {
          headers: {
            "x-apisports-key": key,
            Accept: "application/json",
          },
        }
      );
      const data = await res.json();
      if (data.response) results.push(...data.response);
    } catch (err) {
      console.error(`[SportsSignal] League ${leagueId} fetch failed:`, err.message);
    }
  }

  fixtureCache = results;
  fixtureCacheTime = now;
  return results;
}

async function getTeamForm(teamId) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return null;

  try {
    const res = await fetch(
      `${API_BASE}/teams/statistics?team=${teamId}&season=2024&last=5`,
      {
        headers: {
          "x-apisports-key": key,
          Accept: "application/json",
        },
      }
    );
    const data = await res.json();
    return data.response || null;
  } catch {
    return null;
  }
}

// Calculate form score from last 5 results string e.g. "WWDLW"
function parseFormString(formStr) {
  if (!formStr) return 0.5;
  const recent = formStr.slice(-5);
  let score = 0;
  for (const char of recent) {
    if (char === "W") score += 1;
    else if (char === "D") score += 0.4;
    // L = 0
  }
  return score / 5; // normalise to 0–1
}

function scoreFixture(fixture) {
  const home = fixture.teams?.home;
  const away = fixture.teams?.away;
  if (!home || !away) return null;

  // Use form strings if available in the fixture response
  const homeForm = parseFormString(home.form || "");
  const awayForm = parseFormString(away.form || "");

  const formDiff = Math.abs(homeForm - awayForm);
  const favoredTeam = homeForm > awayForm ? home : away;
  const favoredOutcome = homeForm > awayForm ? "home" : "away";

  // Signal is stronger when form difference is large
  // formDiff of 0.8 means one team is dominant → high confidence
  const score = 0.4 + formDiff * 0.6;

  return {
    fixtureId: fixture.fixture?.id,
    homeTeam: home.name,
    awayTeam: away.name,
    kickoff: fixture.fixture?.date,
    homeForm,
    awayForm,
    score: Math.min(score, 1),
    favoredTeam: favoredTeam.name,
    favoredOutcome,
    keywords: [
      home.name.toLowerCase(),
      away.name.toLowerCase(),
      "football",
      "soccer",
      "match",
    ],
  };
}

export async function runSportsSignal() {
  try {
    const fixtures = await fetchUpcomingFixtures();

    if (!fixtures.length) {
      return {
        source: "sports",
        score: 0,
        direction: null,
        reason: "No fixtures today",
        fetched_at: new Date().toISOString(),
      };
    }

    const scored = fixtures
      .map(scoreFixture)
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];

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
      score: 0,
      direction: null,
      error: err.message,
      fetched_at: new Date().toISOString(),
    };
  }
}
