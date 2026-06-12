---
id: 2015
title: "method call using `this` on an any-typed object-literal receiver throws bare WebAssembly.Exception (__extern_method_call this-routing)"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
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
