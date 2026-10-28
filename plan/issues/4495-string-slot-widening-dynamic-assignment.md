---
id: 4495
title: "Standalone: a string-initialised JS local keeps a native-string slot and stores NULL when assigned a dynamic value"
status: done
sprint: current
blocked_on: ""
created: 2026-08-15
updated: 2026-10-28
completed: 2026-10-28
assignee: ttraenkler/opus-4495
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: standalone
related: [4206, 4205, 4500]
architect_spec: required
loc-budget-allow:
  # 2026-10-28 (#4495 review round 1): +1 line — the import of the new
  # src/codegen/expressions/destructuring-source-literal.ts. The two call sites are
  # one-for-one line swaps; every line of logic lives in the new module. (The
  # earlier +7 grant for numeric-property-analysis.ts is gone: that file now
  # shrinks by 20 lines, its private write walk replaced by the shared one.)
  - src/codegen/literals.ts
  # 2026-10-28 (#4495 review round 2 prep): +1 line, the import of
  # memberReceiverStaticType. The receiver-type line is a one-for-one swap; the
  # logic lives beside its stale-type guard in heterogeneous-scalar-var-widening.ts.
  # 2026-10-28 (#4495 review round 2): +3 more — receiverMayBeNativeStringAtRuntime
  # takes the receiver type as an optional parameter, so prettier splits its signature;
  # the element-read call sites are one-for-one swaps.
  - src/codegen/property-access.ts
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

## Implementation record (opus-4495, 2026-10-28)

### Step 1 finding — the issue's repros were already fixed on main

Re-measured on `df57a0e8e6` (main, 2026-10-28) before touching anything: all
three crash repros **pass** on standalone and gc. A first-parent bisect from
`907b84f903` (the plan commit, where the `id(1)` repro still traps with
`dereferencing a null pointer`) lands on `0d87f21636` (merge of PR #4658), and
the inner bisect on **`bbe50022de` — "fix(#4206): widen a primitive-pinned
module slot on an unconstrainable RHS"** (2026-08-19). That commit is exactly
this plan's Step 2 for the module-binding analysis
(`src/ir/heterogeneous-module-bindings.ts`): a `mixed` RHS now widens a
primitive-initialised module slot. The function-local analysis
(`src/codegen/analysis/mixed-assignment-carrier.ts`) already widened on a plain
`x = <mixed>` before that. `type-coercion.ts`'s `ref.null` arm is untouched by
both.

So the slot-decision sites are the two definition-side analyses above, and the
plain `x = v` shape is closed. What was still open is the rest of Step 2:
"some **reaching assignment**" — both analyses recognised a write only as
`x = v` (plus `||=`/`&&=`/`??=` on the module side).

### Residual matrix (`.tmp/probe2.mts`, script-mode `.js`, both lanes, top level + function local)

Measured base = `df57a0e8e6`, branch = this PR. A cell is one (scope × lane);
each row has 4 cells. "ok" means spec-correct.

| shape (`var r = 'r'` unless noted) | base | branch |
|---|---|---|
| `r = id(1)` (the issue's repro), `let` twin, nested-fn / arrow write | 4/4 ok | 4/4 ok |
| `[r] = [id(1)]` | 0/4 — null deref | **4/4** |
| `var o = { r: id(3) }; ({ r } = o)` | 0/4 — null deref | **4/4** |
| `r &&= id(1)` / `r ||= id(1)` (`r = ''`) | 2/4 each — fn traps | **4/4** |
| `for (r of [id(1)]) {}` | 2/4 — fn traps | **4/4** |
| `var r = '5'; r++` | 2/4 — fn leaves `'5'` | **4/4** |
| `var r = '5'; r -= 1` | 0/4 — null deref | **4/4** |
| `var r = true; r++` | 2/4 | **4/4** |
| `typeof r` after `r = id(1)` / after `++r` | 2/4 — fn folds `"string"` | **4/4** |
| controls: string-only reassignment, `String(id(1))`, numeric swap `[a,b]=[b,a]`, `for (w of ['p','q'])` | 4/4 | 4/4 |

Total non-ok cells across the 34-row matrix (136 cells): **40 → 14**. The 14 left are four
rows, each a different mechanism and all outside slot typing — see
*Residuals* below.

### What changed

> Superseded in part by *Review round 1* below: `identifier-writes.ts` was
> merged into `src/shared/binding-writes.ts`, and `numeric-property-analysis.ts`
> now takes every store from that shared enumerator instead of a private branch.

- **`src/shared/identifier-writes.ts` (new)** — `identifierWritesOf(node)`: every
  store one AST node performs into a bare identifier (plain and logical
  assignment, array/object destructuring assignment, for-of targets, `++`/`--`,
  numeric compound assignment), paired with WHAT is stored: the named value
  (a literal source element / property, a default), an element / property of a
  non-literal source, a ToNumeric write-back, or unknown.
  It is pure syntax and sits in `src/shared` beside `binding-writes.ts`, so
  `src/ir` and `src/codegen` share it without a new codegen<->ir import edge
  (the import-cycles ratchet rejected it under `src/ir`: codegen->ir 301 -> 303,
  ir->checker 8 -> 9).
  `identifierWriteTag(oracle, write, initialTag)` lives in `checker/oracle.ts`
  beside `jsTagOfFact`, which both callers already import, and answers the JS
  tag through `ctx.oracle` only (`staticJsTypeOf`, `typeFactOf`, `propertyFactOf`) — no new
  checker query. Both analyses consume it, so they cannot disagree on what a
  write stores.
- **`mixed-assignment-carrier.ts`** (function locals) and
  **`heterogeneous-module-bindings.ts`** (module bindings) index those writes
  instead of `x = v` only. The module analysis leaves `++`/`--` to
  `update-retyped-bindings.ts` (#4208 S2): counting them there too demoted the
  IR-owned module init (6 red cases in `tests/issue-4208-update-to-number-ir`
  until excluded).
- **`typeof` on a widened function local** — `slotIsDynamicButStaticallyPrimitive`
  (heterogeneous-scalar-var-widening.ts) adds the function-local twin of the
  #4204 module guard; both `typeof` fold sites in `typeof-delete.ts` call it.
- **`numeric-property-analysis.ts`** — route 2 of the numeric-local proof now
  records destructuring-assignment targets. Without it, widening
  `let a: number | null = 5; [a = 99] = [null]` handed the slot to the #4121
  override, whose def-site proof saw only the default `99` and narrowed the
  slot to **f64** — measured `a === null ? 1 : 2` → `2` (JS: `1`). Base kept
  that slot externref only because the destructuring write was invisible.

### Measurement protocol (all arms run by me, 2026-10-28, same box)

**Arm 1 — repro gate.** The issue's three repros pass on standalone and gc on
both base and branch (fixed upstream, see Step 1); pinned in
`tests/issue-4495.test.ts` (70 cases: repros, the residual-matrix rows above
on both lanes × both scopes, controls, and a precision ratchet asserting no
local of a same-type-writes function is widened).

**Arm 2 — widening-precision census** (`.tmp/census.mts`): every
template-literal program in `tests/equivalence/*.test.ts` compiled as both `.ts`
and `.js`, plus `website/playground/examples/**/*.ts`; 1,810 units compiled.
Counting named locals of the unit's own functions plus `__mod_*` globals:

| | slots | string slots | widened by branch |
|---|---:|---:|---:|
| all units | 2,033 | 126 | **2** (0.10 %) |
| of which string slots | — | 126 | **0** (0.00 %) |

The 2 are `f64 → externref` for a nested pattern under a non-literal source
(`[[x]] = vals`, `vals: number[][]`) — its element type is not expressible as
an expression, so it stays `unknown`. Well under the plan's 5 % stop line. Two
earlier predicate versions failed this arm and were tightened: treating every
non-literal destructuring source as `unknown` widened 14 `f64` slots
(`[x, y, z] = vals` with `vals: number[]`), and `for (w of ['p','q'])` widened
a string slot; both now read the element/property type from the oracle.

**Arms 3 + 4 — scoped test262 A/B, standalone and gc.** In-process
`runTest262File` driver, quickjs eval provider rebuilt per arm (compiler +
runtime bundles rebuilt per arm), base = `df57a0e8e6` by file copy, branch =
this PR. 2,163 files per arm per lane:

| lane | arm | with | addition | types/string | logical-assignment | postfix-inc | prefix-inc | postfix-dec | prefix-dec | compound-assignment | assignment | for-of |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| standalone | base | 177/181 | 45/48 | 24/24 | 60/78 | 31/38 | 30/33 | 30/37 | 31/34 | 432/454 | 461/485 | 719/751 |
| standalone | branch | 177/181 | 45/48 | 24/24 | 60/78 | 31/38 | 30/33 | 30/37 | 31/34 | 432/454 | 461/485 | 719/751 |
| gc | base | 175/181 | 45/48 | 24/24 | 60/78 | 31/38 | 30/33 | 30/37 | 31/34 | 432/454 | 461/485 | 718/751 |
| gc | branch | 175/181 | 45/48 | 24/24 | 60/78 | 31/38 | 30/33 | 30/37 | 31/34 | 432/454 | 461/485 | 718/751 |

**Zero transitions in either direction on either lane, and zero changed error
messages among the non-passing rows.** Totals: standalone 2,040 / 105 / 18 CE,
gc 2,037 / 108 / 18 CE, identical per arm.

Two corrections to this file's earlier numbers: the `with` baseline is no
longer 113 / 55 / 13 — main is at **177 pass / 3 fail / 1 CE** standalone. None
of the 4 non-passing `with` rows is a slot defect (two Proxy-env traps, one
TypedArray-in-proto-chain, one #1387 CE). So the "4 `result === undefined`"
and "13 `__str_concat`" rows this file attributed to #4495 have all already
moved, and this PR has no direct test262 yield in the buckets measured. Its
value is the 26 residual-matrix cells above.

**Arm 5 — perf.** `.tmp/perf.mts`: an untyped `.js` 10⁶-iteration concat loop
that also exercises every new write form with same-type values (`||=`, `&&=`,
`[a, b] = [b, a]`, `k++`, `k -= 1`, `for (w of ['p','q'])`). The branch binary
is **byte-identical** to base on both lanes (standalone sha `5a35a300f0cb3f40`,
60,414 B; gc sha `0b5e586715486775`, 106,027 B), so the runtime is identical by
construction. Medians of 3, same box: standalone 58.7 ms base / 58.5 ms
branch; gc 75.5 / 64.4 ms (noise). An earlier branch version that typed for-of
elements as `unknown` was +62 % bytes and +18 % time on this bench — that is
what the arm caught, and why the element type now comes from the oracle.

**Regression checks.** `tests/issue-4495.test.ts` 70/70. Neighbouring suites
(3765, 4121 ×3, 4122, 4131 ×2, 4204, 4206 ×3, 4208 update-IR, 4428, 3364, 4491
function-binding): 202/208 on branch, **the same 6 failures as on base**
(4121 ×2, 4122 ×2, 4491 ×2 — pre-existing, not touched here).
`node scripts/equivalence-gate.mjs` on the branch: exit 0, 2,447 passing,
20 failing, no new regressions (2 baseline failures now pass —
`delete-sentinel` and `reflect-api`; not ratcheted here, main owns the
baseline).

### Residuals — NOT fixed here, need their own issues

Item 1 is filed as [#7184](7184-widened-binding-stale-checker-type-reads.md),
and item 2 is fixed. Items 3 and 4 are outside this issue's write analysis and
have no id yet. Each is a separate mechanism:

1. **A widened binding's READS still carry the initializer's checker type.**
   `var r = 'r'; r = id(1); var s = r; '' + s` traps: `s` takes its slot from
   `r`'s stale type `string`, so the widening does not propagate through an
   initializer. Same root for a call argument (`g(r)` with
   `function g(a){ return '' + a }` answers `"null"`) and for a function's
   inferred return type (`return r` → string result). 4/4 cells, both lanes.
2. **(Fixed in review round 1, finding 6.)** **Destructuring-assignment RHS object literal typed from the pattern.**
   `({ a: r } = { a: id(1) })` (or `{ a: 5 }`) stores `undefined`: the RHS
   literal is compiled against the pattern's contextual type `{ a: string }`,
   so the value is lost before it reaches the (now correctly widened) slot.
   The shorthand form from a variable source works. 4/4 cells.
3. **`typeof x` before a function-local `var x = 'init'`** folds to
   `"string"`; `readPrecedesVarInitializer` (typeof-delete.ts) is module-only.
   2/4 cells (function scope).
4. **`id(true)` returns a Number** — `function id(x){ return x }` called only
   with a boolean: `typeof id(true) === 'number'`. Parameter/return inference,
   no slot involved; the plan excludes params. 4/4 cells.

Also seen, pre-existing and identical on base: `[a = 99] = [null]` fires the
default (array-pattern default treats `null` as `undefined`).

## Review round 1 (opus, 2026-10-28)

Fresh-context adversarial review of `b7701d9c83` (PR #6954, review comment
6474478996): REQUEST CHANGES — 2 blocking findings, 5 nits. Every finding was
reproduced before it was fixed, with node as the oracle, on standalone and gc,
at module scope and in a function (`.tmp/probe.mts`). Base = `b6250f09f8`
(`origin/main`), first head = `b7701d9c83`. A cell is one (scope × lane).

| # | finding | outcome |
|---|---|---|
| 1 | a rest target splits an array local (BLOCKING regression) | fixed |
| 2 | two write enumerators that disagree (BLOCKING) | fixed — one enumerator |
| 3 | a nested pattern's default hides its non-literal source | fixed |
| 4 | annotated function locals over-widened | fixed — an annotation covers every write TypeScript checked |
| 5 | `typeof` / equality / closure-return stale types, captured locals | `typeof` fixed; equality and closure return are residuals |
| 6 | a literal RHS loses its value silently | fixed — the literal is lowered against its own type |
| 7 | optional fields + `!`, two `stripParens`, call-site `++`/`--` filter | fixed |

### 1 — a rest target splits an array local (fixed)

Two halves, both needed:

- **Analysis.** A rest element is write kind `rest`, tag `object`: it always
  stores a fresh Array or Object. `var y = [9]; if (c) [...y] = [1, 2]` keeps
  its vec slot again, as on base.
- **Codegen** (`expressions/assignment.ts`). The rest-identifier store now
  resolves exactly like an element target: the binding's own local or module
  global, coerced on store. The old code allocated a second, vec-typed `$y`
  whenever the slot was `externref` and redirected the name (#962/#971), so
  every read after a conditional or looped rest write saw the dead original.
  At module scope it never looked up the module global at all and wrote a
  fresh `__module_init` local — a base bug the first head inherited.

| shape (`fn` / `mod`, both lanes) | base | first head | now |
|---|---|---|---|
| `var y = [9]; if (id(false)) [...y] = [1, 2]; y.length` | ok / trap | trap / trap | ok / ok |
| looped rest into `var y = [9, 9]` | ok / wrong | wrong / wrong | ok / ok |
| `var y; if (id(false)) [...y] = [1, 2]; typeof y` | wrong / wrong | wrong / wrong | ok / ok |
| `var y = 's'; [...y] = [1, 2]; typeof y` | wrong / wrong | wrong / ok | ok / ok |
| `var y = 's'; [...y] = [1, 2]; '' + y` | trap / ok | ok / ok | ok / ok |

One shape moves the other way, and it is residual A below:
`var y = 's'; [...y] = [1, 2]; y.length` was right on the first head in every
cell and on base at module scope, and traps now in every cell. Those answers
came from the shadow local itself — straight-line code read the fresh vec
local. The store now lands in the binding's own, correctly widened slot, and
`y.length` reads it through the stale checker type `string` and traps,
exactly as `var y = 's'; y = id([1, 2]); y.length` traps in every cell on all
three trees. The shadow local is what made the conditional and looped rows
above wrong.

**Correction (round 2).** This paragraph called the trade "loud, not silent".
That was wrong. The number and boolean twins (`var y = 0` / `var y = true`,
then `[...y] = [1, 2]; '' + y.length`) answered a silent `null` at module
scope, and `[, ...r] = [1, 2, 3]; r.length` trapped. Round 2 fixed every row:
see "Review round 2" below.

### 2 — one write enumerator (fixed)

`src/shared/identifier-writes.ts` is gone. `src/shared/binding-writes.ts` is
the single enumerator, and both questions are projections of it:

- `identifierWritesOf(node, { updates? })` names every store one node
  performs, with what it stores: plain / logical / compound assignment (`+=`
  as the `value` of the assignment itself, since the oracle answers its result
  type; the numeric forms as `numeric`), destructuring (assignment AND binding
  patterns), `++`/`--`, for-in heads (`key`, always a string), for-of heads
  (`element`), through parentheses and TS wrappers (`as`, `!`, `satisfies`,
  `<T>x`), and a `var` declarator with an initializer (a re-declaration is a
  write; a caller that knows a binding's own declarator skips it).
- `isLexicalBindingWrite` keeps its climb to the root write node and answers
  `identifierWritesOf(root).some((w) => w.target === id)`;
  `varDeclaratorWrittenNames` is the declarator projection.
- `numeric-property-analysis.ts` lost its private branches and
  `ALWAYS_NUMERIC_COMPOUND` (now the shared `isNumericCompoundAssignment`):
  every non-declarator store comes from the enumerator. Its for-in/for-of
  pattern heads now define their targets, so the reviewer's
  `var a = 5; for ([a] of id([['x']])) {}` reads `typeof a === 'string'` in a
  function (was `'number'`, value NaN). Net −20 lines in that file.
- The module analysis passes `{ updates: false }` instead of filtering
  `++`/`--` at its call site, and skips a declarator's own store.

**Parity.** Old vs new `isLexicalBindingWrite` and `varDeclaratorWrittenNames`
over every identifier / declaration of the source files in `src/`,
`scripts/`, `tests/equivalence/`, the playground examples, and test262
`language/`, `annexB/`, `built-ins/`, `staging/`, `harness/` (53,000 files,
3.24 M identifiers, 319 k declarations; `.tmp/parity.mts`): **0** declarator
differences and **4** identifier differences, all in the early-error syntax
tests `language/statements/for/S12.6.3_A8*.js`, where
`for (…; {index++; index*2;})` parses as `{index}++` and the old climb called
that a write of `index`. `tests/binding-writes.test.ts` pins per-shape answers
and the projections over nine shape families.

The reviewer's examples now: `var n = 1; n += 'x'` → `'' + n` and `typeof n`
right on 4/4 cells (4/4 wrong before); `var r = 'r'; var r = id(1)` right on
4/4 (the function cells trapped); `var r = 1; for (var r in {a: 1}) {}`
right on 4/4 (function cells wrong); `(r) = id(1)` at module scope right (it
trapped on base). The module-scope for-in and for-of-pattern cells stay wrong,
as on base, for a lowering reason — residual B.

### 3 — a nested pattern's default (fixed)

A nested pattern with a default now collects from its source element AND from
its default. `var a = id([[1]]); [[r] = ['z']] = a; '' + r` is right on 4/4
cells (trapped on base and first head); the default-taken twin stays right.

### 4 — an annotation covers every write TypeScript checked (fixed, narrower than proposed)

For a declaration with an explicit TypeScript annotation,
`bindingHasMixedAssignmentCarrier` now counts every write whose value
TypeScript checked against that annotation as storing the declared
(initializer's) tag — the module analysis's rationale: a violation is user
error under diagnostics-off compilation. A value typed `any` / `unknown` is
unchecked and keeps its own verdict. The #2917 struct-identity check
(`crossesUntypedObjectReturns`) is about representation, not type, and still
runs. The new `identifierWriteFact` (`checker/oracle.ts`) names the fact of
the value a write stores; `identifierWriteTag` is now its tag plus the three
kinds whose tag needs no fact.

| program (standalone) | base | first head | now |
|---|---|---|---|
| `let x: number = 0; let vals: number[][] = [[7]]; [[x]] = vals; return x` | 32,872 B | 91,919 B | **32,872 B**, sha-identical |
| `let a: number \| null = 5; [a = 99] = [null]; return a === null ? 0 : (a as number)` (`issue-1550-dstr-init-skipped` #6) | 32,535 B | 92,093 B | **32,535 B**, sha-identical |
| its object twin `({ a = 99 } = { a: null })` (#7) | 54,931 B | 92,630 B | **54,931 B**, sha-identical |

**Why not the module analysis's whole rule** (skip every annotated
declaration), as proposed: measured, it regresses. An `any` value is not
checked against an annotation, so an annotated local assigned one must keep
its carrier. With the whole rule, `tests/equivalence/issue-7154-any-array-share-sweep.test.ts`
under `JS2WASM_FULL_SWEEP=1` fell from 754/754 (base) to 750/754:
`let ys: any[] = []; const xs: any[] = (ys = o)` with `o: any` holding a
typed vec stopped aliasing (four "init via nested =" rows, ok → wrong). A
`let r: string` local assigned `id(1)` would null the value — this issue's
own bug. With the checked-writes rule the sweep is 754/754 again and its test file
is back to main's version. `tests/issue-4495.test.ts`
pins both sides — the f64 slot, and `ys` still aliasing `o`.

The first round's note on `[a = 99] = [null]` still holds: the slot stays
externref (a nullable primitive), and route 2 sees the `null` through the
shared enumerator.

### 5 — stale types for captured locals (partly fixed)

- **`typeof`, fixed.** A local a closure writes lives in a ref cell, so
  `slotIsDynamicButStaticallyPrimitive` now reads the cell's value type, not
  the local's. `var r = '5'; var g = () => { r -= 1 }; g(); typeof r` is
  `'number'` on 4/4 cells (function cells wrong on base and first head).
- **Equality, residual.** `var r = 'r'; [r] = [id(1)]; r == 1` traps with an
  illegal cast on 4/4 cells on all three trees. A missing guard is not the
  cause: even at module scope, where the #4264 guard exists, it lowers to
  `__str_to_number(r) == 1` — the string-vs-number route, chosen from the
  stale checker type `string` before that guard is consulted. Residual A.
- **Closure return, residual.** `function () { return r }` over a captured
  widened local still returns the checker's `string` (function cells wrong on
  all three trees); the module twin is right since the first head. The fix
  needs a declaration-keyed carrier verdict reachable from another function's
  codegen. Residual A.

### 6 — a literal RHS keeps its value (fixed)

The value was lost before it reached the slot: a literal a destructuring
pattern receives is contextually typed by the PATTERN, so `[r] = [1]` built a
`[string]` tuple and stored `null` for the `1`. New
`src/codegen/expressions/destructuring-source-literal.ts`: `literalContextualType` is the
contextual type the array and object literal lowerers start from, and for
such a source it answers none, so they fall back to the literal's own type.
`literals.ts` changes by one import plus two one-for-one line swaps (and loses
two raw `ctx.checker` calls). Kept narrow:

- one decision per source tree, so the levels of a nested literal agree on
  their struct types;
- `null`/`undefined` values and pattern holes never count, so the `undefined`
  sentinel a default relies on (#801 / #1024) keeps its contextual lowering;
- a level the context lowers as a vec keeps it — a pattern with a rest
  (`[r, ...rest] = [1, 2, 3]`): the literal's own type is a full-length tuple
  and the rest lowering reads only a vec. (A first cut without this rule broke
  `tests/equivalence/issue-6992-outer-write-shapes` "array rest target".)

Right on 4/4 cells each, where base trapped and the first head answered
`"null"`: `[r] = [1]`, `[[r]] = [[1]]`, `[, r] = ['a', 1]`,
`[{ a: r }] = [{ a: 1 }]`, `({ r } = { r: 'a', r: 1 })`, `({ a: r } = { a: 1 })`
and `({ a: r } = { a: id(1) })` (the first round's residual 2). Also right
now, wrong on base: the cross-type swap `var a = 'x', b = 1; [a, b] = [b, a]`,
`var b = true; [b] = ['s']` and `var n = 0; ({ n } = { n: 'q' })`. A pattern
with a rest keeps its context, and `[r, ...rest] = [1, 2, 3]` stays right.
(This section also claimed `[, ...r] = [1, 2, 3]` stays right. It did not:
`r.length` trapped once `r` was read as an array. Round 2 fixed it.)

### 7 — quality (fixed)

`IdentifierWrite` is a discriminated union (`value` / `element` / `property`
/ `numeric` / `key` / `rest` / `unknown`), so no `write.expr!` remains;
`mixed-assignment-carrier.ts` imports the one `stripParens`; the `++`/`--`
exclusion is the `updates: false` option.

### Validation (all run by me, 2026-10-28, same box)

- **Tests.** `tests/issue-4495.test.ts` 180/180 (110 new: every row above, both
  lanes × both scopes, plus the annotated-slot and aliasing check); `tests/binding-writes.test.ts`
  35/35.
- **Equivalence files** touching destructuring, closures, compound / logical
  assignment, for-in/for-of and `typeof` (44 files, on the earlier cut of
  finding 4): 528/532; the 4 failures are all listed in
  `scripts/equivalence-baseline.json`. The gate below covers every file on
  the final tree.
- **Neighbouring suites** (48 files: #1024, #1719, #2917, #3364, #3366, #3765,
  #3961, #4121, #4122, #4131, #4204, #4206, #4208, #4428, #4491, #4616, #4707,
  #5269), final tree: 30 failures — the identical set on base.
- **Equivalence gate**, `SHARD=k/8` for k = 1…8, final tree: all eight exit 0
  — 2,455 passing, 20 failing, every failure in the baseline, no new
  regression. Two baseline failures pass (`reflect-api` Reflect.construct,
  `delete-sentinel` string property), as in the first round; not ratcheted
  here (main owns the baseline). An earlier run, with the whole-rule cut of
  finding 4, failed shard 5 on the #7154 row described there.
- **Byte identity**, base vs now, every template program in
  `tests/equivalence/*.test.ts` (as `.ts`, and as `.js` when annotation-free)
  plus `website/playground/examples/**/*.ts`, on both lanes: **3,484 / 3,486**
  binaries identical (the first head differed on 14). The two that differ are
  one program, `iterator-protocol-custom.test.ts` #1, gc and standalone
  (+34 B each): `let s = 0; for (const v of anyIterator) s += v` — `$s` is now
  `externref`, exactly what base already emits for the spelled-out
  `s = s + v` (132,861 B, same size). `s += v` with a string `v` stores a
  string, which an f64 slot cannot hold. The closure-capture and loop-boxing
  callers are byte-identical by construction (parity above).
- **String-heavy bench** (untyped `.js` loop exercising `||=`, `&&=`, swaps,
  `++`, `-=`, `+=`, string `+=`, for-of over strings, for-in): byte-identical
  sha on base / first head / now, both lanes (standalone `51aea3d691563195`
  56,511 B; gc `ccdb3c8fe0877cc9` 106,853 B), so runtime is identical.
- **Scoped test262 A/B** (in-process `runTest262File`, base vs now, same
  test262 checkout, no runtime-eval provider in either arm), 1,824 files:
  `language/expressions/{assignment, compound-assignment, logical-assignment,
  postfix-increment, prefix-decrement}`, `language/statements/{for-in,
  for-of, variable}` (for-of `dstr/` without its generator / async variants).
  Both lanes, both arms: **1,694 pass / 114 fail / 16 CE**, **0** status
  flips, identical per bucket. The only error-text differences (43 rows per
  lane) are the eval-provider path each arm reports as missing. The arms ran
  on the tree before finding 4's second cut; that cut reads only
  TypeScript annotations, which these JavaScript files do not have.
- **Gates** (each run bare, `LOC_GATE_BASE` = the `origin/main` sha): LOC
  budget, function budget, coercion sites, oracle ratchet, dead exports,
  import cycles, compiler-boundaries inventory, IR layering and IR fallbacks
  — all exit 0. The only LOC growth needing a grant is `literals.ts` +1 (the
  import), granted in this file's frontmatter; the oracle ratchet nets
  `ctx.checker` −1.

### Residuals — not fixed here, filed in round 2

Each is a separate mechanism, and each now has its own issue:

- A: [#7184](7184-widened-binding-stale-checker-type-reads.md)
- B: [#7185](7185-module-scope-for-head-writes-module-global.md)
- C, D and E: [#7186](7186-destructuring-assignment-lowering-residuals.md)

Round 2 fixed A's element-read row.

- **A. Stale checker type on reads of a widened binding** (the first round's
  residual 1, wider now): element reads (`y[1]` after a rest write into a
  string-initialised binding; traps on main too), loose equality (`r == 1` → `__str_to_number(r)`, illegal cast on every tree),
  a closure's inferred return over a captured widened local, call arguments
  and initializers.
- **B. Module-scope lowering defects, identical on base.** A for-in identifier
  head at module scope stores the key into a function-local `$k` in
  `__module_init` (`forInIdentifierHeadLocal`, `statements/loops.ts`), never
  into the module global — whose slot now correctly widens (`__mod_k`
  f64 → externref). A for-of pattern head at module scope does the same
  (`(local $a externref)` in `__module_init`, `__mod_a` widened).
- **C. A pattern default is lowered against the pattern's element type**:
  `var r = 'r'; [r = 5] = []; '' + r` is wrong on base and now alike.
- **D. TS wrapper targets lose the store**: `r! = id(1)` and
  `[r as any] = [id(1)]` widen the slot now, but the assignment lowering
  drops the value (wrong on base and now alike).
- **E. Pre-existing destructuring defects, identical on base.** A rest from a
  tuple source (`[[s], ...q] = [[1], 2]`) leaves `q` unassigned
  ("Rest on tuples is not supported" in `compileArrayDestructuringAssignment`).
  The first round's `[a = 99] = [null]` note: my probe of it (`.ts`,
  `skipSemanticDiagnostics`, `deferTopLevelInit`, `a === null ? 1 : 2`) still
  answers the default on all three trees, while the equivalence spelling
  (issue-1550 #6) passes everywhere — a harness-option difference, not traced.

### Follow-ups (not done here) — filed as [#7187](7187-fold-private-write-walkers-and-stripparens.md)

Two more private write walkers remain outside the shared enumerator:
`src/ir/dynamic-local-widening.ts` (#3795 — deliberately narrow, and it only
ever widens, so a missed write cannot make it unsound) and
`src/ir/const-binding-writes.ts#bodyWritesIdentifier` (#7014). Folding either
changes IR claim decisions, so it needs its own byte-identity check.

## Regression fix before round 2 (opus, 2026-10-28)

The round-1 fixes made `var y = 's'; [...y] = [1, 2]; y.length` trap on all
four cells (main: right at module scope only, by reading the never-written
string). Cause: `compilePropertyAccess` dispatched on the checker type of the
receiver (`string`), so the string `.length` arm coerced the widened externref
slot to a native string, got `null` for the array, and read its length.

Fix: `memberReceiverStaticType` (in `heterogeneous-scalar-var-widening.ts`,
beside the `slotIsDynamicButStaticallyPrimitive` guard the `typeof` fix uses)
answers `any` for a receiver identifier whose slot is widened, so every member
read takes the dynamic arms. `compilePropertyAccess` swaps one line for it.

| `var y='s'; [...y]=[1,2]` then | main | round-1 head | now |
| --- | --- | --- | --- |
| `y.length`, module | 2 | trap | 2 |
| `y.length`, function | trap | trap | 2 |
| `y[1]`, both scopes | trap | trap | trap (residual A) |

Both lanes identical. Playground corpus: 26/26 binaries byte-identical to the
round-1 head. `tests/issue-4495.test.ts` 184/184 (one new case, four cells),
`tests/binding-writes.test.ts` 35/35; every gate exits 0 against
`origin/main`.
