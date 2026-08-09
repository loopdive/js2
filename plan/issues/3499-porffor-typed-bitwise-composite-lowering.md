---
id: 3499
title: "Lower typed JavaScript bitwise composites through the Porffor backend"
status: done
completed: 2026-07-23
sprint: 75
created: 2026-07-20
updated: 2026-07-20
pr: 3447
priority: high
horizon: m
complexity: L
feasibility: hard
reasoning_effort: max
task_type: bug
area: ir, porffor, codegen-linear
language_feature: javascript-bitwise-operators
goal: backend-agnostic-ir
depends_on: [3497]
related: [1584, 1850, 2953, 3288, 3497, 3498]
origin: "2026-07-20 explicit user request to unblock exact landing-page fib.js through JS2 typed SSA and Porffor-C"
files:
  - src/ir/lower.ts
  - src/ir/backend/emitter.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/bytecode-emitter.ts
  - src/ir/backend/contract-conformance.ts
  - src/ir/backend/linear-emitter.ts
  - src/ir/backend/wasmgc-emitter.ts
  - src/ir/backend/porffor/sink.ts
  - tests/issue-3288.test.ts
  - tests/issue-3499-porffor-typed-bitwise-composites.test.ts
---

# #3499 — Porffor typed JavaScript bitwise composites

## Problem

The shared typed SSA represents JavaScript `&`, `|`, `^`, `<<`, `>>`, and
`>>>` as `js.bitand`, `js.bitor`, `js.bitxor`, `js.shl`, `js.shr_s`, and
`js.shr_u`. Their existing composite lowering correctly implements JavaScript
`ToInt32` and result conversion for WasmGC/linear, but it emits the constituent
instructions through `BackendEmitter.pushRaw`. Porffor deliberately rejects
the six operations in legality before that lowering because its symbolic sink
cannot accept raw Wasm.

After #3497 resolves the JSDoc signature of the exact landing `fib.js`, its
`(a + b) | 0` reaches this boundary and cannot proceed from shared IR to
Porffor IR and native C.

## Root cause

The operation is composite in the shared lowerer but only partly represented
by the backend contract. Ordinary arithmetic and unary operations already have
typed emitter methods. The scalar constants, numeric conversions, and final
native i32 bitwise step were still encoded as raw Wasm instructions. This made
the semantics reusable in source code but not in the backend contract.

Special-casing `fib`, rewriting its source, or introducing a Porffor-only IR
node would hide the missing contract operation and leave the other bitwise and
shift variants broken. Emitting direct C would also bypass Porffor's typed IR,
effect sequencing, and sanitizer-visible conversion helpers.

## Implementation plan

1. Add narrow typed scalar-constant, numeric-conversion, and i32-bitwise
   operations to the backend emitter contract.
2. Express the existing shared `ToInt32` composite entirely through those
   typed operations, preserving its exact WasmGC/linear instruction stream.
3. Map the operations to Porffor `Const`, `Convert`, and `Bin` nodes. Mask every
   shift count with `31`, perform left shift in the unsigned domain to avoid C
   signed-overflow UB, and preserve unsigned `>>>` result conversion.
4. Keep bytecode's legality boundary unchanged and fail loudly if the new
   contract methods are ever reached outside its admitted subset.
5. Cover every variant, both mixed f64/i32 directions, narrowed i32 chains,
   exact emitted Wasm/linear parity, no `RawC`, and native coercion edges under
   ASan/UBSan.
6. After #3497 lands on `origin/main`, merge that landed main and validate the
   exact checked-in website `fib.js` from source through shared IR and its
   `LinearMemoryPlan` into Porffor-C, comparing outputs with Node.

## Acceptance criteria

- [x] All six JavaScript bitwise/shift composites are legal for Porffor and
      lower through typed backend operations only.
- [x] Mixed f64/i32 operands and narrowed i32 chains preserve JavaScript
      coercion and signedness, including unsigned `>>>` results.
- [x] Every generated C shift is unsigned and count-masked; left shift avoids
      signed overflow and signed right shift uses an explicit sign-fill mask.
- [x] WasmGC and linear instruction streams remain identical and bytecode's
      unsupported-op boundary remains unchanged.
- [x] The exact checked-in landing `fib.js` reaches JS2 linear IR/shared
      `LinearMemoryPlan`, Porffor IR, and native C after landed #3497 is merged;
      native outputs equal Node under ASan/UBSan.
- [x] Focused tests, typecheck, lint, format, IR fallback, and linear-IR checks
      pass on the final landed-main merge.

## Implementation notes

The new emitter operations are intentionally smaller than an `Instr` and are
not a second IR. `lower.ts` remains the single owner of JavaScript coercion:
truncate, reduce modulo 2^32, saturating-convert to the i32 bit pattern, apply
the native operation, then convert signed or unsigned i32 back to f64 only when
the SSA result was not already narrowed.

Porffor maps `i32.trunc_sat_f64_u` through its range-aware conversion node with
the range-known flag clear. That detail matters for `NaN` and infinities:
Porffor uses its defined conversion helper rather than an undefined raw C
float-to-integer cast. `i32.shl` converts its left operand to u32 before `<<`
and converts the bit pattern back to i32 afterward. Signed right shift is also
reconstructed from logical u32 shift plus an explicit sign-fill mask, avoiding
C's implementation-defined `negative_i32 >> count`. Every generated C shift
therefore has u32 operands, and every dynamic shift count is masked by `0x1f`;
counts such as 0, 32, and 63 are defined without relying on target behavior.

## Exact-source evidence

PR #3446 landed on `origin/main` as
`e78ef504f0b62d339d994181d5a27981124d1d6a` and was merged into this branch
before the source-derived proof was added. The test reads
`website/public/benchmarks/competitive/programs/fib.js` directly as bytes and
asserts 348 bytes plus SHA-256
`910ab9ef86bf7ed4c6b7e55c0fe20d93b653dd8bfdb5d48de6ef906778943a73`.
It performs no source rewrite or substitution.

Compiling those bytes with `target: "linear"`,
`allocator: "analysis-stack"`, and the exact path selects only `run`, reports
no rejection, and publishes the source-derived typed module plus its
`analysis-stack-arena-v1` `LinearMemoryPlan`. The module contains both expected
`js.bitor` composites. That same module and plan are passed to
`lowerIrModuleToPorffor`; the resulting `run` is rendered by pinned Porffor and
compiled with Clang `-fsanitize=address,undefined -fno-omit-frame-pointer`.

Node, linear Wasm, and sanitized Porffor-C agree exactly:

| Input | 0 | 1 | 2 | 10 | 31 | 5000 | 20000000 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Output | 0 | 1 | 1 | 55 | 1346269 | -1846256875 | -1821818939 |

The native process exits zero with empty sanitizer stderr under
`ASAN_OPTIONS=detect_leaks=0:halt_on_error=1:abort_on_error=1` and
`UBSAN_OPTIONS=halt_on_error=1:print_stacktrace=1`.

## Final validation

- `JS2WASM_PORFFOR_ROOT=<pinned Porffor> PORFFOR_NATIVE_REQUIRED=1 pnpm exec vitest run tests/issue-3499-porffor-typed-bitwise-composites.test.ts`
  — 6/6 passed, including all operators/coercion edges and the exact-source
  fixed/cold/runtime native sanitizer oracle.
- Applicable backend regression command covering backend contract, bytecode
  proof, verifier, linear integration, Porffor scalar/native canaries, #3497,
  #3288, and #3499 — 72/72 passed across 9 files with
  `PORFFOR_NATIVE_REQUIRED=1 PORFFOR_NATIVE_SANITIZERS=1`.
- `pnpm run typecheck` — passed.
- `pnpm run lint` — passed.
- `pnpm run format:check` — passed.
- `pnpm run check:stack-balance` — passed with zero bucket deltas.
- `pnpm run check:pushraw` — passed; no new call sites and 18 removed.
- `pnpm run check:ir-fallbacks` — passed with zero gated deltas.
- `pnpm run check:linear-ir` — passed (`compiled=8`, baseline `8`).
- `pnpm run check:loc-budget` and `pnpm run check:issues` — passed.

No benchmark, website, selector, JSDoc, native harness, or benchmark-runner
source is changed by #3499; #3497 is present solely through the landed
`origin/main` merge.

Implementation PR: https://github.com/loopdive/js2/pull/3447
