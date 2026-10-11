---
id: 6771
title: "ES2015 standalone: built-ins/Array residue (34 rows) — Proxy receivers + species/RangeError/copyWithin (H6 re-apply), array-like exotic operands, Array(n) holes, @@unscopables, Boolean.prototype.toString override, ArraySetLength order, flat species, fnctor prototype.constructor"
status: in-progress
assignee: ttraenkler/opus-6771
sprint: current
created: 2026-09-30
updated: 2026-10-01
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-lead
related: [6651, 6766, 6767, 6769, 6770, 5145, 6683, 6701, 2717, 4655, 3468, 2727, 4222, 3251, 1539, 6720]
loc-budget-allow:
  # 2026-09-30 (#6771 plan): S1 re-applies the reverted #6651 H6 second set
  # (commit e7cd6a20a1 + 501bcd9b0e, reverted by 83fc243108) — same files, same
  # +485 lines; the new leaf `array-copywithin-native.ts` comes back with it.
  - src/codegen/analysis/proxy-binding-escape.ts
  - src/codegen/array/array-copywithin-native.ts
  - src/codegen/array-methods.ts
  - src/codegen/array-prototype-borrow.ts
  - src/codegen/array-proxy-receiver.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/proxy-array-like.ts
  - src/codegen/type-coercion.ts
  - src/codegen/array-holes.ts
  - src/codegen/context/types.ts
  # 2026-09-30 (#6771 plan): S2–S11 wiring. Anything longer than ~40 lines goes
  # in the NEW leaves listed last (object-runtime.ts / dataview-native.ts are
  # at budget — never grow them; splice-front arms only).
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/closure-props.ts
  - src/codegen/ta-dyn-mop.ts
  - src/codegen/literals.ts
  - src/codegen/array-flat-native.ts
  - src/codegen/array-flatmap.ts
  - src/codegen/native-proto.ts
  - src/codegen/native-proto-own-props.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/to-locale-string-element.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/array-tolocalestring.ts
  - src/codegen/array-join-element.ts
  - src/codegen/expressions/fnctor-prototype.ts
  - src/codegen/native-construct.ts
  - src/codegen/vec-overlay.ts
  - src/codegen/vec-props.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/array-length-define.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-integrity-proxy.ts
  - src/codegen/object-runtime-proxy-chain.ts
  - src/codegen/array-species.ts
  - src/codegen/array/array-like-exotic-arms.ts
  - src/codegen/array/array-unscopables.ts
  - src/codegen/expressions/bool-to-locale-string.ts
  - src/codegen/array/array-set-length-coercion.ts
  - src/codegen/proxy-trap-getmethod.ts
  - scripts/compiler-boundaries.json
  # 2026-09-30 (#6771 implementation, Opus): wiring lines only — S1's Proxy-trap
  # return widening is one wrapper call in `computeClosureWrapperSig`
  # (closures.ts, +6 formatted); S2's finalize fill is one call per pipeline
  # plus its import (index.ts, +3). Bodies live in the new leaves
  # proxy-trap-closure-return.ts / array-like-exotic-arms.ts / array-length-holes.ts.
  - src/codegen/closures.ts
  - src/codegen/index.ts
  - src/codegen/closures/proxy-trap-closure-return.ts
  - src/codegen/array/array-length-holes.ts
  # S6: `typeof this` must not fold to "object" in strict code whose `this`
  # TypeScript types as a primitive wrapper (one guard + its import; the
  # predicate lives in bool-to-locale-string.ts).
  - src/codegen/typeof-delete.ts
  # S7: one guarded-read call in the `.constructor` namespace fold, one
  # runtime-predicate condition in the `Array.isArray` fold (bodies in
  # array-ctor-this.ts).
  - src/codegen/property-access-dispatch.ts
  - src/codegen/expressions/call-builtin-static.ts
  # S8/S9: one element-coerce call + one pre-flush registration in
  # `buildVecFromExternref` (type-coercion.ts, granted above) and one finalize
  # call per pipeline (index.ts, granted above); bodies in the new leaf
  # vec-elem-fidelity.ts. S10a/S10b: ArraySetLength's second conversion —
  # `__vec_dp_value`'s length body (vec-overlay.ts, granted above), the dynamic
  # `__extern_set` vec-length arm (vec-length-set.ts, three hook lines + import),
  # the static assignment + non-writable fold (assignment.ts, granted above);
  # bodies in array-set-length-coercion.ts.
  - src/codegen/array/vec-elem-fidelity.ts
  - src/codegen/vec-length-set.ts
  # S7 follow-up (2026-09-30): `var r = Array.from.call(C, …)` / an O-returning
  # or species-creating `Array.prototype.X.call(…)` keeps an externref slot —
  # one call in `transferredArrayLikeResultNeedsExternref` + its import (the
  # #6651 E5 hook); the predicate lives in array-ctor-this.ts.
  - src/codegen/statements/variables.ts
  - src/codegen/array/array-ctor-this.ts
  # 2026-10-02 (#6771 x #6797 import-cycle ratchet): the leaves above moved out
  # of flat src/codegen/ (flat-dir budget) and no longer import core modules —
  # they reach the 16 core helpers they need through the late-bound wrappers in
  # helpers/core-delegates.ts, registered once at module scope by expressions.ts
  # (16 imports + one register call). to-locale-string-element.ts's
  # helper-reservation primitives moved verbatim to helpers/reserved-helper-funcs.ts
  # so the Boolean twin stops importing it (net shrink there).
  - src/codegen/expressions.ts
  - src/codegen/helpers/core-delegates.ts
  - src/codegen/helpers/reserved-helper-funcs.ts
func-budget-allow:
  # 2026-09-30 (#6771 plan): each gains one arm / one guard / one route.
  - src/codegen/array-methods.ts::setupArrayLoop
  - src/codegen/array-methods.ts::compileArrayMap
  - src/codegen/array-methods.ts::compileArrayFilter
  - src/codegen/array-methods.ts::tryCompileFlatMapNative
  - src/codegen/array-methods.ts::compileArrayFlatMap
  - src/codegen/array-prototype-borrow.ts::compileArrayLikePrototypeCall
  - src/codegen/array-proxy-receiver.ts::compileProxyReceiverArrayProtoCall
  - src/codegen/type-coercion.ts::buildVecFromExternref
  - src/codegen/object-runtime-enumeration.ts::buildObjectArrayLikeLengthArm
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  - src/codegen/array-flat-native.ts::compileArrayFlatNativeCall
  - src/codegen/array-species.ts::emitArraySpeciesResultSwap
  - src/codegen/native-proto.ts::seededNativeProtoSymbolMembersByBrand
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/literals.ts::compileArrayConstructorCall
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/native-proto.ts::ensureNativeProtoCompanionSeeder
  - src/codegen/ta-dyn-mop.ts::fillTaDynViewMopArms
  - src/codegen/vec-overlay.ts::fillVecOverlayHelpers
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  # 2026-09-30 (#6771 implementation, Opus): one call each — the S2 fill in both
  # finalize pipelines, and S3's hole-aware static `k in arr` branch.
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/property-access-dispatch.ts::tryConstructorPrototypeIdentity
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/native-construct.ts::fillNativeConstructDrivers
  # S10a (2026-09-30): the vec-length arm gains three hook splices (first
  # conversion, step-5 agreement, step-12 refusal); the bodies are
  # `arraySetLengthDynamicParts` in array-set-length-coercion.ts.
  - src/codegen/vec-length-set.ts::fillVecLengthDynamicArms
coercion-sites-allow:
  # 2026-09-30 (#6771 implementation, Opus): ToString(k) of an integral array
  # index — the canonical key spelling every array-like arm uses (the `$Object`
  # arms of `__extern_get_idx`/`__extern_has_idx` already call
  # `number_toString` for exactly this). S1 re-applies the #6651 H6 copyWithin
  # body (reviewed there, grant stranded by the revert); S2's closure / builtin
  # carrier arms delegate by the same key.
  - src/codegen/array/array-copywithin-native.ts
  - src/codegen/array/array-like-exotic-arms.ts
  # 2026-10-02 (#6771 x #6797): not a new site — `TO_STRING = "__extern_toString"`
  # moved verbatim from to-locale-string-element.ts with the reservation helpers.
  - src/codegen/helpers/reserved-helper-funcs.ts
---

## Problem

`built-ins/Array/**` still has 34 ES2015 non-pass rows on `--target
standalone` (the lead's bucket, `.tmp/array/rows.txt`; realm rows were
excluded upstream — **none of the 34 is a `$262.createRealm` / cross-realm
row**). Measured by this plan on `origin/main` @ `2ef807a68e`
(`flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts
.tmp/6771/rows.txt --isolate --standalone`, QuickJS provider built): **33
fail + 1 compile_error, 0 pass**. Per-row verdict + first error line:
`.tmp/6771/rows-base-2ef807a68e.log` (the lane's copy; the implementer
re-measures per Step 0).

The 34 rows are 12 mechanisms, not 12 directories. Each was isolated with a
standalone probe (`.tmp/6771/p*.js`, run through `.tmp/6771/probe.mts`; node
reference via `node-ref.cjs`) and, where the module-level pre-scan matters,
with an **instrumented copy of the real row run under the real harness
prefix** — the runner accepts a path outside `test262/` (`../../.tmp/6771/
rowcopy/<x>.js`, relative to `test262/test/`), which is the only way to see
what the harness includes do to the pre-scan flags.

| probe | what it asks | main | node |
| --- | --- | ---: | ---: |
| p14 | species through a double Proxy: `Object.getPrototypeOf(Array.prototype.{slice,map,filter,splice,concat}.call(proxy)) === Ctor.prototype` (1/2/4/8/16) + non-proxy controls (32/64/128) | **0** | 255 |
| p14b | NO Proxy in module: `getPrototypeOf(arr2.slice()) === Ctor.prototype` (1), `instanceof Ctor` (2), `.constructor === Ctor` (4), same for map/concat/splice/filter | **0** | 511 |
| p15 | `get` trap answers `length = 2^32`: map/splice/slice `.call(proxy)` throw RangeError, no `set`/callback | **trap** `requested new array is too large` | 31 |
| p1f | `[].concat(1, <Proxy whose length = 2^53-1>)` throws TypeError | **trap** (same) | 1 |
| p13b | `Array.prototype.copyWithin.call(<Proxy>)` runs `has`/`deleteProperty`; plain array-like control | **7168** (three TypeErrors "not yet callable") | 7 |
| rowcopy/fn (harness) | `fn[@@isConcatSpreadable]=true; fn[0]=1..; [].concat(fn)` | `c.len=0 fn.length=3 fn0=undefined` | `[1,2,3]` |
| rowcopy/strw (harness) | `str1 = new String("yuck💩")`; default `[].concat(str1)` is `[str1]` (OK) — the row fails on the NEXT assert, `str1[@@isConcatSpreadable]=true` → 6 code units | p1g **35** (bits 4/8/16 = spreadable wrapper: 0 elements) | 63 |
| rowcopy/regexp (harness) | `re = /abc/` then `[].concat(re)` FIRST | `c.len=0 isArr=**true**` | `[re]`, `false` |
| p1h2..p1h6 | same RegExp in a module WITHOUT the harness, each later write alone | 51 = node (no defect) | 51 |
| p1h7 | RegExp + `re[0]=1, re.length=3` writes, no harness | **compile refusal** "standalone RegExp engine does not support RegExp values not created by this backend (#1539)" | 255 |
| p2 | `Object.defineProperty(ta, "length", {value: 3})` on a Uint8Array: `hasOwnProperty` (4) yes, `ta.length === 3` (2) no, `[].concat(ta).length === 3` (8) no; harness shape (32/64) no | **21** | 127 |
| p1e | `Array.prototype.concat.call({length:{valueOf:null,toString:null}, …spreadable})` and the same as an operand → TypeError (1/2); 2^53−1 overflow (4) | **4** | 7 |
| p1d5 | `new Array(5)[2]`: `=== undefined` (2) / `=== null` (16) / `String(...)` (64 "undefined" / 256 "null") | **273** (reads `null`) | 103 |
| rowcopy/sparse (harness) | `[].concat({length:5, spreadable})` compares equal to `[void 0 ×5]` (cmp=true), then `new Array(4000)[100]` is `null` → `compareArray(new Array(4000), c2)` false → the harness formats 2×4000 elements and dies with the "non-stringifiable payload" exception | `na100=null` | `undefined` |
| p3 / p3b / p3c | `array.length = obj` (`@@toPrimitive` / `valueOf`): coerced ONCE (hints.length 1), spec TWICE (ToUint32 then ToNumber); `Reflect.set(array,"length",obj)` not `false`; `defineProperty(arr,"length",{value: obj})` coerces once and never reaches the writable check | p3 **1**, p3b **55**, p3c **267** | 511 / 127 / 135 |
| p4 | `Reflect.defineProperty([], "length", {enumerable:true} / {set} / {writable:true} on non-writable)` must return `false` | **7253** (all three THROW instead) | 127 |
| p5 | `Array.prototype[@@unscopables]`: object (1), null proto (2), members `true` (4), own (8), `{w:false,e:false,c:true}` (16); control `@@iterator` own + descriptor (64/128/256) | **449** (controls pass, unscopables absent) | 511 |
| p6 / p6b | strict: `Boolean.prototype.toString = function(){return typeof this}` — `true.toString()` (2), `true.toLocaleString()` (4), `[true,false].toLocaleString()` (8); p6b = the ACCESSOR form | **33** / **0** | 63 / 7 |
| p7 | `Array.from.call(C, iterable)`: `result instanceof C` (1), `result.constructor === C` (2), `C.prototype.constructor === C` (16), `Array.from.call(Object, []).constructor === Object` (32), `getPrototypeOf(that) === Object.prototype` (512) | **200** | 1023 |
| p8 / p8c / p8d | `obj = {0:2,1:4,2:0,3:16,length:4}; delete obj[2]`: `Array.from(obj)[2]` is NaN (p8 bit 8 fails); an untyped-param `o[2]` IS `undefined` (p8c = 1 ✓); `Object.keys(obj)` traps `illegal cast` (p8d) | 55 / 1 / trap | 63 / 1 / 7 |
| p9 / p9b | `Object.defineProperty(Array.prototype, "0", {set})` in the module: `[1][0]`, `["a"][0]`, `[o][0]` fine; **every BOOLEAN vec read `[true][0]`, `b[0]` answers `undefined`**, even after the delete | 122 / **27** | 127 / 511 |
| p11a / p11b | `flat` with a species whose result is non-extensible / has a non-configurable `"0"` → TypeError (1/2); species ctor called once (4) | **8** (species never consulted) / **compile refusal** "#2717 non-array-returning callback" | 15 / 1 |
| p16 | species result is `new Proxy(new Array(len), new Proxy({}, {get: log}))`: creation logs nothing (32), the `splice` trap log is `defineProperty, defineProperty, set, getOwnPropertyDescriptor, defineProperty` (2) | **20** (log starts `get, set, has, apply, …` = the 13-trap snapshot at ProxyCreate) | 123 |

Root causes, one line each (details per step below):

1. **Proxy receivers** (11 rows): a Proxy binding handed to an Array borrow is
   materialised into a COPY of its target at its declaration (#2615 escape),
   the species prologue reads the copy, `Object.getPrototypeOf(<Array-typed>)`
   is folded to `%Array.prototype%` from the checker's type, a trapped length
   > 2^32−1 reaches `array.new_default` (trap, not RangeError), and standalone
   has no array-like `copyWithin` body at all. All five were built and pinned
   in the #6651 H6 second set (`e7cd6a20a1`, `501bcd9b0e`) and reverted
   unmeasured by `83fc243108` because the row runs never finished.
2. **Array-like trio has no arms for exotic operands** (6 rows): `__extern_length`
   / `__extern_get_idx` / `__extern_has_idx` answer 0 / undefined for a CLOSURE
   (function with `length` = arity and expando index props — and `fn[0] = 1`
   is DROPPED, closure-props.ts admits only named keys), for a STRING WRAPPER
   (`$Object` with the `[[PrimitiveValue]]` slot — §10.4.3 `length` + code-unit
   indices), and for a dyn TypedArray view carrying an OWN `length` data
   property in its expando bag (§10.4.5 ordinary-key path). `ToLength(Get(O,
   "length"))` on a `$Object` uses a bare unbox, so a non-coercible `length`
   object answers 0 instead of throwing. A module-level `var re = /abc/` that
   later gets `re[0]=1 … re.length=3` writes compiles to a value the
   `__extern_is_array` chain accepts (under the harness) or refuses outright
   (without it, #1539): the writes re-type the binding instead of landing as
   RegExp expandos.
3. **`Array(n)` / `new Array(n)` holes read as `null`** (1 row): the sparse build
   is `array.new_default` over an externref vec (literals.ts) → `ref.null.extern`
   → reads `null`, `in` true.
4. **ArraySetLength coercion order** (3 rows): every length write coerces ONCE
   and checks [[Writable]] BEFORE coercing; `Reflect.defineProperty` has no
   false channel (the applier throws).
5. **`Array.prototype[@@unscopables]` is not seeded** (2 rows).
6. **`Boolean.prototype.toString` override is invisible** (2 rows): a boolean
   receiver folds to `"true"`/`"false"` (`emitBoolToString`), and the array
   `toLocaleString` boolean element arm renders natively (#4655 scope note).
7. **fnctor `prototype` object has no `constructor` back-link; `Construct(Object)`
   builds an object with no `%Object.prototype%` link** (2 rows).
8. **Closed-struct numeric field deleted → `__extern_get_idx` reads the NaN
   sentinel** (1 row) — the string-key arm already maps it.
9. **Boolean vec index reads vanish under `protoIndexDirty`** (1 row).
10. **`flat`/`flatMap` never run ArraySpeciesCreate** (3 rows) and the typed
    `flatMap` refuses to compile once species widens `map`'s result.
11. **ProxyCreate snapshots all 13 traps** (1 row) — §10.5 is `GetMethod(handler,
    name)` per operation; plus the species result swap does a define AND a
    `Set` per element.
12. **Global `this` does not alias a top-level `var`** (1 row) — not an Array
    mechanism (#2727), recorded, not planned here.

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Order is by yield per unit of risk; every step is independently shippable
and measured with the row list + its pin set before the next starts. Type
queries go through `ctx.oracle`, never `ctx.checker` (oracle-ratchet gate).
Nothing here touches `src/ir/select.ts`, `object-runtime.ts` or
`dataview-native.ts` bodies (both at LOC budget — splice-front arms from a
leaf only, the #3183 discipline).

**ES5 is `completed` — zero ES5 row regressions.** Every step names its pin
set; extract each from the standalone baseline
(`.test262-cache/test262-standalone-current.jsonl`, `status:"pass"`, promoted
2026-09-30 18:49) into `.tmp/6771/pin-<name>.txt` BEFORE the first edit and
re-run it (0 pass → non-pass, per-path set diff, `--isolate`, under the lock)
after the step. Measured pass counts (all editions; ES5 is the subset that
matters for the gate): `Array/prototype/concat` 56, `Array/length` 28,
`Array/prototype/toLocaleString` 6, `map` 159, `filter` 222, `slice` 63,
`splice` 65, `copyWithin` 27, `flat` 13, `flatMap` 15, `Array/from` 39,
`Array/of` 12, `Object/defineProperty/15.2.3.6-4-1*` 109, `Boolean/**` 50,
`Proxy/**` 265, `Reflect/defineProperty` 11, `Reflect/set` 17,
`Function/prototype/**` 271, `RegExp/prototype/**` 447,
`TypedArray/prototype/**` 1010, `language/statements/with/**` 173,
`language/expressions/delete/**` 62.

### Step 0 — base copies and the before-state

- `mkdir -p .tmp/6771/base-src && git archive origin/main src | tar -x -C .tmp/6771/base-src`
  (the revert copy; A/B by `cp`, never `git stash`).
- Copy `.tmp/6771/{probe.mts,node-ref.cjs,p*.js,rowcopy/}` from the lead's
  `/home/user/js2/.tmp/6771/` (the plan lane's files live in its worktree
  `.tmp/6771/`; the lead copies them over on dispatch). Run every probe on the
  unmodified tree and confirm the `main` column above.
- Build the QuickJS provider once (`npx tsx scripts/build-quickjs-eval-provider.mjs`
  — `concat_spreadable-function.js` links `js2wasm:runtime-eval` because of
  its `Function.prototype[…]` writes), then run `rows.txt` on the unmodified
  tree under the lock → `.tmp/6771/rows-base.log` (expect 33 fail + 1
  compile_error).
- Extract the pin lists named per step (`grep -F '"file":"test/<dir>' … |
  grep '"status":"pass"' | sed 's/.*"file":"test\///; s/".*//'`).

### S1 — re-apply the #6651 H6 second set (11 rows)

- Rows: `prototype/{slice,splice,map,filter,concat}/create-proxy.js`,
  `prototype/{map,splice}/create-species-undef-invalid-len.js`,
  `prototype/slice/create-proxied-array-invalid-len.js`,
  `prototype/concat/arg-length-exceeding-integer-limit.js`,
  `prototype/copyWithin/return-abrupt-from-{has-start,delete-proxy-target}.js`.
- The code exists in main's history: `git show e7cd6a20a1` (+485 lines, 11
  files incl. the new leaf `src/codegen/array-copywithin-native.ts` and the
  pin suite `tests/issue-6651-h6-array-proxy-receiver.test.ts`) and
  `501bcd9b0e` (proxy pre-scan flag out of the dynamic-code cascade). Re-apply
  with `git diff 83fc243108 83fc243108^ -- src scripts/compiler-boundaries.json
  tests | git apply --3way`. Measured on `2ef807a68e`: **only
  `src/codegen/expressions/object-get-prototype-of.ts` conflicts** (its import
  block gained `popBody, pushBody` and `isStandaloneBaseClassOrPrototype`
  since) — hand-apply its two hunks: the
  `import { arrayTypedValueMayNotBeArray } from "../proxy-array-like.js";`
  line, and in `tryCompileEs5GetPrototypeOfValue` change
  `if (knownPrototypeName) {` to
  `if (knownPrototypeName && !(knownPrototypeName === "Array" && arrayTypedValueMayNotBeArray(ctx))) {`.
  Re-add the `array-copywithin-native.ts` entry to `scripts/compiler-boundaries.json`
  (the patch carries it; if the 3-way drops it, see "Lane protocol").
- What the set does (read the H6 record in #6651 § "Built, measured only by
  pins, and REVERTED" before touching it): (a) `proxy-array-like.ts::
  arrayMethodReadsProxyOperand` — a Proxy binding used as receiver of
  `Array.prototype.{map,filter,slice,splice,concat,copyWithin}.call` or as a
  concat operand is NOT an escape, so it keeps the open externref slot
  (`analysis/proxy-binding-escape.ts::expressionIsEscapingArgument` gains one
  early-`false`); (b) `array-methods.ts::setupArrayLoop` records
  `recvExternTmp` (the receiver BEFORE `buildVecFromExternref`) and
  `compileArrayMap`/`compileArrayFilter` feed `speciesOriginalArrayInstrs(loop)`
  to `emitArraySpeciesCreate` — the §10.4.2.3 `originalArray` is the proxy,
  whose `constructor` lives on the proxy; (c) `array-proxy-receiver.ts` adds
  `copyWithin` to `PROXY_RECEIVER_GENERIC_METHODS` and, for slice/splice, runs
  `emitArraySpeciesCreate` on the ORIGINAL receiver after the helper and
  `emitArraySpeciesResultSwap` (ordering under-approximation recorded in
  #6651; identity/prototype exact); (d) `proxy-array-like.ts::
  arrayLikeLengthLimitGuard` — `> 4294967295` ⇒ RangeError "Invalid array
  length", spliced before the `i32.trunc_sat` in `type-coercion.ts::
  buildVecFromExternref` and in `array-prototype-borrow.ts::
  compileArrayLikePrototypeCall`'s `map` length read; (e) `proxy-array-like.ts::
  arrayTypedValueMayNotBeArray` — the `Object.getPrototypeOf` fold declines
  when `ctx.arraySpeciesDirty || ctx.proxyDirty`; (f) the new leaf's
  `__arrprod_copyWithin(recv, argsVec)` — §23.1.3.4 step for step on
  `__extern_length` / `__extern_has_idx` / `__extern_get_idx` /
  `__extern_set_strict` / `__delete_property`, every key `ToString(k)`.
- Extend (f)'s reach one notch: `p13b` shows `Array.prototype.copyWithin.call(<plain
  array-like>)` also throws "not yet callable" today. Route it through the
  same helper from `compileArrayLikePrototypeCall` (add `"copyWithin"` to
  `ARRAY_LIKE_METHOD_SET` in `array-prototype-borrow.ts:46` and dispatch it
  exactly as `compileProxyReceiverArrayProtoCall` does: receiver + args into
  an `$ObjVec`, one `call __arrprod_copyWithin`). Low risk — today's answer
  is a TypeError.
- `p14b = 0` says the `getPrototypeOf` fold ALSO hides the already-passing
  `create-species*.js` rows' results from `instanceof`/`.constructor`; (e)
  fixes `getPrototypeOf`, which is all the 5 rows assert. `instanceof Ctor`
  on an Array-typed species result stays a recorded residual (no row).
- ES5 risk: (a) changes escape analysis for `.call` receivers of six borrows —
  standalone only, Proxy-bindings only (`tracesToProxyValue`). (d) adds a
  compare per `buildVecFromExternref` under `ctx.proxyDirty` only. (e) makes
  `Object.getPrototypeOf(arr)` a runtime read in species/proxy modules, where
  `__getPrototypeOf`'s array arm (#6651 R1) still answers the singleton.
  Pins: `Array/prototype/{map,filter,slice,splice,concat,copyWithin}/**`,
  `Proxy/**`, `Object/getPrototypeOf/**`, `Array/isArray/**`; plus the H6 pin
  suite (9 + 13 tests) green on the branch, 6 + 9 RED on `base-src`.
- Acceptance: all 11 rows pass; `p14` = 31 (bits 1–16) or 255, `p15` = 31,
  `p1f` = 1, `p13b` = 7.

### S2 — array-like trio arms for exotic operands: closure, String wrapper, dyn-view own `length`, ToLength abrupt; RegExp expandos (6 rows) — new leaf `src/codegen/array-like-exotic-arms.ts`

- Rows: `prototype/concat/Array.prototype.concat_spreadable-{function,string-wrapper,reg-exp}.js`,
  `prototype/concat/Array.prototype.concat_{large,small}-typed-array.js`,
  `prototype/concat/Array.prototype.concat_array-like-to-length-throws.js`.
- Today `__extern_length`'s ladder (`object-runtime-enumeration.ts:640-700`)
  is `$__vec_base` → `$ObjVec` → `buildObjectArrayLikeLengthArm` (`ref.test
  $Object ∨ $Proxy` → `__extern_get(v,"length")` + `buildArrayLikeToLengthFromExternref`)
  → `0`. `__extern_get_idx` (same file, 720-770, `buildExternGetIdxBody`) and
  `__extern_has_idx` mirror it. The closed-struct arms are spliced at
  finalize by `fillExternArrayLikeStructArms` (#3317), the dyn-view arm by
  `ta-dyn-mop.ts:1058-1108`.
- **S2a closure carrier.** New finalize fill in the leaf, spliced FRONT of
  the three natives (same shape as `ta-dyn-mop.ts:1058`): `ref.test` against
  every root in `collectClosureBaseWrapperTypeIdxs(ctx)`
  (`closure-classifier.ts`) → `__extern_length`: `ToLength(__extern_get(v,
  "length"))` (the closure arm of `__extern_get` already answers the arity via
  the #2896 metadata and consults the closure bag + the Function-brand
  companion for everything else — `closure-props.ts:320-345`);
  `__extern_get_idx`: `__extern_get(v, number_toString(idx))` (the same
  delegation the `$Object` arm uses); `__extern_has_idx`: `__extern_has(v,
  number_toString(idx))`. That alone makes `Function.prototype[0] = 1`
  visible (companion walk). For the INSTANCE expando the write is dropped:
  `closure-props.ts:585-600` keeps numeric keys out of the bag only for the
  VEC carriers ("numeric keys are array ELEMENTS") — verify with
  `.tmp/6771/rowcopy/fn.js` whether `fn[0] = 1` reaches `__extern_set` at all
  (the static lowering of an element-assignment on a function-typed LHS may
  fold to a no-op before the runtime sees it: `expressions/assignment.ts`,
  element-access branch). Route it to `__extern_set(fn, ToPropertyKey(k), v)`
  exactly as `fn.p = v` is routed (#3468), then the bag stores `"0"`.
- **S2b String wrapper.** In `buildObjectArrayLikeLengthArm` (and the
  `$Object` arms of `get_idx`/`has_idx`), BEFORE `__extern_get(v,"length")`:
  `__obj_find(o, WRAPPER_PRIMITIVE_KEY)` (`object-runtime.ts:355`, the
  `[[PrimitiveValue]]` slot; `__wrapper_string_value` at
  `object-runtime.ts:5703-5725` is the existing extractor and returns the
  native string or null) → if a string: `length` = `__str_length`, index `i`
  in range → the one-code-unit string (`charAt`), `has` = in range. §10.4.3.
  Keep the ordinary-property walk for everything else, so a wrapper with an
  OWN `length` define still shadows (spec: a String exotic's `length` is
  non-configurable, so nothing can).
- **S2c dyn-view own `length`.** In `ta-dyn-mop.ts:1058-1108`'s
  `__extern_length` arm: before `pushTaDynViewInBoundsLen`, if the view's
  expando bag (field 4 of `$__ta_dyn_view`, `aExp` at 571; lazily created on
  the first ordinary write, 812-820) is non-null and `__hasOwnProperty(exp,
  "length")` → return `ToLength(__extern_get(exp, "length"))`. §10.4.5.4
  step 3 + §10.4.5.1: `"length"` is not a CanonicalNumericIndexString, so an
  own data property on the instance shadows the prototype accessor. (`p2`
  bit 2 — the STATIC `ta.length` read — is not required by the rows; leave
  it.) **Coordinate with #6769** (it edits `ta-dyn-method-call.ts`,
  `ta-dyn-proto-methods.ts`, `dataview-native.ts`, NOT `ta-dyn-mop.ts`;
  still, merge `origin/main` before touching the file and keep the change to
  the one arm).
- **S2d ToLength abrupt.** `buildArrayLikeToLengthFromExternref` (same file,
  used at 246) must run §7.1.20 ToLength = ToIntegerOrInfinity(ToNumber(v)),
  with ToNumber via `__to_primitive(v, "number")` + `__unbox_number` for a
  non-primitive (the `__to_primitive` body throws "Cannot convert object to
  primitive value" when valueOf/toString are both non-callable —
  `object-runtime.ts:4148-4175` — which is the row's TypeError). Read the
  current body first: if it already calls `__to_primitive` for `$Object`
  values, the miss is the `.call(<receiver>)` route (the receiver of
  `Array.prototype.concat.call(o, …)` takes `compileArrayConcatNativeSpecFromExprs`
  → `emitConcatSource` → `__extern_length`) — `p1e` bits 1 AND 2 fail, so the
  operand form fails too; the defect is in the ToLength helper, not the route.
- **S2e RegExp expandos.** `.tmp/6771/rowcopy/regexp.js` (harness) reports
  `Array.isArray(re) === true` for `var re = /abc/`, and the same module
  without the harness refuses to compile (#1539 "RegExp values not created by
  this standalone backend"). Both come from the index/`length` writes
  `re[0] = 1, … re.length = 3` on the module-level binding: find the analysis
  that re-types a `var` from its index writes (`literals.ts:3206-3242`
  `widenedVarStructMap` / the "shape-inferred (vec-widened module-global)"
  path `array-prototype-borrow.ts:66` names) and exclude a binding whose
  initializer is a RegExp literal / `new RegExp` (the oracle's
  `typeFactOf(init).kind`), so the value stays a `$NativeRegExp`; then its
  numeric-key expandos go to the #4010 carrier bag exactly like
  `re.lastIndex`'s neighbours (`$NativeRegExp` is in
  `BUILTIN_INSTANCE_CARRIER_STRUCT_NAMES`, `closure-props.ts:585-605`; the
  bag is what `re[0]` / `re.length` read through `__extern_get`), and
  `RegExp.prototype[0] = 1` / `.length = 3` land on the RegExp brand
  companion (`isProtoIndexWrite`, `array-holes.ts:111`), which S2a's
  `__extern_get(v, key)` delegation walks. Verify each half with the row
  copy's DIAG line (`c.len`, `isArr`, `spv`) before moving on.
- ES5 risk: S2a/S2b/S2c add front arms to the three chokepoints every
  borrowed generic reads through. Pins: `Array/prototype/**` (all passing
  rows — the borrow family `15.4.4.x-*` is ES5), `Function/prototype/**`,
  `String/prototype/**` + `String/**` wrapper rows, `RegExp/prototype/**`,
  `TypedArray/prototype/**` + `TypedArrayConstructors/**`,
  `Object/defineProperty/15.2.3.6-4-1*`.
- Acceptance: 6 rows pass; `p1b` = 63, `p1e` = 7, `p2` ≥ 125 (bit 2
  optional), `p1g` = 63, `p1h` = 127, `p1h7` compiles and answers 255.

### S3 — `Array(n)` / `new Array(n)` holes are holes (1 row)

- Row: `prototype/concat/Array.prototype.concat_spreadable-sparse-object.js`.
- `literals.ts:6823-6858` builds the length-form array as `array.new_default`
  over the externref vec (`elemWasm = externref`, 6784), so every slot is
  `ref.null.extern` = JS `null` (`p1d5`: `nb[2] === null`, `2 in nb` true).
  `new Array(n)` (new-super.ts:8024 validates, then reaches the same builder).
  Under standalone fill the backing with the `$Hole` marker instead:
  `ensureHoleType(ctx)` (array-holes.ts; the marker the #4446 concat loop and
  `vec-externref-hole-presence.ts` already agree on) → `array.new` with the
  marker value (`global.get` of the hole singleton) in place of
  `array.new_default`, gated on `ctx.standalone`. Then verify the READ side
  for a statically typed `any[]`: `nb[2] === undefined`, `typeof nb[2]`,
  `String(nb[2]) === "undefined"`, `!(2 in nb)` (p1d5 must answer 103) — the
  `$ObjVec` readers map the marker to `undefined` (concat-spec header); if the
  typed `__vec_externref` element read does not, add the map at the read
  (`vec-props.ts` / the element-read arm that `protoIndexRecvGetMissInstrs`
  feeds), never at the write.
- After S3 re-run the row; if it still dies with "uncaught Wasm-GC exception
  (non-stringifiable payload)", instrument `.tmp/6771/rowcopy/sparse.js`'s
  DIAG (it already prints `cmp2`) — the remaining throw is then in the
  harness's 4000-element `compareArray.format` path, not in concat.
- ES5 risk: HIGH surface — `Array(n)` is everywhere in ES5 rows
  (`S15.4.2.2_*`, every `15.4.4.x` sparse-array row, `join`/`toString` of
  holes). Pins: ALL passing `built-ins/Array/**` rows (~1,300) +
  `language/expressions/new/**` + `Array/length/**`. Run them all once after
  S3.
- Acceptance: row passes; `p1d5` = 103, `p1d3` = 255, `p1d4` = 63.

### S4 — `flat` / `flatMap` run ArraySpeciesCreate (3 rows)

- Rows: `prototype/flat/target-array-{non-extensible,with-non-configurable-property}.js`,
  `prototype/flatMap/target-array-non-extensible.js`.
- `compileArrayFlatNativeCall` (`array-flat-native.ts:540-573`) compiles the
  receiver into `recv`, then `call __arrprod_<flat|flatMap>` (a plain
  `$ObjVec`). Wrap it exactly as `array-proxy-receiver.ts` (S1) wraps
  slice/splice: `prepareArraySpeciesDeps` before the operands compile;
  after the helper, `species = emitArraySpeciesCreate(ctx, fctx, deps,
  [local.get recv], [f64.const 0])` (§23.1.3.13 step 5 / §23.1.3.14 step 5
  both pass `0`), then `emitArraySpeciesResultSwap(…, EXTERNREF)` — the swap's
  `__defineProperty_value` is the CreateDataPropertyOrThrow that throws the
  two rows' TypeErrors (non-extensible target; non-configurable accessor at
  `"0"`). Same recorded ordering under-approximation as S1(c) (spec creates
  `A` before flattening) — no row in this bucket observes it.
- The TYPED receivers do not reach that function: `arr.flat(1)` on `number[]`
  takes the #3363 static depth-1 path and `arr.flatMap(cb)` takes
  `tryCompileFlatMapNative` (`array-methods.ts:10668-10727`), which calls
  `compileArrayMap` (species widens its result to externref) and then
  `flatMapSpeciesResult` declines for an array-returning callback → the
  #2717 refusal at 10838 (`p11b`). Add one route at the top of both: when
  `arraySpeciesActive(ctx)` (`array-species.ts:102`), go to
  `compileArrayFlatNativeCall` (now species-aware) instead. Modules without
  `Symbol.species` / `.constructor =` keep their bytes (the flag is the
  pre-scan's).
- ES5 risk: none (ES2019 methods); pins `Array/prototype/{flat,flatMap}/**`
  (28) + the species rows `Array/prototype/*/create-species*.js`.
- Acceptance: 3 rows pass; `p11a` = 15, `p11b` = 1.

### S5 — `Array.prototype[@@unscopables]` (2 rows) — new leaf `src/codegen/array-unscopables.ts`

- Rows: `prototype/Symbol.unscopables/{prop-desc,value}.js` (and, for free,
  the 3 non-ES2015 rows in the same directory once the full ES2024 list is
  seeded).
- The Array `$NativeProto` glue (`array-object-proto.ts:175`
  `ARRAY_PROTO_METHODS`, registered at 2844) seeds string members and the
  `@@1` iterator alias as METHOD closures. A symbol-keyed DATA property
  already has one precedent: `glue.symbolTag` (`native-proto.ts:788-803`)
  is seeded into the brand companion with `PROTOTYPE_SEED_FLAGS.symbolTag`
  (0xbc = `{writable:false, enumerable:false, configurable:true}` — exactly
  §23.1.3.38's attributes) and recognised by `__nproto_hasown` /
  `__nproto_gopd` through `seededNativeProtoSymbolTagsByBrand` (555-566).
  Generalise it: add to `NativeProtoBuiltinGlue` an optional
  `symbolDataProps?: ReadonlyArray<{ id: number; flags: number; value: (ctx, seedFctx) => Instr[] }>`,
  seeded in the same loop with `buildPrototypeSeedSymbolKey(id, boxSymbolIdx)`
  + the value instrs + `buildPrototypeSeedDataTail(defineIdx, flags)`, and
  make the two `seededNativeProtoSymbol*ByBrand` readers (and
  `native-proto-own-props.ts`'s hasown/gopd ladders, ~96-230) enumerate
  `symbolDataProps` ids alongside `symbolTag`. For Array: id **11**
  (`WELL_KNOWN_SYMBOLS.unscopables`, builtin-value-read.ts:185), flags 0xbc,
  value = the leaf's `emitUnscopablesObject`: `__object_create(null)` (a
  `$Object` with `$proto` null — `Object.getPrototypeOf(u) === null` is
  asserted) then `__defineProperty_value(o, "<name>", true, 0b1011_1111)` for
  each of §23.1.3.38's list: `at, copyWithin, entries, fill, find, findIndex,
  findLast, findLastIndex, flat, flatMap, includes, keys, toReversed,
  toSorted, toSpliced, values`. Build it ONCE into a module global (identity
  is observable across reads) and reuse the externref.
- The static computed read `Array.prototype[Symbol.unscopables]`
  (`native-proto-value-read.ts`, the well-known-symbol path that serves `@@1`)
  must resolve id 11 to the seeded entry rather than to a member closure —
  follow how `Symbol.toStringTag` value reads reach the companion. `p5` bit 1
  passing today with bit 2 failing means the read currently answers a
  non-object carrier; the row throws on `getPrototypeOf(undefined)`.
- `verifyProperty` in `prop-desc.js` also WRITES (`Array.prototype[@@unscopables]
  = "unlikelyValue"` must be a silent sloppy no-op — non-writable) and
  DELETES (`delete Array.prototype[@@unscopables]` must succeed —
  configurable — after which `hasOwnProperty` is false). Both are what the
  companion entry gives for free once the flags are right (the same
  `symbolTag` path is exercised by `Symbol.toStringTag` prop-desc rows).
- `with` interaction: `with-scope.ts` (50-70, 393) consults the receiver's
  `@@unscopables` at run time for dynamic receivers; an array receiver now
  has a real blocklist object. That is spec behaviour
  (`language/statements/with/unscopables-*.js`) — pin the whole `with`
  family (173) to be sure nothing that passed by accident regresses.
- ES5 risk: `with` + `Object.getOwnPropertyDescriptor(Array.prototype, …)`
  rows. Pins: `language/statements/with/**`, `Array/prototype/Symbol.*`,
  `Object/getOwnPropertyDescriptor/**`, `Object/getOwnPropertyNames/**` (the
  symbol must NOT appear there), `Object/keys/**`.
- Acceptance: 2 rows (+3) pass; `p5` = 511.

### S6 — `Boolean.prototype.toString` / `.toLocaleString` overrides reach a boolean receiver and the array `toLocaleString` boolean element (2 rows) — new leaf `src/codegen/bool-to-locale-string.ts`

- Rows: `prototype/toLocaleString/primitive_this_value{,_getter}.js` (both
  `onlyStrict`: `typeof this` inside the override must be `"boolean"`, so
  the primitive is the receiver, boxed on the wire only).
- Mirror #6651 TA1 (`to-locale-string-element.ts`): `reserveNumberToLocaleString`
  (176-190) is gated on `sourceOverridesBuiltinPrototypeMember(anchor,
  "Number", "toLocaleString")` and filled by `fillNumberToLocaleString`
  (264-296) with `buildNumberCompanionProbe` (493-540): companion
  presence probe (`protoIndexBrandCompanionHasInstrs`), receiver-aware
  companion `[[Get]]` (`protoIndexRecvGetMissInstrs` — invokes a companion
  ACCESSOR with the original receiver as `this`, proto-index-store.ts:69-70,
  which is what the getter row needs), `__apply_closure(m, box, null)`,
  `__extern_toString`. Write the Boolean twin in the new leaf:
  `reserveBoolToLocaleString(ctx, fctx, anchor)` gated on
  `sourceOverridesBuiltinPrototypeMember(anchor, "Boolean", "toString") ||
  (…, "toLocaleString")` (the scanner, `builtin-proto-member-override.ts:
  111-165`, recognises both the assignment and the
  `Object.defineProperty(Boolean.prototype, "toString", …)` spellings — the
  getter row's define is seen). Body of `__bool_to_locale_string(i32) ->
  externref`: box via `__box_boolean`; consult the Boolean brand companion
  (`builtinBrandOffsetOf("Boolean")`) for `"toLocaleString"` → if callable,
  apply and `ToString`; else §20.1.3.5 `Object.prototype.toLocaleString` =
  `Invoke(O, "toString")` → consult the companion for `"toString"` → apply;
  else the native `"true"`/`"false"`. `typeof this` of the boxed boolean
  inside the closure must classify `"boolean"` (`__typeof_boolean` is the
  predicate the #1896 typeof natives use) — verify with `p6` bit 2 first.
- Wire two callers: (1) the boolean-receiver arm in
  `call-receiver-method.ts:3759-3768` (`isBooleanType(receiverType)` →
  `emitBoolToString`) — when the reserve returns a funcIdx, call it for
  `toString` and `toLocaleString` (today `toLocaleString` on a boolean falls
  further down to the generic `__extern_toString` arm at ~3790); (2) the
  array `toLocaleString` element fold's BOOLEAN arm (`array-join-element.ts`
  header names the four arms; `array-tolocalestring.ts::isLocalizedJoin`
  selects the localized tail) — for `toLocaleString` only, replace the
  `"true"`/`"false"` literal select with `call __bool_to_locale_string`.
  `join`/`toString` keep their bytes (§23.1.3.18 is `ToString`, not
  `Invoke`).
- Absent-not-wrong: no companion hit ⇒ native rendering, so a module that
  only DELETES `Boolean.prototype.toString` keeps
  `tryCompileStandaloneDeletedBooleanToString`'s path
  (`standalone-primitive-tail.ts:138`).
- ES5 risk: `Boolean/prototype/toString/**` (`S15.6.4.2_*`),
  `Array/prototype/{join,toString,toLocaleString}/**`. Pins: `Boolean/**`
  (50), `Array/prototype/toLocaleString/**` (6), `Array/prototype/join/**`.
- Acceptance: 2 rows pass; `p6` = 63, `p6b` = 7.

### S7 — `Array.from.call(C, …)`: the fnctor prototype's `constructor` back-link; `Construct(Object)` (2 rows)

- Rows: `from/iter-cstm-ctor.js`, `from/source-object-constructor.js`.
- `p7` bit 16: `C.prototype.constructor === C` is FALSE for `var C =
  function(){}`. The per-fnctor prototype `$Object` (`expressions/
  fnctor-prototype.ts`, lazily `__new_plain_object` on first `F.prototype`
  read; #2660 S2) is created without the §10.2.5 MakeConstructor
  `constructor` data property `{writable:true, enumerable:false,
  configurable:true}`; `new C().constructor` passes only because that read is
  folded statically, while `__native_construct_0` (native-construct.ts,
  #3981) builds a real `$Object` whose `constructor` read walks the chain and
  lands on `Object.prototype.constructor`. Seed the back-link at the lazy
  init: `__defineProperty_value(proto, "constructor", <closure singleton>,
  0xb9)` where the closure value is the identity-stable
  `ctx.funcClosureGlobals` global (`__fn_closure_<name>`, the same handle
  `closure-prototype-edge.ts` keys on). The file already interns
  `"constructor"` at 289-292 / 382-383 for a related read — read those two
  sites first; if one of them is a `hasOwn("constructor")` probe (the comment
  at 349 says so), the seed belongs next to it. Verify `hasOwn` stays true
  after a user `F.prototype = {…}` reassignment (spec: the user object
  decides; do not re-seed).
- `p7` bits 32/512: `Array.from.call(Object, [])` → `Construct(Object)` via
  `__native_construct_0(<Object namespace carrier>)` → `__object_create(
  __extern_get(Object, "prototype"))` — the namespace carrier's `prototype`
  read answers null, so the instance has no `[[Prototype]]`. Add an `Object`
  arm to the driver (precedent: `builtinCollectionConstructArm`, #6720, in
  `native-construct.ts`): callee `ref.eq` the reified `Object` carrier ⇒
  `__new_plain_object()` (its `$proto` IS `%Object.prototype%`). Then
  `.constructor` walks to `Object.prototype.constructor === Object` (`p7`
  bit 128 already passes).
- `iter-cstm-ctor.js` then also asserts `callCount === 1`, `thisVal ===
  result`, `args.length === 0` (`p7` bit 4) — the constructor lane in
  `array-from-native.ts:609-617` calls `__native_construct_0` with no args;
  if bit 4 still fails after the back-link, the `arguments` object inside a
  natively-constructed closure is the suspect (record, do not chase).
- ES5 risk: `Function/prototype/**`, `Object/prototype/constructor/**`,
  `language/statements/function/**` (`S13.2.2_*` construct rows). Pins those
  three families.
- Acceptance: 2 rows pass; `p7` ≥ 1019 (bit 4 optional).

### S8 — a deleted numeric-keyed f64 field of a closed struct reads `undefined` through `__extern_get_idx` (1 row)

- Row: `from/source-object-length.js`.
- `delete obj[2]` on the closed literal `{0:2,1:4,2:0,3:16,length:4}` sets
  the f64 field to the NaN sentinel (`typeof-delete.ts:246-262,357-370`).
  The string-key closed-struct arm of `__extern_get` maps it (`p8c` = 1), the
  numeric arm of `__extern_get_idx` (spliced by `fillExternArrayLikeStructArms`,
  #3317) reads the raw field → `Array.from`'s array-like loop
  (`array-from-native.ts:413+`, `Get(items, k)` via `__extern_get_idx`) stores
  NaN. Fix in the fill: for an f64 field, apply the same sentinel→`undefined`
  mapping the string-key arm uses (locate it by the `deleteSentinelInstr`
  consumers); or delegate the closed-struct numeric arm to `__extern_get(v,
  number_toString(idx))` as the `$Object` arm does — cheaper and keeps ONE
  mapping. `p8d` (`Object.keys` on that struct traps `illegal cast`) is a
  separate defect — record it in the run log, do not fix here.
- ES5 risk: `language/expressions/delete/**` (62), `Array/from/**`,
  `Object/keys/**`. Pins those.
- Acceptance: row passes; `p8` = 63, `p8c` = 1.

### S9 — boolean-element vec index reads under `protoIndexDirty` (1 row)

- Row: `of/does-not-use-prototype-properties.js`.
- `p9b` = 27: once the module contains `Object.defineProperty(Array.prototype,
  "0", {set})` (`isProtoIndexWrite` → `ctx.protoIndexDirty`), every
  BOOLEAN vec read — `[true][0]`, `b[0]`, `[false,true][1]`, even after
  `delete Array.prototype[0]` — answers `undefined`; f64, string and object
  vecs are unaffected, and the setter never fires (bit 2 ✓). So the i32
  (boolean) carrier's element read takes the proto-index consult INSTEAD of
  its own element. Bisect the read: compile `.tmp/6771/p9b.js` with
  `JS2WASM_KEEP_WAT`-style dumping (or read the emitted `arr[0]` for a
  `boolean[]` local under `protoIndexDirty`) and find which arm — the static
  element read in `property-access.ts` / `vec-props.ts:464`
  (`protoIndexRecvGetMissInstrs(ctx, 0, 1)`), or the dynamic
  `__extern_get_idx` `__vec_i32` arm (`fillExternGetIdxVecArms`) — consults
  the store before the in-range own read. The rule to restore: a dense
  in-range element is an OWN property (§10.4.2.1); the store is a MISS
  fallback only (proto-index-store.ts:60-70 states it). The likely culprit
  is a "presence" test that treats an i32 element as absent (no hole sentinel
  exists for i32 carriers, unlike NaN/`$Hole`).
- ES5 risk: every boolean-array row (`Array/prototype/*/15.4.4.x-*` with
  `[true]` fixtures). Pins: `Array/prototype/**` + `Array/of/**`.
- Acceptance: row passes; `p9b` = 511, `p9` = 127.

### S10 — ArraySetLength: two coercions, coerce-before-writable-check, `Reflect.set`/`Reflect.defineProperty` false channel (3 rows) — new leaf `src/codegen/array-set-length-coercion.ts`

- Rows: `length/define-own-prop-length-{coercion-order-set,coercion-order,no-value-order}.js`.
- **Coordinate with #6770 (Object/Reflect residue — planned in parallel; its
  branch `plan-6770-object-reflect` had no issue file at plan time).** The
  `Reflect.defineProperty` false channel (S10c) is the one piece both lanes
  could reasonably own: check #6770's plan before starting; if it claims the
  applier's failure channel, take only S10a/S10b here and consume its
  channel.
- **S10a `array.length = v` (assignment.ts:4862-4885).** §10.4.2.4 steps 3–4
  are TWO observable conversions: `newLen = ToUint32(v)`, `numberLen =
  ToNumber(v)`, then `newLen ≠ numberLen ⇒ RangeError`; ONLY THEN
  (step 12) `oldLenDesc.[[Writable]] false ⇒ return false` (strict: TypeError).
  Today: `coerceType(→f64)` once, then `emitArraySetLengthValidation`, and
  `buildOverlayArrayLengthSet` reads the writable bit. For a value whose
  static type is not provably primitive (the oracle's `staticJsTypeOf(v)` is
  not number/string/boolean/nullish), emit the leaf's
  `emitArraySetLengthCoerce(ctx, fctx, vLocal)`: `__to_primitive(v,"number")`
  → `__unbox_number` → `ToUint32` (i32 wrap of the f64 via the existing
  validation), AGAIN `__to_primitive(v,"number")` → `__unbox_number`, compare,
  RangeError. `p3` shows a further defect to reproduce first: with the
  `@@toPrimitive` function itself freezing `length`, the strict assignment
  throws BEFORE any coercion (hints `[]`) — i.e. the writable check runs
  first; move it after. `Reflect.set(array, "length", v)` reaches
  `__reflect_set` (call-namespace-static.ts:2680), which has NO vec-length
  arm (object-runtime.ts:3302-3460); add one in the leaf (splice-front on
  `__reflect_set`, `ref.test $__vec_base` + key `"length"`): same
  double-coercion, then `false` when the companion's `"length"` entry is
  non-writable (vec-overlay.ts:943-1000 seeds it), else perform the
  `__vec_dp_value` length body and `true`.
- **S10b `Object.defineProperty(arr, "length", {value: v, …})`.**
  `maybeEmitVecLengthDefine` (array-length-define.ts:112-200) defers an
  object-valued `value` to the generic applier; the `"length"` define body in
  `vec-overlay.ts:1070-1140` (`lengthToNumber`) converts ONCE. Make it the
  two-step of §10.4.2.4 steps 3–4 (call the same leaf helper from the
  splice), and read the seeded `"length"` entry's writable bit AFTER
  (step 12), throwing `throwType()` — `coercion-order.js` asserts
  `valueOfCalls === 2` and the TypeError.
- **S10c `Reflect.defineProperty` → `false`.** The standalone arm
  (call-namespace-static.ts:1706-1800) documents the limitation: the applier
  `__obj_define_from_desc` / `__defineProperty_value` throw on every
  §10.1.6.3 rejection (`object-runtime-descriptors.ts:340-352` messages;
  vec-overlay.ts S3 `throwType`/`throwTypeMsg`; `vec-define-rejections.ts`).
  Add a module global `__define_soft` (mut i32, default 0) + `__define_rejected`
  (mut i32): the Reflect arm sets soft=1 / rejected=0 around the applier
  call and returns `rejected == 0`; every TypeError rejection site listed
  above becomes `if (soft) { rejected = 1; return <recv> } else throw`.
  RangeError (ArraySetLength step 3) and the ToPropertyDescriptor TypeErrors
  (malformed descriptor) still throw under Reflect (spec). Implement the
  site edit as ONE helper `buildDefineRejectInstrs(ctx, throwInstrs)` in the
  leaf so no site hand-rolls the check.
- ES5 risk: HIGH — `Object/defineProperty/15.2.3.6-4-1*` (109, the array
  `length` family), `Object/defineProperty/**`, `Object/defineProperties/**`,
  `Array/length/**` (28), `Array/prototype/*/15.4.4.x-*` rows that set
  `length`. Pins all of them + `Reflect/defineProperty/**` (11) +
  `Reflect/set/**` (17).
- Acceptance: 3 rows pass; `p3` = 511, `p3b` = 127, `p3c` = 135, `p4` = 127.

### S11 — Proxy traps are `GetMethod(handler, name)` per operation; the species swap does not `Set` a proxy target (1 row, stretch) — new leaf `src/codegen/proxy-trap-getmethod.ts`

- Row: `prototype/splice/property-traps-order-with-species.js`.
- Two halves, both measured by `p16` (main 20, node 123):
  (a) `__proxy_create` (object-runtime-proxy.ts:1546-1760) reads all 13 traps
  off the handler at creation (`readTrap(...)` ×13 into `$ProxyTraps`), so a
  handler that is itself a Proxy logs `get, set, has, apply, deleteProperty,
  …` at `new Proxy(...)` — §28.2.1.1 ProxyCreate reads nothing; §10.5.x each
  do `GetMethod(handler, "<trap>")` at the operation. (b)
  `emitArraySpeciesResultSwap` (array-species.ts:427-470) does
  `__defineProperty_value` AND `__extern_set` per element (the `Set` exists
  because a `$vec` target's define writes only the overlay); on a PROXY
  target that is an extra `set` trap per element — the expected log has
  exactly one `set` (for `length`).
- (b) first (cheap, safe): guard the post-define `Set` with `ref.test
  $__vec_base` on the species object — only a vec target needs the dense-lane
  write; a `$Object` / `$Proxy` target got the value from the define.
- (a): the 13 field reads happen at ~16 dispatch sites (`struct.get
  $ProxyTraps` in object-runtime-proxy.ts 415, 723, 837, 1052, 1142, 1386,
  1507, 1991, 2122; object-integrity-proxy.ts 245, 440, 616, 643;
  object-runtime-proxy-chain.ts 361; object-runtime.ts 4026;
  object-runtime-prototype.ts 413). Keep the `$ProxyTraps` struct and its
  field indices (every site's local layout depends on them) but make the
  STORED values lazy: at ProxyCreate store `null` in every slot and set a new
  `$Proxy` bit `lazyTraps = 1`; add the leaf's native
  `__proxy_trap(proxy: externref, field: i32) -> externref` = if `revoked` ⇒
  TypeError; `GetMethod(phandler, NAME[field])` (`__extern_get` +
  `__nullish_to_null`; a present non-callable ⇒ TypeError per §7.3.10);
  and replace each `struct.get $ProxyTraps <field>` with `call __proxy_trap`
  through ONE helper `readTrapInstrs(d, proxyLocal, field)` exported by the
  leaf — mechanical, no per-site logic. Keep the eager snapshot behind
  `lazyTraps = 0` for the `handler is a revoked proxy` special case (#5140)
  only if the lazy path cannot express it (it can: the GetMethod on a revoked
  handler throws at the operation, which IS the spec).
- ES5 risk: none (Proxy is ES2015), but `Proxy/**` has 265 passing rows and
  `Reflect/**`, `Object/**` rows reach proxies through every MOP native —
  pin `Proxy/**`, `Reflect/**`, `Object/getOwnPropertyDescriptor/**`,
  `Object/defineProperty/**`, `Array/prototype/*/create-*proxy*.js`, plus the
  suites `issue-1355-*`, `issue-5196-*`, `issue-5122-*`, `issue-6766-*` (one
  vitest process each). Ship (b) even if (a) does not land in the window.
- Acceptance: row passes; `p16` = 123 (with (b) alone: bit 16 stays set, bit
  32/64 still fail).

### Not planned here (1 row) — record, do not chase

- `from/source-array-boundary.js`: `Array.from(array, mapFn, this)` at script
  top level with `this.arrayIndex++` aliasing the top-level `var arrayIndex`.
  That is the global-object ↔ `var` binding of a sloppy script (#2727,
  `typeof this` at top level), not an Array mechanism; `Array.from`'s
  `thisArg` forwarding is already correct (`iter-map-fn-this-*` rows pass).
  Cross-reference #2727; leave the row.
- Realm rows: none in this bucket (excluded upstream); nothing to flag.

### Step 12 — measure, controls, gates, record

- Re-run `rows.txt` (expect ≥ 32 pass; ≥ 33 with S11(a); name each
  residual's first failing assertion) and the probe table (`p14` 255/31, `p15`
  31, `p1f` 1, `p13b` 7, `p1b` 63, `p1e` 7, `p1g` 63, `p1h` 127, `p2` ≥ 125,
  `p1d5` 103, `p1d3` 255, `p11a` 15, `p11b` 1, `p5` 511, `p6` 63, `p6b` 7,
  `p7` ≥ 1019, `p8` 63, `p9b` 511, `p3` 511, `p4` 127, `p16` 123).
- Pin suite `tests/issue-6771-array-residue.test.ts`: one case per probe
  above asserting the node answer (RED on `.tmp/6771/base-src` — swap `src/`
  in, run, swap back, write the base verdict into the record), plus guards
  that answer the same on both trees: `[1,2,3].concat([4])`, `new Array(3).length`
  and `Array(3).join(",") === ",,"`, `[true,false].toString()`,
  `Object.defineProperty([1,2], "length", {value: 1})`, `[1].flat()`,
  `new Proxy({}, {}).x`, `function F(){}; new F() instanceof F`.
- Controls (0 pass → non-pass, per-path set diff, `--isolate`, under the
  lock): the union of every pin set named above, extracted once at Step 0
  (≈ 3,000 rows ≈ 2 h at the shared lock's pace; run it ONCE at the end on
  the merged tree, and the per-step subset after each step).
- Gates, bare and chained (never piped): `node scripts/check-loc-budget.mjs &&
  node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs
  && npm run -s check:oracle-ratchet && npm run -s check:dead-exports && node
  scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main
  && npm run -s typecheck`, then loc/func again with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`. Delete
  `.tmp/core-node-execution-*` after `check:dead-exports`.
- Record: append `### 2026-09-30 — #6771 implementation (Opus)` to THIS file
  with the before/after row table, the probe table's `branch` column, the
  pins' base verdict, the control diff, and residuals with mechanisms; then
  a one-paragraph pointer in `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`
  under a new `### 2026-09-30 — #6771 …` heading (and close the H6 record's
  "reverted, unmeasured" note by pointing at S1's measurement).

## Acceptance criteria

- ≥ 32 of the 34 rows pass on standalone (`--isolate`), measured on the
  branch with `origin/main` merged in; the two allowed residuals are
  `from/source-array-boundary.js` (#2727) and, if S11(a) does not land,
  `splice/property-traps-order-with-species.js`; every other residual has
  its first failing assertion and mechanism named in the record.
- Probe answers on the branch as listed in Step 12; the pin file is red on
  the base sources.
- **0 pass → non-pass across every ES5 row** in the union control (the
  edition ratchet's `completed: true` gate for ES5 blocks the merge queue on
  ONE row), and 0 across the rest of the union.
- All gates green; `src/ir/select.ts`, `object-runtime.ts`,
  `dataview-native.ts` bodies untouched (arms spliced from leaves only);
  growth grants in this file's frontmatter only.

## Overlap / ordering with in-flight lanes

- **#6769 (TypedArray residue, active):** S2c edits `ta-dyn-mop.ts`'s
  `__extern_length` arm; #6769 lists `ta-dyn-method-call.ts`,
  `ta-dyn-proto-methods.ts`, `dataview-native.ts`, `array-methods.ts`
  (`emitDynViewSpeciesMethodTwoArm` / `emitDynViewMethodTwoArm`, lines
  ~1588-1900) — disjoint functions from S1's `setupArrayLoop` /
  `compileArrayMap` / `compileArrayFilter` (~6850-7800). Merge `origin/main`
  before S1 and S2c; expect textual, not semantic, conflicts in
  `array-methods.ts`.
- **#6770 (Object/Reflect residue, planned in parallel):** S10c
  (`Reflect.defineProperty` false channel through the shared applier) is the
  one shared mechanism — settle ownership before S10 (see the step).
- **#6767 (class reflective residue):** touches
  `expressions/object-get-prototype-of.ts` (its `isStandaloneBaseClassOrPrototype`
  import is what made the H6 patch's hunk drift) — S1's hand-apply is against
  the post-#6767 file; no semantic overlap.
- **#6766 (Proxy-as-prototype):** S11(a) rewrites every `$ProxyTraps` read,
  including `object-runtime-proxy-chain.ts:361` that #6766 added; if #6766 is
  still open when S11 starts, base S11 on its branch.
- **#6651 H6 record:** S1 is the "next lane" the record hands the reverted
  set to; write the measurement it lacked.

## Lane protocol

- Worktree: `git worktree add /home/user/js2/.claude/worktrees/issue-6771 -b issue-6771-array-residue origin/main`,
  then `ln -s /home/user/js2/node_modules <wt>/node_modules` and
  `rm -rf <wt>/test262 && ln -s /home/user/js2/test262 <wt>/test262` (the
  hook does not provision them). Never edit `/home/user/js2` itself — it is
  the BASE tree the lead measures against.
- One test262 runner at a time on this 4-core box: every
  `run-test262-paths.mts` invocation goes through
  `flock /tmp/claude-0/t262.lock …` (paths relative to `test262/test/`; a
  `../../.tmp/…` path is accepted and is the harness-prefixed probe channel).
  Rebuild the QuickJS adapter after a `src/` change if a row reports
  "provider is not built": `npx tsx scripts/build-quickjs-eval-provider.mjs`.
  No full vitest suites.
- New `src/` files (`array-copywithin-native.ts` back from S1,
  `array-like-exotic-arms.ts`, `array-unscopables.ts`,
  `bool-to-locale-string.ts`, `array-set-length-coercion.ts`,
  `proxy-trap-getmethod.ts`) MUST be registered in
  `scripts/compiler-boundaries.json` — a textual insert next to their
  neighbours with the entry shape `{ "path": "src/codegen/<file>.ts",
  "state": "unmigrated", "layer": "mixed-needs-split", "destination":
  "backend-wasmgc", "owner": "3518-coordinator", "nextBoundary": "<same as
  the neighbouring array-*.ts entry>" }`; the boundaries gate runs in the
  chain above with `--base origin/main`.
- Gate chain before EVERY commit, bare and chained (see Step 12), with
  `LOC_GATE_BASE=$(git rev-parse origin/main)` for the loc/func gates; LOC /
  func growth allowances go in THIS file's frontmatter with a dated rationale
  (already granted above — extend, never edit `scripts/*-baseline.json`).
- Push needs `NODE_OPTIONS=--max-old-space-size=4096 git push -u origin
  <branch>` (the pre-push hook takes minutes — run it detached and poll the
  log); never `--no-verify`. Commit early and push the branch immediately;
  do NOT open a PR and do NOT enqueue — the lead verifies the pushed head and
  opens it.
- Commit format: subject ends with ` ✓`; author `Thomas Tränkler
  <git@thomas.traenkler.com>`, committer `Claude <noreply@anthropic.com>`;
  trailers `Co-Authored-By:` for the implementing model, `Claude-Session:
  https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`, and the `Model:`
  trailer naming the dispatched model and effort (AGENTS.md § Commit
  Attribution).
- No `git stash`; A/B by file copy from `.tmp/6771/base-src`.

## 2026-10-01 — implementation record (Opus)

Branch `issue-6771-array-residue`: S1–S10b, the S3 and S7 follow-ups and the
pin suite, merged with `origin/main` @ `5dfc21de14` (every measurement below
ran on the merge with `a895598841`; `5dfc21de14` adds only npm-compat
artifacts, no `src/`). By lead decision S10c (the
`Reflect.defineProperty` false channel) is **#6770 S4** and S11 (lazy
`GetMethod` per Proxy trap) is **#6770 S8** — neither is built here. #6770 S4
is on `origin/issue-6770-object-reflect-residue` (`9173486efc`), not on main.

### Rows — 34, `flock … run-test262-paths.mts .tmp/6771/rows.txt --isolate --standalone`

| tree | pass | fail | CE | log (`.tmp/6771/`) |
| --- | ---: | ---: | ---: | --- |
| `origin/main` @ `2ef807a68e` (plan) | 0 | 33 | 1 | `rows-base-2ef807a68e.log` |
| `origin/main` @ `a895598841` (today's base, re-measured) | **0** | 33 | 1 | `rows-base-a8955.log` |
| after S1 (measured mid-step, before the trap-return widening) | 10 | 23 | 1 | `rows-s1.log` |
| after S1–S9 | 29 | 5 | 0 | `rows-m3.log` |
| after S10a/S10b | 30 | 4 | 0 | `ctl-out/c000-rows.log` |
| **head, merged with `a895598841`** | **30** | 4 | 0 | `rows-m5.log` (std runner) = `iso-rows.log` (row for row) |
| head + #6770's branch, trial merge (not committed) — the 4 residual rows | 2 of 4 | 2 | 0 | `rows-with6770.log` |

Per step (each row is attributed to the step whose mechanism it failed on;
the cumulative counts above are the measurements):

| step | rows | n |
| --- | --- | ---: |
| S1 | `{slice,splice,map,filter,concat}/create-proxy.js`, `{map,splice}/create-species-undef-invalid-len.js`, `slice/create-proxied-array-invalid-len.js`, `concat/arg-length-exceeding-integer-limit.js`, `copyWithin/return-abrupt-from-{has-start,delete-proxy-target}.js` | 11 |
| S2 | `concat/Array.prototype.concat_spreadable-{function,string-wrapper,reg-exp}.js`, `concat_{large,small}-typed-array.js`, `concat_array-like-to-length-throws.js` | 6 |
| S3 | `concat/Array.prototype.concat_spreadable-sparse-object.js` | 1 |
| S4 | `flat/target-array-{non-extensible,with-non-configurable-property}.js`, `flatMap/target-array-non-extensible.js` | 3 |
| S5 | `Symbol.unscopables/{prop-desc,value}.js` | 2 |
| S6 | `toLocaleString/primitive_this_value{,_getter}.js` | 2 |
| S7 (+ follow-up) | `from/iter-cstm-ctor.js`, `from/source-object-constructor.js` | 2 |
| S8 | `from/source-object-length.js` | 1 |
| S9 | `of/does-not-use-prototype-properties.js` | 1 |
| S10a/S10b | `length/define-own-prop-length-coercion-order-set.js` | 1 |
| | **total** | **30** |

### Residual rows (4) — first failing assertion and mechanism

1. `length/define-own-prop-length-no-value-order.js` — `!Reflect.defineProperty([],
   "length", {enumerable: true})`: the standalone `Reflect.defineProperty` arm
   lets the applier's TypeError escape instead of answering `false` (S10c).
   **Passes on the trial merge with #6770's branch** (`rows-with6770.log`).
2. `length/define-own-prop-length-coercion-order.js` — first assertion,
   `Object.defineProperty(array, "length", {value: length, writable: true})`
   throws a TypeError: "no exception". **Not an ArraySetLength defect** — the
   test262 assembly is a SCRIPT (no import/export), so TypeScript MERGES the
   row's top-level `var length = {valueOf …}` with lib.dom's
   `declare var length: number` (Window.length). The binding is checker-typed
   `number`, its initializer is ToNumber'd once at the declaration (`valueOf`
   runs there, `valueOfCalls` = 1), and the define receives the number 2.
   Isolated: `.tmp/6771/q14.js` (no exports) reads `typeof length ===
   "number"` (node: `"object"`); one added `export` (`co-x1.js`) makes it a
   module and the define throws the TypeError; the row copy with the binding
   renamed (`rowcopy/co2.js`) passes the first assertion on the branch and
   the WHOLE row on the #6770 trial merge (`with6770/`, in-process dev
   check). #2176's `resolveIdentifierType` handles the non-merging
   `const name` collider; a MERGING top-level `var` keeps lib.dom's type.
   10 test262 files declare such a top-level var (`var
   length|status|top|origin|parent|self|…`): the two
   `Array/length/define-own-prop-length-coercion-order*.js`,
   `Promise/race/resolve-self.js`,
   `Iterator/zipKeyed/iterables-iteration-inherited.js`,
   `Symbol/{for,keyFor}/cross-realm.js`,
   `language/reserved-words/unreserved-words.js`,
   `language/expressions/super/prop-{dot,expr}-obj-ref-this.js`,
   `language/statements/function/13.2-30-s.js`. Needs its own issue
   (checker level: a user `var` merged with a lib.dom global, or a DOM-free
   lib for `--target standalone`), plus #6770 S4 for the Reflect half.
3. `from/source-array-boundary.js` — `this.arrayIndex` in the `Array.from`
   callback does not alias the top-level `var arrayIndex` (global object ↔
   script `var`, #2727). Not an Array mechanism; recorded, not planned.
4. `splice/property-traps-order-with-species.js` — trap log starts `get, set,
   has, apply, …` (ProxyCreate snapshots all 13 traps): S11, #6770 S8. Also
   fails on the #6770 trial merge (S8 is not on that branch yet).

### Probe table (`.tmp/6771/probes-all.sh`; node / branch head / `origin/main` @ `a895598841`)

| probe | node | branch | base | |
| --- | ---: | ---: | ---: | --- |
| p14 | 255 | **255** | 0 | |
| p14b | 511 | 0 | 0 | residual (a) |
| p15 | 31 | **31** | trap | |
| p1f | 1 | **1** | trap | |
| p13b | 7 | **7** | 7168 | |
| p1b | 63 | **63** | 3 | |
| p1e | 7 | **7** | 4 | |
| p1g | 63 | **63** | 35 | |
| p1h | 127 | **127** | 84 | |
| p1h7 | 255 | **255** | CE (#1539) | |
| p2 | 127 | 85 | 21 | residual (b); plan asked ≥ 125 |
| p1d5 | 103 | **103** | 273 | |
| p1d3 | 255 | 243 | 179 | residual (c) |
| p1d4 | 63 | **63** | 17 | |
| p11a | 15 | **15** | 8 | |
| p11b | 1 | **1** | CE (#2717) | |
| p5 | 511 | **511** | 449 | |
| p6 | 63 | 47 | 33 | residual (d) |
| p6b | 7 | **7** | 0 | |
| p7 / p7u | 1023 | **1023** | 200 / 205 | |
| p8 | 63 | **63** | 55 | |
| p8c | 1 | 1 | 1 | |
| p8d | 7 | trap | trap | residual (e), "record, do not fix" |
| p9 / p9b | 127 / 511 | **127 / 511** | 122 / 27 | |
| p3 | 511 | throws | 1 | the uncaught `Reflect.defineProperty` TypeError (bits 128/256, S10c); its S10a/S10b bits are the S10 pin |
| p3b / p3c | 127 / 135 | **127 / 135** | 55 / 267 | |
| p4 | 127 | 7253 | 7253 | S10c — **127 on the #6770 trial merge** |
| p16 | 123 | 20 | 20 | S11 (#6770 S8) |

Residual mechanisms (no row in this bucket):

- (a) `var s = arr.slice()` in a species-observable module with NO Proxy:
  TypeScript types the call `any[]`, the declaration materialises a copy of
  the species result, so `getPrototypeOf` / `instanceof` / `.constructor` see
  an Array. The S7 follow-up's externref-slot predicate covers only the
  `.call` spellings; the inline reads (p14 bits 32/64/128, the rows) are
  exact.
- (b) bits 2/8/32: a STATIC TypedArray carrier (`var ta = new
  Uint8Array(1)`) has no expando side-table, so `Object.defineProperty(ta,
  "length", …)` is not recorded (`gOPD` answers `undefined`,
  `.tmp/6771/q9.js`) and the static `ta.length` / concat reads see the native
  length — the gap #6651's TypedArray record already names. The rows'
  harness shape (a dyn view through a parameter) is S2c and passes.
- (c) bits 4/8: `[].map.call(<holes>, String)` writes the mapped value into
  the holes (map over holes, pre-existing).
- (d) bit 16: `[true, "x"].toLocaleString()` — a MIXED-element array takes
  the generic element arm, which does not consult the Boolean companion.
- (e) `Object.keys` on a closed struct after `delete obj[2]` traps
  `illegal cast` on both trees.
- `indexOf` / `lastIndexOf(undefined)` over a run of holes answers 0 in some
  module shapes on BOTH trees (`.tmp/6771/q3.js`–`q6.js`: e.g. the inline
  `new Array(3).indexOf(undefined)`, and `h.lastIndexOf(undefined)` in a
  module without an elision literal); route-dependent, not hole storage.

### Pins

`tests/issue-6771-array-residue.test.ts` (29 cases, one per probe
mechanism): **29/29 on the branch**; on `origin/main` @ `a895598841` sources
(`.tmp/6771/base-a8955`, the pin file copied in) **23 failed / 6 passed** —
the 23 "RED on base" cases fail, the 6 guards pass on both
(`.tmp/6771/pins-{branch,base}.log`). Bits whose mechanism is out of scope
(S10c, residuals (a)–(e), the hole-search shapes) are left out of the masks.

### Controls

Union of every pin set named in the plan, extracted from the standalone
baseline (`status:"pass"`, promoted 2026-09-30 18:49): **9,593 rows**, every
one baseline-pass — ES5 4,222 · ES2015 2,330 · unclassified (-3) 1,994 ·
later editions 1,047. Run on a snapshot of the head's sources
(`.tmp/6771/snap-f5`, `diff -r` identical to `src/`), 60-row chunks, each
under the shared lock, ES5 first (`.tmp/6771/ctlrun5.sh`; logs
`.tmp/6771/ctl5-out/`). Runner: `.tmp/6771/iso.mts` — the `--isolate`
semantics (one fresh node process per row, the tree's own `runTest262File`,
the same 120 s budget) with the NEXT row's process started while the current
row runs, which hides the ~4.5 s runner import per row. Parity on the 34
rows: identical verdicts and messages to `run-test262-paths.mts --isolate`
(`iso-rows.log` vs `rows-m5.log`).

CONTROL-RESULTS-PENDING

### Gates

`LOC_GATE_BASE=$(git rev-parse origin/main)` loc + func budgets, coercion
sites, oracle ratchet, dead exports, compiler boundaries (`--mode inventory
--base origin/main`), typecheck: all exit 0 (`.tmp/6771/gates5.log`).

### Acceptance

- ≥ 32 of 34 rows: **not met on this branch alone — 30.** The two rows the
  plan counted on beyond 30 depend on S10c: with #6770's branch merged,
  `no-value-order` passes (31); `coercion-order` additionally needs the
  lib.dom `var length` merge fixed (residual 2) — not an Array mechanism.
  `source-array-boundary` (#2727) and `property-traps-order-with-species`
  (#6770 S8) are the plan's allowed residuals.
- Probe answers: met except p2 (85; plan ≥ 125), p1d3 (243), p6 (47) —
  residuals (b)–(d) — and p3 / p4 / p16 (#6770 S4 / S8).
- Pins red on base: met (23 of 23 RED cases).
- Status stays `in-progress`: the remaining rows wait on #6770 S4 / S8 and a
  new lib.dom-merge issue, not on work in this lane.

## 2026-10-02 — import-cycle ratchet (#6797) follow-up (Opus)

Merged with `origin/main`, the branch failed two new `quality` gates:
`check-import-cycles` (largest SCC 697 → 706: the nine leaves this issue added
sat inside the codegen strongly-connected component) and `check-flat-dir-budget`
(`src/codegen/*.ts` 829 → 838). Both are fixed without touching either baseline.

**Why the leaves were in the cycle.** Each leaf is called by core modules
(array-holes, vec-overlay, type-coercion, index, …) and called core helpers
back (`buildThrowJsErrorInstrs`, `stringConstantExternrefInstrs`,
`holeSentinelInstrs`, …). Cutting the inbound side would need a registrar
outside the SCC, and tests import `codegen/index.ts` directly, bypassing
`compiler.ts`. So the cut is on the outbound side:

- **Free cuts:** `ensureLateImport` / `flushLateImportShifts` / `compileExpression`
  / `coerceType` now come from the existing `shared.ts` delegates;
  `nativeStringLiteralInstrs` from `native-string-literals.ts` and
  `protoIndexRecvGetMissInstrs` from `proto-index-read-bindings.ts` (both
  re-exported unchanged by the core modules, and both outside the SCC).
- **Moved below both:** `TO_STRING`, `reservePlaceholder`, `makeHelperFctx`,
  `reservedFunc` moved verbatim from `to-locale-string-element.ts` to
  `helpers/reserved-helper-funcs.ts`.
- **Late-bound:** the 16 remaining core helpers go through same-named wrappers
  in `helpers/core-delegates.ts`. That module imports only types, so it sits
  below both sides. `expressions.ts` registers the real functions once, at
  module scope, next to the `shared.ts` registrations. The wrappers forward
  their arguments unchanged. An unregistered call throws a named error and
  never falls back.
- **Flat-dir:** the seven Array leaves moved to `src/codegen/array/`,
  `bool-to-locale-string.ts` to `expressions/` (it also serves `bool.toString()`
  receiver calls, so it is not Array-only) and `proxy-trap-closure-return.ts`
  to `closures/`. These are pure moves: only import paths changed.
  `proxy-array-like.ts` predates this issue and stays flat, now out of the SCC.

Measured on the merged tree: import-cycles OK (largest SCC 697, 5 SCCs);
flat-dir 829/829. The 68 compiled modules (the 34 rows × sloppy/strict, with
the harness, `--target standalone`) are byte-identical between the pre-cut
and post-cut `src/` (`.tmp/bytecmp.mts`). The QuickJS eval adapter is also
byte-identical (sha256 `6fdabe43…`). Pins: 29/29.
Rows (`flock … run-test262-paths.mts .tmp/array/rows.txt --isolate
--standalone`, QuickJS provider rebuilt): **30 pass / 4 fail**, the same four
residuals as above. Gates (`LOC_GATE_BASE=origin/main` loc and func budgets,
coercion sites, oracle ratchet, dead exports, compiler-boundaries inventory,
claude-md paths, typecheck, import cycles, flat-dir): all exit 0.
