#!/usr/bin/env bash
# Downloads all OpenAlex endpoints used by the dashboard to data/*.json.
# Each file is written atomically (tmp → final) so a partial run always
# leaves previously-succeeded files intact.
set -euo pipefail

API="https://api.openalex.org"
INST="I22465464"
OUT="data"
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

# ── Section 5 — Faculty profiles (field-level proxy) ──────────────────────────
# Each faculty maps to one or more OpenAlex field IDs. We download yearly output,
# OA status and leading topics per faculty. Faculties that share a field set
# produce identical data (a known OpenAlex limitation).

echo "▸ Faculties"
declare -A FAC_FIELDS=(
  [FB1]="12" [FB2]="12" [FB3]="33" [FB4]="20|14" [FB5]="27|13|24"
  [FB6]="33" [FB7]="32" [FB8]="12" [FB9]="12" [FB10]="26|17"
  [FB11]="31" [FB12]="16|30" [FB13]="11|13" [FB14]="19|23" [FB15]="12"
)
for code in FB1 FB2 FB3 FB4 FB5 FB6 FB7 FB8 FB9 FB10 FB11 FB12 FB13 FB14 FB15; do
  # Build topics.field.id filter: prefix each numeric id with the OpenAlex URL
  raw="${FAC_FIELDS[$code]}"
  fieldfilter=""
  IFS='|' read -ra nums <<< "$raw"
  for n in "${nums[@]}"; do
    seg="https://openalex.org/fields/${n}"
    fieldfilter="${fieldfilter:+${fieldfilter}|}${seg}"
  done
  facfilter="institutions.id:${INST},topics.field.id:${fieldfilter}"
  download "faculty_${code}_year" \
    "${API}/works?filter=${facfilter}&group_by=publication_year&per_page=200"
  download "faculty_${code}_oa" \
    "${API}/works?filter=${facfilter}&group_by=open_access.oa_status"
  download "faculty_${code}_topics" \
    "${API}/works?filter=${facfilter}&group_by=topics.id&per_page=10&sort=count:desc"
done

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
for id in \
  I22465464 I1292875679 I45335783 I112057170 I55449684 \
  I16951967 I1278002445 I202697675 I14961990 I55249678 \
  I43489663 I51556381 I179430786 I74977 I66743132
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
