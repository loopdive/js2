---
id: 3740
title: "landing string-hash benchmark: default experimentalIR claim silently drops the #1210/#1761 string-builder rewrite (~20-28x regression)"
status: done
created: 2026-07-28
completed: 2026-07-28
priority: high
feasibility: easy
reasoning_effort: high
task_type: performance
area: ir, codegen, strings
goal: performance
language_feature: strings, loops
related: [1210, 1580, 1746, 1761, 2619, 2621]
---

# #3740 — IR claims the string-hash `run` function and drops the string-builder rewrite

## Problem

The landing-page competitive benchmark
`website/public/benchmarks/competitive/programs/string-hash.js` — compiled
exactly as shipped (`{ target: "wasi", nativeStrings: true, optimize: 3 }`,
`scripts/lib/landing-wasmtime-runtime.mjs`'s `LANDING_WASMTIME_COMPILE_OPTIONS`)
— is dramatically slower than it needs to be, and none of the prior
investigations (#1580, #1746, #2619, #2621) caught why, because they all
reasoned about the *arithmetic* lowering (i32 vs f64 ToInt32 dance, GC
bounds-check elimination) and concluded the bounded levers were exhausted.
The actual regression is one selector-gate away: **`experimentalIR` defaults
to `true`** (`src/compiler.ts:740`), and the unannotated `run(n)` function
(plain `number` param/return — no explicit types) satisfies the IR
individual-claim gate. IR claims it, lowers it, and IR's string `+=`
lowering has **no equivalent of the legacy #1210 string-builder rewrite or
#1761 presize** — every `text += <expr>` in the IR-lowered build loop goes
through a full `__str_concat` (cons-string-or-flatten) call, i.e. the
exact O(N)-allocation path #1210 was written to eliminate.

## Reproduction / evidence

```js
import { compile } from "./scripts/compiler-bundle.mjs";
const src = fs.readFileSync("website/public/benchmarks/competitive/programs/string-hash.js", "utf8");
const r = await compile(src, { fileName: "string-hash.js", target: "wasi", nativeStrings: true, optimize: 3 });
console.log(r.irCompiledFuncs); // ['run']  (before this fix)
```

Compiling the SAME unmodified source with `experimentalIR: false` (forcing
legacy) instead of the default:

| Compile                              | `irCompiledFuncs` | warm avg (Node WasmGC, `run(20000)` ×200 after 50 warm-up calls) |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------ |
| default (`experimentalIR` unset)     | `['run']`           | **5427 µs**                                                        |
| `experimentalIR: false` (legacy)     | n/a (not IR)        | **227 µs** (~24x faster, identical result `862771296`)             |

Disassembling the optimized binaries confirms the mechanism: the default/IR
binary's `run` calls a shared 2-arg `$concat(ref, ref) -> ref` helper three
times per build-loop iteration (cons-or-flatten strategy, `array.copy` +
fresh `array.new_default` on every call once the running total crosses the
inline-cons threshold). The legacy binary's `run` instead allocates one
buffer up front and does straight `array.set` writes — the #1210/#1761
rewrite. Absolute numbers are Node's WasmGC engine (no local `wasmtime`
available in this environment to reproduce the Cranelift-AOT numbers #1580/
#1746/#2619 measured), but the *codegen shape* difference — shared-helper
call chain vs. presized direct writes — is engine-independent; Cranelift
also has to execute the extra allocation/copy work every append.

Why #2619's "explicit i32-typed hash measures identical to the f64 hash"
finding didn't surface this: that experiment only re-typed the *hash loop*
variables. Adding `type i32 = number` annotations to the *build* loop's `i`/
`a`/`b` (while leaving `text` itself untyped, matching the shipped source)
turns out to ALSO change `run`'s IR eligibility — the `i32` alias trips a
different (unrelated) IR rejection arm — which incidentally routed it to
legacy and got the presize win as a side effect, without anyone noticing IR
claim/fallback was the actual variable. The prior issues measured "i32
lowering makes no difference" using a variant that had *also* silently
switched off IR, so the comparison never isolated the real cause.

## Fix

`src/ir/select.ts`'s per-function claim gate (`whyNotIrClaimable`) now
declines to claim any function containing the `let s = ""; for (...) s +=
<expr>` shape — recognized structurally by the new
`containsStringBuilderLoopShape` helper
(`src/ir/string-builder-shape.ts`) — until IR grows its own builder/presize
lowering. This is a narrow, additive selector change:

- New `IrFallbackReason` value `"string-builder-candidate"`.
- New file `src/ir/string-builder-shape.ts`: a small, self-contained,
  syntactic (no `ts.TypeChecker`) detector, deliberately independent of
  `src/codegen/string-builder.ts` to avoid adding a codegen→ir runtime
  import edge (that file pulls in `compileExpression`/`closures.ts`, which
  reach back into ir integration). Being name-text-based rather than
  symbol-identity-based makes it *more* eager to defer to legacy than the
  legacy detector's precise version — safe here, since a false positive
  only costs IR-specific wins for that one function (legacy still compiles
  it correctly) and a false negative just leaves the regression unfixed for
  that shape.
- Wired into `whyNotIrClaimable` right after the `fn.body` null-check.
  `isIrClaimable` and `select-identity.ts`'s
  `assessIrStructuralSelectorSubject` both delegate to
  `whyNotIrClaimable`/this same reason set, so no separate edit needed there.

## Validation

- `pnpm run check:ir-fallbacks`: **zero impact** on the tracked
  `playground/examples/**` corpus — none of those examples contain the
  `let s=""` + `+=`-only loop shape, so the new reason doesn't appear in
  either bucket and no baseline update was needed.
- `tests/issue-1210.test.ts`, `tests/issue-1761.test.ts`: pass unchanged.
- `tests/issue-1746-i32-hashpath.test.ts`: 5 pre-existing failures
  (`Cannot read properties of undefined (reading 'map')` — the test's
  `compileAndRun` helper calls `compile(...)` without `await`, a bug
  unrelated to this change; reproduces identically on `origin/main` before
  this fix). Not touched — out of scope for this issue.
- Re-measured the shipped compile options after the fix:
  `irCompiledFuncs: []`, warm avg **192 µs** (matches the forced-legacy
  measurement), same result `862771296` for `run(20000)` as the default
  path measured before the fix — confirms both correctness and the speedup.
- `tests/ir-algorithms-cluster.test.ts`'s `joinNums` helper (`s = s + x`,
  plain assignment not `+=`) does not match the new shape gate — that
  test's IR-vs-legacy byte-diff assertions are unaffected.

## Non-goals / what this does NOT fix

This does not teach IR the string-builder/presize rewrite — it only stops
IR from silently regressing on the shape until it does. The BCE epic
(#2621) and the V8-JIT-parity levers (#1746) remain independently valid
follow-ups for the *legacy* codegen path, now that the shipped benchmark
actually reaches it.

**Update (#3744):** IR now has a native fast path for this shape
(`__str_concat_owned`, dispatched via `string.concat`'s `owned-append`
mode) — see #3744. This selector gate has been REMOVED (IR now claims this
shape by default); `JS2WASM_IR_STRING_BUILDER=0` is a kill switch for
reverting to legacy. Note this means the specific `string-hash` benchmark's
own absolute number moved from legacy's ~0.19ms back up to ~3.1ms (still
~1.8x faster than the original pre-#3740 regression, but not legacy parity)
— see #3744's "residual gap" note: IR still lacks a *separate* i32
loop-arithmetic promotion legacy has, tracked independently.
