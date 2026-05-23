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
#   - GitHub's "branch protection" surface has two APIs:
#       (a) Legacy /repos/:owner/:repo/branches/:branch/protection  (PUT)
#       (b) Newer /repos/:owner/:repo/rulesets                       (POST/PUT)
#     We use (a) because it's still fully supported, accepts a single PUT,
#     and matches what existing js2wasm tooling references.
#   - Required-check names below MUST match the GitHub job names exactly.
#     Update `docs/ci-policy.md` and this file together when adding checks.
#
set -euo pipefail

REPO_OWNER="${REPO_OWNER:-loopdive}"
REPO_NAME="${REPO_NAME:-js2wasm}"
BRANCH="${BRANCH:-main}"

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
# -----------------------------------------------------------------------------
REQUIRED_CHECKS=(
  "cheap gate (main-ancestor + lint)"    # test262-sharded.yml — fast pre-flight reject
  "merge shard reports"                  # test262-sharded.yml — authoritative test262 gate
  "quality"                              # ci.yml — lint, format, typecheck, IR budget
)

# Build the JSON payload. We use printf into a heredoc-style buffer rather
# than a real heredoc so the embedded JSON is straightforward to read.
#
# Schema reference (legacy protection API):
#   https://docs.github.com/en/rest/branches/branch-protection#update-branch-protection
build_payload() {
  local contexts_json
  contexts_json=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R . | jq -s .)

  jq -n \
    --argjson contexts "$contexts_json" \
    '{
      required_status_checks: {
        strict: true,
        contexts: $contexts
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        required_approving_review_count: 1,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        require_last_push_approval: false
      },
      restrictions: null,
      required_linear_history: false,
      allow_force_pushes: false,
      allow_deletions: false,
      block_creations: false,
      required_conversation_resolution: true,
      lock_branch: false,
      allow_fork_syncing: false
    }'
}

PAYLOAD="$(build_payload)"

API_PATH="/repos/${REPO_OWNER}/${REPO_NAME}/branches/${BRANCH}/protection"

echo "Branch-protection target:"
echo "  repo:   ${REPO_OWNER}/${REPO_NAME}"
echo "  branch: ${BRANCH}"
echo "  API:    PUT ${API_PATH}"
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
echo "Branch protection updated on ${REPO_OWNER}/${REPO_NAME}@${BRANCH}."
echo ""
echo "Verify with:"
echo "  gh api '${API_PATH}' | jq '.required_status_checks.contexts, .enforce_admins, .allow_force_pushes'"
