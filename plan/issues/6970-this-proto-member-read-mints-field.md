---
id: 6970
title: "standalone: a `this.<m>` VALUE read inside a fnctor constructor (`this.init.apply(this, arguments)`) auto-registers `m` as an OWN struct field from the TS instance type, shadowing `F.prototype.m` → undefined (box2dweb `K.b2X.apply(this,arguments); this.constructor===K&&this.b2X.apply(this,arguments)` idiom, 48 sites in Octane box2d)"
status: in-progress
assignee: ttraenkler/claude-session-d
sprint: current
created: 2026-10-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, prototype
goal: standalone-gap
related: [874, 6938, 5180, 2660, 6951, 6954]
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
---

# `finalizeStructAndDynamicMemberGet` mints a struct field for a prototype method read through `this`

Found by the Octane standalone triage (Session D, 2026-10-11), one failure past the parseInt
blocker (`.tmp/#6969`): box2d then fails with
`Cannot read properties of undefined (reading 'SetV')` — instrumented (`.tmp/patch-box2d-setv.mjs`)
the undefined receiver is `this.m_xf.position`, i.e. a `b2Transform` instance whose box2dweb
"constructor body" never ran.

## Minimized (`.tmp/bx18.js`, node `5`, standalone `TypeError: Cannot read properties of undefined (reading 'apply')`)

```js
function K() { this.init.apply(this, arguments); }
K.prototype.init = function (v) { this.r = v; };
export function main() { return new K(5).r; }
```

- `.tmp/bx26.js` (fold-proof): `var x = this.init; this.same = x === K.prototype.init; this.und =
  x === undefined` → node `true:false`, standalone `false:false` — `x` is the struct field's NULL.
- Controls: `.tmp/bx25.js` (`this.init(v)` CALL form) passes; `.tmp/bx22.js` (`var p =
  K.prototype; p.init = …`) passes; `.tmp/bx11/12/13` (static `K.s`, `K.init.apply`) pass.
- WAT (`.tmp/bx18.js.wat`): `(type $__fnctor_K (struct … (field $init (mut externref))))` vs
  bx22/bx25 without `$init`.

## Root cause

`src/codegen/property-access-dispatch.ts` `finalizeStructAndDynamicMemberGet` (~4701-4800): when the
receiver resolves to a struct type and the property is not a known field, it "auto-registers the
property from the TS type" — `objType.getProperties()` of a JS constructor-function instance type
INCLUDES the prototype methods, so `init` is appended as an own field (`fields.push(newField)`,
line 4765; traced with a Proxy on the reserved field list) and the read becomes a `struct.get` of a
never-written slot. The #6938 guard `fnctorProtoMemberRead` declines this only for NON-`this`
receivers (`expr.expression.kind !== ts.SyntaxKind.ThisKeyword`); `this.<m>` inside the ctor body
(`fctx.thisStructName = __fnctor_K`) still takes the auto-registration arm. The call form never
reaches this arm (method-call dispatch has prototype arms), which is why only VALUE reads break.

## Implementation Plan

**File: `src/codegen/property-access-dispatch.ts`, `finalizeStructAndDynamicMemberGet` (~4707)**

1. Widen the #6938 guard: also decline auto-registration for a `this` receiver when the TS property
   is NOT declared by a `this.<p> = …` write — i.e. compute `tsProp = objType.getProperties().find(
   p => p.name === propName)` and treat it as a prototype member when `tsProp.declarations` is
   non-empty and none of them is a `this`-rooted `PropertyAccessExpression` (or a `BinaryExpression`
   whose LHS is one). Then `fnctorProtoMemberRead = isFnctor && (receiverIsNotThis ||
   thisReadOfNonOwnMember)` and the read takes the existing dynamic route (`__extern_get` →
   `__fnctor_proto_start`), exactly as a non-`this` receiver does today.
   Simulated patch: `/home/user/js2/.claude/worktrees/agent-af047ca9deb401f6e/.tmp/sim-fix-5-this-proto-member-read.diff`.
2. Prefer `ctx.oracle.declarationsOf(expr.name)` over `tsProp.declarations` if the oracle ratchet
   complains (the function already uses the checker heavily; check `check-coercion-sites`/oracle
   gates before choosing).
3. Do NOT touch `deriveFnctorFields` — the ctor-write derivation is correct; the leak is only the
   read-site auto-registration.

### Measured with the simulated fix
- `.tmp/bx18/bx17/bx23/bx10` → node-identical; `.tmp/bx26.js` → `true:false`; controls
  `bx25/bx11/bx13/bx22` unchanged.
- **Residual, NOT fixed by this change — separate sub-cause (`.tmp/bx28.js`, node `number:number`,
  standalone `reading 'apply'`):** the same idiom with the fnctor declared INSIDE an IIFE
  (`(function(){ function w(){ … this.b2T.apply(this, arguments) } w.prototype.b2T = …; Box2D.make
  = function(){ return new w(); } })()`). Top-level twin `.tmp/bx27.js` passes; nested fnctor call
  form `.tmp/bx30.js` and outside reads/calls `.tmp/bx31/bx32.js` pass. WAT (`.tmp/bx28.js.wat`):
  `$__fnctor_w_new` is `unreachable` (instances are driver-created `$Object`s), the struct has no
  `b2T` field, and the in-ctor read goes through `__extern_get(this, "b2T")` (`$w` ~93542/93708)
  and still answers undefined → the instance's [[Prototype]] is not linked to `w.prototype` DURING
  the ctor body, while the outside route (`__fnctor_proto_start`) recovers it. Suspect:
  `__object_create(__extern_get(wClosure, "prototype"))` seeds a null proto because
  `closurePrototypeEdgeGetArm` only knows top-level singletons (closure-prototype-edge.ts header:
  "a nested function memoized in a LOCAL … absent from the table"). Next step: probe
  `Object.getPrototypeOf(this) === w.prototype` inside vs after the ctor in bx28, then route the
  nested-fnctor `prototype` read through the per-fnctor prototype global the outside route uses.
  Octane box2d's 48 wrappers are ALL IIFE-nested declarations, so box2d needs this residual too.

### Acceptance
- `tests/issue-<id>.test.ts` standalone vs node: `.tmp/bx18.js` → `5`; `.tmp/bx26.js` →
  `true:false`; `.tmp/bx21.js`/`.tmp/bx28.js` → node-identical (residual); controls
  `bx22/bx25/bx30/bx31/bx32` unchanged; a fnctor with a REAL own field written in the ctor and
  read before the write (`function F(){ var a = this.x; this.x = 1; }`) still types `x` as a field.
- box2d: `node --import tsx .tmp/octane-sa.mjs box2d --script --no-eval --patch
  .tmp/patch-box2d-parseint.mjs` (compile ≈200 s) must pass `m_xf.position`; then the harness
  `pnpm run -s benchmark:octane -- --only box2d --lanes node,standalone --timeout 600`.
- Size: **M** (S for step 1 alone; the nested-fnctor residual is the M half).

## Implementation notes (2026-10-11)

### Step 1 — `this.<m>` read of a prototype member (property-access-dispatch.ts)

On `origin/main` the #6938 guard (`fnctorProtoMemberRead`, non-`this` receivers) is not present
(it lives on `c-octane-integ`), so the step-1 decline is NOT a widening of that guard: it is a
separate module-level predicate `isThisReadOfFnctorPrototypeMember(typeName, expr, tsProp)`
consulted at the field auto-register arm (`if (tsProp && !isThisReadOfFnctorPrototypeMember(…))`).
That keeps the change orthogonal to #6938 — the two compose without a textual conflict on the
`if (typeName && …)` line. The predicate is true for a `__fnctor_*` struct, a `this` receiver,
and a TS property whose declarations are non-empty and include no `this`-rooted write
(`this.p = …` / `this[p] = …`); the read then takes the existing dynamic `__extern_get` route.
No checker query is added (it reads `tsProp.declarations` of the symbol the arm already holds).

Measured (standalone, Script goal, no eval provider): `bx18/bx17/bx23/bx10` node-identical on
`main`; on `c-octane-integ` additionally `bx26` → `true:false` (on `main` `bx26` reads
`true:true`: the in-ctor `__extern_get(this,"init")` misses because `main` lacks #6949/#6951's
prototype materialization/snapshot). Controls `bx22/bx25/bx11/bx13/bx27/bx29/bx30` unchanged.
`tests/issue-6970-this-proto-member-read.test.ts`: base 8/16, head 16/16.
