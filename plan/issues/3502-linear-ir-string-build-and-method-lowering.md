---
id: 3502
title: "Lower landing string construction and char methods through shared IR"
status: done
completed: 2026-07-23
sprint: 75
created: 2026-07-20
updated: 2026-07-20
priority: high
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir, strings, codegen-linear, porffor
goal: backend-agnostic-ir
depends_on: [3497, 3499, 3501]
related: [2956, 3498]
origin: "#3498 post-#3497 exact string-hash native-route probe"
loc-budget-allow:
  - src/codegen-linear/index.ts
  - src/codegen-linear/runtime.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/nodes.ts
---

# #3502 — Shared string build and character methods

## Problem and evidence

Exact `website/public/benchmarks/competitive/programs/string-hash.js` passes
JSDoc signature selection after #3497. The shared builder then rejects its
first `text += ...` with:

```text
ir/from-ast: compound assign to non-f64 slot "text" (i32) not in slice 6 (run)
```

The direct linear fallback has no `charAt` or `charCodeAt` method arm. These
are representation/lowering gaps, not benchmark support cells. The source is
not to be rewritten.

## Root cause

- `string.const`, `string.concat`, and `string.len` already exist in typed IR,
  but compound assignment decides from the slot carrier alone and accepts only
  scalar `f64`. In the linear lane a semantically-string local is carried as
  `i32`, so lowering must combine checker/producer evidence with that carrier
  rather than treating the carrier as the JavaScript type.
- `from-ast.ts` currently represents string methods as backend-selected helper
  calls. The linear resolver recognizes only `charCodeAt` and `slice`, while
  the Porffor legality/backend cannot consume the linear helper call. The
  source-derived module therefore has no backend-neutral char operation for
  both linear consumers.
- Linear strings already use the `string:utf8-bytes-v1` layout and helpers.
  `charAt` and `charCodeAt` are specified over UTF-16 code units, including
  surrogate halves and distinct out-of-range results (`""` versus `NaN`).
  This issue does not replace that representation. The exact benchmark's
  literals, `charAt` results, and concatenations are closed ASCII, which
  `analysis/encoding.ts` can prove. The first shared native claim is therefore
  gated on ASCII; non-ASCII and lone-surrogate inputs reject with a stable
  diagnostic until a separately tested general representation slice exists.

The existing `__linear_ir_str_char_code_at` helper is useful evidence but is
not the shared solution: it is a linear-Wasm helper selected by name and does
not give the Porffor emitter a typed operation. No prior attempt lowered the
untouched benchmark through the source-derived Porffor route.

## Implementation plan

### Slice 1 — disjoint semantic/lowering/runtime contract

1. Define exact typed evidence for non-coercive `string += string`, `charAt`,
   and `charCodeAt`, including omitted-index and numeric-type requirements.
   Keep JavaScript semantic evidence from checker/producer state separate from
   the backend carrier so an `i32` linear slot can still be proven string.
2. Define a backend-neutral string emitter contract and symbolic runtime
   operations, bound to the source-derived `LinearMemoryPlan` layout and
   allocation-site decisions without Wasm instructions, Porffor enums, C, or
   runtime symbol names.
3. Freeze UTF-16 index/bounds semantics in focused reference tests. Reuse the
   existing encoding lattice and linear layout, accepting only proven ASCII in
   this backend slice and testing stable rejection for broader encodings. Keep
   the exact initial rejection as evidence until producer wiring lands.

### Slice 2 — shared producer and backend wiring

1. After #3501 releases `src/ir/from-ast.ts`, lower typed string `+=` to the
   existing `string.concat` instruction and add typed `string.char_at` and
   `string.char_code_at` instructions for static string receivers.
2. Route all string instructions through `StringBackendEmitter` rather than
   `pushRaw`. Preserve the WasmGC/native-string behavior and reject dynamic,
   coercive, or prototype-overridden cases before claim.
3. Bind linear-Wasm to symbolic runtime operations and the exact existing
   `LinearMemoryPlan` layout/helpers. Preserve `charAt` empty-string bounds and
   `charCodeAt` NaN bounds. Reject unproven/non-ASCII encodings; do not claim
   general Unicode execution without tests through both linear Wasm and
   Porffor native.
4. After #3501 releases `src/ir/backend/porffor/assembler.ts`, lower the same
   planned string layout and operations to Porffor IR nodes. Do not emit RawC,
   use Porffor-native object/string layouts, or statically import the optional
   renderer.

### Slice 3 — exact-source four-lane acceptance

1. Compile the untouched landing file and assert the exact source-derived
   `IrModule` and `LinearMemoryPlan` contain `run` with no rejection or direct
   fallback.
2. Compare representative outputs across Node, JS2 WasmGC, shared linear Wasm,
   and the exact `(IrModule, LinearMemoryPlan)` lowered through Porffor IR to C.
3. Stress the JS2-to-Porffor native executable under ASan/UBSan and retain
   source hash, IR operation, plan, and sanitizer evidence.

## Acceptance criteria

- [x] Exact `string-hash.js` reaches Node-equal, sanitizer-clean native
      execution from shared source-derived IR with no source rewrite.
- [x] Node, JS2 WasmGC, shared linear Wasm, and JS2 IR/plan → Porffor IR → C
      agree for representative inputs including `0`, `1`, `100`, and `20000`.
- [x] Typed string append, `charAt`, `charCodeAt`, bounds, omitted indices, and
      UTF-16 code units are explicit in the semantic IR contract. The first
      backend claim is proven ASCII; broader encodings reject stably unless
      exercised through both linear Wasm and Porffor native.
- [x] Linear allocation/layout decisions come only from `LinearMemoryPlan`.
- [x] Porffor remains optional; no RawC, benchmark-name special case, second
      parser, or Porffor-specific planner vocabulary is introduced.
- [x] Existing string, linear-memory, WasmGC, and Porffor tests remain green.

## P1 audit correction — control-flow soundness

The initial production wiring read identifier encoding evidence from mutable
scope metadata, but branch and loop lowering did not conservatively merge that
metadata. An ASCII-initialized local could therefore retain stale `ascii`
evidence after a conditional assignment from an unproven string parameter.
Both linear consumers would then accept the same invalid typed operation.

- Structured statement, expression, loop, and exceptional-flow bodies now
  lower against independent scope snapshots. Every reachable continuation
  joins encoding facts with the existing lattice; an unproven predecessor is
  conservative top and therefore kills narrower ASCII evidence.
- Loop headers compute a real finite-lattice fixed point over possible writes.
  This covers loop-carried cross-variable dependencies such as
  `text = other; other = input`, where widening `other` on one pass must widen
  `text` on the next. Nested functions remain separate scopes.
- Ternary, nullish, and logical short-circuit RHS/arms use the same independent
  snapshots and joins. Current selection conservatively rejects the audited
  else/ternary/short-circuit source shapes; the lowering is sound when those
  shapes are admitted later.
- The exact benchmark remains provably ASCII because every loop-carried write
  is an append of ASCII-proven producers. This correction does not broaden the
  Porffor Unicode claim or replace the established linear string layout.

## Implementation outcome

- Checker and producer facts now prove semantic string values independently of
  their `i32` linear carrier. Proven non-coercive `+=`, `charAt`, and
  `charCodeAt` lower to typed shared IR; unresolved or dynamic cases retain the
  established conservative fallback/rejection behavior.
- `StringBackendEmitter` carries the shared operations through WasmGC, linear
  Wasm, and Porffor. Porffor lowers them to ordinary typed allocation,
  load/store, copy, and control-flow nodes without `RawC`.
- Both linear consumers bind the existing `string:utf8-bytes-v1` layout from
  the source-derived `LinearMemoryPlan`. The header keeps its payload-size
  meaning; owned append adds geometric capacity without changing the public
  representation or invalidating aliases.
- The backend execution claim is gated by `analysis/encoding.ts` evidence.
  Proven ASCII executes; broader UTF-8/non-ASCII inputs reject with the stable
  diagnostic `ir/linear-string: ASCII encoding proof required for constant
  result (got utf8-guaranteed)`. The semantic reference contract remains
  UTF-16-code-unit correct for indexing, omitted indices, and bounds.

## Runner integration

The landing four-lane runner from #3498 is the origin and downstream consumer
of this issue, so that relationship remains explicit in frontmatter. Final
validation is based on `origin/main@f26fb333510137fee6b0108d2ff94a1f80326e83`,
which merged runner PR #3452, while retaining the landed #3499 bitwise and
#3501 array/shared-file dependencies. The exact-source acceptance test here
proves the formerly blocked string cell independently of benchmark timing.

## Test results

- Untouched source identity: 601 bytes, SHA-256
  `66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c`.
  Node, JS2 WasmGC, shared linear Wasm, and source-derived Porffor native agree
  for inputs `[0, 1, 100, 20000]` with outputs
  `[0, 96500, 36729899, 862771296]`.
- `JS2WASM_PORFFOR_ROOT=<this-worktree>/vendor/Porffor
  PORFFOR_NATIVE_REQUIRED=1 PORFFOR_NATIVE_SANITIZERS=1 pnpm exec vitest run
  tests/issue-3502-string-hash-four-lane.test.ts` — 3/3 passed on merged HEAD
  `10a01a0d1` in 11.98 seconds. The native assertion passed in 2.179 seconds.
  Clang used combined ASan/UBSan; both exact-source and ASCII method
  executables exited zero with no sanitizer diagnostics.
- ASCII method execution agrees across Node, WasmGC, linear Wasm, and native C
  for indices `[-1, 0, 1, 2]` plus omitted index, producing
  `[777, 1065, 1122, 777, 1065]` and covering empty-string versus `NaN` bounds.
- Required final command with `JS2WASM_PORFFOR_ROOT=$PWD/vendor/Porffor`,
  `PORFFOR_NATIVE_REQUIRED=1`, and `PORFFOR_NATIVE_SANITIZERS=1` — both #3502
  files passed, 10/10 tests in 16.63 seconds. The native Porffor C assertion
  passed in 2.783 seconds with combined ASan/UBSan and no diagnostics.
- `tests/issue-3502-string-contract.test.ts` — 7/7 passed. The added P1 audit
  regression proves the conditional and loop-carried cases contain no stale
  typed ASCII character instruction and return the JavaScript result `1` for
  input `"é"` through shared linear Wasm. Source-derived Porffor lowering
  rejects the unresolved general helper instead of consuming invalid ASCII
  evidence; else, ternary, and short-circuit shapes reject at selection.
- The focused native/linear string regression set passed 118/118. Adjacent
  backend-contract, linear-IR, encoding-analysis, and #2134 coverage passed
  44/44.
- Focused #3502 plus native-string regressions — 100/100 passed. Adjacent
  backend-contract, linear, layout, encoding, and #2134 coverage — 58/58
  passed.
- The landed #3498 native-route support probe passes with all four JS2 native
  cells supported and sanitizer-clean after updating its formerly-blocked
  #3502 expectation. The full adjacent runner file otherwise passes 11/12
  locally; its capture-resume case stops at the intentional toolchain guard
  because local Rust is 1.93.1 while the runner pins 1.94.1.
- The focused #3498 native support probe was rerun after the P1 correction and
  passed 1/1 (11 unrelated tests filtered) in 55.79 seconds.
- `pnpm run typecheck`, `pnpm run lint`, and `pnpm run format:check` passed on
  the merged head.
- `check:pushraw`, `check:ir-fallbacks`, `check:linear-ir`,
  `check:stack-balance`, `check:issue-spec-coverage`, `check:issues`,
  `check:issue-ids:against-main`, and `check:loc-budget` passed. Linear IR
  improved to 10 compiled units from the baseline 8; pushRaw has six fewer
  call sites and no additions.
- `check:godfiles` reports six landed-main regressions in
  `src/codegen/expressions/calls.ts`, `src/codegen/index.ts`,
  `src/codegen/object-runtime.ts`, and `src/codegen/array-methods.ts`. None of
  those files differs in the #3502 change set versus `origin/main`; the issue
  does not refresh the shared profile. No full local Test262 run was required.
