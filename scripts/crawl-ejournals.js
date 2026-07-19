#!/usr/bin/env node
// Crawls DataCite (DOI records) and OpenAlex (citation counts) for every ULB Münster
// e-journal and writes the results as static JSON that the dashboard reads once per
// page load, instead of re-fetching DataCite + OpenAlex live every time someone opens
// the page. Runs monthly via .github/workflows/ejournals-data.yml -- this data changes
// slowly (new issues a few times a year per journal), so a monthly cache is more than
// current enough while cutting the live per-visit fetch entirely.
//
// This list must be kept in sync with the `J` array in ejournals/index.html (dp =
// DataCite DOI suffix prefixes to search; journals with dp:[] have no DOI
// registration and are skipped here, same as the dashboard's own "nd" flag).
const JOURNALS = [
  { slug: "aods", dp: ["aods"] },
  { slug: "byzrev", dp: ["byzrev"] },
  { slug: "fnp", dp: ["fnp", "freeneuropathology"] },
  { slug: "ifgimpulse", dp: ["ifgimpulse"] },
  { slug: "jcsw", dp: ["jcsw"] },
  { slug: "mittelalterdigi", dp: ["mittelalterdigi"] },
  { slug: "mfiphs", dp: ["mjiphs", "mfiphs"] },
  { slug: "mwsca", dp: ["mwsca"] },
  { slug: "nn", dp: ["nn"] },
  { slug: "ozean", dp: ["ozean"] },
  { slug: "paradigma", dp: ["paradigma"] },
  { slug: "pop", dp: [] },
  { slug: "replicationresearch", dp: ["replicationresearch"] },
  { slug: "satura", dp: ["satura"] },
  { slug: "sbi", dp: [] },
  { slug: "sun", dp: ["sun"] },
  { slug: "tjo", dp: ["tjo"] },
  { slug: "tso", dp: ["tso"] },
  { slug: "thrv", dp: ["thrv"] },
  { slug: "ZfK", dp: [] },
  { slug: "zkr", dp: ["zkr"] },
  { slug: "zpth", dp: ["zpth"] },
  { slug: "zts", dp: ["zts"] },
];

const fs = require("fs");
const path = require("path");

const CONTACT_EMAIL = "lukas.roeseler@uni-muenster.de";
const DATA_DIR = path.join(__dirname, "..", "ejournals", "data");
const PUBLICATIONS_FILE = path.join(DATA_DIR, "publications.json");
const META_FILE = path.join(DATA_DIR, "meta.json");
const MAXP = 500;
const DCP = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dk(doi) {
  const m = doi.match(/(\d{4})[-/](\d+)/);
  if (m) return Number(m[1]) * 1e6 + Number(m[2]);
  const m2 = doi.match(/(\d+)$/);
  return m2 ? Number(m2[1]) : 0;
}

async function fetchJson(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || 20000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Mirrors fetchDC() in ejournals/index.html.
async function fetchDC(journal) {
  const all = [];
  const seen = new Set();
  for (const prefix of journal.dp) {
    const q = `prefix:10.17879 AND suffix:${prefix}*`;
    for (let page = 1; all.length < MAXP; page++) {
      const url = `https://api.datacite.org/dois?query=${encodeURIComponent(q)}&page%5Bsize%5D=${DCP}&page%5Bnumber%5D=${page}`;
      let data;
      try {
        data = await fetchJson(url, 20000);
      } catch (err) {
        console.warn(`  DataCite request failed for ${journal.slug} (${prefix}, page ${page}): ${err.message}`);
        break;
      }
      if (!data || !data.data || !data.data.length) break;
      for (const record of data.data) {
        const doi = record.attributes && record.attributes.doi;
        if (doi && !seen.has(doi)) {
          seen.add(doi);
          all.push(record);
        }
      }
      if (data.data.length < DCP) break;
      await sleep(150);
    }
  }
  return all.slice(0, MAXP);
}

// Mirrors parseDC() in ejournals/index.html.
function parseDC(record) {
  const a = record.attributes;
  if (!a || !a.doi) return null;
  const title = a.titles && a.titles.length ? a.titles[0].title || "" : "";
  const auth = [];
  for (const c of a.creators || []) {
    const name = c.familyName ? c.familyName + (c.givenName ? `, ${c.givenName}` : "") : c.name || "";
    let orcid = null;
    for (const ni of c.nameIdentifiers || []) {
      if ((ni.nameIdentifierScheme || "").toUpperCase() === "ORCID") {
        orcid = (ni.nameIdentifier || "").replace(/^https?:\/\/orcid\.org\//, "");
      }
    }
    if (name) auth.push({ n: name, o: orcid });
  }
  const yr = a.publicationYear ? Number(a.publicationYear) : null;
  return { doi: a.doi, title, auth, yr, url: a.url || `https://doi.org/${a.doi}`, key: dk(a.doi), oa: null, cby: [] };
}

// Mirrors oaBatch() in ejournals/index.html.
async function oaBatch(batch) {
  const filter = batch.map((p) => `https://doi.org/${p.doi}`).join("|");
  const url = `https://api.openalex.org/works?filter=doi:${encodeURIComponent(filter)}&per-page=50&select=doi,cited_by_count,counts_by_year&mailto=${encodeURIComponent(CONTACT_EMAIL)}`;
  let data;
  try {
    data = await fetchJson(url, 15000);
  } catch (err) {
    console.warn(`  OpenAlex batch failed: ${err.message}`);
    return;
  }
  if (!data || !data.results) return;
  const byDoi = new Map();
  for (const w of data.results) {
    if (w.doi) byDoi.set(w.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//, ""), w);
  }
  for (const p of batch) {
    const w = byDoi.get(p.doi.toLowerCase());
    if (!w) continue;
    p.oa = w.cited_by_count != null ? w.cited_by_count : 0;
    p.cby = w.counts_by_year || [];
  }
}

async function crawlJournal(journal) {
  const records = await fetchDC(journal);
  if (!records.length) return [];
  const pubs = records.map(parseDC).filter(Boolean);
  for (let i = 0; i < pubs.length; i += 25) {
    await oaBatch(pubs.slice(i, i + 25));
    await sleep(150);
  }
  return pubs;
}

function loadExisting(file) {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return {};
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Start from whatever is already cached, so a single journal's fetch failure this
  // run doesn't blank out its last-known-good data -- only successful fetches
  // overwrite their journal's entry.
  const publications = loadExisting(PUBLICATIONS_FILE);
  let succeeded = 0;
  let failed = 0;

  for (const journal of JOURNALS) {
    if (!journal.dp.length) continue; // no DOI registration, matches the dashboard's "nd" journals
    console.log(`Crawling ${journal.slug}...`);
    try {
      const pubs = await crawlJournal(journal);
      if (pubs.length) {
        publications[journal.slug] = pubs;
        succeeded++;
        console.log(`  -> ${pubs.length} publications`);
      } else {
        console.warn(`  -> no records found; keeping previous cache entry, if any`);
      }
    } catch (err) {
      failed++;
      console.error(`  -> failed: ${err.message}; keeping previous cache entry, if any`);
    }
    await sleep(200);
  }

  fs.writeFileSync(PUBLICATIONS_FILE, JSON.stringify(publications));

  const totalPublications = Object.values(publications).reduce((s, arr) => s + arr.length, 0);
  const meta = {
    generatedAt: new Date().toISOString(),
    journalsSucceeded: succeeded,
    journalsFailed: failed,
    totalPublications,
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));

  console.log(`Done: ${succeeded} journals updated, ${failed} failed, ${totalPublications} total publications cached.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
