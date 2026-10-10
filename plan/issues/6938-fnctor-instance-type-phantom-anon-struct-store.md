---
id: 6938
title: "Octane richards: `next.link = this` throws/traps on a non-null receiver — a JSDoc `@param {Packet}` on a function declaration mints a phantom `__anon_N` struct for the fnctor instance type, and the member-store path pins to it"
status: in-progress
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
language_feature: objects, compiler-internals
goal: core-semantics
related: [874, 4155, 1712, 2071, 1058, 2084, 2660]
loc-budget-allow:
  # 2026-10-10 (#6938): +9 lines in resolveStructName — the fnctor-instance
  # lockstep answer (reserved `__fnctor_<Name>` struct or dynamic); see
  # Implementation Notes. No smaller placement keeps it beside the anon lookup.
  - src/codegen/property-access.ts
func-budget-allow:
  # 2026-10-10 (#6938): +2 lines — the registration guard that stops the phantom
  # `__anon_N` struct (plan step 2). resolveWasmType shrank by 8 in the same change.
  - src/codegen/index.ts::ensureStructForType
origin: "2026-10-10 — Octane triage (Session C). richards.js is the first Octane benchmark that compiles but does not run on js2."
---

# #6938 — phantom anon struct for a function-constructor instance type breaks `obj.field = v`

## Problem

Octane `richards.js` (pinned commit `570ad1cc`) compiles on both lanes but every
run throws inside `Packet.prototype.addTo` at `next.link = this`
(richards.js:533), although `next == null` is `false` one statement earlier
(verified with a traced variant that would have thrown its own Error first):

| lane | result |
| --- | --- |
| node | `runRichards()` completes, queue/hold counts match |
| js2 gc host | `TypeError: Cannot access property on null or undefined at 535:3` (535 = richards.js:533 after a 2-line stub) |
| js2 standalone | `RuntimeError: dereferencing a null pointer` |

Driver: `.tmp/octane-probe4.mjs` / `.tmp/run-both.mjs` (stub `Benchmark`/
`BenchmarkSuite`, richards.js verbatim, `export function main(){ runRichards(); return 1 }`,
compiled through the public `compile()` with `allowJs`, gc host via
`buildImports`/`instantiateWasm`, standalone via `WebAssembly.instantiate(bin, {})`).

### Minimized repro (`.tmp/r11.js`)

```js
/** @param {Packet} queue */
function TaskControlBlock(queue) {          // (1) top-level DECLARATION with a Packet-typed param
  this.queue = queue;
}
function HandlerTask() { this.v1 = null; }
HandlerTask.prototype.run = function (packet) {
  this.v1 = packet.addTo(this.v1);          // (2) argument is a property read → receiver not pinnable
};
function Packet(id) { this.link = null; this.id = id; }
/** @param {Packet} queue */
Packet.prototype.addTo = function (queue) {  // (3) receiver `next` is checker-typed Packet
  this.link = null;
  if (queue == null) return this;
  var next = queue;
  while (next.link != null) next = next.link;
  next.link = this;
  return queue;
};
export function main() {
  var h = new HandlerTask();
  h.run(new Packet(1));
  h.run(new Packet(2));
  return h.v1.link.id;
}
```

| | output |
| --- | --- |
| node | `2` |
| js2 gc host | `TypeError: Cannot access property on null or undefined at 33:10` |
| js2 standalone | `TypeError: Cannot access property on null or undefined at 33:10` |

Negative controls (all pass `2` on both lanes): drop the JSDoc on (1) → pass;
drop the JSDoc on (3) → pass; bind the argument from a pinnable local
(`q = new Packet(…); p.addTo(q)`) → pass (this is why the first "minimal"
attempt passed — the fnctor flow map pins `next` and the bug is skipped).
Full richards with the two declaration-level `@param {Packet}` annotations
(richards.js:256 on `TaskControlBlock`'s `queue`, richards.js:512 on `Packet`'s
own `link`) rewritten to `{*}` runs to completion on **both** lanes
(`.tmp/r0c.js` → `main -> 1`). That is the confirmation: nothing else in the
benchmark is wrong.

## Root cause (confirmed by instrumentation; see `DBG store` / `DBG anon` traces in the triage session)

A function-constructor ("fnctor") instance type reaches the struct registry
through a side door and becomes a struct that is never allocated:

1. `collectDeclarations` (`src/codegen/declarations.ts:2977-2980`) calls
   `ensureStructForType(ctx, pt)` for **every parameter type of every top-level
   function declaration**. With `/** @param {Packet} queue */` the checker type
   of `queue` is the instance type of fnctor `Packet` (symbol name `Packet`,
   properties = ctor-assigned fields **plus prototype methods**:
   `link,id,kind,a1,a2,addTo,toString`).
2. `ensureStructForType` (`src/codegen/index.ts:13388-13742`) has **no fnctor
   guard**. `ctx.structMap.has("Packet")` is false (the runtime struct is
   registered as `__fnctor_Packet`), so it mints `__anon_N` from the checker
   shape and records `ctx.anonTypeMap.set(tsType, "__anon_N")`
   (index.ts:13731-13742). Zero `struct.new $__anon_N` exist in the output —
   the only Packet allocation is `__fnctor_Packet_new` → `struct.new $__fnctor_Packet`.
   `resolveWasmType` (index.ts:13010-13033) already knows this type must NOT be
   lowered to a checker-shape struct (#1712: "data fields PLUS prototype-assigned
   methods has no subtype relation to the runtime struct"; #4155 maps it to the
   reserved `$__fnctor_<Name>` on standalone, externref on gc) — but the
   registration site is not in lockstep with it.
3. In `compilePropertyAssignment` (`src/codegen/expressions/assignment.ts:4201`,
   struct-store tail at 5001-5272): `resolveReceiverStruct`
   (`src/codegen/fnctor-escape-gate.ts:1524`) returns `undefined` for `next`
   (its value flows from `this.v1`/`this.v2` property reads the may-flow
   fixpoint at 1373-1448 cannot bind), so the code falls to
   `resolveStructNameForExpr` → `resolveStructName`
   (`src/codegen/property-access.ts:1022-1055`), which returns
   `ctx.anonTypeMap.get(tsType)` = `__anon_N` at line 1054. The
   `isConstructedFnctorName` exclusion at line 1045 only guards the
   `structMap.has(name)` branch, not the anon-map branch.
4. The store is emitted as `ref.test $__anon_N → ref.cast | ref.null none`,
   then the #2084 null guard, then `struct.set $__anon_N 0`
   (assignment.ts:5220-5254). A real `$__fnctor_Packet` fails the test, narrows
   to null, and the guard throws (gc) / the standalone variant traps. Reads
   survive because the member-GET dispatcher tests `$__anon_N` and then falls
   back to `$__fnctor_Packet` (`findAlternateStructsForField`); the member-SET
   struct path has no alternate-shape fallback.

Second symptom of the same registration (what the minimized repro surfaces
first): any field/param/local whose checker type is the fnctor instance type is
lowered to `(ref null $__anon_N)`, so a `$__fnctor_Packet` stored into it
guard-casts to null and reads back `null` (`h.v1.link` → throw at 33:10).

Why the "minimal version passes": with a pinnable argument the #2660 pinned
member-set (`tryEmitPinnedStructMemberSet`) wins before the phantom struct is
ever consulted. The bug needs (a) a declaration-level annotation to mint the
phantom and (b) an unpinnable receiver typed by the same annotation name.

## Implementation Plan

Fix at the registration site, mirror at the lookup site; no change to emitted
code for anything that is not a fnctor instance type.

1. **Shared predicate** — new export `isFnctorInstanceType(ctx, tsType): boolean`
   in `src/codegen/fnctor-instance-names.ts` (keeps `index.ts` LOC flat): the
   exact `isFnCtorType && tsType.getCallSignatures().length === 0` predicate
   now inlined in `resolveWasmType` (`src/codegen/index.ts:13011-13021` —
   `isConstructedFnctorName(ctx, sym.name)` OR the symbol's value declaration is
   a `FunctionDeclaration` / `FunctionExpression` / `var f = function(){}`),
   excluding `ctx.classSet` names. Replace the inline predicate in
   `resolveWasmType` with the helper so the two sites cannot drift.
2. **`ensureStructForType`** (`src/codegen/index.ts:13388`): after the `.d.ts`
   and `globalThis` guards and before `const props = tsType.getProperties()`,
   `if (isFnctorInstanceType(ctx, tsType)) return;` — never register, never
   touch `anonTypeMap`. Ordering constraint: `ctx.fnctorEscapeGate` is assigned
   at index.ts:5390 (single) / 10725 (multi) **before** `collectDeclarations`
   runs at 5849 / 11043, so `isConstructedFnctorName` is answerable at
   registration time; `funcConstructorMap` alone is not (lazy, see the
   #1058 note in fnctor-instance-names.ts).
3. **`resolveStructName`** (`src/codegen/property-access.ts:1054`): decline an
   `anonTypeMap` hit when `tsType.symbol?.name` is a constructed fnctor name
   and not a class — the same rule line 1045 applies to the named branch — so
   an anon entry that arrives through the other registration routes
   (`literals.ts:3269`, `object-shape-widening.ts:758`) can never pin a fnctor
   receiver either. With (2) this is belt-and-braces.
4. Semantics: plain `PutValue` / ordinary [[Set]] (ECMA-262 §13.15.2
   AssignmentExpression, §10.1.9 OrdinarySet). Receiver and RHS evaluation
   order are already preserved by the dynamic store the receiver now takes
   (`compilePropertyAssignmentExternSet` on gc, the `__fnctor_<Name>` /
   `$Object` dispatcher on standalone); nothing new is reordered.
5. Lanes: gc host and standalone both reproduce and both are fixed by (2).
   `ensureStructForType` is shared with the linear backend's type reservation
   (`linear-type-reservations.ts`), so run `linear-tests` locally once.

### Regression tests (`tests/issue-6938-fnctor-instance-anon-struct.test.ts`)

- The minimized repro above, as real source through the public `compile()`
  (`allowJs: true`), gc host and standalone: `main()` → `2` (node oracle).
- Store-site variant (`.tmp/r15.js`: `kind`-routed `v1`/`v2` queues, the
  richards `peek`/`next` loop body, three packets, node → `3`). Note: every
  minimized program trips the field-type symptom (null read-back) *before* the
  store line; only the verbatim richards reaches `next.link = this` with a
  non-null `$__fnctor_Packet` in hand (its `v1` carrier stays externref). Both
  are the same registration, so the test asserts the node value, not the
  failing line.
- Negative controls (must pass before and after): the repro with the
  declaration-level JSDoc removed; with the method-level JSDoc removed; a
  `class Packet {}` of the same name (`ctx.classSet`) still registers and
  resolves its own struct; the #1058 interface-named-like-a-fnctor case keeps
  its externref resolution.
- Acceptance check (manual, Octane sources are not in-repo):
  `node --import tsx .tmp/octane-probe.mjs richards` on gc and standalone runs
  `runRichards()` — the benchmark's own `queueCount`/`holdCount` check throws
  on a wrong result, so a normal return is the oracle.

## Implementation Notes (2026-10-10, senior-dev, WIP — NOT merge-ready)

Plan steps 1-2 implemented as written (`isFnctorInstanceType` in
fnctor-instance-names.ts shared by `resolveWasmType` and `ensureStructForType`,
which now never registers a fnctor instance type). Evidence:
`plan/log/6938-evidence/*.txt`.

**Deviation in step 3 (`resolveStructName`).** The literal plan (decline → no
struct) regressed standalone: the phantom `__anon_N` was what routed member
CALLS on an unpinned approved-standalone fnctor receiver into
`compileCallablePropertyCall`'s #1712 dynamic dispatch. Without any struct name
the call falls to the graceful tail (`call-tail-dispatch.ts`) and answers
undefined. Measured: `.tmp/6938/r0c.js` (richards with `{*}` on the two
`{Packet}` decls) base `1/1` → plan-literal standalone `TypeError … markAsSuspended`;
minimal `this.s.suspend()` with `/** @param {Sched} s */` base 11 → 0. The same
graceful-tail defect already exists without any annotation
(`this.s = new Sched(); this.s.suspend()` → 0 on base standalone).

So step 3 answers in lockstep with `resolveWasmType` instead: a fnctor instance
type resolves to the struct `resolveWasmType` lowers it to (reserved
`__fnctor_<Name>` for an approved standalone fnctor; none on gc/non-approved).

**Open — why this is not merge-ready:**

1. Regression vs base (standalone): `tests/issue-3719-new-assigned-to-binding.test.ts`
   "reads a prototype method as a value" (`var p; p = new Q(); p.inc ? 1 : 0` → 0).
   With a `__fnctor_Q` name, the property-GET path in
   `property-access-dispatch.ts` (~4704, the "auto-register missing field" arm)
   ADDS an `inc` field to `$__fnctor_Q` and reads its null default. Pinned
   locals never reach that arm because `carrierNameForAccess` only names the
   carrier for an existing field. Probe: excluding non-`this` `__fnctor_*`
   receivers from that arm (the #2071 `foreignReturnReceiver` pattern) fixes it
   with no other 3719 change — but that file is outside this issue's scope.
2. Octane richards standalone still fails after the store fix:
   `TypeError: called value is not a function` at `HandlerTask.prototype.run`
   `packet.addTo(this.v2)`. Pre-existing and independent of this change
   (minimal `.tmp/6938/m5.js` fails identically on base): with
   `@param {Packet}` consumers every `new Packet` site classifies `keep-typed`
   in the fnctor escape gate, so Packet is not approved and its prototype
   methods are never compiled, but the instances still reach an untyped
   `packet.addTo()`. Needs its own issue (escape-gate soundness, #4261 family).

Results (base → head): r11 throw/throw → 2/2; r15 throw/throw → 3/3; richards
gc throw → passes, standalone null-deref → #2 above. Related tests (238 files
mentioning fnctor/anonTypeMap/ensureStructForType/1058): +4 head-only passes
(#2608 ×3, #5162 ×1), −1 (#3719 above); #5195 skips are test262-file
existence (`skipIf`), not code. Equivalence gate green (1748 pass, 22 known).

## Acceptance criteria

- [ ] `.tmp/r11.js` → `2` on gc host and standalone (node: `2`).
- [ ] Octane richards (pinned `570ad1cc`, verbatim) runs one iteration on gc
      host and standalone through the public `compile()`.
- [ ] No `__anon_N` struct whose field list is a fnctor's ctor fields + its
      prototype method names is registered for a fnctor instance type.
- [ ] `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports` green; equivalence gate green; no test262 regression in the merge group.

## Ownership note

These files are in Session A's WasmGC / shared-IR area; implementation is done
by Session C at the project lead's direction. Exact functions touched, for A's
overlap check: `src/codegen/index.ts` — `ensureStructForType` (13388) and the
`isFnCtorType` predicate inside `resolveWasmType` (13011-13021);
`src/codegen/property-access.ts` — `resolveStructName` (1022-1055);
`src/codegen/fnctor-instance-names.ts` — new `isFnctorInstanceType` beside
`isConstructedFnctorName`. Not touched: `compilePropertyAssignment`,
`collectDeclarations`, the fnctor escape gate.

## Overlap check (2026-10-10)

- #4155 (`ready`, claimed 2026-08-04 by `ttraenkler/claude` on
  `claude/acorn-performance-optimization-hagjht`, stale) is the inverse
  defect — the instance type being *discarded* to externref — and its Phase 1
  (`resolveFnctorInstanceType`) is already on main; it does not mention
  `ensureStructForType` / `anonTypeMap`. #1712 records that synthesizing a
  struct from the checker shape regressed; this issue is that synthesis
  happening anyway through the declaration-parameter registration.
- #2071 (foreign-return fnctor) and #1058 (interface named like a fnctor) are
  the neighbouring guards in `resolveWasmType`; neither covers registration.
- Open PRs (31, checked 29 via REST; #6468 and #5883 file lists unavailable):
  none touch `ensureStructForType`, `resolveStructName` or fnctor instance
  registration; no PR adds a `plan/issues/6938-*` file.
- #874 is the Octane umbrella; this is its first richards finding.
