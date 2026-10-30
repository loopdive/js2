---
id: 7188
title: "IR-only test262 lane: present non-numeric programs — internal declarations, string-concat provider, untyped parameter contracts, dynamic globals"
status: in-progress
created: 2026-10-29
updated: 2026-10-29
assignee: ttraenkler/js2-17
priority: critical
horizon: l
feasibility: hard
reasoning_effort: high
task_type: implementation
area: ir, compiler
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 7106
related: [7142, 3518, 3525, 3527]
loc-budget-allow:
  # 2026-10-29 (#7188 S1, after review): +4 lines in a file already over the
  # threshold (1,604). `DeclarationCapture` becomes a `PrimitiveDeclaration |
  # InternalDeclaration` union (two doc lines, the internal arm, the union
  # alias) plus the shared `promiseResult` predicate; the capture, the two
  # join guards and the readers were narrowed in place and two existing gap
  # objects collapsed, which pays for most of it. The union is the review's
  # point (the type checker forces every slot reader to narrow), so it cannot
  # move out of the file that owns the capture.
  - src/compiler/ir-program-presentation.ts
---

# #7188 — IR-only test262 lane: present non-numeric programs

## Problem

`summary.ir_only_pass` has been 2 for weeks. On `origin/main` `3faf62eb45`
the IR-only lane no longer fails at transport: every row reaches the strict
Prepared compiler and is refused by the **presentation contract** in
`src/compiler/ir-program-presentation.ts`, which only presents numeric
programs.

Probe (CI's shard settings, `test/built-ins/Boolean/`, 51 files, ~40 s):

```
TEST262_COMPILER_PATH=ir TEST262_TARGET=standalone TEST262_ORACLE_MODE=honest \
TEST262_PATH_FILTER=test/built-ins/Boolean/ TEST262_CHUNK_TOTAL=1 TEST262_CHUNK_INDEX=0 \
node node_modules/vitest/dist/cli.js run tests/test262-chunk-dynamic.test.ts
```

51/51 `compile_error`, all `compilerPathFailureKind: compilation`:

| fragment (summed) | count | gate |
| --- | --- | --- |
| `complete synchronous numeric or Boolean function declarations are required` | 472 | every function declaration must have number/boolean slots |
| `top-level global storage needs a numeric source classification` | 186 | every top-level `var` must be numeric |

The test262 harness (`assert`, `Test262Error`, `$DONE`, `compareArray`)
takes strings and objects, so no case can be presented.

Takeover note: this is the scope of #7142 (A). A's candidate branch was never
pushed and A did not answer the 00:30Z deadline posted on #6583 at Thomas's
instruction, so this issue carries the work from `origin/main`.

## Implementation Plan

Fast repro loop: the strict wrapper `compile` in
`src/test262/test262-prepared-entry.ts` with
`{ wholeProgram: { kind: "prepared-program-required", version: 1 }, backend: "wasmgc", target: "gc" }`.

- **S1 — internal declarations (this PR).** A synchronous non-exported
  function whose slots are not number/Boolean has no host boundary. Capture it
  as `slots: "none"` (no slot fields at all); the slot/ABI join skips it; an export
  that targets it is refused at the export join, so the gate stays fail-closed.
  Exported declarations keep the primitive host contract unchanged.
- **S2 — untyped parameter contracts.** `src/ir/program-source.ts:1432`
  refuses `function f(v) {…}` with "unresolved parameter contract". Resolve an
  untyped JS parameter to the IR's dynamic carrier where the body is
  claimable.
- **S3 — string-concat provider.** `src/ir/runtime/manifest.ts:2260`: the
  prepared runtime manifest has `concat=unsupported`; select the native
  string-concat provider for the native targets.
- **S4 — dynamic globals.** `ir-program-presentation.ts:317`: a top-level
  `var` that is not exported has no host boundary either; present it with the
  IR's own storage contract, as S1 does for functions.

Quality criterion: each slice narrows an existing gate to the real host
boundary; no parallel presentation path, no second classifier.

## S1 result (2026-10-29)

- `ir-program-presentation.ts`: `DeclarationCapture` is a discriminated union
  on `slots`. `"primitive"` (`PrimitiveDeclaration`) carries `params`,
  `results`, `witParamNames?`, `fulfillment?`; `"none"`
  (`InternalDeclaration`) carries only the source location and name, so every
  slot reader (signature join, export join, `booleanExportSignature`,
  `captureWitExport`, `promiseContractMatches`, `mixed`, `checkMixedDemand`)
  must narrow before it can read a slot. A non-exported all-number helper is
  `"primitive"`.
- `tests/issue-7188-ir-only-presentation-internal-declarations.test.ts` 6/6:
  an untyped helper behind a numeric export is presented and **runs**
  (`main() === 4`) with every direct generator forbidden; an exported untyped
  function is still refused; `export { u }`, `export { u as alias }` and
  `export default u` of an internal helper that `main` calls are refused at
  the export join with its exact message (mutation-checked: reverting that
  guard to `!declaration` fails all three); a numeric-only program is
  unchanged.
- Residual (pre-existing, not changed here): the `exported` predicate is true
  for `export function` inside a `namespace`, so such a member is refused as
  if it were a module export. That fails closed, but S4 must not reuse the
  predicate as written for top-level `var` exports.
- Probe programs: `function id(x){return x}` + numeric export goes from refused
  to prepared (126 B). The next refusals are S2/S3 above.

## S2 probe (2026-10-29, not in this PR)

One-line change in `prepareSourceFunctionSignatures`
(`src/ir/program-source.ts` ~1424): when the propagated parameter type lowers
to nothing (`{ kind: "unknown" }` for helpers called only from module-init, as
every test262 harness helper is), fall through to `checkerScalar` and then
`checkerAny` (the existing dynamic carrier). The parameter contract then
resolves, and the refusal moves to two deeper gates:

- **Physical carrier.** `wasmgc:host physical setup cannot be materialized:
  body ignore params carries non-scalar IR type dynamic; physical carrier
  materialization is not available` — the prepared physical layer has no
  dynamic (externref/anyref) carrier outside host async. This is the #3527
  physical-ledger area (#6925/#6928) and gates S2.
- **Operand lowering.** `ir/from-ast: Phase 1 requires matching operand types
  for '===' in isTrue` — a dynamic `===` against a Boolean is not lowered in
  the prepared path.
- Separately, call sites inside a function propagate a union and hit `arg 0 of
  call to weight is i32, expected union<f64,i32>` (argument coercion into a
  union parameter).

Order: physical dynamic carrier first (it gates every harness helper), then
the S2 fallback, then operand lowering.

