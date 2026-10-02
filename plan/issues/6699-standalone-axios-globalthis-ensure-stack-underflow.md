---
id: 6699
title: "standalone: axios `__native_globalThis_ensure` stack underflow — a void call's result is dropped (#2090)"
status: done
sprint: current
created: 2026-09-26
updated: 2026-09-27
completed: 2026-09-27
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [1032, 3015, 4638, 5383, 6698, 6714]
# 2026-09-27: +1 line — one named import (`knownStaticMethodRestInfo`) in the
# import block; the call-site logic lives in object-method-rest-abi.ts.
loc-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts
---

# #6699 — axios standalone-dynamic: `__native_globalThis_ensure` operand-stack underflow

## What you will see

With [#6698](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6698-standalone-extern-get-bucket-ladder-stack-overflow)
(the `__extern_get` ladder stack overflow) fixed, the npm-compat **axios**
standalone-dynamic lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only axios --no-write --perf-only --lane standalone-dynamic`,
measured 2026-09-26) stops at:

```
stack-balance (#2090): cannot supply a missing stack value in function "__native_globalThis_ensure" — operand stack underflow by 2 in an empty-typed block (body delta -2, expected 0); this is not a missing block result; site function body[2].if.then[210].if.then, physical body #0; first negative net prefix at instruction 282 (initial stack depth 0); window: [280] f64.const {"value":189} (delta 1, running 3); [281] call {"funcIdx":2097530} (delta -3, running 0); [282] drop (delta -1, running -1); [283] local.get {"index":6} (delta 1, running 0); [284] global.get {"index":1098} (delta 1, running 1). The repair pass refuses to invent a value here because doing so would mask a producing codegen bug as a silent null. This is a compiler defect at the value producer; report the failing input.
```

## First reading

The window shows a 3-argument `call` to a stable-handle function
(`funcIdx 2097530` = 2^21 + 378, a `mintDefinedFunc` handle, see
`src/codegen/func-space.ts`) whose last argument is `f64.const 189`, followed by
`drop` — the producer assumed the callee returns a value but its resolved
signature is void (net -3). The helper is the outlined realm-global seed from
`src/codegen/native-globalthis-outline.ts` (#5383 S2p), site
`body[2].if.then[210].if.then`. Start by naming the callee (map the handle back
through `func-space`) and the seed step that emits the `call … drop`.

## Implementation Plan

Executed 2026-09-27 on upstream/main `c2601efa89`.

1. **Re-measure first.** The lane no longer reports the #2090
   `__native_globalThis_ensure` underflow — compile now succeeds and the module
   fails at `wasm-opt` parse (`popping from empty stack`). The globalThis
   blocker is already fixed on main (the #5383 outline / #6170
   `reserveAnyToF64Handle` line of work); nothing further to do for it.
2. **New blocker A — `AxiosHeaders_delete`:** V8: `not enough arguments on the
   stack for call_ref (need 7, got 4)`. `header.forEach(deleteHeader)` where
   `deleteHeader` is a capture-carrying nested declaration. With a
   `Function`/`eval` site in the program the identifier read goes through the
   runtime-eval dynamic-global path and arrives as `externref`, so
   `setupArrayCallback` takes the standalone dynamic-callback recovery
   (`resolveDynamicCallbackClosure`, #3015/#4638). That keyed the funcref
   wrapper on the **lifted** signature from `getFuncSignature` —
   `[captures..., tdzFlags..., userParams...]` — instead of the value's
   signature, so the cast target and the `call_ref` type expected six params.
   Fix: new `closures/func-value-callable-signature.ts`
   (`funcValueCallableSignature`) derives the value ABI exactly as
   `emitFuncRefAsClosure` registers it (strip captures, TDZ flags, TS
   pseudo-`this`; bridge native-generator results); the recovery uses it.
3. **New blocker B — `__closure_336` (http.js):** V8: `call[0] expected type
   (ref null 93), found local.get of type (ref null 2)`. `AxiosHeaders` has both
   `concat(...targets)` and `static concat(first, ...targets)`; both registered
   `ctx.funcRestParams["AxiosHeaders_concat"]` (last-wins), so instance call
   sites packed arguments with the static member's `restIndex`. Fix:
   `classMemberRestParamKey` (class-member-keys.ts) — the colliding STATIC
   member registers/reads under its funcMap key (also its display name, which
   its own body prologue reads); the two static call sites
   (`call-namespace-static.ts`, `call-receiver-method.ts`) read through it via
   `knownStaticMethodRestInfo` (object-method-rest-abi.ts).
   Non-colliding members keep `fullName`. This is shared codegen: the JS-host
   lane emitted the same invalid module for the repro; it is valid after.

## Resolution

- Regression test `tests/issue-6699-axios-standalone-callable-abi.test.ts`:
  3/3 pass with the fix, 3/3 fail on the parent (anti-vacuity control).
- Scoped standalone test262 (370 rows: `language/rest-parameters`,
  `built-ins/Array/prototype/forEach`, class static/method rows in
  `language/statements/class{,/definition}`): parent 299 pass / 66 fail / 5 CE,
  fix 299 / 66 / 5, identical non-pass set — no losses.
- JS-host control: axios dogfood 208/231 on parent and with the fix
  (`--lane js-host`, same failing files).
- axios standalone-dynamic lane: before = `optimization-error` (invalid module,
  `AxiosHeaders_delete` call_ref arity); after = `optimization-error` at the
  next blocker, filed as
  [#6714](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6714-standalone-textencoder-encode-f64-vec-vs-uint8array):
  `__closure_392` `type error in fallthru[0] (expected (ref null 1010), got (ref null 4))`
  — standalone `TextEncoder.encode` returns an f64 vec where the declared
  `Uint8Array` result lowers to the packed-i8 vec.
- Residuals seen while reducing (not on the lane's path, not fixed here): a
  static/instance member pair still shares `funcOptionalParams` and
  `funcUsesArguments` by `fullName`; the reduced axios `concat` shape
  (`this.constructor.concat(this, ...targets)`) validates but traps
  `illegal cast` at run time in standalone.
