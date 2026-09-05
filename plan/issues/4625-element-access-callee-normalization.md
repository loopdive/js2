---
id: 4625
title: "standalone: string-literal element-access callee `x[\"toString\"]()` never reaches the property-access dispatch — normalize onto the fixed route; unblocks property-accessors S11.2.1_A3_T1/_T2 remaining checks"
status: done
completed: 2026-08-23
sprint: current
loc-budget-allow:
  # +14 lines, ALL of it dispatch. The normalization body, the ambient-member
  # condition and the whole placement argument live in the new subsystem module
  # `expressions/element-access-callee-normalization.ts`, which is what #3102
  # asks for. What cannot move out of the driver is the ROUTE:
  #   call-tail-dispatch.ts +14 — one import + a 13-line block (8 of them
  #                               comment) whose only job is to sit between the
  #                               array-method arm and the `cea` arm. That
  #                               POSITION is the fix — one line earlier it
  #                               would claim shapes the earlier arms already
  #                               lower correctly, one line later `cea` has
  #                               already claimed the call. A reader at the call
  #                               site cannot see either constraint without the
  #                               comment, so it stays here rather than in the
  #                               module header (where it is also stated, at
  #                               length).
  - src/codegen/expressions/call-tail-dispatch.ts
func-budget-allow:
  # The same +13 lines counted per function — `compileTailDispatch` IS the
  # element-access dispatch ladder, so a new rung in that ladder has no other
  # home. Nothing was added to it beyond the routed call.
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
created: 2026-08-23
updated: 2026-08-23
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: member-access
goal: standalone-gap
related: [4619, 4481]
origin: "dev-4619 R1 (2026-08-23): base AND after both throw 'Cannot access property on null or undefined' — a static-key ElementAccess callee has its own dispatch chain that never reaches the route #4619 fixed. Blast radius wanted its own issue."
---

# #4625 — element-access callee normalization

## Problem (measured by dev-4619)

`x["toString"]()` (string-literal key, callee position) throws
`TypeError: Cannot access property on null or undefined` on shapes where
the property-access spelling `x.toString()` now works (#4619's
wrapper-proto dispatch). A static-key `ElementAccessExpression` callee is
lowered by its own dispatch chain (`src/codegen/expressions/
call-tail-dispatch.ts`) which never consults the property-access route
that #4619 (and #4481/#2175 before it) taught about wrapper receivers and
singleton-carried proto-method values.

This is the whole of what still blocks
`language/expressions/property-accessors/S11.2.1_A3_T1.js` (CHECK#2/#4)
and `_T2.js` (CHECK#3/#4) — both rows' first checks pass since #4619.
Pinned `it.fails` in tests/issue-4619.test.ts (R1).

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   the two rows + the R1 pins on current campaign HEAD.
2. Normalization point: early in the call lowering, rewrite a callee of
   shape `ElementAccess(expr, StringLiteral k)` where `k` is a valid
   identifier-shaped key onto the same code path as
   `PropertyAccess(expr, k)` — ONE canonical entry, not a parallel
   re-implementation inside call-tail-dispatch.ts. Find where
   `call-tail-dispatch.ts` branches on callee kind and route, don't copy.
   Non-identifier keys (`x["a b"]()`) keep the element chain.
3. Mind the blast radius: element-access callees on arrays/vecs and
   computed-key numeric shapes must be byte-stable — the normalization
   must be conditioned on a STATIC string key only. Lane byte-identity
   check on host/gc for a probe set that exercises numeric element calls.
4. A/B: the two acceptance rows + #4619's R1 pins flip to positive +
   scoped `language/expressions/property-accessors` (21 files) and a
   `built-ins/{Boolean,Number}/prototype` re-sweep, zero regressions,
   own runs both arms.
5. Pins: tests/issue-4625.test.ts; flip #4619's R1 `it.fails` pins in the
   same change (the pin's design).

## Root cause (measured on base `9d9291db7`, all runs my own)

**The issue's framing — "the element chain never consults the
property-access route" — is right about the effect and wrong about the
mechanism, and the correction is what made the fix small.** The bracket
call does not fall THROUGH the element ladder and land in a hole. It is
**claimed, five arms before the end**, by
`compileCallableElementAccessCall` (#1306) — the `fns[i](…)` arm.

Traced with a temporary `console.error` at each arm (base copy restored
after):

```
[4625] enter resolved-key key=toString recv=false
[4625] cea claimed key=toString
THROW [object WebAssembly.Exception]
```

`cea` claims on ONE signal: TypeScript reports a call signature for the
element type. For `false["toString"]` that signature is real — it comes
from `interface Boolean` in `lib.es5.d.ts` — but the premise behind the
arm is not: the arm then READS a callable value out of the receiver, and
the compiler materialises no closure in that slot for a built-in method
on a primitive or wrapper receiver. The read yields null and `cea`'s own
`emitNullCheckThrow` produces the reported
`TypeError: Cannot access property on null or undefined`. The value being
"read" only exists as a lowering.

That is why the property-access route was never reached, and it is also
why the arm sitting anywhere later would not have helped: the call is
already gone by then. Measured directly — a probe placed at the graceful
decline fallback at the END of the resolved-key ladder never fired for
any of the three failing shapes.

Base probe matrix (16 shapes, standalone, one module per probe, both the
plain and the `sta.js` module shape):

| shape | base | after |
| --- | --- | --- |
| `false["toString"]()` | throws | 1 |
| `new Boolean(false)["toString"]()` | throws | 1 |
| `new Number(1)["toFixed"](5)` | throws | 1 |
| `(1)["toString"]()` | 1 | 1 |
| `(1)["toFixed"](5)` | 1 | 1 |
| `s["charAt"](0)`, `a["join"]("-")` | 1 | 1 |
| `a[0]()`, `o["m"]()`, `o["a b"]()`, `o[k]()` | 7 / 5 / 3 / 9 | unchanged |

The passing bracket rows are the tell: `(1)["toString"]()` works because
the **number-method arm** claims it first, `s["charAt"]` because the
native-strings arm does, `a["join"]` because `compileArrayMethodCall`
does. Only receivers with no dedicated bracket arm — booleans and wrapper
objects — reach `cea`.

## Fix

One new subsystem module plus a 14-line route.

- `src/codegen/expressions/element-access-callee-normalization.ts` —
  rewrites `recv["key"](args)` to `recv.key(args)` and recompiles.
  Follows the precedent already in the same driver: the `ctx.nativeStrings`
  string arm (#3027) recompiles the call as the dot form rather than
  duplicating the dot form's logic. One canonical entry.
- `call-tail-dispatch.ts` — the routed call, placed between the
  array-method arm and the `cea` arm.

**The condition is AMBIENT-MEMBER, not receiver-shape**, and that choice
is the design:

- it is the exact complement of `cea`'s premise. A member whose every
  declaration lives in a `.d.ts` is never a user closure parked in a
  slot, so "read the value and call it" is a fiction for it; a
  user-authored callable element (`fns[0]`, an object literal's `m`, a
  class field) has a declaration in the user's own file, declines, and
  keeps `cea` byte-for-byte;
- asking instead "is this receiver a Boolean wrapper?" would re-derive at
  a second site the receiver knowledge #4619 and #4481 put on the
  property-access route — the copy this issue exists to avoid.

Two implementation details worth keeping:

- **The declaration question is asked of the KEY LITERAL, not of the
  element access.** `getSymbolAtLocation` on the
  `ElementAccessExpression` answers `[]` for BOTH `false["toString"]` and
  `o["m"]`, so it cannot tell them apart; at the string-literal node the
  split is exact (`lib.d.ts` vs `p2.js`). The first cut asked the wrong
  node and declined silently on every shape — the probe matrix was
  unchanged, which is what caught it.
- **Optional element access declines.** `x?.["k"]()` carries
  short-circuit semantics a plain property access does not.

**Placement, and why it is not the plan's "early in the call lowering".**
The plan asked for the normalization early. Early is not implementable
without giving up byte-stability: every arm that already lowers a bracket
call correctly (iterator/RegExp symbol protocols, class and struct
methods, static methods, `string_*`, the number-method family,
`compileArrayMethodCall`) sits above, and routing before them would move
their bytes for no gain. Placed immediately before `cea` instead, those
arms run first and cannot move. Numeric and computed keys fail the
identifier-shape test, so the array/vec element-call shapes are
byte-stable **by construction**, not by review.

## Test Results

Every number below is from a run I executed on this branch. The A/B is a
file copy (`.tmp/base-call-tail-dispatch.ts`, captured at the first
edit), never `git stash` — other agents share this clone's ref stack.
Both arms ran under the same eval tier, `JS2WASM_QUICKJS_ARTIFACT_DIR=
…/quickjs-artifact-d8a5a91d6f183b87` (this worktree had no
`.test262-cache` at all — the #4484 trap; it was seeded from the main
checkout before any sweep).

**The blast radius is a MEASURED population, not a sampled directory.**
The arm can only claim a call spelled `<expr>["identShaped"](`. Grepping
the whole `test262/test` tree for that shape returns **227 files** — that
is every file in the corpus it can reach, and all 227 are in the sweep.
The harness (`sta.js`, `assert.js`, `propertyHelper.js`, …) contains
none, so no file is affected indirectly.

**Standalone sweep, 437 files** (the 227-file blast population ∪ the
issue's scoped set: `language/expressions/property-accessors` 21 +
`built-ins/Boolean/prototype` + `built-ins/Number/prototype` 194):

| | base | after |
| --- | --- | --- |
| pass | 360/437 | **362/437** |

Flip list — **+2, −0, and no status changed in either direction beyond
these two**:

- `language/expressions/property-accessors/S11.2.1_A3_T1.js` fail → pass
- `language/expressions/property-accessors/S11.2.1_A3_T2.js` fail → pass

**Host/gc sweep, 209 files** — the same blast population minus the 18
`dynamic-import/usage/…` rows, which crash the sweep PROCESS in the host
lane by actually importing a `_FIXTURE` module (they run fine in
standalone and are covered there). Run because the byte probe showed one
host-lane control moving (below), so the route change needed a
behavioural measurement rather than an argument:

| | base | after |
| --- | --- | --- |
| pass | 162/209 | **164/209** |

Same two rows, +2/−0. **The host lane was broken on base too** — both
rows failed there — so this fix is not standalone-only, and gating the
arm to `ctx.standalone` (the tempting way to buy total host byte-identity)
would have cost 2 real rows. That is why it is not gated.

**Lane byte-identity, 16 shapes × 2 lanes, sha256 of the emitted
binary.** 14 shapes are ones the arm must NOT claim (numeric keys,
computed keys, vec-of-closures, `a[0][0]()`, user string members,
non-identifier keys, class methods, and the already-working bracket
builtins); 2 are shapes it DOES claim, included so an all-identical
result cannot be a vacuous pass.

- **standalone: 14/14 non-claimed shapes byte-identical.** Only the 2
  claimed shapes move.
- **host/gc: 13/14 byte-identical.** The one that moves is
  `s["charAt"](0)`, and the reason is worth recording: the bracket string
  arm looks up a `string_<method>` import that is not registered in that
  lane, so it declines there and the call reaches this arm. It is a route
  change, not a behaviour change — the 209-file host sweep above is the
  evidence, and `tests/equivalence/string-methods.test.ts` passes.

**Pins.** All 30 vitest files in the repo that contain a bracket call
with an identifier-shaped key, each in its own invocation, run on BOTH
arms. The base/after diff is **exactly one line**:

```
< Tests  1 failed | 22 passed (23)  tests/issue-4619.test.ts
> Tests  23 passed (23)             tests/issue-4619.test.ts
```

That one line is #4619's R1 pin, flipped from `it.fails` to `it` in this
change per the pin's design. Six failures are **pre-existing and
identical on both arms** — `issue-3522-ir-cross-owner-free-function` (1),
`issue-3793-ir-acorn-retained-parser-wrappers` (1), `issue-4482` (1),
`issue-820b` (7), `unsupported-call-fallback` (1) — which is measured,
not assumed: the same 30 files ran on base and the counts diff clean.

- `tests/issue-4625.test.ts` — **12 passed** (new; 5 flip pins including
  a receiver-evaluated-exactly-once pin and a radix-survives-the-rewrite
  pin, 7 control pins). Also **12 passed under
  `JS2WASM_EVAL_ENGINE=interpreter`** — the file mints no module from a
  body string, so the refusal provider does not reach it, but the
  changed-root `quality` lane runs that tier and the brief says check
  rather than assume.
- `tests/equivalence/` per-file (the directory OOMs in one invocation),
  over the 4 files whose sources contain the affected shape plus 4
  adjacent ones — **153 passed, 0 failed**:
  `computed-property-class` (7), `computed-setter-class` (2),
  `super-element-access` (4), `iife-and-call-expressions` (70),
  `tostring-valueof` + `wrapper-constructors` (15), `string-methods` +
  `array-prototype-methods` (55).

**Gates**: typecheck, biome lint, prettier, oracle-ratchet (+0 —
`ctx.oracle.declarationsOf`, no raw checker), coercion-sites (+0),
dead-exports (0 new), pushraw (+0) all OK. loc-budget (+14) and
func-budget (+13, `compileTailDispatch`) need the allowances granted in
this file's frontmatter — the body is already in its own subsystem
module; what remains in the driver is the route and the comment
explaining why it sits exactly there. `check:godfiles` fails identically
on base and after (`object-runtime.ts`, `array-methods.ts`,
`native-strings.ts` — none of them touched here); verified by running it
on both arms and diffing the output.

## Residuals

- **R1 — const-folded and computed string keys are not normalized.**
  `var k = "toString"; x[k]()` keeps the element chain even though the
  key is statically knowable via `resolveComputedKeyExpression`. Narrowed
  to `ts.isStringLiteral` deliberately: the issue's shape is the literal
  one, no measured row needs the folded form, and widening the admission
  test widens the population that stops taking `cea`. Not measured as
  failing — measured as *unchanged* (`o[k]()` control, base and after).
  Owner: standalone-gap, unclaimed.
- **R2 (not a defect — measured, and pinned) — a user-overridden ambient
  member on a plain object routes to the dot form.**
  `var o = {}; o.toString = f; o["toString"]()` resolves its key symbol
  to `lib.d.ts` (the object's static type carries no own `toString`), so
  the arm DOES claim it and hands it to the property-access route — where
  #4482's `tryEmitStoredMemberClosureCall` is the dot-form handler for
  exactly that shape. This is the one place the ambient-member condition
  admits a slot that really does hold a user closure, so it was measured
  rather than argued: **base 1, after 1** (`.tmp/p2.mts`, standalone).
  Pinned in `tests/issue-4625.test.ts` so a later change to either route
  cannot move it silently.
- **R3 — the 18 `dynamic-import/usage/…` host-lane rows are unmeasured
  in the HOST lane only.** They crash the sweep process there by
  importing a real fixture module; their standalone results are in the
  437-file sweep and unchanged. Not a property of this change — any
  host-lane sweep touching that directory hits it.
