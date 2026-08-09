---
id: 3408
title: "Retire non-atomic issue-ID entrypoints and stale collision-remediation guidance"
status: done
completed: 2026-07-23
created: 2026-07-18
updated: 2026-07-19
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: tooling
language_feature: n/a
goal: developer-experience
sprint: 75
related: [2530, 2531, 2943, 2974, 2977]
origin: "2026-07-18 codebase engineering audit (plan/log/2026-07-18-codebase-engineering-audit.md, F4)"
---

# #3408 — retire non-atomic issue-ID entrypoints

## Problem

The repository mandates atomic ID allocation through:

```text
node scripts/claim-issue.mjs --allocate
```

because optimistic `max + 1` selection races with open PRs and concurrent
agents, and collisions surface only in `merge_group`. Yet the shortest,
canonical-looking package command still invokes the deprecated predictor:

```json
"new:issue-id": "node scripts/next-issue-id.mjs"
```

(`package.json:78-81`). The safe alias is less discoverable:
`new:issue-id:allocate` (`package.json:157-160`).

`scripts/next-issue-id.mjs:12-24` explicitly says it does not reserve and does
not scan open PRs. The merged-tree collision check nevertheless tells users to
repair a collision with that deprecated script
(`scripts/check-merged-issue-integrity.mjs:160-166`). Stale agent context also
describes it as reliable allocation guidance.

The failure path therefore sends contributors back into the same race that the
#2531 allocator and CI gate were built to eliminate.

## Scope

- Make the canonical `new:issue-id` command perform atomic allocation.
- Retain a non-mutating predictor only under an explicit preview name.
- Replace all active remediation and agent guidance that recommends
  `next-issue-id.mjs` for allocation.
- Add a cheap static contract test so aliases/messages cannot drift back.
- Do not redesign the allocator or its orphan-ref locking protocol.

## Implementation steps

1. Change `pnpm run new:issue-id` to call
   `node scripts/claim-issue.mjs --allocate`.
2. Rename the old behavior to an honest command such as
   `preview:issue-id`; keep `scripts/next-issue-id.mjs` only as the documented
   read-only preview implementation if it still has a user.
3. Update collision diagnostics in
   `scripts/check-merged-issue-integrity.mjs` and any other active checker to
   recommend the atomic allocator.
4. Update current agent/developer context. Historical logs may retain old
   commands when clearly historical; active operating instructions may not.
5. Add a no-network static test that parses `package.json` and checker messages:
   canonical creation aliases/remediation must contain
   `claim-issue.mjs --allocate`, while preview aliases must be labeled preview.
6. Document that the canonical command mutates the reservation ref so users who
   only want visibility choose the preview command deliberately.

## Acceptance criteria

- [ ] `pnpm run new:issue-id` atomically reserves against main, open PRs, and
      the issue-assignments ref.
- [ ] A clearly named preview command remains available without pushing a
      reservation, if preview behavior is still needed.
- [ ] No active checker, agent instruction, or package alias recommends
      `next-issue-id.mjs` as an allocator or collision repair.
- [ ] Static tests fail if canonical aliases/remediation regress to the
      non-reserving predictor.
- [ ] Existing `claim-issue.mjs --allocate` concurrency and dry-run tests remain
      green.

## Validation plan

- Package-script contract test and checker-message unit test.
- `node scripts/claim-issue.mjs --allocate --dry-run --no-pr-scan` for a
  non-mutating smoke test.
- Existing allocator/issue-ID test suites and `pnpm run check:issues`.
- `pnpm run check:issue-ids:against-main` on a clean branch and a synthetic
  colliding fixture.
- Formatting and typecheck (where applicable).

## Dependencies

- Builds on #2531's allocator and #2530's merged-state gate.
- #2943/#2974/#2977 own allocator robustness under API failure/contention; this
  issue changes entrypoints and guidance only.

## Risks

- Existing users may assume `new:issue-id` is read-only. The command rename and
  documentation must call out that it now creates a reservation.
- Tests must not reserve real IDs. Use static assertions and allocator dry-run
  modes only.
- Do not remove the preview script until all legitimate read-only callers are
  identified; the defect is misleading allocation guidance, not the existence
  of a preview tool.
