---
id: 779c
title: "String.prototype.split result `.constructor` is not `Array`"
status: ready
sprint: 53
created: 2026-05-21
updated: 2026-05-21
priority: medium
feasibility: easy
reasoning_effort: low
goal: property-model
parent: 779
es_edition: ES5.1
language_feature: string-prototype-split
task_type: bug
test262_fail: 78
note: "Verified 2026-05-21: corrected file path from builtins/string.ts (does not exist) to string-ops.ts (split branches at L1681, L1746)"
---

# #779c — String.prototype.split result `.constructor` is not `Array`

## Problem

~78 test262 fails: `assert.sameValue(__split.constructor, Array, ...)` where
`__split = "a,b,c".split(",")`. `String.prototype.split` returns an array
object whose `.constructor` does not resolve to the global `Array` — the
prototype chain on builtin-returned arrays is not wired to
`%Array.prototype%`. Spec requires the result of `split` to be a freshly
allocated standard Array, indistinguishable from `[...]` literals at the
property-access level.

## ECMAScript spec reference

- §22.1.3.22 `String.prototype.split (separator, limit)` — Step "Let A be
  ! ArrayCreate(0)." (`ArrayCreate` produces an exotic Array with
  `[[Prototype]] = %Array.prototype%`).
- §7.3.18 `ArrayCreate` — sets `[[Prototype]]` to `%Array.prototype%`.
- §20.1.3.1 `Array.prototype.constructor` — initial value is `%Array%`.

Therefore `("a,b,c".split(",")).constructor === Array` must hold.

## Files to change

- `src/codegen/string-ops.ts` (verified 2026-05-21 — there is no
  `src/codegen/builtins/string.ts`; the `builtins/` dir contains only
  `error-types.ts`, `imports.ts`, `types.ts`). The `split` method
  branches live at lines 1681 and 1746. Ensure the allocated result is
  built via the same ArrayCreate path used for array literals (which
  wires the prototype correctly), instead of a bare WasmGC struct/array
  allocation that bypasses `%Array.prototype%`.
- If a shared "ArrayCreate from builtin" helper exists, use it; otherwise
  set the result's prototype field to the canonical `%Array.prototype%`
  reference held by the runtime.

## Acceptance criteria

- [ ] `"a,b,c".split(",").constructor === Array` evaluates to `true`.
- [ ] `Object.getPrototypeOf("a,b,c".split(",")) === Array.prototype` evaluates to `true`.
- [ ] All `built-ins/String/prototype/split/**` assertion_fail tests that match the constructor-identity pattern flip to pass.
- [ ] Net test262 pass increase ≥ +60 (target ~78).
- [ ] No regression in existing `split` behavioural tests (separator regex, limit argument, empty separator).
