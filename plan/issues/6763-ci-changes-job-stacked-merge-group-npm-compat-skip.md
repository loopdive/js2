---
id: 6763
title: "CI: ci.yml `changes` classifies only the top PR of a stacked merge group, so an npm-compat refresh on top skips equivalence-gate for the stack"
status: ready
sprint: Backlog
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: s
feasibility: easy
task_type: bug
area: ci
goal: ci-hardening
requested_by: ttraenkler/claude-lead
related: [6762, 3988, 3914]
---

# The `changes` job in `ci.yml` has the #6762 defect

## Symptom (predicted from the code, not yet observed in a run)

#6762 fixed `test262-sharded.yml`: a stacked merge group whose top entry is an
npm-compat artifact refresh skipped every test262 shard, went green, and merged
the failed entries beneath it. #6762's "Not covered" section named `ci.yml` as
a likely second instance. Reading it confirms it.

`.github/workflows/ci.yml`, job `changes`:

```yaml
- name: Classify and validate an npm-compat artifact-only change
  id: npm_compat
  run: node scripts/check-npm-compat-promotion.mjs --base HEAD^ --github-output "$GITHUB_OUTPUT"
- id: detect
  ...
  if [ "$NPM_COMPAT_ONLY" = "true" ]; then
    echo "code=false" >> "$GITHUB_OUTPUT"; exit 0
  fi
  if [ "$EVENT" != "pull_request" ]; then echo "code=true" ...
```

In a `merge_group` the checked-out commit is the group head, and `HEAD^` is the
head of the entry ahead of it, not `main`. When the top entry is the
`ci/npm-compat-refresh` PR, `HEAD^..HEAD` holds only the six npm-compat JSON
files, `NPM_COMPAT_ONLY=true`, `code=false`, and every job gated on
`needs.changes.outputs.code` (the equivalence shards behind the required
`equivalence-gate`, `linear-tests`, …) skips for the whole stack. The
`merge_group` short-circuit to `code=true` is never reached because the
npm-compat branch returns first.

## Fix

Same shape as #6762: in a `merge_group`, resolve the base branch tip
(`github.event.merge_group.base_ref`) and pass it as `--base` to
`check-npm-compat-promotion.mjs` (so the classifier sees the whole stack's
diff), or evaluate the npm-compat shortcut only for `pull_request`. An
unresolvable tip must fail safe (`code=true`).

## Acceptance

- A stubbed-`git` test in the style of `tests/test262-per-lane-gating.test.ts`
  ("#6762" block) runs the real `changes` step body: an npm-compat-only entry
  stacked on a `src/` change yields `code=true`; the same entry built directly
  on `main` still yields `code=false`.
- `.github/workflows/*.yml` has no other `merge_group` path classifier that
  diffs against `HEAD^` or `merge_group.base_sha` alone (grep and list the
  result in this file).
