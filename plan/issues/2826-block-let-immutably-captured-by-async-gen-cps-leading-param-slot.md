---
id: 2826
title: "Bug C (CPS-capture half): block-scoped let immutably captured by a hoisted async/generator declaration reads the stale pre-hoisted slot"
parent: 2818
related: [2820, 2818, 2825, 2811, 2669]
status: blocked
created: 2026-06-29
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
es_edition: 2017
language_feature: closures
goal: spec-completeness
sprint: current
horizon: m
architect_spec: needs-revision
blocked_reason: "Design 1A regresses CPS guardrail async-generator-interleaved; needs architect re-spec (transitive-capture-graph gate). See ## Implementation attempt (impl2826)."
---

# #2826 — Bug C (CPS-capture half): block-`let` immutably captured by a hoisted async/generator declaration

Carved from #2818 (parent) and #2820 (the plain-function half of Bug C, fixed
there). This is the **async / generator capturer** residual of the
`ary-ptrn-rest-obj-prop-id` block-`let`-capture cluster — the half #2820's
producer-side slot-reuse gate *deliberately excludes* (the gate fires only when
the block-`let` is captured by ≥1 plain function and **zero** CPS-lowered
async/generator functions, because the broad reuse regressed 43
`for-await-of/async-{func,gen}-decl-dstr-*` tests, net −14).

It is a **distinct** bug from #2825 (the class-method captured-globals half):
this one is in the **leading-capture-param** channel, #2825 is in the
**captured-globals** channel.

## Reproduction (verified on current main, host/gc lane)

```ts
// async capturer
export async function t5(): Promise<number> {
  { let s = 42; async function f(): Promise<number> { return s; } return await f(); }
}
// => 0   (should be 42)

// generator capturer
export function t6(): number {
  { let s = 42; function* g(): Generator<number> { yield s; } return g().next().value; }
}
// => 0   (should be 42)
```

Controls that **PASS** (function-scope `let`, not in a block):

```ts
export async function t4(): Promise<number> {
  let s = 42; async function f(): Promise<number> { return s; } return await f();
}                                                            // => 42 ✓
export function t7(): number {
  let s = 42; function* g(): Generator<number> { yield s; } return g().next().value;
}                                                            // => 42 ✓
```

The block-nested capturer reads `0` — the numeric zero-init of an **un-written
pre-hoisted slot** — not the captured `42`. (Empirically reproduced via
`compileAndInstantiate` on `369f37442cd`.)

## Root cause (verified)

A nested function declaration that captures outer locals is lowered with the
captures as **leading parameters** (`compileNestedFunctionDeclaration`,
`src/codegen/statements/nested-declarations.ts:617-783`). The capture metadata is
recorded in `ctx.nestedFuncCaptures` at the point the nested fn is
**hoist-compiled** (`nested-declarations.ts:773-783`), pinning each capture to
the outer-frame slot it sees *then* via `outerLocalIdx`
(`src/codegen/context/types.ts:1254`).

The construction/call site reads the capture value out of that pinned slot. For
an **immutable** capture this is a bare `local.get cap.outerLocalIdx`
(`src/codegen/expressions/calls.ts:12941`; the parallel mutable paths are at
12892 / 12912). The `localMap.get(name) ?? cap.outerLocalIdx` re-resolve was
tried in #1177 and **reverted** (100+ regressions where main's wrong-slot null
was load-bearing) — so the immutable path is hard-pinned to `outerLocalIdx`.

Now the duplicate-slot mechanism (the Bug C core, see #2820):

1. `walkStmtForLetConst` (`src/codegen/index.ts:14626`) pre-allocates a slot for
   every block-`let`/`const` at **function entry** (the *pre-hoisted slot A*),
   recorded in `fctx.preHoistedLetConstSlots` (added by #2820).
2. A function declaration nested in a block is **hoisted to the top of that
   block** and compiled before `let s` runs, so its `nestedFuncCaptures` entry
   records `outerLocalIdx = A`.
3. On **block entry** `saveBlockScopedShadows` removes the block-`let` from
   `localMap`/`tdzFlagLocals`. When `let s = 42` finally executes,
   `compileVariableStatement` (`src/codegen/statements/variables.ts`) sees
   `!localMap.has(name)` and — because **#2820's reuse gate is skipped for CPS
   capturers** (`variables.ts` ~837, the `cpsCaptured && !capturedByPlainFn`
   branch does nothing) — falls through `freshLocalForLetConst` and
   `allocLocal`s a **fresh slot B**, storing `42` into **B**.
4. The capture is still pinned to **A** (never written) → the construction reads
   `A = 0`, not `B = 42`.

For a **plain** function #2820 collapses A and B (reuse), so `outerLocalIdx = A =
B` and the read is correct. For a **CPS** function the collapse perturbs the
`for-await-of` continuation state machine (43 regressions), so #2820 skips it —
leaving the immutable CPS capture pinned to the stale A. **That is this bug.**

Why only *immutable* captures: a **mutable** CPS capture is boxed into a ref
cell at the call site (`calls.ts:12904-12928`), and that boxed cell already
threads the value correctly (per #2820's gate comment) — and is exactly the path
the broad reuse *broke*. So the fix must touch **only** the immutable,
unboxed CPS capture, never the mutable boxed one.

## Implementation Plan

### Design 1A — producer-side capture re-point (preferred)

Symmetric with #2820 (producer-side, in `variables.ts`), but **without** the
slot collapse that perturbs the CPS state machine. Instead of reusing A, keep
both slots (B stays the real storage, A stays a dead pre-hoist slot) and
**re-point the already-recorded capture metadata from A to B**.

**File: `src/codegen/statements/variables.ts`** — in the block immediately after
the existing #2820 reuse gate (~line 837), and after the fresh `localIdx` (slot
B) for the block-`let` is allocated + the initializer stored:

- Compute `preHoisted = fctx.preHoistedLetConstSlots?.get(decl)` (already in
  scope from the #2820 gate) — its `valueSlot` is the stale slot **A**.
- Guard: run **only** when the block-`let` was *not* reused (i.e. the
  `freshLocalForLetConst` path produced a distinct `localIdx` **B** with
  `B !== A`), i.e. the CPS-excluded branch — this is the exact inverse of
  #2820's `capturedByPlainFn && !cpsCaptured` gate, so the two compose with no
  overlap.
- Iterate `ctx.nestedFuncCaptures`. For every capturer `capName` and capture
  entry `cap` where:
  - `cap.name === name`, **and**
  - `cap.mutable !== true` (immutable / unboxed only — never touch boxed
    mutable captures: that is the 43-regression class), **and**
  - `cap.outerLocalIdx === preHoisted.valueSlot` (still pinned to the stale A),
  - re-point `cap.outerLocalIdx = localIdx` (B), and if a TDZ flag was
    re-allocated for this decl (the `freshLocalForLetConst` re-alloc at
    `variables.ts:~1607`-region), also re-point `cap.outerTdzFlagIdx` from the
    pre-hoist flag slot to the new `fctx.tdzFlagLocals.get(name)`.

Because the re-point mutates the **single source of truth**
(`nestedFuncCaptures[*].outerLocalIdx`), **all** downstream construction sites
that read it (`calls.ts:12941` immutable, plus the lazy
`emitFuncRefAsClosure` / closure-builder reads near `calls.ts:15414-15531`)
automatically resolve to **B** — no edit needed at the read sites.

Producer slot **count/layout is unchanged** (A is left allocated, just dead), so
the `for-await-of` continuation state-struct snapshot is byte-identical to
baseline for the regression cluster → no perturbation.

### Ordering guarantee

The re-point is valid because:
- The capture entry already exists when `let s` runs (the nested fn is
  block-hoisted → compiled before the `let`). The `cap.outerLocalIdx === A`
  guard makes the re-point a no-op if the entry does not yet exist or already
  points at B.
- A **non-hoisted** capturer (async arrow / async fn-expr assigned *after* the
  `let`) records its capture with `localMap` already at B → guard fails → no
  re-point needed (already correct).

### Design 1B — construction-site narrowed re-resolve (fallback only)

If 1A proves insufficient for some shape, the alternative is to re-resolve the
immutable capture by name at `calls.ts:12941` (`fctx.localMap.get(cap.name) ??
cap.outerLocalIdx`) **gated narrowly** on: capturer is async/generator
(`ctx.asyncFunctions`/`ctx.generatorFunctions`), the name is a pre-hoisted
block-`let`/`const`, and `localMap.get(name) !== cap.outerLocalIdx`. This is the
*minefield* #1177 hit with the blanket version (the async-null-deref tests rely
on the wrong slot) — prefer 1A; only fall back here with full merge_group
validation. **Do not** ship the un-gated `?? outerLocalIdx` form.

### Edge cases

- **Immutable vs mutable**: re-point immutable only. Mutable boxed captures are
  the #2820-gate's "already threads correctly" path and the 43-regression class
  — leave them untouched. (`length` in the dstr cluster is immutable; the loop
  counters `iterCount`/`nextCount` are mutable.)
- **TDZ interaction**: a block-`let` read before init must still throw. The
  call-site TDZ check (`calls.ts:12840-12848`, `analyzeTdzAccessByPos`) keys on
  `fctx.tdzFlagLocals.get(cap.name)`; re-point `outerTdzFlagIdx` in lockstep so
  the flag the callee tests is the live one (B's), not the dead pre-hoist flag.
  The construction in the repro is textually after `let s`, so the analysis is
  "skip" — but a transitive call through a closure that captured the flag must
  still observe the live flag.
- **Nested destructuring patterns** (`let [...{ length: z }]`): the *outer*
  immutable capture is the plain identifier `length`/`s`, not the pattern
  binding `z`. Pattern bindings are not pre-allocated by `walkStmtForLetConst`
  (`index.ts:14732`) so they carry no pre-hoist slot — the guard
  (`outerLocalIdx === preHoisted.valueSlot`) naturally excludes them.
- **#2820 boundary (must compose, no overlap)**: #2820 fires iff
  `capturedByPlainFn && !cpsCaptured`; this fix fires on the complementary CPS
  branch. A block-`let` captured by **both** a plain fn and a CPS fn: #2820's
  gate already declines reuse (because `cpsCaptured`), so slot B is fresh; this
  fix then re-points the CPS capture's `outerLocalIdx` to B, and the plain
  capturer — also reading via `nestedFuncCaptures` against the same producer
  frame — likewise benefits from the re-point. Confirm the mixed case in a test.
- **generators vs async**: both are CPS-lowered; gate on
  `ctx.asyncFunctions.has(capName) || ctx.generatorFunctions.has(capName)` if a
  capturer-kind gate is wanted, but Design 1A's `mutable !== true` + slot-guard
  already restricts to the right entries without an explicit kind check.

### Scoped repro / acceptance

Add `tests/issue-2826.test.ts`:

- `t5` (block async), `t6` (block generator) above return **42** (and a string
  variant returns the captured string).
- Controls `t4`/`t7` (fn-scope) still return 42.
- Mixed plain+CPS capturer of the same block-`let` returns the captured value
  from both.
- A block-`let` read-before-init inside the CPS body still throws
  ReferenceError (TDZ regression control).

### test262 paths this unblocks (conformance target)

Async / generator analogs of the `ary-ptrn-rest-obj-prop-id` cluster where an
outer `let` is **immutably read** inside the CPS body, e.g.:

- `language/statements/for-await-of/async-gen-dstr-let-ary-ptrn-rest-obj-prop-id.js`
  (asserts `length === "outer"` — the outer immutable `let length` read inside
  the `async function *fn()` body).
- `language/statements/for-await-of/async-func-dstr-let-ary-ptrn-rest-obj-prop-id.js`
  and the `const` / `async`-prefixed siblings in the same directory.

### Full-merge_group regression guard (REQUIRED)

These pass/fail flips **only manifest on the merged baseline** — they are the
exact 43-test `for-await-of/async-{func,gen}-decl-dstr-*` class #2820 had to
exclude. **Validate on the full `merge_group` / full CI, never a scoped sweep.**
Specifically confirm **zero** regressions in:

- `for-await-of/async-func-decl-dstr-*` (e.g. `array-rest-after-element` —
  `[x, ...y]`-style mutable loop-var captures), and
- `for-await-of/async-gen-decl-dstr-*` (the `iterCount`/`nextCount`/`iterator`
  loop-state-var class),

i.e. the mutable boxed-capture path must stay byte-identical. (See #2820's gate
comment for the precise regression signature.)

## Dependencies

- **Depends on #2820** (PR #2293) being merged: this fix reuses
  `fctx.preHoistedLetConstSlots` and the `cpsCaptured` detection introduced
  there, and lives directly beside that gate in `variables.ts`. Branch should be
  taken **after** #2293 lands (or predecessor-stacked on it).
- **In-lane** (closures / nested-fn lowering / `nestedFuncCaptures`); no
  dependency on the parallel substrate work ($Object dynamic reader /
  any-receiver dispatch / `calls.ts` host-dispatch / acorn / NM). The only
  `calls.ts` touch is the *fallback* Design 1B; Design 1A leaves `calls.ts`
  untouched.

## Acceptance criteria

- `t5`/`t6` (and string variants) return the captured value; `t4`/`t7` controls
  unchanged.
- The immutable-`let`-read async/generator `dstr-*` cluster members return pass.
- **Zero** regressions in the 43-test `for-await-of/async-{func,gen}-decl-dstr-*`
  mutable-capture class on full merge_group.
- TDZ throws for pre-init reads through a CPS capture preserved.

## Implementation attempt (impl2826, senior-dev) — Design 1A is UNSAFE, do not merge

**Verdict: STOP / re-spec.** Design 1A (producer-side immutable `outerLocalIdx`
A→B re-point) was implemented byte-for-byte per the spec and **regresses a named
guardrail test** while delivering **zero conformance gain** on the cited targets.
The implementation is preserved in git history (commit `e851cbf` on branch
`issue-2826-cps-capture`) and **reverted** at the branch tip (`0329c7c`) so
nothing ships. Debug-validated on current `origin/main` (`43394821800b`),
host/gc lane.

### What worked
The synthetic #2826 repro is fixed by the re-point:
`t5` (block async), `t6` (block generator), the string variant, and the mixed
plain+CPS capturer all return the captured value (42 / "hi" / 14) — up from 0 on
baseline. The re-point fires correctly: `[2826] name=s A=0 B=2 mutable=false`.

### The byte-identical proof DID hold for the *mutable boxed* path
WAT diff of `async-func-decl-dstr-array-rest-after-element.js` (a mutable
loop-state cluster member) base→fix is exactly **two lines**: the immutable
captures' construction reads change `local.get 0/2` → `local.get 7/8`. The
**mutable boxed captures** (`struct.new <ref-cell>`; `local.tee`) are
**byte-identical** — the `cap.mutable === true` gate held. So the spec's claim
"never touch the boxed mutable path" is satisfied.

### Why it still regresses — the spec's "producer byte-identical" premise is false
The immutable captures are **also spilled into the async-generator continuation
state struct** (`struct.new` of the captured-by-value consts) at the construction
site. `outerLocalIdx` is read there too, so re-pointing it A→B changes *which
slot is snapshotted into the CPS state struct* — perturbing the state machine.
The spec assumed keeping both slots (A dead, B live) makes the producer
byte-identical; it does not, because the **construction-site spill** reads
`outerLocalIdx`, not just the trivial leading-param `local.get`.

Concrete failure — **`language/expressions/await/async-generator-interleaved.js`
(a NAMED guardrail test) regresses pass → fail**:
```
BASE  MUST-PASS  pass  async-generator-interleaved.js
FIX   MUST-PASS  fail  async-generator-interleaved.js
      -> "dereferencing a null pointer in pushAwait() at L19 (via callAsync@L19 ← test@L8)"
```
Debug shows the re-point firing on genuinely immutable consts captured by the
async generator:
```
[2826] name=actual      A=0 B=6 mutable=false fnName=test   (captured by pushAwait + checkAssertions)
[2826] name=iterations  A=4 B=9 mutable=false fnName=test   (captured by async generator callAsync)
```
`callAsync` is an `async function*` with `await` in a loop; `pushAwait` (capturing
`actual`) is **transitively** captured by it. Re-pointing `actual`/`iterations`
A→B breaks the snapshot the CPS lowering takes → null read inside `pushAwait`.
This is the exact 43-regression *mechanism* (#2820's gate comment), reached here
via the **immutable** path rather than the mutable one.

`t5`/`t6` survive the same re-point because their capturer is constructed **and
consumed inline** (`return await f()`) reading the freshly-written B — no escaping
closure, no state-struct spill snapshot.

### The cited conformance targets are blocked by a DIFFERENT bug (no #2826 payoff)
`async-{func,gen}-dstr-let-ary-ptrn-rest-obj-prop-id.js` (the spec's
"test262 paths this unblocks") **fail on baseline AND fix identically**, at
`assert.sameValue(v, 7)` — assert **#1**, long before the `length === "outer"`
assert (#6) that #2826 would address. `v` is a binding from
`for await (let [...{ 0: v, 1: w, ... }] of [[7,8,9]])` — a **for-await
rest-to-object-pattern destructuring** bug, orthogonal to the immutable capture.
So even a correct #2826 fix yields **zero** flips on the cited targets until that
destructuring bug is fixed.

### Recommendation (for the architect)
A producer-side `outerLocalIdx` re-point cannot be made safe by a mutability gate
alone — the immutable re-point itself perturbs CPS state-struct spills. Options:
1. **Transitive-capture-graph gate**: re-point only when **no** capturer of the
   name (directly or transitively) is a CPS function that *suspends* (has a
   continuation state struct that snapshots captures). `t5`/`t6` (capturer
   constructed-and-consumed inline, no escaping spill) qualify; `callAsync` /
   `pushAwait`-under-`callAsync` do not. Requires building the capture DAG and a
   "spills-captures" predicate per nested fn — non-trivial, architect-owned.
2. **Construction-site mirror (not re-point)**: leave `outerLocalIdx = A` (spill
   stays byte-identical) and additionally **store the initializer value into A**
   (write-through) so the stale-A read/snapshot observes the live value. Keeps B
   as the live binding. Needs validation that A is otherwise dead and that the
   double-write doesn't itself perturb the CPS frame. NOT the reverted #1177
   construction-site re-resolve (Design 1B) — that's the confirmed minefield.
3. **Re-scope / defer**: given the cited conformance targets are blocked by the
   separate for-await rest-object-destructuring bug, the real-world value of
   #2826 in isolation is low. Consider deferring behind that destructuring fix,
   or narrowing #2826 to the verified `t5`/`t6` shapes only via option 1.

### Reproduction harness (kept for re-spec)
`.tmp/probe-2826.mts` (t5/t6/controls/mixed), `.tmp/run262-2826.mts`
(end-to-end runner on the 5 guardrail + 2 target files), `.tmp/bytecmp-2826.mts`
(SHA-256 of wrapped binaries), `.tmp/wat-one.mts` (single-file WAT). All under
`.tmp/` (gitignored).
