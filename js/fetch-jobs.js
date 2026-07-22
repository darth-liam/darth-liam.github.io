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
// Company sources. Add tokens to these lists to pull in more companies —
// see README.md for how to find a company's Greenhouse/Lever/Workday token.
// ---------------------------------------------------------------------------

const GREENHOUSE_BOARDS = [
  "vast", // Vast Space — https://job-boards.greenhouse.io/vast
];

const LEVER_COMPANIES = [
  // "spotify", // https://jobs.lever.co/spotify
];

// tenant/site/wd are read off the company's own myworkdayjobs.com URL, e.g.
// https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite
//                ^tenant  ^wd            ^site
const WORKDAY_SITES = [
  { tenant: "nvidia", wd: "wd5", site: "NVIDIAExternalCareerSite", company: "NVIDIA" },
  { tenant: "sec", wd: "wd3", site: "Samsung_Careers", company: "Samsung" },
];

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

// ---------------------------------------------------------------------------
// Greenhouse — free public API, no key. Token is the last part of the
// company's board URL, e.g. job-boards.greenhouse.io/vast -> "vast"
// ---------------------------------------------------------------------------
async function fetchGreenhouse(token) {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
  return (data.jobs || []).map((item) => ({
    id: `greenhouse-${token}-${item.id}`,
    title: item.title,
    company: item.company_name || token,
    location: item.location?.name || "Unspecified",
    url: item.absolute_url,
    source: "Greenhouse",
    tags: (item.departments || []).map((d) => d.name),
    posted: item.updated_at || item.first_published || null,
  }));
}

// ---------------------------------------------------------------------------
// Lever — free public API, no key. Token is the company slug in
// jobs.lever.co/<token>
// ---------------------------------------------------------------------------
async function fetchLever(token) {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${token}?mode=json`);
  return (data || []).map((item) => ({
    id: `lever-${token}-${item.id}`,
    title: item.text,
    company: token,
    location: item.categories?.location || "Unspecified",
    url: item.hostedUrl,
    source: "Lever",
    tags: item.categories?.team ? [item.categories.team] : [],
    posted: item.createdAt ? new Date(item.createdAt).toISOString() : null,
  }));
}

// ---------------------------------------------------------------------------
// Workday — free public JSON feed on every myworkdayjobs.com tenant, but it's
// an internal endpoint (not an officially documented public API) and
// Workday's Akamai bot protection can block requests that don't look like a
// real browser, or that come from a datacenter IP (GitHub Actions runners
// are datacenter IPs). Treat this as best-effort: if it starts failing in
// the Action logs, that's likely why.
// ---------------------------------------------------------------------------
async function fetchWorkday({ tenant, wd, site, company }) {
  const url = `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const data = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Referer: `https://${tenant}.${wd}.myworkdayjobs.com/${site}`,
    },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }),
  });
  return (data.jobPostings || []).map((item) => ({
    id: `workday-${tenant}-${item.bulletFields?.[0] || item.title}`,
    title: item.title,
    company,
    location: item.locationsText || item.bulletFields?.[1] || "Unspecified",
    url: `https://${tenant}.${wd}.myworkdayjobs.com/${site}${item.externalPath}`,
    source: "Workday",
    tags: [company],
    // Workday only exposes a relative age like "Posted 3 Days Ago", not a real date
    posted: null,
  }));
}

// ---------------------------------------------------------------------------
// Amazon — amazon.jobs has no officially documented public API. This calls
// the same internal search.json endpoint amazon.jobs's own site uses, which
// works today but isn't a supported contract, so treat it as fragile: it
// could change shape or start requiring different headers without notice.
// ---------------------------------------------------------------------------
async function fetchAmazon() {
  const data = await fetchJson("https://www.amazon.jobs/en/search.json?result_limit=50&sort=recent");
  return (data.jobs || []).map((item) => ({
    id: `amazon-${item.id_icims || item.id}`,
    title: item.title,
    company: "Amazon",
    location: item.normalized_location || item.location || "Unspecified",
    url: item.url_next_step ? `https://www.amazon.jobs${item.url_next_step}` : `https://www.amazon.jobs/en/jobs/${item.id_icims}`,
    source: "Amazon",
    tags: item.job_category ? [item.job_category] : [],
    posted: item.posted_date || null,
  }));
}

async function main() {
  const fetchers = [
    ["RemoteOK", fetchRemoteOK],
    ["Remotive", fetchRemotive],
    ["Arbeitnow", fetchArbeitnow],
    ["Amazon", fetchAmazon],
    ...GREENHOUSE_BOARDS.map((token) => [`Greenhouse:${token}`, () => fetchGreenhouse(token)]),
    ...LEVER_COMPANIES.map((token) => [`Lever:${token}`, () => fetchLever(token)]),
    ...WORKDAY_SITES.map((cfg) => [`Workday:${cfg.company}`, () => fetchWorkday(cfg)]),
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
