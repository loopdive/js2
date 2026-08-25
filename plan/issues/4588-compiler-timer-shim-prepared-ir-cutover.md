---
id: 4588
title: "Prepare the compiler timer shim through exact IR ownership"
status: done
created: 2026-08-21
updated: 2026-08-21
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3518
depends_on: [4573, 4579, 4583, 4584]
related: [1501, 3090, 3519, 3520, 3792, 4573, 4579, 4583, 4584]
assignee: ttraenkler/codex
files:
  - .github/workflows/ci.yml
  - package.json
  - plan/issues/4577-standalone-calendar-retirement.md
  - plan/issues/4583-standalone-ir-cutover-corpus.md
  - plan/issues/4588-compiler-timer-shim-prepared-ir-cutover.md
  - scripts/check-ir-only.ts
  - scripts/ir-kind-neutrality-baseline.json
  - scripts/ir-only-baseline.json
  - scripts/standalone-ir-cutover-corpus.json
  - src/codegen/index.ts
  - src/codegen/ir-imported-call-planning.ts
  - src/codegen/ir-overlay-preparation.ts
  - src/codegen/ir-overlay-safety.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/ir-timer-shim-planning.ts
  - src/codegen/tonumber-fast-paths.ts
  - src/codegen/tonumber-fast-path-flags.ts
  - src/ir/ast-lowering-plans.ts
  - src/ir/backend/handles.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/compiler-timer-shim-preparation.ts
  - src/ir/dynamic-number-lowering.ts
  - src/ir/from-ast.ts
  - src/ir/identity.ts
  - src/ir/injected-timer-shim.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/lowering-dynamic-scratch.ts
  - src/ir/outcomes.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/prepared-component-sealing.ts
  - src/ir/prepared-instruction-support.ts
  - src/ir/prepared-lowering-patch.ts
  - src/ir/promise-delay.ts
  - src/ir/select-identity.ts
  - src/ir/timer-shim-lowering.ts
  - tests/issue-3519-ir-outcomes.test.ts
  - tests/issue-3520-ir-unit-identity.test.ts
  - tests/issue-3520-planning-owner.test.ts
  - tests/issue-4573-standalone-native-promise-delay.test.ts
  - tests/issue-4577-dom-interaction-bridge.test.ts
  - tests/issue-4577-standalone-calendar-retirement.test.ts
  - tests/issue-4588-standalone-timer-shim-cutover.test.ts
  - tests/linear-number-to-string.test.ts
  - tests/standalone-ir-cutover-corpus.test.ts
---
# #4588 — prepare the compiler timer shim through exact IR ownership

## Problem

The exact standalone Async example has five user terminals fully owned by IR,
but import preprocessing also injects an executable `setTimeout` wrapper. Its
compiler provenance is already stable, yet the inventory deliberately records
it as unowned support, so `compileDeclarations` still enters
`compileFunctionBody` and `compileStatement` for that wrapper. Those are the
last two strict physical-body entries in the pinned five-example corpus after
#4584 removed the two residual class-body walker visits.

The shim is injected in both JS-host and standalone compilation. Its identity
must therefore remain target-neutral; a standalone-only inventory exception
would make the same transformed source acquire different semantic owners.

## Scope

- Promote only the compiler-provenanced `timer-shim:set-timeout` function to a
  self-owned `synthetic-support` terminal while preserving its stable UnitId.
- Reuse the checker-backed `isExactInjectedTimerShim` proof. Source spelling,
  comments, or ambient declarations alone never authorize the cutover.
- Plan the exact `env::__timer_set_timeout` call against that terminal and
  lower the wrapper through ordinary AST-to-IR coercion, including callback
  packing, number boxing, and full dynamic `ToNumber` for timer handles.
- Let generic Prepared free-function routing seal and install the exact
  UnitId/Program-ABI callable before either physical body entry can run.
- Keep a default-on kill switch for one release and retain the emitted wrapper;
  defined-function deletion is separate DCE/Program-ABI work.
- Fail closed for user timers, shadows, aliases/escapes, near-miss shims, WASI,
  and multi-source duplicate wrappers.

## Non-goals

- Removing `$setTimeout` from the artifact. Current DCE intentionally roots
  every defined function.
- Broad timer-family migration (`setInterval`, clear functions, scheduler
  intrinsics) or name-based import authorization.
- Treating one clean corpus as proof that `compileDeclarations` or direct
  codegen is globally deletable. #3090 and the optimization-retirement ledger
  remain required.

## Acceptance criteria

- [x] The exact timer shim is a self-owned terminal with stable compiler UnitId
      in both host and standalone inventories.
- [x] Both lanes emit it through IR with zero direct body/statement entries;
      user and near-miss timers retain their established routes.
- [x] A kill-switch control restores both physical entries while producing the
      same valid artifact and runtime behavior.
- [x] The exact five-case physical corpus has no strict body entries and no
      unowned support, with an updated exact manifest/digest.
- [x] Timer, identity, planning, Promise-delay, host/standalone IR-only,
      typecheck, formatting, budget, fallback, and optimization gates pass.

## Completion evidence

The exact five-source manifest now records 47 units: 38 terminals, 9 owned
support units, 0 unowned support units, and 19 derived units. Async remains at
eight total units while moving from 5 terminals / 1 unowned support unit to 6
terminals / 0 unowned support units. The manifest digest is
`sha256:e25d80c90cdd5eb3c6a21672e6d9f3db754ddd4a068d54d5d37b5fee856eb0b7`.
The observed terminal kinds are 26 functions, 2 module initializers, and 10
class members.

Both bounded IR-only lanes now measure 5/5 successful entries and 38/38
emitted IR bodies, with zero legacy bodies, Unsupported outcomes, or
Invariants. A four-cell basename/full-path × default/explicit-IR probe preserves
the exact timer UnitId and records `terminal-ir` with no physical body entries
in every cell. The exact #4588 suite is 21/21 green; the refreshed #3519 plus
corpus tests are 34/34 green, and both post-timer #4577 census assertions pass.

Prepared-body fallback now restores the original free-function-only retry
contract by exact UnitId. Unsupported class and module owners remain
direct-only, compiler timer terminals are excluded from ordinary retries, and
every owner in a rejected timer-connected component carries the typed
`timer-component-not-isolated` outcome so the component falls back atomically.
The unchanged #3520 node-wrapper source now pins the resulting routes: its
unsupported class method is direct-only, its helper retries after direct
emission, and `main` remains IR-only without an unpatched slot. The focused
#3520 identity and planning suites are 38/38 green.

The required `check:standalone-ir-cutover-corpus` package command is wired into
CI with an exact manifest/digest pass followed by the raw-audit gate
`--require-no-legacy --expect-successful 5 --min-sources 5 --min-units 47`.
Both validations pass on the final checkpoint. The production dependency gap
is closed, and independent final review found no remaining architecture
blocker. The bounded corpus result alone does not establish wider compiler
retirement.

The final nine-file changed-root selection is 127/127 green. The eight ordinary
files are 115/115 in the standard isolated worker run; the #4573, "standalone
native Promise-delay compile-once ownership," file is 12/12 when run in the
thread pool under Node's required `--experimental-wasm-exnref` flag. The two
#3520, "IR-only R1: source-qualified unit identity and whole-program ABI map,"
failures from the earlier control are resolved without changing the valid
node-wrapper fixture: one was a stale 6 → 7 terminal census, while the other
exposed the lost free-function retry contract fixed above. The unrelated #1501,
"browser: setTimeout/setInterval/clearTimeout/clearInterval host imports,"
test is byte-for-byte unchanged from the branch base.

Landing validation also keeps the exact compiler timer support terminal out of
the linear backend's attempt-root, legacy-slot, and rejection telemetry. A
user-authored function named `setTimeout` remains an ordinary attempted owner,
so the exclusion is provenance-bound rather than spelling-bound. The IR-kind
neutrality verdicts and ratchets are unchanged; its baseline refresh records
only current evidence-line locations after the timer-cutover source changes.
