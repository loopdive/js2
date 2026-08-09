---
id: 3741
title: "IR path has no equivalent to legacy's #1120 i32-coerced-local promotion — loop.ts benchmark accumulator pattern still 16x slower under IR than legacy"
status: done
completed: 2026-07-28
sprint: 77
created: 2026-07-28
updated: 2026-07-30
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
task_type: performance
area: ir
language_feature: bitwise-operators
goal: performance
depends_on: []
related: [3707, 3733, 3734, 3739, 3758]
# (#3102) The slot-promotion LOWERING needs `LowerCtx` / `lowerExpr` / the IR
# builder, so it cannot live outside `from-ast.ts` without an import cycle —
# the same constraint #3758's own `ir/i32-pure-bitwise.ts` header records for
# its paired `emitI32PureExpr`. Everything that IS pure (the planner, the
# Q-CANON/Q-WRAP predicates, the token/op tables) already lives in the new
# `src/ir/analysis/i32-slots.ts` (+381) and `src/codegen/analysis/
# i32-coerced-locals.ts`, which is why from-ast's share is +421 and not +800.
# `builder.ts` (+26) is the `trunc_sat(convert(x)) === x` cancellation, which
# must be in the builder to catch every emitter; `nodes.ts` (+7) is the
# IrBinop doc note.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/builder.ts
  - src/ir/nodes.ts
# (#3400) `lowerBinary` +6 is the two-line fused-path hook plus its comment;
# `lowerFunctionAstToIr` +4 is the `i32Slots:` context field plus its comment.
# `collectI32CoercedLocals` is NOT growth — it is a byte-identical MOVE out of
# `src/codegen/function-body.ts`, where the baseline already records it at
# exactly 422; only its path key changed, so the gate reads it as new.
func-budget-allow:
  - src/ir/from-ast.ts::lowerBinary
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/codegen/analysis/i32-coerced-locals.ts::collectI32CoercedLocals
---

# #3741 — IR path lacks legacy's i32-coerced-local promotion (no-box i32 loop accumulators)

## Context

Follow-up to #3739 (ToInt32 bit-manipulation rewrite, merged as #3713). After
that fix, the landing-page `loop.ts` benchmark (`let s = 0; for (let i = 0; i
< 1000000; i++) s = (s + i) | 0;`) improved ~2x (17.3ms → ~6.6ms per call in
local sandbox measurement) but still doesn't approach the speed of a pure-i32
loop. Investigating why led to a much bigger finding.

## The finding

Compiling the exact same source with `experimentalIR: false` (forcing the
**legacy** AST-direct codegen path) produces:

```wat
(func $run (result f64)
  (local $s i32)
  (local $i i32)
  i32.const 0
  local.set 0
  i32.const 0
  local.set 1
  (block (loop
    local.get 1
    i32.const 1000000
    i32.lt_s
    i32.eqz
    br_if 1
    (block local.get 0 local.get 1 i32.add local.set 0)
    local.get 1 i32.const 1 i32.add local.set 1
    br 0
  ))
  local.get 0
  f64.convert_i32_s
  return
)
```

Zero ToInt32 calls, zero float arithmetic in the loop body — pure `i32.add`
and `i32.lt_s`. Benchmarked directly: **legacy 0.41ms vs IR 6.6ms — a 16x
gap**, far larger than what #3739's ToInt32 fix alone can close. The
`loop.ts` benchmark compiles through the **IR path** by default (confirmed
via `.wat` local-naming and via the presence of #3739's `$js_bitwise_i64_*`
scratch locals, which only exist in `src/ir/lower.ts`'s `emitJsToInt32`
Instr[] fast path) — so IR-compiled code never gets this optimization.

**Root cause**: legacy has a dedicated, already-shipped, already-hardened
analysis — `collectI32CoercedLocals` (#1120, refined by #1236) in
`src/codegen/function-body.ts:182-603` — that proves a `let`/`const` local is
always int32-range (every write is bitwise-coerced, e.g. `x = (x + y) | 0`,
or is an in-range integer literal) and promotes its Wasm storage from f64 to
native i32. A sibling analysis, `detectI32LoopVar` in
`src/codegen/statements/loop-analysis.ts:20-78`, does the same for the
canonical `for (let i = INT; i < …; i++)` counter shape. **Neither has an IR
equivalent.** `src/ir/from-ast.ts`'s `lowerVarDecl` (~line 2202) hardcodes
`irVal({kind:"f64"})` as the default hint for any un-annotated `number`
local, and IR's selector (`src/ir/select.ts`'s `isPhase1TypeNode`) actively
_rejects_ an explicit `: i32` type-alias annotation from IR eligibility
(demotes the whole function to legacy) — so today an i32-accumulator loop
inside an otherwise-IR-eligible function simply never gets the promotion
either way.

This is **not** a duplicate of `src/ir/propagate.ts` (#1131 Phase 2's lattice
type-propagation system) — that module infers param/return types for
_unannotated_ functions so they can become IR-eligible at all (e.g. proving
`function fib(n) {...}` is `(number) -> number`). It doesn't touch local
no-box storage representation within an already-eligible function's body,
which is the problem here.

## What was attempted (reverted — not committed, see below)

A first implementation attempt threaded a new `i32CoercedLocals:
ReadonlySet<string>` through `LowerCtx` (mirroring the existing
`mutatedLets` field/pattern exactly), computed once per function via the
**unmodified, reused** legacy `collectI32CoercedLocals(fn)` — zero duplicated
analysis logic, matching the precedent already set by #2766's reuse of
`isIncreasingStep`/`loopBodyMutatesIndexOrArray` from the same
`loop-analysis.ts` module. Four small, targeted edits made the exact
benchmark loop compile with i32 `s`/`i` locals:

1. **`lowerVarDecl`** (`from-ast.ts:~2222`): when no more-specific hint
   applies (no explicit annotation, no empty-array inference, no module
   binding), check `cx.i32CoercedLocals.has(name)` (regular locals) or
   `detectI32LoopVar(d.parent.parent)` (for-loop counters, found via
   `d.parent` = `VariableDeclarationList`, `.parent.parent` = the enclosing
   `ForStatement` when the declaration is a for-loop's init clause) and hint
   `i32` instead of defaulting to `f64`.
2. **`lowerExpr`'s numeric-literal case** (`from-ast.ts:~2704`): this
   hardcoded `f64.const` regardless of the `hint` parameter — the injection
   point above was inert without this. Fixed to emit `i32.const` when the
   hint is i32 AND the literal is an in-range integer (mirrors
   `collectI32CoercedLocals`'s own `isI32SafeExpr` range check); any
   out-of-range/fractional literal against an i32 hint still falls through
   to f64, surfacing as a clean mismatch at the hint's consumption site
   rather than silently miscompiling.
3. **General binary-op operand lowering** (`from-ast.ts`'s `lowerBinary`,
   ~line 7756): both operands were unconditionally hinted f64. Changed to
   lower LHS first, inspect its resolved type, and hint RHS as i32 when LHS
   resolved to i32 — makes `i < 1000000` (i32 loop counter vs literal) lower
   both sides consistently. Confirmed this dual-i32 path is genuinely
   supported for **comparisons and bitwise ops** (`lowerBinary` already has
   `if (!isF64 && !isI32) requireF64(...)` gates for `<`/`<=`/`>`/`>=` and
   `&`/`|`/`^`/`<<`/`>>`/`>>>`).
4. **`coerceReturnValue`** (`from-ast.ts:~5831`): found and fixed a real
   latent bug this surfaced — a promoted i32 local returned into a declared
   `f64` result was never widened. The function's own comment ("native
   scalar returns already line up via the hint") was an invariant that held
   _only_ because no un-annotated local could previously resolve to
   anything but f64; #3741 breaks that invariant. Fixed by reusing the
   existing `coerceIrNumeric` helper (already used elsewhere for exactly
   this i32→f64 widen, `f64.convert_i32_s`) instead of the unconditional
   pass-through.

**This much was tested clean**: full `tests/equivalence/ts-wasm-equivalence.test.ts`
(29 tests), `tests/ir-propagate-i32.test.ts` (32 tests), and
`tests/ir-let-const-equivalence.test.ts` (12 tests, including the exact
`const y = 1; return y;` case that exposed the return-coercion gap) all
passed after all four fixes above.

### Why it was reverted anyway

A broader sweep (`tests/ir-algorithms-cluster.test.ts`,
`tests/ir-vec-new-fixed.test.ts`, plus 8 other `tests/ir-*.test.ts` files)
surfaced **13 new failures** (verified via `git stash` A/B against the same
suite on unmodified `main` — baseline has exactly 5 pre-existing, unrelated
failures; with the WIP diff applied it was 18). All 13 new failures are
`i32CoercedLocals`/`detectI32LoopVar` promoting a loop counter or
accumulator that ANOTHER, not-yet-audited consumption site still assumes is
f64 — the exact same class of bug `coerceReturnValue` had, recurring at
other call sites this session didn't reach:

- `#2856 C1` — early value return from inside a while/for loop
- `#2856 C2` — `arr[i] = v` element stores (in-place swap / growing store)
- `#2856 C3` — module-scope Map storage-slot type tracking (mixed IR-writer
  / legacy-reader)
- `#2856 C4` — constructed-vec reads inside for/while bodies, nested
  loops+do-while
- `#2856` whole-component claim tracking (`algorithms.ts`, "zero demotions")
- `#1804 (6e)/(6f)` — vec reads inside while/for loops (`Phase 1 requires
matching operand types for '<'` — the SAME comparison-operand-hint gap
  fixed for the benchmark's own condition, recurring in a different
  loop/array-index pairing my LHS-drives-RHS fix didn't cover)

This confirms the "hint is advisory; an already-lowered value's ACTUAL type
just passes through unconverted at each consumption site" pattern is used
pervasively across `from-ast.ts` (array indexing, closures/captures, Map
storage slots, and almost certainly more not yet exercised by any existing
test) — not just at the 4 sites patched above. Promoting a local's `IrType`
from f64 to i32 is therefore not a locally-contained change; it's a
cross-cutting change to a ~9,000-line file whose full consumption-site
surface isn't enumerable without a systematic audit (grep every
`cx.builder.typeOf`/type-equality check against an assumed-f64 local, or add
a debug assertion that fires on any i32-vs-f64 mismatch and run the full
suite to enumerate hits).

Given the correctness stakes (a wrong answer, not a crash — exactly the
class of bug #1236 already burned the codebase on once) and that this is a
widely-shared, foundational dispatch file, continuing to patch failures
one-by-one without that systematic audit was judged too risky to land in
one session. **The IR edits were reverted; nothing from this attempt is
committed.** The 4-point sequence above is preserved here as a validated
starting point for whoever picks this up next — re-applying it should
reproduce the same 13 failures immediately as a checklist, not a surprise.

## A harder blocker found independently: `+`/`-`/`*` are deliberately f64-only in IR

Even with every consumption-site gap above fixed, `s + i` itself cannot
compute as native `i32.add` through the _general_ binary-op path: IR's
`lowerBinary` unconditionally calls `requireF64(isF64, "+", ...)` for
`+`/`-`/`*` (`from-ast.ts:~7910/7915/7920`) — comparisons and bitwise ops
already have an `if (!isF64 && !isI32) requireF64(...)` escape hatch, but
arithmetic does not. This is not an oversight: it's the IR-level analogue of
legacy's own #1236 guard (`collectI32CoercedLocals`'s `isI32SafeExpr`
explicitly excludes `+`/`-`/`*` from the safe-to-promote set, with a
detailed comment on why — raw i32 arithmetic on i32-safe operands can still
be wrong if the _sum itself_ isn't immediately re-truncated, because Wasm
`i32.add` wraps while a plain `f64.add` widens without truncating).

For the specific pattern that matters (`(a + b) | 0` or similar — a bitwise
wrapper immediately following the arithmetic), native `i32.add` IS
bit-exact equivalent to `ToInt32(f64_add(a, b))` when `a`/`b` are already
int32-range (two's-complement wraparound addition and `(a+b) mod 2^32`
signed-reinterpreted are the same operation) — this is exactly what
legacy's own codegen does (confirmed: legacy's `.wat` output above never
computes `s + i` as a standalone f64 op at all; the `|0` wrapper's codegen
recognizes both operands are i32 and emits `i32.add` directly, never
exposing bare i32 arithmetic as a general capability).

**Recommendation for a future attempt**: don't extend the general `+`/`-`/`*`
lowering to accept i32 operands (reopens the #1236 risk broadly). Instead,
add a narrowly-scoped **fused pattern** — recognize `(expr op expr) | 0` (or
`^0`, or other bitwise-wrapping context) at the bitwise-operator lowering
site specifically, and when the inner arithmetic's operands are BOTH already
i32-typed, emit `i32.add`/`i32.sub`/`i32.mul` directly for that fused unit
only — never as a standalone, generally-reachable i32 arithmetic op. This
mirrors the existing #3733 `x | 0` identity fast path (already special-cases
the immediate operand of `|0`) one level deeper.

## Recommended alternative strategy for a future session

Given the consumption-site blast radius, retyping a local's _global_
`IrType` (visible to every consumer in the function) is the wrong lever.
Consider instead a **scoped shadow representation**: keep the local's
`IrType` as f64 everywhere (unchanged for every existing consumer — return,
array stores, Map slots, closures, all keep working exactly as today), and
only within a provably self-contained hot region (a `for`/`while` loop body
where the accumulator is written exclusively via the bitwise-wrapped pattern
and never escapes to a call/closure/property-store mid-loop) maintain an
_additional_, loop-scoped i32 shadow slot — converting f64↔i32 exactly once
at loop entry and loop exit, never changing what any other part of the
function sees. This is architecturally closer to a register-allocator
"rematerialize as i32 for this region" optimization than a type-system
change, and would avoid resurrecting the cross-cutting consumption-site
audit entirely — at the cost of needing a new "does this variable escape
the loop" analysis (a smaller, more contained problem than auditing every
existing IR consumer).

## Out of scope / follow-ups

- The Porffor backend (separate value representation, no i64/i32 native
  arithmetic support per #3739's investigation) — not applicable to this
  local-storage question either way.
- `array.ts`'s `__vec_push` dispatch overhead — tracked in #3734, unrelated.
- A systematic audit of every `from-ast.ts` consumption site that currently
  assumes "un-annotated locals are always f64" — needed regardless of which
  strategy (global retype vs. scoped shadow) a future attempt takes, unless
  the scoped-shadow strategy above sidesteps it entirely by construction.


## Correction — #3758 was a real win, but it did NOT close this issue

This issue was briefly closed as "fixed by #3758". That closure was made on a
**shape** criterion — "the loop now compiles with exactly one `i32.add`, zero
`i64.*` ToInt32-dance instructions, and the correct result" — which is true,
and #3758 is a genuine, correctly-reasoned improvement. But correct output
plus the right instruction mix is **not** the same as fast, and the gap this
issue was filed for is a *timing* gap. Measured, it is still there.

### Measurement (2026-07-28)

Compiling the exact `loop.ts` benchmark, instantiating, and timing the export
(median of 40 calls after 30 warm-up calls, node/V8):

| build                                  | IR path  | legacy path |
| -------------------------------------- | -------- | ----------- |
| `origin/main` b12a84a8 (**with #3758**) | 7.63 ms  | 0.405 ms    |
| this issue's slot-promotion change      | 0.388 ms | 0.406 ms    |

Main is still **~19x slower than legacy** on the IR path (pre-#3758 it was
~6.6 ms, so on this particular shape #3758 is marginally slower, within the
same band).

### Why: storage kind is the lever, not the arithmetic

#3758 keeps both locals in **f64 slots** and composes the arithmetic in i32
by narrowing each leaf with `i32.trunc_sat_f64_s` and widening the result
with `f64.convert_i32_s`. On main the loop body is:

```wat
local.get $slot_s   ;; f64
i32.trunc_sat_f64_s
local.get $slot_i   ;; f64
i32.trunc_sat_f64_s
i32.add
i32.const 0
i32.or              ;; the `| 0`, not folded away
f64.convert_i32_s
local.set $slot_s
;; plus f64.add for i++ and f64.lt for the condition
```

That is a **loop-carried** `f64 → i32 → f64` round trip on the accumulator.
A hand-written-`.wat` A/B of the candidate lowering shapes (node/V8, 1M
iterations, same harness) shows that round trip costs as much as the entire
ToInt32 sequence it replaces:

| loop-body shape                                                    | median  |
| ------------------------------------------------------------------ | ------- |
| both locals `i32` (legacy)                                          | 0.41 ms |
| both `i32`, f64 view only at the loop condition                     | 0.70 ms |
| accumulator `i32`, counter `f64`                                    | 1.88 ms |
| both `f64`, `trunc_sat`/`i32.add`/`convert` per iter (**= #3758**)  | 7.25 ms |
| both `f64`, `f64.add` + `i64.trunc`/`wrap` per iter (= pre-#3758)   | 6.10 ms |

`i32.trunc_sat_f64_s` carries a range check on V8, and the convert/truncate
pair sits directly on the loop-carried dependency chain. **Any design that
leaves the local in an f64 slot is worth ~0 however cheap ToInt32 becomes.**

### What #3758 IS good for (keep it)

#3758's expression-level fusion is the right and only tool for every
i32-range value that is *not* slot-promotable — a `const` bound as an SSA
local, a value whose write shapes this issue's promoter cannot produce, a
guarded `i32.mul`. It is **complementary, not competing**, and the fix for
this issue is layered on top of it rather than replacing it:

- #3758 answers "is this VALUE int32-range?" → narrow the f64 with a cheap
  `trunc_sat`.
- #3741 answers "should this local's STORAGE be i32?" → then there is nothing
  to narrow; the read *is* the i32.

Where both apply, #3741 wins (no narrowing instruction at all); where only
#3758 applies, #3758 runs unchanged. `isFusedI32Lowerable` in `from-ast.ts`
takes the union of the two proofs precisely so a mixed subtree like
`(promotedLocal + pureButF64Stored) | 0` degrades to neither — without it,
#3741 would have *regressed* expressions #3758 already handled.

### The fix, and why it is contained

`planI32Slots` (`src/ir/analysis/i32-slots.ts`) gives a provably-int32
mutable local a native **i32 Wasm slot** while keeping its
`ScopeBinding.type` at **f64**, under two invariants:

- **R (read)** — every read widens with `f64.convert_i32_s`, so the SSA value
  handed to every consumer is f64-typed and numerically identical to before.
  No consumer in the ~9k-line `from-ast.ts` can tell the difference. This is
  what avoids the consumption-site blast radius that sank the first attempt
  documented above.
- **W (write)** — every write lowers its RHS *directly* to an exact i32; it is
  never an f64 that gets truncated. A write shape the lowering cannot produce
  is simply not promoted, so the function compiles exactly as today (no new
  legacy fallback, no fallback-budget growth).

Eligibility reuses legacy's own `collectI32CoercedLocals` (#1120/#1236/#2789)
and `detectI32LoopVar` verbatim, intersected with a **producibility fixpoint**
over the write shapes, plus shadowing and closure-capture guards applied
uniformly (legacy's counter path lacks these) — so it is strictly more
conservative than legacy about *which* locals it promotes.

`IrFunctionBuilder.emitUnary` also gains the algebraic cancellation
`i32.trunc_sat_f64_s(f64.convert_i32_s(x)) === x`. Without it the most common
consumer of a promoted counter — an array index `arr[i]` — would pay
convert+truncate where it used to pay just truncate, i.e. the promotion would
*pessimize* indexed loops.

### Process note

The lesson worth keeping: **an instruction-mix assertion is not a performance
verification.** Both #3745's revert (a correctness bug found by differential
execution, not by reading the emitted ops) and this closure (a performance
non-fix passed by reading the emitted ops) point the same way — for a
`task_type: performance` issue, the acceptance criterion has to be a measured
number against the stated baseline, not a `.wat` inspection.

### Eligibility is keyed on the BINDING, not the name

A first cut of the planner returned a `Set<string>` and guarded shadowing with
"this name must be declared exactly once in the function". That is safe but
badly pessimistic, because **two sibling `for (let i = …)` loops are two
distinct bindings that happen to share a name** — the guard rejected *both*:

```ts
const arr: number[] = [];
for (let i = 0; i < 10000; i++) arr.push(i);
let total = 0;
for (let i = 0; i < arr.length; i++) total = total + arr[i];   // ← both `i` f64
```

Alpha-renaming the second `i` to `j` — no semantic change whatsoever — flipped
both counters to i32. Two sibling `for (let i …)` loops is one of the most
common shapes in real JS/TS, so a name-keyed set silently disabled the whole
optimization across a wide swath of ordinary code. Legacy does not have this
problem: its promotion is applied per-loop at emit time, so it never has to
reconcile two same-named bindings in one set.

The planner now returns `ReadonlySet<ts.VariableDeclaration>` and resolves each
candidate to its **binding scope** (the `ForStatement` for a loop head, the
innermost enclosing block for a plain `let`). Write scans, capture scans and
the producibility fixpoint's identifier probe are all scoped to that subtree,
so a same-named sibling binding can never contribute a write or leak its
promotion. Genuine shadowing (nested `for (let i …)` inside `for (let i …)`, or
a counter shadowing an outer `let i`) has *non-disjoint* scopes and is still
dropped wholesale — distinguishing those needs full use-site scope resolution,
and the conservative answer costs nothing on the shapes that matter.

Verified deterministically on the `array.ts` shape above: the sibling-`i` and
alpha-renamed programs now emit byte-identical instruction mixes
(`slots=[i:i32 total:f64 i:i32]`, same `i32.add`/`i32.lt_s`/`f64.add` counts).
`total` correctly stays f64 — its write is not `| 0`-wrapped.

### Side finding: a pre-existing `detectI32LoopVar` bug in LEGACY

Writing the regression tests surfaced an unrelated **legacy** defect.
`detectI32LoopVar` promotes a for-counter on the loop HEAD's shape alone and
never inspects the body, so a body that assigns a non-integer to the counter
silently truncates and changes the iteration count:

```ts
export function part(n: number): number {
  let t = 0;
  for (let i = 0; i < 10; i++) { i = i + n; t = (t + 1) | 0; }
  return t;
}
// part(0.5): JS and IR = 52, legacy = 55
```

#3741's planner rejects that binding (the write is not a shape `lowerAsI32`
can emit exactly), so the IR path is correct. Not fixed here — it needs its own
issue against `src/codegen/statements/loop-analysis.ts`. Covered by an
IR-vs-JS-only assertion in `tests/issue-3741-i32-slot-promotion.test.ts`.
