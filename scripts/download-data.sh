#!/usr/bin/env bash
# Downloads all OpenAlex endpoints used by the dashboard to citations-topics/data/*.json.
# Each file is written atomically (tmp → final) so a partial run always
# leaves previously-succeeded files intact.
set -euo pipefail

API="https://api.openalex.org"
INST="I22465464"
OUT="citations-topics/data"
mkdir -p "$OUT"

PASS=0
FAIL=0
CURR_YEAR=$(date +%Y)

# ── helpers ──────────────────────────────────────────────────────────────────

download() {
  local name="$1"
  local url="$2"
  local dest="${OUT}/${name}.json"
  local tmp="${dest}.tmp"

  # Append api_key (handles both ?-first and &-append cases)
  if [[ -n "${OA_API_KEY:-}" ]]; then
    if [[ "$url" == *"?"* ]]; then
      url="${url}&api_key=${OA_API_KEY}"
    else
      url="${url}?api_key=${OA_API_KEY}"
    fi
  fi

  printf "  %-48s " "${name}"
  if curl -sf --max-time 30 --retry 2 --retry-delay 5 "${url}" -o "${tmp}"; then
    mv "${tmp}" "${dest}"
    PASS=$((PASS + 1))
    echo "✓"
  else
    rm -f "${tmp}"
    FAIL=$((FAIL + 1))
    echo "✗  (existing file kept)"
  fi
  sleep 0.35   # stay well inside the polite-pool rate limit
}

# ── Section 1 — Overview ─────────────────────────────────────────────────────

echo "▸ Overview"
download "institution" \
  "${API}/institutions/${INST}"

download "works_by_year" \
  "${API}/works?filter=institutions.id:${INST}&group_by=publication_year&per_page=200"

# ── Section 2 — Scholarly Output ─────────────────────────────────────────────

echo "▸ Scholarly Output"
download "works_by_type" \
  "${API}/works?filter=institutions.id:${INST}&group_by=type"

download "venues" \
  "${API}/works?filter=institutions.id:${INST}&group_by=primary_location.source.id&per_page=10&sort=count:desc"

RECENT_CUTOFF=$(( CURR_YEAR - 4 ))
download "recent_works" \
  "${API}/works?filter=institutions.id:${INST},publication_year:>${RECENT_CUTOFF}&sort=cited_by_count:desc&per_page=5&select=id,title,doi,publication_year,cited_by_count,open_access,primary_location,authorships"

# ── Section 3 — Open Access ───────────────────────────────────────────────────

echo "▸ Open Access"
download "oa_all" \
  "${API}/works?filter=institutions.id:${INST}&group_by=open_access.oa_status"

for year in $(seq 2010 $(( CURR_YEAR - 1 ))); do
  download "oa_year_${year}" \
    "${API}/works?filter=institutions.id:${INST},publication_year:${year}&group_by=open_access.oa_status"
done

# ── Section 4 — Topics ────────────────────────────────────────────────────────

echo "▸ Topics"
download "topics" \
  "${API}/works?filter=institutions.id:${INST}&group_by=topics.id&per_page=25&sort=count:desc"

download "domains" \
  "${API}/works?filter=institutions.id:${INST}&group_by=topics.domain.id"

download "fields" \
  "${API}/works?filter=institutions.id:${INST}&group_by=topics.field.id&per_page=30"

download "sdg" \
  "${API}/works?filter=institutions.id:${INST}&group_by=sustainable_development_goals.id&per_page=20"

download "topics_early" \
  "${API}/works?filter=institutions.id:${INST},publication_year:>2018,publication_year:<2022&group_by=topics.id&per_page=200"

download "topics_late" \
  "${API}/works?filter=institutions.id:${INST},publication_year:>2021,publication_year:<2025&group_by=topics.id&per_page=200"

# ── Section 6 — Collaboration ─────────────────────────────────────────────────

echo "▸ Collaboration"
download "collab_countries" \
  "${API}/works?filter=institutions.id:${INST}&group_by=authorships.institutions.country_code&per_page=200"

download "collab_institutions" \
  "${API}/works?filter=institutions.id:${INST}&group_by=authorships.institutions.id&per_page=20&sort=count:desc"

download "collab_intl" \
  "${API}/works?filter=institutions.id:${INST},countries_distinct_count:>1&per_page=1"

# ── Section 6 — Benchmarking ──────────────────────────────────────────────────

echo "▸ Benchmarking (U15)"
# Must match the `U15` array's institution ids in citations-topics/index.html exactly --
# localFilePath() there maps each id to data/bench_${id}.json, so a mismatch here means
# these downloads are wasted and the dashboard silently falls back to 15 live API calls
# per visitor instead of using the committed snapshot.
for id in \
  I22465464 I75951250 I39343248 I135140700 I114090438 \
  I161046081 I74656192 I159176309 I223822909 I180923762 \
  I8204097 I62916508 I100066346 I8087733 I25974101
do
  download "bench_${id}" \
    "${API}/institutions/${id}?select=id,display_name,works_count,cited_by_count,summary_stats"
done

# ── Section 7 — Authors ───────────────────────────────────────────────────────

echo "▸ Authors"
download "authors" \
  "${API}/authors?filter=affiliations.institution.id:${INST}&sort=cited_by_count:desc&per_page=20"

for year in $(seq 2015 $(( CURR_YEAR - 1 ))); do
  download "active_${year}" \
    "${API}/works?filter=institutions.id:${INST},publication_year:${year}&group_by=authorships.author.id&per_page=1"
done

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════"
echo "  ✓ ${PASS} succeeded   ✗ ${FAIL} failed"
echo "════════════════════════════════════════"

# Write a metadata file so the dashboard knows when data was last refreshed
echo "{\"refreshed\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"pass\":${PASS},\"fail\":${FAIL}}" \
  > "${OUT}/meta.json"
