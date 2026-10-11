---
id: 6873
title: "Dynamic `actual instanceof expected` answers false when `expected` is a compiled class VALUE — axios AxiosError/settle/validator `toBeInstanceOf` ×4"
status: ready
sprint: current
created: 2026-10-05
updated: 2026-10-05
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
---

## Problem

Measured 2026-10-05 on `upstream/main` `42d289a96f` while closing
[#6417](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6417-axios-residual-round-2).
`instanceof` with a STATIC class on the right is correct; the same check with
the class held in an `any` value is always false:

```js
// mod.js (untyped)
export class Plain { constructor(v) { this.v = v; } }
export class ErrSub extends Error { constructor(m) { super(m); this.code = "C"; } }
```

```ts
// entry.ts
import { Plain, ErrSub } from "./mod.js";
function dyn(actual: any, expected: any) { return String(actual instanceof expected); }
dyn(new Plain(1), Plain);     // "false" — node: true
dyn(new ErrSub("m"), ErrSub); // "false" — node: true
dyn(new ErrSub("m"), Error);  // "true"  (built-in RHS works)
new ErrSub("m") instanceof ErrSub; // true (static RHS works)
```

The upstream harness's `toBeInstanceOf(expected)` is exactly `dyn`, so every
`expect(err).toBeInstanceOf(AxiosError)` fails: AxiosError "returns an
AxiosError instance", settle "assigns ERR_BAD_REQUEST for a 400 status",
validator ×2 (4 axios tests).

The dynamic path lowers to `env::__instanceof_dyn(v, ctor)`
(`compileInstanceOf`, `src/codegen/typeof-delete.ts`). The runtime wraps the
class object into its host class mirror (`_maybeWrapCallableUnknownArity` →
`_wrapForHost`) and answers `fnctorOrNative(v, mirror, …)`; `v` is the raw
WasmGC instance, whose host prototype chain never reaches the mirror's
`.prototype`.

## Implementation Plan

1. In `__instanceof_dyn` (`src/runtime.ts`, the `__promise_subclass_instanceof`
   twin), when `ctor` is a compiled class object (`_classCtorClosures.has`) and
   `v` is a WasmGC struct, answer OrdinaryHasInstance against the compiled
   class identity instead of the host chain: walk
   `compiledClassInstancePrototype(v, exports)` (#5347) and compare with the
   mirror's `prototype` (the #5354 mirror identity guarantees `===`). Put the
   walk in `src/runtime/` (runtime.ts is at its ceiling); the call site is one
   line.
2. Keep the host-chain answer for every other operand pair — built-in RHS,
   host instances, fnctor instances (`_fnctorInstanceofResult`).
3. Regression test: untyped two-file fixture, the four `dyn` rows above plus
   negative controls (`dyn(new Plain(1), ErrSub)` false, `dyn({}, Plain)`
   false, `dyn(subInstance, Base)` true through `extends`).
4. A/B the dogfood suites (axios, prettier, redux, hono, jest) and the scoped
   standalone `language/expressions/instanceof` slice.

## Acceptance criteria

- axios +4 (AxiosError ×1, settle ×1, validator ×2) with no other suite dropping.
- Negative controls stay false.
