---
id: 6948
title: "Standalone: a fnctor whose `new` sites classify `keep-typed` in the escape gate is not approved, so its prototype methods are never compiled — yet its instances still reach an untyped `x.method()` call (Octane richards `packet.addTo`)"
status: ready
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: objects, compiler-internals
goal: core-semantics
related: [874, 6938, 4261]
---

# #6948 — escape gate: `keep-typed` fnctor loses its prototype methods on standalone

## Problem

Split out of #6938 (PR
https://github.com/loopdive/js2/pull/6623). With #6938 applied, Octane
richards passes on the host (gc) target, but on `--target standalone` it still
fails:

```
TypeError: called value is not a function
  at HandlerTask.prototype.run → packet.addTo(this.v2)
```

Pre-existing: it fails identically on base, independent of #6938.

## Minimal reproduction

```js
function Packet(id) { this.id = id; }
Packet.prototype.get = function () { return this.id; };
function Holder() { this.q = null; }
/** @param {Packet} q */
Holder.prototype.put = function (q) { this.q = q; };
Holder.prototype.use = function () { var p = this.q; return call(p); };
function call(x) { return x.get(); }
export function main() { var h = new Holder(); h.put(new Packet(7)); return h.use(); }
```

Expected `7` (node). Standalone: "called value is not a function".

## Diagnosis so far (from the #6938 implementer)

- A JSDoc `@param {Packet}` consumer makes every `new Packet` site classify
  `keep-typed` in the fnctor escape gate (`src/codegen/fnctor-escape-gate.ts`).
- So `Packet` is not approved for a native `__fnctor_Packet` struct, and its
  `Packet.prototype.*` methods are not compiled for the dynamic path either.
- The instance still flows through `this.q` into an untyped parameter `x`, and
  `x.get()` dispatches dynamically, finds no callable, and throws.

The gate's two outcomes disagree: one side assumes the typed path owns the
methods, the other assumes the dynamic path does. Neither compiles them.

## Acceptance criteria

1. The reproduction returns `7` on gc and standalone.
2. Octane richards (`pnpm run bench:octane -- --only richards`, harness from
   #874 / PR #6618) passes on standalone.
3. Regression test under `tests/issue-6948*.test.ts` covering both targets,
   plus a negative control without the JSDoc annotation.
4. No pass→fail in the fnctor / escape-gate related tests (`grep -l
   "fnctor\|escape" tests/*.test.ts`) and the equivalence gate stays green.

## Notes

- Escape-gate soundness, #4261 family. The gate is in Session A's WasmGC
  scope (see https://github.com/loopdive/js2/pull/6583); implementation needs
  A's release of the exact functions before C dispatches it.
