#!/bin/sh
set -eu
umask 077

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname "$0")" && pwd)"
VERSION_FILE="${NETNODE_VERSION_FILE:-${SCRIPT_DIR}/VERSION}"
DEFAULT_VERSION="$(sed -n '1p' "$VERSION_FILE" 2>/dev/null || true)"
VERSION="${NETNODE_VERSION:-${DEFAULT_VERSION:-0.3.2}}"
BASE_URL="${PUSHME_BOT_URL:-https://pushme.site}"
STATE_FILE="${NETNODE_STATE_FILE:-./netnode-state.tsv}"
ENV_FILE="${NETNODE_ENV_FILE:-./netnode.env}"
LOCATION="${NETNODE_LOCATION:-default-node}"
PACKET_COUNT="${NETNODE_PACKET_COUNT:-4}"
INTERVAL_MS="${NETNODE_INTERVAL_MS:-60000}"
PUBLISH_MODE="$(printf '%s' "${NETNODE_PUBLISH_MODE:-changes}" | tr '[:upper:]' '[:lower:]')"
RELEASE_CHANNEL="${NETNODE_RELEASE_CHANNEL:-stable}"
IMAGE_REPOSITORY="${NETNODE_IMAGE_REPOSITORY:-ghcr.io/yodakohl/pushme-netnode}"
IMAGE="${NETNODE_IMAGE:-${IMAGE_REPOSITORY}:${RELEASE_CHANNEL}}"
SOURCE_URL="${NETNODE_SOURCE_URL:-}"
DEBOUNCE_COUNT_REQUIRED=2
ONCE=0
DRY_RUN=0
TAB="$(printf '\t')"
DEBUG="${NETNODE_DEBUG:-0}"
CONTROL_PLANE_MAX_TIME="${NETNODE_CONTROL_PLANE_MAX_TIME:-15}"
CONTROL_PLANE_CONNECT_TIMEOUT="${NETNODE_CONTROL_PLANE_CONNECT_TIMEOUT:-5}"
ALLOW_HTTP_BASE_URLS="${NETNODE_ALLOW_HTTP_BASE_URLS:-}"

for arg in "$@"; do
  case "$arg" in
    --once) ONCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
  esac
done

PUSHME_API_KEY="${PUSHME_API_KEY:-}"
BASE_URL="${PUSHME_BOT_URL:-$BASE_URL}"
LOCATION="${NETNODE_LOCATION:-$LOCATION}"

STATE_SCHEMA_VERSION=2

debug_log() {
  [ "$DEBUG" = "1" ] || return 0
  printf '[pushme-netnode debug] %s\n' "$1" >&2
}

set_if_empty() {
  key="$1"
  value="$2"
  case "$key" in
    PUSHME_API_KEY)
      if [ -z "${PUSHME_API_KEY:-}" ]; then
        PUSHME_API_KEY="$value"
      fi
      ;;
    PUSHME_BOT_URL)
      if [ -z "${PUSHME_BOT_URL:-}" ]; then
        PUSHME_BOT_URL="$value"
      fi
      if [ "$BASE_URL" = "https://pushme.site" ] && [ -n "$value" ]; then
        BASE_URL="$value"
      fi
      ;;
    NETNODE_LOCATION)
      if [ -z "${NETNODE_LOCATION:-}" ]; then
        NETNODE_LOCATION="$value"
      fi
      if [ "$LOCATION" = "default-node" ] && [ -n "$value" ]; then
        LOCATION="$value"
      fi
      ;;
  esac
}

load_env_file() {
  [ -f "$ENV_FILE" ] || return 0
  while IFS="$TAB" read -r key value || [ -n "${key:-}" ]; do
    case "$key" in
      PUSHME_API_KEY|PUSHME_BOT_URL|NETNODE_LOCATION)
        set_if_empty "$key" "$value"
        ;;
    esac
  done <"$ENV_FILE"
}

load_env_file
BASE_URL="${PUSHME_BOT_URL:-$BASE_URL}"
LOCATION="${NETNODE_LOCATION:-$LOCATION}"

validate_base_url() {
  case "$BASE_URL" in
    https://*)
      return 0
      ;;
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*)
      return 0
      ;;
  esac

  case ",${ALLOW_HTTP_BASE_URLS}," in
    *,"${BASE_URL}",*)
      return 0
      ;;
  esac

  echo "[pushme-netnode] unsupported PUSHME_BOT_URL: ${BASE_URL}" >&2
  exit 1
}

detect_dns_tool() {
  if command -v getent >/dev/null 2>&1; then
    DNS_PROBE_TOOL="getent"
    return
  fi
  if command -v nslookup >/dev/null 2>&1; then
    DNS_PROBE_TOOL="nslookup"
    return
  fi
  echo "[pushme-netnode] missing DNS probe tool (need getent or nslookup)" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[pushme-netnode] missing required command: $1" >&2
    exit 1
  }
}

validate_base_url
require_command curl
require_command awk
require_command mktemp
require_command ping
require_command date
detect_dns_tool

path_dir() {
  case "$1" in
    */*) printf '%s\n' "${1%/*}" ;;
    *) printf '.\n' ;;
  esac
}

control_plane_curl() {
  curl -fsS \
    --max-time "$CONTROL_PLANE_MAX_TIME" \
    --connect-timeout "$CONTROL_PLANE_CONNECT_TIMEOUT" \
    "$@"
}

read_ms() {
  if [ -r /proc/uptime ]; then
    awk '{ print int($1 * 1000) }' /proc/uptime
    return
  fi
  if date_ms="$(date +%s%3N 2>/dev/null)" && [ -n "$date_ms" ]; then
    printf '%s\n' "$date_ms"
    return
  fi
  printf '%s000\n' "$(date +%s)"
}

sanitize_field() {
  printf '%s' "$1" | tr '\r\n\t|' '    '
}

json_escape() {
  printf '%s' "$1" | awk '
    BEGIN { RS = "\0"; ORS = "" }
    {
      gsub(/\\/, "\\\\");
      gsub(/"/, "\\\"");
      gsub(/\r/, "\\r");
      gsub(/\n/, "\\n");
      print;
    }'
}

json_quote() {
  printf '"%s"' "$(json_escape "$1")"
}

bool_json() {
  if [ "$1" = "1" ] || [ "$1" = "true" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

present_suffix() {
  value="$1"
  suffix="$2"
  if [ -n "$value" ]; then
    printf '%s' "$suffix"
  fi
}

append_csv_unique() {
  list="$1"
  value="$2"
  if [ -z "$value" ]; then
    printf '%s' "$list"
    return
  fi
  case ",$list," in
    *,"$value",*)
      printf '%s' "$list"
      ;;
    *)
      if [ -n "$list" ]; then
        printf '%s,%s' "$list" "$value"
      else
        printf '%s' "$value"
      fi
      ;;
  esac
}

state_init() {
  CONNECTIVITY_LAST_SEVERITY=""
  CONNECTIVITY_LAST_FINGERPRINT=""
  CONNECTIVITY_LAST_PUBLISHED_AT=""
  CONNECTIVITY_PENDING_FINGERPRINT=""
  CONNECTIVITY_PENDING_COUNT="0"
  CONNECTIVITY_PENDING_SEVERITY=""
  PROVIDER_LAST_SEVERITY=""
  PROVIDER_LAST_FINGERPRINT=""
  PROVIDER_LAST_PUBLISHED_AT=""
  PROVIDER_PENDING_FINGERPRINT=""
  PROVIDER_PENDING_COUNT="0"
  PROVIDER_PENDING_SEVERITY=""
}

state_load() {
  state_init
  [ -f "$STATE_FILE" ] || return 0
  while IFS="$TAB" read -r key value || [ -n "${key:-}" ]; do
    case "$key" in
      STATE_LAST_SEVERITY|STATE_CONNECTIVITY_LAST_SEVERITY) CONNECTIVITY_LAST_SEVERITY="$value" ;;
      STATE_LAST_FINGERPRINT|STATE_CONNECTIVITY_LAST_FINGERPRINT) CONNECTIVITY_LAST_FINGERPRINT="$value" ;;
      STATE_LAST_PUBLISHED_AT|STATE_CONNECTIVITY_LAST_PUBLISHED_AT) CONNECTIVITY_LAST_PUBLISHED_AT="$value" ;;
      STATE_PENDING_FINGERPRINT|STATE_CONNECTIVITY_PENDING_FINGERPRINT) CONNECTIVITY_PENDING_FINGERPRINT="$value" ;;
      STATE_PENDING_COUNT|STATE_CONNECTIVITY_PENDING_COUNT) CONNECTIVITY_PENDING_COUNT="$value" ;;
      STATE_PENDING_SEVERITY|STATE_CONNECTIVITY_PENDING_SEVERITY) CONNECTIVITY_PENDING_SEVERITY="$value" ;;
      STATE_PROVIDER_LAST_SEVERITY) PROVIDER_LAST_SEVERITY="$value" ;;
      STATE_PROVIDER_LAST_FINGERPRINT) PROVIDER_LAST_FINGERPRINT="$value" ;;
      STATE_PROVIDER_LAST_PUBLISHED_AT) PROVIDER_LAST_PUBLISHED_AT="$value" ;;
      STATE_PROVIDER_PENDING_FINGERPRINT) PROVIDER_PENDING_FINGERPRINT="$value" ;;
      STATE_PROVIDER_PENDING_COUNT) PROVIDER_PENDING_COUNT="$value" ;;
      STATE_PROVIDER_PENDING_SEVERITY) PROVIDER_PENDING_SEVERITY="$value" ;;
    esac
  done <"$STATE_FILE"
}

state_save() {
  state_dir="$(path_dir "$STATE_FILE")"
  mkdir -p "$state_dir"
  tmp_state="$(mktemp "${state_dir}/.netnode-state.XXXXXX")"
  chmod 600 "$tmp_state"
  {
    printf 'STATE_LAST_SEVERITY%s%s\n' "$TAB" "$CONNECTIVITY_LAST_SEVERITY"
    printf 'STATE_LAST_FINGERPRINT%s%s\n' "$TAB" "$CONNECTIVITY_LAST_FINGERPRINT"
    printf 'STATE_LAST_PUBLISHED_AT%s%s\n' "$TAB" "$CONNECTIVITY_LAST_PUBLISHED_AT"
    printf 'STATE_PENDING_FINGERPRINT%s%s\n' "$TAB" "$CONNECTIVITY_PENDING_FINGERPRINT"
    printf 'STATE_PENDING_COUNT%s%s\n' "$TAB" "$CONNECTIVITY_PENDING_COUNT"
    printf 'STATE_PENDING_SEVERITY%s%s\n' "$TAB" "$CONNECTIVITY_PENDING_SEVERITY"
    printf 'STATE_CONNECTIVITY_LAST_SEVERITY%s%s\n' "$TAB" "$CONNECTIVITY_LAST_SEVERITY"
    printf 'STATE_CONNECTIVITY_LAST_FINGERPRINT%s%s\n' "$TAB" "$CONNECTIVITY_LAST_FINGERPRINT"
    printf 'STATE_CONNECTIVITY_LAST_PUBLISHED_AT%s%s\n' "$TAB" "$CONNECTIVITY_LAST_PUBLISHED_AT"
    printf 'STATE_CONNECTIVITY_PENDING_FINGERPRINT%s%s\n' "$TAB" "$CONNECTIVITY_PENDING_FINGERPRINT"
    printf 'STATE_CONNECTIVITY_PENDING_COUNT%s%s\n' "$TAB" "$CONNECTIVITY_PENDING_COUNT"
    printf 'STATE_CONNECTIVITY_PENDING_SEVERITY%s%s\n' "$TAB" "$CONNECTIVITY_PENDING_SEVERITY"
    printf 'STATE_PROVIDER_LAST_SEVERITY%s%s\n' "$TAB" "$PROVIDER_LAST_SEVERITY"
    printf 'STATE_PROVIDER_LAST_FINGERPRINT%s%s\n' "$TAB" "$PROVIDER_LAST_FINGERPRINT"
    printf 'STATE_PROVIDER_LAST_PUBLISHED_AT%s%s\n' "$TAB" "$PROVIDER_LAST_PUBLISHED_AT"
    printf 'STATE_PROVIDER_PENDING_FINGERPRINT%s%s\n' "$TAB" "$PROVIDER_PENDING_FINGERPRINT"
    printf 'STATE_PROVIDER_PENDING_COUNT%s%s\n' "$TAB" "$PROVIDER_PENDING_COUNT"
    printf 'STATE_PROVIDER_PENDING_SEVERITY%s%s\n' "$TAB" "$PROVIDER_PENDING_SEVERITY"
  } >"$tmp_state"
  mv "$tmp_state" "$STATE_FILE"
}

profile_lines() {
  cat <<'EOF'
cloudflare-resolver|Cloudflare Resolver|resolver|1.1.1.1|https://1.1.1.1/cdn-cgi/trace|one.one.one.one|1|0|1
google-resolver|Google Resolver|resolver|8.8.8.8|https://www.google.com/generate_204|google.com|1|0|1
quad9-resolver|Quad9 Resolver|resolver|9.9.9.9|https://www.quad9.net/|dns.quad9.net|1|0|1
github-web|GitHub Web|web|github.com|https://github.com/robots.txt|github.com|1|0|1
wikipedia-web|Wikipedia Web|web|wikipedia.org|https://www.wikipedia.org/|wikipedia.org|1|0|1
iana-web|IANA Web|web|www.iana.org|https://www.iana.org/|www.iana.org|1|0|1
openai-status-ai|OpenAI Status|ai|status.openai.com|https://status.openai.com/api/v2/status.json|status.openai.com|0|1|1
anthropic-status-ai|Anthropic Status|ai|status.anthropic.com|https://status.anthropic.com/api/v2/status.json|status.anthropic.com|0|1|1
huggingface-ai|Hugging Face|ai|huggingface.co|https://huggingface.co/|huggingface.co|0|0|1
EOF
}

dns_warn_ms() {
  case "$1" in
    resolver) printf '250' ;;
    web) printf '400' ;;
    ai) printf '300' ;;
    *) printf '250' ;;
  esac
}

http_warn_ms() {
  case "$1" in
    resolver) printf '1500' ;;
    web) printf '2600' ;;
    ai) printf '3000' ;;
    *) printf '1200' ;;
  esac
}

http_down_ms() {
  case "$1" in
    resolver) printf '4500' ;;
    web) printf '5500' ;;
    ai) printf '6000' ;;
    *) printf '4000' ;;
  esac
}

packet_warn_pct() {
  case "$1" in
    ai) printf '100' ;;
    *) printf '5' ;;
  esac
}

packet_down_pct() {
  case "$1" in
    ai) printf '100' ;;
    *) printf '60' ;;
  esac
}

measure_dns() {
  host="$1"
  started="$(read_ms)"
  if [ "$DNS_PROBE_TOOL" = "getent" ]; then
    if getent ahostsv4 "$host" >/dev/null 2>&1 || getent hosts "$host" >/dev/null 2>&1; then
      finished="$(read_ms)"
      printf '%s||' "$((finished - started))"
      return
    fi
  elif nslookup "$host" >/dev/null 2>&1; then
    finished="$(read_ms)"
    printf '%s||' "$((finished - started))"
    return
  fi
  printf '|DNS probe failed|'
}

parse_provider_status() {
  awk '
    BEGIN {
      RS = "\0";
      ORS = "";
    }
    {
      indicator = "";
      description = "";
      gsub(/\n/, " ");
      if (match($0, /"indicator"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        chunk = substr($0, RSTART, RLENGTH);
        sub(/^.*"/, "", chunk);
        sub(/"$/, "", chunk);
        indicator = chunk;
      }
      if (match($0, /"description"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        chunk = substr($0, RSTART, RLENGTH);
        sub(/^.*"/, "", chunk);
        sub(/"$/, "", chunk);
        description = chunk;
      }
      printf "%s|%s", indicator, description;
    }
  ' "$1"
}

map_provider_status_severity() {
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    ""|none) printf '' ;;
    minor|maintenance) printf 'degraded' ;;
    major|critical) printf 'down' ;;
    *) printf 'degraded' ;;
  esac
}

parse_curl_metrics() {
  metrics_text="$1"
  METRIC_TIME_TOTAL=""
  METRIC_HTTP_CODE=""
  METRIC_CONTENT_TYPE=""
  METRIC_SIZE_DOWNLOAD=""
  while IFS='=' read -r key value || [ -n "${key:-}" ]; do
    case "$key" in
      time_total) METRIC_TIME_TOTAL="$value" ;;
      http_code) METRIC_HTTP_CODE="$value" ;;
      content_type) METRIC_CONTENT_TYPE="$value" ;;
      size_download) METRIC_SIZE_DOWNLOAD="$value" ;;
    esac
  done <<EOF
$metrics_text
EOF
}

time_total_to_ms() {
  value="${1:-0}"
  awk -v value="$value" '
    BEGIN {
      if (value == "") {
        value = "0";
      }

      split(value, parts, ".");
      seconds = parts[1];
      fraction = (length(parts) > 1 ? parts[2] : "0");

      if (seconds !~ /^[0-9]+$/) {
        seconds = 0;
      }
      if (fraction !~ /^[0-9]+$/) {
        fraction = 0;
      }

      fraction = substr(fraction "000", 1, 3);
      printf "%d\n", (seconds + 0) * 1000 + (fraction + 0);
    }
  '
}

measure_http() {
  url="$1"
  provider_status_enabled="$2"
  body_file=""
  metrics_text=""

  if [ "$provider_status_enabled" = "1" ]; then
    body_file="$(mktemp)"
    if ! metrics_text="$(
      curl -sS -L --max-time 8 -A "pushme-netnode/${VERSION}" \
      -o "$body_file" \
      -w 'time_total=%{time_total}\nhttp_code=%{http_code}\ncontent_type=%{content_type}\nsize_download=%{size_download}\n' \
      "$url" 2>/dev/null
    )"; then
      rm -f "$body_file"
      printf '||||||HTTP probe failed'
      return
    fi
  else
    if metrics_text="$(
      curl -sS -I -L --max-time 8 -A "pushme-netnode/${VERSION}" \
        -o /dev/null \
        -w 'time_total=%{time_total}\nhttp_code=%{http_code}\ncontent_type=%{content_type}\nsize_download=%{size_download}\n' \
        "$url" 2>/dev/null
    )"; then
      parse_curl_metrics "$metrics_text"
      http_code="$METRIC_HTTP_CODE"
      case "${http_code:-0}" in
        403|404|405|429|500|501|502|503|504)
          if ! metrics_text="$(
            curl -sS -L --max-time 8 -A "pushme-netnode/${VERSION}" \
              -o /dev/null \
              -w 'time_total=%{time_total}\nhttp_code=%{http_code}\ncontent_type=%{content_type}\nsize_download=%{size_download}\n' \
              "$url" 2>/dev/null
          )"; then
            rm -f "$body_file"
            printf '||||||HTTP probe failed'
            return
          fi
          ;;
      esac
    else
      if ! metrics_text="$(
        curl -sS -L --max-time 8 -A "pushme-netnode/${VERSION}" \
          -o /dev/null \
          -w 'time_total=%{time_total}\nhttp_code=%{http_code}\ncontent_type=%{content_type}\nsize_download=%{size_download}\n' \
          "$url" 2>/dev/null
      )"; then
        rm -f "$body_file"
        printf '||||||HTTP probe failed'
        return
      fi
    fi
  fi

  parse_curl_metrics "$metrics_text"
  time_total="$METRIC_TIME_TOTAL"
  http_code="$METRIC_HTTP_CODE"
  content_type="$METRIC_CONTENT_TYPE"
  size_download="$METRIC_SIZE_DOWNLOAD"
  latency_ms="$(time_total_to_ms "$time_total")"
  provider_indicator=""
  provider_description=""
  provider_severity=""
  if [ "$provider_status_enabled" = "1" ]; then
    provider_status="$(parse_provider_status "$body_file")"
    IFS='|' read -r provider_indicator provider_description <<EOF
$provider_status
EOF
    provider_severity="$(map_provider_status_severity "$provider_indicator")"
  fi
  if [ "${http_code:-0}" -lt 200 ] || [ "${http_code:-0}" -ge 400 ]; then
    rm -f "$body_file"
    printf '%s|%s|%s|%s|%s|%s|HTTP probe failed with %s' \
      "$latency_ms" "$http_code" "$(sanitize_field "$content_type")" "${size_download%%.*}" \
      "$(sanitize_field "$provider_indicator")" "$(sanitize_field "$provider_description")" "$http_code"
    return
  fi
  rm -f "$body_file"
  printf '%s|%s|%s|%s|%s|%s|' \
    "$latency_ms" "$http_code" "$(sanitize_field "$content_type")" "${size_download%%.*}" \
    "$(sanitize_field "$provider_indicator")" "$(sanitize_field "$provider_description")"
}

measure_ping() {
  host="$1"
  packet_count="$2"
  output="$(ping -n -q -c "$packet_count" "$host" 2>&1 || true)"
  parsed="$(
    printf '%s\n' "$output" | awk '
      /packet loss/ {
        if (match($0, /[0-9.]+% packet loss/)) {
          loss = substr($0, RSTART, RLENGTH);
          sub(/% packet loss$/, "", loss);
        }
      }
      /min\/avg\/max\// || /round-trip min\/avg\/max/ {
        split($0, a, "=");
        metrics = a[2];
        gsub(/^[ \t]+/, "", metrics);
        split(metrics, b, "/");
        min = b[1];
        avg = b[2];
        max = b[3];
        jitter = b[4];
        sub(/[[:space:]]*ms.*/, "", jitter);
      }
      END {
        if (loss != "") {
          printf "%s|%s|%s|%s|%s|", loss, min, avg, max, jitter;
        }
      }
    '
  )"
  if [ -n "$parsed" ]; then
    printf '%s' "$parsed"
  else
    printf '100||||Ping probe failed'
  fi
}

classify_profile() {
  group="$1"
  dns_latency="$2"
  http_latency="$3"
  packet_loss="$4"
  dns_error="$5"
  http_error="$6"
  packet_error="$7"

  dns_warn="$(dns_warn_ms "$group")"
  http_warn="$(http_warn_ms "$group")"
  http_down="$(http_down_ms "$group")"
  packet_warn="$(packet_warn_pct "$group")"
  packet_down="$(packet_down_pct "$group")"

  failure_count=0
  [ -n "$dns_error" ] && failure_count=$((failure_count + 1))
  [ -n "$http_error" ] && failure_count=$((failure_count + 1))
  [ -n "$packet_error" ] && failure_count=$((failure_count + 1))

  if [ "$failure_count" -ge 3 ]; then
    printf 'down'
    return
  fi
  if { [ -n "$packet_loss" ] && [ "${packet_loss%.*}" -ge "$packet_down" ]; } || \
     { [ -n "$http_error" ] && [ -n "$dns_error" ]; } || \
     { [ -n "$packet_loss" ] && [ "${packet_loss%.*}" -ge 30 ] && [ -n "$http_latency" ] && [ "$http_latency" -ge "$http_down" ]; }; then
    printf 'down'
    return
  fi
  if { [ -n "$packet_loss" ] && [ "${packet_loss%.*}" -ge "$packet_warn" ]; } || \
     { [ -n "$dns_latency" ] && [ "$dns_latency" -ge "$dns_warn" ]; } || \
     { [ -n "$http_latency" ] && [ "$http_latency" -ge "$http_warn" ]; } || \
     [ -n "$dns_error" ] || [ -n "$http_error" ] || [ -n "$packet_error" ]; then
    printf 'degraded'
    return
  fi
  printf 'ok'
}

run_probe_cycle() {
  measured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  results_file="$(mktemp)"
  profiles_file="$(mktemp)"
  : >"$results_file"
  profile_lines >"$profiles_file"

  profile_count=0
  impacted_count=0
  down_count=0
  degraded_count=0
  ok_count=0
  resolver_impacted=0
  web_impacted=0
  ai_impacted=0
  resolver_count=0
  web_count=0
  ai_count=0
  resolver_provider_reported=0
  web_provider_reported=0
  ai_provider_reported=0
  provider_profile_count=0
  provider_impacted_count=0
  provider_down_count=0
  provider_degraded_count=0
  provider_ok_count=0
  provider_group_count=0
  total_http_bytes=0
  total_ping_packets=0
  packet_probe_target_count=0
  dns_sum=0
  dns_count=0
  http_sum=0
  http_count=0
  ping_sum=0
  ping_count=0
  jitter_sum=0
  jitter_count=0
  max_packet_loss=0
  impacted_groups=""
  impacted_profiles=""
  provider_groups=""
  provider_impacted_groups=""
  provider_impacted_profiles=""
  connectivity_fingerprint_profiles=""
  provider_fingerprint_profiles=""

  while IFS='|' read -r name label group target_host target_url dns_host packet_probe provider_status_enabled provider_status_affects || [ -n "${name:-}" ]; do
    [ -n "$name" ] || continue
    profile_count=$((profile_count + 1))

    dns_result="$(measure_dns "$dns_host")"
    IFS='|' read -r dns_latency dns_error _dns_unused <<EOF
$dns_result
EOF

    http_result="$(measure_http "$target_url" "$provider_status_enabled")"
    IFS='|' read -r http_latency http_status http_content_type http_response_bytes provider_indicator provider_description http_error <<EOF
$http_result
EOF
    provider_severity="$(map_provider_status_severity "$provider_indicator")"

    if [ "$packet_probe" = "1" ]; then
      packet_probe_target_count=$((packet_probe_target_count + 1))
      ping_result="$(measure_ping "$target_host" "$PACKET_COUNT")"
      IFS='|' read -r packet_loss packet_min packet_avg packet_max packet_jitter packet_error <<EOF
$ping_result
EOF
      packet_packets_sent="$PACKET_COUNT"
    else
      packet_loss=""
      packet_min=""
      packet_avg=""
      packet_max=""
      packet_jitter=""
      packet_error=""
      packet_packets_sent="0"
    fi

    severity="$(classify_profile "$group" "$dns_latency" "$http_latency" "$packet_loss" "$dns_error" "$http_error" "$packet_error" "$provider_severity" "$provider_status_affects")"

    case "$severity" in
      down) down_count=$((down_count + 1)); impacted_count=$((impacted_count + 1)) ;;
      degraded) degraded_count=$((degraded_count + 1)); impacted_count=$((impacted_count + 1)) ;;
      *) ok_count=$((ok_count + 1)) ;;
    esac

    case "$group" in
      resolver)
        resolver_count=$((resolver_count + 1))
        [ "$severity" != "ok" ] && resolver_impacted=$((resolver_impacted + 1))
        [ -n "$provider_severity" ] && resolver_provider_reported=$((resolver_provider_reported + 1))
        ;;
      web)
        web_count=$((web_count + 1))
        [ "$severity" != "ok" ] && web_impacted=$((web_impacted + 1))
        [ -n "$provider_severity" ] && web_provider_reported=$((web_provider_reported + 1))
        ;;
      ai)
        ai_count=$((ai_count + 1))
        [ "$severity" != "ok" ] && ai_impacted=$((ai_impacted + 1))
        [ -n "$provider_severity" ] && ai_provider_reported=$((ai_provider_reported + 1))
        ;;
    esac

    if [ "$provider_status_enabled" = "1" ]; then
      next_provider_groups="$(append_csv_unique "$provider_groups" "$group")"
      if [ "$next_provider_groups" != "$provider_groups" ]; then
        provider_groups="$next_provider_groups"
        provider_group_count=$((provider_group_count + 1))
      fi
      provider_profile_count=$((provider_profile_count + 1))
      case "$provider_severity" in
        down)
          provider_down_count=$((provider_down_count + 1))
          provider_impacted_count=$((provider_impacted_count + 1))
          provider_impacted_groups="$(append_csv_unique "$provider_impacted_groups" "$group")"
          provider_impacted_profiles="${provider_impacted_profiles}${provider_impacted_profiles:+,}${name}"
          ;;
        degraded)
          provider_degraded_count=$((provider_degraded_count + 1))
          provider_impacted_count=$((provider_impacted_count + 1))
          provider_impacted_groups="$(append_csv_unique "$provider_impacted_groups" "$group")"
          provider_impacted_profiles="${provider_impacted_profiles}${provider_impacted_profiles:+,}${name}"
          ;;
        *)
          provider_ok_count=$((provider_ok_count + 1))
          ;;
      esac
      provider_fingerprint_profiles="${provider_fingerprint_profiles}${provider_fingerprint_profiles:+|}${name}:${group}:${provider_severity:-ok}:${provider_indicator:-none}:${http_status:-na}"
    fi

    [ -n "$dns_latency" ] && dns_sum=$((dns_sum + dns_latency)) && dns_count=$((dns_count + 1))
    if [ -n "$http_latency" ]; then
      http_sum=$((http_sum + http_latency))
      http_count=$((http_count + 1))
    fi
    if [ -n "$packet_avg" ]; then
      ping_sum=$((ping_sum + ${packet_avg%.*}))
      ping_count=$((ping_count + 1))
    fi
    if [ -n "$packet_jitter" ]; then
      jitter_sum=$((jitter_sum + ${packet_jitter%.*}))
      jitter_count=$((jitter_count + 1))
    fi
    if [ -n "$packet_loss" ] && [ "${packet_loss%.*}" -gt "$max_packet_loss" ]; then
      max_packet_loss="${packet_loss%.*}"
    fi
    if [ -n "$http_response_bytes" ]; then
      total_http_bytes=$((total_http_bytes + ${http_response_bytes%.*}))
    fi
    total_ping_packets=$((total_ping_packets + packet_packets_sent))

    if [ "$severity" != "ok" ]; then
      impacted_profiles="${impacted_profiles}${impacted_profiles:+,}${name}"
    fi

    connectivity_fingerprint_profiles="${connectivity_fingerprint_profiles}${connectivity_fingerprint_profiles:+|}${name}:${group}:${severity}:${http_status:-na}:$(present_suffix "$dns_error" 'dns!')$(present_suffix "$http_error" 'http!')$(present_suffix "$packet_error" 'ping!')"

    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s\n' \
      "$name" "$(sanitize_field "$label")" "$group" "$severity" \
      "$target_host" "$target_url" "$dns_host" "$packet_probe" \
      "$dns_latency" "$http_latency" "$http_status" "$(sanitize_field "$http_content_type")" "$http_response_bytes" \
      "$packet_loss" "$packet_packets_sent" "$packet_min" "$packet_avg" "$packet_max" "$packet_jitter" \
      "$(sanitize_field "$provider_indicator")" "$(sanitize_field "$provider_description")" "$(sanitize_field "$provider_severity")" \
      "$(sanitize_field "$dns_error")" "$(sanitize_field "$http_error")" "$(sanitize_field "$packet_error")" "$provider_status_affects" \
      >>"$results_file"
  done <"$profiles_file"
  rm -f "$profiles_file"

  if [ "$impacted_count" -eq 0 ]; then
    overall_severity="ok"
    scope="healthy"
    event_type="net.connectivity.ok"
  elif [ "$impacted_count" -eq 1 ]; then
    overall_severity="degraded"
    scope="localized"
    event_type="net.connectivity.degraded"
  elif [ "$impacted_count" -eq "$profile_count" ]; then
    overall_severity="degraded"
    scope="global"
    event_type="net.connectivity.degraded"
  else
    overall_severity="degraded"
    scope="partial"
    event_type="net.connectivity.degraded"
  fi

  if [ "$profile_count" -gt 0 ] && [ "$down_count" -ge $(( (profile_count + 1) / 2 )) ]; then
    overall_severity="down"
    event_type="net.connectivity.down"
  fi

  diagnosis_code="mixed-connectivity-issue"
  diagnosis_label="mixed connectivity issue"
  diagnosis_summary="Some destinations are impacted, but the failure pattern does not map cleanly to one probe group."

  if [ "$impacted_count" -eq 0 ]; then
    diagnosis_code="healthy"
    diagnosis_label="healthy connectivity"
    diagnosis_summary="All configured probe groups are healthy."
  elif [ "$resolver_count" -gt 0 ] && [ "$resolver_impacted" -eq "$resolver_count" ] && [ "$web_impacted" -eq 0 ]; then
    diagnosis_code="resolver-reachability-issue"
    diagnosis_label="resolver reachability issue"
    diagnosis_summary="DNS resolver paths are degraded while general web destinations still look healthy."
  elif [ "$web_count" -gt 0 ] && [ "$web_impacted" -eq "$web_count" ] && [ "$resolver_impacted" -eq 0 ] && [ "$ai_impacted" -eq 0 ]; then
    diagnosis_code="web-egress-issue"
    diagnosis_label="web egress issue"
    diagnosis_summary="Web destinations are degraded while resolver paths still look healthy."
  elif [ "$ai_count" -gt 0 ] && [ "$ai_impacted" -eq "$ai_count" ] && [ "$resolver_impacted" -eq 0 ] && [ "$web_impacted" -eq 0 ]; then
    diagnosis_code="ai-platform-access-issue"
    diagnosis_label="AI platform access issue"
    diagnosis_summary="AI platform endpoints are degraded while generic resolver and web groups still look healthy."
  else
    impacted_group_count=0
    [ "$resolver_impacted" -gt 0 ] && impacted_group_count=$((impacted_group_count + 1))
    [ "$web_impacted" -gt 0 ] && impacted_group_count=$((impacted_group_count + 1))
    [ "$ai_impacted" -gt 0 ] && impacted_group_count=$((impacted_group_count + 1))
    if [ "$impacted_group_count" -ge 2 ]; then
      diagnosis_code="broad-connectivity-issue"
      diagnosis_label="broad connectivity issue"
      diagnosis_summary="Multiple probe groups are impacted, suggesting an upstream or wider network issue."
    elif [ "$scope" = "localized" ]; then
      diagnosis_code="single-destination-anomaly"
      diagnosis_label="single destination anomaly"
      diagnosis_summary="Only one destination is degraded, which usually points to a destination-specific issue rather than a wider local outage."
    fi
  fi

  [ "$resolver_impacted" -gt 0 ] && impacted_groups="${impacted_groups}${impacted_groups:+,}resolver"
  [ "$web_impacted" -gt 0 ] && impacted_groups="${impacted_groups}${impacted_groups:+,}web"
  [ "$ai_impacted" -gt 0 ] && impacted_groups="${impacted_groups}${impacted_groups:+,}ai"

  avg_dns=""
  avg_http=""
  avg_ping=""
  avg_jitter=""
  [ "$dns_count" -gt 0 ] && avg_dns=$((dns_sum / dns_count))
  [ "$http_count" -gt 0 ] && avg_http=$((http_sum / http_count))
  [ "$ping_count" -gt 0 ] && avg_ping=$((ping_sum / ping_count))
  [ "$jitter_count" -gt 0 ] && avg_jitter=$((jitter_sum / jitter_count))

  connectivity_fingerprint="${overall_severity}:${scope}:${diagnosis_code}:${impacted_count}/${profile_count}:${connectivity_fingerprint_profiles}"

  provider_scope="healthy"
  provider_event_type="net.provider.ok"
  provider_diagnosis_code="provider-status-healthy"
  provider_diagnosis_label="provider status healthy"
  provider_diagnosis_summary="Monitored provider status endpoints do not report a current provider-side incident."
  if [ "$provider_impacted_count" -eq 0 ]; then
    provider_overall_severity="ok"
    provider_scope="healthy"
    provider_event_type="net.provider.ok"
  else
    provider_scope="partial"
    if [ "$provider_profile_count" -gt 0 ] && [ "$provider_impacted_count" -eq "$provider_profile_count" ]; then
      provider_scope="global"
    elif [ "$provider_impacted_count" -eq 1 ]; then
      provider_scope="localized"
    fi
    if [ "$provider_down_count" -gt 0 ]; then
      provider_overall_severity="down"
      provider_event_type="net.provider.down"
      if [ "$provider_impacted_count" -eq "$provider_profile_count" ]; then
        provider_diagnosis_code="provider-outage-reported"
        provider_diagnosis_label="provider outage reported"
        provider_diagnosis_summary="All monitored provider status endpoints currently report major or critical provider-side incidents."
      else
        provider_diagnosis_code="partial-provider-outage-reported"
        provider_diagnosis_label="partial provider outage reported"
        provider_diagnosis_summary="At least one monitored provider status endpoint reports a major or critical provider-side incident."
      fi
    else
      provider_overall_severity="degraded"
      provider_event_type="net.provider.degraded"
      provider_diagnosis_code="provider-degradation-reported"
      provider_diagnosis_label="provider degradation reported"
      provider_diagnosis_summary="One or more monitored provider status endpoints report degraded service while direct connectivity probes may still be healthy."
    fi
  fi
  provider_fingerprint="${provider_overall_severity}:${provider_scope}:${provider_diagnosis_code}:${provider_impacted_count}/${provider_profile_count}:${provider_fingerprint_profiles}"

  RESULTS_FILE="$results_file"
  MEASURED_AT="$measured_at"
  AVG_DNS="$avg_dns"
  AVG_HTTP="$avg_http"
  AVG_PING="$avg_ping"
  AVG_JITTER="$avg_jitter"
  MAX_PACKET_LOSS="$max_packet_loss"
  TOTAL_HTTP_BYTES="$total_http_bytes"
  TOTAL_PING_PACKETS="$total_ping_packets"
  PACKET_PROBE_TARGET_COUNT="$packet_probe_target_count"
  RESOLVER_IMPACTED="$resolver_impacted"
  RESOLVER_PROVIDER_REPORTED="$resolver_provider_reported"
  WEB_IMPACTED="$web_impacted"
  WEB_PROVIDER_REPORTED="$web_provider_reported"
  AI_IMPACTED="$ai_impacted"
  AI_PROVIDER_REPORTED="$ai_provider_reported"

  CONNECTIVITY_GROUP_COUNT="3"
  CONNECTIVITY_OVERALL_SEVERITY="$overall_severity"
  CONNECTIVITY_EVENT_TYPE="$event_type"
  CONNECTIVITY_SCOPE="$scope"
  CONNECTIVITY_DIAGNOSIS_CODE="$diagnosis_code"
  CONNECTIVITY_DIAGNOSIS_LABEL="$diagnosis_label"
  CONNECTIVITY_DIAGNOSIS_SUMMARY="$diagnosis_summary"
  CONNECTIVITY_PROFILE_COUNT="$profile_count"
  CONNECTIVITY_IMPACTED_COUNT="$impacted_count"
  CONNECTIVITY_IMPACTED_GROUPS="$impacted_groups"
  CONNECTIVITY_IMPACTED_PROFILES="$impacted_profiles"
  CONNECTIVITY_FINGERPRINT="$connectivity_fingerprint"

  PROVIDER_GROUP_COUNT="$provider_group_count"
  PROVIDER_OVERALL_SEVERITY="$provider_overall_severity"
  PROVIDER_EVENT_TYPE="$provider_event_type"
  PROVIDER_SCOPE="$provider_scope"
  PROVIDER_DIAGNOSIS_CODE="$provider_diagnosis_code"
  PROVIDER_DIAGNOSIS_LABEL="$provider_diagnosis_label"
  PROVIDER_DIAGNOSIS_SUMMARY="$provider_diagnosis_summary"
  PROVIDER_PROFILE_COUNT="$provider_profile_count"
  PROVIDER_IMPACTED_COUNT="$provider_impacted_count"
  PROVIDER_IMPACTED_GROUPS="$provider_impacted_groups"
  PROVIDER_IMPACTED_PROFILES="$provider_impacted_profiles"
  PROVIDER_FINGERPRINT="$provider_fingerprint"
}

should_debounce_connectivity_degraded() {
  [ "$CONNECTIVITY_OVERALL_SEVERITY" = "degraded" ] || return 1
  [ "$MAX_PACKET_LOSS" -gt 0 ] && return 1
  hard_failure=0
  while IFS='|' read -r _ _ _ severity _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ provider_severity dns_error http_error packet_error _; do
    [ "$severity" = "down" ] && hard_failure=1
    [ -n "$dns_error" ] && hard_failure=1
    [ -n "$http_error" ] && hard_failure=1
    [ -n "$packet_error" ] && hard_failure=1
  done <"$RESULTS_FILE"
  [ "$hard_failure" -eq 1 ] && return 1

  impacted_group_count=0
  [ "$RESOLVER_IMPACTED" -gt 0 ] && impacted_group_count=$((impacted_group_count + 1))
  [ "$WEB_IMPACTED" -gt 0 ] && impacted_group_count=$((impacted_group_count + 1))
  [ "$AI_IMPACTED" -gt 0 ] && impacted_group_count=$((impacted_group_count + 1))
  [ "$impacted_group_count" -ge 2 ] && return 1
  [ "$CONNECTIVITY_IMPACTED_COUNT" -ge 4 ] && return 1
  return 0
}

decide_connectivity_publication() {
  CONNECTIVITY_DECISION_PUBLISH=0
  CONNECTIVITY_DECISION_REASON=""

  if [ "$PUBLISH_MODE" = "always" ]; then
    CONNECTIVITY_DECISION_PUBLISH=1
    CONNECTIVITY_DECISION_REASON="publish mode always"
    return
  fi

  if [ -z "$CONNECTIVITY_FINGERPRINT" ] || [ -z "$CONNECTIVITY_OVERALL_SEVERITY" ]; then
    CONNECTIVITY_DECISION_PUBLISH=0
    CONNECTIVITY_DECISION_REASON="missing connectivity fingerprint"
    return
  fi

  if [ "$CONNECTIVITY_LAST_FINGERPRINT" = "$CONNECTIVITY_FINGERPRINT" ]; then
    CONNECTIVITY_DECISION_PUBLISH=0
    CONNECTIVITY_DECISION_REASON="no connectivity state change"
    return
  fi

  if [ "$CONNECTIVITY_OVERALL_SEVERITY" = "ok" ]; then
    if [ -n "$CONNECTIVITY_LAST_SEVERITY" ] && [ "$CONNECTIVITY_LAST_SEVERITY" != "ok" ]; then
      CONNECTIVITY_DECISION_PUBLISH=1
      CONNECTIVITY_DECISION_REASON="published connectivity recovery"
      CONNECTIVITY_EVENT_TYPE="net.connectivity.recovered"
    else
      CONNECTIVITY_DECISION_PUBLISH=0
      CONNECTIVITY_DECISION_REASON="healthy connectivity with no published incident"
    fi
    return
  fi

  if [ "$CONNECTIVITY_OVERALL_SEVERITY" = "down" ] || ! should_debounce_connectivity_degraded; then
    CONNECTIVITY_DECISION_PUBLISH=1
    if [ "$CONNECTIVITY_OVERALL_SEVERITY" = "down" ]; then
      CONNECTIVITY_DECISION_REASON="hard connectivity outage"
    else
      CONNECTIVITY_DECISION_REASON="significant connectivity degradation"
    fi
    return
  fi

  if [ "$CONNECTIVITY_PENDING_FINGERPRINT" = "$CONNECTIVITY_FINGERPRINT" ]; then
    next_pending_count=$((CONNECTIVITY_PENDING_COUNT + 1))
  else
    next_pending_count=1
  fi

  if [ "$next_pending_count" -ge "$DEBOUNCE_COUNT_REQUIRED" ]; then
    CONNECTIVITY_DECISION_PUBLISH=1
    CONNECTIVITY_DECISION_REASON="connectivity degradation persisted for ${next_pending_count} probes"
    return
  fi

  CONNECTIVITY_PENDING_FINGERPRINT="$CONNECTIVITY_FINGERPRINT"
  CONNECTIVITY_PENDING_COUNT="$next_pending_count"
  CONNECTIVITY_PENDING_SEVERITY="$CONNECTIVITY_OVERALL_SEVERITY"
  CONNECTIVITY_DECISION_PUBLISH=0
  if [ "$next_pending_count" -eq 1 ]; then
    CONNECTIVITY_DECISION_REASON="waiting for degraded connectivity confirmation"
  else
    CONNECTIVITY_DECISION_REASON="waiting for degraded connectivity persistence"
  fi
}

decide_provider_publication() {
  PROVIDER_DECISION_PUBLISH=0
  PROVIDER_DECISION_REASON=""

  if [ "$PROVIDER_PROFILE_COUNT" -le 0 ] || [ -z "$PROVIDER_FINGERPRINT" ] || [ -z "$PROVIDER_OVERALL_SEVERITY" ]; then
    PROVIDER_DECISION_PUBLISH=0
    PROVIDER_DECISION_REASON="provider status monitoring unavailable"
    return
  fi

  if [ "$PROVIDER_LAST_FINGERPRINT" = "$PROVIDER_FINGERPRINT" ]; then
    PROVIDER_DECISION_PUBLISH=0
    PROVIDER_DECISION_REASON="no provider state change"
    return
  fi

  if [ "$PROVIDER_OVERALL_SEVERITY" = "ok" ]; then
    if [ -n "$PROVIDER_LAST_SEVERITY" ] && [ "$PROVIDER_LAST_SEVERITY" != "ok" ]; then
      PROVIDER_DECISION_PUBLISH=1
      PROVIDER_DECISION_REASON="published provider recovery"
      PROVIDER_EVENT_TYPE="net.provider.recovered"
    else
      PROVIDER_DECISION_PUBLISH=0
      PROVIDER_DECISION_REASON="healthy provider status with no published incident"
    fi
    return
  fi

  PROVIDER_DECISION_PUBLISH=1
  if [ "$PROVIDER_OVERALL_SEVERITY" = "down" ]; then
    PROVIDER_DECISION_REASON="provider outage reported"
  else
    PROVIDER_DECISION_REASON="provider degradation reported"
  fi
}

select_probe_family() {
  family="$1"
  PROBE_SIGNAL_FAMILY="$family"
  PROBE_RESULTS_FILE="$RESULTS_FILE"
  PROBE_MEASURED_AT="$MEASURED_AT"
  PROBE_AVG_DNS="$AVG_DNS"
  PROBE_AVG_HTTP="$AVG_HTTP"
  PROBE_AVG_PING="$AVG_PING"
  PROBE_AVG_JITTER="$AVG_JITTER"
  PROBE_MAX_PACKET_LOSS="$MAX_PACKET_LOSS"
  PROBE_TOTAL_HTTP_BYTES="$TOTAL_HTTP_BYTES"
  PROBE_TOTAL_PING_PACKETS="$TOTAL_PING_PACKETS"
  PROBE_PACKET_PROBE_TARGET_COUNT="$PACKET_PROBE_TARGET_COUNT"
  PROBE_RESOLVER_PROVIDER_REPORTED="$RESOLVER_PROVIDER_REPORTED"
  PROBE_WEB_PROVIDER_REPORTED="$WEB_PROVIDER_REPORTED"
  PROBE_AI_PROVIDER_REPORTED="$AI_PROVIDER_REPORTED"

  case "$family" in
    provider)
      PROBE_GROUP_COUNT="$PROVIDER_GROUP_COUNT"
      PROBE_OVERALL_SEVERITY="$PROVIDER_OVERALL_SEVERITY"
      PROBE_EVENT_TYPE="$PROVIDER_EVENT_TYPE"
      PROBE_SCOPE="$PROVIDER_SCOPE"
      PROBE_DIAGNOSIS_CODE="$PROVIDER_DIAGNOSIS_CODE"
      PROBE_DIAGNOSIS_LABEL="$PROVIDER_DIAGNOSIS_LABEL"
      PROBE_DIAGNOSIS_SUMMARY="$PROVIDER_DIAGNOSIS_SUMMARY"
      PROBE_PROFILE_COUNT="$PROVIDER_PROFILE_COUNT"
      PROBE_IMPACTED_COUNT="$PROVIDER_IMPACTED_COUNT"
      PROBE_IMPACTED_GROUPS="$PROVIDER_IMPACTED_GROUPS"
      PROBE_IMPACTED_PROFILES="$PROVIDER_IMPACTED_PROFILES"
      PROBE_FINGERPRINT="$PROVIDER_FINGERPRINT"
      PROBE_PREVIOUS_SEVERITY="$PROVIDER_LAST_SEVERITY"
      ;;
    *)
      PROBE_GROUP_COUNT="$CONNECTIVITY_GROUP_COUNT"
      PROBE_OVERALL_SEVERITY="$CONNECTIVITY_OVERALL_SEVERITY"
      PROBE_EVENT_TYPE="$CONNECTIVITY_EVENT_TYPE"
      PROBE_SCOPE="$CONNECTIVITY_SCOPE"
      PROBE_DIAGNOSIS_CODE="$CONNECTIVITY_DIAGNOSIS_CODE"
      PROBE_DIAGNOSIS_LABEL="$CONNECTIVITY_DIAGNOSIS_LABEL"
      PROBE_DIAGNOSIS_SUMMARY="$CONNECTIVITY_DIAGNOSIS_SUMMARY"
      PROBE_PROFILE_COUNT="$CONNECTIVITY_PROFILE_COUNT"
      PROBE_IMPACTED_COUNT="$CONNECTIVITY_IMPACTED_COUNT"
      PROBE_IMPACTED_GROUPS="$CONNECTIVITY_IMPACTED_GROUPS"
      PROBE_IMPACTED_PROFILES="$CONNECTIVITY_IMPACTED_PROFILES"
      PROBE_FINGERPRINT="$CONNECTIVITY_FINGERPRINT"
      PROBE_PREVIOUS_SEVERITY="$CONNECTIVITY_LAST_SEVERITY"
      ;;
  esac
}

build_group_stats_json() {
  group_stats_row() {
    target_group="$1"
    awk -F '|' -v target="$target_group" '
      function append_csv(list, value) {
        return list == "" ? value : list "," value
      }
      BEGIN {
        count = 0;
        impacted = 0;
        down = 0;
        degraded = 0;
        provider_reported = 0;
        dns_sum = 0;
        dns_count = 0;
        http_sum = 0;
        http_count = 0;
        ping_sum = 0;
        ping_count = 0;
        jitter_sum = 0;
        jitter_count = 0;
        max_jitter = "";
        max_loss = 0;
        impacted_profiles = "";
      }
      $3 == target {
        count += 1;

        if ($4 == "down") {
          impacted += 1;
          down += 1;
          impacted_profiles = append_csv(impacted_profiles, $1);
        } else if ($4 == "degraded") {
          impacted += 1;
          degraded += 1;
          impacted_profiles = append_csv(impacted_profiles, $1);
        }

        if ($22 != "") {
          provider_reported += 1;
        }

        if ($9 != "") {
          dns_sum += $9;
          dns_count += 1;
        }
        if ($10 != "") {
          http_sum += $10;
          http_count += 1;
        }
        if ($17 != "") {
          value = int($17 + 0);
          ping_sum += value;
          ping_count += 1;
        }
        if ($19 != "") {
          value = int($19 + 0);
          jitter_sum += value;
          jitter_count += 1;
          if (max_jitter == "" || value > max_jitter) {
            max_jitter = value;
          }
        }
        if ($14 != "") {
          value = int($14 + 0);
          if (value > max_loss) {
            max_loss = value;
          }
        }
      }
      END {
        if (count == 0) {
          exit 1;
        }
        avg_dns = "";
        avg_http = "";
        avg_ping = "";
        avg_jitter = "";
        if (dns_count > 0) {
          avg_dns = int(dns_sum / dns_count);
        }
        if (http_count > 0) {
          avg_http = int(http_sum / http_count);
        }
        if (ping_count > 0) {
          avg_ping = int(ping_sum / ping_count);
        }
        if (jitter_count > 0) {
          avg_jitter = int(jitter_sum / jitter_count);
        }
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s",
          count, impacted, down, degraded, provider_reported,
          avg_dns, avg_http, avg_ping, avg_jitter, max_jitter, max_loss, impacted_profiles;
      }
    ' "$PROBE_RESULTS_FILE"
  }

  printf '['
  first=1
  for group in resolver web ai; do
    stats_row="$(group_stats_row "$group" 2>/dev/null || true)"
    [ -n "$stats_row" ] || continue
    IFS="$TAB" read -r count impacted down degraded provider_reported avg_dns avg_http avg_ping avg_jitter max_jitter max_loss impacted_profiles <<EOF
$stats_row
EOF
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{'
    printf '"group":%s,' "$(json_quote "$group")"
    printf '"profileCount":%s,' "$count"
    printf '"impactedCount":%s,' "$impacted"
    printf '"downCount":%s,' "$down"
    printf '"degradedCount":%s,' "$degraded"
    printf '"providerReportedCount":%s,' "$provider_reported"
    if [ -n "$avg_dns" ]; then printf '"avgDnsLatencyMs":%s,' "$avg_dns"; else printf '"avgDnsLatencyMs":null,'; fi
    if [ -n "$avg_http" ]; then printf '"avgHttpLatencyMs":%s,' "$avg_http"; else printf '"avgHttpLatencyMs":null,'; fi
    if [ -n "$avg_ping" ]; then printf '"avgPingLatencyMs":%s,' "$avg_ping"; else printf '"avgPingLatencyMs":null,'; fi
    if [ -n "$avg_jitter" ]; then printf '"avgJitterMs":%s,' "$avg_jitter"; else printf '"avgJitterMs":null,'; fi
    printf '"maxPacketLossPct":%s,' "${max_loss:-0}"
    if [ -n "$max_jitter" ]; then printf '"maxJitterMs":%s,' "$max_jitter"; else printf '"maxJitterMs":null,'; fi
    printf '"impactedProfiles":%s' "$(json_quote "$impacted_profiles")"
    printf '}'
  done
  printf ']'
}

build_profiles_json() {
  printf '['
  first=1
  while IFS='|' read -r name label group severity target_host target_url dns_host packet_probe dns_latency http_latency http_status http_content_type http_response_bytes packet_loss packet_packets_sent packet_min packet_avg packet_max packet_jitter provider_indicator provider_description provider_severity dns_error http_error packet_error _provider_affects; do
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '{'
    printf '"name":%s,' "$(json_quote "$name")"
    printf '"label":%s,' "$(json_quote "$label")"
    printf '"group":%s,' "$(json_quote "$group")"
    printf '"severity":%s,' "$(json_quote "$severity")"
    printf '"targetHost":%s,' "$(json_quote "$target_host")"
    printf '"targetUrl":%s,' "$(json_quote "$target_url")"
    printf '"dnsHost":%s,' "$(json_quote "$dns_host")"
    printf '"packetProbeEnabled":%s,' "$(bool_json "$packet_probe")"
    [ -n "$dns_latency" ] && printf '"dnsLatencyMs":%s,' "$dns_latency" || printf '"dnsLatencyMs":null,'
    [ -n "$http_latency" ] && printf '"httpLatencyMs":%s,' "$http_latency" || printf '"httpLatencyMs":null,'
    [ -n "$http_status" ] && printf '"httpStatusCode":%s,' "$http_status" || printf '"httpStatusCode":null,'
    printf '"httpContentType":%s,' "$(json_quote "$http_content_type")"
    [ -n "$http_response_bytes" ] && printf '"httpResponseBytes":%s,' "${http_response_bytes%%.*}" || printf '"httpResponseBytes":null,'
    [ -n "$packet_packets_sent" ] && printf '"packetPacketsSent":%s,' "$packet_packets_sent" || printf '"packetPacketsSent":0,'
    [ -n "$packet_loss" ] && printf '"packetLossPct":%s,' "${packet_loss%%.*}" || printf '"packetLossPct":null,'
    [ -n "$packet_min" ] && printf '"packetMinLatencyMs":%s,' "${packet_min%%.*}" || printf '"packetMinLatencyMs":null,'
    [ -n "$packet_avg" ] && printf '"avgPingLatencyMs":%s,' "${packet_avg%%.*}" || printf '"avgPingLatencyMs":null,'
    [ -n "$packet_max" ] && printf '"packetMaxLatencyMs":%s,' "${packet_max%%.*}" || printf '"packetMaxLatencyMs":null,'
    [ -n "$packet_jitter" ] && printf '"packetJitterMs":%s,' "${packet_jitter%%.*}" || printf '"packetJitterMs":null,'
    printf '"providerStatusIndicator":%s,' "$(json_quote "$provider_indicator")"
    printf '"providerStatusDescription":%s,' "$(json_quote "$provider_description")"
    printf '"providerStatusSeverity":%s,' "$(json_quote "$provider_severity")"
    printf '"dnsError":%s,' "$(json_quote "$dns_error")"
    printf '"httpError":%s,' "$(json_quote "$http_error")"
    printf '"packetError":%s' "$(json_quote "$packet_error")"
    printf '}'
  done <"$PROBE_RESULTS_FILE"
  printf ']'
}

build_event_payload() {
  title_severity="$PROBE_OVERALL_SEVERITY"
  case "$PROBE_EVENT_TYPE" in
    net.connectivity.recovered|net.provider.recovered) title_severity="recovered" ;;
  esac

  summary_parts=""
  if [ "$PROBE_SIGNAL_FAMILY" = "provider" ]; then
    if [ "$PROBE_IMPACTED_COUNT" -eq 0 ]; then
      summary_parts="All ${PROBE_PROFILE_COUNT}/${PROBE_PROFILE_COUNT} monitored provider status endpoints are healthy"
    else
      impacted_list=""
      while IFS='|' read -r _name label group severity _target_host _target_url _dns_host _packet_probe _dns_latency _http_latency _http_status _http_content_type _http_response_bytes _packet_loss _packet_packets_sent _packet_min _packet_avg _packet_max _packet_jitter provider_indicator _provider_description provider_severity _dns_error _http_error _packet_error _provider_affects; do
        [ -n "$provider_severity" ] || continue
        impacted_list="${impacted_list}${impacted_list:+, }${label} ${provider_severity}"
      done <"$PROBE_RESULTS_FILE"
      summary_parts="${PROBE_IMPACTED_COUNT}/${PROBE_PROFILE_COUNT} monitored provider status endpoints report incidents: ${impacted_list}"
    fi
  else
    if [ "$PROBE_IMPACTED_COUNT" -eq 0 ]; then
      summary_parts="All ${PROBE_PROFILE_COUNT}/${PROBE_PROFILE_COUNT} probe targets healthy"
    else
      impacted_list=""
      while IFS='|' read -r _name label _group severity _rest; do
        [ "$severity" = "ok" ] && continue
        impacted_list="${impacted_list}${impacted_list:+, }${label} ${severity}"
      done <"$PROBE_RESULTS_FILE"
      summary_parts="${PROBE_IMPACTED_COUNT}/${PROBE_PROFILE_COUNT} targets impacted: ${impacted_list}"
    fi
  fi

  summary_parts="${summary_parts}, diagnosis: ${PROBE_DIAGNOSIS_LABEL}"
  [ -n "$PROBE_IMPACTED_GROUPS" ] && summary_parts="${summary_parts}, ${PROBE_IMPACTED_GROUPS} impacted"
  [ -n "$PROBE_AVG_DNS" ] && summary_parts="${summary_parts}, avg DNS ${PROBE_AVG_DNS} ms"
  [ -n "$PROBE_AVG_HTTP" ] && summary_parts="${summary_parts}, avg HTTP ${PROBE_AVG_HTTP} ms"
  [ -n "$PROBE_AVG_JITTER" ] && summary_parts="${summary_parts}, avg jitter ${PROBE_AVG_JITTER} ms"
  summary_parts="${summary_parts}, max loss ${PROBE_MAX_PACKET_LOSS}%"
  summary_parts="${summary_parts}, HTTP ${PROBE_TOTAL_HTTP_BYTES} B"
  summary_parts="${summary_parts}, ICMP ${PROBE_TOTAL_PING_PACKETS} pkts"

  if [ "$PROBE_SIGNAL_FAMILY" = "provider" ]; then
    body="Location: ${LOCATION}
Signal family: provider
Overall severity: ${PROBE_OVERALL_SEVERITY}
Scope: ${PROBE_SCOPE}
Diagnosis: ${PROBE_DIAGNOSIS_LABEL}
Diagnosis summary: ${PROBE_DIAGNOSIS_SUMMARY}
Impacted provider endpoints: ${PROBE_IMPACTED_COUNT}/${PROBE_PROFILE_COUNT}
Impacted groups: ${PROBE_IMPACTED_GROUPS:-none}
Connectivity impacted targets this cycle: ${CONNECTIVITY_IMPACTED_COUNT}/${CONNECTIVITY_PROFILE_COUNT}
Measured at: ${PROBE_MEASURED_AT}"
  else
    body="Location: ${LOCATION}
Overall severity: ${PROBE_OVERALL_SEVERITY}
Scope: ${PROBE_SCOPE}
Diagnosis: ${PROBE_DIAGNOSIS_LABEL}
Diagnosis summary: ${PROBE_DIAGNOSIS_SUMMARY}
Impacted targets: ${PROBE_IMPACTED_COUNT}/${PROBE_PROFILE_COUNT}
Impacted groups: ${PROBE_IMPACTED_GROUPS:-none}
Measured at: ${PROBE_MEASURED_AT}"
  fi

  group_stats_json="$(build_group_stats_json)"
  profiles_json="$(build_profiles_json)"
  source_url="$SOURCE_URL"
  if [ -z "$source_url" ]; then
    if [ "$PROBE_SIGNAL_FAMILY" = "provider" ]; then
      while IFS='|' read -r _source_name _source_label _source_group _source_severity _source_host candidate_url _source_dns_host _source_packet_probe _source_dns_latency _source_http_latency _source_http_status _source_http_content_type _source_http_response_bytes _source_packet_loss _source_packet_packets_sent _source_packet_min _source_packet_avg _source_packet_max _source_packet_jitter _source_provider_indicator _source_provider_description source_provider_severity _source_dns_error _source_http_error _source_packet_error _source_provider_affects; do
        [ -n "$source_provider_severity" ] || continue
        source_url="$candidate_url"
        break
      done <"$PROBE_RESULTS_FILE"
    fi
    if [ -z "$source_url" ]; then
      IFS='|' read -r _source_name _source_label _source_group _source_severity _source_host source_url _source_rest <"$PROBE_RESULTS_FILE"
    fi
  fi

  metadata=$(
    cat <<EOF
{
  "location": $(json_quote "$LOCATION"),
  "nodeCountryCode": $(json_quote "${NETNODE_COUNTRY_CODE:-}"),
  "nodeCountry": $(json_quote "${NETNODE_COUNTRY:-}"),
  "nodeRegion": $(json_quote "${NETNODE_REGION:-}"),
  "nodeCity": $(json_quote "${NETNODE_CITY:-}"),
  "nodeProvider": $(json_quote "${NETNODE_PROVIDER:-}"),
  "nodeProviderDomain": $(json_quote "${NETNODE_PROVIDER_DOMAIN:-}"),
  "nodeAsn": $( [ -n "${NETNODE_ASN:-}" ] && printf '%s' "${NETNODE_ASN}" || printf 'null' ),
  "nodeNetworkType": $(json_quote "${NETNODE_NETWORK_TYPE:-}"),
  "nodeIdentitySource": "configured",
  "nodeVersion": $(json_quote "$VERSION"),
  "releaseChannel": $(json_quote "$RELEASE_CHANNEL"),
  "image": $(json_quote "$IMAGE"),
  "stateSchemaVersion": ${STATE_SCHEMA_VERSION},
  "signalFamily": $(json_quote "$PROBE_SIGNAL_FAMILY"),
  "packetCount": ${PACKET_COUNT},
  "severity": $(json_quote "$PROBE_OVERALL_SEVERITY"),
  "previousSeverity": $(json_quote "$PROBE_PREVIOUS_SEVERITY"),
  "measuredAt": $(json_quote "$PROBE_MEASURED_AT"),
  "scope": $(json_quote "$PROBE_SCOPE"),
  "diagnosisCode": $(json_quote "$PROBE_DIAGNOSIS_CODE"),
  "diagnosisLabel": $(json_quote "$PROBE_DIAGNOSIS_LABEL"),
  "diagnosisSummary": $(json_quote "$PROBE_DIAGNOSIS_SUMMARY"),
  "groupCount": ${PROBE_GROUP_COUNT},
  "impactedGroupsCsv": $(json_quote "$PROBE_IMPACTED_GROUPS"),
  "profileCount": ${PROBE_PROFILE_COUNT},
  "impactedProfileCount": ${PROBE_IMPACTED_COUNT},
  "impactedProfilesCsv": $(json_quote "$PROBE_IMPACTED_PROFILES"),
  "providerReportedProfileCount": $((PROBE_RESOLVER_PROVIDER_REPORTED + PROBE_WEB_PROVIDER_REPORTED + PROBE_AI_PROVIDER_REPORTED)),
  "avgDnsLatencyMs": $( [ -n "$PROBE_AVG_DNS" ] && printf '%s' "$PROBE_AVG_DNS" || printf 'null' ),
  "avgHttpLatencyMs": $( [ -n "$PROBE_AVG_HTTP" ] && printf '%s' "$PROBE_AVG_HTTP" || printf 'null' ),
  "avgPingLatencyMs": $( [ -n "$PROBE_AVG_PING" ] && printf '%s' "$PROBE_AVG_PING" || printf 'null' ),
  "avgJitterMs": $( [ -n "$PROBE_AVG_JITTER" ] && printf '%s' "$PROBE_AVG_JITTER" || printf 'null' ),
  "maxPacketLossPct": ${PROBE_MAX_PACKET_LOSS},
  "totalHttpResponseBytes": ${PROBE_TOTAL_HTTP_BYTES},
  "totalPingPacketsSent": ${PROBE_TOTAL_PING_PACKETS},
  "dnsProbeCount": ${PROBE_PROFILE_COUNT},
  "httpProbeCount": ${PROBE_PROFILE_COUNT},
  "packetProbeTargetCount": ${PROBE_PACKET_PROBE_TARGET_COUNT},
  "groupStatsJson": $(json_quote "$group_stats_json"),
  "profilesJson": $(json_quote "$profiles_json")
}
EOF
  )

  cat <<EOF
{
  "eventType": $(json_quote "$PROBE_EVENT_TYPE"),
  "topic": $(json_quote "$( [ "$PROBE_SIGNAL_FAMILY" = "provider" ] && printf '%s provider status' "$LOCATION" || printf '%s connectivity' "$LOCATION" )"),
  "title": $(json_quote "$( [ "$PROBE_SIGNAL_FAMILY" = "provider" ] && printf 'Provider status %s at %s' "$title_severity" "$LOCATION" || printf 'Connectivity %s at %s' "$title_severity" "$LOCATION" )"),
  "summary": $(json_quote "$summary_parts"),
  "body": $(json_quote "$body"),
  "sourceUrl": $(json_quote "$source_url"),
  "externalId": $(json_quote "${LOCATION}-${PROBE_EVENT_TYPE}-${PROBE_MEASURED_AT}"),
  "tags": [
    "network",
    $( case "$PROBE_EVENT_TYPE" in net.connectivity.recovered|net.provider.recovered) printf '"recovered"' ;; *) json_quote "$PROBE_OVERALL_SEVERITY" ;; esac )
  ],
  "metadata": $metadata
}
EOF
}

publish_event() {
  payload="$1"
  control_plane_curl \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${PUSHME_API_KEY}" \
    -d "$payload" \
    "${BASE_URL}/api/bot/publish"
}

build_identity_hint_json() {
  printf '{'
  first=1
  append_identity_field() {
    key="$1"
    value="$2"
    [ -n "$value" ] || return 0
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '%s:%s' "$(json_quote "$key")" "$(json_quote "$value")"
  }
  append_identity_number() {
    key="$1"
    value="$2"
    [ -n "$value" ] || return 0
    [ "$first" -eq 1 ] || printf ','
    first=0
    printf '%s:%s' "$(json_quote "$key")" "$value"
  }
  append_identity_field "countryCode" "${NETNODE_COUNTRY_CODE:-}"
  append_identity_field "country" "${NETNODE_COUNTRY:-}"
  append_identity_field "region" "${NETNODE_REGION:-}"
  append_identity_field "city" "${NETNODE_CITY:-}"
  append_identity_field "provider" "${NETNODE_PROVIDER:-}"
  append_identity_number "asn" "${NETNODE_ASN:-}"
  append_identity_field "networkType" "${NETNODE_NETWORK_TYPE:-}"
  printf '}'
}

parse_update_response() {
  printf '%s' "$1" | awk '
    BEGIN {
      update = "false";
      latest = "";
      min = "";
      image = "";
    }
    {
      text = $0;
      if (match(text, /"updateAvailable"[[:space:]]*:[[:space:]]*(true|false)/)) {
        chunk = substr(text, RSTART, RLENGTH);
        sub(/^.*:[[:space:]]*/, "", chunk);
        update = chunk;
      }
      if (match(text, /"latestVersion"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        chunk = substr(text, RSTART, RLENGTH);
        sub(/^.*:[[:space:]]*"/, "", chunk);
        sub(/"$/, "", chunk);
        latest = chunk;
      }
      if (match(text, /"minSupportedVersion"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        chunk = substr(text, RSTART, RLENGTH);
        sub(/^.*:[[:space:]]*"/, "", chunk);
        sub(/"$/, "", chunk);
        min = chunk;
      }
      if (match(text, /"image"[[:space:]]*:[[:space:]]*"[^"]*"/)) {
        chunk = substr(text, RSTART, RLENGTH);
        sub(/^.*:[[:space:]]*"/, "", chunk);
        sub(/"$/, "", chunk);
        image = chunk;
      }
    }
    END {
      printf "%s|%s|%s|%s", update, latest, min, image;
    }
  '
}

log_update_notice() {
  update_available="$1"
  latest_version="$2"
  min_supported_version="$3"
  update_image="$4"
  if [ "${update_available:-false}" = "true" ]; then
    echo "[pushme-netnode] update available: current=${VERSION} latest=${latest_version:-unknown} min_supported=${min_supported_version:-unknown} image=${update_image:-unknown}" >&2
  fi
}

report_startup() {
  [ -n "$PUSHME_API_KEY" ] || return 0
  identity_hint_json="$(build_identity_hint_json)"
  payload=$(
    cat <<EOF
{"nodeVersion":"$(json_escape "$VERSION")","releaseChannel":"$(json_escape "$RELEASE_CHANNEL")","image":"$(json_escape "$IMAGE")","stateSchemaVersion":${STATE_SCHEMA_VERSION},"location":"$(json_escape "$LOCATION")","intervalMs":${INTERVAL_MS},"identityHint":${identity_hint_json}}
EOF
  )
  response="$(control_plane_curl \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${PUSHME_API_KEY}" \
    -d "$payload" \
    "${BASE_URL}/api/bot/netnode/startup" || true)"
  [ -n "$response" ] || return 0
  parsed_startup="$(parse_update_response "$response")"
  IFS='|' read -r update_available latest_version min_supported_version update_image <<EOF
$parsed_startup
EOF
  printf '{\n  "startupReported": true,\n  "nodeVersion": %s,\n  "releaseChannel": %s,\n  "image": %s,\n  "stateSchemaVersion": %s,\n  "updateAvailable": %s,\n  "latestVersion": %s,\n  "minSupportedVersion": %s,\n  "updateImage": %s\n}\n' \
    "$(json_quote "$VERSION")" "$(json_quote "$RELEASE_CHANNEL")" "$(json_quote "$IMAGE")" "$STATE_SCHEMA_VERSION" \
    "${update_available:-false}" "$(json_quote "$latest_version")" "$(json_quote "$min_supported_version")" "$(json_quote "$update_image")"
  log_update_notice "${update_available:-false}" "$latest_version" "$min_supported_version" "$update_image"
}

report_heartbeat() {
  [ -n "$PUSHME_API_KEY" ] || return 0
  identity_hint_json="$(build_identity_hint_json)"
  payload=$(
    cat <<EOF
{"nodeVersion":"$(json_escape "$VERSION")","releaseChannel":"$(json_escape "$RELEASE_CHANNEL")","image":"$(json_escape "$IMAGE")","stateSchemaVersion":${STATE_SCHEMA_VERSION},"location":"$(json_escape "$LOCATION")","intervalMs":${INTERVAL_MS},"identityHint":${identity_hint_json}}
EOF
  )
  response="$(control_plane_curl \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${PUSHME_API_KEY}" \
    -d "$payload" \
    "${BASE_URL}/api/bot/netnode/heartbeat" || true)"
  [ -n "$response" ] || return 0
  parsed_heartbeat="$(parse_update_response "$response")"
  IFS='|' read -r update_available latest_version min_supported_version update_image <<EOF
$parsed_heartbeat
EOF
  log_update_notice "${update_available:-false}" "$latest_version" "$min_supported_version" "$update_image"
}

run_once() {
  debug_log "run_once: loading state"
  state_load
  debug_log "run_once: probing"
  run_probe_cycle
  debug_log "run_once: heartbeat"
  report_heartbeat || true
  debug_log "run_once: deciding publication"
  decide_connectivity_publication
  decide_provider_publication

  published_any=0

  if [ "$CONNECTIVITY_DECISION_PUBLISH" -eq 1 ]; then
    select_probe_family connectivity
    debug_log "run_once: building connectivity payload"
    payload="$(build_event_payload)"
    if [ "$DRY_RUN" -eq 1 ] || [ -z "$PUSHME_API_KEY" ]; then
      debug_log "run_once: dry-run connectivity"
      printf '%s\n' "$payload"
    else
      debug_log "run_once: publishing connectivity event"
      publish_event "$payload"
    fi
    CONNECTIVITY_LAST_SEVERITY="$PROBE_OVERALL_SEVERITY"
    CONNECTIVITY_LAST_FINGERPRINT="$PROBE_FINGERPRINT"
    CONNECTIVITY_LAST_PUBLISHED_AT="$PROBE_MEASURED_AT"
    CONNECTIVITY_PENDING_FINGERPRINT=""
    CONNECTIVITY_PENDING_COUNT="0"
    CONNECTIVITY_PENDING_SEVERITY=""
    published_any=1
  fi

  if [ "$PROVIDER_DECISION_PUBLISH" -eq 1 ]; then
    select_probe_family provider
    debug_log "run_once: building provider payload"
    payload="$(build_event_payload)"
    if [ "$DRY_RUN" -eq 1 ] || [ -z "$PUSHME_API_KEY" ]; then
      debug_log "run_once: dry-run provider"
      printf '%s\n' "$payload"
    else
      debug_log "run_once: publishing provider event"
      publish_event "$payload"
    fi
    PROVIDER_LAST_SEVERITY="$PROBE_OVERALL_SEVERITY"
    PROVIDER_LAST_FINGERPRINT="$PROBE_FINGERPRINT"
    PROVIDER_LAST_PUBLISHED_AT="$PROBE_MEASURED_AT"
    PROVIDER_PENDING_FINGERPRINT=""
    PROVIDER_PENDING_COUNT="0"
    PROVIDER_PENDING_SEVERITY=""
    published_any=1
  fi

  if [ "$published_any" -ne 1 ]; then
    debug_log "run_once: skip path"
    printf '{\n  "connectivity": {"severity": %s, "previousSeverity": %s, "fingerprint": %s, "publicationReason": %s, "skipped": %s, "reason": %s},\n  "provider": {"severity": %s, "previousSeverity": %s, "fingerprint": %s, "publicationReason": %s, "skipped": %s, "reason": %s},\n  "skipped": true\n}\n' \
      "$(json_quote "$CONNECTIVITY_OVERALL_SEVERITY")" "$(json_quote "$CONNECTIVITY_LAST_SEVERITY")" "$(json_quote "$CONNECTIVITY_FINGERPRINT")" "$(json_quote "$CONNECTIVITY_DECISION_REASON")" "$(bool_json 1)" "$(json_quote "$CONNECTIVITY_DECISION_REASON")" \
      "$(json_quote "$PROVIDER_OVERALL_SEVERITY")" "$(json_quote "$PROVIDER_LAST_SEVERITY")" "$(json_quote "$PROVIDER_FINGERPRINT")" "$(json_quote "$PROVIDER_DECISION_REASON")" "$(bool_json 1)" "$(json_quote "$PROVIDER_DECISION_REASON")"
  fi

  state_save
  rm -f "$RESULTS_FILE"
}

sleep_interval() {
  interval_ms="$1"
  seconds=$((interval_ms / 1000))
  [ "$seconds" -le 0 ] && seconds=1
  sleep "$seconds"
}

report_startup || true
run_once

if [ "$ONCE" -eq 1 ]; then
  exit 0
fi

while :; do
  sleep_interval "$INTERVAL_MS"
  run_once || true
done
