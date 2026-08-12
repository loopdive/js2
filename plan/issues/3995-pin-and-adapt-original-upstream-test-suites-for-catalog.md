---
id: 3995
title: "npm-compat: pin and adapt original upstream test suites for catalog packages"
status: ready
created: 2026-07-30
updated: 2026-08-12
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ci
language_feature: n/a
goal: dogfood
sprint: Backlog
horizon: m
related: [1058, 3587, 3672, 3958, 3982, 3997, 3999, 4000, 4287, 4299, 4301, 4302, 4303]
oracle-ratchet-allow:
  # The Hono fix compares the actual registered Wasm carriers for two inferred
  # anonymous object literals. TypeOracle deliberately exposes only
  # registry-free facts, so it cannot answer whether their concrete typeIdx
  # values match; keep this exact representation query at the codegen seam.
  - src/codegen/literals.ts
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations/import-collector.ts
  - src/codegen/literals.ts
  - src/codegen/index.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/control-flow.ts
  - src/compiler.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/declarations/import-collector.ts::finalizeUnifiedCollector
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/context/create-context.ts::createCodegenContext
---
# npm-compat: pin and adapt original upstream test suites for catalog packages

## Problem

The catalog package tarballs do not ship their original unit suites. The npm-compat page correctly reports upstream suite not shipped; adapter pending, but this needs a tracked path to genuine validation.

Pin matching source revisions and provide adapters for: hono, lodash, axios, react-dom, webpack, uuid, typescript, redux, jest, styled-components, moment, stylelint, three, lit, tailwindcss, and cookie. Keep upstream-suite validation distinct from compile checks, synthetic differential vectors, and benchmark harnesses.

Start with React DOM, Jest, and Lit, which already compile and validate their entry artifacts.

## Provenance

Migrated on 2026-08-01 from a GitHub issue on `loopdive/js2` (opened 2026-07-30)
that was created by an agent in error — this project tracks work as markdown
under `plan/issues/`, not as GitHub issues. The GitHub issue has been closed and
points here. **No content was dropped:** the Problem section above is the
original issue body verbatim.

Metadata below the title is newly assigned and is a **starting estimate, not a
measurement** — `priority`, `horizon` and `feasibility` were not stated in the
original and have not been validated against the corpus. Re-derive before
scheduling.

## UUID v14.0.1 lane (remeasured 2026-08-12)

The UUID adapter is now pinned and runnable at
`pnpm run dogfood:uuid-upstream-suite`. It clones
`uuidjs/uuid@v14.0.1`, verifies commit
`70177807e9229dfacde2038dc1e722f1828f358a`, and runs the ten original
`src/test/*.test.ts` files against the published `uuid@14.0.1` tarball. The
shared `test_constants.ts` fixture is pinned separately. Registration-shaped
`Array#forEach` calls are expanded only by the generic runner so the source
test bodies stay intact; this preserves all dynamically generated cases.

Measured oracle/runtime result on the first mainline merge carrying this lane
and on current main: **75/75 native tests pass; 3/75 admitted tests pass in
Wasm** (exact denominator 75, no harness-incompatible tests). All ten generated
modules compile; nine validate, while `v7.test.ts` emits a `call_ref` operand
type mismatch in `__call_fn_2`. The three passing cases are two parse cases and
the v6 creation-time sort case. The remaining 72 Wasm failures are recorded
individually in `tests/dogfood/report/uuid-upstream-suite.json`, including
illegal casts in v1, null dereferences in validate/version, and assertion
mismatches in vector and crypto paths. The opt-in floor now reflects this
measured mainline baseline; it is not lowered below a result that ever existed
on main. This is runtime evidence, not a compile-only card; the lane remains
open until the compiler/runtime frontier improves.

## Hono, Lodash, and Moment lanes (measured 2026-08-12)

The matching upstream repositories are pinned to immutable commits and their
complete unit inventories are verified before extraction:

- Hono v4.12.16: 120 `src/**/*.test.{ts,tsx}` files and 2,355 measured
  `test`/`it` registration sites. The initial adapter runs all 31 callbacks in
  `utils/accept.test.ts` and `utils/mime.test.ts` against published `dist`.
- Lodash 4.18.1: the complete 27,234-line `test/test.js` source is pinned by
  digest (1,753 QUnit registration sites). Seven complete, self-contained
  QUnit modules contribute 11 unchanged callbacks against the matching
  published modular method files.
- Moment 2.30.1: 190 core/locale unit files and 2,638 measured registration
  sites. Six synchronous core files contribute ten original callbacks against
  published `moment.js`.

The adapters run the same callback text and assertion shim in Node and Wasm.
Deferred files/registration sites remain explicit report fields; they are not
counted as passes or silently removed from the upstream denominator. UUID's
existing 75-test lane is reused unchanged rather than duplicated.

Measured runtime results after the 2026-08-12 compiler fixes:

- Hono: **31/31 native, 31/31 Wasm**. Both selected modules compile and
  validate. The six initial failures were generic compiler defects: an
  incompatible nested object carrier reused across array elements, host-null
  instead of real `undefined` on closure fallthrough, and an untyped JavaScript
  object-default parameter closed to the default object's exact shape.
- Lodash CommonJS: **11/11 native, 11/11 Wasm**. Static top-level `require`
  linking, CommonJS export-object handling, JSDoc `*` parameter preservation,
  mixed callable arrays, and callback/apply lowering are exercised by the
  unchanged selected QUnit modules.
- lodash-es 4.18.1 is a separate catalog lane: its published 308-module ESM
  barrel now compiles to valid Wasm, and the same seven original QUnit modules
  pass **11/11 native, 11/11 Wasm** against the modular ESM implementation. A
  source-qualified ambient-builtin registry prevents `toNumber`'s
  `freeParseInt` alias from being confused with lodash-es's own exported
  three-argument `parseInt` function.
- Moment: **10/10 native, 0/10 Wasm**. All six selected modules compile and
  validate, but the generated callbacks observe a null Moment implementation.
  The exact implementation-versus-adjacent-declaration resolution defect is
  split into #4384.

These are exact selected-slice denominators, not whole-suite pass rates. The
reports retain the larger upstream inventories and deferred counts separately.

## Suspended catalog handoff (2026-08-09)

Work is suspended on `codex/npm-compat-handoff`. The last compiler checkpoint
is `7a50f7fd9a34fd` plus the handoff/config commit that closes #4000. No
parallel worker retained an implementation patch. A fresh manual audit of the
23 pinned catalog entries found **13 compiling and 12 validating**; the
checked-in public report predates the latest long-running probes and must be
regenerated before publication. In particular, a validating re-export barrel
is not evidence that ReactDOM or Lit's implementation works.

| lane | suspended state | owner / next step |
| --- | --- | --- |
| React | 64/64 scored original tests pass; 272/273 admitted | #3958 records the complete result |
| ReactDOM | implementation emits a malformed `updateForwardRef` frame; 0 scored | #3982 |
| jsdom | 318 original API tests accounted for; implementation compile times out at 180.227 s; 0 executed | #4299 |
| Hono | 373,905-byte module validates; route match fails the `#routes` brand | #4301 |
| TypeScript | source graph 82 -> 31 files, but no binary after 300.3 s | #1058 |
| ESLint | selected upstream unit lane passes 44/44; full `lib/api` graph still exceeds the bounded run | resume the scale measurement from #3672 before claiming full ESLint |
| Prettier / Axios | no binary; residual safe async refusal | #4302 |
| Stylelint | explicit `fs enabled` lane reaches five #4302 diagnostics and one #4303 diagnostic | #4000, #4302, #4303 |
| styled-components | compiles; invalid `nt` local type | #3999 |
| webpack / tailwindcss | bounded entry compile does not finish | #4287 |
| Three.js | bounded entry compile does not finish | #3997 |
| UUID | 3/75 original tests currently pass; the v7 suite module is invalid | this issue's UUID section |
| Lit | 8/16 scored; implementation validation remains blocked | #3978 |
| Acorn / clsx / cookie | 3508/3518, 17/18, and 21/21 respectively | existing package-specific issues |
| Redux | runtime workload passes 1/1 | adapter can be expanded to originals |
| Jest / Lodash / Moment | entry compiles and validates; no original-suite score yet | add pinned adapters here |

The npm-compat generator now invokes the Hono, Lodash, lodash-es, UUID, and
Moment upstream runners directly. Pass counts therefore come from a fresh run,
not copied static data. UUID remains **3/75** with exact per-test messages and
is tracked in #4383. Performance regressions remain informational rather than
a gate, per the catalog policy.

## 2026-08-11 resumed compiler progress

The pinned catalog was rerun from current `main` while resuming this umbrella:

- `lit@3.3.3` now compiles to a valid 98,116-byte module after unknown-field
  logical assignment was routed through dynamic property storage (#3978);
- `styled-components@6.4.4` now compiles to a valid 272,297-byte module after
  three generic validation bugs were fixed (#3999);
- neither card has a runtime differential workload yet, so both remain
  correctness-unverified despite validation succeeding.

The full pinned Lit upstream suite was also rerun: 583/587 upstream tests are
admitted, 8/16 scored tests pass, 554 need browser/test infrastructure, and two
implementation files (28 tests total) still emit invalid call operands before
execution. The report also contains 92 invalid per-test batches. #3978 remains
the active owner for that compiler frontier; this umbrella continues to own the
missing consistent runtime adapters and report integration.
