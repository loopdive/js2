---
id: 1528
title: "spec gap: non-constructor TypeError — Promise.all / allSettled species and executor paths"
status: in-progress
created: 2026-05-20
updated: 2026-06-22
assignee: ttraenkler/senior-developer
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: promise, species, constructor-invariants
sprint: 65
es_edition: ES2015+
test262_category: built-ins/Promise, language/function-code
test262_count: 79
related: [1519]
---
# #1528 — `[object Object] is not a constructor` instead of spec TypeError

## Problem

79 test262 tests fail with:

```
[object Object] is not a constructor
```

The error wording is our runtime's host string, not the spec
`TypeError("X is not a constructor")` shape. Most cases come from
Promise combinators and from explicit non-constructor invocation
checks. Per spec, `Construct(C, …)` requires `IsConstructor(C)` and
throws `TypeError` otherwise — with the wording `"<X> is not a constructor"`.

## Failing test examples

- `test/built-ins/Promise/all/resolve-throws-iterator-return-null-or-undefined.js`
- `test/built-ins/Promise/allSettled/species-get-error.js`
- `test/built-ins/Promise/executor-function-not-a-constructor.js`
- `test/built-ins/Promise/allSettled/reject-element-function-length.js`
- `test/language/function-code/10.4.3-1-26gs.js`

Most tests do `assert.throws(TypeError, …)` so they fail because the
thrown object isn't recognised as `TypeError`. Two cases are related:

1. Promise species lookup (`@@species`) returns a non-constructor;
   we should call `IsConstructor` and throw spec `TypeError`.
2. `Promise.all/allSettled/any/race` executor handling — the *resolve*
   /*reject* element-function paths fall through into a `Construct`
   we don't gate.

## Approach

1. Make `IsConstructor` available at the codegen sites that perform
   `[[Construct]]` (Promise combinators, `new`).
2. Make the failure path raise spec `TypeError` with the canonical
   message instead of the host runtime string.
3. Bridge to #1519 (new-expression non-constructor TypeError) — there
   is likely a shared helper.

## Acceptance criteria

- The five example tests pass.
- The error string contains `"is not a constructor"` and the thrown
  object is `instanceof TypeError`.
- At least 50 of the 79 cluster tests flip to pass.

## Estimated impact

**~79 test262 tests** plus indirect downstream unblocks once Promise
combinators round-trip species correctly.

## Investigation + decomposition (2026-05-27)

Ran the five named test262 files and ground-truth compile/instantiate/run
probes on current main. The cluster is NOT a single Promise/species bug; it is
dominated by a **missing dynamic `[[Construct]]` path**, and the species half
is already spec-correct.

### Confirmed by probe
1. **Dynamic `new <runtime-value>()` does not perform IsConstructor + throw.**
   `new executorFunction()` where the callee is a runtime function value (the
   `isConstructor.js`-harness tests) is the dominant failing shape. Today such
   identifiers fall into the unknown-constructor `__new_<name>` extern-import
   path (throws a generic `No dependency provided` Error, not a TypeError) or
   silently no-throw. A type-checker heuristic cannot fix this safely: TS models
   plain function *declarations* as call-only (`construct=0, call=1`), identical
   to non-constructable function *expression values* — but `new f()` on a
   function value IS valid JS, so rejecting on the signature shape would regress
   valid constructions. This needs the architect-spec'd dynamic-construct path
   (route to `__reflect_construct` / Wasm-native IsConstructor), which touches
   the most-trafficked `new` dispatch. **Tracked as #1528a — needs architect
   sign-off; NOT landed here.**
2. **Species half already correct.** `Promise.allSettled.call(C, [])` does not
   spuriously read `@@species` (probe passed); the JS-host delegation in
   `runtime.ts` `Promise_allSettled` → native `Promise.allSettled.call` is
   spec-correct.
3. **`10.4.3-1-26gs.js` is mis-bucketed** — a strict-mode `new (anon fn)`
   returning `this` case, unrelated to non-constructor TypeError.

### Landed here (#1528b — safe static subset)
Broadened the static non-constructor guards in `new-super.ts` to unwrap
`as`/`!`/type-assertion wrappers (not just parens) via a shared
`unwrapNewTarget` helper, so `new ((() => {}) as any)()` and
`new (Math.abs as any)()` hit the real-TypeError throw path instead of slipping
into the dynamic path and silently no-throwing. The call-sig-only / prototype-
method guards now resolve the type on the *pre-cast* target. ~30 LOC, additive,
zero regressions in the constructor/new unit suites. Spec §7.3.15 Construct /
§7.2.4 IsConstructor.

**Status:** #1528b landed; #1528a (the dominant 79-test cluster) remains open,
escalated for an architect dynamic-construct spec.

## Implementation Plan (#1528a — dynamic-construct via `__reflect_construct`)

### Root cause (one paragraph)

`new <expr>(...args)` where `<expr>` is a **runtime function value** (a
parameter, captured local, member access on an externref, IIFE result, etc.)
falls past every typed branch in `compileNewExpression`
(`src/codegen/expressions/new-super.ts`):

- The static-non-constructor guards (lines 1464–1584) only fire when the
  callee is `ArrowFunction`, `PropertyAccess` ending in `.prototype.X`, a
  TS type with call-sigs-but-no-construct-sigs, or a known builtin namespace.
  None of these match a plain externref-valued identifier such as
  `executorFunction` from test262's `isConstructor.js` harness.
- The class fast-paths (`classSet.has(className)`, `funcConstructorMap`,
  `__new_<Name>` host import, function-style class via `compileNewFunctionDeclaration`)
  all require `className` to resolve to a *static* class or function-style
  constructor known at compile time. A locally-bound `function executorFn(){}`
  *value* (re-assigned, returned from a factory, or stored on an object) does
  not.
- Control therefore reaches the catch-all `reportError(ctx, expr,
  \`Unsupported new expression for class: ${className}\`)` at
  `new-super.ts:3177`, which either silently emits no construct call or
  produces the legacy `__new_<name>` extern-import path that throws the host
  string `[object Object] is not a constructor` — neither matches spec
  §7.3.15 `Construct(F)` (TypeError instance) nor delivers a real
  constructed value when F **is** constructable.

The infrastructure to fix this already exists: `__reflect_construct(ctor,
args, newTarget)` is wired and used by the `Reflect.construct` lowering
(`src/codegen/expressions/calls.ts:4534-4545`) and bound on the JS host
side at `src/runtime.ts:5488-5498`. This plan reuses it as the dynamic
`new` fallback.

### Spec citations

- ECMA-262 §13.3.5.1.1 **EvaluateNew** — `constructor = ? GetValue(ref);
  if (! IsConstructor(constructor)) throw a TypeError exception;
  argList = ? ArgumentListEvaluation(arguments);
  return ? Construct(constructor, argList)`.
- §7.3.15 **Construct(F, argumentsList, newTarget)** — calls `F.[[Construct]](argumentsList, newTarget)`.
- §7.2.4 **IsConstructor(argument)** — returns `true` iff argument has a `[[Construct]]` internal method.

`__reflect_construct` already performs all three steps host-side:
`Reflect.construct` throws `TypeError("X is not a constructor")` when
`IsConstructor` fails, and otherwise returns the constructed object as an
externref. The Wasm side does nothing but forward the callee, the packed
argList, and `newTarget`.

### Host import contract

`__reflect_construct` is already registered (see runtime.ts:5488).
The dynamic-`new` path uses the **same** signature it shares with the
`Reflect.construct` lowering — no new import:

```
(import "env" "__reflect_construct"
  (func (param externref)   ;; constructor (target)
        (param externref)   ;; args — a JS Array built via __js_array_new/__js_array_push
        (param externref)   ;; newTarget — ref.null.extern means "use ctor as newTarget"
        (result externref)))
```

Reuse `ensureLateImport(ctx, "__reflect_construct", [externRef, externRef,
externRef], [externRef])` — the cache will return the existing index when
both `Reflect.construct(...)` and dynamic `new` appear in the same module.

**Standalone (`--target wasi`, `noJsHost(ctx)===true`) — out of scope.**
There is no Wasm-native `Reflect.construct` today; if the import is
unavailable, emit the same real-TypeError throw the static guards use
(`emitThrowTypeError(ctx, fctx, "is not a constructor")`) and push
`ref.null.extern` for stack discipline. This is consistent with #1474
(RegExp refuse-and-document) and #1473 (host-error stubs) — leaving a
follow-up issue for native dynamic-construct is appropriate.

### Changes

**File: `src/codegen/expressions/new-super.ts`**

1. **New helper at module scope** (near the existing
   `unwrapNewTarget` at line 1445):

   ```ts
   /**
    * (#1528a) Compile `new <callee>(...args)` via __reflect_construct when the
    * callee is an externref-valued runtime expression we cannot resolve to a
    * known class / function-style constructor at compile time. The host
    * wrapper performs IsConstructor and throws spec TypeError on failure.
    *
    * Layout on the Wasm stack after this function returns:
    *   [externref]  — the constructed instance (or trap propagated out)
    *
    * Returns the externref ValType so the caller can use it as the
    * compileNewExpression result.
    */
   function compileDynamicConstruct(
     ctx: CodegenContext,
     fctx: FunctionContext,
     expr: ts.NewExpression,
   ): ValType {
     const externRef: ValType = { kind: "externref" };

     // Standalone fallback: no __reflect_construct on no-JS-host targets.
     // Mirror the static-guard behaviour: throw a real TypeError and yield
     // ref.null.extern so downstream stack discipline holds.
     if (noJsHost(ctx)) {
       emitThrowTypeError(ctx, fctx, "is not a constructor");
       fctx.body.push({ op: "ref.null.extern" });
       return externRef;
     }

     // 1. Compile callee as externref (parameter, member access, IIFE, etc.).
     //    coerceType handles f64/i32/ref → externref via __box_number /
     //    extern.convert_any as needed (see codegen/type-coercion.ts).
     const calleeTy = compileExpression(ctx, fctx, expr.expression, externRef);
     if (!calleeTy) {
       fctx.body.push({ op: "ref.null.extern" });
     } else if (calleeTy.kind !== "externref") {
       coerceType(ctx, fctx, calleeTy, externRef);
     }

     // 2. Build the argList JS Array via __js_array_new / __js_array_push.
     //    Mirrors the array packing in calls.ts:4146-4170 (Reflect.apply 3rd arg).
     const arrNewIdx = ensureLateImport(ctx, "__js_array_new", [], [externRef]);
     const arrPushIdx = ensureLateImport(
       ctx,
       "__js_array_push",
       [externRef, externRef],
       [],
     );
     flushLateImportShifts(ctx, fctx);

     fctx.body.push({ op: "call", funcIdx: arrNewIdx! });
     // Stash the array in a local so we can push args without disturbing the callee.
     const argsLocal = allocLocal(fctx, `__dynctor_args_${fctx.locals.length}`, externRef);
     fctx.body.push({ op: "local.set", index: argsLocal });

     const args = expr.arguments ?? [];
     for (const arg of args) {
       fctx.body.push({ op: "local.get", index: argsLocal });
       // Spread: pass-through. Per §13.3.5 + §13.3.8 ArgumentListEvaluation,
       // spread expands at call time. For the dynamic path we evaluate each
       // spread element via the existing array-spread helper. If the spread
       // operand is a Wasm vec struct it must be flattened. **Out of scope
       // for the first cut — reject `new <dynamic>(...spread)` with a clear
       // diagnostic and let #1609 lift the restriction.**
       if (ts.isSpreadElement(arg)) {
         reportError(
           ctx,
           expr,
           "Codegen error: spread arguments in dynamic new-expression not yet supported (#1528a / #1609).",
         );
         fctx.body.push({ op: "drop" }); // drop the args-local copy we pushed
         fctx.body.push({ op: "ref.null.extern" });
         return externRef;
       }
       const argTy = compileExpression(ctx, fctx, arg, externRef);
       if (argTy && argTy.kind !== "externref") {
         coerceType(ctx, fctx, argTy, externRef);
       } else if (argTy === null) {
         fctx.body.push({ op: "ref.null.extern" });
       }
       fctx.body.push({ op: "call", funcIdx: arrPushIdx! });
     }

     // 3. Push the args array, then newTarget = ref.null.extern (host defaults
     //    to ctor when newTarget is null — see runtime.ts:5493).
     fctx.body.push({ op: "local.get", index: argsLocal });
     fctx.body.push({ op: "ref.null.extern" });

     // 4. Call the import. Re-lookup the funcIdx — argument compilation may
     //    have triggered addUnionImports (which shifts indices), mirroring
     //    the pattern at new-super.ts:2687.
     const reflectConstructIdx = ensureLateImport(
       ctx,
       "__reflect_construct",
       [externRef, externRef, externRef],
       [externRef],
     );
     flushLateImportShifts(ctx, fctx);
     const finalIdx = ctx.funcMap.get("__reflect_construct") ?? reflectConstructIdx!;
     fctx.body.push({ op: "call", funcIdx: finalIdx });
     return externRef;
   }
   ```

2. **Wire it into the catch-all** at `new-super.ts:3177`. Replace the bare
   `reportError(... \`Unsupported new expression for class: ${className}\`)` with:

   ```ts
   // (#1528a) Dynamic constructor path. We exhausted the typed/static fast
   // paths; if the callee is a runtime externref-valued expression, defer
   // IsConstructor + Construct to the host via __reflect_construct. This
   // covers:
   //   - parameter or local function values (`function f(C){ new C() }`)
   //   - member access producing a function value (`new obj.ctor()` when
   //     the receiver is externref and we can't resolve the property)
   //   - IIFE results (`new (function(){ return X; })()`)
   //   - any TS type widened to `any` / `Function` / `unknown` that escaped
   //     the static guards above
   // Static non-constructors (arrow fns, prototype methods, builtin
   // namespaces) have ALREADY thrown a real TypeError via the guards at
   // lines 1464-1584. By the time we get here we have a runtime value
   // whose constructability is genuinely unknown — that's exactly what
   // Reflect.construct is for. The host wrapper throws spec TypeError
   // ("X is not a constructor") when IsConstructor fails.
   if (!noJsHost(ctx)) {
     return compileDynamicConstruct(ctx, fctx, expr);
   }
   // Standalone: keep the error (escalates the gap visibly until a
   // Wasm-native dynamic-construct lands).
   reportError(ctx, expr, `Unsupported new expression for class: ${className}`);
   return null;
   ```

3. **Imports already present.** `compileExpression`, `coerceType`,
   `ensureLateImport`, `flushLateImportShifts`, `allocLocal`,
   `emitThrowTypeError`, `noJsHost`, `reportError` are all already imported
   in this file — no new module-level imports needed.

**File: `src/codegen/expressions/calls.ts`** — no changes. The existing
`Reflect.construct` lowering (line 4534) already uses `ensureLateImport`,
so the index is cached and shared with the dynamic-`new` callsite.

**File: `src/runtime.ts`** — no changes. `__reflect_construct` is already
bound (lines 5488–5498) and handles `newTarget === null/undefined` by
defaulting to the ctor.

**File: `src/codegen/host-import-allowlist.ts`** — verify
`__reflect_construct` is on the JS-host allowlist (it must be already
because `Reflect.construct` uses it). No change expected; flag if missing.

### `new.target` handling

In a **derived constructor body**, `new.target` is the original construct
target. The dynamic path in this issue is **at the call site, not inside
a constructor**, so the construct target == the callee value the user
wrote, and `newTarget = null` (= "default to ctor" per the host wrapper)
is correct.

Cases that DO see a non-trivial `new.target`:

- `super(...)` inside a derived constructor — handled in the existing
  `compileSuperCall` path, not this one.
- `Reflect.construct(C, args, NT)` — explicit, already handled by the
  `Reflect.construct` lowering, which forwards the third arg unchanged.

If a future caller needs to thread `new.target` through dynamic `new`
(e.g. `new (this.constructor)(...)` from a method whose enclosing
constructor has its own `new.target`), the helper takes a fourth optional
parameter `newTargetExpr?: ts.Expression`; the first cut should leave
this at `null` (host-defaults-to-ctor) and add the parameter when a
concrete failing test demands it. Document this as out-of-scope-for-now
with a TODO comment referencing #1640 (Reflect invariant mirror).

### Pre-conditions / ordering vs the existing fast paths

The dynamic path is the **last** branch. All static guards must fire
first so they continue to win in their cases:

1. (line 1464) `new <ArrowFunction>()` → static TypeError. **Must precede**
   dynamic — arrows are values too, but IsConstructor on them is `false`
   and we'd rather throw at compile time than round-trip the host.
2. (line 1515) prototype-method / call-sig-only non-constructors →
   static TypeError. Same reason.
3. (line 1555) builtin-namespace non-constructors (`Math`, `JSON`,
   `Reflect`, `Atomics`) → static TypeError.
4. (line 2622) `ctx.classSet.has(className)` → in-module class. **Must
   precede** dynamic — emits direct `<Class>_new` call, no host round-trip.
5. (line 2310) `new this(...)` resolving to a function-style class
   (#1679). **Must precede** dynamic.
6. (line 2588) `__new_<Name>` host-import path for known builtin
   constructors (Number/String/Boolean/Error subclasses/etc.). **Must
   precede** dynamic.
7. **(NEW) Dynamic construct** — fall-through.

Verify by reading the function top-to-bottom; the catch-all already sits
at the bottom (line 3177), so replacing it preserves order automatically.

### Edge cases

- **Callee evaluates to `null` / `undefined`.** `__reflect_construct`
  forwards to `Reflect.construct`, which throws
  `TypeError("X is not a function")` (or "...not a constructor" on V8).
  Test262's `assert.throws(TypeError, …)` accepts either. No special
  handling needed.
- **Callee is a Wasm class instance (e.g. `new C` where `C = SomeClass`
  was assigned to a parameter typed `Function`).** `_isWasmStruct` /
  `_wrapForHost` in runtime.ts:5491 already wraps the struct so the host
  sees a JS-callable proxy. The proxy's `[[Construct]]` routes back into
  the wasm `<Class>_new` via the existing JS-host bridge.
- **Argument is a Wasm vec struct (rest spread).** Out of scope for the
  first cut (see helper step 2 — reject spread with a clear diagnostic
  pointing at #1609). The non-spread arity case (`new fn(a, b, c)`)
  is the dominant shape across the 79-test cluster.
- **Argument is f64 / i32.** `coerceType(... , externRef)` already routes
  through `__box_number` / `f64.convert_i32_s + __box_number` per
  `src/codegen/type-coercion.ts`. No new boxing.
- **`new <callee>` (zero args).** `__js_array_new` produces `[]`; the
  loop is skipped; the host invokes `new ctor()`. Correct.
- **`addUnionImports` shifts.** The `ctx.funcMap.get("__reflect_construct")
  ?? reflectConstructIdx` re-lookup at step 4 handles late-import
  shifts, mirroring the same pattern at new-super.ts:2687 and
  shared advice in `CLAUDE.md` (`addUnionImports` section).
- **`expr.expression` is `ts.SuperExpression`.** Cannot reach this path
  — `super(...)` is a SuperCall, not a NewExpression. No guard needed.
- **`expr.expression` throws during evaluation** (e.g. property access on
  null). Compile the callee FIRST, before building the args array; any
  throw it emits propagates correctly via the exception tag. Step 1
  before Step 2 in the helper enforces this. (Spec §13.3.5.1.1 evaluates
  the constructor before ArgumentListEvaluation.)
- **Evaluation order.** Spec is: evaluate constructor → evaluate
  arguments left-to-right → IsConstructor check → Construct. Steps 1–4
  of the helper preserve this exactly. Side effects in argument
  expressions land in source order.

### Wasm IR pattern (representative)

```wasm
;; source:  new makeCtor(1, x)
;;
;; 1. callee
call $makeCtor              ;; -> externref
;; coerceType already a no-op since makeCtor returns externref

;; 2. argList = __js_array_new()
call $__js_array_new        ;; -> externref
local.set $__dynctor_args_7

;; arg 0: f64 const 1
local.get $__dynctor_args_7
f64.const 1
call $__box_number          ;; f64 -> externref
call $__js_array_push       ;; (args, val) -> void

;; arg 1: local x (already externref)
local.get $__dynctor_args_7
local.get $x
call $__js_array_push

;; 3. push args + null newTarget
local.get $__dynctor_args_7
ref.null extern

;; 4. construct
call $__reflect_construct   ;; (ctor, args, newTarget) -> externref
;; result on stack: the constructed instance (or trap propagates)
```

### Acceptance criteria

1. All five originally-named test262 files in the issue's "Failing test
   examples" section now `pass`.
2. ≥ 50 of the 79 cluster tests flip to `pass`. Remaining failures fall
   into one of: spread-in-new (#1609), bigint-related (#1644), or
   genuinely unrelated to this cluster.
3. The `executor-function-not-a-constructor.js`-shaped tests throw a
   value where `instanceof TypeError === true` AND the message contains
   `"is not a constructor"`.
4. **No regressions** in `tests/equivalence.test.ts` `new`-expression
   buckets. Spot-check classes that hit each static guard (arrow,
   prototype-method, `Math`, named class, function-style class, builtin
   wrapper Number/String/Boolean, `__new_Error`) — they must continue to
   take their existing static path, not fall through to dynamic.
5. Standalone (`--target wasi`) behaviour for the same constructs stays
   the diagnostic-error path (no silent `__reflect_construct` import
   added in standalone — verify with the IR-fallback budget script).

### Test files to verify (canonical sample)

- `test/built-ins/Promise/executor-function-not-a-constructor.js` —
  passes a non-constructor where a constructor is required; expects
  spec TypeError.
- `test/built-ins/Promise/all/resolve-throws-iterator-return-null-or-undefined.js`
  — Promise.all delegation; observes TypeError via combinator path.
- `test/built-ins/Promise/allSettled/species-get-error.js` — species
  hook; observes TypeError via the @@species path. (#1528b confirmed
  species itself is spec-correct; this test failed because of the
  TypeError shape only.)
- `test/built-ins/Promise/allSettled/reject-element-function-length.js`
  — element-function `[[Construct]]` invariant.
- `test/language/function-code/10.4.3-1-26gs.js` — strict-mode
  `new (anon fn)`. (Per the investigation note this is mis-bucketed but
  should also pass once the dynamic path handles `new (FunctionExpression)`
  through the same mechanism for the non-statically-named case.)

### Estimated impact

50–79 test262 tests in the immediate Promise-combinator cluster, plus an
unknown downstream from real-world JS code that currently routes
`new <dynamic>` into the legacy `__new_<name>` extern-import (which throws
the host string on first invocation). Tracked via the post-PR
test262-sharded diff on the regression-gate baseline.

### Out of scope (follow-up issues)

- **Spread in dynamic `new`** — bridged to #1609. Helper rejects with a
  clear diagnostic; lift restriction when #1609 lands.
- **Standalone/WASI dynamic construct** — needs a Wasm-native
  `IsConstructor` and a structural Construct path; not solvable from a
  host import. New issue if/when standalone hits this gap.
- **Threaded `new.target`** — out of scope until a concrete failing test
  forces it; helper signature leaves room.
- **#1640 Reflect invariant mirror** — orthogonal; this spec uses the
  existing host-side `Reflect.construct` semantics as-is.

## 2026-05-28 — PR #794 closed, #1528a blocked pending architect rework

The architect-spec'd implementation of #1528a in PR #794 (`fix(#1528a):
dynamic new via __reflect_construct`) caused a **catastrophic
−822-net regression** confirmed across **three** CI runs (948 wasm-change
regressions, threshold 200; 945 pass→fail). PR #794 closed without merge.

**Root cause:** `compileDynamicConstruct` calls `flushLateImportShifts`
**three times** during mid-function emission, and the broad catch-all at
the old `reportError` callsite (`src/codegen/new-super.ts:3262` in the PR
branch) routed far more `new <expr>(...)` shapes into the dynamic path
than the architect spec envisioned. Each `flushLateImportShifts` call
corrupts already-emitted `call` indices in the surrounding function body
— the same #618 pattern that forced the PR #608 revert.

**Status (2026-05-28):** #1528a → `blocked`. The fix requires architect
rework of `compileDynamicConstruct` so it (a) does **not** call
`flushLateImportShifts` mid-compilation, and (b) narrows the catch-all
callsite to the genuinely-dynamic shapes only (parameter / captured
local / member-access on externref / IIFE result), not every `new <expr>`
that falls past the static guards.


## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).

## #1528a-arrow subset landed (2026-06-22)

Landed the **arrow-function-value** subset of the #1528a non-constructor cluster
— a small, substrate-independent slice that reuses the **existing, tested**
`__construct` brand-check path (#1732 S1), avoiding the
`flushLateImportShifts`-mid-function index corruption that forced the PR #608
revert of the broad `compileDynamicConstruct`.

**Change** — `src/codegen/expressions/new-super.ts`,
`resolvesToNonConstructableValue` (the #1732 S1 helper): an **arrow-function
initializer** (`const f = () => 1; new f()`) is now recognised as a provably-
non-constructable value (§15.3.4 — arrows have no [[Construct]]), so `new f()`
routes through the `__construct` brand check and throws a real
`TypeError("… is not a constructor")` instead of slipping into the unknown-ctor
path and silently not throwing. 8 lines, additive, alongside the existing
prototype-method / `.bind`/`.call`/`.apply` shapes. No runtime.ts change; no new
coercion site.

**Tests** — `tests/issue-1528.test.ts` gains a `#1528a — arrow-function value`
describe (5 cases: arrow value, cast-wrapped arrow, arrow-with-params throw;
class + function-declaration construct regression guards). 11/11 pass. Full
constructor/new suite (issue-1732-s1/s2, issue-1519, fn-constructor,
issue-2026-constructor-identity-any) green — zero regressions.

**Still open (substrate-blocked, #1632b-2):** dynamically **CONSTRUCTING** a
runtime function VALUE (factory-returned `function C(){}` → `new C()`) — verified
this needs the closure-construct host bridge (`_wrapCallableForHost`'s construct
trap) PLUS the `__call_fn_*` arity dispatcher to be reachable for the value, and
behaves inconsistently depending on `setExports` timing. That is the deeper
closure-as-dynamic-constructor work, NOT a clean dev slice. The non-constructor
**throw** cases (arrows, bound functions, prototype methods, call-only callables)
are the substrate-independent, test262-cluster-dominant part and are now covered.
Issue stays `ready` for the remaining construct-a-fn-value cluster.

## #1632b-2 closure-construct-bridge — implementation plan (2026-06-22, sd, task #56)

**Re-grounded root cause (current main).** `new Ctor(args)` where `Ctor` is a
factory-returned `function C(){}` value (an `any`/function-typed identifier, not
a declared class) is mis-classified: codegen routes it to the **extern-class**
path (`new-super.ts:3999` `externClasses.get(className)`), emitting a
`<prefix>_new` host call that fails at instantiation with
`No dependency provided for extern class "Ctor"`. It never reaches a construct
bridge. (Confirmed via `.tmp/probe-construct.js` → that exact runtime error.)

The existing `__construct` host helper (`runtime.ts:9275`) wraps the callee with
`_wrapForHost` (NON-callable proxy), so its `IsConstructor` probe FAILS for a
real constructable closure and it throws "not a constructor" — correct for
arrows/bound/methods (#1921 routes those here to throw), WRONG for a genuine
`function C(){}` value.

**Fix (two narrow parts; host-helper, NOT a wasm `__construct_closure` codegen
export — sidesteps the #608/#794 `flushLateImportShifts`-mid-function index
corruption entirely):**

1. **runtime.ts** — new host helper `__construct_closure(callee, argsArray)`:
   when `callee` is a wasm closure, wrap with **`_wrapCallableForHost`** (its
   construct trap = ECMA-262 §10.2.2 OrdinaryCallEvaluateBody, already present at
   `runtime.ts:4874`) and `Reflect.construct(callableProxy, args)`. Non-closure
   structs / non-functions still throw the spec TypeError (keeps ctx-non-ctor).
   Distinct helper name so the arrow/bound/method NON-constructable throw path
   (`__construct`) is untouched.

2. **new-super.ts** — a NARROW guard placed BEFORE the extern-class branch
   (3999): when the `new` callee is an identifier whose value is a **function
   type that is NOT a declared/extern class** (a runtime function value), and
   `!noJsHost`, materialize args into a `__js_array_new`/`__js_array_push` JS
   array and emit a single `__construct_closure(callee, argv)` call. ONE terminal
   `flushLateImportShifts` after the call (the safe pattern the existing
   `__construct` site at 3663 uses), never mid-emission. Gate strictly on the
   function-value shape so no declared-class / intrinsic-ctor / typed-array path
   is intercepted (those branches precede or are matched by `classSet`/
   `externClasses` with real dependencies).

**Validation:** broad-impact construct path ⇒ full-gate via merge_group, never a
scoped sweep. Regression-watch the constructor/new suites (issue-1732-s1/s2,
issue-1519, fn-constructor, issue-2026-constructor-identity-any, issue-1528) +
the Promise capability tests (this also resolves #2614's any/invoke-resolve
illegal-cast — the combinator's NewPromiseCapability(C)→Construct(C, executor)
goes through the same bridge). Add `tests/issue-1528-closure-construct.test.ts`.

## #1632b-2 closure-construct bridge LANDED (2026-06-22, task #56)

The **ordinary-function-value** construct-a-fn-value cluster is now supported
JS-host: `const C = makeCtor(); new C(args)` constructs via the new
`__construct_closure` host helper (`_wrapCallableForHost`'s construct trap runs
the compiled closure body). New `tests/issue-1528-closure-construct.test.ts`
(4 pass, 1 skip = the explicit-object-return override follow-up). The 48-test
constructor/new regression suite stays green; the #1921 non-constructable throw
cases are untouched (separate `__construct` path). Also unblocks the Promise
combinator capability path's `any/invoke-resolve` (same bridge).

**Still open (follow-up, out of this slice):** the compiled-CLASS-as-dynamic-ctor
sub-case — `__fn_tramp_Constructor_*` `illegal cast` (e.g.
`allSettled/call-resolve-element.js`, `race/resolve-from-same-thenable.js`). That
is the `__construct_closure` *codegen export* (spec step 4), distinct from the
host-helper ordinary-function path delivered here. Issue stays `in-progress` for
that arm; #2614 remains blocked on it.

## Class-ctor arm — implemented + measured verdict (2026-06-22, sd-1838, post-#1940-merge)

**The bounded surface fix is done; the headline cluster is a larger follow-up.**

### Done (committed, branch issue-1528-classctor-arm, 0 regressions)
`calleeIsCapabilityCtorParam` (calls.ts) — syntactic gate: a param whose declaring
function flows to a `Promise.{all,allSettled,race,any}.call(fn, …)` site. Such a
param (`executor`) is UNTYPED (`any`, no call signatures) and V8 fills it with a
HOST function when it does `Construct(Constructor, «executor»)` (via #1940's
bridge). The no-call-signature fallback `ref.cast`s it to a closure struct →
`illegal cast in Constructor()`. Fixed by routing the call through the existing
`__call_function` host helper via an early-return BEFORE the call-sig gate
(alongside the bound-function path). Min repro passes; +2 peripheral rows
(`capability-executor-called-twice`, `species-get-error`). JS-host only; the
narrow gate preserves the #1941 dual-mode guarantee.

### NOT closed (larger follow-up — beyond the param-call surface fix)
1. **Multi-hop host→wasm callback cast** (`allSettled/call-resolve-element`,
   `race/resolve-from-same-thenable`): `Constructor` passes its INNER `resolve`
   (a wasm closure) to the host `executor`; when the host thenable later calls
   `resolve(value)` BACK, the host→wasm callback path casts and traps. The
   executor-call fix routes the OUTBOUND call; the INBOUND callback of a
   wasm-closure-passed-to-host is a separate cast site.
2. **Species / ctor identity** (all `ctx-ctor` rows): `instance.constructor ===
   SubPromise` requires the capability's `.constructor`/prototype identity to
   survive the bridge — a `_wrapCallableForHost` `.prototype`/species concern.
3. **Observable-resolve identity** (`invoke-resolve` all/race): still asserts
   `nextValue === current` (the #2614 sandbox-`Promise.resolve` coupling); the
   observable-resolve change was deliberately NOT stacked here (it couples to
   #1 and #2).

### Recommendation
The executor-routing substrate is useful and clean, but the cluster's dominant
rows need #1 (multi-hop callback cast) + #2 (species identity) + #3
(observable-resolve), which together are a sprint-scale capability-cluster effort,
not this arm. Ship the arm small OR fold it into that larger effort. #2614 stays
blocked on #1/#2/#3; #2618 (Proxy apply/construct) shares the same
`__fn_tramp_Constructor` dispatch and sequences after.
