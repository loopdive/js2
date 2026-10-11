---
id: 6968
title: "standalone: `<non-fnctor expr>.prototype = { … }` (closure returned from a call / member-held `Class.create()` ctor) stores a CLOSED-struct literal; the native construct driver's `__object_create(proto)` then seeds `$proto = null` → instances get `%Object.prototype%` (Octane raytrace `Flog.RT.Color.prototype = {…}`)"
status: ready
sprint: current
created: 2026-10-11
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: compiler
language_feature: constructor-functions, prototype
goal: standalone-gap
related: [874, 802, 4163, 3981, 6951, 2660]
---

# A dynamic `.prototype = {literal}` write keeps the literal's closed-struct representation

Found by the Octane standalone triage (Session D, 2026-10-11). raytrace's Prototype-style classes
are `Flog.RT.Color = Class.create(); Flog.RT.Color.prototype = { initialize: function(){…}, … }`
where `Class.create()` returns `function () { this.initialize.apply(this, arguments); }`. After
the typeof-guard fix (companion `.tmp/#6967`), `new
Flog.RT.Color(2)` throws `Cannot read properties of undefined (reading 'apply')` (`.tmp/rta1.js`).

## Minimized (`.tmp/rtb8.js`, node `11`, standalone `100`)

```js
function create() { return function () { this.y = 1; }; }
var P = create();
P.prototype = { init: function () { return 5; } };
/** @returns {number} */
export function main() {
  var p = new P();
  return (Object.getPrototypeOf(p) === P.prototype ? 1 : 0) + (p.init ? 10 : 0)
       + (Object.getPrototypeOf(p) === Object.prototype ? 100 : 0);
}
```

Bisection (all node-identical unless noted):
- `.tmp/rtb7.js` — `P.prototype === X` and `P["prototype"] === X` are TRUE: the bag write and
  both reads work. `.tmp/rtb6.js` — user-level `Object.create(X)` works.
- `.tmp/rtb2.js` / `rtb3.js` — `function P(){}` / `var P = function(){}` (resolvable fnctors) work:
  `tryCompileFnctorPrototypeAssign` builds the literal as `$Object`
  (`compileObjectLiteralAsExternref`, fnctor-prototype.ts:491-500).
- `.tmp/p7.js` — same as rtb5 but `X = Object.create(Object.prototype)` (an `$Object`) works.
- Fails: `.tmp/rtb1/rtb4/rtb5/rtb8/p6.js` — ctor is a closure value (`var P = create()`), RHS is
  an object literal (inline or via `var X = {…}`).

## Root cause

1. `P` is not a user fnctor symbol (`resolveFnctorSymbol` needs an identifier resolving to a
   function), so `P.prototype = {…}` takes the generic path: `compileExpression(rhs)` builds a
   CLOSED-shape struct for the literal, `__extern_set` → `buildFnctorPrototypeWriteArm`
   (`src/codegen/closure-props.ts:352-466`) `writeOwn()` defines `prototype` in the closure's bag.
   Reads see it (rtb7), identity holds.
2. `new P()` goes through the #3981 native construct driver (`src/codegen/native-construct.ts`
   ~732-755): `proto = __extern_get(callee, "prototype")` → the struct; `__object_create(proto)`
   (`src/codegen/object-runtime-prototype.ts` ~660-712) seeds `$proto = (proto is $Object ? cast :
   null)` and, since the RAW proto is non-null, flags=0 → the implicit terminal is
   `%Object.prototype%`. Hence `100`, `p.init` undefined, raytrace's `this.initialize` undefined.
3. The #4163 proto-source marking in `scanForDynamicProto` (`src/codegen/dynamic-proto.ts:283-304`)
   covers `F.prototype = X` ONLY when `resolveFnctorSymbol` yields an APPROVED fnctor — exactly the
   case that does not need it (fnctor-prototype.ts already promotes). The dynamic-ctor case has no
   mark, so literals.ts (~2300-2320, `ctx.dynamicProtoLiteralNodes.has(expr)`) never promotes.

## Implementation Plan

**File: `src/codegen/dynamic-proto.ts`, `scanForDynamicProto`, the `.prototype =` arm (293-304)**

1. Widen the arm: for `node.left.name.text === "prototype"` compute `sym =
   resolveFnctorSymbol(ctx.checker, node.left.expression)`. If `sym` is undefined (member chain,
   call-returned closure binding, element access, `this.X` …) OR the existing approved-fnctor
   condition holds:
   - if `node.right` (unwrapped) is an `ObjectLiteralExpression` → `ctx.dynamicProtoLiteralNodes
     .add(rhs)` (direct literal — `markProtoSource` only follows identifiers);
   - else `markProtoSource(node.right)` (identifier → its literal initializer, rtb5/p6 shape).
   Keep the resolved-but-unapproved fnctor behaviour unchanged (the #2660 S2 header's −40 floor
   note), i.e. only add the `sym === undefined` disjunct. Standalone-gate the new disjunct
   (`ctx.standalone`) like the colon-`__proto__` arm, so gc/host/wasi bytes do not move.
2. `literals.ts` then builds the literal as `$Object` and `variables.ts`/`index.ts` type a
   `var X = {…}` slot externref in lockstep (existing Slice-A plumbing) — no further change.
3. Defensive (optional, separate commit): in `buildFnctorPrototypeWriteArm.writeOwn()` nothing
   changes; but consider making `__object_create` LOG/trap under a debug env when `proto` is a
   non-null non-`$Object` (today it silently reparents to Object.prototype — this is the amplifier
   that hid the bug behind "reading 'apply'").

### Edge cases
- `P.prototype = someFnctorInstance` / `= new Q()` — not a literal; unchanged (already `$Object`
  when Q is reconstructed, else a known gap, out of scope).
- Literal with accessors/spread already takes the open path (`objectLiteralForcesHostPath`).
- The literal is also referenced elsewhere as a closed struct (`var X = {…}; X.init(); P.prototype
  = X`): the binding becomes externref everywhere — correct but slower; same as #4163's trade.
- `F.prototype.p = v` per-prop writes are unaffected (bag/proto-edge path).

### Measured with the simulated fix (step 1 exactly, uncommitted in
`/home/user/js2/.claude/worktrees/agent-af047ca9deb401f6e/src/codegen/dynamic-proto.ts`, diff vs
`.tmp/base/dynamic-proto.ts`; also saved in `.tmp/sim-fixes.diff`)
- `.tmp/rtb8/rtb5/rtb4/p6.js` → `11`; `.tmp/rtb7.js` → `17`; `.tmp/rta1.js` → `2`; controls
  `.tmp/rtb2/rtb3/rtb6/p7` unchanged.
- raytrace with BOTH companions applied: `node --import tsx .tmp/octane-sa.mjs raytrace --script
  --no-eval` → `standalone run -> 1`, teardown ok (compile 6.3 s). No further functional
  failure; per-rep cost ≈ 370 ms standalone (20 reps ≈ 7.1 s).

### Acceptance
- `tests/issue-<id>.test.ts` standalone vs node: `.tmp/rtb8.js` → `11`; `.tmp/rtb5.js`/`p6.js` →
  `11`; `.tmp/rtb4.js` → `11`; `.tmp/rta1.js` → `"2"`; controls `.tmp/rtb2/rtb3/rtb6/rtb7/p7`
  unchanged.
- raytrace (together with the typeof-fold companion): `pnpm run -s benchmark:octane -- --only
  raytrace --lanes node,standalone --timeout 600`. Triage verdict with both simulated fixes
  (`.tmp/harness-raytrace.log`, `benchmarks/results/octane-latest.json`): node `pass` (82 reps,
  945 µs/rep); standalone `skipped: timeout after 180s (run, reps 82)` — the harness runs warm-up
  + 5 samples × 82 reps ≈ 490 reps × 370 ms. So after this fix the remaining raytrace blocker is
  PERFORMANCE (~390× node), not correctness; the acceptance for THIS issue is that
  `octane-sa.mjs raytrace` completes and the harness row is no longer an error row.
- Size: **S**.
