---
id: 4495
title: "Standalone: a string-initialised JS local keeps a native-string slot and stores NULL when assigned a dynamic value"
status: ready
sprint: current
blocked_on: ""
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: standalone
related: [4206, 4205]
architect_spec: required
---

# Standalone: dynamic value assigned into a native-string slot becomes NULL

## Problem

A JavaScript local whose **initializer is a string literal** is given a native
string slot (`ref $AnyString`). A later assignment of a value the compiler treats
as **dynamic** stores **`null`** into that slot whenever the runtime value is not
a string. Any subsequent use — typically a concatenation — then dereferences
null and traps.

Minimal repro (`--target standalone`). No `with`, no globals, no try/catch:

```js
function id(x) { return x; }
var result = 'r';
result = id(1);
var out = '' + result;   // RuntimeError: dereferencing a null pointer in __str_concat
```

The variable's real domain is `string | number`, but its slot can only hold a
string, and the coercion that bridges the gap answers `null` rather than
refusing or widening.

## Isolation (measured 2026-08-15, `--target standalone`)

| case | result |
|---|---|
| `this.p1 = 1; var result = 'r'; result = p1` | **crash** |
| `function id(x){return x} var result='r'; result = id(1)` | **crash** |
| `this.p1 = 's'; …` — runtime value IS a string | ok |
| `var p1 = 1; var result='r'; result = p1` — statically number | ok |
| `var p1 = 'one'; …` — statically string | ok |
| `var o={a:1}; var result='r'; result = o.a` — statically number | ok |
| `this.p1 = 1; var out = '' + p1` — no string slot at all | ok |

Two independent facts fall out of this table:

1. It is **not** about `with` and **not** about globals — `id(1)` has neither.
2. It is **value-dependent at runtime**: the identical program is fine when the
   dynamic value happens to be a string. So this is a latent miscompile that
   only fires on the non-string path, which is why it reads as a sporadic
   `__str_concat` crash rather than as a type error.

## Root cause, and what is NOT the fix

The null is **deliberate**, at `src/codegen/type-coercion.ts:2469`:

```ts
} else {
  elseBranch = [{ op: "ref.null", typeIdx: toIdx }];
}
```

The rationale is stated four lines below it, and it is sound:

> Generic ToString here would corrupt null/undefined sentinels and silently
> stringify unrelated objects at every typed-string boundary.

**Do not "fix" this by adding a ToString at the coercion site.** That option was
already considered and rejected on the record; re-adding it would trade a loud
trap for silent corruption at every typed-string boundary in the compiler.

The defect is one level up: **slot typing**. A local initialised with a string
literal but later assigned a non-string is not a string variable, and should not
get a native-string slot. The fix direction is to widen such a local to
`externref` / `$AnyValue` when any reaching assignment is dynamic or
non-string — i.e. a definition-side decision, not a coercion-side one.

## Blast radius — read before starting

This touches **every string local in every `.js` file** the compiler sees. The
widening trades native-string fast paths for boxed slots wherever it fires, so a
naive "widen whenever the initializer is a string and any other assignment
exists" rule will regress string-heavy code broadly (npm-compat perf lanes, the
native-string corpus). The slice needs:

- a precise reaching-definition condition (widen only when a reaching assignment
  is genuinely not provably-string), not an initializer-shape heuristic;
- a measured gc-lane control — this is **not** carrier-gated, so the default
  lane changes bytes too;
- a string-heavy perf check, because the failure mode of over-widening is silent
  slowdown rather than a red test.

`feasibility: hard` and `architect_spec: required` for those reasons.

**A Fable-lane implementation plan is required BEFORE dispatch.** Do not start
implementation off this file alone.

## Relationship to #4206 and the 2026-08-07 handoff — TWO heads, not one

> **CORRECTION (2026-08-15, same day).** An earlier revision of this section
> claimed global-binding unification was "one source of this issue, not a
> separate issue", and told the next lane not to file it separately. **That was
> wrong.** It was inferred from cases where the two defects co-occur, before the
> controlled experiment below was run. Global-binding is an independent defect
> and DOES need its own id.

The #4206 handoff of 2026-08-07 named *global-binding unification*
(`this.p1 = 1` vs bare `p1`) as "the real head of this cluster … unowned and
unfiled", sized at ≥19 files. It is a **separate defect from this one**, proven
by holding the type constant so no slot-typing explanation is available
(`--target standalone`, every value numeric throughout):

| case | result |
|---|---|
| `this.p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` | **WRONG** |
| `var p1 = 1; p1 = 2; this.p1 === 2` | **WRONG** |
| `var p1 = 1; this.p1 = 2; p1 === 2` | **WRONG** |
| `this.p1 = 'a'; var f = function(){ p1 = 'b'; }; f(); p1 === 'b'` (string throughout) | **WRONG** |
| `var p1 = 1; var f = function(){ p1 = 2; }; f(); p1 === 2` (var global) | ok |

No type ever changes in those rows, so this issue's mechanism cannot explain
them: `this.p` and bare `p` are simply **two different storages that never
reconcile, in either direction**. Straight-line `this.p1 = 1; p1 = 'x1'` and a
bare read of a `this.`-assigned global both work, so the split only becomes
observable across a **closure boundary** or across a **`this.`/bare direction
change**.

The two defects merely **co-occur** in the S12.10 `with` corpus, because
`this.p1 = 1` both (a) splits the storage and (b) makes the value dynamic to the
checker, which then hits this issue's string-slot path. That co-occurrence is
what produced the incorrect merge above. The clean separator is
`function id(x){return x}` — it reproduces THIS issue with no globals anywhere.

**Both need to be fixed; neither subsumes the other.**

Downstream of this issue (and NOT of global-binding):

- **#4206's 13 `__str_concat` crash rows.** Note these are worth **zero passes**
  on their own — in all 13 files every concatenation sits inside
  `throw new Test262Error(...)`, so the crash is strictly on the already-failing
  path (verified: neutralising the message concat still throws). They convert
  from crash to clean assertion failure. The *passes* come from fixing the
  underlying value mismatch, which is what this issue is.
- The #4206 `p1 === "x1"` / `result === undefined` actual `null` rows are
  plausibly the same slot defect and may move for free; re-measure after.

## Acceptance criteria

1. The three repros above run correctly on `--target standalone`
   (`'' + result` yields `"1"`, not a trap).
2. `src/codegen/type-coercion.ts:2469` is **unchanged** — the fix is on the
   slot-typing side.
3. Measured, two-sided A/B on `language/statements/with` standalone against the
   corrected baseline in #4206 (113 pass / 55 fail / 13 CE, working quickjs
   provider), plus a gc-lane control and a string-heavy perf check.
4. Zero `pass → non-pass` transitions on both lanes.

## Instrument warning

Measuring this requires a **working eval provider**, or a third of the `with`
corpus reports a false failure. See #4206 §0: `TEST262_FULL_RUNTIME_EVAL=1`
selects the interpreter tier, but since #4242 the default engine is **quickjs**
and the selector never builds it. Build both bundles first, then the provider:

```sh
node_modules/.bin/esbuild src/index.ts   --bundle --platform=node --format=esm \
  --outfile=scripts/compiler-bundle.mjs --external:typescript --external:binaryen
node_modules/.bin/esbuild src/runtime.ts --bundle --platform=node --format=esm \
  --outfile=scripts/runtime-bundle.mjs  --external:typescript --external:binaryen
NODE_OPTIONS=--max-old-space-size=3072 node scripts/build-quickjs-eval-provider.mjs
```

Both bundles must be rebuilt **per A/B arm** — the test262 pool worker imports
`scripts/compiler-bundle.mjs`, not `src/`.

## Implementation Plan (fable, 2026-08-15)

Direction is fixed by the issue: **definition-side slot widening**, coercion
site `type-coercion.ts:2469` unchanged. The plan adds the how, the guardrails,
and the measurement protocol.

### Step 1 — localize the slot-decision site (no fix yet)

Compile the `id(1)` repro and find where the local `result` is assigned its
`ref $AnyString` slot. Concretely: instrument the local-allocation path (the
allocator that chooses a native-string slot from a string-literal initializer)
and log `(name, chosenSlot, decidingInput)` for the repro. Record the exact
function+file in this section before proceeding. Do NOT start from a grep for
"AnyString" across the tree — start from the repro, backwards from the trap:
the `ref.null` at type-coercion.ts:2469 receives `toIdx` = the slot's type;
its caller chain names the slot's owner.

### Step 2 — the widening condition (precise, not heuristic)

Widen a local's slot to the boxed/dynamic representation (`externref` /
`$AnyValue`, whichever the surrounding function already uses for dynamic
locals) **iff**:

- the local's slot would otherwise be a native-string type, AND
- some reaching assignment's RHS is **not provably string** by the existing
  static answer (the same oracle the initializer decision uses — do not
  introduce a new type query; route through `ctx.oracle` per the ratchet).

"Provably string": string literal, concat of provably-strings, call whose
oracle signature returns string, typeof result, String(...) — whatever
predicate the slot-decision site ALREADY uses for initializers, reused
verbatim for subsequent assignments. The condition is per-local and
whole-function (all reaching defs), not flow-sensitive — a local that is
sometimes-dynamic is dynamic.

Explicitly NOT in scope: TS-annotated `: string` locals (annotation wins,
current behavior stands — a wrong annotation is user error); params (separate
inference, #2867's S2 already touched param-return-inference.ts — do not
disturb); `let`/`const` with provably-string-only assignments (no change).

### Step 3 — expected emitted-code consequence

Widened locals lose the native-string fast path: reads that fed `__str_concat`
directly now go through the boxed-value string coercion (the same path a
param-typed dynamic value takes today — `'' + id(1)` with no intermediate
local works, per the isolation table, so the boxed lowering exists and is
correct; the fix routes the local through it).

### Step 4 — measurement protocol (the hard part; do not skip any arm)

All arms measured yourself, provenance labels on every number:

1. **Repro gate**: the 3 crash rows in the isolation table flip to correct
   values; the 5 ok rows stay ok. One probe file, both targets
   (standalone + gc).
2. **Widening-precision census**: instrument the widening condition and
   compile the equivalence corpus (`tests/equivalence/`) + `playground/examples/`;
   report HOW MANY locals widen. An unexpectedly large count (>~5% of
   string-slot locals) means the "provably string" predicate is too weak —
   stop and strengthen it before running the big lanes.
3. **Scoped test262 A/B, standalone**: `language/statements/with` against the
   68-row baseline (`.tmp/with-base2.jsonl`, quickjs provider built per the
   Instrument warning above — rebuild bundles per arm), plus
   `language/expressions/addition` + `language/types/string` as
   string-heavy control buckets. Zero pass→non-pass.
4. **gc-lane control**: same buckets, `--target` default. This is NOT
   carrier-gated; the default lane changes bytes too. Zero pass→non-pass.
5. **Perf spot-check**: `benchmarks/` string-heavy case (or a 10^6-iteration
   concat microbench in `.tmp/` if no committed bench isolates strings),
   before/after, same box, 3 runs each, report medians. A >10% regression on
   a string-heavy microbench blocks landing — take it back to the predicate.

### Acceptance

The issue's 4 criteria + the Step-4 arms. The expected test262 yield is the
#4206 rows: 4 `result === undefined` rows plus whatever the 13 crash rows'
underlying assertions do — re-measure, expect modest (~single digits) direct
flips; the value is un-blocking #4206's cluster arithmetic, not a big number.
