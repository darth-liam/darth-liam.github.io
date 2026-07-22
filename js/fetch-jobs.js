// fetch-jobs.js
// Pulls listings from a few free, no-key job APIs, normalizes them into a
// common shape, and writes the result to jobs.json.
//
// Run manually:   node fetch-jobs.js
// Run on a schedule via the GitHub Actions workflow in
// .github/workflows/update-jobs.yml
//
// Requires Node 18+ (built-in fetch).

import { writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Add custom sources here later. Two easy ones to bolt on if you want specific
// companies included: most companies on Greenhouse or Lever expose a free
// public JSON API, e.g.
//   https://boards-api.greenhouse.io/v1/boards/<company>/jobs
//   https://api.lever.co/v0/postings/<company>?mode=json
// Add a fetcher function below following the same pattern as the others,
// then push its results into `allJobs`.
// ---------------------------------------------------------------------------

const KEYWORD_FILTER = null; // e.g. "engineer" to only keep matching titles, or null for everything
const MAX_AGE_DAYS = 30; // drop postings older than this many days (null to disable)

function daysAgo(dateLike) {
  const then = new Date(dateLike).getTime();
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / (1000 * 60 * 60 * 24);
}

function passesFilters(job) {
  if (MAX_AGE_DAYS !== null && daysAgo(job.posted) > MAX_AGE_DAYS) return false;
  if (KEYWORD_FILTER) {
    const haystack = `${job.title} ${job.company} ${job.tags.join(" ")}`.toLowerCase();
    if (!haystack.includes(KEYWORD_FILTER.toLowerCase())) return false;
  }
  return true;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "personal-job-aggregator/1.0" },
    ...options,
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// RemoteOK — https://remoteok.com/api
// Free, no key. First array element is a legal-notice object, skip it.
// ---------------------------------------------------------------------------
async function fetchRemoteOK() {
  const data = await fetchJson("https://remoteok.com/api");
  return data
    .filter((item) => item && item.id && item.position)
    .map((item) => ({
      id: `remoteok-${item.id}`,
      title: item.position,
      company: item.company,
      location: item.location || "Remote",
      url: item.url || `https://remoteok.com/l/${item.id}`,
      source: "RemoteOK",
      tags: Array.isArray(item.tags) ? item.tags : [],
      posted: item.date || null,
    }));
}

// ---------------------------------------------------------------------------
// Remotive — https://remotive.com/api/remote-jobs
// Free, no key. Note: Remotive's terms require linking back to the job's
// Remotive URL and crediting Remotive as the source (which this does via
// `source` + `url`) — see https://remotive.com/remote-jobs/api
// ---------------------------------------------------------------------------
async function fetchRemotive() {
  const data = await fetchJson("https://remotive.com/api/remote-jobs");
  return (data.jobs || []).map((item) => ({
    id: `remotive-${item.id}`,
    title: item.title,
    company: item.company_name,
    location: item.candidate_required_location || "Remote",
    url: item.url,
    source: "Remotive",
    tags: Array.isArray(item.tags) ? item.tags : [],
    posted: item.publication_date || null,
  }));
}

// ---------------------------------------------------------------------------
// Arbeitnow — https://arbeitnow.com/api/job-board-api
// Free, no key. Europe-heavy + remote listings.
// ---------------------------------------------------------------------------
async function fetchArbeitnow() {
  const data = await fetchJson("https://arbeitnow.com/api/job-board-api");
  return (data.data || []).map((item) => ({
    id: `arbeitnow-${item.slug}`,
    title: item.title,
    company: item.company_name,
    location: item.remote ? "Remote" : item.location || "Unspecified",
    url: item.url,
    source: "Arbeitnow",
    tags: Array.isArray(item.tags) ? item.tags : [],
    posted: item.created_at ? new Date(item.created_at * 1000).toISOString() : null,
  }));
}

async function main() {
  const fetchers = [
    ["RemoteOK", fetchRemoteOK],
    ["Remotive", fetchRemotive],
    ["Arbeitnow", fetchArbeitnow],
  ];

  const results = await Promise.allSettled(fetchers.map(([, fn]) => fn()));

  let allJobs = [];
  const sourceStatus = {};

  results.forEach((result, i) => {
    const [name] = fetchers[i];
    if (result.status === "fulfilled") {
      allJobs = allJobs.concat(result.value);
      sourceStatus[name] = { ok: true, count: result.value.length };
    } else {
      sourceStatus[name] = { ok: false, error: String(result.reason) };
      console.error(`[${name}] fetch failed:`, result.reason);
    }
  });

  allJobs = allJobs.filter(passesFilters);

  // Newest first
  allJobs.sort((a, b) => new Date(b.posted || 0) - new Date(a.posted || 0));

  const output = {
    updated_at: new Date().toISOString(),
    count: allJobs.length,
    sources: sourceStatus,
    jobs: allJobs,
  };

  await writeFile("jobs.json", JSON.stringify(output, null, 2));
  console.log(`Wrote ${allJobs.length} jobs to jobs.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
