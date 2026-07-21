#!/usr/bin/env bash
# E2E tests for the 3 real PRA agents — trigger each via Inngest dev server send API,
# then poll GraphQL to confirm the run reached "Completed" status.
#
# Usage:
#   bash scripts/e2e-mock-test/e2e-3-agents.sh
#
# Requires:
#   - AO main running on :3002 (registered to Inngest dev server)
#   - Inngest dev server on :8288
#
# Result: prints PASS / FAIL per agent + run IDs for inspection.

set -uo pipefail

INNGEST_BASE="${INNGEST_BASE:-http://localhost:8288}"

cyan()  { printf "\033[36m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
gray()  { printf "\033[90m%s\033[0m\n" "$*"; }

# ─────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────

send_event() {
  local NAME="$1"; local DATA="$2"
  local RES
  RES=$(curl -sS -m 5 -X POST "$INNGEST_BASE/e/test" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$NAME\",\"data\":$DATA}")
  echo "$RES" | jq -r '.ids[0] // .error // "?"'
}

# Wait up to TIMEOUT secs for a run on FUNCTION_SLUG to reach a terminal state
# after EVENT_TS. Prints final status + run id.
wait_for_run() {
  local FUNCTION_NAME="$1"; local EVENT_AFTER_MS="$2"; local TIMEOUT="$3"
  local DEADLINE=$(( $(date +%s) + TIMEOUT ))
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    local Q="query { functionRuns(query: { lastID: null }) { runID functionID function { name } status startedAt endedAt } }"
    local R=$(curl -sS -m 5 -X POST "$INNGEST_BASE/v0/gql" \
      -H 'Content-Type: application/json' \
      -d "{\"query\":\"$Q\"}" 2>/dev/null)
    local HIT=$(echo "$R" | jq -r --arg fn "$FUNCTION_NAME" --argjson after "$EVENT_AFTER_MS" '
      .data.functionRuns[]?
      | select(.function.name == $fn)
      | select( (.startedAt | sub("\\..*Z$";"Z") | fromdate * 1000) >= $after )
      | "\(.runID)\t\(.status)"
    ' | tail -1)
    if [ -n "$HIT" ]; then
      local RID=$(echo "$HIT" | awk -F'\t' '{print $1}')
      local ST=$(echo "$HIT" | awk -F'\t' '{print $2}')
      if [ "$ST" = "Completed" ] || [ "$ST" = "Failed" ] || [ "$ST" = "Cancelled" ]; then
        echo "$RID|$ST"
        return 0
      fi
      gray "  run $RID still $ST..."
    fi
    sleep 2
  done
  echo "|TIMEOUT"
  return 1
}

# ─────────────────────────────────────────────────────────
# E2E 1: resume-parser-agent (RESUME_DOWNLOADED with inline parsed.data)
# ─────────────────────────────────────────────────────────

cyan "════════════════════════════════════════════════════════"
cyan "  E2E 1: resume-parser-agent"
cyan "  trigger: RESUME_DOWNLOADED (legacy path with inline parsed.data)"
cyan "════════════════════════════════════════════════════════"

T1_START=$(($(date +%s%3N)))
EVENT_DATA_1=$(cat <<'EOF'
{
  "upload_id": "e2e-rpa-test-001",
  "bucket": "recruit-resume-raw",
  "objectKey": "e2e/test-resume.pdf",
  "filename": "e2e-test-resume.pdf",
  "hrFolder": null,
  "employeeId": "e2e_employee_001",
  "etag": "e2e-mock-etag-001",
  "size": 12345,
  "sourceEventName": "test",
  "receivedAt": "2026-05-14T15:00:00Z",
  "parsed": {
    "data": {
      "name": "E2E 测试候选人",
      "email": "e2e@test.com",
      "phone": "13800138001",
      "location": "北京",
      "summary": "E2E 测试用候选人简历",
      "experience": [
        {"title": "高级研发工程师", "company": "字节跳动", "startDate": "2022-01", "endDate": "2024-12", "description": "Java 后端开发"}
      ],
      "education": [
        {"degree": "本科", "field": "计算机", "institution": "清华大学", "graduationYear": "2021"}
      ],
      "skills": ["Java", "MySQL", "Redis"]
    }
  }
}
EOF
)
ID1=$(send_event "RESUME_DOWNLOADED" "$EVENT_DATA_1")
echo "  emitted event id: $ID1"
RESULT1=$(wait_for_run "Resume Parser Agent" "$T1_START" 30)
RID1=$(echo "$RESULT1" | cut -d'|' -f1)
ST1=$(echo "$RESULT1" | cut -d'|' -f2)
if [ "$ST1" = "Completed" ]; then
  green "  ✅ E2E 1 PASS · run=$RID1 · status=$ST1"
elif [ "$ST1" = "Failed" ]; then
  red "  ⚠ E2E 1 FAIL · run=$RID1 · status=$ST1 (run failed — check log)"
else
  red "  ⚠ E2E 1 TIMEOUT · status=$ST1"
fi

# ─────────────────────────────────────────────────────────
# E2E 2: create-jd-agent (REQUIREMENT_LOGGED)
# ─────────────────────────────────────────────────────────

cyan ""
cyan "════════════════════════════════════════════════════════"
cyan "  E2E 2: create-jd-agent"
cyan "  trigger: REQUIREMENT_LOGGED"
cyan "════════════════════════════════════════════════════════"

T2_START=$(($(date +%s%3N)))
EVENT_DATA_2=$(cat <<'EOF'
{
  "entity_type": "Job_Requisition",
  "entity_id": "e2e-jr-test-001",
  "event_id": "e2e-evt-jr-001",
  "payload": {
    "job_requisition_id": "e2e-jr-test-001",
    "client_id": "e2e-client-001",
    "raw_input_data": {
      "prompt": "招聘一名 Java 高级研发工程师,北京,5年经验,薪资 30-50k",
      "language": "zh"
    }
  },
  "trace": {
    "trace_id": "e2e-trace-001",
    "request_id": "e2e-req-001"
  }
}
EOF
)
ID2=$(send_event "REQUIREMENT_LOGGED" "$EVENT_DATA_2")
echo "  emitted event id: $ID2"
RESULT2=$(wait_for_run "Create JD Agent (workflow node 4)" "$T2_START" 60)
RID2=$(echo "$RESULT2" | cut -d'|' -f1)
ST2=$(echo "$RESULT2" | cut -d'|' -f2)
if [ "$ST2" = "Completed" ]; then
  green "  ✅ E2E 2 PASS · run=$RID2 · status=$ST2"
elif [ "$ST2" = "Failed" ]; then
  red "  ⚠ E2E 2 FAIL · run=$RID2 · status=$ST2 (run failed — check log)"
else
  red "  ⚠ E2E 2 TIMEOUT · status=$ST2"
fi

# ─────────────────────────────────────────────────────────
# E2E 3: match-resume-agent (RESUME_PROCESSED — auto-triggered by E2E 1 cascade,
#         but also directly testable)
# ─────────────────────────────────────────────────────────

cyan ""
cyan "════════════════════════════════════════════════════════"
cyan "  E2E 3: match-resume-agent"
cyan "  trigger: RESUME_PROCESSED (direct trigger;cascade from E2E 1 also counts)"
cyan "════════════════════════════════════════════════════════"

T3_START=$(($(date +%s%3N)))
EVENT_DATA_3=$(cat <<'EOF'
{
  "upload_id": "e2e-mra-test-001",
  "objectKey": "e2e/test-resume-2.pdf",
  "filename": "e2e-test-resume-2.pdf",
  "bucket": "recruit-resume-raw",
  "hrFolder": null,
  "employeeId": "e2e_employee_002",
  "etag": "e2e-mock-etag-002",
  "size": 12345,
  "sourceEventName": "test",
  "receivedAt": "2026-05-14T15:00:00Z",
  "candidate_id": "e2e-cand-mra-001",
  "resume_id": "e2e-resume-mra-001",
  "job_requisition_id": "e2e-jr-test-001",
  "parsed": {
    "data": {
      "name": "E2E MRA 测试",
      "email": "mra@test.com",
      "phone": "13800138002",
      "summary": "Java 工程师",
      "experience": [{"title": "Java 研发", "company": "腾讯", "startDate": "2020-01", "endDate": "2024-06"}],
      "skills": ["Java", "Spring", "MySQL"]
    }
  },
  "candidate": {},
  "candidate_expectation": {},
  "resume": {},
  "parsedAt": "2026-05-14T15:00:00Z",
  "parserVersion": "v7-pull-model@2026-05-08"
}
EOF
)
ID3=$(send_event "RESUME_PROCESSED" "$EVENT_DATA_3")
echo "  emitted event id: $ID3"
RESULT3=$(wait_for_run "Match Resume Agent (workflow node 10)" "$T3_START" 60)
RID3=$(echo "$RESULT3" | cut -d'|' -f1)
ST3=$(echo "$RESULT3" | cut -d'|' -f2)
if [ "$ST3" = "Completed" ]; then
  green "  ✅ E2E 3 PASS · run=$RID3 · status=$ST3"
elif [ "$ST3" = "Failed" ]; then
  red "  ⚠ E2E 3 FAIL · run=$RID3 · status=$ST3 (run failed — check log)"
else
  red "  ⚠ E2E 3 TIMEOUT · status=$ST3"
fi

# ─────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────

cyan ""
cyan "════════════════════════════════════════════════════════"
cyan "  Summary"
cyan "════════════════════════════════════════════════════════"
echo "  E2E 1 (resume-parser-agent):   $ST1 · run=$RID1"
echo "  E2E 2 (create-jd-agent):       $ST2 · run=$RID2"
echo "  E2E 3 (match-resume-agent):    $ST3 · run=$RID3"
