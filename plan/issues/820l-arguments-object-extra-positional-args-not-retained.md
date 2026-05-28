---
id: 820l
title: "arguments object: extra positional args beyond formals not retained (~61 fails)"
status: blocked
created: 2026-05-27
updated: 2026-05-28
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: arguments-object, host-callback
goal: spec-completeness
sprint: 56
parent: 820
related: [1053, 849, 779e, 1528a, 1632a]
blocked_on: [1528a]
---
# #820l — arguments object: extra positional args beyond formals not retained

## Problem

ECMAScript §10.4.4.6 / §10.4.4.7 (CreateMappedArgumentsObject / CreateUnmappedArgumentsObject):
`arguments.length` must equal the *actually-passed* argument count, and
`arguments[i]` must be set for **every** passed positional, even `i >=` the
declared formal-parameter count.

~61 test262 fails on this. Repro:

```ts
[10, 20, 30].forEach(function (v) {
  arguments.length;     // observed: 1 — expected: 3
  arguments[1];         // observed: undefined — expected: index (1, 2, ...)
});
```

`v` is the only declared formal, but `forEach` invokes the callback with
`(value, index, array)` — three positional args. We see `arguments.length === 1`.

### Sub-shapes (sample only — full bucket is `~61`)

| Sub-shape | Approx fails | Notes |
|---|---|---|
| Array.prototype.* callbacks (`forEach`/`map`/`filter`/`reduce`/`some`/`every`/…) | ~41 | host calls callback with 3-4 args; we declare ≤ N formals |
| `params-dflt-ref-arguments` family | ~14 | param defaults reference `arguments` before extras populate |
| Function.prototype.bind body | ~8 | overlaps #1632a / PR #796 |

## Root cause

The compiled `arguments`-object machinery is already correct on the
receive side (`emitArgumentsVecBody` in
`src/codegen/statements/nested-declarations.ts:1035`):

1. Read `__argc` global → fall back to formal count `numArgs` if `-1`.
2. Read `__extras_argv` global → fall back to empty vec.
3. `totalLen = argc + extrasLen`.
4. Fill formal slots `arr[0..numArgs)` from locals (guarded by `i < argc`).
5. `array.copy` extras into `arr[numArgs..totalLen)`.
6. Build vec struct `{length: totalLen, data: arr}`.

`emitSetExtrasArgv` (at compiled call sites) correctly populates `__argc`
and `__extras_argv` when the **compiler** is the caller (8 call sites in
`src/codegen/expressions/calls.ts`).

**The gap is the host-callback path.** When the host (V8 Array.prototype
implementations, native `Reflect.apply`, etc.) calls a Wasm closure via the
`__call_fn_<arity>` dispatcher, two layers conspire to drop the extras:

### Layer 1 — `_wrapWasmClosure` in `src/runtime.ts:946-967`

```js
return function wasmClosureBridge(...args: any[]): any {
  const padded: any[] = [];
  for (let i = 0; i < arity; i++) padded.push(args[i]);   // → pads to arity
  return callFn(closure, ...padded);
};
```

This is fine: the bridge pads/truncates to the dispatcher arity
(`_PROTO_CB_SLOTS.forEach.arity === 3` etc.), which is the JS call-arity,
not the closure's declared formal count.

### Layer 2 — `emitClosureCallExportN` in `src/codegen/index.ts:2232`

The dispatcher emits one arm per distinct closure func-type. For each
arm, it pushes `self + user args 0..closureArity-1` and drops the rest:

```ts
for (let i = 0; i < entry.closureArity; i++) {            // ← drops args ≥ closureArity
  argInstrs.push(...buildArgConversion(i + 1, paramType));
}
```

After this, `__argc` is still `-1` and `__extras_argv` is still `null` in
the callee — so the closure body's `emitArgumentsVecBody` falls back to
`numArgs = closureArity` and an empty extras vec. `arguments.length` ends
up as `closureArity` (= 1 for our `forEach((v) => …)` repro), not the
3 the host actually passed.

### Why this is exactly the spec-broken shape #820l describes

`_PROTO_CB_SLOTS` already encodes the JS call-arity per method
(`forEach: 3`, `reduce: 4`, `sort: 2`, …). The dispatcher receives all
3/4 externref user args — they are *available* as locals 1..arity but
simply not propagated to the wasm globals before `call_ref`.

## Fix

In `emitClosureCallExportN` (`src/codegen/index.ts`), before each arm's
`call_ref`, populate the wasm globals so the closure body's
`emitArgumentsVecBody` sees the right `__argc` and `__extras_argv`:

1. `global.set $__argc = i32.const arity` — the **actual** call-site arg
   count (always `arity`, since the host always passes `arity` user args).
2. If `closureArity < arity`: build an externref array of args
   `[closureArity..arity)`, wrap in the externref vec struct, and store in
   `global.set $__extras_argv`.
3. If `closureArity >= arity`: leave `__extras_argv = ref.null`.

This guarantees:
- `arguments.length === arity` for callbacks that read `arguments` (#820l
  observable).
- `arguments[i]` for `i >= closureArity` holds the host-supplied value.
- No behaviour change for closures that don't read `arguments` — the
  globals are consumed-and-cleared on entry to the body (see lines
  1072-1074, 1080-1081 of `nested-declarations.ts`), so unused values just
  fall through harmlessly.

### Touch points

- `src/codegen/index.ts` — `emitClosureCallExportN` (~30 LOC: emit
  `__argc = arity` always, and conditionally build the extras vec from
  args[closureArity..arity)).
- No changes to `src/runtime.ts` (`_wrapWasmClosure` stays as-is).
- No changes to `emitArgumentsVecBody` — receive-side already handles
  both globals.

### Edge cases

- **Closures that don't read `arguments`** — the body still consumes-and-
  clears the globals (current behaviour); writing them in the dispatcher
  is wasted work but harmless. Optimisation: skip if no closure with
  `closureArity ≤ arity` references `arguments`; tracked but not blocked
  on for the first fix.
- **`f64` / `i32` param types** — `buildArgConversion` already unboxes
  formal-slot args; extras stay as externref (boxed) in `__extras_argv`,
  matching the existing `emitArgumentsVecBody` shape.
- **`__call_fn_0` / `__call_fn_1` / `__call_fn_2`** — these dispatchers
  exist as separate emit functions in `index.ts` (lines 1973, 2167, 2185
  share via the generic helper). Need to confirm the same fix applies to
  all of them, not just `__call_fn_<N≥3>`.

## Acceptance criteria

1. `[1,2,3].forEach(function(v){ return arguments.length; })` — sees `3`.
2. `arguments[2]` inside `[10,20,30].forEach(function(v){…})` resolves to
   `arr` (the third positional from host invocation).
3. `params-dflt-ref-arguments` test262 sample passes (param default
   references `arguments` and sees `arguments.length === actual` count).
4. No regression on closures that don't read `arguments` (dispatcher path
   for plain `.forEach(v => v * 2)` continues to pass).
5. ~50+ of the ~61 sub-bucket fails flip to pass (Function.prototype.bind
   sub-shape ~8 may need #1632a / PR #796 to land in parallel).

## Out of scope

- Mapped-arguments writes via `arguments[i] = v` reflecting back into
  declared param locals — already covered for declared formals by #849;
  extras (i ≥ closureArity) are unmapped per spec, no sync needed.
- Function.prototype.bind body — partial overlap with #1632a (PR #796)
  which builds bound-function repr. The 8-fail sub-shape may need both
  to land.

## Coordination

- **Wait for PR #794 (#1528a) to stabilise** before pushing this — both
  PRs touch `arguments` plumbing (`__argc` / `__extras_argv` global
  shapes). The receive-side in `nested-declarations.ts:1035` is the
  shared surface; this PR only modifies the dispatcher side
  (`index.ts:2232`), so once #794 lands the diff applies cleanly.

## Investigation 2026-05-28 (dev, task #193) — BLOCKED on #794 + needs deeper trace

Reproduced the bug locally:
```ts
[10,20,30].forEach(function (v) {
  return arguments.length;   // returned 1, expected 3
});
```

Implemented the dispatcher-side fix as drafted above (populate `__argc` and
`__extras_argv` at the start of each `callBody` arm in
`emitClosureCallExportN`, with a new `extrasArrLocal` to round-trip the
`array.new_fixed` result through a local for `struct.new` ordering). The
fix compiled cleanly and produced a valid module — but the repro still
returned `lenSeen === 1`.

**Debug instrumented `_wrapWasmClosure`'s bridge** (`process.stderr.write`
before `callFn(closure, ...padded)`): NO bridge invocation was observed
for the `[10,20,30].forEach(function(v){…})` repro. Confirmed:

- `__call_fn_3` IS exported (verified via `WebAssembly.Module.exports`).
- Direct host-side `instance.exports.__call_fn_3(closure, a, b, c)` against
  an exported closure returns `null` (the dispatcher's no-match fallback)
  — closure isn't being matched by any entry's `ref.test`.
- The `forEach` code-gen routes through `__extern_method_call` (lazy
  late-import at `src/codegen/expressions/calls.ts:6928`).
  `__extern_method_call` in `src/runtime.ts:5074-5093` DOES consult
  `_PROTO_CB_SLOTS` and call `_maybeWrapCallable(callback, 3, …)`.
- `_maybeWrapCallable` (`src/runtime.ts:984`) early-returns `val` if
  `typeof val === "function"`. The probe `cb` was not a function (it's a
  Wasm closure struct), so the function-typeof check would NOT return
  early. But the bridge isn't entering. Possible alternative paths:
  closure callback may be passing through a different export wrapper
  (e.g. `wrapExports`-style fast path), or `_isWasmStruct(val)` returns
  false for this concrete closure shape, or the receiver-host coercion
  short-circuits with a sparse-fast-path.

**Open question**: where does the host actually invoke the forEach
callback? The native `Array.prototype.forEach` walks `for k in 0..len-1;
callback.call(thisArg, value, k, O)`. If `callback` arrives at the host
as `typeof === "object"` (a WasmGC struct), V8 would throw "callback is
not a function" — but our repro doesn't throw, it just returns the wrong
length. So `callback` IS arriving as a callable somewhere. The path
needs tracing — possibly via `looksMarshalable` → `makeCallableClosureWrapper`
in `wrapExports` (which uses `__call_fn_0` / `__call_fn_1` paths, NOT
`__call_fn_3`, and drops user args entirely per its own comment at
`src/runtime.ts:8270-8273`).

That last bit — `makeCallableClosureWrapper` falls back to `__call_fn_0`
for >1-arg calls, **dropping all user args** — looks like the actual
miss-route. The fix surface may be partly there (route through
`__call_fn_<actual-arity>` with extras plumbing) plus the dispatcher
populate-extras fix. Needs more investigation before the next attempt.

**Status**: BLOCKED. Three blockers stack:
1. PR #794 (#1528a) is ESCALATED with −822 net regression on arguments
   plumbing — must stabilise before any sibling arguments PR.
2. The forEach-style repro routes through a callable-wrapper path
   (`wrapExports.makeCallableClosureWrapper` is the likely suspect) that
   intentionally drops user args, NOT through the
   `__call_fn_<arity>`-with-bridge dispatcher this issue's fix targets.
   The dispatcher fix is necessary but not sufficient.
3. The two layers need a unified design: dispatcher-side populates
   `__argc`/`__extras_argv` AND the callable-wrapper path actually picks
   the right `__call_fn_N` for the JS-engine call-arity (not 0).

**Recommendation**: park `#820l` until PR #794 lands. Re-attempt with a
deeper trace of `makeCallableClosureWrapper` vs `_wrapWasmClosure` →
unified fix touches both `src/runtime.ts:8264` and
`src/codegen/index.ts:2232`.
