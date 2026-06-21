---
id: 2571
title: "standalone: class/object-literal method generators leak env.__gen_* host imports — no native lowering (validate-but-can't-instantiate)"
status: ready
sprint: Backlog
created: 2026-06-21
updated: 2026-06-21
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: generators, classes, object-literals
goal: standalone-mode
related: [2040, 1665, 2170, 2171, 2203, 680]
test262_bucket: standalone-method-generator-hostimport-leak
test262_count: 250
es_edition: es2015
origin: "Carved from #2040 (sd-5 reproduction, 2026-06-21). Distinct from #2040's cluster-A rest-identity codegen bug (sd-3): this is a separate instantiation bug — class/object-literal METHOD generators have no native lowering, so in a no-JS-host target they emit env.__gen_* imports that validate but cannot be satisfied at instantiate time. Affects ~250/500 generator/class files sampled."
---

# #2571 — standalone native method generators (no host-import buffer path)

## Problem

In a no-JS-host target (`target: "standalone"` / `wasi`), a **class or
object-literal generator method** compiles to a module that **validates** but
**cannot instantiate**:

```ts
class C { *m() { yield 42; } }
export function run(): number { return new C().m().next().value === 42 ? 1 : 0; }
```

```
WebAssembly.instantiate(): Import #0 "env": module is not an object or function
```

The module imports `env.__gen_create_buffer`, `env.__create_generator`,
`env.__gen_next`, `env.__gen_result_value_f64`, `env.__get_caught_exception`
— the legacy **eager-buffer** generator runtime, which has no standalone
(pure-Wasm) backing.

A free-function generator (`function* g(){ yield 42 }`) does NOT leak — it is
lowered by the **native generator state machine** (#1665/#2170/#2171, in
`src/codegen/generators-native.ts`), which emits zero imports.

This is **distinct from** #2040's cluster-A rest-array-identity bug (the
untyped/externref method-param rest path aliasing the source vec, owned by
sd-3). That one is a value-correctness codegen bug; this one is an
instantiation-time host-import leak. Both surface on `gen-meth-*` files, but
the fixes live in different code (rest-identity → `destructuring-params.ts`;
this → `generators-native.ts` candidate gate + `class-bodies.ts` emit).

## Measured impact

Leak probe over 500 `language/{statements,expressions}/{generators,class}`
files compiled with `target: "standalone"`: **~250 (≈50%) import `env.__gen_*`**
and therefore cannot instantiate standalone. All are `gen-meth-*` (class /
method generators). Estimate ~250+ test262 rows are pass-on-host but
unrunnable-on-standalone purely from this leak.

## Root cause

- `sourceNeedsGeneratorHostImports()` (`src/codegen/generators-native.ts:911`)
  routes **every** `MethodDeclaration` with an asterisk to the host-import
  buffer path unconditionally (`needsHost = true`).
- `isNativeGeneratorCandidate()` (`:795`) only accepts `ts.FunctionDeclaration`
  (requires `decl.name`), and has **no `this` / receiver handling** — class
  method generators (instance vs static, with `this`, possibly capturing the
  class lexical scope) are out of its model.
- The class-method generator emit in `src/codegen/class-bodies.ts:2025-2080`
  unconditionally calls `__gen_create_buffer` / `__create_generator`
  (`ctx.funcMap.get("__gen_create_buffer")!`) regardless of target.

## Why this is hard (not a point fix)

1. **Receiver/`this`** — the native state struct (`generators-native.ts`) has
   no slot for `this` or for captured class-scope bindings. The same gap that
   makes capturing *nested* generators fall to the host path (#2203) applies to
   method generators, which always have an implicit `this` capture.
2. **Static vs instance** — instance methods carry a `this` param at index 0
   (see `class-bodies.ts` `isStatic` handling); static methods don't.
3. **Laziness** — the buffer model is **eager** (runs the whole body at
   creation, buffers all yields). A mere "buffer into a WasmGC vec instead of a
   host JS array" port would fix *instantiation* but still fail the spec
   laziness rows (`assert.sameValue(executed, false)` until first `.next()`) —
   roughly the cluster-B "~140 must-be-lazy" rows #2040 flagged. The correct
   fix is the **lazy native state machine** extended to a method receiver, not a
   vec-buffer.

## Suggested approach (architect, then senior-dev)

1. Extend `buildNativeGeneratorPlan` / the native state struct to carry a
   `this` field (and any captured class-scope bindings — reuse / generalize the
   #2203 capture model).
2. Make `isNativeGeneratorCandidate` accept `ts.MethodDeclaration` (asterisk,
   non-async), modelling the receiver param (instance: param 0 = `this`;
   static: none).
3. Route `class-bodies.ts:2025` method-generator emit through
   `compileNativeGeneratorFunction` when `noJsHostTarget(ctx) && candidate`,
   keeping the host-buffer path only for the JS-host target.
4. Update `sourceNeedsGeneratorHostImports` to NOT force `needsHost` for a
   method generator that the (extended) native path can handle.

## Acceptance criteria

- `class C { *m(){ yield 42 } }` + `new C().m().next().value` compiles to a
  standalone module with **zero `env.__gen_*` imports** and instantiates +
  runs correctly (`WebAssembly.validate` true, `run()` === 42-derived).
- Object-literal method generator `({ *m(){ yield 42 } })` same.
- Static method generator `class C { static *m(){…} }` same.
- Lazy: a method-generator body does not run until the first `.next()`
  (`executed === false` before first next).
- The standalone `env.__gen_*` leak count over the gen-method test262 subset
  drops to ~0; host mode unchanged (no regression).
- No new host imports introduced for the standalone path.
