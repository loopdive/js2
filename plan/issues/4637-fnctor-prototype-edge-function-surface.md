---
id: 4637
title: "ES5 standalone: fnctor-prototype edge + Function-constructor surface — S13.2.2 family, Object(func) identity, apply/call as own-property values (~48 rows)"
status: done
completed: 2026-08-23
# Flipped in-progress→done at merge by the lead, per the agent's own gap
# statement: 4 of 5 acceptance clauses met; the unmet "A2 crashes gone" names
# S13.2.2_A17_T3, which the agent measured to be a `with`-statement scoping
# row (deferred feature), not a construct-return crash — mis-attributed in
# the plan, owner recorded in ## Residuals.
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 5
language_feature: function-objects
goal: standalone-gap
related: [4506, 4623, 4624, 4619]
origin: "2026-08-23 wave-3 residual map at 97.5% (196 true failures re-measured on branch tree, .tmp/sweep-204-all.jsonl). Lane A."
# (#3102) Intentional god-file growth for this change-set. Every entry is a
# WIRING line or a context-field declaration; the substance lives in the new
# `src/codegen/proto-function-value.ts` and in `closure-prototype-edge.ts`.
loc-budget-allow:
  # +25: the four `protoFunctionValue*` context fields + their doc comments.
  # `CodegenContext` is where the reserve-then-fill handshake state has to live —
  # `closurePropHelpersReserved` and its type/global indices are declared three
  # lines above, and splitting the twin across a second interface is what the
  # #4241 header calls "a private second copy of a layout fact".
  - src/codegen/context/types.ts
  # +19: two `fillProtoFunctionValue(ctx)` calls and two
  # `spliceClosurePrototypeEdgeHasOwn(ctx)` calls (single- and multi-source
  # FINALIZE), plus their ordering comments and one import. The FINALIZE
  # sequence is a single ordered list in this file by construction.
  - src/codegen/index.ts
  # +11: one decline clause in `staticTypeofForType` (the fold must not trust a
  # foreign-return fnctor INSTANCE shape) plus its measured rationale.
  - src/codegen/typeof-delete.ts
  # +8: one `reserveProtoFunctionValue(ctx, objectTypeIdx)` call inside the
  # existing standalone reserve block, plus the ordering comment that states why
  # it must sit between `reserveClosurePropHelpers` and
  # `buildObjectPrototypeHelpers`, plus one import.
  - src/codegen/object-runtime.ts
# (#3400) Intentional function growth for this change-set.
func-budget-allow:
  # +37: the four proto-position choke points (`__object_create`,
  # `__getPrototypeOf`, `__isPrototypeOf`, `__object_setPrototypeOf`) are all
  # registered inside this ONE function, and the whole point of the A1 fix is
  # that they agree. The added lines are two 6-line helper closures plus four
  # 1-line call sites and their comments; extracting them would put the
  # canonicalize/devirtualize pair in a third file away from the four bodies
  # that must stay consistent with it.
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  # +12 / +6: the FINALIZE call sequences (see the index.ts note above).
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  # +7: the reserve call + ordering comment (see the object-runtime.ts note).
  - src/codegen/object-runtime.ts::ensureObjectRuntime
---

# #4637 — fnctor-prototype edge + Function surface

## Problem (measured 2026-08-23 on branch tree, row list `.tmp/lane-A-function.txt` — regenerate via the sweep if absent)

Four families, ~43 rows in `language/statements/function` +
`built-ins/Function{,/prototype}` + `built-ins/Object/S15.2.{1,2}`, plus 5
Object-identity leftovers:

- **A1 — the fnctor-prototype EDGE (largest single blocker, ~10 rows)**:
  `function P(){}; function F(){}; F.prototype = P; new F()` leaves
  `Object.getPrototypeOf(m) === P` false — a FUNCTION value in the
  `.prototype` slot cannot be held by the `(ref null $Object)` `$proto`
  field. Named verbatim in `src/codegen/fnctor-instance-prototype.ts`
  (#4480 S2 residual) and re-confirmed by #4623 (its S13.2.2_A1_T1/_T2
  half-bar). Also behind `S15.3.5.3_A3_T2` (instanceof through a
  function-valued prototype).
- **A2 — S13.2.2 residual (~12 rows)**: ctor returning a FUNCTION
  (`__instance is not a function` — [[Construct]] step 9/10: a returned
  callable must BE the result and be callable), null-deref crashes
  (S13.2.2_A17_T3 — crash class, do FIRST), thrown-TypeError identity
  (S13.2.2_A2), named-funcexpr self-reference (S13.2.2_A19_T8).
- **A3 — `Object(func)` / `new Object(func)` identity (~8 rows)**:
  `Object(function(){})` must return the SAME function object, callable,
  with `.constructor === Function` — currently `n_obj is not a function`.
  #4479 slice 2 measured this family as "Object(v) loses the argument's
  carrier" (its residual table, 5 rows); `emitObjectCoercion`
  (`src/codegen/expressions/calls-guards.ts`) compiles the arg to plain
  externref. Includes leftovers `preventExtensions/15.2.3.10-2` (o2 === o
  identity through Object.preventExtensions return),
  `prototype/constructor/S15.2.4.1_A1_T2` (`new Object.prototype.constructor`),
  `valueOf/S15.2.4.4_A14` (`(1, Object.prototype.valueOf)()` comma-value
  call must throw), `S15.2.4_A1_T2`.
- **A4 — intrinsics as own-property VALUES (~10 rows)**:
  `obj.apply = Function.prototype.apply; typeof obj.apply === "function"`,
  then `obj.apply(...)` dispatches §19.2.3.1 with obj's own method
  (`obj["shifted"]` rows). The #4624 Function-marker work covered the gOPD
  surface; this is the STORE+typeof+call surface for borrowed intrinsic
  values on plain objects. `Function.prototype.toString` rows (2) remain
  from #4619 family A — extend the wrapper-proto toString render to user
  functions' `"function <name>() { [native code] }"` §20.2.3.5 legal form.
- **A5 — `Function(...)`-minted function surface (~6 rows,
  eval-tier-dependent)**: `built-ins/Function` S15.3.2.1 rows — a
  quickjs-provider-minted function's `length`/`prototype`/param binding
  (`f() returns undefined` vs null, `p is expected to be 1`). #4624 R4
  named this family (GENERIC Function(src) markers have no prototype
  object). Re-measure under the QUICKJS tier (set
  JS2WASM_QUICKJS_ARTIFACT_DIR); rows that are provider-capability-walled
  get declined with the runtime-eval owner.

## Implementation Plan

1. Brief: plan/method/es5-standalone-agent-brief.md (binding). Re-measure
   all families live on your worktree HEAD; crash rows (A2 null-derefs)
   FIRST.
2. A1 is the representation decision: widen the instance `$proto` slot
   story so a function-valued prototype is holdable — either (a) hold the
   fnctor's callable carrier via an anyref-widened `$proto` + chain-walk
   arm in `__isPrototypeOf`/`__getPrototypeOf`/`in`, or (b) a boxed
   proto-carrier struct. Read `fnctor-instance-prototype.ts`'s residual
   note + #4506's decision matrix FIRST and record your own decision block
   the same way. This is the hard core of the lane — the XL half; timebox
   and record honestly if it needs its own successor issue.
3. A3: make `emitObjectCoercion` identity-preserving for callable args
   (return the SAME carrier, not a fresh externref box) — verify
   `Object(f) === f`, `typeof Object(f) === "function"`, `Object(f)()`.
4. A4: store-then-typeof-then-call for intrinsic values on `$Object`
   receivers; reuse #4624's marker plumbing. §20.2.3.5 render for user
   functions.
5. A5: re-measure under quickjs tier; fix what the compiled lane owns;
   decline provider-walled rows with owner.
6. Verify: scoped sweeps of the four directories before/after (own runs,
   both arms); pins tests/issue-4637.test.ts; neighbour pins
   4506/4623/4624/4619 green; zero regressions.

## Root cause

### A1 — a FUNCTION VALUE cannot sit in a `[[Prototype]]` slot

`$Object.$proto` is `(mut (ref null $Object))` (`object-runtime.ts`), and a
function value is not an `$Object` — it is a closure wrapper struct. So both
proto-position natives (`__object_create`, `__object_setPrototypeOf`) reach
their `ref.test $Object` gate, miss, and store **null**. Measured on this
branch's base with `.tmp/probe.mts` (`--target standalone`, `deferTopLevelInit`,
runs executed for this issue):

| shape                                                                | base |
| -------------------------------------------------------------------- | ---- |
| `function P(){}; P.type="m"; var o=Object.create(P); o.type`            | `undefined` |
| `… Object.getPrototypeOf(o) === P`                                     | false |
| `… P.isPrototypeOf(o)`                                                 | false |
| `function P(){}; function F(){}; F.prototype=P; var m=new F()` — ditto  | all false; `getPrototypeOf(m)` is `null` |
| `F.prototype === P` (the STATIC read)                                  | **true** |

The last row is what makes this a REPAIR rather than a widening: the `.prototype`
slot already holds the function value, and only the instance link disagreed. This
is the residual `fnctor-instance-prototype.ts` names verbatim and the half-bar
#4623 pinned (`it.fails`) on `S13.2.2_A1_T1` / `_T2`.

### A2 — the checker's INSTANCE shape is trusted where §10.2.1.3 step 13 voids it

`fnctor-foreign-return.ts` (#2071) already exists precisely to distrust the
checker's instance type for a constructor whose body can `return` a foreign
value, and `resolveWasmType` already degrades the SLOT to externref off that
predicate. Two consumers were still reading the TS type:

- `staticTypeofForType` folded `typeof i` to the constant `"object"`;
- `isFreshlyConstructedNonCallable` (#4221) classified `new F(…)` as provably
  non-callable, turning a legal call into a hard TypeError.

Measured on the base (`.tmp/p6.js`, standalone):
`function G(a){return a+1}; var F=function(a,b){this.first=a; G.prop=b; return G};
var i=new F("one","two")` gave `i === G` ✓, `i.prop === "two"` ✓,
`i.first === undefined` ✓ — the override LANDS — and `typeof i === "function"` ✗,
`i(1)` ✗ (`__instance is not a function`). That is `S13.2.2_A8_T1` / `_T2`.

### A3 — `Object(f)` identity was already right; the guard was not

`emitObjectCoercion`'s fallback compiles the argument to externref, which
preserves a closure. Measured on the base (`.tmp/p8.js`): `new Object(func) === func`
✓ and `Object(func) === func` ✓. What failed was `typeof new Object(func)` (the
checker types the expression `Object` ⇒ constant `"object"`) and `n_obj()` (the
same #4221 guard). So the issue's framing — "`emitObjectCoercion` compiles the
arg to plain externref and loses the carrier" — is **not** what the rows measure.
The carrier survives; the STATIC TYPE of the expression is the lie.

### A4 — the `prototype` own-property surface disagreed with the value read

The #2660 M3 edge answers `f.prototype` for a function value but nothing answered
`f.hasOwnProperty("prototype")`. Measured on the base (`.tmp/p13.js`):
`function f(){}` gave `typeof f.prototype === "object"` ✓ and
`f.hasOwnProperty("prototype")` **false** — one value, two surfaces, opposite
answers. §20.2.4.2 says the property is OWN.

## Fix

| # | Where | What |
| - | ----- | ---- |
| A1 | **new** `src/codegen/proto-function-value.ts` + 4 call sites in `object-runtime-prototype.ts` | Canonicalize a callable to its #3468 own-property bag `$Object` at the proto-position choke points (`__object_create`, `__object_setPrototypeOf`, `__isPrototypeOf`'s receiver), and map the bag back to the callable on the way OUT of `__getPrototypeOf`. |
| A2 | `typeof-delete.ts::staticTypeofForType`, `expressions/calls-guards.ts::isFreshlyConstructedNonCallable` | Both decline on `typeIsForeignReturnFnctorInstance` / `foreignReturnFunctionNames` — the predicate `resolveWasmType` already uses. |
| A3 | `expressions/calls-guards.ts` — new `objectCoercionMayBeCallable` | `new Object(x)` is provably non-callable only when `x` is. `new Object()` and `new Object(<primitive>)` keep the throw. |
| A4 | `closure-prototype-edge.ts` — new `closurePrototypeEdgeHasOwnArm` + `spliceClosurePrototypeEdgeHasOwn` | The SAME edge, spliced into `__hasOwnProperty` / `__object_hasOwn` for the interned key `"prototype"`. |

### The A1 decision block (recorded the way #4506 records its slot decision)

Two representations were on the table (plan step 2). The full argument lives in
the `proto-function-value.ts` header; the summary:

- **(a) widen `$proto` to `anyref` + teach every walk to skip non-`$Object`
  links — REJECTED.** `$proto` is read by `struct.get $Object 0` across the
  object runtime (`__extern_get`/`_has`/`_set`, the descriptor surface, `in`, the
  proto-index store, the `setPrototypeOf` cycle check, `__isPrototypeOf`), and
  every one of those reads feeds a local typed `(ref null $Object)`. Widening the
  field forces a `ref.test`+`ref.cast` at each site and changes the type of each
  local — a whole-runtime edit whose failure mode is a validation error at best
  and a silently truncated chain at worst. It also buys nothing (b) does not: a
  link to a value nothing can walk THROUGH is not a chain.
- **(b) a proto-VIEW of the function — ADOPTED.** A property-carrying closure
  already has an `$Object` standing in for its own-property table (the #3468
  bag). §10.1.8.1 OrdinaryGet on an instance whose proto is `P` reads **P's own
  properties** — exactly what the bag holds — so the chain becomes walkable with
  no new walk. The entire cost is one bag↔callable identity map.

**The reverse map is not optional.** Canonicalizing alone would make
`Object.getPrototypeOf(o)` answer the BAG: an internal object the program can
never name, i.e. a WRONG answer replacing a merely missing one (`null`). That is
the one trade this campaign forbids, so `__proto_from_function` records
`(bag → function)` in a tiny append-only registry and `__function_from_proto`
maps it back. An `$Object` never used as a proto-view is absent from the registry
and maps to itself, so the common path is one null check on an empty list.

**Scope: CALLABLE carriers only.** The gate is a `ref.test` chain over
`collectClosureBaseWrapperTypeIdxs` — the closure base-wrapper set
`__is_closure`/`__typeof_function` use — deliberately NOT the wider
`__is_closure_prop_carrier` set (which also matches `$__StandaloneRegExp` /
`$__Date` / user instance carriers). Those reach the proto-position natives
through paths this issue did not measure; they keep today's `null`.

**What it does NOT claim.** The bag's own `$proto` stays null, so
`%Object.prototype%` is not reachable *through* a function-valued prototype. That
is one link short of the spec chain (`m → P → %Function.prototype% →
%Object.prototype%`) and is a missing answer, not a wrong one — see the residuals.

## Residuals (with owners)

| family | row(s) | why it is still failing | owner |
| ------ | ------ | ----------------------- | ----- |
| A1 host lane | (no test262 row; pinned `it.fails` in `tests/issue-4623.test.ts`) | The canonicalization is gated on `ctx.standalone \|\| ctx.wasi`. In host mode `env::__extern_*` / `__boundary_object_*` own the prototype chain, so the same fact would have to be stated a second time inside the host runtime. | this issue's successor, or the host-runtime lane |
| A1 chain depth | `S15.3.4.4_A1_T1/_T2`, `S15.3.4.3_A1_T1/_T2` | The proto-view bag's own `$proto` is null, so `%Function.prototype%`'s methods are not reachable *through* a function-valued prototype. Needs `%Function.prototype%` materialized as a real chain object with its §20.2.3 own properties — today `emitFunctionPrototypeObjectSingleton` (`array-object-proto.ts`) builds it with `__object_create(null)` and installs **nothing**. | builtin-object materialization (#4619 family) |
| A3 static type | `S15.2.2.1_A2_T5` (`new Object(<Date>).getFullYear()`) | Identity holds; the checker types the expression `Object`, so the method does not dispatch. Needs `Object(x)`'s static type to follow the argument — a checker/type-mapper change, not a proto-representation one. | type-mapper / `Object` intrinsic signature lane |
| A3 `.constructor` | `S15.2.1.1_A2_T11`, `S15.2.2.1_A2_T7` | `n_obj.constructor === Function` needs the same missing `%Function.prototype%` materialization as the A1-chain-depth row. | builtin-object materialization |
| A3 slot typer | `preventExtensions/15.2.3.10-2` | **NOT a `preventExtensions` bug.** Measured (`.tmp/p11.js`): `Object.preventExtensions(o) === o` is TRUE, and `var b; b = Object.preventExtensions(o)` works. The failing fact is `var a = undefined; a = o; a === o` — the `undefined` initializer types the SLOT, so the later object write is lost. | module-global slot typer (`declarations/heterogeneous-scalar-var-widening.ts` family) |
| A4 own-props | `built-ins/Function/prototype/S15.3.5.2_A1_T1` | The row's subject is `new Function("", null)` — a GENERIC runtime-eval marker. #4624's header already prices and declines a `prototype` for it: answering `true` with no prototype OBJECT to hand back would be two surfaces disagreeing about one value. The A4 arm shipped here covers user functions, which the row does not use. | runtime-eval (#4624 T7 successor) |
| A4 framing | — | The issue's A4 description (`obj.apply = Function.prototype.apply; typeof obj.apply === "function"`, then `obj.apply(...)`) **already works on the base** — measured `.tmp/p13.js`, both `apply` and `call`. The rows filed under A4 are chain-depth rows (above) or eval-tier rows (below), not borrowed-intrinsic-value rows. | — (map correction) |
| A5 | `S15.3.2.1_A1_T10/_A2_T5/_A2_T6/_A3_T3/_A3_T15`, `S15.3.4.3_A5_T8/_A7_T6/_A8_T6`, `S15.3.4.4_A5_T8/_A6_T1/_A6_T2/_A6_T6/_A7_T6`, `S13.2.2_A8_T3` | Re-measured under the QUICKJS tier (`JS2WASM_QUICKJS_ARTIFACT_DIR=…/quickjs-artifact-2e2d7736713beeda`, the verified key for this source): every one is about a `Function(src)`-minted function's `length` / `prototype` / parameter binding / `this` install. Provider-capability walled — the compiled lane owns none of it. | runtime-eval (#4624 R4) |
| A2 `with` | `S13.2.2_A17_T3` | The `RuntimeError: dereferencing a null pointer` is a `with`-statement scoping failure (`var getRight` inside `with(__obj)` clobbers the module binding), not a §13.2.2 construct-return failure. `with` is a deferred feature in the IR budget table. | deferred (`with`) |
| A2 misc | `S13.2.2_A2`, `_A4_T2`, `_A18_T1/_T2`, `_A19_T8`, `13.2-17-1`, `13.2-18-1` | Distinct, unrelated facts (thrown-error identity, `arguments.callee`, named-funcexpr self-reference, `fun.prototype.constructor` attributes). None is the representation question this issue owns. | successor `fix(...)` per row |

## Gap statement — why this is `in-progress`, not `done`

The acceptance bar had five clauses. Four are met and verified from this agent's
own runs; **one is not**, so the issue stays `in-progress` rather than claiming a
completion it does not have.

| clause | verdict |
| ------ | ------- |
| A1 representation decision recorded + measured | **met** — decision block in `proto-function-value.ts` and above, 4 test262 flips, 3 probe-verified shapes, #4623's `it.fails` residual retired |
| A3 `Object(f) === f` identity | **met** — identity already held on the base; the callable/`typeof` half now works, 2 flips, pinned with negative controls |
| scoped sweeps before AND after, zero regressions | **met** — 1,372 rows, both arms run by this agent, +6/−0, and no still-failing row changed its error string |
| neighbour pins 4506/4623/4624/4619 green + new `tests/issue-4637.test.ts` | **met** |
| **A2 crashes gone** | **NOT met** |

The A2 crash the plan named first — `S13.2.2_A17_T3`,
`RuntimeError: dereferencing a null pointer in __module_init()` — was
root-caused, not skipped: it is a **`with`-statement scoping failure**. The
module-level `var getRight = function(){…}` binding reads null at the check on
L38 because a `var getRight` declared *inside* `with(__obj){…}` in an IIFE
clobbers it. `with` is a deferred feature (the IR fallback budget lists it under
`deferred-feature`, wont-fix), and nothing about §13.2.2 construct-return is
involved. Fixing it means implementing `with`-scope var semantics, which is not
this issue and is not a proto-representation change.

The other rows that *look* like crashes in the A2 list resolve the same way on
inspection: `S15.3.4.3_A8_T6`, `S15.3.4.4_A6_T1`, `_A7_T6` and `15.3.4.5-2-8`
are `Function(src)`-minted / `bind` rows, i.e. A5 and the bind lane, not
construct-return.

**Recommendation for the lead:** the branch is complete and mergeable as it
stands — the code, pins and sweeps are self-contained and regression-free. Flip
this issue to `done` on merge and open the successor scope named at the end of
the Results section (**materialize `%Function.prototype%` with its §20.2.3 own
properties**), which is what actually unlocks the remaining `built-ins/Function`
rows now that A1 has made a function-valued prototype a walkable chain. The
`with` row belongs to the deferred bucket, not to a successor of this issue.

## Results

### test262 — scoped standalone sweep, BOTH arms run by this agent

Scope: 1,372 ES≤5 files — `language/statements/function/**` +
`built-ins/Function/**` + the `built-ins/Object` subtrees a proto-representation
change can reach (`S15.2.*` top level, `create/`, `getPrototypeOf/`,
`preventExtensions/`, `isExtensible/`, `keys/`, `freeze/`, `seal/`, `isFrozen/`,
`isSealed/`, `getOwnPropertyNames/`, `prototype/`). Filtered through
`.tmp/es5-files.txt`. `--target standalone` via the real `runTest262File`,
QUICKJS eval tier (`JS2WASM_QUICKJS_ARTIFACT_DIR=…/quickjs-artifact-2e2d7736713beeda`).

| arm | pass | fail | compile_error | artifact |
| --- | ---: | ---: | ------------: | -------- |
| before (branch base `81445abf7`) | 1302 | 69 | 1 | `.tmp/before-final.jsonl`, run 2026-08-23 07:36–08:20 |
| after (`f6d98fd07`)              | **1308** | **63** | 1 | `.tmp/after.jsonl`, run 2026-08-23 08:20–09:1x |

**+6, zero regressions, and zero still-failing rows whose ERROR STRING changed** —
the last is the check that catches a fix trading one failure for another inside
the same row.

The before arm is a genuine base measurement, not an inherited artifact: the
sweep process loaded `src/` at startup, before the first source edit, and the
three anchor rows in `.tmp/before-final.jsonl` carry the exact base errors
(`__PROTO.isPrototypeOf(__monster) must be true`, `__instance is not a function`,
`n_obj is not a function`).

### Flip list

| row | family | was |
| --- | ------ | --- |
| `language/statements/function/S13.2.2_A1_T1.js` | A1 | `#1: __PROTO.isPrototypeOf(__monster) must be true` |
| `language/statements/function/S13.2.2_A1_T2.js` | A1 | same, `var`-spelled ctor |
| `language/statements/function/S13.2.2_A8_T1.js` | A2 | `TypeError: __instance is not a function` |
| `language/statements/function/S13.2.2_A8_T2.js` | A2 | same |
| `built-ins/Object/S15.2.2.1_A2_T2.js` | A3 | `TypeError: n_obj is not a function` |
| `built-ins/Object/S15.2.2.1_A2_T6.js` | A3 | same |

### Probe-verified, no test262 row of its own

- `Object.create(<function>)`: inherited read, `getPrototypeOf` identity and
  `isPrototypeOf` all flip false→true (`.tmp/p2.js`).
- `instanceof` through a function-valued prototype (`S15.3.5.3_A3_T2`'s shape)
  flips false→true (`.tmp/p1.js`, base `8` → after `31`). **Shape-dependent, and
  the scope matters:** the bare `F.prototype = P; new F() instanceof F` spelling
  already answers `true` on the base — `instanceof` here goes through the escape
  gate's classification, so the flip is a property of `.tmp/p1.js`'s shape, not
  of the construct in general. See cross-lane note 3.
- `typeof (new F())` where F returns a function: `"object"` → `"function"`
  (`.tmp/p6.js`).
- `f.hasOwnProperty("prototype")` **and** `Object.hasOwn(f, "prototype")` for a
  user function: false → true — measured both arms, `.tmp/p19.js`, base `188` vs
  after `191` (the delta is exactly those two bits; every other bit in the probe
  is identical). The test262 row for this (`S15.3.5.2_A1_T1`) uses
  `new Function("", null)` and stays a residual.

  **PRECONDITION, and it is narrower than the sentence above reads on its own
  (corrected 2026-08-23 after a cross-check prompted by dev-4639).** The A4 arm
  is emitted only when `hasClosurePrototypeEdges(ctx)` is true, i.e. when the
  module actually REACHES `f.prototype` — a `.prototype` read or a `new f()`
  somewhere in the file — because that is what populates
  `ctx.fnctorPrototypeObject` and lets `collectPrototypeEdges` pair a prototype
  global with the function's value singleton. Measured: `.tmp/p18.js` (same
  program, `f` read as a value but **no** `.prototype` read anywhere) gives
  `188` on BOTH arms — the arm is absent entirely, and `f.hasOwnProperty(
  "prototype")` stays false. The earlier `.tmp/p13.js` A/B (27 → 31) happened to
  satisfy the precondition via its `typeof f.prototype` line, so reporting it as
  an unconditional "for a user function" overstated the scope. This is the #2660
  M3 edge's own documented limitation ("a function with a prototype global but no
  singleton VALUE global was never read as a value, so no runtime consumer can
  hold it"), inherited rather than introduced — but it belongs in the claim, not
  only in the module it comes from.

### Pins

- **New** `tests/issue-4637.test.ts` — 16 tests: 12 pinning the fixed families
  (including four NEGATIVE controls: an ordinary-object prototype is untouched,
  a function is not reported as the prototype of an unrelated object,
  `new Plain()()` still throws, `new Object(42)()` / `new Object()()` still
  throw) and 4 `it.fails` pinning the measured residuals. All 16 green. No case
  mints from a body string, so no eval-tier arm is needed.
- **`tests/issue-4623.test.ts`** — its standalone `it.fails` residual
  ("standalone: P.isPrototypeOf(new F()) is true when F.prototype = P", added by
  #4623 with the note *"pinned failing so the day the representation lands, this
  test says so"*) now PASSES and has been flipped to an ordinary `it`. The JS-host
  twin stays `it.fails`, with the lane-gating reason recorded inline.
- Neighbour pins green (own runs): `tests/issue-4506.test.ts` +
  `tests/issue-4619.test.ts` 45/45; `tests/issue-4623.test.ts` 14/14 after the
  flip; `tests/issue-4624.test.ts` 15/15 (QUICKJS tier).

### Gates (own runs)

`check:loc-budget` OK (four grants above), `check:func-budget` OK (four grants),
`check:oracle-ratchet` OK (`getTypeAtLocation +0, ctx.checker +0` across 14
changed codegen files), `check:coercion-sites` OK, `check:stack-balance` OK (no
fixup-bucket increases), `check:dead-exports` OK, prettier + biome lint clean.

### What this issue did NOT deliver, plainly

The issue's headline was "~48 rows". Six flipped. The gap is not effort
mis-spent — it is that **the row-to-family map in the Problem section does not
survive re-measurement**:

- A4's stated surface (borrowed intrinsic values on a plain object:
  `obj.apply = Function.prototype.apply; typeof obj.apply`) **already works on
  the base** — measured, both `apply` and `call`. The rows filed under A4 are
  really A1-chain-depth rows (`FACTORY.prototype = Function.prototype`) or A5
  eval-tier rows.
- A3's stated cause ("`emitObjectCoercion` compiles the arg to plain externref,
  losing the carrier") is **not** what fails: the carrier survives and
  `Object(f) === f` already held. The static TYPE of the expression was the lie.
- A5's 14 rows are provider-capability walled, as the plan anticipated.
- The single largest remaining blocker behind the A1-chain-depth and
  `.constructor` rows is one concrete, nameable thing: **`%Function.prototype%`
  is materialized as an EMPTY `$Object`** (`emitFunctionPrototypeObjectSingleton`
  builds it with `__object_create(null)` and installs no §20.2.3 own property).
  That is the successor scope, and it is now unblocked — with A1 landed, a
  function-valued prototype is a walkable chain, so the moment
  `%Function.prototype%` carries `call`/`apply`/`bind`/`toString`, the
  `S15.3.4.3_A1_*` / `S15.3.4.4_A1_*` / `S15.2.x .constructor` rows resolve
  through the SAME walk with no new mechanism.

### Equivalence (per-file loop — a single vitest invocation OOMs in this container)

23 files scoped to what this diff can reach (the `object-*`, `typeof-*`, `new-*`,
call-dispatch and prototype-chain suites) — all green except one, which is a
**pre-existing environment failure, A/B-confirmed**:

`tests/equivalence/new-non-constructor.test.ts` fails 2/3 identically on the
branch base and on this commit. It hard-codes
`/workspace/test262/test/built-ins/Math/ceil/not-a-constructor.js`, and an agent
worktree is not at `/workspace`, so the read is ENOENT and the follow-on case
gets an empty binary. Measured both arms with a `git checkout <base> -- src/codegen`
revert: `2 failed | 1 passed` before and after.

Green: `object-create`, `object-mutability`, `object-keys`,
`object-define-property`, `object-define-property-return`, `object-to-primitive`,
`issue-799-prototype-chain`, `issue-4123-param-receiver-proto-method`,
`hasownproperty-call`, `typeof-comparison`, `typeof-extended`,
`typeof-member-expression`, `typeof-narrowing`, `symbol-typeof`,
`new-expression-spread`, `wrapper-constructors`, `fn-variable-call`,
`arrow-call-apply`, `iife-and-call-expressions` (70), `empty-object-widening`,
`function-name-length`, `arguments-object`.

## Handed to another lane

dev-4639 (#4639) reported, and this agent reproduced under the QUICKJS tier
(`.tmp/p15.js` / `.tmp/p16.js`): a `Function()`-minted function with an EMPTY
body returns JS **`null`**, not `undefined`.

    function h() {}
    var g0 = Function();                    String(g0())  →  "null"      (want "undefined")
    var g1 = Function("return undefined;");  String(g1())  →  "undefined" ✓
    var g2 = Function("return null;");       String(g2())  →  "null"      ✓
    var g3 = Function("var x = 1;");         String(g3())  →  "null"      (want "undefined")

The discriminator matters: the **explicit** `return undefined;` decodes
correctly, so `buildRuntimeEvalValueUnwrap`'s
`RUNTIME_EVAL_VALUE_KIND_UNDEFINED` arm (`src/codegen/runtime-eval-boundary.ts`,
which already prefers the `undefinedSingleton` global over `ref.null.extern`) is
**not** the defect. The two failing shapes are exactly the ones with an IMPLICIT
completion value, so the envelope's value slot for an implicit return is either
not a `$RuntimeEvalValue` carrier at all — in which case
`buildRuntimeEvalValueUnwrap`'s `ref.test`-fails else-arm passes the raw
`ref.null.extern` straight through, and that is JS `null` — or it is a carrier
tagged `KIND_NULL`. That is a provider-side / envelope-encoding question, in the
runtime-eval lane, not in this issue's proto-representation scope, and changing
the decode blind would alter every interpreted return's value model without a
sweep to cover it. **Declined here; owner: runtime-eval (#4624 family).** It is
the cause of `built-ins/String/prototype/replace/S15.5.4.11_A1_T5`.

## Cross-lane contact points (for whoever merges second)

Raised with dev-4639 (#4639) while both branches were open. Recorded here because
one of them is a surface **neither** lane had on its list.

### 1. `__object_hasOwn` — a real contact point, measured clean

dev-4639's C2 arm (`src/codegen/builtin-static-expando.ts`) calls
`__object_hasOwn(carrier, key)` on a builtin CONSTRUCTOR carrier, and concluded
there was no intersection with this issue on the grounds that #4637 touches
`__object_create` / `__object_setPrototypeOf` / `__isPrototypeOf` /
`__getPrototypeOf`. **The conclusion is right; the premise is not.** The A4 arm
(`spliceClosurePrototypeEdgeHasOwn`) splices into **`__hasOwnProperty` AND
`__object_hasOwn`** — so C2's helper is one this issue does modify.

Why it is safe, measured rather than argued (`.tmp/p17.js` / `.tmp/p18.js`,
both arms, base vs `f6d98fd07`, identical `60` and `188`): the spliced arm fires
only when the key is the interned literal `"prototype"` **and**
`__closure_proto_of(recv)` is non-null — an `ref.eq` identity match against the
`__fn_closure_<name>` / `__class_<Name>` singletons. A builtin constructor
carrier is not one of those, so the arm declines and C2's answer is byte-for-byte
unchanged. `Array` / `String` / `Object` `.hasOwnProperty("prototype")` and
`Object.hasOwn(<same>, "prototype")` are identical on both arms, as is the
negative control `Array.hasOwnProperty("zzz")`.

**The two arms MEET on the key — only the receiver test separates them.**
dev-4639 measured this after the exchange above and it is stronger than either
lane's first reading: `propName === "prototype"` really does reach the C2 arm
(the `emitLazyNativeProtoGet` fast path above it falls through for any builtin
with no registerable proto brand), so C2 emits
`__object_hasOwn(carrier, "prototype")` — **the exact interned literal this arm
keys on**. The key match is not hypothetical and is not future work; it happens
today. What keeps the arms apart is the receiver predicate alone.

dev-4639 also replaced their original (false) premise with a structural one.
**Keep BOTH, and their reason is the right one: the two fail differently.** The
A/B catches a wrong READING of the code; the construction argument catches a
DRIFTING carrier set. Neither alone would have caught both — and the construction
argument is only as good as the reading behind it, which is exactly the failure
mode that produced the false premise it replaced. The structural argument: the
only receiver C2 ever passes to `__object_hasOwn` is `carrierLocal`,
set from `emitBuiltinProtoConstructorValue` — always a `__new_plain_object`
`$Object` (`__builtin_ctor_<Name>` / `__builtin_<Name>`); the `$NativeProto` from
`pushBuiltinIntrinsicPrototype` reaches `__extern_get` only. A carrier is neither
a `__fn_closure_*` nor a `__class_*` singleton and cannot become one, so
`__closure_proto_of` is null by construction. The A/B above then confirms the
construction rather than being the only evidence for it.

**The tripwire, therefore, is exact and singular:** if any C2-shaped read ever
asks `__object_hasOwn(recv, "prototype")` where `recv` IS an edge-bearing closure
or class-object singleton, this arm answers `1` **first**, before C2's own logic.
That is the spec answer (§20.2.4.2), but it is this issue's answer, not C2's. It
is written on both sides (`plan/issues/4639-string-regexp-ctor-proto-surface.md`
carries the twin).

### 2. `classifyUse` widening (dev-4639 C1) — re-measure after both land

dev-4639 widened `classifyUse` in `src/codegen/fnctor-escape-gate.ts` so a
`NewExpression` ARGUMENT classifies `dynamic` (standalone only). That changes
which `new F()` sites become open `$Object`s — and this issue's A1 arm fires
exactly at `__object_create`, i.e. only at sites that already reconstruct. So the
two read the same representation choice from opposite ends.

The interaction is expected to be **additive** (more sites reconstructing ⇒ more
instances whose function-valued prototype now links), not contradictory — but
that is a prediction, not a measurement, and neither lane measured the combined
tree. Whoever merges second should run, at minimum: this issue's
`tests/issue-4637.test.ts` + the six flipped rows in the list above, and
dev-4639's `tests/issue-4639.test.ts` (12 pins, ~95 s) + their five flipped rows.
Do not carry either lane's before/after numbers across the merge.

**Both pin files had the SAME structural gap, in mirror image — fixed on both
sides.** dev-4639 found theirs first: `tests/issue-4639.test.ts` covers the
direction where this issue's work can break theirs, and structurally cannot cover
the reverse, because nothing in it constructs a callable in a `[[Prototype]]`
slot. Checking for the mirror found the same hole here: **every A1 pin in
`tests/issue-4637.test.ts` built a ZERO-ARG `new F()`**, so none of them
exercised the classification C1 widens (a `NewExpression` ARGUMENT). A merger
running either suite alone would have seen green on a two-directional
interaction.

First attempt: a case putting the instance in `new H(g)` argument position with
a function-valued prototype, verified not incidentally green (`.tmp/p20.js`,
base `33` → after `63`). **That case was mislabelled and has been renamed.** It
is a real test of the A1 arm; it is NOT a C1 canary, and that was measurable
without dev-4639's branch: delete the `var h = new H(g);` line and the answer is
still `63` (`.tmp/p21.js`). The NewExpression-ARGUMENT position is not what
drives the reconstruction there — the other dynamic uses (`isPrototypeOf`,
`getPrototypeOf`, the property read) already classify the instance as dynamic
without C1's widening. **A pin whose named interaction can be deleted without
changing its answer is not a canary for it.**

This is the same blindness dev-4639 found in their own C2 canary, one round
after both lanes articulated the rule — which sharpens the rule itself:
**reverting shows a pin is sensitive to YOUR change and says nothing about
whether it is sensitive to THEIRS.** A cross-lane canary needs its own
sensitivity check, and the cheap form is: delete the interaction the pin is
named for and see whether the answer moves.

The shape where C1's lever actually acts is the ARGUMENT-ONLY one — `new G()`
appears solely as a `new` argument, every read goes through `h.wrapped`, so no
other dynamic use can classify the instance. Measured `.tmp/p22.js`, **both arms
`2`**: only `instanceof` holds, the A1 arm does not fire, because the site never
reconstructs. Pinned as `CROSS-LANE PREDICTION (dev-4639 C1 x A1)`, `it.fails`, and now
**decomposed into two separately observable halves** — dev-4639's measurement of
`G.prototype === P` on their branch confirms the FIRST half and only the first:

| bits | assertion | who has to fire | observed |
| ---- | --------- | --------------- | -------- |
| 1 | `G.prototype === P` | C1 alone | **confirmed by dev-4639** on `issue-4639` |
| 2 | `instanceof` | neither — already true | true on both arms here |
| 4 \| 8 \| 16 | `isPrototypeOf`, inherited read, `getPrototypeOf` | the A1 arm, at the site C1 newly classifies | **unobserved** |

So the sharpened prediction: **C1 alone takes this shape from `2` to `3`;
C1 + A1 composed takes it to `31`.** If both land and the pin sits at `3` rather
than `31`, the site got classified but the A1 arm did not link its
function-valued prototype — the halves did not compose, and that is the finding.

**The anomaly in that shape, isolated — and it is PRE-EXISTING.**
`G.prototype === P` reads false there, unlike every other A1 case. dev-4639 ran
a RECONSTRUCTED version of the shape on `issue-4639`, saw it read `true`, and
inferred it was *introduced by this branch* — a regression claim, and the wrong
conclusion for a merger to inherit. Their own caveat is what made it resolvable:
the reconstruction was written from a prose description, not from `.tmp/p22.js`.

Measured directly instead (`.tmp/p23.js`, three shapes in one module, both arms):
**base `11` = after `11`.**

| shape | `G.prototype === P` | both arms |
| ----- | ------------------- | --------- |
| bare, `function P(){}` | true | identical |
| bare, `var P = function(){}` | true | identical |
| arg-only instantiation (the p22 shape) | **false** | identical |

So it is a property of the ARG-ONLY instantiation shape — not of function-valued
prototypes, not of declaration-vs-expression, and **not introduced by this
branch**.

**And there is a THIRD state neither lane's arm-pair could represent.** dev-4639
then measured (their run, not this agent's): the reading is false on the campaign
tip and **true on `issue-4639`**, returning to false with **only**
`fnctor-escape-gate.ts` reverted. So it is *pre-existing on the tip AND fixed by
C1*.

Both measurements were correct and both conclusions were wrong, for one shared
reason: **a tip-vs-own-branch A/B cannot express "pre-existing, and fixed by the
other lane."** This lane's arms were tip-vs-here → identical → "unaffected";
theirs was their-branch-only → true → "introduced by yours". Neither pair
contained the other lane's change. That is a **campaign-level methodology gap**,
not a mistake either lane made: with sibling lanes branching from one tip, a
two-arm A/B answers "did I change this" and is structurally silent on "did
someone else fix it". Where a cross-lane interaction is in play, the third arm —
the sibling's branch — has to be measured by whoever owns it, and cited as
theirs.

> **PREDICTION ANSWERED (lead, 2026-08-23, at merge):** on the combined
> campaign tree — BOTH lanes merged (#4639's C1 widening + this branch's A1
> arm) — the answer is PER-SPELLING, measured by lead probe on the
> combined tree (`.tmp/probe-anomaly2.mts`):
>
> | spelling | `G.prototype===P` | `P.isPrototypeOf(h.wrapped)` |
> | --- | --- | --- |
> | `var g = new G(); var h = new H(g);` | true | **true — COMPOSED** |
> | `var h = new H(new G());` (the pin's shape) | true | **false — did not compose** |
>
> So C1×A1 **did** compose for the variable-then-argument spelling (on
> dev-4637's branch alone that shape answered only `instanceof`), and the
> residual gap is precisely the INLINE `new G()` argument — plausibly
> because an inline argument has no binding slot for #4506's G4
> externref-slot half of the gate to widen. The `it.fails` prediction pin
> (inline shape) correctly stays red. The `G.prototype === P` false
> anomaly did not reproduce in either spelling of the lead's probe
> module; dev-4637's p23 measured it false in its fuller module (with
> `P.type` seeding) on both arms — shape-sensitive, provenance settled
> as pre-existing, mechanism still open. Successor scope: the inline-arg
> reconstruction gap; the pin flips the day it lands.

### 3. Every pin re-verified against the base — two were mislabelled

dev-4639's operational rule, adopted: **a canary nobody has seen fail is an
assertion about the code, not a test of it.** The `.tmp/p20.js` A/B above proved
the SHAPE was affected; it did not prove the PIN AS WRITTEN fails. So the whole
suite was run against `81445abf7` with `tests/` held at the branch version. Two
pins were the wrong thing:

- **`carries instanceof through a function-valued prototype` PASSED on base.**
  It used the bare `function P(){} function F(){} F.prototype = P;
  new F() instanceof F` spelling, which already answered `true` before this
  change — so a case presented as demonstrating the fix asserted only
  pre-existing behaviour. `instanceof` here is escape-gate-SHAPE-dependent
  (`.tmp/p1.js`'s fuller shape measures base `8` → after `31`, with `instanceof`
  among the flipping bits, while the bare shape is green both ways). The pin now
  uses the measured-flipping shape, and the bare one is kept beside it,
  explicitly labelled `REGRESSION GUARD (green on base)` — it still earns its
  place, because an arm that changes what sits in the `$proto` slot could
  quietly break an `instanceof` that already worked.
- **`does not report a function as the prototype of an unrelated object` FAILED
  on base** — because it bundled the negative assertion with a positive one
  (`P.isPrototypeOf(o)`). A build answering `true` for BOTH receivers would have
  produced the wrong total for the right-looking reason, so the
  no-false-positive property was never independently exercised. Split: it now
  asserts only the false-positive direction and is green on both arms; the
  positive half is already covered by the `Object.create(<function>)` case.

**Resulting partition, measured (base `81445abf7`, tests at branch version):
8 fail / 11 pass.** Every one of the 8 failures is a test OF the change; every
one of the 11 passes is an explicitly-labelled regression guard (1), a pure
negative control (5), an `it.fails` residual (4), or the `it.fails` cross-lane
prediction above (1, red on both arms by design). On the branch: 19/19.

### 4. A green exit code is not a green run (dev-4639's live hazard)

dev-4639 hit this and it is worth a line here even though it does not bite this
file: their suite uses `describe.skipIf(!TEST262)` keyed on
`test262/harness/assert.js` existing, and after restoring the `test262` gitlink
the directory is empty until the symlink-farm rebuilder repopulates it — so the
run reported **`14 skipped`, exit 0**. A merge check that shells out and trusts
the exit code sees green with ZERO coverage, and it composes badly with the
gitlink flip both lanes hit.

**Checked here rather than assumed: `tests/issue-4637.test.ts` and
`tests/issue-4623.test.ts` carry no such gate.** Neither calls
`runTest262File`; both compile in-process (`compile()` + `WebAssembly.instantiate`
/ `instantiateWasm`), so there is no test262 path to be absent and nothing that
can skip silently. The general rule still applies to whoever runs the merge
check: **confirm the run says N passed — never that it exited 0.**

**Named canaries** (dev-4639's mapping — one pin per contact point, so a
failure identifies WHICH interaction broke rather than only that something did):

| canary | watches |
| ------ | ------- |
| dev-4639's C2 group — `String.indicator`, `RegExp.indicator`, `Math.NaN` | this issue's spliced `__object_hasOwn` prologue |
| `built-ins/String/S15.5.2.1_A1_T10` | the C1 escape-gate × A1 reconstruction interaction |
| this issue's `tests/issue-4637.test.ts` A1 group | a callable in a `[[Prototype]]` slot surviving C1's widened classification |

Two further flips fell out of dev-4639's key check and are recorded here only so
they are not mistaken for this issue's: `Math.prototype` and `Proxy.prototype`
go `compile_error → undefined` (spec: `undefined`; neither is a constructor).
They are theirs, outside their 37-row list, and do not move either lane's
headline.
