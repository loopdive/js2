---
id: 3409
title: "Pre-push format gate hard-depends on GNU timeout and falsely blocks macOS pushes"
status: ready
created: 2026-07-18
updated: 2026-07-18
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: tooling
language_feature: n/a
goal: developer-experience
sprint: current
related: [914, 1525, 1771, 3102]
origin: "2026-07-18 codebase engineering audit publication preflight (plan/log/2026-07-18-codebase-engineering-audit.md, F8)"
---

# #3409 — make the pre-push format timeout portable

## Problem

The Husky pre-push hook runs the format gate through an unconditional GNU
`timeout` invocation:

```sh
fmt_out=$(timeout 90 pnpm run format:check 2>&1)
```

(`.husky/pre-push:151-170`). Stock macOS does not provide `timeout`, and this
Darwin development host has neither `timeout` nor Homebrew's `gtimeout` on
`PATH`. The command therefore exits 127 before Prettier starts. The hook treats
every nonzero code other than 124 as a genuine format failure and blocks the
push.

This audit reproduced the failure on an otherwise clean planning-only branch:

- pre-push typecheck and lint passed;
- direct `pnpm run format:check` passed;
- direct Markdown Prettier checks passed;
- `git push` stopped at `Pre-push: format:check FAILED` without naming an
  offending file.

The diagnostic is blank because the hook filters captured output to Prettier
warnings and `.ts` paths, hiding the actual `timeout: command not found` error.
The advertised escape hatch, `git push --no-verify`, also bypasses every other
pre-push safety/integrity guard.

## Scope

- Make the 90-second format watchdog work on supported Linux and macOS hosts
  without requiring an undocumented GNU coreutils installation.
- Preserve the intended policy: genuine format failures block, a local watchdog
  timeout fails open to CI, and runner/setup failures are diagnosed accurately.
- Add isolated hook tests for formatter success, formatter failure, timeout, and
  missing watchdog tooling.
- Do not change the repository's formatter or formatting scope.

## Implementation steps

1. Extract the timed-command behavior into a small testable helper, preferably a
   cross-platform Node process runner already available wherever `pnpm` runs.
2. If shell command selection is retained, explicitly probe `timeout` and
   `gtimeout`; when neither exists, run the format check without a watchdog or
   fail open with a clear warning rather than manufacturing a format failure.
3. Preserve and distinguish exit states: formatter nonzero, watchdog expiry,
   command-not-found/setup error, and success.
4. On an unexpected runner error, print the unfiltered captured stderr. Only use
   the warning/path filter as an optional summary after the real failure is
   visible.
5. Add `tests/hooks/pre-push-format-timeout.test.ts` (or the established hook-test
   location) with a synthetic `PATH` that contains neither timeout binary.
6. Document any host prerequisite if the final design intentionally retains an
   external utility.

## Acceptance criteria

- [ ] A normal push on stock macOS reaches and executes `pnpm run format:check`.
- [ ] A correctly formatted branch is not blocked when GNU `timeout` is absent.
- [ ] A real Prettier failure still blocks and names the offending file(s).
- [ ] A watchdog expiry emits the documented warning and defers to CI without
      being mislabeled as a formatting defect.
- [ ] An unexpected runner/setup failure exposes its real stderr and does not
      print an empty `Offending files` section.
- [ ] Linux behavior and the 90-second hang protection remain covered.

## Validation plan

- Hook unit/integration tests with stub `pnpm`, `timeout`, and `gtimeout`
  executables covering exit 0, exit 1, exit 124, exit 127, and a hanging child.
- Run the hook test matrix on Linux and macOS GitHub Actions runners.
- On macOS without coreutils: `pnpm run format:check`, then a dry-run/synthetic
  pre-push invocation; both must pass for formatted input.
- Confirm malformed TypeScript still produces a blocking formatter diagnostic.
- Existing `pnpm run format:check`, typecheck, lint, and issue-integrity gates.

## Dependencies

- No implementation dependency. Coordinate with PR #3355 only if its separate
  pre-git-push LOC hook changes shared hook-test infrastructure.

## Risks

- A hand-rolled shell watchdog can leak child processes or mis-handle signals;
  prefer a small cross-platform process helper with explicit termination.
- Silently removing the timeout can reintroduce the original 300-second push
  hang. The portable fix must retain bounded behavior or clearly fail open.
- Encouraging `--no-verify` as the ordinary macOS path disables unrelated
  privacy and integrity guards, so it is a workaround, not an acceptable fix.
