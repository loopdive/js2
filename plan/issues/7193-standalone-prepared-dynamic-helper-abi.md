---
id: 7193
title: "IR: bind the carrier's String / in helpers in prepared components on standalone (prepared-dynamic-helper-abi)"
status: in-progress
sprint: current
created: 2026-10-29
updated: 2026-10-29
priority: critical
horizon: s
feasibility: medium
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
related: [7113, 5297]
assignee: "ttraenkler/js2-17"
# 2026-10-29 (#7193): select.ts +3 — the `prepared-carrier-loose-equality`
# member of the inline capability union (kept independent of legality.ts by
# design, #3529 P1) and the one selection-option read beside its sibling.
loc-budget-allow:
  - src/ir/select.ts
---

# IR: bind the carrier's String / in helpers in prepared components on standalone

## Problem

`summary.ir_only_pass` counts hybrid-standalone test262 passes with zero
legacy units. The harness `<module-init>` is the last legacy unit in nearly
every test; with the revived harness stack, one of its two remaining blockers
is `String(message)` in `assert.compareArray`'s member closure, refused on
standalone as `closure-carrier-helper-call`.

The refusal comes from `prepared-dynamic-helper-abi`
(`src/ir/backend/legality.ts`), which was WASI-only: standalone and the
native-first gc lane (projected as standalone) had no symbolic Program ABI ref
for the helpers, so a claimed closure withdrew at preparation.

## Reproduction (origin/main 95648287)

Shape: `subject.f = function (m, k) { if (k === 9) return; <body> };` inside
`<module-init>`, `target: "standalone"`.

| body | origin/main | capability flipped, nothing else |
| --- | --- | --- |
| `var r = m ? m : 1; throw String(r);` | select refusal | resolve withdrawal |
| `throw "x" + String(m);` (not a new shape) | **post-claim withdrawal** (`late-preparation-unsupported`) | same |
| `if (m == 2) …` / `r != "2"` | select refusal | resolve withdrawal |
| `if ("a" in m) …` | select refusal | resolve withdrawal |

With the capability flipped, the first unnameable instruction blocks the whole
unit's sidecar in `prepareDynamicInstructionSupportForUnits`, so every helper
of the unit then reports `unplanned-abi-binding`. The real gaps were:

- `dyn.to_string` (from `String(<carrier>)`) — no arm;
- `tag.test` Object / Function (from `in`'s receiver check, `lowerNativeIn`) —
  only Undefined / Null were named;
- loose `dyn.eq` — no arm.

## Implementation Plan

**Module.** `src/ir/prepared-dynamic-support.ts` only, plus the capability in
`src/ir/backend/legality.ts` and the selector seam that reads it.

**Reuse.** Every new binding goes through the existing `bindExact` →
`exactPreparedDynamicHelperRef`, naming the same symbol the host-carrier arm of
`makeDynamicLowering` (`src/ir/integration.ts`) calls:

- `dyn.to_string` → `__extern_toString` `(externref) → externref` (the
  native-string re-tag after it calls nothing). Folded into the existing
  `dyn.truthy` / `dyn.typeof` / strict `dyn.eq` arm, not a new arm.
- `tag.test` Object → `__typeof_object`, Function → `__typeof_function`,
  `(externref) → i32`. The single `Undefined` special case becomes a
  `TAG_TEST_HELPERS` table, so the three partitions share one arm.

**Capability.** `prepared-dynamic-helper-abi` becomes true on standalone and
WASI (non-fast wasmgc). It now guards `String(<carrier>)` and `in`.

**Fail-closed for loose equality.** Measured with the capability on: a loose
`==` / `!=` on the carrier claims, but standalone's `__extern_loose_eq`
(`__any_from_extern` + `__any_eq`) skips the ToPrimitive step legacy's inline
arm performs:

- `{ valueOf() { return 2 } } == 2` traps on an illegal cast;
- `[2] != "2"` answers `true`.

The same bug exists on origin/main for an ordinary standalone IR function
(`function g(m: any) { return m == 2 }` traps). So loose equality gets its own
capability, `prepared-carrier-loose-equality`, which stays WASI-only (exactly
the old behaviour). The walk reads it at the only site a loose operator reaches
(`in` returns earlier). No `__extern_loose_eq` binding is added: nothing would
reach it.

**Duplicate removed.** The `Undefined`-only tag.test branch is replaced by the
table; no new predicate or arm is added.

**Acceptance.**

- Correctness: `String(<carrier>)` and `in` are claimed with zero post-claim
  errors on standalone. IR = legacy = node on primitives, `null` / `undefined`,
  objects with `toString` / `valueOf`, arrays and symbols. For `in` on a
  primitive, IR throws the TypeError node throws (legacy answers `false`).
- Fail-closed: carrier loose `==` / `!=` stays refused at select on standalone.
- WASI byte-identical. gc changes only where the native-first gc lane now
  claims `String(<carrier>)`; the playground examples stay byte-identical on
  gc.
- Code quality: no new arm, no new helper, no dead parameter. One table
  replaces a special case.

## Follow-ups (need ids — `claim-issue.mjs --allocate` had no open-PR scan in this container)

1. Standalone `__extern_loose_eq` must ToPrimitive an object operand like
   legacy's inline loose equality (`src/codegen/any-helpers.ts`
   `ensureExternLooseEqHelper`). Once fixed, flip
   `prepared-carrier-loose-equality` (and re-check
   `native-dynamic-loose-equality`, whose standalone claim is false today).
2. IR `"" + <carrier holding a Symbol>` answers `"Symbol()"` instead of
   throwing a TypeError (pre-existing on origin/main; legacy throws).
3. Cleanup (review nit): `exactPreparedDynamicHelperRef` and its helper-name
   union live in `compiler-timer-shim-preparation.ts` with a timer-shim name
   (`PreparedTimerDynamicHelperName`) but serve every prepared dynamic unit.
   Move them next to `prepared-dynamic-support.ts`. That is its own change,
   because the timer-shim import graph moves with it.

## Review (adversarial, fresh context, 2026-10-29)

No blocking findings. The helper names match the `makeDynamicLowering` arms,
the capability split is consistent at every read site, and there is no
fail-open path (a missing binding withdraws at preparation). Nits fixed:

- the host-carrier arm's nested ternaries became the `HOST_CARRIER_HELPERS`
  table, the same shape as `TAG_TEST_HELPERS`;
- the table value types reuse `exactPreparedDynamicHelperRef`'s name type.

Module-placement nit: filed as follow-up 3. The "gc changes" point is
intended: the native-first gc lane projects as standalone and now claims
`String(<carrier>)`.

## Test Results (2026-10-29, base origin/main 95648287)

- `tests/issue-7193-standalone-prepared-dynamic-helper-abi.test.ts`: 9/9.
- `tests/issue-7106-*` + `tests/issue-5297-*` (39 files): head has the same 4
  failures as base, all `semanticProviders: "host-assisted"` compile errors
  (option removed by #6979). Two `issue-7106-member-closure-shapes` rows
  were updated on purpose: `String(<carrier>)` is now claimed on standalone and
  gc, and the `in` row moved out of the refused set. That file: 62/62.
- No `tests/issue-7113*` files exist; #7113's rows live in
  `issue-7106-member-closure-shapes`.
- Playground examples: 26/26 byte-identical on gc and standalone. The probe
  shapes are byte-identical on WASI.
- Scoped standalone test262 (`built-ins/Math/abs`, `built-ins/Boolean`, 59
  files): 57 pass on base and on head, 0 pass→fail.
- Real `assert.compareArray` closure: the `closure-carrier-helper-call`
  refusal on `String(message)` is gone. It then reaches the pre-existing
  build failure "direct call to `assert` has no exact AST-site plan" (a
  post-claim error), which shows up on head with `String(message)` replaced by
  `message` as well. That is the other harness blocker, owned by another lane.
- Gates: loc / func budget (with `LOC_GATE_BASE=origin/main`),
  coercion-sites, oracle-ratchet, dead-exports, `check:ir-fallbacks`,
  `check:host-import-policy`, `check-standalone-arms`, and `typecheck` are all
  green.
