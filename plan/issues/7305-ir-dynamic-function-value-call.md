---
id: 7305
title: "IR: a statement call through a top-level subject's dynamic parameter (function value in a dynamic slot)"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7287, 7277, 7286, 7272, 7283, 7294, 7298, 7106, 2949, 7127]
assignee: "ttraenkler/c-lane-opus"
loc-budget-allow:
  # 2026-11-07 (#7305): select.ts +29 net. `ownParameterStatementCall` (the
  # structural half both the selector and the call graph read), the widened
  # `dynamicValueCallTarget` membership with its doc, the one move-only sink,
  # and the shared `scanCarrierArguments` (which replaces S3a's inline loop).
  # from-ast.ts +5: the closure-argument box at the direct-call boundary.
  # Restated here because the #7287 grants this branch stacks on are
  # stranded once #7287 merges.
  - src/ir/select.ts
  - src/ir/from-ast.ts
func-budget-allow:
  # 2026-11-07 (#7305): dynamicUsesAreMoveOnly +4. It gains one sink (the
  # callee and arguments of a statement call through a dynamic value), and
  # the argument loop is now shared with S3a's `new g()` arm. The scan's arms
  # are closures over its state (`dynNames`, `isDynShaped`, `scanExpr`), so
  # this sink cannot move out without the scan refactor #2949 tracks.
  - src/ir/select.ts::dynamicUsesAreMoveOnly
---

# #7305: function values in dynamic slots, and calling them

Design and measurement only. Code waits for the #2949/#7127 contract answer
(#6583, comment 6700838780, deadline 04:00Z). If that answer comes, it binds
§4.

## 1. How legacy represents and calls a dynamic function value (standalone)

All paths are under `src/`.

- **Representation.** A closure is a WasmGC struct
  `{ funcref, $arity i32, $bag externref, captures… }`
  (`runtime/wasmgc/values/closure-layouts.ts:25-34, 70-76`; lifted signature
  `(ref $wrapperRoot, …params) → ret`, 47-50). It is boxed into the dynamic
  carrier with `extern.convert_any` (`codegen/expressions/calls.ts:4302`). It
  is recovered with `any.convert_extern` + `ref.test`/`ref.cast` over the
  base wrappers (`calls.ts:4789-4797`, `closure-classifier.ts:40-85`), then
  `call_ref` on field 0.
- **The generic call.** `__apply_closure(fn, recv, args) → externref`
  (`codegen/object-runtime.ts:6338-6370`, body `fillApplyClosure` 6439-6747):
  - Arguments travel as one `$ObjVec` / externref vector. The call dispatches
    on argument count 0..8, plus an n > 8 arm, to `__call_fn_method_N`
    (`closure-exports.ts:1249-1754`).
  - `__call_fn_method_N` saves and installs `__current_this`
    (`closures/method-dispatch-prologue.ts:24-45`), calls, boxes the result
    and restores `__current_this` (1677-1680).
  - **Arity.** The raw count goes to `__argc` (`object-runtime.ts:6706`).
    Missing formals become undefined (`buildApplyClosureArityWidening`,
    `closure-exports.ts:1970`). Extra arguments go to `__extras_argv`, which
    feeds `arguments` (1364-1372, 1466-1481). An arity above the top
    dispatcher traps (`object-runtime.ts:6718-6741`).
  - **Not callable.** The call site guards with `__is_callable` and throws
    TypeError `called value is not a function` (`calls.ts:4566-4575`).
  - **Throws** unwind on the `__exn` tag. There is no try/catch in the
    bridge, so `__current_this` is **not restored** when the callee throws.
- **`typeof`.** `__typeof_function` does `ref.test` over the closure,
  bound-function and builtin carriers (`typeof-natives-finalize.ts:63-100,
  302-323`). `__is_callable` excludes class values (325-330).
- **`===`.** `__extern_strict_eq` compares with `ref.eq` on eqrefs
  (`any-helpers.ts:840-858`).
- **`.length` / `.name`.** Read through `dyn-read.ts:327-379`
  (`__builtinfn_get_meta`, then the bag, then `$arity`;
  `function-instance-props.ts`, `function-instance-meta.ts`).
- **`new v()`.** Goes through `__native_construct_<N>` and throws
  `value is not a constructor` (`native-construct.ts:188, 487`;
  `construct-is-constructor-guard.ts`). `Reflect.construct` is in
  `reflect-construct-native.ts:208-279`.
- **Bound and builtin values.**
  - `.bind` creates a `$__bound_fn {target, thisArg, boundArgs, $bag}`
    (`registry/types.ts:668-701`). `__apply_closure` unwraps it
    (`object-runtime.ts:7050-7129`).
  - Lib functions stored in a variable (`Array.isArray`,
    `Object.defineProperty`) are `$__builtinfn_<n>` subtypes of the closure
    wrapper (`builtin-fn-meta.ts:1-56`).
  - So one `__apply_closure` call covers closures, bound functions and lib
    builtins.
- **`this` on a plain call.** The receiver is undefined
  (`calls.ts:4304`), so `__current_this` stays null
  (`helpers/undefined-receiver.ts`). The callee then reads the global object
  in sloppy mode and undefined in strict mode, per its own source
  (`helpers/sloppy-this-global.ts:68-83`).

## 2. What the IR already lowers

- **from-ast.** `lowerDynamicValueCall` → `applyDynamicCallee`
  (`src/ir/function-object-lowering.ts:157-…`). It evaluates the callee,
  then each argument through `IR_DYN_CALL_ARGUMENT_FN` into `__objvec_new` /
  `__objvec_push`, then checks `__is_callable` and throws the same
  `called value is not a function` TypeError. It calls `__apply_closure`
  with an undefined receiver. That is legacy's bare-call order, message and
  ABI, so the lowering already exists.
- **Selector: who may take it.** `dynamicValueCallTarget`
  (`src/ir/select.ts` ~L6669) admits only a callee in
  `currentClosureDynamicParamNames` / `currentClosureFunctionObjectReadLocals`.
  Those are non-empty **only inside a planned member closure**
  (`assert.throws`' `func()`, `compareArray`'s `format(actual)`). Every
  top-level subject refuses a call through a local at Phase-1:
  `expr-local-call-target`, select.ts ~L12496. Measured on standalone: a
  parameter `g(x)`, `return g(x)`, and `var` / `const` aliases of a
  parameter, member or logical pick all refuse there.
- **#7287** (R9, branch `issue-7287-ir-script-var-closure-call` @ dfd8c404)
  adds:
  - one resolver rule: a script's single `var` that shadows a lib-only name
    (`print`) binds to that `var`;
  - one arm on each side: a **statement-position** call whose callee is a
    script `var` in its dynamic module home takes the same
    `lowerDynamicValueCall`.

  Value-position calls stay refused and pinned by a test: a lib-named `var`'s
  call result is typed by the lib signature.

## 3. The smallest general extension, and what it unblocks

**Extension.** Let a top-level function declaration take `dynamicValueCallTarget` when
the callee is one of its own dynamic **parameters** (`currentDynamicParamNames`,
the membership S3a's `new g()` already uses), in statement position in its own
body, and it has no ambient `this`. `var`/`const` aliases of a dynamic value are
deferred: whether a local is dynamic is only known once the move-only scan has
run (`dynNames` grows there), after the Phase-1 call check. Class members are
out of scope. The lowering and runtime are unchanged. Value position stays
refused, as in #7287. The receiver is undefined.

**Consumers**, measured with a throwaway admission that bypassed (a) the
top-level-function-as-value scope check, (b) `expr-logical-value-family` and
(c) `expr-local-call-target`, in situ on a 6-file propertyHelper sample:

| consumer | today's first refusal | after the extension (+ pick) | still blocking | yield now |
| --- | --- | --- | --- | ---: |
| `verifyCallableProperty` (130 units) | `expr-logical-value-family` on `options && options.verifyProperty \|\| verifyProperty` | passes the pick and the `propertyVerifier(…)` call | `condition-module-value-nonbool` `!__hasOwnProperty(desc,"value") && …`, then callee `verifyProperty` legacy (`vardecl-module-binding-alias` `__getOwnPropertyDescriptor`) → closure | 0 |
| `$DONE` ← `__consolePrintHandle__` (139 files) | callee `msg` slot | not this extension: the `print` call is #7287's script-var arm | #7277 (`msg`), #7286 (`string + dynamic`), the call-graph closure | 0 |
| `isConstructor` (12 files ≤1) | `Reflect` not in scope | not a call: `Reflect.construct(function(){}, [], f)` is [[Construct]] with a newTarget | needs `Reflect.construct` lowering (`reflect-construct-native.ts`), out of scope | 0 |
| propertyHelper `<module-init>` (`__isArray = Array.isArray`, `call.bind(…)`) | `vardecl-module-binding-alias` / storage | not a call: builtin and bound function *values* in module storage | #7294 (builtin values), #7272/#7283 | 0 |

The pick also needs a top-level function used as a value (`verifyProperty`
in `… || verifyProperty`). The scope check refuses it today
(`expr-ident-not-in-scope`). The function-object value plan
(`topLevelFunctionValues`, #7106 S3c) is the existing producer.

**Other stride units refused at the call gate:** 1 (`Constructor`'s
`executor`). The other `expr-logical-value-family` units
(`testWith*TypedArrayConstructors` ×150) pick an array, not a function.

**Expected zero-legacy / ≤1-unit delta on the stride: 0** for every
consumer today. The extension is an enabler: `verifyCallableProperty` moves
only once the propertyHelper alias condition and `verifyProperty` are IR.

## 4. Contract: one predicate, not a sibling

The rule to add:

> A dynamic value may flow into the callee position of a statement-position
> call when that call lowers through `__apply_closure`.

That rule is *already* `dynamicValueCallTarget`. The extension should widen
**that one predicate's membership test** from "a planned closure's dynamic
parameter or read local" to "…or a top-level function declaration's own
dynamic parameter" (§3). It should not add a sibling predicate or a second arm.

`dynamicUsesAreMoveOnly` then needs one sink line: "the callee of a bare
statement call when `dynamicValueCallTarget` holds". It reads the same
predicate, so the selector's shape check and the move-only scan cannot
disagree, and from-ast already dispatches on that shape.

Writing the rule only as a contract sentence inside `dynamicUsesAreMoveOnly`
would duplicate the shape test that `isPhase1Expr` must also pass. That is
the two-predicate drift the IR quality rule forbids.

## 5. Yield

Section 3: **0 units / 0 files ≤1 now.** It is bounded by census, because
every consumer has an independent blocker owned elsewhere. The probe
admission confirmed it for `verifyCallableProperty`.

## 6. Risks to pin before any code

- **`this` after a throw.** `__apply_closure` does not restore
  `__current_this` when the callee throws. A top-level subject *can* read
  `this` (sloppy global). Refuse the arm when the subject reads `this`
  anywhere, or prove it reads `this` only before the call. A planned
  closure never reads `this`, which is why Stage 4 could skip this.
- **Identity.** `===` / `!==` on the picked value must stay
  `__extern_strict_eq` (`ref.eq`). The pick must move the carrier, never
  re-box a function value: a re-box would break `propertyVerifier ===
  verifyProperty`.
- **`typeof`, `.length`, `.name`.** These are value reads and already routed
  through the dynamic carrier (`__typeof_function`, `dyn-read.ts`). The
  extension adds no new read.
- **`new f()` / `Reflect.construct`.** Refuse: [[Construct]] is a different
  ABI (`__native_construct_<N>`, newTarget).
- **`arguments`.** Arity widening and `__extras_argv` live in the callee
  (`__call_fn_method_N`), so the caller is unaffected. A *subject* that
  reads its own `arguments` keeps today's arms.
- **Value-position calls.** Keep them refused, as #7287 does. The checker
  types a lib-named callee's result by the lib signature, and the same
  hazard applies to any `var` whose checker type comes from a declaration.

## Coordination

R9 (#7287) agreed on 2026-11-07: this lane implements once #7287 lands. R9
will not claim it. Constraints carried over from #7287:

- Statement position only is load-bearing. #7287's first cut also admitted
  value-position calls, and #7253's equivalence cases caught the call result
  coerced to the checker's signature for the callee
  (`var isNaN = function () { return "U"; }` then `return isNaN(1)` read as
  `true`). Any local whose checker type is wrong or `any` has the same hazard.
  Measure it before admitting a value position.
- The new arm goes after the propertyHelper alias arms in both `lowerCall`
  and `buildLocalCallGraph`, in the selector's order (#7287's review
  must-fix).

The widening in §4 touches the same predicate family but not R9's
module-binding arm.

## Adversarial review (fresh context, 2026-11-07)

Verdict: no blockers, sound in every compiled probe (`irPostClaimErrors`
empty, standalone and gc pass).

| # | finding | resolution |
| --- | --- | --- |
| 1 (should-fix) | the arm also claimed class instance / static methods (`currentDynamicParamNames` holds their parameters); sound, but undocumented and untested | owner restricted to a `FunctionDeclaration`; methods pinned as refused, `new u(f)` pinned as claimed |
| 2 (should-fix) | §3/§4 promised `var`/`const` aliases; the code admits parameters only | §3/§4 now say parameters only, and why aliases are deferred |
| 3 (nit) | `decls.has(callee)` runs before the structural check, so a parameter shadowing a top-level function still adds a graph edge | kept: moving the check ahead of `decls.has` would also put it ahead of the propertyHelper alias arms (#7287's ordering rule), and the extra edge only makes the unit more conservative |
| 4 (nit) | the closure-or-primitive box choice appears at two from-ast boundaries | kept: two users; folding it is a follow-up if a third appears |
| 5 (nit) | the catch-binding paragraph read as covering the new arm | now says it describes the closure arm |

