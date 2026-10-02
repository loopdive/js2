# Main sync and extraction recovery — 2026-09-27

This is a data-only recovery checkpoint in held PR 5883, not a runtime
activation or permission to retire the old compiler. Keep every original
fixture, failure, expectation and conformance floor.

## Exact recovery state

- Upstream `loopdive/js2` main: `688eb4de4184a6f8db74ff1ed73ab9612289e99c`.
  PR 6178 is confirmed merged at that commit; PR 6181 is already included.
- Active worktree: `/private/tmp/js2-5883-main-688-20260927`.
- Branch: `codex/5883-main-688-20260927`.
- Merge commit: `a7c550e38b57b8e5ff8c0f06840d4f12b13a5d4e`.
- Repairs remain dirty/staged there. The shared root was not changed. Previous
  worktrees remain intact; no stash, reset, force push or worktree cleanup.
- The three patches in this directory are a complete snapshot of the source,
  tests, plans and inventory differences against the exact upstream commit
  above, **not incremental patches to apply over an earlier repair archive**.
  Restore in a fresh isolated checkout of that upstream commit and apply each
  once. Preserve the existing live worktree rather than overwriting it.

Patch SHA-256:

- `owned-source-tests.patch.txt`: `6c58165d34e7bf0b1e78d784bb46edaf6b60ac574779276b242d93dbc5f8ec4f`
- `owned-plans-receipts.patch.txt`: `9aff26ad7e45ffccf58842ca673687fc00831d00f34345dff8600bb6635bc25f`
- `inventory.patch.txt`: `bb8a0d40bc043a581fa4141c42ac4095b7976a70ff14f7ec2530294c3e22d6c1`

## Measured validation

- Main sync reapplied all owned repairs without conflicts. The difference in
  `object-runtime.ts` against the preceding repaired tree is exactly main's
  function-constructor prototype cast guard.
- Full source TypeScript check: pass.
- File and function size gates against upstream `688eb4de`: pass. Existing
  allowances remain; none were added by this follow-up.
- Six focused control suites: **38/38 pass**, including all 12 array-length
  tests (the two newer upstream cases remain), 12 class-field policy cases,
  six finalization cases, six spread cases and two length-store cases.
  Report: active worktree `.tmp/main-688-controls.json`, SHA-256
  `62a1b20f6a785348b86f737e2766e06df77bf02213eb257030675fe9b65c1d7d`.
- Final two function extractions: both unchanged test files run in full before
  and after, **29/52 pass and 23/52 fail on each arm**. All per-test statuses,
  fixture hashes and available normalized failure messages match. Details in
  `last-two-extractions.json`. Four failures per arm serialize no exception
  detail: matching status is not proof of equal exception values.
- Both original 512 MB attempts terminated with heap OOM and no usable report.
  Preserve their logs in `/private/tmp/js2-5883-main-sync-20260927/.tmp/`.
  Retry used the existing supported `VITEST_FORK_MAX_OLD_SPACE_SIZE=2048` and
  `VITEST_MAX_FORKS=1` for both arms, without changing tests or timeouts.
- Checker-query growth gate: pass, net `getTypeAtLocation -2`, `ctx.checker -2`.
- Inventory now covers all 1565 tracked modules. All 20 missing helper entries
  remain unmigrated; no clean activation or allowed-edge relaxation. Initial
  classification failed six clean-boundary edges; corrected these three
  entries to migration debt with their intended destination recorded.
  Final status: `inventory-valid-architecture-incomplete`, zero inventory
  errors, **four unknown edges**, graph and architecture incomplete.

## Still blocked — do not represent this source as ready

- Coercion vocabulary gate fails: `number_toString +2`, `__unbox_number +2`,
  `__is_truthy +3`, in `iterator-live-array.ts`,
  `iterator-receiver-to-object.ts`, and `promise-vector-iterator.ts`.
  Use the established conversion machinery; no waiver or baseline relaxation
  was added.
- Dead-export/preservation audit fails: production-rooted moved-runtime
  evidence incomplete and 16 newly unreferenced functions, principally in
  the still-unwired staging foundation. Preserve the actual log at active
  worktree `.tmp/main-688-dead-exports.log`; do not delete required work or
  refresh a baseline merely to make it green.
- Earlier closed-field measurement remains 41/58 runtime passes with 17
  unchanged failures; that population is separate from the 52-row extraction
  check. Full end-to-end IR equivalence is not established.
- Construction-lease follow-up from Russell is frozen and unreviewed, with
  39 newly authored tests unrun. It is not included in these source patches.

## Resume order

1. Preserve one owner for local compiler runs; do not kill live tests.
2. Keep queued PR 6182 unchanged: at the verified snapshot it is queue position
   one with no unresolved review threads; 6183 and 6180 follow it.
3. Fix the measured conversion and production-reachability blockers, then
   rerun their gates and paired unchanged fixtures before a source push.
4. Review the isolated construction-lease patch before testing or integration.
5. Continue provider closure and IR implementation; old compiler retirement
   remains blocked until the new path is complete and demonstrably equivalent.
