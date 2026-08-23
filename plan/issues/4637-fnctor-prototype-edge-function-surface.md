---
id: 4637
title: "ES5 standalone: fnctor-prototype edge + Function-constructor surface — S13.2.2 family, Object(func) identity, apply/call as own-property values (~48 rows)"
status: ready
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
