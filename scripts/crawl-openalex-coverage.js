#!/usr/bin/env node
// Computes OpenAlex coverage for every ULB Münster e-journal and writes the
// results to ejournals/data/openalex.json, which the /ejournals/openalex/ page
// reads. Runs monthly via .github/workflows/ejournals-data.yml alongside the
// DataCite + OpenAlex crawl.
//
// For each journal it reports:
//   registered  — number of DOIs the journal registers with DataCite (from the
//                 monthly crawl cache; capped at 500 per journal).
//   indexed     — number of works OpenAlex indexes for the journal. If OpenAlex
//                 has a dedicated source (venue) for the journal, this is that
//                 source's live works count. Otherwise it is how many of the
//                 journal's registered DOIs OpenAlex has indexed (usually
//                 attributed to the publisher).
//   doiIndexed  — how many of the journal's registered DOIs OpenAlex has indexed
//                 (an independent cross-check of coverage).
//   status      — "indexed" | "partial" | "novenue" | "missing".
//
// This list must stay in sync with the `J` array in ejournals/index.html and
// the JOURNALS list in scripts/crawl-ejournals.js (dp = DataCite DOI suffix
// prefixes; journals with dp:[] register no DOIs).
const JOURNALS = [
  { slug: "aods",             name: "Archive of Orofacial Data Science",                                    issn: "2941-783X", dp: ["aods"] },
  { slug: "byzrev",           name: "The Byzantine Review",                                                 issn: "2700-0524", dp: ["byzrev"] },
  { slug: "fnp",              name: "Free Neuropathology",                                                  issn: "2699-4445", dp: ["fnp", "freeneuropathology"] },
  { slug: "ifgimpulse",       name: "IfG Impulse",                                                          issn: "",          dp: ["ifgimpulse"] },
  { slug: "jcsw",             name: "Jahrbuch für Christliche Sozialwissenschaften",                        issn: "0075-2592", dp: ["jcsw"] },
  { slug: "mittelalterdigi",  name: "Mittelalter Digital",                                                  issn: "2702-9069", dp: ["mittelalterdigi"] },
  { slug: "mfiphs",           name: "Münstersche Fachzeitschrift für islamische und philosophische Studien", issn: "2749-4330", dp: ["mjiphs", "mfiphs"] },
  { slug: "mwsca",            name: "Münster Working Paper Series in Social and Cultural Anthropology",     issn: "",          dp: ["mwsca"] },
  { slug: "nn",               name: "nachbarsprache niederländisch",                                        issn: "",          dp: ["nn"] },
  { slug: "ozean",            name: "Online Zeitschrift zur Antiken Numismatik",                           issn: "2698-3079", dp: ["ozean"] },
  { slug: "paradigma",        name: "Paradigma",                                                            issn: "",          dp: ["paradigma"] },
  { slug: "pop",              name: "POP. Kultur & Kritik",                                                issn: "2192-9408", dp: [] },
  { slug: "replicationresearch", name: "Replication Research",                                             issn: "",          dp: ["replicationresearch"] },
  { slug: "satura",           name: "Satura",                                                              issn: "2700-2640", dp: ["satura"] },
  { slug: "sbi",              name: "Schule. Bildung. Inklusion",                                          issn: "",          dp: [] },
  { slug: "sun",              name: "Soziologie und Nachhaltigkeit",                                       issn: "2364-1282", dp: ["sun"] },
  { slug: "tjo",              name: "Teiresias Journal Online",                                             issn: "",          dp: ["tjo"] },
  { slug: "tso",              name: "Teiresias Supplements Online",                                         issn: "",          dp: ["tso"] },
  { slug: "thrv",             name: "Theologische Revue",                                                   issn: "0040-568X", dp: ["thrv"] },
  { slug: "ZfK",              name: "Zeitschrift für Kulturwissenschaften",                                issn: "1862-8060", dp: [] },
  { slug: "zkr",              name: "Zeitschrift für Kanonisches Recht",                                   issn: "",          dp: ["zkr"] },
  { slug: "zpth",             name: "Zeitschrift für Pastoraltheologie",                                   issn: "0555-9308", dp: ["zpth"] },
  { slug: "zts",              name: "Zeitschrift für Theoretische Soziologie",                             issn: "2195-0695", dp: ["zts"] },
];

// The OpenAlex source (venue) ID for journals that have one, verified against
// the live API by exact title / ISSN. Journals absent here have no dedicated
// OpenAlex venue; their works (if any) sit under the publisher source instead.
const SOURCES = {
  aods:                { id: "S7407078502", name: "Archive of Orofacial Data Science",                     issnL: "2943-5706" },
  byzrev:              { id: "S7407066533", name: "The Byzantine Review",                                  issnL: "2699-4267" },
  fnp:                 { id: "S4393919117", name: "Free Neuropathology",                                   issnL: "2699-4445" },
  ifgimpulse:          { id: "S7407081835", name: "IfG Impulse",                                           issnL: "3052-1270" },
  jcsw:                { id: "S4306514795", name: "Jahrbuch für Christliche Sozialwissenschaften",         issnL: "0075-2584" },
  nn:                  { id: "S7407065988", name: "nachbarsprache niederländisch",                         issnL: "0936-5761" },
  ozean:               { id: "S7407077854", name: "Online Zeitschrift zur Antiken Numismatik",             issnL: "2698-4490" },
  pop:                 { id: "S4210215660", name: "POP Kultur und Kritik",                                  issnL: "2194-6981" },
  replicationresearch: { id: "S7407154776", name: "Replication Research",                                  issnL: "3052-5977" },
  sun:                 { id: "S7407062131", name: "Soziologie und Nachhaltigkeit",                         issnL: "2364-1282" },
  tjo:                 { id: "S7407077427", name: "Teiresias Journal Online",                              issnL: "2751-6946" },
  thrv:                { id: "S4306532607", name: "Theologische Revue",                                    issnL: null },
  ZfK:                 { id: "S4210202375", name: "Zfk - Zeitschrift für Kulturwissenschaften",            issnL: "2197-9103" },
  zkr:                 { id: "S7407079693", name: "Zeitschrift für Kanonisches Recht",                     issnL: "2941-430X" },
  zpth:                { id: "S4306535626", name: "Zeitschrift für Pastoraltheologie (ZPTh)",              issnL: "0555-9308" },
  zts:                 { id: "S4394708440", name: "ZTS Zeitschrift für Theoretische Soziologie",           issnL: "2195-0695" },
};

const fs = require("fs");
const path = require("path");

const CONTACT_EMAIL = "lukas.roeseler@uni-muenster.de";
// Optional OpenAlex API key, shared with the other crawlers (crawl-publication-costs.js,
// download-data.sh). Raising the request budget avoids the per-IP throttling that a
// bare `mailto` is subject to. Set via the OA_API_KEY GitHub Actions secret.
const OA_API_KEY = process.env.OA_API_KEY || null;
const DATA_DIR = path.join(__dirname, "..", "ejournals", "data");
const PUBLICATIONS_FILE = path.join(DATA_DIR, "publications.json");
const OUT_FILE = path.join(DATA_DIR, "openalex.json");
const DETAIL_FILE = path.join(DATA_DIR, "openalex-detail.json");
const OA = "https://api.openalex.org";
const DOI_BATCH = 40;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, ms) {
  const timeout = ms || 20000;
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.ok) {
        const json = await res.json();
        await sleep(250); // gentle throttle between OpenAlex requests
        return json;
      }
      if (res.status === 429 || res.status >= 500) {
        // Rate-limited / transient: back off and retry.
        await sleep(800 * (attempt + 1));
        attempt++;
        if (attempt > 6) throw new Error(`HTTP ${res.status} after retries`);
        continue;
      }
      throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function sourceWorks(sid) {
  const data = await fetchJson(oaUrl(`${OA}/works?filter=primary_location.source.id:${sid}&mailto=${CONTACT_EMAIL}&per-page=1`));
  return data.meta ? data.meta.count : 0;
}

// Append the optional API key so OpenAlex gives this request the account's own
// (higher) request budget instead of the shared per-IP budget.
function oaUrl(url) {
  return OA_API_KEY ? url + "&api_key=" + encodeURIComponent(OA_API_KEY) : url;
}

// Returns the subset of the given DOIs that OpenAlex has indexed. DOIs are
// matched case-insensitively and returned lower-cased. OpenAlex supports OR-ing
// DOIs in one filter (`filter=doi:d1|d2|...`), so we batch to keep requests low.
async function indexedDois(dois) {
  const found = new Set();
  for (let i = 0; i < dois.length; i += DOI_BATCH) {
    const batch = dois.slice(i, i + DOI_BATCH);
    const url = oaUrl(`${OA}/works?filter=doi:${batch.join("|")}&mailto=${CONTACT_EMAIL}&per-page=200&select=doi`);
    const data = await fetchJson(url);
    if (data.results) {
      for (const w of data.results) if (w.doi) found.add(w.doi.toLowerCase());
    }
  }
  return [...found];
}

function statusFor(j, indexed, registered) {
  if (!indexed || indexed <= 0) return "missing";
  if (!SOURCES[j.slug]) return "novenue";
  if (!registered || registered <= 0) return "indexed";
  const cov = indexed / registered;
  return cov >= 0.75 ? "indexed" : "partial";
}

async function main() {
  let pubs = {};
  try {
    pubs = JSON.parse(fs.readFileSync(PUBLICATIONS_FILE, "utf8"));
  } catch (e) {
    console.warn("Could not read publications.json; using registered=0 for all journals.");
  }

  const journals = [];
  const detail = {}; // slug -> [indexed DOIs]
  for (const j of JOURNALS) {
    const registered = (pubs[j.slug] || []).length;
    const dois = (pubs[j.slug] || []).map((p) => p.doi);
    const src = SOURCES[j.slug] || null;

    let indexed;
    let doiSet = [];
    if (src) {
      indexed = await sourceWorks(src.id);
      if (dois.length) doiSet = await indexedDois(dois);
    } else {
      doiSet = dois.length ? await indexedDois(dois) : [];
      indexed = doiSet.length;
    }
    const doiIndexed = doiSet.length;
    detail[j.slug] = doiSet;

    journals.push({
      slug: j.slug,
      name: j.name,
      issn: j.issn,
      status: statusFor(j, indexed, registered),
      indexed,
      registered,
      doiIndexed,
      sourceId: src ? src.id : null,
      sourceName: src ? src.name : null,
      sourceIssnL: src ? src.issnL : null,
    });

    console.log(`${j.slug}: registered=${registered} indexed=${indexed} doiIndexed=${doiIndexed} status=${statusFor(j, indexed, registered)}`);
    await sleep(150);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: "OpenAlex + DataCite (computed by scripts/crawl-openalex-coverage.js)",
    journals,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  const detailOut = {
    generatedAt: out.generatedAt,
    source: "OpenAlex (computed by scripts/crawl-openalex-coverage.js)",
    indexedDois: detail,
  };
  fs.writeFileSync(DETAIL_FILE, JSON.stringify(detailOut, null, 2));
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`Wrote ${DETAIL_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
