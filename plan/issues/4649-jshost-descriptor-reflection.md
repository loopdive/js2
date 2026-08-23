---
id: 4649
title: "js-host: property-descriptor/reflection harness self-tests — verifyProperty ×2, deepEqual-deep, isConstructor"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
files:
  - src/codegen/object-runtime.ts
---

# js-host: descriptor/reflection harness self-tests — 4 failures

Goal context: 100% of `test262/test/harness/` in BOTH lanes; js-host is at
102/116 (2026-08-23, branch `claude/harness-standalone-green`,
`.tmp/run-harness-all-host.mts`). This issue owns the
property-descriptor/reflection bucket:

| test | js-host error |
| --- | --- |
| `verifyProperty-value.js` | `prop descriptor should not be writable; … not be configurable` at L20 — `Object.getOwnPropertyDescriptor` reports wrong flags for a plain data property defined via `Object.defineProperty` |
| `verifyProperty-desc-is-not-object.js` | L12 `assert.throws(Test262Error, …)` did not throw — `verifyProperty(obj, "prop", <primitive desc>)` should reject a non-object descriptor |
| `deepEqual-deep.js` | L12 `assert.deepEqual({}, {a:{x:1},b:[true]})` did NOT throw — deepEqual judges an EMPTY object equal to a non-empty one (own-key enumeration of `{}` vs the compared object is broken somewhere in the harness's `Object.keys`/`getOwnPropertyNames` walk) |
| `isConstructor.js` | `SameValue(«false», «true»)` at source L194 via `__closure_39` — the failing assert maps to L14 `typeof isConstructor === "function"` but the booleans say a later `isConstructor(...)` verdict is wrong; source-map attribution needs re-deriving |

## Implementation Plan (initial — deepen before implementing)

1. **Minimal repros first**, in `.tmp/`, js-host mode:
   - verifyProperty-value — NARROWED (lead, 2026-08-23): the defineProperty
     PRIMITIVE is fine in js-host. Probes passed for BOTH a literal and a
     dynamic (variable, field-mutated) descriptor: writes blocked under
     `writable:false`, delete blocked under `configurable:false`, for-in
     empty under `enumerable:false`. So the failure lives in the harness
     composition: `reset(desc)` REASSIGNS the module-level `obj` from inside
     a function (closure-captured outer-var write), `desc.value = prop`
     mutates the param, and `verifyProperty` then reads `obj`. Suspect the
     closure write to `obj` not being visible to the later read, or
     verifyProperty's own restore/probe sequence. One SEPARATE latent finding
     while probing: a sloppy-mode write to a non-writable prop THROWS
     TypeError ("Cannot assign to read only property") instead of silently
     no-oping — propertyHelper catches, so it is probably not this test's
     cause, but it is a spec deviation worth its own note/issue if confirmed.
   - deepEqual-deep — NARROWED (lead, 2026-08-23): NOT an enumeration bug.
     `for-in` over `{}`/`{a,b}` is correct (probe passed), and the file's
     lines 10+12 alone pass — including the `assert.throws(Test262Error,
     function () { assert.deepEqual({}, {a:{x:1},b:[true]}); })` closure. The
     failure appears ONLY when line 13's third closure
     (`…deepEqual({a:{x:1},b:[true]}, {a:{x:1},b:[false]})`) is ALSO present:
     then the SECOND line's closure stops throwing (error attributes
     `__closure_92` via the L12 call site). Three-line repro kept at
     `test262/test/tmpprobe/deep4.js`-shape (recreate; tmpprobe is not
     committed). Suspect cross-closure/cross-literal type unification (the
     structurally-similar closures or the `[true]`/`[false]`/`{}` literals
     sharing an inferred shape) changing deepEqual's path — diagnose by
     diffing the compiled module with/without line 13.
   - isConstructor — the failing assert is one of the
     `assert.sameValue(isConstructor(function(){}), true)` /
     `…(Array), true)` lines (got false): the include's
     `Reflect.construct(function(){}, [], f)` THROWS for a legitimate
     constructor `f`, so `try/catch` answers false. js-host
     `Reflect.construct` with an explicit `newTarget` argument is the
     suspect — probe it directly first.
2. Fix the underlying builtin(s) in the js-host lane. These are almost
   certainly host-import/object-runtime issues, not parser issues — locate the
   js-host lowering for `defineProperty`/`getOwnPropertyDescriptor`
   (`src/codegen/object-runtime.ts` + host imports in `src/runtime.ts`) before
   assuming a compiled-JS bug.
3. **Watch cross-lane gating**: fixes must not disturb the standalone
   descriptor path (FLAG_* machinery) — standalone category must stay 113/116
   on the stacked base.

## Acceptance criteria

- The 4 tests pass js-host (`.tmp/run-harness-all-host.mts` shows them green).
- Standalone category unchanged (113/116 on the stacked base) and js-host
  sample 59/60 (`.tmp/run-host-list.mts`, `.tmp/host-sample.txt` —
  AsyncDisposableStack failure is pre-existing).

## Permanent repro

`test262/test/harness/verifyProperty-value.js` and
`test262/test/harness/deepEqual-deep.js` (js-host lane,
`tests/test262-runner.ts` `runTest262File(..., undefined)`).
