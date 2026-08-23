---
id: 4647
title: "runtime-eval: provider-minted Function(...).call/.apply lose this-binding writes and argument marshalling; Function.prototype.bind unimplemented in standalone — 16-row built-ins/Function/prototype block"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime-eval
es_edition: 5
language_feature: call-apply-bind
goal: standalone-gap
related: [4642, 4639, 4637, 4643, 4429, 4442]
origin: "wave-4 lead sweep (2026-08-23) on campaign HEAD: 16 rows in built-ins/Function/prototype, all re-verified failing; bucketed by the lead from per-row errors + test source reads."
---

# #4647 — provider-minted call/apply this-binding + bind

## Problem (lead-measured on campaign HEAD, 2026-08-23)

Three subfamilies inside the 16-row `built-ins/Function/prototype` block
(all rows re-verified failing by the lead's sweep; exact rows below):

**A. Provider-minted function + `.call`/`.apply` with a this-binding
(eval tier).** e.g. `call/S15.3.4.4_A6_T1.js`:

```js
Function("a1,a2,a3", "this.shifted=a1;").call(null, [1]);
// this["shifted"] must be the Array [1] on the global this
```

and `apply/S15.3.4.3_A5_T8.js`:

```js
var obj = Function();
new Function("this.touched= true; return this;").apply(obj);
// obj.touched must be true
```

Errors: `obj.touched expected true`, `this["shifted"]` undefined,
`obj["shifted"]` expected "42" — the write into the bound `this` either
lands elsewhere or the argument array does not cross. Some rows die
harder: `Cannot access property on null or undefined at 263:18` (a
runtime helper crash — locate which helper owns source offset 263 in the
harness module and name it in the fix record).

**B. Inherited `.apply`/`.call` through a function-valued prototype.**
`apply/S15.3.4.3_A1_T1.js`: `FACTORY.prototype = Function(); obj = new
FACTORY(); typeof obj.apply` → `undefined`, expected `"function"`. This
is exactly #4643's read-through-callable-proto gap — VERIFY on a tree
containing #4643's fix before touching anything here; expected outcome
is that #4643 heals subfamily B and this lane only pins it. Cross-lane
rule: methodology item 7 (a claim about #4643's effect needs an arm
containing #4643's change).

**C. `Function.prototype.bind` in standalone.**
`bind/S15.3.4.5_A5.js` throws `Function.prototype.bind is not yet
implemented in --target standalone`; `bind/15.3.4.5-2-6.js` and
`bind/15.3.4.5-2-8.js` fail downstream of the same gap
(`(o == 42) !== true`, `[object WebAssembly.Exception]`). There is prior
bind plumbing in the host lane — find it, and give standalone a
Wasm-native path per the dual-mode rule (no new host import without a
standalone fallback).

## Affected rows (all 16, sweep-verified)

```
built-ins/Function/prototype/call/S15.3.4.4_A1_T1.js   (typeof obj.call)
built-ins/Function/prototype/call/S15.3.4.4_A1_T2.js
built-ins/Function/prototype/call/S15.3.4.4_A5_T8.js   (obj.touched)
built-ins/Function/prototype/call/S15.3.4.4_A6_T1.js   (this["shifted"] ctor)
built-ins/Function/prototype/call/S15.3.4.4_A6_T2.js
built-ins/Function/prototype/call/S15.3.4.4_A6_T6.js   (obj["shifted"]="42")
built-ins/Function/prototype/call/S15.3.4.4_A7_T6.js   (helper crash 263:18)
built-ins/Function/prototype/apply/S15.3.4.3_A1_T1.js  (subfamily B)
built-ins/Function/prototype/apply/S15.3.4.3_A1_T2.js  (subfamily B)
built-ins/Function/prototype/apply/S15.3.4.3_A5_T8.js  (obj.touched)
built-ins/Function/prototype/apply/S15.3.4.3_A7_T6.js
built-ins/Function/prototype/apply/S15.3.4.3_A8_T6.js  (helper crash 263:18)
built-ins/Function/prototype/S15.3.5.2_A1_T1.js        (f.hasOwnProperty('prototype'))
built-ins/Function/prototype/bind/S15.3.4.5_A5.js      (subfamily C)
built-ins/Function/prototype/bind/15.3.4.5-2-6.js      (subfamily C)
built-ins/Function/prototype/bind/15.3.4.5-2-8.js      (subfamily C)
```

## Implementation Plan

1. Brief: `plan/method/es5-standalone-agent-brief.md` (binding), incl.
   methodology item 7 and the eval-tier pin rule (item 5) — most of this
   family mints from body strings, so every pin needs an interpreter-tier
   arm.
2. Subfamily A first (largest): trace one row end-to-end. The reference
   surface is the `__current_this` save/install/restore discipline
   (#4429, `src/codegen/type-coercion.ts` `emitWithCurrentThis`) and the
   provider apply path (`__runtime_apply_interpreted`,
   `scripts/runtime-eval-provider.mjs`). Establish by instrumentation
   whether the this-binding is dropped compiler-side (call/apply arm
   doesn't pass the receiver to the provider bridge) or provider-side
   (envelope has no receiver slot). Fix at the owning layer; the other
   layer gets a decline-with-comment, not a workaround.
3. Subfamily B: run the two A1 rows on a tree with #4643's fix merged
   (coordinate with that lane / ask the lead for the combined tree).
   Expected: healed there. If NOT healed, the residual is a distinct
   read path — document and hand exact evidence to #4643's lane; do not
   fix it here.
4. Subfamily C: implement standalone `bind` — a Wasm-native bound-thunk
   (closure struct carrying target + bound this + partial args), NOT a
   host import. Reference: `function-intrinsic-carrier.ts` (#4442) for
   identity-stable carriers, `construct-return-value.ts` (#4464) for
   [[Construct]] semantics of bound functions (new on a bound fn ignores
   bound this).
5. Companion issue **#4642** (implicit completion crosses as null —
   same provider territory, plan in its file) belongs to this lane:
   verify its hypothesis first as written there; the provider rebuild +
   eval-corpus sweep it prescribes covers this issue's verification too.
6. Pins: `tests/issue-4647.test.ts`, both tiers (quickjs + interpreter),
   every subfamily exercised (pin-exercises-the-shape rule: the pin must
   perform the this-bound WRITE and read it back, not assert shapes).
7. Verification floor per brief: scoped sweep over
   `built-ins/Function/prototype` before/after from your own runs; zero
   regressions; eval-dependent rows need the quickjs artifact
   (`JS2WASM_QUICKJS_ARTIFACT_DIR=/home/user/js2wasm/.test262-cache/quickjs-artifact-2e2d7736713beeda`
   or copy `.test262-cache/` in — fresh-worktree trap in the brief).
