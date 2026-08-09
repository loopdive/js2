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
sprint: Backlog
horizon: m
architect_spec: needs-revision
blocked_reason: "THREE approaches now fail: Design 1A re-point (impl2826) AND write-through-to-A (cps2826) BOTH perturb the CPS continuation state — identical async-generator-interleaved null-deref + array-elem-iter-nrml-close nextCount=2 signatures. PROVEN un-gateable: the regressing names (nextCount/iterations) are indistinguishable from the required-fix name (length) at the let-init site (same mutability / captured-global / capturer set). Needs the transitive-capture/continuation-snapshot graph analysis (recommendation #1) — genuinely architect-owned. See ## Implementation attempt 2."
---

# #2826 — Bug C (CPS-capture half): block-`let` immutably captured by a hoisted async/generator declaration

Carved from #2818 (parent) and #2820 (the plain-function half of Bug C, fixed
there). This is the **async / generator capturer** residual of the
`ary-ptrn-rest-obj-prop-id` block-`let`-capture cluster — the half #2820's
producer-side slot-reuse gate _deliberately excludes_ (the gate fires only when
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
  {
    let s = 42;
    async function f(): Promise<number> {
      return s;
    }
    return await f();
  }
}
// => 0   (should be 42)

// generator capturer
export function t6(): number {
  {
    let s = 42;
    function* g(): Generator<number> {
      yield s;
    }
    return g().next().value;
  }
}
// => 0   (should be 42)
```

Controls that **PASS** (function-scope `let`, not in a block):

```ts
export async function t4(): Promise<number> {
  let s = 42;
  async function f(): Promise<number> {
    return s;
  }
  return await f();
} // => 42 ✓
export function t7(): number {
  let s = 42;
  function* g(): Generator<number> {
    yield s;
  }
  return g().next().value;
} // => 42 ✓
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
the outer-frame slot it sees _then_ via `outerLocalIdx`
(`src/codegen/context/types.ts:1254`).

The construction/call site reads the capture value out of that pinned slot. For
an **immutable** capture this is a bare `local.get cap.outerLocalIdx`
(`src/codegen/expressions/calls.ts:12941`; the parallel mutable paths are at
12892 / 12912). The `localMap.get(name) ?? cap.outerLocalIdx` re-resolve was
tried in #1177 and **reverted** (100+ regressions where main's wrong-slot null
was load-bearing) — so the immutable path is hard-pinned to `outerLocalIdx`.

Now the duplicate-slot mechanism (the Bug C core, see #2820):

1. `walkStmtForLetConst` (`src/codegen/index.ts:14626`) pre-allocates a slot for
   every block-`let`/`const` at **function entry** (the _pre-hoisted slot A_),
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

Why only _immutable_ captures: a **mutable** CPS capture is boxed into a ref
cell at the call site (`calls.ts:12904-12928`), and that boxed cell already
threads the value correctly (per #2820's gate comment) — and is exactly the path
the broad reuse _broke_. So the fix must touch **only** the immutable,
unboxed CPS capture, never the mutable boxed one.

## Implementation Plan

> **SUPERSEDED (senior-conflicts 2026-07-02).** Designs 1A (re-point A→B) and 1B
> (construction-site re-resolve) below, **and** the later write-through-to-A
> (see `## Implementation attempt 2`), are **all three proven net-negative and
> un-gateable at the let-init site** — do NOT retry any producer-side point-fix.
> The real spec is **`## Implementation Plan — v2`** (transitive
> continuation-snapshot discriminator) further down. Designs 1A/1B are retained
> only as the historical record of what fails and why.

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
- Guard: run **only** when the block-`let` was _not_ reused (i.e. the
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
- A **non-hoisted** capturer (async arrow / async fn-expr assigned _after_ the
  `let`) records its capture with `localMap` already at B → guard fails → no
  re-point needed (already correct).

### Design 1B — construction-site narrowed re-resolve (fallback only)

If 1A proves insufficient for some shape, the alternative is to re-resolve the
immutable capture by name at `calls.ts:12941` (`fctx.localMap.get(cap.name) ??
cap.outerLocalIdx`) **gated narrowly** on: capturer is async/generator
(`ctx.asyncFunctions`/`ctx.generatorFunctions`), the name is a pre-hoisted
block-`let`/`const`, and `localMap.get(name) !== cap.outerLocalIdx`. This is the
_minefield_ #1177 hit with the blanket version (the async-null-deref tests rely
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
- **Nested destructuring patterns** (`let [...{ length: z }]`): the _outer_
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

## Implementation Plan — v2 (transitive continuation-snapshot discriminator)

_(architect spec, senior-conflicts 2026-07-02 — the un-gateability of all three
producer-side point-fixes is PROVEN, see `## Implementation attempt 2`. This is
recommendation #1 made concrete. It is genuinely whole-program and NOT a
~20-line patch; scope it as a `feasibility: hard`, `reasoning_effort: max`
analysis-pass task and validate on full merge_group.)_

### Why a local predicate cannot work (the proven blocker)

At `compileVariableStatement` (the let-init site) the name that **needs** the fix
(`length`) and the names that **regress** (`nextCount`, `iterator`, `iterations`)
are **byte-identical in every materialised signal**: same `cap.mutable`, same
not-a-captured-global, same single direct capturer. The distinguishing property
is **runtime dataflow of the captured value through a suspending CPS
continuation**, which is not represented as metadata when the slot decision is
made. Gates (a) per-entry `mutable`, (b) per-name "no mutable cap anywhere",
(c) "no direct capturer is itself captured", (d) `!capturedGlobals.has(name)`
were each disproven on the sample. Therefore the fix MUST be driven by a
**pre-codegen whole-program pass** that materialises the missing property.

### The safety predicate to compute

Apply the producer-side slot fix (re-point `cap.outerLocalIdx` A→B, or the
equivalent) for a block-`let` `name` **iff NO function in the transitive
capturer+callee closure of `name` snapshots `name` (or a value derived from it)
into a _suspending_ continuation state struct.** `length` qualifies (safe);
`nextCount`/`iterator`/`iterations` do not (each reaches a suspending
continuation, directly or transitively).

### Pass design (new, e.g. `src/codegen/analysis/continuation-capture-graph.ts`)

Run **before** slot assignment in `compileVariableStatement`, cache the verdict
on `fctx` keyed by the decl. Build two graphs over the function's nested
declarations + object-literal methods:

1. **Capture graph** (edges available today from `ctx.nestedFuncCaptures`,
   `types.ts:1312`): `capturer → capturedName`, and transitively
   `capturer → names captured by fns it captures`.
2. **Call graph** (does NOT exist today — build it): scan every nested-fn body
   and every **object-literal method / accessor** (`{ next(){…} }`,
   get/set) for `CallExpression`s that resolve to a named nested fn, an
   object-method, or a direct funcIdx call into an async/generator body. The
   `iterations` case reaches its suspending `callAsync` via a **direct call
   edge** (`pushAwait()`), invisible to the capture graph — so the call graph is
   mandatory, not optional.

Per node, compute **`spillsIntoSuspendingContinuation`**: the fn is CPS-lowered
(`ctx.asyncFunctions`/`ctx.generatorFunctions`, `types.ts:1289/1291`, incl.
async-generators) **and** it has a `yield`/`await` point at which the capture is
live (i.e. the captured value is spilled into the resumable `$Frame`/state
struct across a suspend). Also mark **object-literal iterator/accessor methods
that mutate the name** (`next(){ nextCount += 1 }`) — that mutation escapes into
the iteration protocol and is invisible to a `nestedFuncCaptures` mutability
scan, so treat such a method as an unsafe spiller of `name`.

`name` is **safe** iff the transitive closure (capture ∪ call edges) from every
direct capturer of `name` contains **no** node with
`spillsIntoSuspendingContinuation` and **no** escaping-mutation object-method for
`name`. Only then apply the re-point.

### Where it plugs in

`src/codegen/statements/variables.ts` — the same block after #2820's reuse gate
(~line 837) where Design 1A lived. Replace 1A's local `cap.mutable !== true`
guard with `isSafeToRepointName(fctx, name)` from the new pass. When true,
re-point `cap.outerLocalIdx` (and `cap.outerTdzFlagIdx`) A→B exactly as Design 1A
specifies; when false, leave the capture on slot A (today's behaviour → the
`for-await-of` cluster stays byte-identical, zero regression).

### Edge cases

- Mixed plain + CPS capturer of the same `name`: the plain capturer benefits from
  the re-point; safety is governed solely by the CPS side's suspend-spill.
- TDZ flag re-point in lockstep (see Design 1A ordering guarantee).
- Nested destructuring pattern bindings carry no pre-hoist slot (guard excludes).
- Recursion / cycles in the call graph: use a visited-set; a cycle through a
  suspending node makes the whole component unsafe.

### Validation (REQUIRED — same as attempt 2)

The flips manifest ONLY on the merged baseline. Confirm on full
`merge_group`/local-CI: (i) `t5`/`t6`/`t8` + the `length` `dstr` targets flip
fail→pass; (ii) **zero** regressions in the 43-test
`for-await-of/async-{func,gen}-decl-dstr-*` class (the named guardrails
`async-generator-interleaved.js` + `array-elem-iter-nrml-close.js` stay pass).
A scoped sweep cannot see this cluster. Harness preserved under `.tmp/`
(`probe-2826.mts`, `run262-2826.mts`).

### Do NOT retry (proven-failed point-fixes)

- **Design 1A** re-point A→B (PR #2333): net −8, perturbs the CPS state struct.
- **Design 1B** construction-site `localMap.get(name) ?? outerLocalIdx`: the
  #1177 minefield (async-null-deref tests rely on the wrong slot).
- **write-through-to-A** (attempt 2): identical CPS perturbation as 1A, reached
  via the write instead of the re-point.
  All three are un-gateable by any predicate computable at the let-init site.

## Dependencies

- **Depends on #2820** (PR #2293) being merged: this fix reuses
  `fctx.preHoistedLetConstSlots` and the `cpsCaptured` detection introduced
  there, and lives directly beside that gate in `variables.ts`. Branch should be
  taken **after** #2293 lands (or predecessor-stacked on it).
- **In-lane** (closures / nested-fn lowering / `nestedFuncCaptures`); no
  dependency on the parallel substrate work ($Object dynamic reader /
  any-receiver dispatch / `calls.ts` host-dispatch / acorn / NM). The only
  `calls.ts` touch is the _fallback_ Design 1B; Design 1A leaves `calls.ts`
  untouched.

## Acceptance criteria

- `t5`/`t6` (and string variants) return the captured value; `t4`/`t7` controls
  unchanged.
- The immutable-`let`-read async/generator `dstr-*` cluster members return pass.
- **Zero** regressions in the 43-test `for-await-of/async-{func,gen}-decl-dstr-*`
  mutable-capture class on full merge_group.
- TDZ throws for pre-init reads through a CPS capture preserved.

## Merge-group regression (do not re-enqueue as-is)

The first implementation attempt (PR #2333, branch `issue-2826-bugc-cps-capture-repoint`,
commit `7eba3f486` "re-point immutable CPS block-let captures to fresh slot (Bug C)")
was **auto-parked** (`hold` + `auto-park-bot:merge-group-failure`) on a REAL,
net-negative test262 regression caught only in `merge_group`. It is NOT
baseline drift.

**Why PR-level missed it:** at PR level the test262 shards are skipped — the
`check for test262 regressions` check ran in ~3s on a stub with no shard data.
Full conformance is only validated in `merge_group`. So "PR-green" never
validated test262 here.

**Delta (merge_group, baseline f8c1aa5):**

- 30 regressions / 22 improvements → **net −8**, ratio 136%, signature `dd4fa22aa1d2c2a1`.
- ALL 30 regressed tests are `for-await-of` dstr
  (`async-func-decl-dstr-*` / `async-gen-decl-dstr-*` array/obj rest+elem,
  e.g. `async-func-decl-dstr-array-elem-iter-nrml-close.js`).
- The 22 improvements are also for-await/await dstr — so the fix is a
  **same-area tradeoff that breaks more than it fixes**.
- Confirmed PR-caused (not drift/flake): WAT differs branch vs `origin/main`,
  and a runtime probe via the exact CI path (`runTest262File`) flips
  `async-func-decl-dstr-array-elem-iter-nrml-close.js` from **pass on main**
  to **fail on branch** ("assert.sameValue(nextCount, 1)").
- Cross-checked against #2335/#2818: DIFFERENT signature, ZERO shared regressed
  tests, no `S15.3_A3_T1`/TLA markers → not a shared drift cluster.

**Narrowing direction for the rework:** the slot re-point is over-applied. It
must re-point ONLY the CPS capture that genuinely needs a fresh slot (the exact
immutable-`let`-captured-by-hoisted-async/gen case this issue targets), and
leave the mutable `for-await-of/async-{func,gen}-decl-dstr-*` capture path on
its existing slot — that path is what regressed. Gate the re-point on the same
predicate #2820 used to _exclude_ CPS capturers, inverted to its single
intended case. **Validate against a full `merge_group` / local-CI test262 run
BEFORE re-enqueue** — a scoped check cannot see this cluster. PR #2333 branch

- this diagnosis must survive; re-open this issue for the narrowed attempt.

## Implementation attempt 2 (cps2826, senior-dev) — write-through-to-A is ALSO unsafe; PROVEN un-gateable → architect

**Verdict: STOP / defer to architect (third strike).** The corrected approach —
impl2826's recommendation #2, _write-through-to-A_ (leave `outerLocalIdx = A`,
also store the block-`let`'s value INTO slot A at let-init so the stale-A
read/CPS-snapshot observes the live value) — was implemented and **reproduces the
EXACT same CPS-state perturbation as the reverted Design 1A re-point.** Reverted;
**nothing ships** (this PR is docs-only). Debug-validated on current `origin/main`,
host/gc lane. Harness: `.tmp/probe-2826.mts` (t5/t6/t8 + controls),
`.tmp/run262-2826.mts` (guardrail + 43-class samples + the 4 cited targets).

### Re-grounding: #2844 advanced the cited targets, but NOT to the #2826 assert

The premise for the retry was that #2844 (for-await rest→object-pattern dstr,
now merged) unblocks the cited `ary-ptrn-rest-obj-prop-id` targets. Confirmed
#2844 is on main — the targets advanced from **assert #1** (`v===7`) to **assert
#5** (`z===3`, "returned 6"). But assert #5 (`length: z` reads the rest array's
`.length`) is **yet another orthogonal dstr bug**, still short of assert #6
(`length === "outer"` — the actual #2826 immutable-outer-`let` capture). So on a
_correct_ baseline the cited targets remain blocked upstream of #2826.

### What write-through fixes

Synthetic repro fixed: `t5`/`t6`/`t5s`/`t8` (mixed plain+CPS) return the captured
value (42 / "hi" / 28) vs 0 on baseline; `t4`/`t7` fn-scope controls unchanged.
And — notably — write-through on `length` **flips all 4 cited targets fail→pass**
(it satisfies assert #5+#6 together), so the conformance payoff is real _when it
fires on the right name_.

### Why it is unsafe (same mechanism as Design 1A, reached via the write)

Writing B→A at the let-init **clobbers slot A, which the CPS continuation relies
on** (it is NOT a dead pre-hoist slot for escaping/suspending capturers). Two
named regressions, **identical signatures to the reverted re-point** (PR #2333):

- `language/expressions/await/async-generator-interleaved.js` (NAMED guardrail):
  pass→fail, _"dereferencing a null pointer in pushAwait()"_ (`actual`/`iterations`).
- `for-await-of/async-{func,gen}-decl-dstr-array-elem-iter-nrml-close.js` (43-class):
  pass→fail, _`assert.sameValue(nextCount, 1)` returned 2_ (`nextCount`/`iterator`).

### The decisive finding: the regression is UN-GATEABLE at the let-init site

Instrumented every write-through firing. The name that **must** get the fix
(`length`) and the names that **regress** (`nextCount`, `iterations`, `iterator`)
have **identical state** at `compileVariableStatement` — no discriminator exists:

| name (test)                                | mutable-cap? | captured-global? | capturers     | write-through  |
| ------------------------------------------ | ------------ | ---------------- | ------------- | -------------- |
| `length` (target) — **needs fix**          | no           | no               | `[fn]`        | **safe (fix)** |
| `nextCount` (array-elem) — **regresses**   | no           | no               | `[fn]`        | **null/2**     |
| `iterator` (array-elem) — **regresses**    | no           | no               | `[fn]`        | **regress**    |
| `iterations` (interleaved) — **regresses** | no           | no               | `[callAsync]` | **null-deref** |
| `x`/`y` (array-rest) — harmless            | no           | no               | `[fn]`        | stays green    |

`length` (safe) and `nextCount`/`iterator` (regress) are **byte-for-byte identical
in every signal available** — same `mutable` across all cap entries, same
not-a-captured-global, same single capturer `fn`. The difference is purely the
**runtime dataflow of the captured value through the CPS continuation**:

- `length` — a plain immutable read inside the for-await body of an inline-driven
  `fn().next()`;
- `nextCount`/`returnCount`/`args` — mutated inside **object-literal iterator
  methods** (`next(){ nextCount += 1 }`) that escape into the iteration protocol —
  the mutation is **invisible** to a `nestedFuncCaptures` mutability scan;
- `iterations` — read inside `callAsync`, an `async function*` that **suspends**
  at `await pushAwait()` in a loop; the continuation snapshots `pushAwait`'s
  closure (which holds `actual` from slot A) at a timeline the let-init write
  cannot satisfy. `pushAwait` reaches `callAsync` by a **direct call** (funcIdx),
  not a capture edge, so it is invisible to the capture graph too.

Gates attempted and disproven on the sample: (a) per-entry `cap.mutable !== true`;
(b) per-NAME "no mutable cap anywhere"; (c) "no direct capturer is itself
captured" (transitive); (d) `!capturedGlobals.has(name)`. **None** separate
`length` from `nextCount`/`iterations` — because the distinguishing information
(object-method mutation, call-graph through suspending continuations, snapshot
timing) is **not materialized as metadata** when `compileVariableStatement` runs.

### Recommendation → architect (recommendation #1 only; #2 disproven)

A producer-side slot fix (whether re-point A→B or write-through B→A) **cannot be
made safe by any predicate computable at the let-init site.** Both perturb the
CPS state and the safe/unsafe boundary is whole-program. The only remaining
viable path is impl2826 **recommendation #1**: build the **transitive
capture+call graph** and a per-nested-fn **"spills captures into a _suspending_
continuation state struct"** predicate; apply the fix **only** when no capturer
of the name (directly or transitively, including through object-literal
iterator/accessor methods and direct calls into suspending async/gen bodies)
snapshots the name into a continuation. `t5`/`t6`/`t8` + `length` qualify;
`callAsync`/`pushAwait`/the iterator-protocol mutators do not. This is genuinely
architect-owned and must be validated on a **full `merge_group`/local-CI
test262** run before re-enqueue — the flips do not manifest on a scoped sweep.

Given (i) three failed approaches and (ii) the cited targets remain blocked
upstream of #2826 by the separate assert-#5 `length: z` dstr bug even after
#2844, the practical recommendation is to **keep #2826 blocked behind the
architect's transitive-continuation-graph design** rather than ship any
producer-side heuristic. Reproduction harness preserved under `.tmp/` (gitignored).
