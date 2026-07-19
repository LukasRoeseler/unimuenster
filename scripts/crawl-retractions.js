#!/usr/bin/env node
// Downloads the Retraction Watch Database (hosted by Crossref, freely available,
// no auth required) and filters it down to records naming a University of
// Münster institution, powering the "Retractions & Editorial Notices" section
// of the Bibliometric Dashboard.
//
// Source: https://gitlab.com/crossref/retraction-watch-data (retraction_watch.csv,
// ~50-65MB, updated by Crossref/Retraction Watch on weekdays). The Institution and
// Country columns are free text, not normalized against any authority list (unlike
// OpenAlex institution IDs elsewhere in this dashboard), so matching here is
// necessarily fuzzy -- the dashboard callout discloses this rather than presenting
// the result as exact.
//
// Runs on the same weekly schedule as download-data.sh / crawl-publication-costs.js
// (see .github/workflows/refresh-data.yml); the upstream file itself updates far
// more often than that, but a weekly refresh is plenty for a slow-moving indicator
// like retractions.

const fs = require("fs");
const path = require("path");

const CSV_URL = "https://gitlab.com/crossref/retraction-watch-data/-/raw/main/retraction_watch.csv";
const DATA_DIR = path.join(__dirname, "..", "citations-topics", "data");
const OUT_FILE = path.join(DATA_DIR, "retractions-muenster.json");

// Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas, and
// "" as an escaped quote. The upstream file uses semicolons *within* a field to
// separate multiple values (e.g. several institutions or authors on one record),
// which is orthogonal to this comma/quote-based field splitting.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      // Skip a stray \r left from \r\n line endings
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (c === "\r") {
      // handled by the following \n
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function splitMulti(value) {
  return (value || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

// "Münster" collides with the Irish province of Munster, so a bare name match
// isn't enough -- require the country field to plausibly be Germany (or be
// blank, since some records leave it empty even for clearly-German institutions).
function isMuensterRecord(institution, country) {
  const instValues = splitMulti(institution);
  const nameHit = instValues.some((v) => /m[üue]nster/i.test(v));
  if (!nameHit) return false;
  const countryValues = splitMulti(country);
  if (countryValues.length === 0) return true;
  const looksGerman = countryValues.some((v) => /germany|deutschland/i.test(v));
  const looksIrish = countryValues.some((v) => /ireland/i.test(v));
  return looksGerman || !looksIrish;
}

// The Institution column often lists every author's affiliation on one record
// (semicolon-joined), which can run to several hundred characters -- pull out just
// the entry that actually named Münster so the dashboard can show something short.
function extractMuensterInstitution(institution) {
  const hit = splitMulti(institution).find((v) => /m[üue]nster/i.test(v));
  return hit || institution || null;
}

// RetractionNature casing is inconsistent upstream ("Expression of concern" vs.
// "Correction"); normalize to a fixed set of display buckets.
function normalizeNature(raw) {
  const v = (raw || "").trim().toLowerCase();
  if (v.includes("retraction")) return "Retraction";
  if (v.includes("expression of concern")) return "Expression of Concern";
  if (v.includes("correction")) return "Correction";
  if (v.includes("reinstatement")) return "Reinstatement";
  return raw || "Other";
}

async function main() {
  console.log(`Fetching ${CSV_URL} ...`);
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`Failed to fetch Retraction Watch CSV: HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCSV(text);
  const header = rows[0].map((h) => h.trim());
  const col = (name) => header.indexOf(name);

  const idx = {
    title: col("Title"),
    subject: col("Subject"),
    institution: col("Institution"),
    journal: col("Journal"),
    publisher: col("Publisher"),
    country: col("Country"),
    author: col("Author"),
    urls: col("URLS"),
    articleType: col("ArticleType"),
    retractionDate: col("RetractionDate"),
    retractionDOI: col("RetractionDOI"),
    originalPaperDate: col("OriginalPaperDate"),
    originalPaperDOI: col("OriginalPaperDOI"),
    retractionNature: col("RetractionNature"),
    reason: col("Reason"),
    notes: col("Notes"),
  };
  for (const [key, i] of Object.entries(idx)) {
    if (i === -1) console.warn(`Warning: expected column "${key}" not found in CSV header`);
  }

  const matched = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 2) continue;
    const institution = row[idx.institution] || "";
    const country = row[idx.country] || "";
    if (!isMuensterRecord(institution, country)) continue;
    matched.push({
      title: row[idx.title] || null,
      subject: row[idx.subject] || null,
      institution,
      matchedInstitution: extractMuensterInstitution(institution),
      journal: row[idx.journal] || null,
      publisher: row[idx.publisher] || null,
      country,
      author: row[idx.author] || null,
      urls: row[idx.urls] || null,
      articleType: row[idx.articleType] || null,
      retractionDate: row[idx.retractionDate] || null,
      retractionDOI: row[idx.retractionDOI] || null,
      originalPaperDate: row[idx.originalPaperDate] || null,
      originalPaperDOI: row[idx.originalPaperDOI] || null,
      retractionNature: normalizeNature(row[idx.retractionNature]),
      reason: splitMulti(row[idx.reason]),
      notes: row[idx.notes] || null,
    });
  }

  matched.sort((a, b) => new Date(b.retractionDate || 0) - new Date(a.retractionDate || 0));

  const dataset = {
    generatedAt: new Date().toISOString(),
    sourceUrl: "https://gitlab.com/crossref/retraction-watch-data",
    totalRowsScanned: rows.length - 1,
    n: matched.length,
    records: matched,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(dataset));
  console.log(`Scanned ${dataset.totalRowsScanned} Retraction Watch records; ${dataset.n} matched a Münster institution.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
