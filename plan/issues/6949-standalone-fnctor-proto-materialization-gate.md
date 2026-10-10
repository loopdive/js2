---
id: 6949
title: "standalone: a constructed fnctor that the escape gate does not APPROVE gets no prototype object — its `F.prototype.m = …` statements are dropped at module init and `__fnctor_proto_start` has no arm for `$__fnctor_F`, so any instance reaching a dynamic `inst.m()` throws `called value is not a function` (Octane richards, crypto)"
status: ready
sprint: current
created: 2026-10-10
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, prototype-chain, dynamic-dispatch
goal: standalone-gap
related: [874, 2660, 4261, 6938, 6945, 6943, 3719, 4123]
---

# standalone: prototype materialization is gated on escape-gate APPROVAL, but dynamic dispatch is not

Found by the Octane triage (#874, Session C, 2026-10-10). This is the FIRST (and,
with one isolating patch, the ONLY) blocker of `richards.js` on standalone and the
first blocker of `crypto.js`. It is also the first half of #6945's `db30` shape.

## Problem

Standalone first failures (function trace via `wasm-opt --log-execution` +
`JS2WASM_CLOSURE_NAME_MAP=1`):

| bench | failing call | callee owner | why |
| --- | --- | --- | --- |
| richards | `packet.addTo(this.v2)` in `HandlerTask.prototype.run` (driver line 861; `packet` is an untyped param) | `Packet.prototype.addTo` | `Packet` is `keep-static`; no `Packet.prototype.*` closure exists in the binary |
| crypto | `rng_state.init(rng_pool)` in `rng_get_byte` (driver line 1826; `rng_state = prng_newstate()` where `prng_newstate() { return new Arcfour(); }`) | `Arcfour.prototype.init = ARC4init` | `Arcfour` is `keep-static` (its only `new` site is in `return` position → `neutral`) |

Both go `__call_m_<m>_<n>` (closed dispatcher, no struct arm) → `__extern_method_call`
→ `__extern_get` → `__fnctor_proto_start` (no arm for `$__fnctor_<F>`) → `undefined`
→ `TypeError: called value is not a function` (`calls.ts:5106`-family terminal arm).

Minimized — richards (`.tmp/r4.js`, node `2,true`, standalone throws; the JSDoc on the
ctor and on `go` is load-bearing: without it the `new Packet(queue, 2)` argument is a
`dynamic` use and the fnctor is approved):

```js
/** @param {Packet} link  @param {int} kind */
function Packet(link, kind) { this.link = link; this.kind = kind; }
Packet.prototype.addTo = function (queue) { this.link = null; if (queue == null) return this; var p = queue; while (p.link != null) p = p.link; p.link = this; return queue; };
function Task() { this.v1 = null; }
Task.prototype.run = function (packet) { this.v1 = packet.addTo(this.v1); return this.v1; };
function Sched() { this.task = new Task(); }
/** @param {Packet} queue */
Sched.prototype.go = function (queue) { var p = queue; queue = p.link; return this.task.run(p); };
export function main() { var q = new Packet(null, 1); q = new Packet(q, 2); var r = new Sched().go(q); return r.kind + "," + (r.link === null); }
```

crypto (`.tmp/c1.js`, node `11,12`, standalone throws; `.tmp/c1b.js` with
`rng_state = new Arcfour()` inlined passes — the binding form is classified `dynamic`):

```js
function Arcfour() { this.i = 0; this.j = 0; }
function ARC4init(key) { this.i = key.length; this.j = 7; }
function ARC4next() { this.i = this.i + 1; return this.i + this.j; }
Arcfour.prototype.init = ARC4init;  Arcfour.prototype.next = ARC4next;
var rng_state;  var rng_pool = [1, 2, 3];
function prng_newstate() { return new Arcfour(); }
function rng_get_byte() { if (rng_state == null) { rng_state = prng_newstate(); rng_state.init(rng_pool); } return rng_state.next(); }
export function main() { return rng_get_byte() + "," + rng_get_byte(); }
```

Whole-benchmark confirmation: richards with ONE appended function that forces
approval (`function __approvePacket() { var d = new Packet(null, 0, 0); return d.__whatever; }`,
`.tmp/patch-richards-approve.mjs`) runs to completion on standalone
(`octane_run(1) -> 1`, teardown ok). The gate log for the verbatim benchmark:
`17 new F() site(s): reconstruct=7 keep-typed=0 keep-static=10`.

## Root cause

Four standalone mechanisms are gated on `gate.approvedNames.has(F)`
(`resolveUserFnctorName`, `src/codegen/expressions/fnctor-prototype.ts:177`):

1. the per-fnctor prototype `$Object` global (`getOrMintFnctorProtoGlobal`, `:219`);
2. the module-init KEEP of top-level `F.prototype.m = …` / `F.prototype = …`
   (`isFnctorPrototypeAssignTarget` → `resolveUserFnctorName`, consumed at
   `src/codegen/declarations.ts:4427`; the #4618 identifier-receiver keep at
   `:4575-4598` is `!ctx.standalone`-only, `:4563`) — so on standalone the
   statement is DROPPED and the method body is never compiled (no closure-map entry);
3. the `ref.test $__fnctor_F → global.get __fnctor_proto_F` arm of
   `__fnctor_proto_start` (`fillFnctorPrototypeDispatchArms`,
   `src/codegen/object-runtime.ts:9530-9560`, iterates `ctx.fnctorPrototypeObject`);
4. the per-key method caches in the same fill (`:9600-9640`).

But the escape gate (`analyzeFnctorEscapeGate`, `src/codegen/fnctor-escape-gate.ts:1726-1800`)
is a ONE-HOP, per-allocation-site analysis: it classifies the uses of the binding
`var x = new F()` / `x = new F()` (`bindingOf`, `:690`) or the single inline consumer.
An instance that escapes through a field store with a typed receiver, a `return`
(`classifyUse` `:688` → `neutral`), or a JSDoc-typed parameter (`:664` → `neutral`)
and only LATER meets an `any`-receiver method call is invisible, so `F` stays
`keep-static`. The runtime dynamic path (`__call_m_*` → `__extern_method_call` →
`__fnctor_proto_start`) is reachable by EVERY instance regardless of the gate's
verdict, and for a non-approved `F` it finds nothing. `$__fnctor_F` structs are
registered for every struct-lowered fnctor (`new-super.ts:2757-2782`), approved or
not, and already carry `$constructor` (`fnctor-identity-fields.ts`), so the
representation is in place — only the prototype side is missing.

The gate comment (`fnctor-prototype.ts:117-125`) records why materialization was
scoped to approval in #2660 S2: (a) species `Ctor.prototype` identity for a
never-`new`'d `Ctor` — now covered by the `neverConstructed` arm (#4480); (b)
`Test262Error.prototype.toString` executing once kept (Test262Error is `keep-typed`).
(b) predates `fillFnctorPrototypeDispatchArms` and `__closure_proto_of`; its
re-measurement is acceptance criterion 4 below.

## Implementation Plan

Standalone only (`ctx.standalone || ctx.wasi`); host lane already returns early at
`fnctor-prototype.ts:111` and is byte-identical.

1. **`resolveUserFnctorName`** (`src/codegen/expressions/fnctor-prototype.ts:97-181`):
   replace the admission `gate.approvedNames.has(sym.name) || hasRuntimeDescriptorInstall || neverConstructed`
   with "every ORDINARY user fnctor once the gate exists":
   `gate !== undefined && isOrdinaryFunctionSymbol(ctx, sym) && !ctx.classSet.has(sym.name)`
   (approved ⊂ constructed ⊂ ordinary; `neverConstructed` and the descriptor-install
   scan become redundant — delete the scan, keep `isOrdinaryFunctionSymbol` as the
   single filter so generators/async/arrows stay out, per its doc comment). A missing
   gate keeps today's decline (#4235).
2. **No change needed** in `declarations.ts`: `isFnctorPrototypeAssignTarget` now
   keeps `F.prototype.m = …` / `F.prototype = …` for every ordinary fnctor on
   standalone; `fillFnctorPrototypeDispatchArms` adds the `$__fnctor_F` arm for every
   name in `ctx.fnctorPrototypeObject` whose struct exists. Verify by reading the
   closure map: `Packet.prototype.addTo` / `Arcfour.prototype.init` must appear.
3. **`__fnctor_<F>_new` must NOT vivify** — leave the proto global lazy; the
   `__fnctor_proto_start` arm returns `null` (walk ends) until the first
   `F.prototype` read/write, exactly as for approved fnctors today. (The #6945
   standalone plan below changes this to a construction-time snapshot; do that there,
   not here.)
4. **Typed twins / `resolveLiftedMethodThisStruct`** (`fnctor-escape-gate.ts:392`)
   stay approval-gated — that is a performance tier, not correctness.
5. **Order**: land before #6945-standalone (it assumes every constructed fnctor has a
   proto global) and before the splay keep fix (independent, but both touch
   `fnctor-prototype.ts`).

### Edge cases / risks
- `keep-typed` fnctors with a `Test262Error`-like `prototype.toString` write: the
  write now executes and the instance resolves it through the new arm. Expected to
  FIX rows, but this is the historic −40 eject — measure (criterion 4).
- A fnctor whose `prototype` is reassigned to an Array carrier
  (`stableArrayPrototypeNames`, #4387): `tryCompileFnctorPrototypeAssign` canonicalizes
  through `__proto_from_function`; an Array RHS is stored as-is today for approved
  fnctors, so nothing new.
- `var F = function(){}` fnctors: `isOrdinaryFunctionSymbol` admits them;
  `fnctorConstructorInstallInstrs` already handles the no-singleton case (#4491).
- Cost: one `mut externref` global per ordinary fnctor + one `ref.test` arm per
  constructed fnctor in `__fnctor_proto_start` / `__extern_method_call`. Measure the
  acorn standalone lane (`benchmarks/cross-engine`) before/after.

### Acceptance criteria
1. `tests/issue-<id>-fnctor-proto-unapproved.test.ts` (public `compile()`, `allowJs`,
   standalone vs node via `tryNativeExnRender`): `.tmp/r4.js` → `2,true`; `.tmp/c1.js`
   → `11,12`; `.tmp/db30.js`'s first half (`a.tag` with ONE `mk` call → `A`);
   `.tmp/m5.js` → `7`. Controls: `.tmp/c1b.js`/`.tmp/r3.js` (approved today) unchanged;
   a never-constructed `function Ctor(){}` keeps `Ctor.prototype` identity; a
   generator function gets no proto global (its `.prototype` stays
   `%GeneratorPrototype%`).
2. `pnpm run -s benchmark:octane -- --only richards --lanes standalone --timeout 300`
   → `pass`.
3. crypto: the first failure moves past `rng_get_byte`. NOTE: with the isolating
   patch (`.tmp/patch-crypto-binding.mjs`) the standalone run did not finish within
   12 CPU-minutes (the gc lane also times out at 180 s on crypto); whether that is
   slowness or a hang is untriaged — report the next failure or the timing.
4. test262 standalone floor: no regression in the merge group; specifically
   `harness/` rows using `Test262Error.prototype.toString` and
   `built-ins/Array/prototype/*/create-proxy*` must not move.
5. Ratchet gates green; `fnctor-prototype.ts` LOC goes DOWN (the descriptor scan is deleted).

## Ownership note

`src/codegen/expressions/fnctor-prototype.ts` (`resolveUserFnctorName`,
`isOrdinaryFunctionSymbol`) is in Session A's WasmGC/shared-IR area; needs A's
release. No other file changes.
