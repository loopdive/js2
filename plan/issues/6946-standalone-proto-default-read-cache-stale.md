---
id: 6946
title: "standalone: reading an inherited default (`T.prototype.v = null`) before the instance writes `this.v` leaves later reads stuck on the prototype value — per-key lookup cache is not shadowed by the own write (Octane splay `root_`)"
status: ready
sprint: current
created: 2026-10-10
updated: 2026-10-10
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: prototype-chain, property-assignment
goal: standalone-mode
related: [874, 6943, 6947, 3673, 2660, 4194]
assignee: "ttraenkler/claude-session-c-octane-standalone-proto-default-read-cache-stale-20261010"
---

# #6946 — standalone: own write does not shadow a previously-read prototype default

Found by the Octane triage (#874, Session C, 2026-10-10). This is the standalone
blocker of `splay.js` after #6943: `SplayTree.prototype.root_ = null` is read by
`isEmpty()` before `insert` writes `this.root_`, and every later read still
answers `null`, so the tree never grows (`.tmp/sp11.js`: `true,true,noroot,null,-`
vs node `true,false,0.5,a,true`; full rewritten splay traps).

## Problem

Minimized (`.tmp/sp19.js`):

```js
function T() { }
T.prototype.v = null;
T.prototype.set = function (x) { this.v = x; };
export function main() {
  var t = new T();
  var before = t.v;        // inherited default read FIRST
  t.set(5);                // own write
  return before + "," + t.v + "," + t.hasOwnProperty("v");
}
```

| lane       | result            |
| ---------- | ----------------- |
| node       | `null,5,true`     |
| gc         | `null,5,true`     |
| standalone | `null,null,true`  |

`hasOwnProperty("v")` is `true`, so the write LANDED on the instance; the READ
is wrong. Without the prior read the same program is correct on standalone
(`.tmp/sp14.js`: `5,5,true,v,true`), and the read through a method
(`.tmp/sp20.js`, `t.get()` before/after) fails the same way: `null,null,null,true`.
The value's representation is irrelevant (number `.tmp/sp16.js`, object literal
`.tmp/sp17.js`, fnctor instance `.tmp/sp18.js` all pass when there is no prior
read).

## Root cause (suspected — behaviour pins it to the read path; exact arm to confirm)

The standalone `__extern_get` carries the #3673 per-key prototype-lookup cache:
the interned key (`$HashedString`) remembers the OWNER prototype and its
`$PropEntry` after the first inherited hit (`unshiftExternGetProtoCacheArm`,
`src/codegen/object-runtime.ts:9876+`; the per-fnctor inline variant in
`fillFnctorPrototypeDispatchArms`, `:9543-9610`; population at the
data-property branch, `:1976-2000`). The hit guard is "populated flag + owner
proto `ref.eq` + owner props-array `ref.eq` + live-DATA entry flags"
(`:9882`) — it checks that the PROTOTYPE is unchanged but never that the
RECEIVER has not gained an own property with that key since. For a
`$__fnctor_T` receiver the own write goes to the instance's expando storage
(`$bag`, #4194/#4241) and the next read takes the cache hit first
(§10.1.8.1 OrdinaryGet step 1-2 requires the own lookup FIRST). Staleness is
tracked per owner object (round 21), so an own write on a different object
(the receiver) never invalidates it.

## Implementation Plan

Lanes: standalone/WASI only (gc is correct; linear n/a).

1. Confirm by disabling the cache arm (`unshiftExternGetProtoCacheArm` early
   return) and re-running `.tmp/sp19.js`/`.tmp/sp20.js`/`.tmp/sp11.js` — if they
   pass, the arm is the cause; if not, instrument the `__extern_get` fnctor
   arm's own-storage probe order (`$bag` / presence bits vs `__fnctor_proto_start`).
2. Fix at the hit guard, not the write path: before taking a cache hit for
   receiver `R`, require that `R` has NO own entry for the key — for a
   `$__fnctor_<F>` receiver that is "field not present (presence bit) AND
   `$bag` is null or lacks the key"; for an `$Object` receiver the hit arm is
   already preceded by the own-props probe, so only the fnctor arms (`:9543`)
   need the check. The extra cost is one presence-bit test + one null test per
   hit on the fnctor fast path; measure on the acorn standalone lane (#3673's
   benchmark) and keep the round-12 cache if the delta is within noise.
   Alternative (rejected unless 2 is too slow): invalidate at the write — the
   `__extern_set` fnctor-bag arm would have to find every `$HashedString` whose
   cached owner is this receiver's prototype, which the key-indexed cache
   cannot do cheaply.
3. **Tests** (`tests/issue-6946-own-write-shadows-proto-default.test.ts`,
   standalone + gc vs node): sp19, sp20, sp11, sp12 (`true,5,false,7`), and
   controls: a read-after-write with NO prior read (sp14) stays `5`; an
   inherited METHOD read before/after an own write of the same name
   (`t.f = function(){}` shadowing `T.prototype.f`) dispatches to the own
   function; `delete t.v` after the own write reveals the default again.
4. **Acceptance**: Octane `splay.js` on standalone reaches #6947's call-site
   issue or passes (`.tmp/octane-probe-patched.mjs standalone`); standalone
   test262 floor unchanged; `pnpm run check:ir-fallbacks` unchanged.

## Ownership note

`src/codegen/object-runtime.ts` is Session A's WasmGC/shared-IR area; Session C
implements at the project lead's direction. Functions touched:
`unshiftExternGetProtoCacheArm`, the inline cache in
`fillFnctorPrototypeDispatchArms`, and the `__extern_get` registration-time
population branch (`:~1976`).
