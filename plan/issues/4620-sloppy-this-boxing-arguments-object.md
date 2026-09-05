---
id: 4620
title: "ES5 standalone: sloppy-this boxing + primitive expando + arguments-object surface — function-code 10.4.3-1-* family, arguments descriptors, callee rows (~30 rows)"
status: in-progress
sprint: current
created: 2026-08-16
updated: 2026-08-22
assignee: ttraenkler/dev-4620
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: this-binding
goal: standalone-gap
related: [4489, 4464, 4436]
origin: "2026-08-16 residual map at 97.26%. language/function-code ~10 + language/arguments-object 6 + statements/function residual ~14 share this-binding/arguments-object roots."
---

# #4620 — sloppy-this boxing + arguments-object surface

## Problem (measured 2026-08-16)

- **A — sloppy `this` primitive boxing (`10.4.3-1-10x` family, ~8)**:
  `fn.call(5)` in sloppy mode must box: `(5).x = 'foo'` on the boxed this,
  `typeof this === "object"`, `this == 5` true, `this === 5` false.
  Measured shapes: `(5).x === 5` false rows, `typeof (5).x` expected
  "object" got other, TWO **illegal cast [in __module_init]** rows
  (10.4.3-1-102-s/-102gs — crash class, diagnose FIRST), `eval("typeof
  this")` strict row, `10.4.3-1-83/84-s` "not a function".
- **B — arguments-object property surface (6)**: `length` descriptor must
  be `{writable:true, enumerable:false, configurable:true}` (10.6-6-2,
  10.6-7-1); `typeof arguments[i]` where arg is a function (10.6-13-a-1);
  `S10.6_A5_T3/T4` "arguments object don't exists" (arguments inside
  nested/expression shapes); `Array.isArray(arguments)` false row.
- **C — statements/function residual (~14 non-prototype rows)**:
  `callee === 0` rows (arguments.callee identity), `__instance is not a
  function` (2), `Cannot destructure null` (1), `S13_A2_T2` x==="11",
  function-code S10.2.1_A4_T1/T2 (declaration-instantiation order),
  `S12.9_A5` return-undefined, `S8.1_A2_T2`/`S8.3_A1_T1` void-return
  rows, identifier-resolution scope-chain rows (S10.2.2_A1_T3,
  S11.1.2_A1_T1 "y is not defined").
- **NOT here**: isPrototypeOf rows (→ #4506 fnctor representation).

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   all families live first; crash-class rows (A's illegal casts) FIRST.
2. A: find the sloppy-this substitution site (`helpers/sloppy-this-global.ts`
   — #4489's catalogue documents its §10.4.3 fallback semantics). The boxing
   arm: primitive this → wrapper object with expando storage. The #4489
   undefined-singleton interplay is documented in its issue file — read the
   sloppy-this row of its consumer catalogue before touching.
3. B: arguments-object materialization (`function-expected-argument-count.ts`
   #4436, the `arguments` sections of new-super.ts) — descriptor surface
   goes through whatever gOPD consults; check how #4479's descriptor lane
   stores attributes and reuse.
4. C: triage per-row; declaration-instantiation-order rows may be one
   hoisting fix; scope-chain rows may route to eval-scope machinery
   (decline+record if eval-substrate-walled).
5. Verify: scoped standalone sweeps language/function-code + language/arguments-object
   + language/statements/function before/after (own runs); pins
   4436/4437/4464/4489 green; ≥15 of ~30 flip, zero regressions; residuals
   with owners.

## Root cause

Both crash classes in family A turned out to be **nothing to do with
`this`-binding semantics**. Each is a lowering defect that happens to be
reachable only through a `this`-shaped test.

### A1 — `illegal cast in __module_init` (10.4.3-1-102-s, -102gs)

`String.prototype.replace(searchString, fn)` has had a function-replacer arm
since #4224 (`regex-replace-fn.ts`), but it only accepts a replacer that
compiles to a closure **struct** with a registered `ClosureInfo`. That covers
an inline function expression and a function DECLARATION referenced by name.
It does **not** cover a function VALUE that reaches the call site as an opaque
`externref`:

```js
var g = function () { … };            "ab".replace("b", g)
"ab".replace("b", (function () { "use strict"; return function () { … } })())
```

The second line is exactly what 10.4.3-1-102-s writes. `stageReplacerClosure`
declined, `tryCompileStandaloneStringValueReplace` therefore returned
`undefined`, and control fell through to the **naive native arm** in
`string-ops.ts` (`method === "replace" && firstArgIsStringLike`), which
compiles its replacement operand straight into a `ref $AnyString` slot. The
emitted `any.convert_extern; ref.cast (ref null $AnyString)` on a closure
struct is the trap. Confirmed by bisection: the crash is independent of
`this`, of `"use strict"`, and of the replacer's body — `var g = function () {
return "a"; }; "ab".replace("b", g)` traps identically, while the same
function as a DECLARATION does not.

### A2 — `unreachable in __named_this_call_*` (10.4.3-1-1-s, -2-s, -4-s, -5-s)

These four rows are the actual primitive-`this` boxing family
(`foo.call(1)` → `typeof this` is `'number'` strict / `'object'` sloppy).
The receiver-install trampoline (`named-this-call.ts`, #4025/#4203) wrapped
its exact call in

```wat
try_table (result (ref null $AnyString)) (catch $exc 0) … end
```

**A `try_table` whose block type is a CONCRETE ref traps `RuntimeError:
unreachable` when the instruction is ENTERED**, on Node v22.22.2 /
V8 12.4.254.21. Isolated in a hand-built module with no compiler involved
(`.tmp/v8-trytable-probe.mjs`): `i32` and `externref` block types run fine,
`(ref null <typeidx>)` traps, and nothing is thrown in any variant. In the
compiled module the same conclusion was reached independently two ways —
a side-effect probe showed the protected callee never ran, and binary-patching
the two `try_table`s to plain `block`+`nop`s made the identical module return
the right value.

So every `foo.call(x)` on a named function that reads `this` and returns a
**string or an object** died in the trampoline; `i32`/`f64`-returning targets
were unaffected, which is why it stayed invisible. The ordinary `try`/`catch`
lowering never produces the shape: it emits an EMPTY try_table block type and
`return`s out of the protected body.

## Fix

1. **`src/codegen/replacer-apply-bridge.ts` (new)** — an opaque-callable arm
   for the replacement value. When the replacer compiles to something other
   than a registered closure struct, the per-match call goes through the
   standalone lane's existing dynamic-apply bridge:
   `__objvec_new` / `__objvec_push` build the argument carrier and
   `__apply_closure(fn, recv, args)` (#1888) invokes it, dispatching to
   `__call_fn_method_N`. No new dispatch mechanism.
   - The receiver is `ref.null.extern`, **not** the `undefined` singleton:
     §22.1.3.19 step 14 calls with `undefined`, and only the CALLEE knows
     whether §10.4.3 turns that into the global object (sloppy) or leaves it
     `undefined` (strict). Its own `ref.is_null` fallback makes that call —
     the non-null singleton would defeat it (`helpers/sloppy-this-global.ts`
     `thisReceiverIsGlobalObject`, and #4489's catalogue row). Verified in a
     script-goal probe: a sloppy opaque replacer sees `typeof this ===
     "object"`; a strict one sees `undefined`.
2. **`src/codegen/regex-replace-fn.ts`** — `stageReplacerClosure` now returns
   a discriminated `StagedReplacer` (`closure` | `opaque`), and
   `buildReplacerCallInstrs` branches on it. Both the RegExp and the
   string-search lanes get the arm for free. The closure path is unchanged.
3. **`src/codegen/named-this-call.ts`** — for a ref-typed result the
   trampoline now gives its `try_table` an EMPTY block type and parks the
   call's result in the `__result` local INSIDE the protected body, reading it
   after the scaffold. Scalar results keep the existing value-typed shape, so
   their bytes do not move.
4. **`plan/method/es5-standalone-agent-brief.md`** — the concrete-ref
   `try_table` hazard is recorded as campaign lore (how to recognise it, the
   pattern to use instead, and the grep for other emitters).

## Test Results

All numbers below are from runs I executed in this worktree.

**Environment note (the #4484 trap, hit again):** a fresh worktree has no
`.test262-cache`, and the artifact key here did not match the main checkout's
(`quickjs-artifact-2e2d7736713beeda` wanted vs `…-d8a5a91d6f183b87` present),
so **56 eval-dependent rows failed as "quickjs provider is not built"** in the
first baseline. They were re-measured on the SAME (base) sources with
`JS2WASM_QUICKJS_ARTIFACT_DIR` pointing at the existing artifact — 46 of them
pass — and the corrected baseline is what every comparison below uses. Any
sweep of `language/function-code` without that env var under-reports by ~46
rows.

### Scoped standalone sweep — `language/function-code` + `language/arguments-object` + `language/statements/function` (931 rows)

| | rows |
| --- | --- |
| corrected baseline | **814 pass**, 108 fail, 9 compile_error |
| re-measured after the fix | 295 rows (189 blast-radius + 106 interleaved) |
| flips fail → pass | **6** |
| regressions | **0** |

Flipped (all crash-class, all attributable):

| row | baseline error |
| --- | --- |
| `function-code/10.4.3-1-102-s` | `RuntimeError: illegal cast in __module_init` |
| `function-code/10.4.3-1-102gs` | `RuntimeError: illegal cast in __module_init` |
| `function-code/10.4.3-1-1-s` | `RuntimeError: unreachable in __named_this_call_foo_92` |
| `function-code/10.4.3-1-2-s` | same |
| `function-code/10.4.3-1-4-s` | same |
| `function-code/10.4.3-1-5-s` | same |

Four rows looked like regressions in the batch and are **compile-timeout noise
from a load-15 box** (4 cores, four agents): `arguments-object/10.6-11-b-1`,
`10.5-7-b-3-s`, `10.5-7-b-1-s` each PASS when re-run serially, and
`statements/function/13.2-18-1` times out on the baseline too. None of the
four contains `.replace`/`.call`/`.apply`. Two apparent *fixes* in the same
class (`arguments-object/10.5-1-s`, `function-code/10.4.3-1-19-s`) are the
same noise in the other direction and are NOT counted above — re-run serially,
10.5-1-s passes on both sides and 10.4.3-1-19-s times out on both.

**Scope limit:** 636 of the 931 rows were not re-measured after the fix. They
passed at baseline and their sources contain no
`.replace`/`.replaceAll`/`.call`/`.apply`/`.bind`, so neither changed path can
reach them.

### Pins

- `tests/issue-4620.test.ts` (new, 11 cases) — green. Covers both fixed
  families plus the receiver save/restore and throw-propagation invariants of
  the trampoline.
- `tests/issue-4436.test.ts`, `tests/issue-4437.test.ts` — 42 passed.
- `tests/issue-4464.test.ts`, `tests/issue-4489.test.ts` — 35 passed (needs
  `JS2WASM_QUICKJS_ARTIFACT_DIR`; without it 5 of #4464's cases fail on the
  environment trap above, not on code).
- **A #4489 residual is retired by this work.** Its `it.fails` pin
  "reflective String.replace renders undefined as `[object Object]`" now
  PASSES; A/B'd by reverting only `regex-replace-fn.ts` +
  `named-this-call.ts` (fails on base, passes with the fix), so the pin was
  converted to a normal `it`. That was the blocker on 3 of #4465's 5 R1 rows.
- Scoped equivalence (per-file, never one invocation — OOM):
  `string-methods` 42, `regexp-methods` 22, `arrow-call-apply` 11,
  `hasownproperty-call` 5, `iife-and-call-expressions` 70, `issue-2177` 17,
  `rest-params-call` 4, `shape-inference` 4, `this-receiver-apply` 7,
  `arguments-object` 1 — all pass.
  `arguments-nested-and-loops` has 1 failure ("for-loop with function
  declaration in body", 30 vs 33) that is **pre-existing** — identical on base
  sources by A/B.

## Residuals

Everything below was measured here and is NOT fixed by this change.

### Family A — remaining

| rows | signature | note / owner |
| --- | --- | --- |
| `10.4.3-1-103`, `-104`, `-106` | `(5).x === 5` / `typeof (5).x` | `Object.defineProperty(Object.prototype,"x",{get(){return this}})` then a PRIMITIVE receiver: strict must hand the getter the primitive, sloppy a wrapper. Needs the boxed-receiver accessor path (`boxed-proto-valueof.ts` / `accessor-driver.ts`), not the `this` lowering. **standalone-gap, unowned.** |
| `10.4.3-1-17-s` | `eval("typeof this")` → "object", want "undefined" | eval-substrate; the evaluated code's `this` is not threaded. **runtime-eval lane.** |
| `10.4.3-1-83-s`, `-84-s` | throws `[object Object]` | `Function("…")`-minted strict function called with no receiver. **runtime-eval lane.** |
| `10.4.3-1-19-s`, `statements/function/13.2-18-1` | `compilation timeout (15–18 s)` | Compile-time, not semantics; both time out on base too. **compile-budget owner.** |

### Family B — arguments-object surface (untouched)

Measured signatures (my runs, corrected baseline):

- `10.6-6-2`, `10.6-7-1`: "length descriptor should be configurable" —
  `arguments.length` needs a real own property with
  `{writable, enumerable:false, configurable}`, not a struct field read.
  Probe: `arguments.length = "zz"` is silently ignored (`S10.6_A5_T4`), and
  `delete arguments.length` **crashes the compiler** (`compile()` throws with
  an empty message — worth its own bug).
- 9 `mapped/` rows: "0 descriptor value should be 2" —
  `Object.defineProperty(arguments, "0", …)` and the parameter↔index mapping.
- `mapped|unmapped/Symbol.iterator.js`: "should be an own property".
- `10.6-13-a-1`: `typeof argObj.callee` reads `"number"` — an escaped
  arguments object has no own `callee`, so an `Object.prototype.callee`
  planted by the test wins.
- `built-ins/Array/isArray/15.4.3.2-1-13`: `Array.isArray(arguments)` answers
  **true**. A syntactic arm would not fix it — the row escapes the object
  (`arg = arguments`) first, so this needs a runtime BRAND distinguishing the
  arguments vec from an array. That is representation work adjacent to
  #4506's fnctor lane.

All of family B is one piece of work — a descriptor sidecar for the arguments
vec — and should be scoped as its own issue rather than smuggled in here.
**standalone-gap, unowned.**

### Family C — statements/function

- `S13.2.2_A18_T1/T2` (`callee === 0`): both need `with (arguments) { … }` —
  the `with` scope over an arguments object. Deep; not a `callee` bug.
- `arguments-with-arguments-lex.js`: `RuntimeError: illegal cast in f()` —
  ES6 FunctionDeclarationInstantiation edge (a default-param expression reads
  `arguments` while the body shadows it). Crash class, exotic shape.
- `S13.2.2_A17_T3`: `dereferencing a null pointer in __module_init`.
- The `dstr/` rows (`illegal cast in __iterator_next`, `Cannot access property
  on null or undefined`) belong to the destructuring/iterator lane.
- The `gen-*`/`async-gen-*` trailing-comma rows in this directory are a
  generator-lowering bucket, not this issue's.

### Cross-cutting — the concrete-ref `try_table` hazard

Recorded in the campaign brief. Audit of the other emitters that pass a
non-empty block type to `buildStandardTryTable`/`buildTargetTaggedTry`:

- `src/codegen/expressions.ts:620,649` — `externref` block type. **Safe**:
  the hand-built probe shows single-byte abstract ref types execute correctly.
- `src/ir/backend/wasmgc-emitter.ts:440,471` — block type is a parameter, so
  the shape is *reachable*, but both callers in `src/ir/lower.ts:3042,3076`
  pass `{ kind: "empty" }`. **No live exposure today**; a future IR try/catch
  that yields a value must not pass a concrete ref type.
