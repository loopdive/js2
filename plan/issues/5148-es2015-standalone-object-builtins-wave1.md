---
id: 5148
title: "ES2015 standalone: object-builtins conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-28
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime-strict-set.ts
  - src/codegen/object-proto-tostring.ts
  - src/codegen/object-proto-annex-b-accessors.ts
  - src/codegen/object-proto-name-in.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls-guards.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/object-proto-symbol-tag.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/object-runtime-prototype.ts::buildObjectPrototypeHelpers
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# #5148 — ES2015 standalone: object-builtins conformance wave 1

Growth allowance rationale (2026-08-28): this change-set adds spec-mandated
arms to existing standalone natives (Proxy MOP routing in the integrity /
enumeration statics, `__proto__` accessor pair, ToObject wrappers, setPrototypeOf
TypeError paths, @@toStringTag step 14/15) — all net-new Wasm-emission code in
the files listed above, following patterns already present in each file.

`src/codegen/expressions/calls.ts` is a god-file and the +8 lines there are the
MINIMUM: the @@toStringTag steps-14/15 body lives in the new subsystem module
`src/codegen/object-proto-symbol-tag.ts`, and what remains in the driver is the
single `emitObjectProtoToStringWithSymbolTag(...)` call plus its import and the
comment naming the owner (2026-08-28).

## Problem

90 ES2015-bucket test262 files under `built-ins/Object/**` fail on the
standalone target (re-verified against head 2026-08-28 with
`.tmp/run-standalone.mts`: 83 FAIL + 7 COMPILE_ERROR; **0 of the day-old
baseline list have since been fixed**). The failures are spec-semantics gaps in
the native `$Object` runtime — Proxy MOP bypass in the integrity/enumeration
statics, missing `Object.prototype.__proto__` accessor, silent-instead-of-throw
`[[SetPrototypeOf]]`, `Object.assign` fidelity, and the deferred @@toStringTag
step of `Object.prototype.toString`. All are on the critical path to the 100%
ES2015 standalone goal, and several (Proxy MOP routing, ToObject wrappers)
unblock failures in sibling waves too.

Target list (authoritative, one path per line):
`.tmp/es2015/wp-object-builtins-current-fails.txt` (90 paths).
Probe: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`
(split lists >150 lines; individual tests may take up to 20 s).

## Current failure clusters

Counts partition the 90 exactly. Sample paths are relative to `test262/test/`.

| # | Cluster | Count | Root cause (file:function) | Sample tests |
| - | ------- | ----- | -------------------------- | ------------ |
| 1 | Object.* statics bypass the Proxy MOP; ownKeys invariants unenforced | 28 | `call-builtin-static.ts` ~L1666 (freeze/seal/preventExtensions) routes to the flag-setting natives `__object_freeze`/`__object_seal` — SetIntegrityLevel's per-key `[[OwnPropertyKeys]]`/`[[GetOwnProperty]]`/`[[DefineOwnProperty]]` loop never runs, so `$Proxy` receivers never see their traps and trap abrupts don't propagate. Same bypass in `__obj_ordered*` (object-runtime-enumeration.ts) for keys/values/entries/getOwnPropertyNames/getOwnPropertySymbols/getOwnPropertyDescriptors/defineProperties: they walk `$PropMap` directly, no `$Proxy` arm. §10.5.11 ownKeys result-invariants are explicitly deferred in `object-runtime-proxy.ts` (L66, L553-555 "dedicated invariant slice") — that slice is **#5140 Step 2** (predecessor, do not duplicate). | `built-ins/Object/freeze/abrupt-completion.js` · `built-ins/Object/freeze/proxy-no-ownkeys-returned-keys-order.js` · `built-ins/Object/keys/proxy-non-enumerable-prop-invariant-1.js` |
| 2 | `__proto__` accessor missing + setPrototypeOf refusals silent | 21 | (a) B.2.2.1 `Object.prototype.__proto__` accessor pair is not reflectively exposed: `Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')` → undefined, so `desc.get`/`desc.set` derefs throw (~12 tests, the "at 328:11/845:16" family). (b) `__object_setPrototypeOf` (object-runtime-prototype.ts ~L367-520) returns obj silently on the §10.1.2.1 step-3 (non-extensible) and step-4 (cycle) refusals — §20.1.2.21 step 4 requires a TypeError (~7 tests). (c) the dispatch guard `expr.arguments.length >= 2` (call-builtin-static.ts ~L1885) lets `Object.setPrototypeOf({})` / non-coercible O fall to the `__get_builtin` Phase-B refusal → 2 CE; a primitive proto also silently coerces to null instead of throwing. | `built-ins/Object/prototype/__proto__/get-ordinary-obj.js` · `built-ins/Object/setPrototypeOf/set-failure-non-extensible.js` · `built-ins/Object/setPrototypeOf/proto-not-obj.js` |
| 3 | Symbol surface: @@toStringTag step 14/15, symbol-key carrier identity, Object(sym) | 16 | (a) `object-proto-tostring.ts` L718/L939: the Symbol.toStringTag override (§20.1.3.6 steps 14-15) is a documented "deferred phase-2" — 9 `toString/symbol-tag-*.js` tests. (b) redefining a symbol-keyed property via `Object.defineProperty(o, sym, {get})` stores a **fresh** `$Symbol` carrier in the `$PropEntry`, so `Object.getOwnPropertySymbols(o)[i] !== sym` (identity, not order — minimal repro below); collateral in `getOwnPropertyDescriptors/symbols-included.js` (0 symbol descriptors) and `entries/symbols-omitted.js` — 5 tests. (c) `Object(sym)` keeps the "historical identity fallback" in standalone (calls-guards.ts ~L786, #4530/#2728) instead of building a Symbol wrapper `$Object`; `getOwnPropertySymbols(undefined)` misses its ToObject TypeError — 2 tests. | `built-ins/Object/prototype/toString/symbol-tag-str.js` · `built-ins/Object/getOwnPropertySymbols/order-after-define-property.js` · `built-ins/Object/symbol_object-returns-fresh-symbol.js` |
| 4 | Object.assign spec fidelity | 13 | `__object_assign` (object-runtime-enumeration.ts L1081-1264): (a) target ToObject only rejects nullish — a primitive target stays primitive (should become a Number/Boolean/String wrapper object, §20.1.2.1 step 1) — 4 tests; (b) copies via plain `__extern_set` ("no-op on refusal") — frozen/sealed/non-extensible/non-writable targets must **throw** (Set with Throw=true); `__extern_set_strict` (#3983) already exists — 6 tests; (c) source reads don't run the full `[[Get]]` (getter abrupts swallowed; later-source same-key override yields NaN) — 2 tests; (d) a string source's index properties are not copied ("not a $Object → skipped") — 1 test. | `built-ins/Object/assign/Target-Boolean.js` · `built-ins/Object/assign/target-is-frozen-data-property-set-throws.js` · `built-ins/Object/assign/source-get-attr-error.js` |
| 5 | Object.is with <2 args → CE | 4 | `call-builtin-static.ts` ~L3287: the `Object.is` arm requires `expr.arguments.length >= 2`; `Object.is()` / `Object.is(x)` fall through to the generic member path → `__get_builtin` → #1472 Phase-B refusal (COMPILE_ERROR). Missing args are `undefined`; SameValue(undefined, undefined) is true. | `built-ins/Object/is/same-value-x-y-empty.js` · `built-ins/Object/is/not-same-value-x-y-null.js` |
| 6 | Own-key reflection after defineProperty on functions/arrays | 3 | Function receivers: `Object.keys(fn)` after `fn.a = 1; Object.defineProperty(fn, "length", {enumerable: true})` must yield `["length","a"]` — the closure-carrier expando path doesn't surface a redefined-enumerable `length`; `entries/…-with-function.js` returns `[]` outright. Array receivers: `Object.getOwnPropertyNames(arr)` fabricates index keys `0..length-1` for holes after `defineProperty(arr,"length",{value:2})` (actual `[0,1,length,a]`, expected `[length,a]`) — vec reflection path (`vec-props.ts` / `array-length-define.ts`). | `built-ins/Object/keys/order-after-define-property-with-function.js` · `built-ins/Object/getOwnPropertyNames/order-after-define-property.js` |
| 7 | Residual smalls | 5 | (a) `Object.prototype.toLocaleString` must `Invoke(O,"toString")` dynamically — a patched `Boolean.prototype.toString` is not picked up (2). (b) `hasOwnProperty` runs ToObject before ToPropertyKey — §19.1.3.2 order is ToPropertyKey first (1). (c) `proto-from-ctor-realm.js` — cross-realm NewTarget proto (1). (d) `subclass-object-arg.js` — CE: standalone `Reflect.construct` cannot preserve arbitrary NewTarget; same limitation tracked in #5140 cluster 8 / #5139 (1). | `built-ins/Object/prototype/toLocaleString/primitive_this_value.js` · `built-ins/Object/prototype/hasOwnProperty/topropertykey_before_toobject.js` |

Minimal repro for cluster 3(b), confirmed by probe 2026-08-28
(`.tmp/es2015/probes5148/sym-key3.js`, status IDENTITY-failure):

```js
var symA = Symbol("a"); var symB = Symbol("b");
var obj = {}; obj[symA] = 1; obj[symB] = 2;
Object.defineProperty(obj, symA, { get: function() {} });
Object.getOwnPropertySymbols(obj)[0] === symA  // false — fresh carrier
```

Plain symbol-keyed writes and non-redefining symbol `defineProperty` DO work
(probe `sym-key.js` passes) — the defect is confined to the redefine path
replacing the stored key carrier.

## Implementation Plan

Work the clusters in the order below (count-descending; partial completion
maximizes yield). After each step, re-run the probe on that cluster's paths.
Ground rules: **no new host imports without a standalone fallback** (the runner
fails any module emitting host imports — `standaloneHostImportError`); never
edit `tests/test262-runner.ts`, skip lists, or `scripts/*baseline*.json`; new
codegen needing type info goes through `ctx.oracle`, never the raw checker
(oracle-ratchet gate).

**Step 1 — Route Object.* integrity + enumeration statics through the Proxy
MOP (cluster 1, 28 tests).**
1. Coordinate with **#5140** (proxy wave 1, `plan/issues/5140-…`): its Step 2
   implements the §10.5.11 ownKeys post-trap invariant validators inside
   `object-runtime-proxy.ts`. That alone should flip the 8
   `proxy-invariant-*` / `proxy-non-enumerable-prop-invariant-*` tests here.
   **Do not re-implement invariants** — if #5140 is in flight, branch from its
   PR branch (explicit predecessor-stacking per CLAUDE.md) and enqueue after it
   lands; verify claim state with `node scripts/pre-dispatch-gate.mjs 5140`.
2. Add a `$Proxy` receiver arm to the integrity natives. Pattern to copy:
   `fillObjectAssignProxySourceArm` (object-runtime-enumeration.ts:1466,
   #4749) — a post-registration fill that prepends a `ref.test $Proxy` arm to
   an existing native's body, dispatching traps via the
   `__proxy_call_*` drivers in object-runtime-proxy.ts (`PROXY_CALL_OWNKEYS`
   L34, trap ids at L158). For `__object_freeze` / `__object_seal` /
   `__object_preventExtensions` the arm must run real SetIntegrityLevel
   (§7.3.16): `[[PreventExtensions]]` trap first (abrupt propagates —
   `freeze/abrupt-completion.js`), then `[[OwnPropertyKeys]]`, then per key
   `[[GetOwnProperty]]` + `[[DefineOwnProperty]]` in list order (trap-order
   tests assert `["0","foo",sym]` type-ascending fallback ordering, which the
   ordinary-keys forward already produces).
3. Same arm for the read side: `__object_isFrozen`/`__object_isSealed`
   (TestIntegrityLevel §7.3.17: `[[IsExtensible]]`, then ownKeys + per-key
   GOPD), `__obj_ordered`/`__obj_ordered_all`/`__obj_ordered_symbols`
   consumers (`__object_keys`, `__getOwnPropertyNames`,
   `__getOwnPropertySymbols`, `__object_getOwnPropertyDescriptors`, entries/
   values), and `Object.defineProperties` (per-key `[[DefineOwnProperty]]`
   trap, `defineProperties/proxy-no-ownkeys-returned-keys-order.js`).
   `getOwnPropertyDescriptors/proxy-undefined-descriptor.js` additionally
   requires omitting keys whose GOPD trap answers undefined.
4. `isPrototypeOf/arg-is-proxy.js`: `__object_isPrototypeOf`'s proto walk must
   call the proxy `[[GetPrototypeOf]]` trap per hop (trap driver exists —
   `buildProtoDispatch`, object-runtime-proxy.ts ~L378).

**Step 2 — `__proto__` accessor + setPrototypeOf TypeErrors (cluster 2, 21).**
1. Implement B.2.2.1 `Object.prototype.__proto__` as a real accessor pair,
   copying the module pattern of `object-proto-annex-b-accessors.ts` (#4479)
   wholesale: two natives (`get __proto__` → RequireObjectCoercible +
   `__getPrototypeOf`; `set __proto__` → RequireObjectCoercible; if proto is
   neither `$Object` nor null return undefined; if O not an Object return
   undefined; else `[[SetPrototypeOf]]` and **throw TypeError on false**),
   reflective closures with spec `.name` (`"get __proto__"`/`"set __proto__"`
   — `get-fn-name.js`/`set-fn-name.js`) and a
   `Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')` answer of
   `{enumerable: false, configurable: true, get, set}` (`prop-desc.js`). Wire
   the descriptor read the same way #4479 wired its four names into
   `builtin-static-gopd.ts`.
2. Give `__object_setPrototypeOf` (object-runtime-prototype.ts ~L367) a
   throwing variant: keep the silent native for internal callers, add
   `__object_setPrototypeOf_throw` (or an i32 `strict` param) that emits
   `buildThrowJsErrorInstrs(ctx, "TypeError", …)` on the step-3/step-4
   refusals — exactly the mechanism `__object_assign`'s nullish guard already
   uses in this file family. Route `Object.setPrototypeOf` and the new
   `__proto__` setter through it.
3. Fix the call-site guard (call-builtin-static.ts ~L1885): accept
   `arguments.length >= 1`, emit RequireObjectCoercible on O (TypeError for
   null/undefined — `o-not-obj-coercible.js`), and a "proto must be Object or
   null" TypeError for a missing or primitive proto (`proto-not-obj.js`)
   instead of the silent null-coercion in `canonicalizeProtoArg`. This removes
   both CEs without touching `__get_builtin`.

**Step 3 — Symbol surface (cluster 3, 16).**
1. @@toStringTag step 14/15 in `emitObjectProtoToStringBody`
   (object-proto-tostring.ts): after the branded arms and before the `$Object`
   step-13 default, do a dynamic `[[Get]]` of the well-known @@toStringTag key
   (fixed symbol id 4 — `literals.ts:2512` / `builtin-value-read.ts:158`;
   build the `$Symbol` key via the same carrier `__obj_hash`'s symbol arm
   reads, object-runtime.ts L1551) through `__extern_get` so Proxy receivers
   trap and getter abrupts propagate (`get-symbol-tag-err.js`). If the result
   is a string, use it; else fall through to the existing arm's answer. This
   also needs the builtin `.prototype` carriers to actually own their spec
   @@toStringTag properties — #5116 (in-progress) is doing exactly this for
   Map/Set; extend its mechanism to GeneratorFunction/Promise/WeakMap/WeakSet
   rather than inventing a second one, and check its branch before starting.
   Keep the classifier's "loud stays loud" fallthrough (file header) intact.
2. Symbol-key redefine identity: in the descriptor write path
   (object-runtime-descriptors.ts, `__defineProperty_*`), when an existing
   `$PropEntry` is found for a symbol key, mutate the entry in place and
   **keep its stored key carrier** — never write the freshly-boxed parameter
   carrier into the key field. Verify with the minimal repro above, then the 5
   cluster tests (also fixes descriptor counting in
   `getOwnPropertyDescriptors/symbols-included.js`).
3. `Object(sym)` / ToObject: add a native `__to_object` for standalone (the
   host-mode `__to_object` import at calls-guards.ts ~L789 keeps working):
   dispatch on the boxed tag — number → `__new_Number`-equivalent wrapper
   `$Object` with `WRAPPER_PRIMITIVE_KEY` slot (pattern:
   `boxed-proto-valueof.ts` / `wrapper-proto-value-of.ts`), boolean/string
   likewise, `$Symbol` → wrapper `$Object` holding the carrier, object →
   identity, nullish → TypeError. Route the calls-guards.ts standalone
   fallthrough and `Object.getOwnPropertySymbols`'s argument (TypeError on
   nullish — `non-object-argument-invalid.js`) through it.

**Step 4 — Object.assign fidelity (cluster 4, 13).**
All in `__object_assign` (object-runtime-enumeration.ts L1081) + its call site:
1. Target: replace the nullish-only guard with the Step-3 `__to_object` —
   fixes `Target-Number/-Boolean/-String/-Symbol` and `OnlyOneArgument`
   (return value must be the wrapper, `typeof === "object"`).
2. Copy loop: write through `__extern_set_strict` (#3983, registered in
   object-runtime.ts L4099) so refused writes throw TypeError — fixes the 5
   `target-is-*`/`target-set-not-writable` throw tests; confirm the accessor
   case (`target-is-frozen-accessor-property-set-succeeds.js`) still writes
   through the setter.
3. Source reads: fetch values via the full `[[Get]]` (`__extern_get`) rather
   than raw `$PropEntry` reads, so getters run and abrupts propagate
   (`source-get-attr-error.js`); re-check `ObjectOverride-sameproperty.js`
   (expected "c", got NaN — likely the same raw-read defect unifying types).
4. Add a string-source arm: for an `$AnyString` source, copy index keys
   `"0".."len-1"` (CreateListFromArrayLike over string exotic own keys) —
   `Override-notstringtarget.js`.

**Step 5 — Object.is arity (cluster 5, 4 CEs).**
call-builtin-static.ts ~L3287: relax the guard to `>= 0` and treat missing
args as `undefined` (compile the present args; substitute canonical undefined
externref — `canonicalUndefinedExternInstrs` — for missing ones) before the
existing `__object_is` dispatch. One-line-ish; do first if a quick win is
needed.

**Step 6 — defineProperty own-key reflection on functions/arrays (cluster 6, 3).**
(a) Function expando: make the closure-carrier expando enumeration
(`instance-proto-method-identity.ts` / the carrier-bag path,
`carrier-bag-define.ts`) honor `Object.defineProperty(fn, "length",
{enumerable: true})` — `length` joins `Object.keys`/`entries` output ahead of
later expandos (creation order: `length` predates `a`). (b) Array: stop
fabricating hole indices in `Object.getOwnPropertyNames(arr)` — enumerate only
materialized indices (vec reflection in `vec-props.ts` /
`array-length-define.ts`).

**Step 7 — residuals (cluster 7, do only if budget remains).**
`toLocaleString` → emit `Invoke(O, "toString")` through the dynamic member-call
path instead of a static fold (2 tests). `hasOwnProperty` → run
`__to_property_key` before the ToObject/receiver guard (1). Leave
`proto-from-ctor-realm.js` (cross-realm) and `subclass-object-arg.js`
(Reflect.construct NewTarget — #5140 cluster 8's limitation) documented as
out-of-wave residuals in this issue rather than forcing them.

**What NOT to do**
- No new `env::*` host imports without a standalone fallback (the probe hard-
  fails the module — `standaloneHostImportError`); prefer natives throughout.
- Never edit `tests/test262-runner.ts`, any skip list, or
  `scripts/*baseline*.json` / `scripts/ir-fallback-baseline.json`.
- Do not widen the `object-proto-tostring.ts` fallthrough to a silent
  `[object Object]` default — its header forbids exactly that.
- Do not duplicate #5140's invariant validators or #5116's toStringTag
  carriers — stack on their branches if in flight.
- Do not hand-pick new issue ids; any follow-up issue goes through
  `claim-issue.mjs --allocate`.

## Acceptance criteria

- All 90 paths in `.tmp/es2015/wp-object-builtins-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list …` (clusters 1-6; the ≤2 documented
  cluster-7 residuals may remain failing only with an explicit residual note
  added to this issue).
- All 40 paths in `.tmp/es2015/wp-object-builtins-passing-spotcheck.txt` still
  pass (no regressions on the standalone lane).
- Ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`.
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## Results (wave 1, 2026-08-28)

Measured with `npx tsx .tmp/run-standalone.mts --list …` on this branch, against
the same 90-path list re-run on the branch base immediately before the work.

| | before | after |
| - | - | - |
| target list (90 paths) | 1 pass · 82 fail · 7 CE | **11 pass · 78 fail · 1 CE** |
| spotcheck (40 paths) | 40 pass | 40 pass (no regressions) |

Net **+10** on the standalone lane; the remaining COMPILE_ERROR is
`subclass-object-arg.js` (the #3371/#5140 `Reflect.construct` NewTarget
limitation, a documented out-of-wave residual).

**Fixed**

- **Cluster 5 — `Object.is` arity (4/4).** The arity-2 guard sent
  `Object.is()` / `Object.is(x)` into `__get_builtin`'s Phase-B refusal. A
  short-call arm answers `true` for zero arguments and, for one, tests the
  operand with the native `__extern_is_undefined` under the #2106
  undefined-singleton regime (bare `ref.is_null` outside it, matching that
  lane's own null/undefined conflation).
- **Cluster 2b/2c — `Object.setPrototypeOf` refusals (2/21).**
  `proto-not-obj.js` and `o-not-obj-coercible.js`. New pure native
  `__object_setPrototypeOf_status` answers the §10.1.2.1 boolean without the
  write, so the call site can throw on §20.1.2.21 step 4 while the writer keeps
  its lenient internal-caller posture; the call site now accepts one argument
  and emits RequireObjectCoercible plus the "Object or null" proto check.
- **Cluster 4b/4c — `Object.assign` fidelity (2/13).**
  `source-get-attr-error.js`, `target-set-not-writable.js`. The copy loop is now
  a real `Get(from, key)` + `Set(to, key, v, true)` pair (`__extern_get` /
  `__extern_set_strict`) instead of a raw `$PropEntry` table copy.
- **Cluster 3a — `@@toStringTag` steps 14/15 (2/16).**
  `symbol-tag-str.js`, `symbol-tag-override-instances.js`. New
  `src/codegen/object-proto-symbol-tag.ts` mints `__opts_symbol_tag`, consulted
  by the `Object.prototype.toString.call(v)` fold BEFORE builtinTag so it also
  overrides a tag the #2501 fold proved from a name.

**Not done — carry to wave 2**

- **Cluster 1 (Proxy MOP routing, 28).** Untouched; depends on #5140 Step 2.
- **Cluster 2a (`__proto__` accessor pair, 12).** Needs an accessor descriptor
  with BOTH halves on `Object.prototype`; the existing `$NativeProto` glue
  models `memberKind: "getter" | "method"` only (get-half accessors), so this is
  new machinery, not a table entry.
- **Cluster 2b residual (4).** `set-failure-non-extensible.js` and the three
  `Object.prototype`-receiver rows are MODEL gaps, not missing throws:
  a `{}` literal's `$proto` is null rather than `Object.prototype` (so
  `setPrototypeOf(nonExtensible, null)` is a legal same-value no-op in our
  model), and `Object.prototype` is a `$NativeProto`, not a `$Object`, so its
  §10.4.7 immutable-prototype refusal has nowhere to live. Those rows also
  assert `Reflect.setPrototypeOf(...) === false`, so a call-site-only fix would
  not close them.
- **Cluster 3b — the plan's diagnosis does not reproduce.** Probed directly:
  symbol-key identity survives `defineProperty` redefinition
  (`getOwnPropertySymbols(obj)[0] === symA` is **true**, count and order
  correct). `order-after-define-property.js` fails on its ARRAY half — symbol
  keys on a `$Vec` receiver are not reflected at all — which belongs with
  cluster 6's array reflection, not with the descriptor write path.
- **Cluster 4a/4d (6).** `Target-{Number,Boolean,String,Symbol}` /
  `OnlyOneArgument` need the native ToObject wrapper; `Override-notstringtarget`
  needs the string-source arm.
- **Clusters 6 and 7.** Untouched.
- Two `Object.assign` rows now surface a **different** defect than before (both
  were already failing): a frozen object's ACCESSOR property refuses its own
  setter (`target-is-frozen-accessor-property-set-succeeds.js`) — the
  `__extern_set` completed-set channel reports REFUSED where §10.1.5.3 says the
  setter still runs — and a closed-shape struct target does not carry the
  integrity flags at all, so the frozen/sealed/non-extensible THROW rows stay
  silent. Both are `__reflect_set` / representation issues, not `Object.assign`
  ones.

## References

- **#5140** — ES2015 standalone proxy wave 1: owns the §10.5 post-trap
  invariant validators (its Step 2) and the Reflect.construct NewTarget CE;
  predecessor for cluster 1's invariant tests.
- **#5116** — Map/Set `@@toStringTag` (in-progress): the carrier mechanism
  cluster 3(a) extends.
- **#1355** — Proxy pure-Wasm epic (Stage S2 invariants umbrella); #1466 trap
  fidelity.
- **#4749** — `fillObjectAssignProxySourceArm`: the fill-arm pattern for
  Step 1.
- **#4479** — Annex B accessors module: the pattern for Step 2's `__proto__`
  pair.
- **#3983** — `__extern_set_strict` (strict [[Set]] TypeError), used by Step 4.
- **#2866** — standalone `$Symbol` carrier; **#2042/#2043** — descriptor
  reflection natives; **#1888** — `__object_setPrototypeOf`; **#1472** —
  no-JS-host object property ops (`__get_builtin` Phase-B refusals);
  **#4530/#2728** — `Object(x)`/`Object(sym)` ToObject host arms; **#4119** —
  standalone toString classifier; **#4491** — ES5 defineProperty MOP residual
  (adjacent descriptor semantics).
