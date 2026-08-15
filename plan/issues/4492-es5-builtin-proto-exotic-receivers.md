---
id: 4492
title: "ES5 standalone: builtin-prototype methods on exotic/boxed/dynamic receivers (~103 tests across Array/String/Function.prototype)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es5
goal: standalone-mode
related: [4444, 2175, 4161, 1461]
---

# #4492 — ES5 builtin-proto methods on exotic receivers

## Problem (measured 2026-08-15, `.tmp/es5-standalone-clusters.ts`, fresh baseline)

Three sibling ES5 clusters share a receiver-shape root: `built-ins/Array/
prototype` (36) + `built-ins/String/prototype` (35) + `built-ins/Function/
prototype` (32) ≈ **103 tests**. Sample symptoms:

- Function.prototype.{call,apply,bind} this-binding on dyn receivers:
  `this["feat"] expected "kamon beyba", got undefined`, `obj.touched`
  families, `cannot read property 'length' of null` (bind on extracted fn).
- String methods on BOXED receivers (`new Boolean()`, `new Number()`)
  borrowed via `__instance.substring = String.prototype.substring` —
  answers `[object Object]` instead of coercing the receiver.
- Array generic methods: missing TypeErrors on frozen/sealed targets,
  `new Array()`-subclass-ish length coupling (`newArr.length` mismatches).
- Sputnik-era legacy shapes (`eval("1")` args, Math-as-receiver toString).

## Implementation Plan (fable, 2026-08-15) — triage-first

1. **Sub-bucket by RECEIVER SHAPE, not by method** (mandatory table here):
   (a) `.call/.apply` with dyn/`any` receivers, (b) borrowed methods assigned
   onto boxed primitives (the #2161-B1 wrapper-slot probe precedent —
   `new String(x)` receiver handling in coerceType's externref→AnyString arm
   was specced there; check whether it landed and extend the same pattern to
   `new Boolean`/`new Number` receivers), (c) generic Array methods on
   array-likes (post-#1461 residue), (d) TypeError-on-immutable-target
   enforcement, (e) legacy/eval-arg shapes (may route to runtime-eval lane).
2. Coordinate with the #2175 reflection lane (in-flight): the value-erased
   method-closure path is ITS substrate; this issue owns the RECEIVER
   COERCION inside those closures, not closure resolution itself. Skip any
   test whose failure is "method not resolved" — route those to #2175.
3. Largest bounded sub-bucket first; unit tests per fix; A/B baselines; zero
   pass→non-pass on all three scoped filters.

## Validation

`TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Array/prototype|built-ins/String/prototype|built-ins/Function/prototype" pnpm run test:262`
— baseline ~103 non-pass in the ES5 bucket (the filter also runs ES6+ files;
diff per-file against the fresh baseline, not by count). gc-lane control.
