# Immediate constructor prerequisite on main

Base: `7443ab4826fde65b72f875e0af12337a35520932`; Node22.23.2/macOS.
This is the independently portable constructor prerequisite for held PR5883,
not the captured Promise route, retained-region adapter or whole renderer.

The existing public wrapper delegates to a single immediate helper. Registration,
global reservation, local allocation, publication before seed, and lazy guard
order remain. A private materialized token is consumed synchronously on the
same frame, without an intervening provider call or delayed lifetime.

Intentional correction: cleanup preserves pre-existing liveBodies membership
instead of removing a borrowed outer root, including nested construction and
exception cleanup. Do not claim universal compiler-state byte neutrality.
The helper is explicitly inventoried as unmigrated. No floors, allowances,
original fixtures, or expectations change; no old compiler path is retired.

## Measured main-based comparison

- Same unchanged real-provider observer: all24 cold/reserved and first/repeated
  records match byte-for-byte before/after across six builtin constructors.
- Original25 tests in issue-2984-ctor-carrier-own-props and issue-3006-builtin-
  constructor-identity:24pass/1fail on both arms. All25 names, statuses and
  failure-message arrays match exactly; no exclusions or normalization.
- Eight added extraction cases pass; candidate total32/33. Existing failure is
  the dynamic non-writable-property case, with null exception detail in both
  reports. This does not prove equality of unknown exception values.
- Canonical source TS7 and scoped source-plus-new-test TS7 exit0; four changed
  source/test/inventory files pass Prettier. Initial `pnpm exec tsgo` invocation
  failed because that command is absent; the repository's typescript7 entrypoint
  was then used. Two typechecks briefly overlapped; both terminated normally,
  and no compiler/runtime measurement overlapped them.
- Source review by Hume approved the immediate-only boundary and called out
  the borrowed-membership behavior explicitly.

Full rows, source hashes, and both24-record arrays are preserved in the adjacent
JSON. Original reports/logs and observer remain in `.tmp` in the owned worktree
`/private/tmp/js2-5883-constructor-main-20260927`. Execution handles19405
(baseline) and29402(candidate) both exit1 for the preserved original failure;
1819 and75572 typechecks exit0.

## Remaining larger work

Real immediate-versus-retained constructor correspondence, actual seed-reentry
and declined-seed coverage, semantic provider dependencies and current-main
whole-renderer qualification remain separate requirements for synchronous R.
The published multi-root proof in PR5883 remains pinned to its original subject.
Neither this prerequisite nor those bounded proofs establish full IR parity.
