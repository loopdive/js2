---
id: 6945
title: "A function declaration nested in a helper is ONE shared function object across calls — `function Inheriter(){}; Inheriter.prototype = p; new Inheriter()` inside `inherits()` aliases every caller's prototype (Octane deltablue)"
status: ready
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: function-declarations, closures, prototype-chain
goal: core-semantics
related: [874, 6944, 1712, 2660, 4243, 4480, 4653]
assignee: "ttraenkler/claude-session-c-octane-nested-fnctor-shared-identity-20261010"
---

# #6945 — nested function declaration has program-wide identity, so per-call `.prototype` reassignment aliases

Found by the Octane triage (#874, Session C, 2026-10-10). Together with #6944
this is why `deltablue.js` fails with `addConstraint is not a function`.

## Problem

Deltablue's inheritance helper (called 6 times, once per constraint class):

```js
Object.defineProperty(Object.prototype, "inheritsFrom", {
  value: function (shuper) {
    function Inheriter() { }
    Inheriter.prototype = shuper.prototype;
    this.prototype = new Inheriter();
    this.superConstructor = shuper;
  }
});
```

Per §10.2.3 / §8.6.1 FunctionDeclarationInstantiation, EVERY call of the helper
creates a FRESH `Inheriter` function object with its own `.prototype` slot. js2
emits one cached closure per function NAME, so the second call's
`Inheriter.prototype = …` overwrites the first call's, and the first instance's
chain now points at the wrong parent (in deltablue: cycles, so the walk gives up).

Minimized (`.tmp/db30.js`):

```js
function mk(p) { function Inheriter() { } Inheriter.prototype = p; return new Inheriter(); }
export function main() {
  var a = mk({ tag: "A" }), b = mk({ tag: "B" });
  return a.tag + "," + b.tag + "," + (Object.getPrototypeOf(a) === Object.getPrototypeOf(b));
}
```

| lane       | result                  |
| ---------- | ----------------------- |
| node       | `A,B,false`             |
| gc         | `B,B,true`              |
| standalone | `undefined,undefined,true` |

Deltablue-shaped repros: `.tmp/db19.js` (the `inheritsFrom` helper, two
levels, inherited method called inside the ctor) and `.tmp/db27.js` (same with a
plain `inherits(ctor, shuper)` helper) — both `addConstraint is not a function`
on gc and `called value is not a function` on standalone, and both STILL fail
with #6944's one-line host fix applied, while `.tmp/db3.js` (one level, one
helper call) passes with it. `.tmp/db28.js` (two levels, method called after
construction) fails the same way, so this is not about ctor-internal calls.

## Root cause (confirmed by behaviour; location read from the lowering)

- The nested declaration's VALUE is the per-name cached singleton:
  `compileNestedFunctionDeclarationInScope` binds it via
  `emitCachedFuncClosureAccess` (`src/codegen/statements/nested-declarations.ts:3595`)
  → `ensureFuncClosureSingleton` (`src/codegen/closures/method-trampolines.ts:1154`),
  which mints ONE `__fn_tramp_<name>_cached` trampoline + ONE cache global
  (`ctx.funcClosureGlobals`) per function name. Every activation of `mk`
  observes the same closure struct.
- gc: `.prototype` lives in the host sidecar keyed by that struct
  (`_getOrVivifyFnPrototype`, `src/runtime.ts:364`), so the second
  `Inheriter.prototype = p` overwrites the first; `__register_fnctor_instance`
  (emitted by `emitCtorPrologueFnctorRegistration`, `new-super.ts:2614`) links
  both instances to the same ctor → same prototype. Its own comment already
  names the hazard ("A synthesized cached closure is not equivalent for
  capturing nested constructors").
- standalone: `.prototype` is a per-NAME module global `__fnctor_proto_<F>`
  (`getOrMintFnctorProtoGlobal`, `src/codegen/expressions/fnctor-prototype.ts:219`;
  write arm `tryCompileFnctorPrototypeAssign` `:507`; read arm
  `emitFnctorProtoGet` `:422`), and `__fnctor_proto_start`
  (`object-runtime.ts:9508`) maps a `$__fnctor_Inheriter` struct to that one
  global — identity is per name by construction. (The `undefined,undefined`
  result additionally shows the parameter-valued `Inheriter.prototype = p`
  write is not seen by instances at all on this lane; same fix.)

## Implementation Plan

Spec constraints: §8.6.1 step 36 / §10.2.3 InstantiateOrdinaryFunctionObject —
a fresh function object per activation, with MakeConstructor (§10.2.5) giving
each its own writable `prototype` data property; `new F()` reads `F.prototype`
at construction (§10.1.14 GetPrototypeFromConstructor), so an instance keeps the
prototype of the function OBJECT that made it, not the latest write to any
same-named function.

1. **Per-activation identity for nested declarations that need it.** In
   `compileNestedFunctionDeclarationInScope` (`nested-declarations.ts:1383`),
   when the declaration is nested inside another function AND the body of the
   enclosing scope writes `<name>.prototype`, `new`s it, or lets its identity
   escape (stored/returned/passed — reuse `analyzeFnctorEscapeGate`'s use
   classifier, `fnctor-escape-gate.ts:1578`), allocate a FRESH closure struct
   (`struct.new` of the same wrapper type `ensureFuncClosureSingleton` computes,
   `constructible: true`) at hoist time into the binding local instead of
   `emitCachedFuncClosureAccess`. Declarations without those uses keep the
   singleton (byte-identical output for the common case). The decision must be
   made once per declaration and shared with every consumer that resolves the
   binding (`resolveFnctorSymbol`, `arguments-callee.ts`, `global-var-bindings.ts`).
2. **gc**: nothing else — the sidecar is keyed by struct identity, so each fresh
   struct gets its own vivified `prototype`, and `__register_fnctor_instance`
   already receives the live constructor value.
3. **standalone**: the prototype slot must travel with the function OBJECT. For
   the per-activation case store it in the closure struct (the `$bag`/meta slot
   `fnMetaSlot`, `function-instance-meta.ts`) and make `emitFnctorProtoGet` /
   `tryCompileFnctorPrototypeAssign` / `__fnctor_proto_start` read that slot
   through the instance's `$constructor` field (`fnctor-identity-fields.ts:8`)
   instead of the per-name global; the per-name global remains the fast path
   for top-level fnctors.
4. **Tests** (`tests/issue-6945-nested-fnctor-identity.test.ts`, both lanes vs
   node): db30 (`A,B,false`), `mk(p1) !== mk(p2)` constructor identity
   (`a.constructor !== b.constructor`), db19/db27/db28 (deltablue shape:
   `true,2,1`), and controls: a top-level `function F(){}` keeps a single
   identity across calls (`F === F` from two call sites, `F.prototype` stable);
   a nested declaration that is only CALLED (never `new`'d, no `.prototype`
   write) emits the same bytes as before (snapshot the WAT of a small probe).
5. **Acceptance**: with #6944, Octane `deltablue.js` runs to completion on gc and
   standalone via `.tmp/octane-probe.mjs deltablue`; test262 floors unchanged
   (`language/function-code/` and `language/statements/function/` rows that
   assert distinct function objects per evaluation — e.g. `S13_A17_T1`,
   `13.2-*` — are the positive signal to watch).

## Ownership note

`nested-declarations.ts`, `closures/method-trampolines.ts`,
`expressions/fnctor-prototype.ts`, `object-runtime.ts` (standalone ladder) are
Session A's WasmGC/shared-IR area; Session C implements at the project lead's
direction. Functions touched: `compileNestedFunctionDeclarationInScope`,
`ensureFuncClosureSingleton`/`emitCachedFuncClosureAccess` (a per-activation
sibling, not a change to the singleton), `getOrMintFnctorProtoGlobal`,
`emitFnctorProtoGet`, `tryCompileFnctorPrototypeAssign`,
`fillFnctorPrototypeDispatchArms`.
