---
id: 4221
title: "Calling a non-callable answers undefined instead of throwing TypeError; bound functions do not poison caller/arguments"
status: done
completed: 2026-08-08
updated: 2026-08-18
sprint: 78
created: 2026-08-08
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen
goal: es5
related: [1888, 2106, 2151, 2552, 2929, 3673, 4137, 4220]
loc-budget-allow:
  # object-runtime.ts (+43): the absent-callee TypeError has to be emitted at
  # the site that RESOLVES the method — `__extern_method_call`'s $Object arm,
  # inside `ensureObjectRuntime`. The whole point of the fix is that this
  # registration happens during codegen rather than at finalize (where
  # `fillApplyClosure` lives and where the error machinery shifts func
  # indices), so it cannot be relocated to a satellite module without
  # reintroducing the index-shift hazard it exists to avoid. The +43 is the
  # locals list lifted out of an inline ternary so a local can be appended,
  # plus the guard and its rationale comment.
  - src/codegen/object-runtime.ts
  # calls.ts (+9): one guard dispatch in `compileCallExpression`'s early-guard
  # chain — the guard body itself lives in calls-guards.ts, which is the
  # designated satellite for exactly this. The chain is the only place a
  # callee-shape guard can be ordered against the other guards.
  - src/codegen/expressions/calls.ts
func-budget-allow:
  # Same two edits seen per-function; both are additions to an existing
  # dispatch chain / runtime-function builder, not new logic that could live
  # in its own function without losing access to the surrounding baked
  # funcIdx / locals context. Splitting either is #3399-class work.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/expressions/calls.ts::compileCallExpression
origin: "2026-08-08 — ES5-standalone-90 Wave 2, WP2 (function invocation semantics)"
---

# #4221 — a call to a non-callable must throw TypeError

## Problem

Three independent holes in function-invocation semantics, all of which surface
as "the program silently continued with `undefined`" rather than a diagnosable
error.

### 1. Method call whose callee is absent (standalone only)

`o.bar()` where `o` has no `bar` lowers to
`__extern_method_call(o, "bar", args)`, which resolves the method with
`__extern_get`, normalises the miss to `null`, and hands that `null` to
`__apply_closure`. `fillApplyClosure` (`src/codegen/object-runtime.ts`) is
explicit that this is deliberate and deferred:

> **S1 SCOPE — NO THROWS.** This bridge returns the undefined sentinel
> (`ref.null.extern`) for the not-a-function and arity-overflow cases rather
> than raising a `TypeError`. […] The spec-correct `TypeError` throws (ES
> §7.3.14 step 2 "is not a function" […]) plus the index-shift fix are the S2
> fast-follow.

The stated blocker was that pulling `__new_TypeError` + the exn tag + a string
constant in **at FINALIZE** shifts function indices and corrupts the module
(the #1839/#117/#1886 late-registration class).

The JS-host (gc) lane does not have this bug — there `__extern_method_call` is
a host import and the engine throws — so it is a pure standalone gap.

### 2. Call whose callee is a provably non-callable VALUE (both lanes)

`true()`, `"s"()`, `null()`, `(new Number(1))()` fall all the way through
`compileCallExpression` to its documented last-resort arm:

```ts
// Graceful fallback for non-LHSE callee: compile callee and args for side
// effects, return externref null. Avoids hard compile errors for uncommon
// callee shapes.
```

so the call expression evaluates to `undefined` and execution continues.

### 3. A bound function does not poison `caller` / `arguments`

ES5 §15.3.4.5 steps 20-21 install `[[ThrowTypeError]]` as **both** the getter
and the setter of a bound function's `caller` and `arguments`, unconditionally
— independent of the target's strictness. `sourceFunctionForValue`
(`src/codegen/function-poison-pill.ts`) resolves only *source* functions, so a
bound function reached neither poison path: `boundFn.caller` answered
`undefined` and `boundFn.arguments = 12` silently succeeded.

## Fix

1. **`src/codegen/object-runtime.ts`** — emit the absent-callee TypeError in
   `__extern_method_call`'s `$Object` arm instead of inside `__apply_closure`.
   `ensureObjectRuntime` runs during **codegen**, where minting the in-module
   `__new_TypeError` only APPENDS a defined func, so the index-shift blocker
   that deferred this simply does not apply — the same discipline the
   `__to_primitive` TypeError in that file already uses. Gated on
   `noJsHost(ctx)`; the gc lane is byte-identical.

   Scope is the resolved-method-is-**null** case only. A non-null but
   non-callable value keeps the legacy answer, because the callable-brand
   classifier does not recognise every callable shape and a false positive
   converts a working call into a hard throw.

2. **`src/codegen/expressions/calls-guards.ts`** — new early guard
   `tryNonCallableValueCall`, wired into `compileCallExpression` right after
   `tryNamespaceNonCallable`. Fires only when `ctx.oracle` PROVES the callee
   non-callable: a primitive fact kind, or a nominal instance
   (`builtin`/`class`, plus `object` behind a syntactic `new`). Evaluation
   order follows §13.3.6.2 — callee, then arguments, then the throw — so
   `o.bar(sideEffect())` still runs `sideEffect`.

   **The load-bearing negative case** is `isEvolvingAnyBinding`: the test262
   *probe* idiom `var probe; function f(){ probe = function(){…} } f(); probe();`
   leaves `probe` an implicit-any binding whose control-flow type at the call
   site is `undefined`, because the only write is inside a nested function. A
   naive primitive check compiles that working call into a TypeError — measured,
   it flipped `language/statements/function/scope-param-rest-elem-var-close.js`
   from pass to fail. So a plain identifier callee only reaches the throw when
   its declaration commits to the type (explicit annotation, or an initializer
   that is itself provably non-callable).

3. **`src/codegen/function-poison-pill{,-access}.ts`** — new
   `isBoundFunctionValue`, recognised purely syntactically (a `.bind` member
   call, or a variable whose initializer is one), routed into both the poison
   read and the poison assignment paths.

## Acceptance criteria

- `o.bar()` on a missing method throws TypeError in standalone; `var o = {};
  o.bar = function(){…}; o.bar()` still calls.
- `true()` / `null()` / `new Number(1)()` throw TypeError in both lanes.
- `boundFn.caller`, `boundFn.arguments`, and assignment to either, throw
  TypeError.
- No standalone regression on a sampled cross-section of the corpus.

## Measured flips (`runTest262File`, the #4162 shared seam)

Standalone lane, before → after, each observed directly:

| Test | before | after |
| --- | --- | --- |
| `language/expressions/call/11.2.3-3_1`, `_2`, `_5`, `_6`, `_7` | fail ×5 | **pass ×5** |
| `language/expressions/call/S11.2.3_A3_T1..T5` | fail ×5 | **pass ×5** |
| `language/expressions/call/S11.2.3_A4_T1..T3` | fail ×3 | **pass ×3** |
| `built-ins/Function/prototype/bind/15.3.4.5-2-1` | fail | **pass** |
| `built-ins/Function/prototype/bind/15.3.4.5-20-2`, `-20-3`, `-21-2`, `-21-3` | fail ×4 | **pass ×4** |

**18 flips, no regression found.**

### Regression sampling

A/B over a deterministic 311-file cross-section (`built-ins/{Object,Array,
String,Function,Number,Boolean,Date,JSON,Math,RegExp,Map,Set,Error,Promise,
Symbol}`, `language/{statements,expressions,arguments-object,function-code}`),
each side run against the same file list:

| lane | base | after |
| --- | --- | --- |
| standalone | 195 pass | 195 pass, **+3 in-sample gains, 0 regressions** |
| gc (92-file call-focused subset) | 44 pass | 46 pass, **+2, 0 regressions** |

The standalone `pass` total is flat because the three in-sample gains are
offset by three `pass → compile_error` rows that are **measurement artifacts,
not regressions**: this box is shared with other agents, `runTest262File`
reports a TIMEOUT as `compile_error`, and all three
(`Object/defineProperty/15.2.3.6-4-362`, `-4-484`,
`Object/preventExtensions/not-a-constructor`) pass on a sequential
single-process re-verify. Worth recording as a method note — a parallel
sample on a loaded machine manufactures phantom regressions, and the first
pass of this very measurement reported **38** of them.

## Deliberately NOT in scope (leftovers)

- `11.2.3-3_3` / `_4` — `o.bar.gar()`: the TypeError must come from the
  member READ on `undefined`, not from the call. Different lowering.
- `11.2.3-3_8`, `S11.2.3_A4_T4` — `this.bar()` / `this()` at script top level.
  Blocked on the script-goal global-object model (#4202, #4205).
- `built-ins/Function/prototype/bind/15.3.4.5-2-{3..6,8,9}` — `Number.bind(null)`
  etc. Binding a **builtin constructor** null-derefs because standalone has no
  callable value for builtin constructors. Needs its own issue.
- **Calling a bound function still null-derefs in standalone**
  (`S15.3.4.5_A1`/`_A2`, and directly reproducible as
  `var b = f.bind(null, 4); b(3)`). The poison half of §15.3.4.5 is fixed here;
  the *call* half is a separate defect in the bound-function dispatch, and
  neither change in this issue touches it (`isBoundFunctionValue` is consulted
  only for a `caller`/`arguments` member, and the callee guard sees a
  `function` fact for a bound value and declines). Pinned as a compile-only
  assertion in `tests/es5-standalone-function-semantics.test.ts` so the guard's
  non-interference is regression-tested without locking in the bug. Needs its
  own issue.
- `built-ins/Function/prototype/bind/instance-{length,name}-*` — ES2015
  `length`/`name` on bound functions; out of the ES5 pool.
- `language/arguments-object` — `arguments.callee` as a real own property with
  descriptor attributes, and `arguments.constructor`. Untouched.

## Follow-up — 2026-08-11: runtime eval invalidates a primitive callee fact

The fresh 48,661-row standalone baseline left 89 exact ES5 Annex B residuals.
After excluding the seven `function-code/*-existing-block-fn-update` rows owned
by PR #4387, the largest coherent eval family was the 16 direct+indirect
`eval-code/global-*-eval-global-existing-var-update.js` files. Every one failed
with `TypeError: f is not a function` for this shape:

```js
var f = 123;
eval('{ function f() { return 1; } }');
f();
```

The provider and global pull-sync were already correct: the assertion
`typeof f === "function"` passed after eval. The throw came **before IR
selection**. `tryNonCallableValueCall` trusted the checker's fact for the
original numeric initializer and emitted an unconditional TypeError, so the
updated live global never reached the native IsCallable dispatcher. There is
therefore no competing IR lowering to repair or prefer for this slice; the
pre-IR guard must yield when a linked standalone eval can replace the binding.

The follow-up adds that narrow exception. It applies only when all of these are
true: standalone runtime eval is enabled, the callee is a bare identifier, it
is not shadowed by a local, and it is a caller/provider-synchronised global
`var` or global lexical binding. The ordinary primitive-callee rule remains in
force for modules without runtime eval, local primitive bindings, and the host
lane. A still-non-callable live value reaches the runtime dispatcher and throws
the same TypeError after the specified callee/argument evaluation order.

Maintained standalone A/B, full interpreter provider, one worker, exact filter
`global-existing-var-update`:

| build | pass / 24 | eval failures | controls / other |
| --- | ---: | ---: | ---: |
| fresh `origin/main` (`ebba42dfff7ceb`) | 5 | 16 | 5 pass, 3 fail |
| follow-up | 21 | **0** | 5 pass, 3 fail |

The delta is exactly **+16, 0 regressions**. The three surviving failures are
the non-eval `global-code/{block,switch-*}-global-existing-var-update.js` rows;
they are a separate AOT Annex B publication gap and are deliberately not folded
into this call-guard change. The focused regression executes both direct and
indirect eval through the linked interpreter provider, while the original 14
#4221 tests preserve primitive TypeErrors, evaluation order, dynamic-call
controls, bound-function guards, and host compilation safety.
