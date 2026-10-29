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
  # 2026-10-29 (#7188 S1): +8 lines in a file already over the threshold
  # (1,604). The `boundary` field and its doc line, the hoisted `exported`,
  # the `internal` predicate and prettier's wrap of the existing refusal
  # condition. The internal capture reuses the existing declaration push and
  # both join guards are one-for-one line swaps, so nothing here can move out.
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
  as `boundary: "internal"` (no slots); the slot/ABI join skips it; an export
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

- `ir-program-presentation.ts`: `DeclarationCapture.boundary` (`host` |
  `internal`), the capture branch, the signature-join and export-join guards.
- `tests/issue-7188-ir-only-presentation-internal-declarations.test.ts` 4/4:
  an untyped helper behind a numeric export is presented and **runs**
  (`main() === 4`) with every direct generator forbidden; an exported untyped
  function is still refused; `export { id }` of an internal helper is refused;
  a numeric-only program is unchanged.
- Probe programs: `function id(x){return x}` + numeric export goes from refused
  to prepared (126 B). The next refusals are S2/S3 above.
