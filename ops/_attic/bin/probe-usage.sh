#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

usage() {
  cat <<'EOF'
Usage:
  probe-usage.sh [provider] [mode] [format]

Providers:
  all       Probe every supported provider (default)
  codex     Probe Codex
  claude    Probe Claude Code
  gemini    Probe Gemini

Modes:
  local     Local files/CLI only (default)
  live      Include live network requests when possible

Formats:
  jsonl     Print one JSON object per line (default)
  report    Print a human-readable report
  normalized  Print one normalized JSON document for Shipctl

Examples:
  ops/_attic/bin/probe-usage.sh
  ops/_attic/bin/probe-usage.sh codex local
  ops/_attic/bin/probe-usage.sh all live
  ops/_attic/bin/probe-usage.sh all live report
  ops/_attic/bin/probe-usage.sh all live normalized

Notes:
  - The script prints compact JSON objects, one per probe result.
  - Live mode may fail if auth is expired or the network is unavailable.
  - jq is required. sqlite3 is required for Codex local probes.
EOF
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "{\"provider\":\"core\",\"source\":\"preflight\",\"ok\":false,\"error\":\"missing command: $cmd\"}"
    exit 1
  fi
}

json_string() {
  jq -Rn --arg v "$1" '$v'
}

file_exists_json() {
  local path="$1"
  if [[ -e "$path" ]]; then
    echo "true"
  else
    echo "false"
  fi
}

print_result() {
  local provider="$1"
  local source="$2"
  local ok="$3"
  local payload="$4"
  jq -cn \
    --arg provider "$provider" \
    --arg source "$source" \
    --argjson ok "$ok" \
    --argjson payload "$payload" \
    '{provider: $provider, source: $source, ok: $ok} + $payload'
}

human_duration() {
  local total="$1"
  if [[ -z "$total" || "$total" == "null" ]]; then
    printf "unknown"
    return
  fi

  local days=$(( total / 86400 ))
  local hours=$(( (total % 86400) / 3600 ))
  local mins=$(( (total % 3600) / 60 ))

  if (( days > 0 )); then
    printf "%dd %dh %dm" "$days" "$hours" "$mins"
  elif (( hours > 0 )); then
    printf "%dh %dm" "$hours" "$mins"
  else
    printf "%dm" "$mins"
  fi
}

human_until_iso() {
  local ts="$1"
  if [[ -z "$ts" || "$ts" == "null" ]]; then
    printf "unknown"
    return
  fi

  TARGET_TS="$ts" python3 - <<'PY'
from datetime import datetime, timezone
import os

target = os.environ.get("TARGET_TS", "")
try:
    dt = datetime.fromisoformat(target.replace("Z", "+00:00"))
except Exception:
    print("unknown")
    raise SystemExit(0)

now = datetime.now(timezone.utc)
delta = int((dt - now).total_seconds())
if delta < 0:
    delta = 0

days = delta // 86400
hours = (delta % 86400) // 3600
mins = (delta % 3600) // 60

if days > 0:
    print(f"{days}d {hours}h {mins}m")
elif hours > 0:
    print(f"{hours}h {mins}m")
else:
    print(f"{mins}m")
PY
}

calc_pace_label() {
  local used_percent="$1"
  local elapsed_seconds="$2"
  local window_seconds="$3"

  if [[ -z "$used_percent" || -z "$elapsed_seconds" || -z "$window_seconds" ]]; then
    printf "unknown"
    return
  fi

  if (( window_seconds <= 0 || elapsed_seconds <= 0 )); then
    printf "unknown"
    return
  fi

  local expected
  expected="$(awk -v e="$elapsed_seconds" -v w="$window_seconds" 'BEGIN { printf "%.2f", (e / w) * 100 }')"
  local ratio
  ratio="$(awk -v u="$used_percent" -v x="$expected" 'BEGIN { if (x <= 0) { print 0 } else { printf "%.2f", u / x } }')"

  awk -v r="$ratio" 'BEGIN {
    if (r <= 0) {
      print "unknown";
    } else if (r < 0.8) {
      print "below steady pace";
    } else if (r <= 1.2) {
      print "near steady pace";
    } else {
      print "above steady pace";
    }
  }'
}

render_report() {
  local jsonl_file="$1"

  REPORT_FILE="$jsonl_file" bash <<'EOF'
set -euo pipefail

human_duration() {
  local total="$1"
  if [[ -z "$total" || "$total" == "null" ]]; then
    printf "unknown"
    return
  fi

  local days=$(( total / 86400 ))
  local hours=$(( (total % 86400) / 3600 ))
  local mins=$(( (total % 3600) / 60 ))

  if (( days > 0 )); then
    printf "%dd %dh %dm" "$days" "$hours" "$mins"
  elif (( hours > 0 )); then
    printf "%dh %dm" "$hours" "$mins"
  else
    printf "%dm" "$mins"
  fi
}

human_until_iso() {
  local ts="$1"
  if [[ -z "$ts" || "$ts" == "null" ]]; then
    printf "unknown"
    return
  fi

  TARGET_TS="$ts" python3 - <<'PY'
from datetime import datetime, timezone
import os

target = os.environ.get("TARGET_TS", "")
try:
    dt = datetime.fromisoformat(target.replace("Z", "+00:00"))
except Exception:
    print("unknown")
    raise SystemExit(0)

now = datetime.now(timezone.utc)
delta = int((dt - now).total_seconds())
if delta < 0:
    delta = 0

days = delta // 86400
hours = (delta % 86400) // 3600
mins = (delta % 3600) // 60

if days > 0:
    print(f"{days}d {hours}h {mins}m")
elif hours > 0:
    print(f"{hours}h {mins}m")
else:
    print(f"{mins}m")
PY
}

calc_pace_label() {
  local used_percent="$1"
  local elapsed_seconds="$2"
  local window_seconds="$3"

  if [[ -z "$used_percent" || -z "$elapsed_seconds" || -z "$window_seconds" ]]; then
    printf "unknown"
    return
  fi

  if (( window_seconds <= 0 || elapsed_seconds <= 0 )); then
    printf "unknown"
    return
  fi

  local expected
  expected="$(awk -v e="$elapsed_seconds" -v w="$window_seconds" 'BEGIN { printf "%.2f", (e / w) * 100 }')"
  local ratio
  ratio="$(awk -v u="$used_percent" -v x="$expected" 'BEGIN { if (x <= 0) { print 0 } else { printf "%.2f", u / x } }')"

  awk -v r="$ratio" 'BEGIN {
    if (r <= 0) {
      print "unknown";
    } else if (r < 0.8) {
      print "below steady pace";
    } else if (r <= 1.2) {
      print "near steady pace";
    } else {
      print "above steady pace";
    }
  }'
}

RESULTS=()
while IFS= read -r line; do
  RESULTS+=("$line")
done < <(jq -c '.' "$REPORT_FILE")

find_result() {
  local provider="$1"
  local source="$2"
  local line
  for line in "${RESULTS[@]}"; do
    if jq -e --arg provider "$provider" --arg source "$source" '.provider == $provider and .source == $source' >/dev/null <<<"$line"; then
      printf '%s\n' "$line"
      return 0
    fi
  done
  return 1
}

echo "Usage Probe Report"
echo

codex_live="$(find_result codex live-api || true)"
codex_local="$(find_result codex local-db || true)"
claude_live="$(find_result claude live-api || true)"
claude_local="$(find_result claude local-cli || true)"
gemini_local="$(find_result gemini local-json || true)"

echo "Codex"
if [[ -n "$codex_live" ]] && jq -e '.ok and .rate_limit.primary_window and .rate_limit.secondary_window' >/dev/null <<<"$codex_live"; then
  p_used="$(jq -r '.rate_limit.primary_window.used_percent' <<<"$codex_live")"
  p_window="$(jq -r '.rate_limit.primary_window.limit_window_seconds' <<<"$codex_live")"
  p_reset="$(jq -r '.rate_limit.primary_window.reset_after_seconds' <<<"$codex_live")"
  s_used="$(jq -r '.rate_limit.secondary_window.used_percent' <<<"$codex_live")"
  s_window="$(jq -r '.rate_limit.secondary_window.limit_window_seconds' <<<"$codex_live")"
  s_reset="$(jq -r '.rate_limit.secondary_window.reset_after_seconds' <<<"$codex_live")"
  p_remaining=$((100 - p_used))
  s_remaining=$((100 - s_used))
  p_elapsed=$((p_window - p_reset))
  s_elapsed=$((s_window - s_reset))
  echo "  Provider usage"
  echo "    5h window: ${p_used}% used, ${p_remaining}% remaining, resets in $(human_duration "$p_reset"), pace $(calc_pace_label "$p_used" "$p_elapsed" "$p_window")"
  echo "    7d window: ${s_used}% used, ${s_remaining}% remaining, resets in $(human_duration "$s_reset"), pace $(calc_pace_label "$s_used" "$s_elapsed" "$s_window")"
  echo "    Plan: $(jq -r '.plan_type // "unknown"' <<<"$codex_live")"
else
  echo "  Provider usage"
  echo "    unavailable"
fi
if [[ -n "$codex_local" ]] && jq -e '.ok and .summary.total_tokens_used != null' >/dev/null <<<"$codex_local"; then
  echo "  Local observed usage"
  echo "    5h window: $(jq -r '.windows.tokens_5h' <<<"$codex_local") tokens across $(jq -r '.windows.threads_5h' <<<"$codex_local") threads"
  echo "    7d window: $(jq -r '.windows.tokens_7d' <<<"$codex_local") tokens across $(jq -r '.windows.threads_7d' <<<"$codex_local") threads"
  echo "    30d window: $(jq -r '.windows.tokens_30d' <<<"$codex_local") tokens across $(jq -r '.windows.threads_30d' <<<"$codex_local") threads"
  echo "    Lifetime local DB total: $(jq -r '.summary.total_tokens_used' <<<"$codex_local")"
else
  echo "  Local observed usage"
  echo "    unavailable"
fi
echo

echo "Claude"
if [[ -n "$claude_live" ]] && jq -e '.ok and .five_hour' >/dev/null <<<"$claude_live"; then
  five_used="$(jq -r '.five_hour.utilization // .five_hour.percent_used // .five_hour.used_percent // empty' <<<"$claude_live")"
  seven_used="$(jq -r '.seven_day.utilization // .seven_day.percent_used // .seven_day.used_percent // empty' <<<"$claude_live")"
  sonnet_used="$(jq -r '.seven_day_sonnet.utilization // empty' <<<"$claude_live")"
  five_remaining="$(awk -v u="$five_used" 'BEGIN { printf "%.0f", 100 - u }')"
  seven_remaining="$(awk -v u="$seven_used" 'BEGIN { printf "%.0f", 100 - u }')"
  echo "  Provider usage"
  echo "    5h window: ${five_used:-unknown}% used, ${five_remaining:-unknown}% remaining, resets in $(human_until_iso "$(jq -r '.five_hour.resets_at // empty' <<<"$claude_live")")"
  echo "    7d window: ${seven_used:-unknown}% used, ${seven_remaining:-unknown}% remaining, resets in $(human_until_iso "$(jq -r '.seven_day.resets_at // empty' <<<"$claude_live")")"
  if [[ -n "$sonnet_used" ]]; then
    echo "    7d sonnet window: ${sonnet_used}% used, resets in $(human_until_iso "$(jq -r '.seven_day_sonnet.resets_at // empty' <<<"$claude_live")")"
  fi
else
  echo "  Provider usage"
  echo "    unavailable"
fi
if [[ -n "$claude_local" ]] && jq -e '.ok' >/dev/null <<<"$claude_local"; then
  echo "  Local observed usage"
  echo "    Logged in: $(jq -r '.auth.loggedIn // "unknown"' <<<"$claude_local")"
  echo "    Auth method: $(jq -r '.auth.authMethod // "unknown"' <<<"$claude_local")"
  echo "    Subscription: $(jq -r '.auth.subscriptionType // .backup_account.billingType // "unknown"' <<<"$claude_local")"
  if jq -e '.usage.windows["5h"]' >/dev/null <<<"$claude_local"; then
    echo "    5h window: $(jq -r '.usage.windows["5h"].input_tokens + .usage.windows["5h"].output_tokens + .usage.windows["5h"].cache_creation_input_tokens + .usage.windows["5h"].cache_read_input_tokens' <<<"$claude_local") tokens across $(jq -r '.usage.windows["5h"].messages' <<<"$claude_local") messages"
    echo "    7d window: $(jq -r '.usage.windows["7d"].input_tokens + .usage.windows["7d"].output_tokens + .usage.windows["7d"].cache_creation_input_tokens + .usage.windows["7d"].cache_read_input_tokens' <<<"$claude_local") tokens across $(jq -r '.usage.windows["7d"].messages' <<<"$claude_local") messages"
    echo "    30d window: $(jq -r '.usage.windows["30d"].input_tokens + .usage.windows["30d"].output_tokens + .usage.windows["30d"].cache_creation_input_tokens + .usage.windows["30d"].cache_read_input_tokens' <<<"$claude_local") tokens across $(jq -r '.usage.windows["30d"].messages' <<<"$claude_local") messages"
  fi
  echo "    Cost probe: $(jq -r '.cost.raw // "unavailable"' <<<"$claude_local" | tr '\n' ' ' | sed 's/  */ /g')"
else
  echo "  Local observed usage"
  echo "    unavailable"
fi
echo

echo "Gemini"
echo "  Provider usage"
echo "    unavailable from this probe"
if [[ -n "$gemini_local" ]] && jq -e '.ok and .summary.total != null' >/dev/null <<<"$gemini_local"; then
  echo "  Local observed usage"
  echo "    5h window: $(jq -r '.windows["5h"].total' <<<"$gemini_local") tokens across $(jq -r '.windows["5h"].session_count' <<<"$gemini_local") sessions"
  echo "    7d window: $(jq -r '.windows["7d"].total' <<<"$gemini_local") tokens across $(jq -r '.windows["7d"].session_count' <<<"$gemini_local") sessions"
  echo "    30d window: $(jq -r '.windows["30d"].total' <<<"$gemini_local") tokens across $(jq -r '.windows["30d"].session_count' <<<"$gemini_local") sessions"
  echo "    Lifetime local session total: $(jq -r '.summary.total' <<<"$gemini_local")"
  echo "    Input tokens: $(jq -r '.summary.input' <<<"$gemini_local")"
  echo "    Output tokens: $(jq -r '.summary.output' <<<"$gemini_local")"
  echo "    Cached tokens: $(jq -r '.summary.cached' <<<"$gemini_local")"
  top_project="$(jq -r '.per_project | to_entries | sort_by(-.value.tokens_7d) | .[0].key // empty' <<<"$gemini_local")"
  if [[ -n "$top_project" ]]; then
    echo "    Top project (7d): ${top_project} with $(jq -r --arg p "$top_project" '.per_project[$p].tokens_7d' <<<"$gemini_local") tokens"
  fi
  top_model="$(jq -r '.per_model | to_entries | .[0].key // empty' <<<"$gemini_local")"
  if [[ -n "$top_model" ]]; then
    echo "    Top model: ${top_model} with $(jq -r --arg m "$top_model" '.per_model[$m]' <<<"$gemini_local") tokens"
  fi
else
  echo "  Local observed usage"
  echo "    unavailable"
fi
EOF
}

render_normalized() {
  local jsonl_file="$1"

  jq -s '
    def pct_window(provider_name; window_id; window_label; used; reset_at):
      {
        provider: provider_name,
        window: window_id,
        label: window_label,
        source_type: "provider",
        confidence: "official",
        used_percent: used,
        remaining_percent: (if used == null then null else (100 - used) end),
        reset_at: reset_at,
        token_total: null
      };
    def token_window(provider_name; window_id; window_label; tokens):
      {
        provider: provider_name,
        window: window_id,
        label: window_label,
        source_type: "local",
        confidence: "observed",
        used_percent: null,
        remaining_percent: null,
        reset_at: null,
        token_total: tokens
      };
    def to_entries_top(n):
      to_entries | map({name: .key, tokens: .value}) | sort_by(-.tokens) | .[:n];
    def codex_local:
      map(select(.provider == "codex" and .source == "local-db" and .ok)) | first;
    def codex_live:
      map(select(.provider == "codex" and .source == "live-api" and .ok and .rate_limit?)) | first;
    def claude_local:
      map(select(.provider == "claude" and .source == "local-cli" and .ok)) | first;
    def claude_live:
      map(select(.provider == "claude" and .source == "live-api" and .ok and .five_hour?)) | first;
    def gemini_local:
      map(select(.provider == "gemini" and .source == "local-json" and .ok)) | first;

    {
      generated_at: (now | todateiso8601),
      providers: [
        (
          codex_local as $local
          | codex_live as $live
          | {
              provider: "codex",
              summary_windows:
                ([
                  (if $live then pct_window("codex"; "5h"; "5h"; $live.rate_limit.primary_window.used_percent; ($live.rate_limit.primary_window.reset_at | tostring)) else empty end),
                  (if $live then pct_window("codex"; "7d"; "7d"; $live.rate_limit.secondary_window.used_percent; ($live.rate_limit.secondary_window.reset_at | tostring)) else empty end),
                  (if $local then token_window("codex"; "30d"; "30d"; $local.windows.tokens_30d) else empty end)
                ]),
              local_details:
                (if $local then {
                  source_type: "local",
                  confidence: "observed",
                  tokens_total: $local.summary.total_tokens_used,
                  tokens_5h: $local.windows.tokens_5h,
                  tokens_7d: $local.windows.tokens_7d,
                  tokens_30d: $local.windows.tokens_30d,
                  top_models: ($local.model_totals // [] | map({name: .model, tokens: .tokens_used}) | .[:5]),
                  top_tasks: ($local.top_threads // [] | map({
                    id: .id,
                    label: .title,
                    tokens: .tokens_used,
                    model: (.model // null),
                    project: .cwd,
                    updated_at: .updated_at
                  }) | .[:5]),
                  top_projects: (($local.top_threads // []) | map({name: .cwd, tokens: .tokens_used}) | group_by(.name) | map({name: .[0].name, tokens: (map(.tokens) | add)}) | sort_by(-.tokens) | .[:5])
                } else null end)
            }
        ),
        (
          claude_local as $local
          | claude_live as $live
          | {
              provider: "claude",
              summary_windows:
                ([
                  (if $live then pct_window("claude"; "5h"; "5h"; $live.five_hour.utilization; $live.five_hour.resets_at) else empty end),
                  (if $live then pct_window("claude"; "7d"; "7d"; $live.seven_day.utilization; $live.seven_day.resets_at) else empty end),
                  (if $local then token_window("claude"; "30d"; "30d"; ($local.usage.windows["30d"].input_tokens + $local.usage.windows["30d"].output_tokens + $local.usage.windows["30d"].cache_creation_input_tokens + $local.usage.windows["30d"].cache_read_input_tokens)) else empty end)
                ]),
              local_details:
                (if $local then {
                  source_type: "local",
                  confidence: "observed",
                  tokens_total: ($local.usage.summary.input_tokens + $local.usage.summary.output_tokens + $local.usage.summary.cache_creation_input_tokens + $local.usage.summary.cache_read_input_tokens),
                  tokens_5h: ($local.usage.windows["5h"].input_tokens + $local.usage.windows["5h"].output_tokens + $local.usage.windows["5h"].cache_creation_input_tokens + $local.usage.windows["5h"].cache_read_input_tokens),
                  tokens_7d: ($local.usage.windows["7d"].input_tokens + $local.usage.windows["7d"].output_tokens + $local.usage.windows["7d"].cache_creation_input_tokens + $local.usage.windows["7d"].cache_read_input_tokens),
                  tokens_30d: ($local.usage.windows["30d"].input_tokens + $local.usage.windows["30d"].output_tokens + $local.usage.windows["30d"].cache_creation_input_tokens + $local.usage.windows["30d"].cache_read_input_tokens),
                  top_models: ($local.usage.per_model // {} | to_entries_top(5)),
                  top_tasks: ($local.usage.top_sessions // [] | map({
                    id: .session_id,
                    label: (.path | split("/") | last),
                    tokens: .tokens,
                    model: null,
                    project: .path,
                    updated_at: .updated_at
                  }) | .[:5]),
                  top_projects: ($local.usage.per_project // {} | to_entries_top(5))
                } else null end),
              extra_windows:
                (if $live and $live.seven_day_sonnet != null then [
                  pct_window("claude"; "7d_sonnet"; "7d sonnet"; $live.seven_day_sonnet.utilization; $live.seven_day_sonnet.resets_at)
                ] else [] end)
            }
        ),
        (
          gemini_local as $local
          | {
              provider: "gemini",
              summary_windows:
                ([
                  (if $local then token_window("gemini"; "5h"; "5h"; $local.windows["5h"].total) else empty end),
                  (if $local then token_window("gemini"; "7d"; "7d"; $local.windows["7d"].total) else empty end),
                  (if $local then token_window("gemini"; "30d"; "30d"; $local.windows["30d"].total) else empty end)
                ]),
              local_details:
                (if $local then {
                  source_type: "local",
                  confidence: "observed",
                  tokens_total: $local.summary.total,
                  tokens_input: $local.summary.input,
                  tokens_output: $local.summary.output,
                  tokens_cached: $local.summary.cached,
                  tokens_thoughts: $local.summary.thoughts,
                  tokens_5h: $local.windows["5h"].total,
                  tokens_7d: $local.windows["7d"].total,
                  tokens_30d: $local.windows["30d"].total,
                  top_models: ($local.per_model // {} | to_entries_top(5)),
                  top_tasks: (($local.latest_sessions // []) | sort_by(-.tokens.total) | map({
                    id: .session_id,
                    label: .file,
                    tokens: .tokens.total,
                    model: null,
                    project: .project,
                    updated_at: .last_updated
                  }) | .[:5]),
                  top_projects: ($local.per_project // {} | to_entries | map({name: .key, tokens: .value.tokens_7d, sessions: .value.session_count}) | sort_by(-.tokens) | .[:5])
                } else null end)
            }
        )
      ]
    }
  ' "$jsonl_file"
}

probe_codex_local() {
  local state_db="$HOME/.codex/state_5.sqlite"
  local auth_file="$HOME/.codex/auth.json"
  local config_file="$HOME/.codex/config.toml"

  if [[ ! -f "$state_db" ]]; then
    print_result "codex" "local-db" "false" \
      "$(jq -cn --arg db "$state_db" '{error: "missing state db", db: $db}')"
    return
  fi

  local summary
  summary="$(
    sqlite3 -json "$state_db" "
      select
        count(*) as thread_count,
        coalesce(sum(tokens_used), 0) as total_tokens_used,
        coalesce(sum(case when archived = 0 then tokens_used else 0 end), 0) as active_tokens_used,
        coalesce(sum(case when archived = 0 then 1 else 0 end), 0) as active_thread_count,
        max(tokens_used) as max_thread_tokens
      from threads;
    " 2>/dev/null | jq '.[0] // {}'
  )"

  local windows
  windows="$(
    sqlite3 -json "$state_db" "
      with now(ts) as (select cast(strftime('%s', 'now') as integer))
      select
        coalesce(sum(case when updated_at >= (select ts from now) - 18000 then tokens_used else 0 end), 0) as tokens_5h,
        coalesce(sum(case when updated_at >= (select ts from now) - 604800 then tokens_used else 0 end), 0) as tokens_7d,
        coalesce(sum(case when updated_at >= (select ts from now) - 2592000 then tokens_used else 0 end), 0) as tokens_30d,
        coalesce(sum(case when updated_at >= (select ts from now) - 18000 then 1 else 0 end), 0) as threads_5h,
        coalesce(sum(case when updated_at >= (select ts from now) - 604800 then 1 else 0 end), 0) as threads_7d,
        coalesce(sum(case when updated_at >= (select ts from now) - 2592000 then 1 else 0 end), 0) as threads_30d
      from threads;
    " 2>/dev/null | jq '.[0] // {}'
  )"

  local latest
  latest="$(
    sqlite3 -json "$state_db" "
      select
        id,
        title,
        tokens_used,
        model_provider,
        coalesce(model, '') as model,
        source,
        cwd,
        git_branch,
        created_at,
        updated_at
      from threads
      order by updated_at desc
      limit 5;
    " 2>/dev/null | jq '.'
  )"

  local top_threads
  top_threads="$(
    sqlite3 -json "$state_db" "
      select
        id,
        title,
        tokens_used,
        coalesce(model, '') as model,
        cwd,
        git_branch,
        updated_at
      from threads
      order by tokens_used desc
      limit 5;
    " 2>/dev/null | jq '.'
  )"

  local model_totals
  model_totals="$(
    sqlite3 -json "$state_db" "
      select
        coalesce(model, 'unknown') as model,
        sum(tokens_used) as tokens_used
      from threads
      group by coalesce(model, 'unknown')
      order by sum(tokens_used) desc
      limit 10;
    " 2>/dev/null | jq '.'
  )"

  local payload
  payload="$(
    jq -cn \
      --arg db "$state_db" \
      --arg auth_file "$auth_file" \
      --arg config_file "$config_file" \
      --argjson auth_file_exists "$(file_exists_json "$auth_file")" \
      --argjson config_file_exists "$(file_exists_json "$config_file")" \
      --argjson summary "$summary" \
      --argjson windows "$windows" \
      --argjson latest_threads "$latest" \
      --argjson top_threads "$top_threads" \
      --argjson model_totals "$model_totals" \
      '{
        db: $db,
        auth_file: $auth_file,
        auth_file_exists: $auth_file_exists,
        config_file: $config_file,
        config_file_exists: $config_file_exists,
        summary: $summary,
        windows: $windows,
        latest_threads: $latest_threads,
        top_threads: $top_threads,
        model_totals: $model_totals
      }'
  )"

  print_result "codex" "local-db" "true" "$payload"
}

probe_codex_live() {
  local auth_file="$HOME/.codex/auth.json"

  if [[ ! -f "$auth_file" ]]; then
    print_result "codex" "live-api" "false" \
      "$(jq -cn --arg auth_file "$auth_file" '{error: "missing auth file", auth_file: $auth_file}')"
    return
  fi

  local access_token
  access_token="$(jq -r '.tokens.access_token // .access_token // empty' "$auth_file" 2>/dev/null || true)"
  if [[ -z "$access_token" ]]; then
    print_result "codex" "live-api" "false" \
      "$(jq -cn --arg auth_file "$auth_file" '{error: "missing access token in auth file", auth_file: $auth_file}')"
    return
  fi

  local response
  if ! response="$(curl -sS -H "Authorization: Bearer $access_token" "https://chatgpt.com/backend-api/wham/usage" 2>&1)"; then
    print_result "codex" "live-api" "false" \
      "$(jq -cn --arg error "$response" '{error: $error}')"
    return
  fi

  local payload
  payload="$(printf '%s' "$response" | jq '.' 2>/dev/null || jq -Rn --arg raw "$response" '{raw: $raw}')"
  print_result "codex" "live-api" "true" "$payload"
}

probe_claude_local() {
  local config_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local sessions_dir="$config_dir/sessions"
  local projects_dir="$config_dir/projects"
  local credentials_file="$config_dir/.credentials.json"
  local backup_file
  local auth_status
  local cost_output

  backup_file="$(find "$config_dir/backups" -maxdepth 1 -type f -name '.claude.json.backup.*' 2>/dev/null | sort | tail -1)"

  auth_status="$(claude auth status 2>&1 || true)"
  cost_output="$(claude -p '/cost' 2>&1 || true)"

  local auth_json
  auth_json="$(printf '%s' "$auth_status" | jq '.' 2>/dev/null || jq -Rn --arg raw "$auth_status" '{raw: $raw}')"

  local cost_json
  cost_json="$(
    COST_OUTPUT="$cost_output" python3 - <<'PY'
import json
import os
import re

text = os.environ.get("COST_OUTPUT", "")
data = {"raw": text}
patterns = {
    "total_cost_usd": r"Total cost:\s+\$([0-9.]+)",
    "api_duration": r"Total duration \(API\):\s+(.+)",
    "wall_duration": r"Total duration \(wall\):\s+(.+)",
    "code_changes": r"Total code changes:\s+(.+)",
    "usage": r"Usage:\s+(.+)",
}
for key, pattern in patterns.items():
    match = re.search(pattern, text)
    if match:
        data[key] = match.group(1).strip()
print(json.dumps(data))
PY
  )"

  local usage_json
  usage_json="$(
    PROJECTS_DIR="$projects_dir" python3 - <<'PY'
import glob
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from collections import defaultdict

projects_dir = Path(os.environ["PROJECTS_DIR"])
now = datetime.now(timezone.utc)

summary = {
    "messages": 0,
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
}
windows = {
    "5h": {"seconds": 18000, "messages": 0, "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
    "7d": {"seconds": 604800, "messages": 0, "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
    "30d": {"seconds": 2592000, "messages": 0, "input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
}
per_model = defaultdict(int)
per_project = defaultdict(int)
per_session = defaultdict(lambda: {"tokens": 0, "messages": 0, "path": "", "updated_at": ""})

def parse_iso(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None

for path_str in glob.glob(str(projects_dir / "*" / "*.jsonl")):
    path = Path(path_str)
    try:
        with path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                usage = obj.get("message", {}).get("usage")
                if not isinstance(usage, dict):
                    continue
                ts = parse_iso(obj.get("timestamp"))
                if ts is None:
                    continue
                age_seconds = (now - ts).total_seconds()
                session_id = obj.get("sessionId") or path.stem
                per_session[session_id]["path"] = str(path)
                per_session[session_id]["updated_at"] = obj.get("timestamp") or per_session[session_id]["updated_at"]
                summary["messages"] += 1
                for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
                    value = usage.get(key, 0)
                    if isinstance(value, int):
                        summary[key] += value
                        per_session[session_id]["tokens"] += value
                        per_project[path.parent.name] += value
                per_session[session_id]["messages"] += 1
                model = obj.get("message", {}).get("model")
                if model:
                    token_total = 0
                    for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
                        value = usage.get(key, 0)
                        if isinstance(value, int):
                            token_total += value
                    per_model[model] += token_total
                for info in windows.values():
                    if age_seconds <= info["seconds"]:
                        info["messages"] += 1
                        for key in ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"):
                            value = usage.get(key, 0)
                            if isinstance(value, int):
                                info[key] += value
    except Exception:
        continue

for info in windows.values():
    info.pop("seconds", None)

top_sessions = sorted(
    (
        {
            "session_id": session_id,
            "tokens": info["tokens"],
            "messages": info["messages"],
            "path": info["path"],
            "updated_at": info["updated_at"],
        }
        for session_id, info in per_session.items()
    ),
    key=lambda item: item["tokens"],
    reverse=True,
)[:5]

print(json.dumps({
    "summary": summary,
    "windows": windows,
    "per_model": dict(sorted(per_model.items(), key=lambda item: item[1], reverse=True)),
    "per_project": dict(sorted(per_project.items(), key=lambda item: item[1], reverse=True)),
    "top_sessions": top_sessions,
}))
PY
  )"

  local backup_json="null"
  if [[ -n "${backup_file:-}" ]]; then
    backup_json="$(
      BACKUP_FILE="$backup_file" python3 - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["BACKUP_FILE"])
try:
    data = json.loads(path.read_text())
except Exception:
    print("null")
    raise SystemExit(0)

account = data.get("oauthAccount") or {}
subset = {
    "emailAddress": account.get("emailAddress"),
    "organizationName": account.get("organizationName"),
    "billingType": account.get("billingType"),
    "subscriptionCreatedAt": account.get("subscriptionCreatedAt"),
}
print(json.dumps(subset))
PY
    )"
  fi

  local payload
  payload="$(
    jq -cn \
      --arg config_dir "$config_dir" \
      --arg sessions_dir "$sessions_dir" \
      --arg projects_dir "$projects_dir" \
      --arg credentials_file "$credentials_file" \
      --arg backup_file "${backup_file:-}" \
      --argjson sessions_dir_exists "$(file_exists_json "$sessions_dir")" \
      --argjson projects_dir_exists "$(file_exists_json "$projects_dir")" \
      --argjson credentials_file_exists "$(file_exists_json "$credentials_file")" \
      --argjson auth "$auth_json" \
      --argjson cost "$cost_json" \
      --argjson usage "$usage_json" \
      --argjson backup_account "$backup_json" \
      '{
        config_dir: $config_dir,
        sessions_dir: $sessions_dir,
        sessions_dir_exists: $sessions_dir_exists,
        projects_dir: $projects_dir,
        projects_dir_exists: $projects_dir_exists,
        credentials_file: $credentials_file,
        credentials_file_exists: $credentials_file_exists,
        backup_file: $backup_file,
        auth: $auth,
        cost: $cost,
        usage: $usage,
        backup_account: $backup_account
      }'
  )"

  print_result "claude" "local-cli" "true" "$payload"
}

probe_claude_live() {
  local credentials_file="$HOME/.claude/.credentials.json"
  local source="keychain"
  local access_token=""

  access_token="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null | jq -r '.claudeAiOauth.accessToken // empty' 2>/dev/null || true)"

  if [[ -z "$access_token" && -f "$credentials_file" ]]; then
    source="file"
    access_token="$(jq -r '.accessToken // .access_token // empty' "$credentials_file" 2>/dev/null || true)"
  fi

  if [[ -z "$access_token" ]]; then
    print_result "claude" "live-api" "false" \
      "$(jq -cn --arg credentials_file "$credentials_file" '{error: "missing Claude OAuth access token in keychain or credentials file", credentials_file: $credentials_file}')"
    return
  fi

  local response
  if ! response="$(
    curl -sS \
      -H "Authorization: Bearer $access_token" \
      -H "anthropic-beta: oauth-2025-04-20" \
      "https://api.anthropic.com/api/oauth/usage" 2>&1
  )"; then
    print_result "claude" "live-api" "false" \
      "$(jq -cn --arg error "$response" '{error: $error}')"
    return
  fi

  local payload
  payload="$(printf '%s' "$response" | jq --arg source "$source" '. + {credential_source: $source}' 2>/dev/null || jq -Rn --arg raw "$response" --arg source "$source" '{raw: $raw, credential_source: $source}')"
  print_result "claude" "live-api" "true" "$payload"
}

probe_gemini_local() {
  local base_dir="$HOME/.gemini"
  local settings_file="$base_dir/settings.json"
  local projects_file="$base_dir/projects.json"
  local tmp_dir="$base_dir/tmp"

  if [[ ! -d "$tmp_dir" ]]; then
    print_result "gemini" "local-json" "false" \
      "$(jq -cn --arg tmp_dir "$tmp_dir" '{error: "missing tmp dir", tmp_dir: $tmp_dir}')"
    return
  fi

  local payload
  payload="$(
    TMP_DIR="$tmp_dir" SETTINGS_FILE="$settings_file" PROJECTS_FILE="$projects_file" python3 - <<'PY'
import glob
import json
import os
from pathlib import Path
from collections import defaultdict

tmp_dir = Path(os.environ["TMP_DIR"])
settings_file = Path(os.environ["SETTINGS_FILE"])
projects_file = Path(os.environ["PROJECTS_FILE"])

sessions = []
totals = {
    "input": 0,
    "output": 0,
    "cached": 0,
    "thoughts": 0,
    "tool": 0,
    "total": 0,
    "message_count": 0,
    "session_count": 0,
}
windows = {
    "5h": {"input": 0, "output": 0, "cached": 0, "thoughts": 0, "tool": 0, "total": 0, "session_count": 0},
    "7d": {"input": 0, "output": 0, "cached": 0, "thoughts": 0, "tool": 0, "total": 0, "session_count": 0},
    "30d": {"input": 0, "output": 0, "cached": 0, "thoughts": 0, "tool": 0, "total": 0, "session_count": 0},
}
per_project = defaultdict(lambda: {
    "session_count": 0,
    "tokens_5h": 0,
    "tokens_7d": 0,
    "tokens_30d": 0,
    "tokens_lifetime": 0,
})
per_model = defaultdict(int)

from datetime import datetime, timezone
now = datetime.now(timezone.utc)

def parse_iso(ts):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None

for path_str in glob.glob(str(tmp_dir / "*" / "chats" / "*.json")):
    path = Path(path_str)
    project_name = path.parents[1].name
    try:
      with path.open() as f:
        data = json.load(f)
    except Exception:
      continue

    session_totals = {
        "input": 0,
        "output": 0,
        "cached": 0,
        "thoughts": 0,
        "tool": 0,
        "total": 0,
        "message_count": 0,
    }

    for message in data.get("messages", []):
        tokens = message.get("tokens")
        if not isinstance(tokens, dict):
            continue
        session_totals["message_count"] += 1
        for key in ("input", "output", "cached", "thoughts", "tool", "total"):
            value = tokens.get(key)
            if isinstance(value, int):
                session_totals[key] += value
                totals[key] += value
        totals["message_count"] += 1
        model = message.get("model")
        if model and isinstance(tokens.get("total"), int):
            per_model[model] += tokens["total"]

    if session_totals["message_count"] > 0:
        totals["session_count"] += 1
        per_project[project_name]["session_count"] += 1
        per_project[project_name]["tokens_lifetime"] += session_totals["total"]
        session = {
            "file": str(path),
            "project": project_name,
            "session_id": data.get("sessionId"),
            "start_time": data.get("startTime"),
            "last_updated": data.get("lastUpdated"),
            "message_count": session_totals["message_count"],
            "tokens": {k: session_totals[k] for k in ("input", "output", "cached", "thoughts", "tool", "total")},
        }
        sessions.append(session)

        last_updated_dt = parse_iso(data.get("lastUpdated")) or parse_iso(data.get("startTime"))
        if last_updated_dt is not None:
            age_seconds = (now - last_updated_dt).total_seconds()
            for label, seconds in (("5h", 18000), ("7d", 604800), ("30d", 2592000)):
                if age_seconds <= seconds:
                    windows[label]["session_count"] += 1
                    per_project[project_name][f"tokens_{label}"] += session_totals["total"]
                    for key in ("input", "output", "cached", "thoughts", "tool", "total"):
                        windows[label][key] += session_totals[key]

sessions.sort(key=lambda item: item.get("last_updated") or "", reverse=True)

settings = None
projects = None
for var_name, target in (("SETTINGS_FILE", "settings"), ("PROJECTS_FILE", "projects")):
    path = Path(os.environ[var_name])
    if path.exists():
        try:
            with path.open() as f:
                value = json.load(f)
        except Exception:
            value = None
    else:
        value = None
    if target == "settings":
        settings = value
    else:
        projects = value

print(json.dumps({
    "base_dir": str(tmp_dir.parent),
    "settings": settings,
    "projects": projects,
    "summary": totals,
    "windows": windows,
    "per_project": dict(sorted(per_project.items())),
    "per_model": dict(sorted(per_model.items(), key=lambda item: item[1], reverse=True)),
    "latest_sessions": sessions[:5],
}))
PY
  )"

  print_result "gemini" "local-json" "true" "$payload"
}

probe_provider() {
  local provider="$1"
  local mode="$2"

  case "$provider" in
    codex)
      probe_codex_local
      if [[ "$mode" == "live" ]]; then
        probe_codex_live
      fi
      ;;
    claude)
      probe_claude_local
      if [[ "$mode" == "live" ]]; then
        probe_claude_live
      fi
      ;;
    gemini)
      probe_gemini_local
      ;;
    *)
      echo "{\"provider\":\"$provider\",\"source\":\"dispatch\",\"ok\":false,\"error\":\"unknown provider\"}"
      return 1
      ;;
  esac
}

main() {
  require_cmd jq

  local provider="${1:-all}"
  local mode="${2:-local}"
  local format="${3:-jsonl}"

  case "$provider" in
    -h|--help)
      usage
      exit 0
      ;;
  esac

  case "$mode" in
    local|live) ;;
    *)
      echo "Invalid mode: $mode" >&2
      usage
      exit 1
      ;;
  esac

  case "$format" in
    jsonl|report|normalized) ;;
    *)
      echo "Invalid format: $format" >&2
      usage
      exit 1
      ;;
  esac

  if [[ "$provider" == "all" || "$provider" == "codex" ]]; then
    require_cmd sqlite3
  fi
  if [[ "$provider" == "all" || "$provider" == "claude" ]]; then
    require_cmd claude
  fi
  if [[ "$provider" == "all" || "$provider" == "claude" || "$provider" == "gemini" ]]; then
    require_cmd python3
  fi
  if [[ "$mode" == "live" && ( "$provider" == "all" || "$provider" == "codex" || "$provider" == "claude" ) ]]; then
    require_cmd curl
  fi

  if [[ "$format" == "jsonl" ]]; then
    case "$provider" in
      all)
        probe_provider codex "$mode"
        probe_provider claude "$mode"
        probe_provider gemini "$mode"
        ;;
      codex|claude|gemini)
        probe_provider "$provider" "$mode"
        ;;
      *)
        echo "Invalid provider: $provider" >&2
        usage
        exit 1
        ;;
    esac
  else
    local tmp_file=""
    tmp_file="$(mktemp)"
    trap "rm -f '$tmp_file'" EXIT

    case "$provider" in
      all)
        probe_provider codex "$mode" >>"$tmp_file"
        probe_provider claude "$mode" >>"$tmp_file"
        probe_provider gemini "$mode" >>"$tmp_file"
        ;;
      codex|claude|gemini)
        probe_provider "$provider" "$mode" >>"$tmp_file"
        ;;
      *)
        echo "Invalid provider: $provider" >&2
        usage
        exit 1
        ;;
    esac

    if [[ "$format" == "report" ]]; then
      render_report "$tmp_file"
    else
      render_normalized "$tmp_file"
    fi
  fi
}

main "$@"
