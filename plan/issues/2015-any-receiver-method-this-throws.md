---
id: 2015
title: "method call using `this` on an any-typed object-literal receiver throws bare WebAssembly.Exception (__extern_method_call this-routing)"
status: done
sprint: 62
created: 2026-06-10
updated: 2026-06-14
completed: 2026-06-14
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: host-interop
language_feature: objects
goal: core-semantics
related: [1971]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2015 — this.<field> inside method invoked via extern dispatch traps

## Problem

```ts
const o: any = { x: 21, getx() { return this.x; } };
o.getx()
// wasm: throws bare WebAssembly.Exception (no message)   node: 21
```

The same literal with a *typed* receiver (`const o = {...}`) works.

## Root cause

`src/codegen/expressions/calls.ts:7512` — any/externref receivers dispatch
through `__extern_method_call(obj, name, args)`; the runtime method
wrapper (`src/runtime.ts:~6815`) invokes the compiled method with the
wrapped mirror receiver, and the method body's `this.<field>` path throws
inside wasm (mirror is not the struct the body expects). Exact inner
mechanism needs follow-up triage during fix.

## Fix direction

Pass the original struct ref (not the host mirror) as `this` when the
method is a compiled wasm function; reserve the mirror for genuine host
objects.

## Acceptance criteria

- Repro returns 21; typed-receiver calls unchanged
- Error, if any path remains unsupported, must be a catchable TypeError

## Dupe check

#1017/#1022/#1038 older done-era; #1971's method finding is null class
receivers. New.

## Suspended Work (2026-06-13, dev-c) — CORRECTED root cause

- **Worktree**: `/workspace/.claude/worktrees/issue-2015-any-receiver-this`
  (branch `issue-2015-any-receiver-this`, NO code committed — analysis only;
  one wrong-path runtime attempt was reverted).

### The issue's cited root cause is WRONG — this is NOT an `__extern_method_call` bug
WAT-traced `o.getx()` on the repro (`const o: any = { x: 21, getx() { return
this.x; } }; o.getx()`): the compiled `$test` uses **`__call_fn_0` + `call_ref`
+ a `getx_`-named function** and does **NOT** emit `__extern_method_call` /
`__proto_method_call` / `__extern_get` at all. So despite the `any` annotation,
the compiler statically resolves the object-literal's shape and calls the
`getx` closure **directly** — it just fails to thread the receiver struct as the
method's `this`. The runtime `__extern_method_call` / `_wrapForHost` path
(cited at calls.ts:7512 / runtime.ts:~6815) is never reached.

A runtime fix attempt (unwrap the host-proxy `this` via `_hostProxyReverse` in
`_wrapWasmClosureUnknownArity`'s `__call_fn_method_N` bridge, runtime.ts:~1812)
had **no effect** — confirming the dispatch doesn't go through that bridge.

### Where the real fix is
`src/codegen/expressions/calls.ts` — the **static closure-call path** for a
method access on an any/externref receiver (the `__call_fn_0`/`call_ref` arm,
near the closure-call helpers at ~1345-1360 and the method-call resolution that
picks `closureInfoByTypeIdx`/`closureMap`). When the callee is an object-literal
**method** closure (not a free function), the receiver struct must be threaded
as `this` — either as the method's `__self`/first param, or via the
`__current_this` global (the mechanism class methods already use; grep
`__current_this`, set #1636-S1). Today the closure is called with only its
captured args, so `this.<field>` (a `struct.get` on a null/absent `this`) traps.

### Resume steps
1. In calls.ts, find the arm that compiles `recv.method()` where `recv` is
   any/externref and `method` resolves to an object-literal closure field
   (produces `__call_fn_0`/`call_ref`). Confirm via WAT that the repro hits it.
2. Compare with the CLASS method path (typed receiver works — `o.getx()` on a
   non-`any` receiver returns 21) to see how `this` is threaded there
   (`emitClosureCall*`, the `__current_this` set, or a self param), and mirror it.
3. Thread the receiver struct as `this` for the object-literal-method closure
   call. Guard: free-function closure calls (no receiver) must stay unchanged;
   the no-`this` method control (`{ getx() { return 5; } }`) already works.
4. Equivalence test: any-receiver method using `this.x` → 21; typed-receiver
   unchanged; no-`this` method unchanged; method mutating `this.x` then reading;
   nested `this` in a method calling another method.

### Repro (verified on main)
`const o: any = { x: 21, getx() { return this.x; } }; o.getx()` → wasm throws
bare WebAssembly.Exception; node 21. Typed receiver (`const o = {...}`) → 21.
no-`this` method (`{ getx() { return 5; } }`) → 5 (works).

### Why suspended
`reasoning_effort: high`; the issue's diagnosis was wrong (runtime vs codegen),
so the real fix is a codegen this-threading change with regression risk across
the closure-call paths. Warrants a focused pass / senior-dev with the corrected
analysis above rather than a rushed change at session tail.

## Resolution (2026-06-14, sdev) — FINAL root cause + fix

Both the issue's original diagnosis (`__extern_method_call` this-routing) AND
dev-c's corrected diagnosis (static `__call_fn_0`/`call_ref`, never reaching the
runtime) were inaccurate against current main (76 commits had landed since the
suspension). WAT-tracing the repro on the merged HEAD showed `o.getx()` DOES
route through the JS host — but the real mechanism is a THREE-layer this-loss:

1. **Runtime — `_wrapForHost` proxy `get` trap, generic `closureBridge`
   fallback** (`src/runtime.ts` ~4250). Reading the `getx` closure field off
   the host-mirror proxy returned a bridge that invoked the closure via the
   PLAIN `__call_fn_N` dispatcher (`callFn0(val)`), discarding `this` entirely.
   `__call_fn_N` never installs `__current_this`, so the receiver was lost
   before the method body ran. (The `_wrapWasmClosureUnknownArity` dynamic
   bridge had the same gap — it installed `this` but without unwrapping the
   host-mirror proxy to the raw struct.)
2. **Codegen — object-method trampoline** (`src/codegen/closures.ts`,
   `emitObjectMethodAsClosure` / `emitCachedMethodClosureAccess` /
   `finalizeMethodTrampolines`). The trampoline that bridges the closure ABI
   `(closure_self, …args)` to the method ABI `(this_struct, …args)` HARDCODED
   `ref.null <objStruct>` for the method's `this` slot. So even once
   `__current_this` was installed, the method body (which reads `this` from its
   struct param, not the global) got null → `this.<field>` = `struct.get` on
   null → bare `WebAssembly.Exception`.

### Fix (two files)
- **`src/runtime.ts`**: the generic `closureBridge` fallback and the
  `_wrapWasmClosureUnknownArity` dynamic bridge now dispatch through
  `__call_fn_method_N` (unwrapping the `_wrapForHost` proxy to the raw struct
  via `_unwrapForHost`, gated on `_isWasmStruct`) when invoked with a real
  receiver. A bare/undefined/globalThis `this` (extraction call `const f = o.m;
  f()`) keeps the plain `__call_fn_N` path, preserving spec-mandated unbound-
  `this` semantics unchanged.
- **`src/codegen/closures.ts`**: new `buildTrampolineThisSlot` helper — the
  object-method trampoline reads `__current_this`, `ref.test`s it as the object
  struct, casts and uses it as `this` when it matches, else falls back to
  `ref.null` (so plain `__call_fn_N` dispatch still yields unbound `this`).
  Mirrors the null-guarded `__current_this` read lifted closure bodies already
  use for `ThisKeyword` (#1702). Applied to BOTH the per-call-site
  (`emitObjectMethodAsClosure`) and the cached class/proto
  (`emitCachedMethodClosureAccess`) trampolines, plus the `finalizeMethodTrampolines`
  rebuild — the rebuild replaces (not appends) the func's locals so the
  pre-seeded `__this_any` anyref scratch stays in lockstep with the rebuilt
  body's local indices.

### Verification
- Repro `o.getx()` → 21; typed receiver → 21; no-`this` method → 5.
- New `tests/issue-2015.test.ts` (7 cases): 0/1/2-arg this-threading, `this.x`
  mutation across calls, nested method-to-method `this`. All pass.
- Regression sweep: `issue-1636s1-this-regression`, `issue-1636-s1-tojson-this`,
  `issue-1702-strict-this`, `issue-1742-this-receiver-guard`,
  `issue-1712-capture-closure-dispatch`, `issue-1669-trampoline-externref-coercion`
  all green (25 tests). Full `tests/equivalence/` sweep run; every failure that
  surfaced was confirmed PRE-EXISTING on `origin/main` (verified by swapping the
  original `closures.ts`/`runtime.ts` back in — identical per-file counts). The
  stale `*-calls`/`externref` unit tests that instantiate with `{env:{}}` fail on
  main too (they predate the lazy-importObject ABI), not caused by this change.
