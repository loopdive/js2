---
id: 3758
title: "IR-native i32 arithmetic for the string-hash/fib build-time bitwise fast path (sound wrap, not saturate)"
status: done
created: 2026-07-28
completed: 2026-07-28
priority: medium
feasibility: hard
reasoning_effort: max
task_type: performance
area: ir, codegen
goal: performance
language_feature: bitwise-operators, arithmetic
related: [3740, 3744, 3741, 3745, 3739, 1948, 3759]
# loc-budget-allow justification: `emitI32PureExpr`/`peelParensExpr` (the
# emitter half of the fast path — needs `LowerCtx`/`lowerExpr`/the IR
# builder, so it can't live in the dependency-free `ir/i32-pure-bitwise.ts`
# predicate module without a circular import) and the `lowerBinary` operand
# -selection branch are irreducible: this is genuinely new logic, not
# extractable busywork. `ir/nodes.ts` (+22)/`ir/verify.ts` (+6) growth is the
# new `IrBinop` union variants (`i32.add`/`i32.sub`/`i32.mul`) plus their
# result/operand-kind classification — a few lines each, unavoidable for a
# new op family.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/nodes.ts
  - src/ir/verify.ts
# func-budget-allow justification: `lowerBinary` gains the operand-selection
# branch (predicate check + dispatch to `emitI32PureExpr` vs the existing
# `lowerExpr`) — this must live at the point operands are lowered, it can't
# move out without restructuring the whole function. `lowerFunctionAstToIr`
# gains exactly the two lines `i32PureNames`'s computation + `LowerCtx` field
# wiring needs, mirroring how `mutatedLets` is already wired.
func-budget-allow:
  - src/ir/from-ast.ts::lowerBinary
  - src/ir/from-ast.ts::lowerFunctionAstToIr
---

# #3758 — sound native-i32 fast path for provably-bounded bitwise/arithmetic IR

## Context

#3745 ("string-hash under IR still uses i64 ToInt32 bit-manipulation, not
native i32") proposed closing IR's residual perf gap vs legacy for
bitwise-heavy code (`(i * 13) & 31`, `hash = (hash * 31 + x) | 0`) by
recognizing when a bitwise operator's operands are provably already
int32-range and skipping the expensive ToInt32 dance (`#3739`'s IEEE-754
bit-decomposition).

**A first attempt at this landed and was reverted** (commit `5ae83119` on
PR #3719, reverted by `4ad40b14` — see that revert's message for the full
diagnosis). The bug: it computed a `+`/`-` composition of two proven-bounded
operands via the EXISTING f64 arithmetic (unchanged) and then narrowed the
RESULT with `i32.trunc_sat_f64_s`. That reasoning is unsound — two
int32-range operands can sum to a value OUTSIDE int32 range (e.g. `fib`'s
`(a + b) | 0` accumulator, which is specifically designed to grow past the
boundary and rely on ToInt32's WRAP). `i32.trunc_sat_f64_s` SATURATES on
overflow instead of wrapping. The four-lane sanitizer probe caught the
divergence on `fib(48)`+ and the commit was reverted with a clean repro.

## The fix: never substitute trunc_sat for arithmetic

This attempt is careful about exactly the distinction that broke the first
one:

- **Leaves** (a proven-bounded identifier — `collectI32CoercedLocals`/
  `detectI32LoopVar`, the same proofs legacy's #1120/#1236 i32-local
  promotion uses — an in-range literal, or a nested bitwise/shift
  sub-expression, which is ALWAYS int32-range by ECMA-262 spec regardless of
  its own operands) are lowered via the existing, UNCHANGED general path and
  narrowed via `i32.trunc_sat_f64_s` — exact, because each leaf's value is
  INDEPENDENTLY proven bounded, not inferred from composing other values.
- **`+`/`-`/guarded-`*` compositions** are computed via genuine, NEW native
  `i32.add`/`i32.sub`/`i32.mul` `IrBinop` variants (added in `ir/nodes.ts`),
  which WRAP modulo 2^32 exactly like ECMA-262 ToInt32 — never via
  trunc_sat. `+`/`-` need no extra guard (f64 add/sub of two int32-range
  operands is exact, |a±b| < 2^32 < 2^53, so wrapping the exact sum via
  native i32.add is bit-identical to ToInt32(a+b) — mirrors legacy's own
  `isI32PureExpr` reasoning in `src/codegen/binary-ops.ts`). `*` additionally
  requires `isI32MulSafe` (one operand a "small" literal, |n| < 2^21) — not
  for wrap correctness (native i32.mul always wraps exactly) but because JS
  `*` itself computes in f64 first, so for large operands the true product
  can round; the guard keeps native i32.mul aligned with what JS's own
  (here lossless) float64 multiply actually produces. `>>>` is excluded as a
  "safe leaf" (its [0, 2^32) range doesn't fit signed trunc_sat semantics).
  Call expressions (`charCodeAt`) remain excluded as leaves — that needs a
  separate "provably in-bounds hoisted read" proof (legacy's #2682), a
  loop-preheader hoisting mechanism IR has no equivalent of yet; tracked
  separately rather than rushed into this same change.

## Files changed

- **`src/ir/nodes.ts`**: new `IrBinop` variants `i32.add`/`i32.sub`/`i32.mul`
  — native, wrapping i32 arithmetic (vs. the existing `f64.add`/`f64.sub`/
  `f64.mul` and the composite `js.bit*` ToInt32-dance ops).
- **`src/ir/i32-pure-bitwise.ts`** (new): `computeI32PureNames` (unions
  `collectI32CoercedLocals` + every `detectI32LoopVar` counter name),
  `isI32PureExprIR` (the purity predicate — see header comment for the full
  soundness argument), `isI32MulSafe`, `isIrBitwiseOperatorToken`.
  Dependency-free (only imports from `codegen/function-body.ts` and
  `codegen/statements/loop-analysis.ts`) so `from-ast.ts` can import it
  without a cycle.
- **`src/ir/from-ast.ts`**: `LowerCtx.i32PureNames` field (computed once per
  outer/nested/closure function body, mirroring `mutatedLets`'s wiring);
  `emitI32PureExpr` (the emitter — recursively builds native i32.add/sub/mul
  for compositions, trunc_sat only for leaves); `lowerBinary`'s operand
  -lowering step now dispatches through `emitI32PureExpr` instead of the
  plain f64 lowering when `isIrBitwiseOperatorToken(op) &&
isI32PureExprIR(expr.left, ...) && isI32PureExprIR(expr.right, ...)`.
- **`src/ir/verify.ts`**: `binopResultKind` explicit cases for the three new
  ops (both already covered correctly by the pre-existing default branch,
  added explicitly for clarity).
- **`src/ir/passes/constant-fold.ts`**: `i32Arith` helper + `BINARY_FOLD_TABLE`
  entries — folds `i32.add`/`i32.sub`/`i32.mul` over const operands via
  plain JS arithmetic + `| 0` wrap (exact here, since the fold only ever
  sees already-emitted, already-guard-passed instructions).
- **`src/ir/backend/legality.ts`** + **`src/ir/backend/porffor/sink.ts`**:
  the wasmgc/linear backends already pass any `IrBinop` through generically
  (`out.push({op} as Instr)`), so no changes needed there. The Porffor
  backend needed real work: naive signed C arithmetic on the new ops risks
  UB on overflow (the exact class of bug this whole issue is about, just at
  the C level instead of the trunc_sat level) — `emitBinary` now computes
  `i32.add`/`i32.sub`/`i32.mul` via unsigned (u32) arithmetic and converts
  back to i32, mirroring the SAME unsigned-first pattern
  `emitI32Bitwise`'s `shl`/`shr_s` arms already use to sidestep C UB in this
  exact file. `porfforBinopLegal` now admits the three ops. The bytecode
  backend is left unchanged — it already excludes many op families (incl.
  `js.bit*`) via the same "not in the #1584 production subset" pattern, and
  no test exercises these new ops through that path.

## Validation

- **New test `tests/probe-3758-check.test.ts`** (6 tests): the EXACT `fib`
  overflow scenario that broke the prior attempt (`fib(47)`, `fib(48)`, …
  into the hundreds-of-thousands range — values that genuinely wrap);
  confirms native `i32.add` actually appears in the compiled output;
  a direct repeated-large-add overflow stress case; the large-multiplication
  soundness guard (mirrors #1746's own test); full string-hash build-loop
  correctness across the benchmark's actual input range; confirms native
  `i32.mul` appears in the build loop's compiled output.
- **`tests/issue-1746-i32-hashpath.test.ts`**, **`tests/issue-3744-*.test.ts`**,
  **`tests/issue-1761.test.ts`**: all still pass unchanged.
- **Full `tests/ir-*.test.ts` sweep** (308 tests): identical to the
  pre-existing baseline (14 known-failing tests, verified byte-for-byte
  reproducing on clean `main` without this change — `ir-nullish-coalesce`,
  `ir-scaffold`, `ir-vec-new-fixed`, `ir-bytecode-wasmgc-vm`). Zero new
  failures.
- **`tests/issue-3499-porffor-typed-bitwise-composites.test.ts`**: caught a
  real regression during development — the "feeds the exact checked-in
  fib.js bytes through shared linear IR" test failed because Porffor's
  legality gate correctly rejected the new native-i32 ops. Fixed by
  extending Porffor support (see above) rather than accepting the
  regression; re-verified passing (the file's ONE other failure, "keeps the
  WasmGC and linear instruction streams byte-for-byte aligned", is
  pre-existing — reproduces identically on clean `main`, unrelated to this
  change; confirmed via `git stash`).
- **Full `tests/equivalence/` suite** (1646 tests, both before and after
  this change): 32 failures both times, byte-identical failing-test list
  (TDZ, delete-sentinel, null-dereference-guards, Reflect API,
  coercion-arithmetic-add, etc. — none touch bitwise/arithmetic
  composition). Zero new failures. Spot-verified 4 of the failing files
  reproduce identically via `git stash`.
- `pnpm run check:ir-fallbacks`: no change (the tracked
  `playground/examples/**` corpus doesn't contain this shape).
- `npx tsc --noEmit`: clean (TypeScript's exhaustiveness checking on the
  `IrBinop` union caught the one real gap, `constant-fold.ts`'s
  `BINARY_FOLD_TABLE`, before any test ran).

## Measured performance impact (honest numbers)

Node WasmGC, `optimize: 3`, median of repeated warm calls:

- **`fib.js`** (`(a + b) | 0` accumulator, a single top-level bitwise op per
  iteration): **150.3ms → 131.8ms (~13% faster)**. This benchmark's loop
  body is essentially pure arithmetic, so the fast path's effect is close
  to its full theoretical benefit.
- **An isolated build-loop-only microbenchmark** (the string-hash build
  loop's exact arithmetic shape — `(i*13)&31`, `(a+7)&31` — with the string
  operations stripped out, replaced by an integer accumulator so the
  comparison isolates just the arithmetic): **216.9ms → 187.0ms (~14%
  faster)**. Confirms the fix genuinely improves this arithmetic shape,
  consistent with `fib.js`.
- **The actual `string-hash.js` benchmark** (`run`, both loops together):
  **no measurable change (~1.4-1.5ms either way, within run-to-run noise)**.
  This is the honest, disappointing part: the build loop's REAL bottleneck
  is the string operations (`charAt`, three `+=` concatenations per
  iteration), not the bitwise arithmetic — so a real, confirmed win on the
  arithmetic is a small fraction of this specific benchmark's total cost,
  swamped by string-op overhead this change doesn't touch. And the hash
  loop (see Non-goals below) is completely unaffected by this fix, so it
  still pays the full ToInt32-dance cost every iteration. This is why the
  string-hash landing-page number won't visibly move from this issue alone
  — the arithmetic fast path is real and helps arithmetic-heavy code in
  general (like `fib`), but isn't the dominant cost in THIS specific
  benchmark's build loop, and the hash loop (likely the bigger cost, since
  it runs once per character rather than once per two characters) is
  untouched.

## Also closes #3741

This fix implements exactly the "recommended alternative strategy" #3741's
own analysis pointed to (a fused-pattern, bitwise-operator-site-only i32
computation that never retypes any local's declared `IrType`, sidestepping
the consumption-site blast-radius problem that sank #3741's first attempt).
Verified directly: `loop.ts`'s `bench_loop` (`let s = 0; for (let i = 0; i
< 1000000; i++) s = (s + i) | 0;`) — #3741's own target benchmark — now
compiles through IR with exactly one `i32.add`, zero ToInt32-dance
instructions. #3741 is marked `done` accordingly.

## Non-goals / follow-up

Closing the string-hash HASH loop's remaining gap (`hash = (hash * 31 +
text.charCodeAt(i)) | 0`) needs a "provably in-bounds `charCodeAt`" hoisting
proof ported from legacy's #2682 (`detectCanonicalCharReadLoop`,
`src/codegen/statements/loops.ts`) — a loop-preheader hoisting mechanism IR
has no equivalent of yet. That is a substantial, separate feature (not a
small patch) and is intentionally NOT attempted here — rushing it into the
same change as this fix is exactly the kind of shortcut that caused the
prior attempt's revert. Filed as **#3759** with the full scope and a
suggested implementation path.
