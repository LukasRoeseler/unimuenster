#!/usr/bin/env node
// Crawls OpenAlex for every work affiliated with the University of Munster
// (same institution, I22465464, that download-data.sh already queries) and
// estimates each work's APC cost, powering the "Publication Costs" section of
// the Citations and Topics dashboard.
//
// This used to be a second, independent crawler (in a different repo) that
// separately hit OpenAlex for the same institution's works. It now runs from
// the same workflow as download-data.sh instead, so there is exactly one
// scheduled trigger touching OpenAlex for this institution, not two.
//
// OpenAlex meters free usage at roughly $1/day per contact email, resetting at
// midnight UTC, and a university's full output can span well over one hundred
// thousand works -- far more than one day's budget can fetch. Progress is
// checkpointed to citations-topics/data/publication-costs-progress.json after every page, so a
// run that gets rate-limited (or hits its own conservative per-run request cap)
// picks up exactly where it left off next time.

const fs = require("fs");
const path = require("path");

const INST_ID = "I22465464";
// Optional: shared with download-data.sh. See openalex.org/pricing for current
// premium/higher-budget options. Safe to leave unset.
const OA_API_KEY = process.env.OA_API_KEY || null;
const DATA_DIR = path.join(__dirname, "..", "citations-topics", "data");
const WORKS_FILE = path.join(DATA_DIR, "publication-costs-works.jsonl");
const PROGRESS_FILE = path.join(DATA_DIR, "publication-costs-progress.json");
const DATASET_FILE = path.join(DATA_DIR, "publication-costs-dataset.json");
const PER_PAGE = 200;
const MAX_REQUESTS_PER_RUN = Number(process.env.MAX_REQUESTS_PER_RUN || 300);
const REQUEST_GAP_MS = 110;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
  }
  return { cursor: "*", fetchedCount: 0, totalCount: null, done: false, backlogCompletedAt: null, lastRunAt: null, runs: 0 };
}

function saveProgress(progress) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function appendWorks(works) {
  if (!works.length) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(WORKS_FILE, works.map((w) => JSON.stringify(w)).join("\n") + "\n");
}

function filterQuery(sinceDate) {
  const parts = [`institutions.id:${INST_ID}`];
  if (sinceDate) parts.push(`from_created_date:${sinceDate}`);
  return parts.join(",");
}

async function fetchPage(filter, cursor) {
  let url = `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per_page=${PER_PAGE}&cursor=${encodeURIComponent(cursor)}`;
  if (OA_API_KEY) url += `&api_key=${encodeURIComponent(OA_API_KEY)}`;
  const res = await fetch(url);
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const retryAfter = Number(res.headers.get("retry-after") || body.retryAfter || 0);
    throw Object.assign(new Error(body.message || "OpenAlex budget exhausted for today"), { retryAfter, budgetExhausted: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAlex request failed: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

// Same cost-priority logic used by the Publication Cost Calculator and the old
// Output report: a trusted paid-APC record always wins; preprints and diamond
// OA are free; gold/hybrid fall back to the journal's list price when no paid
// record exists; green/bronze/closed/unknown carry no APC paid by this route.
function estimateCost(work) {
  const apcPaid = work.apc_paid && typeof work.apc_paid.value_usd === "number" ? work.apc_paid.value_usd : null;
  if (apcPaid != null) return { cost: apcPaid, source: "openalex_apc_paid" };
  if (work.type === "preprint") return { cost: 0, source: "preprint_server" };
  const oaStatus = work.open_access && work.open_access.oa_status;
  if (oaStatus === "diamond") return { cost: 0, source: "openalex_diamond" };
  if (oaStatus === "gold" || oaStatus === "hybrid") {
    const apcList = work.apc_list && typeof work.apc_list.value_usd === "number" ? work.apc_list.value_usd : null;
    if (apcList != null) return { cost: apcList, source: "openalex_apc_list" };
    return { cost: null, source: "no_apc_data" };
  }
  return { cost: 0, source: oaStatus ? `oa_status_${oaStatus}` : "unknown" };
}

function firstAuthorIsMuenster(work) {
  const authorships = work.authorships || [];
  const first = authorships.find((a) => a.author_position === "first");
  if (!first) return false;
  return (first.institutions || []).some((inst) => inst.id === `https://openalex.org/${INST_ID}`);
}

function simplifyWork(work) {
  const { cost, source } = estimateCost(work);
  const primarySource = work.primary_location && work.primary_location.source;
  const oaStatus = work.type === "preprint" ? "preprint" : work.open_access && work.open_access.oa_status;
  return {
    id: work.id,
    doi: work.doi,
    title: work.title,
    publication_year: work.publication_year,
    type: work.type,
    oa_status: oaStatus,
    has_pdf_proxy: oaStatus === "preprint" ? true : !!(work.open_access && work.open_access.is_oa),
    cost_usd: cost,
    cost_source: source,
    cited_by_count: work.cited_by_count,
    is_retracted: !!work.is_retracted,
    journal: primarySource && primarySource.display_name,
    publisher: (primarySource && primarySource.host_organization_name) || null,
    mean_citedness: primarySource && primarySource.summary_stats && primarySource.summary_stats["2yr_mean_citedness"],
    field: work.primary_topic && work.primary_topic.field && work.primary_topic.field.display_name,
    is_first_author_muenster: firstAuthorIsMuenster(work),
  };
}

async function crawlBacklog(progress) {
  let requests = 0;
  let cursor = progress.cursor || "*";
  let fetchedThisRun = 0;
  while (requests < MAX_REQUESTS_PER_RUN) {
    let page;
    try {
      page = await fetchPage(filterQuery(), cursor);
    } catch (err) {
      if (err.budgetExhausted) {
        console.log(`Stopping backlog crawl: ${err.message} (retry after ${err.retryAfter}s). Progress saved; the next scheduled run resumes here.`);
        break;
      }
      throw err;
    }
    requests++;
    const works = (page.results || []).map(simplifyWork);
    appendWorks(works);
    fetchedThisRun += works.length;
    progress.fetchedCount += works.length;
    progress.totalCount = page.meta ? page.meta.count : progress.totalCount;
    const nextCursor = page.meta && page.meta.next_cursor;
    if (!nextCursor || works.length === 0) {
      progress.done = true;
      progress.cursor = null;
      progress.backlogCompletedAt = new Date().toISOString();
      break;
    }
    cursor = nextCursor;
    progress.cursor = nextCursor;
    saveProgress(progress);
    await sleep(REQUEST_GAP_MS);
  }
  return fetchedThisRun;
}

async function crawlDelta(progress) {
  const since = (progress.lastRunAt || progress.backlogCompletedAt).slice(0, 10);
  let requests = 0;
  let cursor = "*";
  let fetchedThisRun = 0;
  while (requests < MAX_REQUESTS_PER_RUN) {
    let page;
    try {
      page = await fetchPage(filterQuery(since), cursor);
    } catch (err) {
      if (err.budgetExhausted) {
        console.log(`Stopping delta pass: ${err.message} (retry after ${err.retryAfter}s). Will retry on the next scheduled run.`);
        break;
      }
      throw err;
    }
    requests++;
    const works = (page.results || []).map(simplifyWork);
    appendWorks(works);
    fetchedThisRun += works.length;
    const nextCursor = page.meta && page.meta.next_cursor;
    if (!nextCursor || works.length === 0) break;
    cursor = nextCursor;
    await sleep(REQUEST_GAP_MS);
  }
  return fetchedThisRun;
}

function buildDataset() {
  if (!fs.existsSync(WORKS_FILE)) return { count: 0 };
  const lines = fs.readFileSync(WORKS_FILE, "utf8").trim().split("\n").filter(Boolean);
  const byId = new Map();
  for (const line of lines) {
    try {
      const w = JSON.parse(line);
      if (w.id) byId.set(w.id, w);
    } catch (err) {
      // skip a corrupt checkpoint line rather than aborting the whole build
    }
  }
  const works = Array.from(byId.values());

  const publisherDict = [];
  const publisherIndex = new Map();
  const fieldDict = [];
  const fieldIndex = new Map();
  const internId = (dict, index, value) => {
    const key = value || "";
    if (!index.has(key)) {
      index.set(key, dict.length);
      dict.push(key);
    }
    return index.get(key);
  };

  const dataset = {
    generatedAt: new Date().toISOString(),
    n: works.length,
    publisherDict,
    fieldDict,
    id: [], doi: [], title: [], year: [], oa: [], hasPdf: [],
    cost: [], citations: [], meanCitedness: [], retracted: [], publisher: [], field: [],
    firstAuthorMuenster: [],
  };
  for (const w of works) {
    dataset.id.push(w.id);
    dataset.doi.push(w.doi || null);
    dataset.title.push(w.title || null);
    dataset.year.push(w.publication_year || null);
    dataset.oa.push(w.oa_status || "unknown");
    dataset.hasPdf.push(!!w.has_pdf_proxy);
    dataset.cost.push(typeof w.cost_usd === "number" ? w.cost_usd : null);
    dataset.citations.push(typeof w.cited_by_count === "number" ? w.cited_by_count : 0);
    dataset.meanCitedness.push(typeof w.mean_citedness === "number" ? w.mean_citedness : null);
    dataset.retracted.push(!!w.is_retracted);
    dataset.publisher.push(internId(publisherDict, publisherIndex, w.publisher));
    dataset.field.push(internId(fieldDict, fieldIndex, w.field));
    dataset.firstAuthorMuenster.push(!!w.is_first_author_muenster);
  }
  fs.writeFileSync(DATASET_FILE, JSON.stringify(dataset));
  return { count: works.length };
}

async function main() {
  const progress = loadProgress();
  let fetchedThisRun = 0;
  let runError = null;
  try {
    fetchedThisRun = progress.done ? await crawlDelta(progress) : await crawlBacklog(progress);
  } catch (err) {
    runError = err;
    console.error("Crawl run hit an unexpected error; saving whatever was fetched before it failed.");
    console.error(err);
  }

  progress.lastRunAt = new Date().toISOString();
  progress.runs = (progress.runs || 0) + 1;
  saveProgress(progress);

  const { count } = buildDataset();
  console.log(
    `Fetched ${fetchedThisRun} work record${fetchedThisRun === 1 ? "" : "s"} this run. ` +
      `Deduplicated dataset now holds ${count} works` +
      (progress.totalCount ? ` (OpenAlex reports ~${progress.totalCount} total matches).` : ".")
  );
  if (runError) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
