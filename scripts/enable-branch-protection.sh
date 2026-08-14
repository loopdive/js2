#!/usr/bin/env bash
#
# enable-branch-protection.sh — apply the canonical branch-protection ruleset
# for `main` to the GitHub repo. Source of truth for the rules is
# `docs/ci-policy.md` (#1525).
#
# Usage:
#   ./scripts/enable-branch-protection.sh             # apply
#   ./scripts/enable-branch-protection.sh --check     # dry-run (print payload only)
#
# Requirements:
#   - `gh` CLI authenticated as a user with repo-admin rights, OR
#   - `GH_TOKEN` env var set to a fine-grained PAT with "Administration:write"
#     and "Contents:read" on this repo, AND `gh` CLI installed.
#
# Idempotent: re-running re-applies the canonical state. Drift between repo
# settings and `docs/ci-policy.md` should be reconciled by running this
# script, not by editing settings manually.
#
# Notes:
#   - GitHub's live protection for this repo is a repository ruleset, not the
#     legacy branch-protection endpoint. This script fetches the current ruleset
#     and preserves merge-queue parameters, conditions, enforcement, and bypass
#     actors while replacing only the required-check list.
#   - The merge-queue parameters this script preserves are owned by
#     `scripts/set-merge-queue-config.sh` (batch cap, quorum floor, speculation
#     depth — #3914). The two are mirror images: each reads the live ruleset and
#     rewrites only its own slice, so they are safe to run in either order.
#     Use that script's `--show` to read the live queue config.
#   - Required-check names below MUST match the GitHub job names exactly.
#     Update `docs/ci-policy.md` and this file together when adding checks.
#
set -euo pipefail

REPO_OWNER="${REPO_OWNER:-loopdive}"
REPO_NAME="${REPO_NAME:-js2}"
BRANCH="${BRANCH:-main}"
RULESET_ID="${RULESET_ID:-16700772}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --check|--dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Required status checks — keep in sync with `docs/ci-policy.md` §1.
#
# Each entry is a GitHub check name (the value of the `name:` field on the job
# in the workflow YAML, OR the workflow `name:` if the job doesn't override).
# Names are case-sensitive and whitespace-sensitive.
#
# NOTE (#1897): the STANDALONE test262 lane is gated by an inline guard step
# *inside* the already-required `merge shard reports` job, NOT by a separate
# required check. The standalone shards already run in the same 57×2 matrix and
# the merged standalone JSONL is built in that job; the guard step diffs it
# against the standalone baseline and fails the (required) check on a
# net-negative standalone regression beyond tolerance. So gating standalone
# needed NO separate entry here and NO ruleset re-apply — it rides the
# `merge shard reports` context. See docs/ci-policy.md §3.
# -----------------------------------------------------------------------------
# NOTE (#3934): `linear-tests` was listed here for months while the live
# ruleset has NEVER contained it. That made this array a latent enforcement
# change: running the script would have silently promoted a seventh gate that
# nobody had decided to require. It is removed so this array states the policy
# that is actually in force. `linear-tests` still runs in ci.yml — it just does
# not gate, and ci.yml's `changes` job already treats it as optional. To promote
# it, add it here AND move it out of the optional table in docs/ci-policy.md §1,
# deliberately and in one reviewed change.
# -----------------------------------------------------------------------------
REQUIRED_CHECKS=(
  "cheap gate (main-ancestor + lint)"    # test262-sharded.yml — fast pre-flight reject
  "merge shard reports"                  # test262-sharded.yml — authoritative test262 gate (host + standalone, #1897)
  "quality"                              # ci.yml — lint, format, typecheck, IR budget
  "equivalence-gate"                     # ci.yml — merged equivalence shard gate
  "check for test262 regressions"        # test262-sharded.yml — full rolling-baseline regression diff
  "cla-check"                            # cla-check.yml — external contributor CLA acceptance (REQUIRED, #1660)
)

# Build the JSON payload from the live ruleset. Ruleset PUT is replace-style,
# so preserve everything unrelated to required status checks.
#
# Schema reference:
#   https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset
build_payload() {
  local contexts_json current
  contexts_json=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R . | jq -s .)
  current="$(gh api "${API_PATH}")"

  if ! jq -e '.rules[]? | select(.type == "required_status_checks")' >/dev/null <<<"${current}"; then
    echo "Ruleset ${RULESET_ID} has no required_status_checks rule; refusing to rewrite it." >&2
    exit 1
  fi

  jq \
    --argjson contexts "$contexts_json" \
    '
      .rules |= map(
        if .type == "required_status_checks" then
          .parameters.strict_required_status_checks_policy = true
          | .parameters.required_status_checks = ($contexts | map({context: .}))
        else
          .
        end
      )
      | {
          name,
          target,
          enforcement,
          conditions,
          rules,
          bypass_actors
        }
    ' <<<"${current}"
}

API_PATH="/repos/${REPO_OWNER}/${REPO_NAME}/rulesets/${RULESET_ID}"
PAYLOAD="$(build_payload)"

echo "Ruleset target:"
echo "  repo:    ${REPO_OWNER}/${REPO_NAME}"
echo "  branch:  ${BRANCH}"
echo "  ruleset: ${RULESET_ID}"
echo "  API:     PUT ${API_PATH}"
echo ""
echo "Required status checks (must match GitHub check names exactly):"
for check in "${REQUIRED_CHECKS[@]}"; do
  echo "  - ${check}"
done
echo ""
echo "Payload:"
echo "${PAYLOAD}"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--- DRY RUN (--check given) — no changes applied. ---"
  echo ""
  echo "To apply, re-run without --check, or run this gh command manually:"
  echo ""
  echo "  gh api -X PUT '${API_PATH}' \\"
  echo "    -H 'Accept: application/vnd.github+json' \\"
  echo "    --input - <<'JSON'"
  echo "${PAYLOAD}"
  echo "JSON"
  exit 0
fi

# Apply.
echo "Applying ruleset via gh api..."
echo "${PAYLOAD}" | gh api -X PUT "${API_PATH}" \
  -H "Accept: application/vnd.github+json" \
  --input -

echo ""
echo "Ruleset ${RULESET_ID} updated on ${REPO_OWNER}/${REPO_NAME}@${BRANCH}."
echo ""
echo "Verify with:"
echo "  gh api '${API_PATH}' | jq '.rules[] | select(.type == \"required_status_checks\").parameters.required_status_checks'"
