---
id: 6989
title: "Octane eval benchmarks (zlib, code-load, typescript, mandreel) in the harness; standalone code-load via QuickJS [[Construct]] + owner-routed membrane reads"
status: in-progress
sprint: current
created: 2026-10-14
assignee: ttraenkler/session-d
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime-eval
language_feature: eval, constructor-functions, property-access
goal: standalone-gap
related: [874, 4245, 4307, 4438, 6583]
loc-budget-allow:
  # 2026-10-14: +8 — `tryRuntimeEvalApplyCallableIntrinsic` delegates to the new
  # provider-side `__runtime_eval_rebind_carrier` intrinsic (body lives in
  # runtime-eval-callable.ts); the delegation needs the argument-compile callback.
  - src/codegen/expressions/calls.ts
  # 2026-10-14: +8 — the Node-side identity stub for `__runtime_eval_rebind_carrier`,
  # next to its sibling `__runtime_eval_is_aot_callable` stub.
  - src/interp/loop.ts
---

# #6989 — Octane's eval benchmarks, standalone

## Why

The Octane harness (#874) ran 9 of Octane's 15 benchmarks and excluded the
other six for every lane. All 9 pass on `--target standalone` (main
`320b752d8f`). Four of the six excluded ones are excluded only because they
use `eval` / `new Function`: zlib, code-load, typescript, mandreel.
Standalone has a pure-Wasm eval provider (QuickJS, linked module-to-module,
no JS host), so these four can run. pdfjs and gbemu stay excluded: they need
canvas/window stubs and are GPL-licensed.

## Harness (branch `claude/octane-eval-benches`)

- The manifest adds the four benches. Sources stay fetched and SHA256-pinned
  and are never committed. zlib declares d8's `read` as a prelude var: it is
  only referenced, never called.
- A bench with `runtimeEval: true` keeps the `js2wasm:runtime-eval` imports
  on the standalone lane. The worker links the provider (QuickJS by default)
  the same way test262's standalone lane does. Any other import is still a
  host leak. The 9 existing benches keep `runtimeEvalProvider: false`.

## Status per bench

| bench | node | standalone | blocker |
| --- | --- | --- | --- |
| code-load | pass | **pass** (score 146 vs node 8033, run 2026-10-14) | fixed here (below) |
| zlib | pass-unvalidated | **pass-unvalidated** (score 517 vs node 73496, run 2026-10-14 at load avg 10) | fixed here (below) |
| typescript | pass | compile-error | module-init chunk local leak + `process.*` host-import leaks (separate PR) |
| mandreel | pass-unvalidated | compile-error | duplicate global function declarations rejected (separate PR) |

## code-load fixes

1. **`new F()` on a compiled function from inside evaluated code.**
   `qjs_shim.c` refused construction (`qjs_mb_exotic_call`), and the wrapper
   lacked QuickJS's constructor bit. The callable wrapper is now
   constructible. A construct request reaches the adapter as the reserved
   receiver handle `QJS_CONSTRUCT_RECEIVER` (1). The adapter's
   `__membrane_call` then performs §10.2.2 [[Construct]]:
   OrdinaryCreateFromConstructor as a COMPILED object (so the compiled
   body's `this.x = …` writes land where compiled code and the outbound
   membrane see them), [[Call]] with that receiver, and the step-13 result
   rule.
2. **Property reads on compiled objects now run in the owning module (the
   #4307 residual 1, `bag.m`).** The compiled module publishes a
   non-enumerable *membrane hook* on its global object: a canonical
   AOT-callable carrier (`RUNTIME_EVAL_MEMBRANE_HOOK_PROPERTY`). The adapter
   captures it at every provider entry. `__membrane_get` (and the construct
   path's `prototype` read) rebinds the hook's trampolines onto the target
   via the new provider-side intrinsic `__runtime_eval_rebind_carrier`. The
   read therefore goes through the owner's `__extern_get` and the carrier
   property trampoline, which also wraps closure-valued results as callable
   carriers. Before this change, a method stored on a compiled object crossed
   as a non-callable wrapper ("not a function"), and a compiled closure
   called with provider-boxed arguments read `NaN`.

## zlib fix

zlib's Emscripten module is one big `eval`. It leaves its heap
(`ArrayBuffer` plus typed-array views) and ~400 functions as global bindings.
Every global QuickJS object crossing out became a #4245 slice-2 **mirrored
box** that copied all own string keys, and the box was re-synced at every
crossing. For a typed array that means every element. Measured: a 4 MiB
`Int8Array` global took **104 s** to cross. zlib's setup took 27 s against
36 ms on native QuickJS, and one run took 39 s against ~14 s native.

Binary data (`ArrayBuffer`, typed arrays, `DataView`) now crosses out as an
identity-preserving **unmirrored** box. The new realm helper
`__js2wasm_eval_isbinary__` identifies it. After the fix the 4 MiB case
takes 88 ms, zlib setup 1 s, and one run ~16 s (2026-10-14, contended box).
Residual: compiled code cannot read the elements of an eval-created typed
array. The box only round-trips it.

3. **Owner-routed reads on a non-callable target skip the closure bag.**
   The carrier property trampoline read the carrier's closure-own bag first.
   For a carrier rebound onto a plain compiled object that bag is empty and
   falls back to `%Function.prototype%`, so `'' + obj` inside evaluated code
   called `Function.prototype.toString` on a non-function and threw. That was
   the ES5 ratchet breach that parked the first merge-group run (test262
   `built-ins/Function/S15.3.2.1_A2_T6.js`, run 38661141645). The trampoline now
   reads the target directly when the target is not callable.

## Residuals

- A compiled function's `prototype` does not cross the carrier's property
  trampoline (`Mock.prototype` reads `undefined` from evaluated code). The
  constructed receiver therefore inherits from `%Object.prototype%` instead
  of `F.prototype`. code-load does not depend on it.
- A carrier is minted per read, so `o.m === o.m` reads false inside evaluated
  code.
- A constant-string `eval("new M(); 1")` that the compiler inlines at compile
  time throws `M is not a constructor`. This is a separate path from the
  QuickJS membrane.
- `var e; function f(){ e = eval; return e("…"); }`: assigning `eval` and
  calling it in the same function throws. A setup function assigning it and a
  later call using it (code-load's pattern) works.

## Compiler crash found on the way (zlib ahead-of-time probe)

`temporalKindForExpression` (src/codegen/temporal-native.ts) followed variable
initializers without a cycle guard. Mutually referencing declarations
(`var a = b, b = a;`, which Emscripten output contains) therefore overflowed
the stack on the next member access. It now carries a visited set.
Regression: `tests/issue-6989-temporal-kind-init-cycle.test.ts`.

## Tests

`tests/quickjs-eval-membrane.test.ts` gains a "[[Construct]] of a compiled
function" lane (7 cases: own field, own method with `this`, object-literal
construction, arguments, step-13 object result, a plain object's closure
property, compiled-side readback).
