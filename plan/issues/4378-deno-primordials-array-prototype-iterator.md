---
id: 4378
title: "Deno primordials cannot capture the array-iterator prototype from Array.prototype"
status: done
created: 2026-08-12
updated: 2026-08-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, standalone, deno
language_feature: array-iterator, builtin-prototypes
goal: deno-runtime
sprint: 78
es_edition: ES2015
assignee: ttraenkler/codex-v8x-js2wasm
related: [1320, 2193, 3013, 4376]
origin: "First unchanged-source failure while compiling Deno core 00_primordials.js"
files:
  - src/codegen/array-methods.ts
  - tests/issue-4378-array-prototype-iterator-bootstrap.test.ts
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/expressions/call-namespace-static.ts
---
# #4378 — Deno primordials cannot iterate the pristine `Array.prototype`

## Defect

Deno core's unchanged `00_primordials.js` captures the intrinsic array-iterator
prototype during bootstrap:

```js
Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]())
```

In ECMAScript, `Array.prototype` is itself an initially empty Array exotic
object. js2wasm's standalone target instead materializes a bare
`Array.prototype` value as a `$NativeProto` metadata object. The existing
host-free `Array.prototype.values` lowering consequently rejects the receiver:

```text
Codegen error: #1320 values() receiver is not an array
```

This is the first compiler defect exposed after the v8x/Deno compiler adapter
started including JavaScript sources with `allowJs`. Before that fix, the
side-effect import was silently omitted and a successful Wasm artifact did not
prove that the bootstrap had run.

## Scope

Lower the exact, unshadowed pristine-builtin expression through the native
empty-array iterator substrate. Do not change a shadowing user binding named
`Array`, add a JavaScript-host import, or claim general mutable
`Array.prototype` indexed-element support.

The broader Deno bootstrap remains owned by #4376. Promise/microtask support
and later intrinsic iterator families are separate executed boundaries.

## Acceptance

- [x] `Reflect.getPrototypeOf(Array.prototype[Symbol.iterator]())` compiles in
      standalone mode without an `env` import.
- [x] Its result is genuinely identical to the prototype of a normal array
      iterator, with the array prototype as a non-vacuous negative control.
- [x] A user binding that shadows `Array` keeps normal receiver semantics.
- [x] The unchanged Deno `00_primordials.js` advances past this expression and
      reports the next honest compiler/runtime boundary.
