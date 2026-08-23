---
id: 4647
title: "runtime-eval: provider-minted Function(...).call/.apply lose this-binding writes and argument marshalling; Function.prototype.bind unimplemented in standalone — 16-row built-ins/Function/prototype block"
status: in-progress
assignee: dev-4647
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

## Root cause

All 16 rows re-verified failing on this branch's base (campaign HEAD
`52cb0a6a6`), quickjs tier, this lane's own runs. Three distinct causes, not
one:

### A. The split is by RUNTIME REPRESENTATION, not by `call`/`apply`

"The this-binding write lands elsewhere" is not uniform. Measured with one
compiled module per probe (identity-isolation, methodology 3):

| value / receiver crossing the provider seam | base | this branch |
| --- | --- | --- |
| new realm global assigned a PRIMITIVE | ok | ok |
| new realm global assigned a compiled ARRAY | LOST | **ok** |
| new realm global assigned a compiled OBJECT | LOST | **ok** |
| receiver = demoted/dynamic object (get + set) | ok | ok |
| receiver = compiled ARRAY, GET (`this[1]`, `this.length`) | ok | ok |
| receiver = compiled ARRAY, SET (write-back) | LOST | LOST |
| receiver = SHAPE-TYPED object literal `{pre:44}` | LOST | LOST |
| receiver = compiled FUNCTION (closure struct) | LOST | LOST |

Two independent defects live under that table.

**A1 — the one this lane fixed.** `qjsMirrorRealmProperty`
(`scripts/quickjs-eval-provider.mjs`) mirrors a realm global that did NOT exist
at entry back to the caller, and did so for PRIMITIVE tags only. The comment
justified that as "publishing an arbitrary new object global here would
silently turn a live realm property into a seam-snapshot box" — true for a real
QuickJS object, and **false for an inward membrane wrapper**, which is not a
QuickJS object at all but one of our own compiled objects wearing a QuickJS
face. `qjsToGc` → `qjsPublish` collapses such a handle straight back to
`gcRegistry[id]` (#4245 slice 2), i.e. the caller's ORIGINAL object, same
identity, no box. Refusing it did not protect the caller's value; it made the
caller's value unreachable.

`Function("a1,a2,a3","this.shifted=a1;").call(null,[1])` is exactly that: sloppy
`this` is the realm, so the assignment creates a fresh realm global whose value
is the wrapper for the caller's `[1]`. The **scalar** form of the identical
write already worked on base, which is what localises the defect to the tag
filter rather than to the receiver plumbing or the global mirror.

**A2 — NOT fixed here, precisely characterized instead.** A compiled object
whose runtime representation is a **module-private nominal struct** is opaque
to the provider's dynamic property runtime. Two producers of such structs:
a shape-inferred object literal (`{pre:44}` lowers to `(struct (field f64))`,
`local $o (ref null 45)` in the WAT — a type index unique to that module's
shape table) and a closure struct (`var obj = Function()` is AOT-synthesized by
#2924, so it is an ordinary compiled closure). The provider has no matching
type declaration and cannot `ref.cast` to it, so its `target[key]` answers
`undefined` and its `target[key] = v` is a silent no-op — the write does not
even stick inside the provider (`Function("this.z=9; return this.z;").call(g)`
returns `undefined`). The canonical `$Object` dictionary round-trips fully and
the vec/array carrier round-trips for reads.

This is an architectural gap, not a patch: making it work needs either a
REVERSE membrane (the caller hands the provider get/set callbacks bound to the
object — the provider can already call compiled closures via `__apply_closure`)
or an escape rule that keeps any object reaching a runtime-eval boundary in the
canonical representation from ALLOCATION time (identity-preserving; converting
at the crossing is not, because the caller keeps the original). Deliberately
declined rather than patched blind (methodology 4).

### B. inherited `.apply`/`.call` through a function-valued prototype

Verified on THIS branch's base only: `apply/S15.3.4.3_A1_T{1,2}` and
`call/S15.3.4.4_A1_T{1,2}` all fail with `typeof obj.{apply,call}` ===
`"undefined"`. Untouched by this lane. Per methodology item 7, this lane
CANNOT claim anything about #4643's effect on them — a tree containing #4643's
change is required, measured by that lane or by the session lead on the
combined tree. Recorded here as "still failing on 52cb0a6a6 + this branch's
diff", nothing more.

### C. `bind`

`bind` is NOT unimplemented in standalone — probed on base, user-function
`bind` already works for this-binding, partial application, `.length` and
`.name` (`b.name === "bound f"`). What the three rows need is the part that
does not:

| probe (base) | result |
| --- | --- |
| `f.bind(o)()` this-binding | ok |
| `f.bind(null,10)(5)` partial args | ok |
| `b.length` / `b.name` | ok |
| `new (f.bind(null))(7)` | throws |
| `Object.bind(null)(42)` | wrong value |
| `Array.bind(null)(3)` | `RuntimeError: dereferencing a null pointer` |
| `Function.prototype.bind.apply(f,[…])` | throws the §"not yet implemented" refusal |

The refusal message the issue quotes comes from the generic
`genericThrowBody` arm in `src/codegen/builtin-value-read.ts` — it is the
`Function.prototype.bind` **value read**, not `bind` itself. All three rows
bind a BUILTIN constructor (`Date`, `Object`, `Array`) and two of them then
[[Construct]] through it, so closing them means `%Function.prototype.bind%` as
a first-class value + bound-of-builtin + curried `[[Construct]]` on builtin
carriers. `src/codegen/construct-bound.ts` (#4196) already implements
§10.4.1.2 for user targets; the missing pieces are the builtin-carrier arms.
Left for a dedicated slice — see Residuals.

## Fix

`scripts/quickjs-eval-provider.mjs`, `qjsMirrorRealmProperty`: admit an inward
membrane-wrapper handle alongside the mirrorable primitive tags —

```ts
const crossable: boolean = qjsIsMirrorableTag(tag) || qjsIsMembraneWrapperHandle(h);
```

`qjsIsMembraneWrapperHandle` already existed as a write-back GUARD; its
doc-comment (which read as a blanket "never cross a wrapper") is updated to
name both callers and why their intents are opposite. Adapter rebuilt with
`npx tsx scripts/build-quickjs-eval-provider.mjs` → key `fb007972febf3c42`
(canary-verified by the build script); CI rebuilds it from source
automatically, since the adapter cache key is `sha256(adapter source ∥ compiler
bundle hash)`.

Nothing in `src/codegen/object-runtime.ts` (dev-4643) or the descriptor MOP
(dev-4491) was touched.

## Test Results (runs executed by this lane)

Scoped standalone sweep, `built-ins/Function/prototype` (309 files), both arms
run by this lane's own driver. **The base arm was re-run against a
freshly-built base-source adapter** after the artifact-staleness finding
recorded in #4642 — a stale base can HIDE a regression, so the floor claim
rests on the true base, not the first one:

| arm | pass | fail | compile_error |
| --- | --- | --- | --- |
| base (52cb0a6a6, rebuilt base adapter) | 228 | 76 | 5 |
| this branch | 231 | 74 | 4 |

**+2 real flips, zero regressions.** The diff shows 3 flips; the third,
`built-ins/Function/prototype/S15.3.3.1_A1.js`, is a **flake, not a flip** —
its base entry is `compile_error: compilation timeout (20342.58ms)` under a
loaded box, and it passes on both arms otherwise. Named rather than counted.

Adapter provenance for both arms: this worktree has **no
`scripts/compiler-bundle.mjs`**, so `loadProviderCompiler` took the
`src/index.ts (tsx)` path and each adapter was compiled by the LIVE source of
its own arm (`bundle no-bundle` in both build logs) — base adapter
`1429ec7ecf2163fd` built with base sources checked out, branch adapter
`fb007972febf3c42` with branch sources. No stale-bundle exposure.

`tests/issue-4647.test.ts` — 8 tests: 5 positive pins + 3 `it.fails` residual
pins, each of which performs the this-bound WRITE and reads it back.
**8 passed** on the quickjs tier; **5 passed / 3 skipped** under
`JS2WASM_EVAL_ENGINE=interpreter` (the residual pins are skipped there because
the refusal provider's throw would make an `it.fails` pin pass for the wrong
reason). Both positive realm-global pins verified to FAIL on base by file-copy
revert of `scripts/quickjs-eval-provider.mjs`; the primitive/demoted-object/
array-read pins pass on BOTH arms by design — they are the localisation
controls.

Named sibling suites, this branch: `tests/issue-4639.test.ts` +
`tests/issue-4442.test.ts` → **30 passed**; `tests/issue-4464.test.ts` →
**20 passed**; `tests/issue-4642.test.ts` → **6 passed** on each tier.

Row-level, `runTest262File(..., "standalone")`, base vs this branch:

| row | base | branch |
| --- | --- | --- |
| `call/S15.3.4.4_A6_T1.js` | fail | **pass** |
| `call/S15.3.4.4_A6_T2.js` | fail | **pass** |
| `call/S15.3.4.4_A1_T1.js` | fail | fail (subfamily B) |
| `call/S15.3.4.4_A1_T2.js` | fail | fail (subfamily B) |
| `call/S15.3.4.4_A5_T8.js` | fail | fail (A2) |
| `call/S15.3.4.4_A6_T6.js` | fail | fail (A2) |
| `call/S15.3.4.4_A7_T6.js` | fail | fail (construct-through-provider, #4438) |
| `apply/S15.3.4.3_A1_T1.js` | fail | fail (subfamily B) |
| `apply/S15.3.4.3_A1_T2.js` | fail | fail (subfamily B) |
| `apply/S15.3.4.3_A5_T8.js` | fail | fail (A2) |
| `apply/S15.3.4.3_A7_T6.js` | fail | fail (A2) |
| `apply/S15.3.4.3_A8_T6.js` | fail | fail (construct-through-provider, #4438) |
| `S15.3.5.2_A1_T1.js` | fail | fail (function own `prototype`) |
| `bind/S15.3.4.5_A5.js` | fail | fail (C) |
| `bind/15.3.4.5-2-6.js` | fail | fail (C) |
| `bind/15.3.4.5-2-8.js` | fail | fail (C) |

## Status — PARTIAL, deliberately

2 of the 16 rows closed. `status` stays `in-progress`, not `done`: the
remaining 14 are not "not yet attempted", they are four **named** causes with
owners (below), three of which belong to other lanes and one of which (A2) is
an architectural change this lane declined to make blind. The lead should
decide whether to split A2 and C into their own issues and close this one.

The lead re-verified all 16 rows still failing on the rebuilt shared adapter
(2026-08-23), so the scope above is measured against a fresh provider on both
sides, not a stale cache.

## Residuals (with owners)

- **A2 — module-private struct receivers are opaque at the provider seam.**
  Blocks `call/apply S15.3.4.3_A5_T8`, `call/S15.3.4.4_A6_T6`,
  `apply/S15.3.4.3_A7_T6`, and the array write-back. Needs a reverse membrane
  or an allocation-time escape rule (see A2 above). Owner: runtime-eval +
  value-rep (#2660) jointly — this is the same "canonical vs bespoke struct"
  axis #2660 already owns.
- **`new` on a provider-minted callable** (`call/S15.3.4.4_A7_T6`,
  `apply/S15.3.4.3_A8_T6`; the crash is the harness's own
  `undefined.p1` read after `new` produced nothing). Owner: #4438
  (runtime-eval construct), already an open lane.
- **Subfamily B** — untouched here on purpose; see B above. Owner: #4643.
- **Subfamily C — bind of a BUILTIN constructor + curried `[[Construct]]`,
  and `%Function.prototype.bind%` as a first-class value.** Three rows.
  Owner: unassigned; `src/codegen/construct-bound.ts` + the
  `genericThrowBody` arm in `src/codegen/builtin-value-read.ts` are the two
  edit points.
- **`f.hasOwnProperty('prototype')` is FALSE for every compiled function**
  (declared, expression and `Function(...)`-synthesized alike), and a
  `Function(...)`-synthesized function has no `prototype` object at all while
  a declared one does. Blocks `S15.3.5.2_A1_T1`, which additionally needs
  `prototype` non-configurable and `delete f.prototype === false`. Owner:
  function-instance own properties (#4436/#4437).
