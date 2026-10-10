---
id: 6945
title: "A function declaration nested in a helper is ONE shared function object across calls — `function Inheriter(){}; Inheriter.prototype = p; new Inheriter()` inside `inherits()` aliases every caller's prototype (Octane deltablue)"
status: wont-fix
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
loc-budget-allow:
  # 2026-10-10 (#6945): one hook line + import in the hoist driver, and the
  # closure-allocation instrs factored out of the lazy cache access so the
  # per-activation binding (new statements/nested-fnctor-activation.ts) shares
  # them instead of duplicating the wrapper layout.
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/closures/method-trampolines.ts
func-budget-allow:
  # 2026-10-10 (#6945): the one-line per-activation binding hook.
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
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

## Implementation notes (2026-10-10, Session C) — host lane DONE, standalone OPEN

**Host (gc) — implemented (plan steps 1-2).** A capture-free nested
declaration is bound to a FRESH closure per activation when its enclosing body
writes `<name>.prototype = …`:
- `bindActivationFnctorClosures` (new `src/codegen/statements/nested-fnctor-activation.ts`),
  called once from `hoistFunctionDeclarations`' top-level post-pass, emits a
  fresh wrapper (`emitFreshFuncClosure`: the singleton's trampoline + wrapper
  type via the shared `closureAllocInstrs`, no cache global) into the declaration's hoisted-value local at
  function entry, marks it materialized and the declaration as
  `reassignedFunctionDeclarations` so no read site re-materializes the
  singleton over it (the lazy materializer re-emits only for an unreassigned
  declaration). Identifier reads, `.prototype` writes and every `new` site then
  observe this activation's function object; `__register_fnctor_instance`
  already receives the evaluated constructor value, and the prototype sidecar
  is keyed by the struct, so nothing else changes on the host.
- Deviation from the plan's gate: the plan proposed reusing
  `analyzeFnctorEscapeGate`'s classifier (new / escape / `.prototype` write). I
  gate syntactically and narrower: a body-level `.prototype` write is required,
  and every other mention of the name must be in the same body outside nested
  functions (a nested function would still resolve the per-name singleton), no
  redeclaration, no direct `eval`, no `arguments`/self-reference inside the
  declaration. That keeps the "decision shared with every consumer"
  requirement trivially true — no consumer outside the enclosing body can see
  the name — without touching `resolveFnctorSymbol` / `arguments-callee.ts` /
  `global-var-bindings.ts`. Declarations that are only `new`'d (default
  prototype, no write) keep the singleton: two activations' instances still
  share one vivified prototype (`Object.getPrototypeOf(mk()) ===
  Object.getPrototypeOf(mk())` is `true`, node `false`). Widening is a
  follow-up.

**Standalone — NOT implemented (plan step 3 is architectural).** It needs the
prototype slot to travel with the function OBJECT (closure meta slot) and every
fnctor instance to carry its constructor (`$constructor`) so
`__fnctor_proto_start`, `emitFnctorProtoGet` and
`tryCompileFnctorPrototypeAssign` resolve per object instead of per NAME —
new struct layout and a rewrite of the per-name ladder that every
`__fnctor_proto_start` consumer bakes. Measured blockers on the deltablue shape,
in order:
1. a DYNAMIC `ctor.prototype = v` (receiver not a statically resolved fnctor
   identifier — deltablue's `this.prototype = new Inheriter()`, `.tmp/s2.js`'s
   `setp(Derived, o)`) lands in the closure's own-property bag, never in
   `__fnctor_proto_Derived`, so `new Derived()` does not see it
   (node `function,true,function,true`; standalone `function,false,undefined,false`);
2. the per-NAME `__fnctor_proto_Inheriter` (this issue) — `.tmp/db30.js` stays
   `undefined,undefined,true`.
Both need the per-object prototype slot, so they belong to one design.

**Also observed (pre-existing, not this issue):** gc `new f()` on a function
VALUE (`var f = get(); new f().t`) ignores `f.prototype` (`NaN` vs node `1`,
`.tmp/s3.js`); gc instances link to the CONSTRUCTOR and re-read its
`.prototype` on every lookup instead of snapshotting it at construction
(§10.1.14), so re-assigning `F.prototype` after `new F()` retargets old
instances (`.tmp/s1.js`: gc `A,B,B,true`, node `A,A,B,false`).

**Validation** — `tests/issue-6945-nested-fnctor-identity.test.ts`: 5 gc
positive cases (db30, constructor identity, db19, db27, db28) fail on base and
pass on head; controls (top-level identity on gc + standalone; a call-only
nested declaration allocates no closure) pass on both; the 5 standalone
positives are `it.todo`. Octane `deltablue` gc: `run(1) -> 1` (was
`addConstraint is not a function`).

## Closed — host-lane half dropped (2026-10-10)

`wont-fix`. The project lead is sunsetting the JS host (gc) lane; only
`--target standalone` is relevant (`.claude/memory/project_standalone_only_js_host_sunset.md`).
The per-activation function-object fix above was gc-only and was reverted from
PR https://github.com/loopdive/js2/pull/6624 before merge; its evidence log is
kept. The standalone defect continues as #6951, which per its plan also makes a
per-activation closure unnecessary on standalone. The budget grants above
became unused with the revert.
