---
id: 6770
title: "ES2015 standalone built-ins/Object + built-ins/Reflect residue — 49 rows: closed-struct literals under reflective builtins, own-key order, @@toStringTag on builtin prototypes, Proxy [[OwnPropertyKeys]] surfaces, lazy trap lookup"
status: in-progress
assignee: ttraenkler/opus-6770
sprint: current
created: 2026-09-30
updated: 2026-10-02
priority: high
horizon: xl
feasibility: hard
reasoning_effort: high
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-architect
related: [6651, 6766, 6767, 5316, 5268, 5148, 5116, 4777, 4599, 3371, 4010, 1906]
loc-budget-allow:
  # 2026-09-30 (#6770 plan, Fable lane). Eight mechanisms across the object
  # runtime; wiring only in the existing files listed, every helper longer
  # than ~40 lines goes into a NEW leaf (registered in
  # scripts/compiler-boundaries.json). Growth per step is named in the plan.
  # 2026-09-30 (#6770 impl, Opus): the plan's list carried trailing `# …`
  # comments on each item, which `parseFrontmatterList` does not strip — so no
  # item matched and the list granted nothing. Rewritten one path per line;
  # the per-step attribution lives in the implementation record below.
  # S1: string-source arm call (enumeration), result-binding hub (variables),
  # string-index decline for an Object.assign result binding (property-access).
  - src/codegen/object-runtime-enumeration.ts
  - src/codegen/statements/variables.ts
  - src/codegen/property-access.ts
  # S2: one marker call + one consumer-guard carve-out in the #2992 S6 mopSet
  # arm (object-shape-widening), the shared `$Symbol`-carrier unbox for tuple
  # fields (type-coercion), the symbol-branded field box in the struct
  # `Object.entries` arm (object-ops).
  - src/codegen/declarations/object-shape-widening.ts
  - src/codegen/type-coercion.ts
  - src/codegen/object-ops.ts
  # S3: the RegExp `lastIndex` reflection hook (regexp-lastindex-carrier), the
  # intrinsic-live push in the function own-names arm (function-instance-props),
  # the new leaf object-own-key-order.ts.
  - src/codegen/regexp-lastindex-carrier.ts
  - src/codegen/function-instance-props.ts
  - src/codegen/object-model/object-own-key-order.ts
  # S4: the new leaf define-rejection-channel.ts, the empty-literal proto arg
  # (calls.ts compileProtoArg), the rejection-park hook in the descriptor
  # TypeError builder (runtime layer).
  - src/codegen/object-model/define-rejection-channel.ts
  - src/runtime/wasmgc/values/ordinary-object-descriptor-common.ts
  - src/codegen/object-model/object-literal-reflective-escape.ts
  - src/codegen/object-model/proxy-trap-read.ts
  - src/codegen/object-model/object-proto-to-locale-string.ts
  - scripts/compiler-boundaries.json
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/literals.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime.ts
  - src/codegen/carrier-bag-visibility.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/object-proto-name-in.ts
  - src/codegen/object-proto-has-own-property.ts
  - src/codegen/expressions/object-get-prototype-of.ts
  - src/codegen/object-proto-symbol-tag.ts
  - src/codegen/object-proto-tostring-carriers.ts
  - src/codegen/object-proto-tostring.ts
  - src/codegen/native-proto.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime-proxy-invariants.ts
  - src/codegen/object-integrity-proxy.ts
  - src/codegen/object-runtime-prototype.ts
  - src/stdlib/object-runtime.ts
  # S5 (2026-09-30, Opus): wiring only — the own-key-list receiver
  # materialization (array-methods), the `__proto__` accessor glue member
  # (array-object-proto), the overridden-member value read (builtin-value-read),
  # the primitive Invoke hook (call-receiver-method), the strict-wrapper `typeof
  # this` un-fold (typeof-delete), the Annex B setter-receiver scan
  # (object-get-prototype-of), the unseeded-companion consult
  # (native-proto-instance-method-read), the unseeded `__proto__` own arm
  # (native-proto-own-props), the glue member bodies (object-proto-proto-accessor),
  # the per-file memo (builtin-proto-member-override). Logic lives in the new
  # leaf object-proto-to-locale-string.ts.
  - src/codegen/array-methods.ts
  - src/codegen/array-object-proto.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/native-proto-instance-method-read.ts
  - src/codegen/native-proto-own-props.ts
  - src/codegen/object-proto-proto-accessor.ts
  - src/codegen/builtin-proto-member-override.ts
  # S7 (2026-09-30, Opus): the new leaf proxy-own-keys-surfaces.ts (the
  # full-key-list / filter / enumerable-keys / gOPDs / defineProperties /
  # isPrototypeOf natives), and the Proxy-target literal route (new-builtin-globals).
  - src/codegen/object-model/proxy-own-keys-surfaces.ts
  - src/codegen/expressions/new-builtin-globals.ts
  # S8 (2026-10-01, Opus): the new leaf proxy-trap-read.ts (per-operation
  # GetMethod natives, §7.3.20 CreateListFromArrayLike for the ownKeys result);
  # one import line each in the dispatch files that swap the slot read for it;
  # the proxy-binding escape carve-out for source-declared methods
  # (analysis/proxy-binding-escape.ts); the Proxy ⇒ vec own-keys demand bit
  # (array-holes.ts).
  - src/codegen/object-runtime-proxy-chain.ts
  - src/codegen/analysis/proxy-binding-escape.ts
  - src/codegen/array-holes.ts
  # 2026-10-02 (#6770, Opus): #6797's import-cycle and flat-dir gates. The seven
  # #6770 leaves moved to src/codegen/object-model/ and reach the core through
  # object-model/ports.ts (type-only imports; implementations installed once in
  # codegen/index.ts, the composition root) so none of them joins the core SCC;
  # leaf-shared native names live in object-model/native-names.ts and are
  # re-exported by carrier-bag-visibility.ts / string-exotic-own-props.ts.
  - src/codegen/index.ts
  - src/codegen/string-exotic-own-props.ts
  - src/codegen/object-model/ports.ts
  - src/codegen/object-model/native-names.ts
coercion-sites-allow:
  # 2026-09-30 (#6770 S7, Opus): one by-name lookup of the EXISTING ToBoolean
  # native (`__is_truthy`) for a proxy descriptor's `enumerable` field in the
  # EnumerableOwnProperties / ObjectDefineProperties key walks — a call to the
  # engine's own coercion, not a hand-rolled one.
  - src/codegen/object-model/proxy-own-keys-surfaces.ts
func-budget-allow:
  # 2026-09-30 (#6770 S1, Opus): +10 in the enumeration-helper builder (the
  # string-source arm call, built in the new leaf), +1 in compileElementAccess
  # (the string-index decline for an Object.assign result binding).
  - src/codegen/object-runtime-enumeration.ts::buildObjectEnumerationHelpers
  - src/codegen/property-access.ts::compileElementAccess
  # 2026-09-30 (#6770 S2, Opus): +2..+3 lines each — the inline-literal route
  # in the freeze/seal/preventExtensions arm, the shared symbol-carrier unbox,
  # the marker call + guard carve-out, the symbol-branded entries box.
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/type-coercion.ts::buildVecFromExternref
  - src/codegen/declarations/object-shape-widening.ts::collectGrowableObjectLiterals
  - "src/codegen/declarations/object-shape-widening.ts::scanStatements#2"
  - src/codegen/object-ops.ts::compileObjectKeysOrValues
  # 2026-09-30 (#6770 S3, Opus): the i64 order-index registration in the
  # ordered walk (ensureObjectRuntime +4), the non-`$Object` entries/values arm
  # calls + their two scratch locals each (buildObjectEnumerationHelpers), the
  # String-wrapper `length` placement call in the gOPN walk (+1).
  - src/codegen/object-runtime.ts::ensureObjectRuntime
  - src/codegen/object-runtime-descriptors.ts::buildObjectDescriptorHelpers
  # 2026-09-30 (#6770 S4, Opus): the Reflect.defineProperty boolean hook and
  # the non-Reflect-function decline (compileNamespaceStaticCall), the
  # Reflect-writer marker in the EMPTY-literal widening arm (+1 each).
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/declarations/object-shape-widening.ts::collectEmptyObjectWidening
  - src/codegen/declarations/object-shape-widening.ts::scanStatements
  # 2026-09-30 (#6770 S5, Opus): one hook call each — the own-key-list receiver
  # (compileArrayMethodCall, +5; the arm itself is in object-own-key-order.ts),
  # the unseeded `__proto__` own arm (registerNativeProtoHasOwn), the primitive
  # Invoke hook (compileReceiverMethodCall), the strict-wrapper `typeof this`
  # un-fold (compileTypeofExpression / compileTypeofComparison, +1 each).
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/native-proto-own-props.ts::registerNativeProtoHasOwn
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  # 2026-09-30 (#6770 S6, Opus): +3 in ensureProxyRuntime — the pre-trap
  # [[ProxyTarget]] local (declaration, `local.tee`, index constant); the read
  # helper itself is module-level (`proxyTargetRead`).
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
---

## Problem

`built-ins/Object/**` + `built-ins/Reflect/**` still carry **49 non-pass rows**
on standalone (2026-09-30 census; row list `.tmp/6770/rows.txt`, paths
relative to `test262/test/`). Measured on `origin/main` @ `2ef807a68e`,
`flock /tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts
.tmp/6770/rows.txt --isolate --standalone` → `.tmp/6770/rows-base.log`:
**0 pass, 46 fail, 3 compile_error**. No row needs `$262`/`createRealm` or
`eval` (checked by grep over the 49 files) — nothing here is realm-bound.

The 49 rows are **eight mechanisms**, not eight directories. Every mechanism
below was isolated with a standalone probe (`.tmp/6770/p*.js`, runner
`.tmp/6770/probe.mts`, node reference `.tmp/6770/node-ref.cjs`; results in
`.tmp/6770/probes-base*.log`, `probes-rows.log`). Probe values are bit masks;
"main"/"node" are the measured answers.

### Row → mechanism map

| step | mechanism | rows |
| --- | --- | --- |
| S1 | `Object.assign`: primitive SOURCES are not `ToObject`-ed (a string source traps with a null deref); a primitive TARGET's wrapper answers `valueOf()` as the wrapper | `assign/Target-String`, `assign/Target-Number`, `assign/Target-Boolean`, `assign/Override-notstringtarget` |
| S2 | a literal-bound object (`var o = {a: 1}`) is a CLOSED struct; every reflective builtin that receives it writes through the typed slot (string → f64 NaN), ignores the frozen bit, cannot delete, and re-boxes a symbol value | `assign/ObjectOverride-sameproperty`, `assign/target-is-frozen-data-property-set-throws`, `assign/target-is-non-extensible-existing-accessor-property`, `Reflect/set/set-value-on-data-descriptor`, `Reflect/deleteProperty/delete-properties`, `entries/symbols-omitted` |
| S3 | own-key ORDER: array-index bound is off by one (4294967295 is an index), String wrapper appends `length` after expandos, RegExp has no own `lastIndex`, a redefined closure intrinsic (`length`/`name`) moves to the bag's tail, closed-struct literals keep source order, `Object.entries/values` on a closure see nothing | `Reflect/ownKeys/order-after-define-property`, `Reflect/ownKeys/return-on-corresponding-order-large-index`, `getOwnPropertyDescriptors/order-after-define-property`, `keys/order-after-define-property-with-function`, `entries/order-after-define-property-with-function` |
| S4 | Reflect residue: `setPrototypeOf` on a non-extensible target answers `true`; `defineProperty` THROWS on a frozen target instead of `false`; `Reflect.hasOwnProperty(...)` is a compile refusal | `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible`, `Reflect/defineProperty/return-boolean`, `Reflect/enumerate/undefined` |
| S5 | `Object.prototype`: `__proto__` is not an OWN name for `hasOwnProperty`/`in`/`getOwnPropertyNames`; `Object.getPrototypeOf(<literal-bound var>)` folds to `%Object.prototype%` even after a reflective prototype write; `toLocaleString` on a primitive `this` does not `Invoke(O, "toString")` | `prototype/__proto__/prop-desc`, `prototype/__proto__/set-ordinary-obj`, `prototype/toLocaleString/primitive_this_value`, `prototype/toLocaleString/primitive_this_value_getter` |
| S6 | `Object.prototype.toString`: the METHOD spelling skips step 14 (`Get(O,@@toStringTag)`); the `.call` spelling consults the tag BEFORE the builtinTag steps (a trap that revokes the proxy then breaks IsArray); builtin-prototype tags are answered by BRAND, so `delete X.prototype[@@toStringTag]` is unobserved; generator functions classify as `Function`; a symbol-keyed write on a primitive-wrapper prototype is dropped | `prototype/toString/get-symbol-tag-err`, `…/proxy-revoked-during-get-call`, `…/symbol-tag-weakset-builtin`, `…/symbol-tag-weakmap-builtin`, `…/symbol-tag-promise-builtin`, `…/symbol-tag-non-str-builtin`, `…/symbol-tag-generators-builtin`, `…/symbol-tag-override-primitives` |
| S7 | Proxy `[[OwnPropertyKeys]]` SURFACES: `__getOwnPropertySymbols` has no `$Proxy` front-guard (no invariants at all); the `__proxy_inv_ownkeys` reconciliation walks the target's STRING keys only; the trap-absent forward returns strings only; `Object.keys(proxy)` skips the per-key `[[GetOwnProperty]]` enumerable filter; gOPDs walks string keys only and keeps `undefined` descriptors; `Object.defineProperties(o, <proxy>)` is a compile refusal; seal/freeze's key list misses a computed-symbol-key literal and accessor literals; `isPrototypeOf` reads `$proto` raw on a `$Proxy` argument | `getOwnPropertySymbols/proxy-invariant-{absent-not-configurable-string-key,duplicate-string-entry,not-extensible-absent-string-key,not-extensible-extra-string-key}`, `getOwnPropertyNames/proxy-invariant-{absent-not-configurable-symbol-key,not-extensible-absent-symbol-key}`, `keys/proxy-non-enumerable-prop-invariant-3`, `getOwnPropertyDescriptors/proxy-undefined-descriptor`, `getOwnPropertyDescriptors/proxy-no-ownkeys-returned-keys-order`, `defineProperties/proxy-no-ownkeys-returned-keys-order`, `seal/proxy-with-defineProperty-handler`, `freeze/proxy-with-defineProperty-handler`, `prototype/isPrototypeOf/arg-is-proxy` |
| S8 | trap lookup is an EAGER snapshot: `__proxy_create` performs 13 `[[Get]]`s on the handler at construction (`readTrapRaw`, `object-runtime-proxy.ts:1583`), so a handler that is itself a Proxy logs 13 trap names, accessor-defined traps run once, and a handler mutated later is invisible; an array-LIKE `ownKeys` result is an illegal cast | `keys/property-traps-order-with-proxied-array`, `entries/observable-operations`, `values/observable-operations`, `keys/proxy-keys` |
| — | **cross-reference only, owned by #3371** (`in-progress`, its row list names both): standalone `Reflect.construct` with a non-array-literal argumentsList / a distinct NewTarget | `Reflect/construct/arguments-list-is-not-array-like` (CE `#3371`), `Object/subclass-object-arg` (CE `#3371`) |

4 + 6 + 5 + 3 + 4 + 8 + 13 + 4 + 2 = 49.

### Measurements that pin each mechanism (main @ `2ef807a68e`, standalone)

| probe | main | node | what the gap proves |
| --- | --- | --- | --- |
| p1a/p1b | 7 / 7 | 7 / 15 | `Object.assign(true,{a:1}).valueOf() !== true` (p1b bit 8); the number/string wrappers pass the `===` form but NOT the row's argument form — see p13 |
| p13 (row-faithful `sameValue(a,b)` function) | 268245 | 522239 | bits 2/8/32/65536/131072 missing: `r.valueOf()` of all three assign-wrappers is not the primitive when it flows through a call argument |
| p1d / p1f / p1g | 1 / TRAP / TRAP | 7 / 7 / 15 | `Object.assign(12,"aaa",…)` copies no index keys; `Object.assign({}, "ab")` and `Object.assign({}, new String("cd"))` trap ("dereferencing a null pointer") |
| p2b | 29840 | 32511 | bits 1,2,4,8,32 missing: `{a:1}` literal + `o.a = "q"` / `Object.assign(o,{a:"z"})` reads NaN (typed f64 slot); bit 64: `Object.freeze({foo:1})` + assign does not throw; bit 512: `Reflect.set` on a frozen literal WRITES; bit 2048: `Object.preventExtensions({set foo(v){}})` inline + assign skips the setter. Every expando-built control (`{}` then `o.a = 1`) passes |
| p20 | 732 | 1023 | bits 1,2: with the row's twice-declared `var result`, 3-arg `Reflect.set({p:43},"p",42)` answers false and does not write; bits 32/256: `Object.getPrototypeOf(subject)` FOLDS for `var subject = {}` after `set.call(subject, proto)` and after `subject.__proto__ = proto`, while `proto.isPrototypeOf(subject)` (bit 64) and an untyped read (bit 512) are right |
| p8 | 507 | 1023 | bits 4/512: `Object.entries({key: sym})[0][1] !== sym` (identity lost on the closed-struct arm); `Object.values` keeps identity (bit 8) |
| p7b / p21 | 672618 / see plan | 1048575 | index bound: `o[4294967295]` sorts as an index; `new String("ab")`+`z` → `["0","1","z","length"]`; `/x/` → `["a"]` (no `lastIndex`); `keys(fn)` after `defineProperty(fn,"length",{enumerable:true})` → `["a","length"]`; `getOwnPropertyNames(fn)` → `["name","a","length"]`; literal `{b,2,a,1}` → source order; `Object.entries/values(fn)` → `[]` while `Object.keys(fn)` → `["a"]` |
| p6 | 101363647 | 983039 | bit 64: `Reflect.setPrototypeOf(nonExt, {})` → true (`null` → false is right); bits 1<<25, 1<<26: `Reflect.defineProperty` on a frozen object THROWS; bits 4096/16384: `Reflect.deleteProperty` leaves `hasOwnProperty` true |
| p6b | CE | 31 | `Reflect.hasOwnProperty("enumerate")` → "Reflect.hasOwnProperty not supported in standalone mode (#1472 Phase C)" (`call-namespace-static.ts:2639`) |
| p5d / p5e / p5f | 2 / 5 / 125 | 3 / 7 / 127 | `Object.prototype.hasOwnProperty("__proto__")`, `getOwnPropertyNames(Object.prototype)`, `"__proto__" in Object.prototype` all miss it; the descriptor itself (get/set/enumerable/configurable) is right |
| p4b / p4c | 0 / 518 | 1023 / 1023 | `Boolean.prototype.toString = f` IS stored (`gOPD(Boolean.prototype,"toString").value === f`, p4c bit 512) but `true.toString()`, `true.toLocaleString()`, `Object.prototype.toLocaleString.call(true)` all fold to the intrinsic |
| p3 (grouped) | 17173654 | 1048575 | bit 1: `poisoned.toString()` (method spelling) does not run the getter, `.call` does (bit 2); bits 32/64/256/65536/524288: `delete {WeakSet,WeakMap,Promise,Symbol,Map}.prototype[@@toStringTag]` unobserved; bit 512: `toString.call(function*(){})` → `[object Function]`; group 5 (1<<24) THREW in this strict module — in the runner's sloppy lane the write is silently dropped and the row fails on `[object Boolean]`; `Math`/`JSON` (namespace `$Object` singletons with a real tag property) already pass |
| p12 | 1292 | 681 | bits 256/1024: `toString.call(proxyRevokedInsideItsGetTrap)` throws "Cannot convert undefined or null to object" (tag consulted first, IsArray afterwards on the revoked proxy); bits 32/64: `Object.defineProperties({}, mk())` with a CALL-expression bag silently defines nothing |
| p9 | 5166 | 32767 | bits 1/16/8192/16384: `Object.getOwnPropertySymbols(proxy)` never throws an ownKeys invariant; bit 2 passes for a STRING key but the two `getOwnPropertyNames` rows need SYMBOL keys reconciled; bit 64: `Object.keys(proxy)` returns a non-enumerable key; bits 128/256: trap-absent forward drops symbol keys; bit 512: gOPDs keeps a key whose descriptor is `undefined`; bit 2048: `[].isPrototypeOf(proxyWithGpoTrap)` false while `Object.getPrototypeOf(proxy)` (bit 4096) is right |
| p10 | 5248 | 8191 | trap-call COUNT wrong for `{[sym]: 1}` (0 instead of 1) and `{get foo(){}, set foo(_v){}}` (0 instead of 1); right for `{a:1,b:2}` and an expando symbol key |
| p11a / p11c / p11b | 7 / 15 / TRAP | 15 / 31 / 31 | handler-is-a-Proxy: its `get` trap never fires per operation; accessor traps (`get ownKeys(){…}`) run once, not per operation; an array-like (getter-backed) `ownKeys` result → illegal cast |
| r1…r10 (verbatim rows, numeric shim `100 + first failing assertion`) | 101,THROW,102,102,101,101,101,105,101,101 | 0 | the rows fail exactly where the mechanism above predicts |

**Where the two `===`-form probes lied.** `p1a`, `p5b` and the single-`var`
`Reflect.set` probes PASS with `x === y` and FAIL in the rows: the checker's
static type lets the compiler fold the comparison (`void === undefined`,
`{p:number}.p`). Every acceptance probe below therefore routes values through a
`function sv(a, b)` shaped like `assert.sameValue`, or is the verbatim row.

## Implementation Plan (2026-09-30, Fable lane; Opus implements)

Order is S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8 → S9. S2 is the biggest
lever (it also unblocks the S6/S7 rows whose targets are literals); S8 is
LAST and gated on #6766 having merged (same file, see the risk note).

### S0 — base copies and the before-state

- `mkdir -p .tmp/6770 && git archive origin/main src | tar -x -C .tmp/6770/base-src`.
- The probes and runners are already in `/home/user/js2/.tmp/6770/` (copy them
  into the worktree's `.tmp/6770/`): `probe.mts` (standalone, prints
  `readResult()` — a NUMBER; a native-string return cannot be printed),
  `node-ref.cjs`, `p1a…p21.js`, `shim.txt` + `r1…r10.js`.
- Re-run `rows.txt` on the unmodified tree under the lock →
  `.tmp/6770/rows-base.log` (expect 46 fail + 3 CE), and every probe →
  `.tmp/6770/probes-base.log`. The numbers above are the base you must
  reproduce before editing.

### S1 — `Object.assign`: ToObject on every operand

Rows: `assign/Target-String`, `assign/Target-Number`, `assign/Target-Boolean`,
`assign/Override-notstringtarget`.

1. **Sources.** `__object_assign` (`object-runtime-enumeration.ts:1119-1400`)
   skips a non-`$Object` source ("if !$Object → skip this source", `:1273`);
   §20.1.2.1 step 4.a is `from = ToObject(nextSource)`. Before the skip, add
   a PRIMITIVE-STRING arm: when `srcExt` is a native string
   (`ref.test $NativeString` after `any.convert_extern`, or
   `__typeof_string`), push its String-exotic index keys and values —
   `stringExoticPushKeysPrologue` (`object-runtime-descriptors.ts` ~`:2570`)
   already derives `"0".."n-1"` from `[[StringData]]`; the value at index i is
   the one-char string (`__str_char_at` or the `$NativeString` slice the
   String `[i]` read uses — grep `STRING_EXOTIC_PUSH_KEYS_FN`). Write each
   with the same strict set the `$Object` arm uses (`assignStrictSetIdx`).
   A String WRAPPER source (`new String("cd")`, p1g) must take the same arm
   (unwrap via `WRAPPER_PRIMITIVE_KEY` / the wrapper's `[[StringData]]` read
   in `native-proto-instance-method-read.ts`). Number/boolean/symbol sources
   contribute nothing (keep the skip). First find the null deref: p1f/p1g
   trap BEFORE the skip — suspects are the #4749 Proxy-source arm prepended
   at `:1424-1460` and `classifiedClosedStructSourceCopy` (`:1169`) calling
   `__object_keys` on a string; measure with `.tmp/6770/p1f.js` under
   `--trace` / by bisecting the two arms (swap-in from `base-src`).
2. **Target wrapper `valueOf`.** `emitObjectCoercion` (the `Object(x)` arm,
   `call-builtin-static.ts:3960`) builds the wrapper; `Object(true).valueOf()`
   is right (p1c bit 8) while `Object.assign(true,{a:1}).valueOf()` is not
   (p1b bit 8, p13 bits 2/8/32). Diff the two lowerings: the assign result is
   typed by the checker as the SOURCE/target intersection (`{a:number}` /
   `string & {a:number}`), so `r.valueOf()` is resolved off the wrong
   prototype (a struct method or `String.prototype` fold on an externref).
   Fix at the fold: when `targetIsPrimitive`, record the result's runtime
   shape as the WRAPPER (`emitObjectCoercion`'s brand) — the simplest sound
   route is to compile `Object.assign(<primitive>, …)` as
   `Object.assign(Object(<primitive>), …)` (synthesize the `Object(x)` call
   expression and re-enter the fold) so the receiver type the method
   resolver sees is the wrapper's declared type. Verify with p13 bits
   1..32, 65536, 131072.
3. **`Override-notstringtarget`** additionally needs
   `Object.getOwnPropertyNames(<Number wrapper>)` to list the copied index
   keys — the wrapper's expando bag must be enumerated by
   `__getOwnPropertyNames`' non-`$Object` arm (`bagKeysTail`, S3.5 below);
   if the wrapper carrier has no bag, route the copied properties into the
   companion `$Object` the wrapper already uses for `r.a` (p13 bit 8192 shows
   `r.a === 1` reads back).

Acceptance: p1a=7, p1b=15, p1c=31, p1d=7, p1e=15, p1f=7, p1g=15; p13 bits
1,2,4,8,16,32,65536,131072 set.

### S2 — a literal-bound object that escapes into a reflective builtin is an OPEN `$Object`

Rows: `assign/ObjectOverride-sameproperty`,
`assign/target-is-frozen-data-property-set-throws`,
`assign/target-is-non-extensible-existing-accessor-property`,
`Reflect/set/set-value-on-data-descriptor`,
`Reflect/deleteProperty/delete-properties`, `entries/symbols-omitted`, plus
the literal half of `Reflect/ownKeys/return-on-corresponding-order-large-index`
(S3) and every S6/S7 row whose target is a data literal.

Mechanism (p2b, p20, p8): `compileObjectLiteral` lowers `{a: 1}` with a
concrete contextual type to a CLOSED struct (`compileProtoArg`'s comment,
`calls.ts:730-745`, records this exact defect for `Object.create`/
`setPrototypeOf` and its precedent fix — `compileObjectAssignArg`, #2076 —
builds an INLINE literal argument as a native `$Object`). A literal bound to
a `var` and passed later is not covered by that precedent, and the natives
(`__extern_set`, `__object_freeze`'s integrity bag, `__delete_property`,
`__object_entries`' closed-struct arm) each handle the struct partially.

Fix — one predicate, consulted at the open/closed decision:

- NEW leaf `src/codegen/object-literal-reflective-escape.ts`:
  `literalBindingEscapesToReflectiveBuiltin(ctx, decl: ts.VariableDeclaration): boolean`
  — true when the declared identifier (unique, `var`/`let`/`const`, initializer
  an `ObjectLiteralExpression` of data/shorthand/spread/accessor properties)
  appears anywhere in its scope as an ARGUMENT of: `Object.{assign,freeze,
  seal,preventExtensions,defineProperty,defineProperties,entries,values,
  getOwnPropertyDescriptors,setPrototypeOf}`, `Reflect.*`, `<x>.call(<id>, …)`
  / `<x>.apply(<id>, …)`, or `new Proxy(<id>, …)`, or as the receiver of a
  computed-key WRITE (`o[k] = v`) or of `delete o.<k>`. Reuse
  `ctx.oracle.variableDeclarationOf` and the `callArgIsOpaque` walker at
  `literals.ts:5384-5398` (it already answers "does this binding escape into
  an opaque call" for a narrower list — extend THAT list rather than adding a
  second walker if its shape fits; keep it in the leaf either way).
- `literals.ts`: at the point where a variable-initializer literal chooses the
  struct path (grep `compileObjectLiteralAsExternref` callers and the
  `isShapelessObjectType` gate — the same decision that already sends an
  `any`-annotated literal to the open builder, per the #2580 comment), consult
  the predicate and take the open `$Object` builder. Accessor literals
  (`{ set foo(v) {} }`) must build their accessor entry on the `$Object`
  (`accessor-object-literal.ts` already does this for the open path — verify
  with p2b bit 2048).
- Inline literal arguments of `Object.freeze/seal/preventExtensions` get the
  `compileObjectAssignArg` treatment (p2b bits 64, 2048): route those three
  static arms' first argument through `compileObjectAssignArg` (it declines
  non-literal shapes, so this is byte-inert elsewhere).

Do NOT widen `__extern_set`/`__delete_property` with closed-struct arms — the
struct cannot hold a string in an f64 field, so no runtime arm can make
`ObjectOverride-sameproperty` pass; representation is the only lever.

ES5 risk: HIGH — this changes the representation of ordinary literals in
ES5 rows that call `Object.freeze(o)`/`defineProperty(o,…)`/`o.hasOwnProperty`.
The predicate must stay NARROW (the listed call shapes only; a plain
`o.hasOwnProperty(k)` / `Object.keys(o)` / `Object.getOwnPropertyDescriptor`
read does NOT flip the representation — those already work on structs). Pin
list in S9.

Acceptance: p2b = 32511 (bit 256 excluded — strict module), p20 bits 1,2 set,
p8 = 1023, r1/r5/r7/r8 = 0.

### S3 — own-key ORDER (§10.1.11.1, §10.4.3.3, closure intrinsics)

Rows: `Reflect/ownKeys/order-after-define-property`,
`Reflect/ownKeys/return-on-corresponding-order-large-index`,
`getOwnPropertyDescriptors/order-after-define-property`,
`keys/order-after-define-property-with-function`,
`entries/order-after-define-property-with-function`.

1. **Array-index bound.** `__obj_index_of_key` (`object-runtime.ts:4416-4540`)
   has an exact overflow guard against 2^32 (#4434) but §6.1.7 array index is
   `< 2^32 − 1`: `"4294967295"` must answer −1 (p7b bit 16; the row's
   `o2[4294967295]` lands in string-insertion position). One added compare
   after the accumulate loop.
2. **Closed-struct order.** The literal half of the same row (`o1 = {…}`)
   is fixed by S2 IF the literal escapes (it does: `Reflect.ownKeys(o1)`), so
   nothing to do here — verify p7b bit 2048 flips after S2. If it does not,
   the `Reflect.ownKeys` lowering for a struct receiver lists fields in
   declaration order; sort index keys first there (call-builtin-static
   `ownKeys` struct arm).
3. **String wrapper `length`.** `__getOwnPropertyNames`'
   String-exotic arm (`object-runtime-descriptors.ts:2570-2600`) pushes the
   index keys, walks the table, then appends `"length"` — `length` is created
   by StringCreate BEFORE any expando, so it must be pushed right after the
   index keys and before the table walk (p21: `["0","1","z","length"]` →
   `[…,"length","z"]`; `new String("")+a,b` → `["length","a","b"]`). Move
   the `length` push into `stringExoticPushKeysPrologue`'s wrapper branch
   (keep the primitive-receiver early push as is).
4. **RegExp `lastIndex`.** A RegExp carrier has NO own `lastIndex` on the
   reflective surface (p21 B: `["a"]`; p7b bits 1024/2048/4096: `gOPD(re,
   "lastIndex")` is `undefined`). Add the arm to `__getOwnPropertyNames`'
   non-`$Object` branch (before the carrier bag keys: `lastIndex` is created
   at RegExpAlloc) and to `__getOwnPropertyDescriptor` (`{value: <the
   carrier's lastIndex slot>, writable: true, enumerable: false,
   configurable: false}` — the slot lives in `regexp-lastindex-carrier.ts`).
   `Object.defineProperty(re, "lastIndex", {value: 2})` must then write that
   slot (it already exists for the `re.lastIndex = n` spelling).
5. **Closure intrinsics first.** `bagKeysTail` / `buildBagPushKeys`
   (`carrier-bag-visibility.ts`; callers `object-runtime-enumeration.ts:97,
   :325`) enumerate a closure's bag in insertion order, and a redefined
   `length`/`name` is a bag entry appended AFTER `a` (p21 C/D). §10.2.4 /
   §10.2.9 create `length` then `name` at function creation, so: push
   `"length"` and `"name"` first (when enumerable-or-`includeNonEnum` — read
   their bag override if present, else the synthesized non-enumerable
   intrinsic), then the bag keys EXCLUDING those two.
6. **`Object.entries/values` on a closure.** `__object_entries` /
   `__object_values` (`:783`, `:872`) return `[]` for a non-`$Object`
   receiver; `__object_keys` (`:325`) already has the `bagKeysTail` arm. Add
   the same arm (keys via `bagKeysTail`, values via `__extern_get`) to both.
   Also covers `Object.entries(new String(…))`? — not a row; skip.

Acceptance: p7 = 32767, p7b = 1048575, p21 = 201029114210 (first form) /
`D=3020 E=4920 F=3010`.

### S4 — Reflect residue

Rows: `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible`,
`Reflect/defineProperty/return-boolean`, `Reflect/enumerate/undefined`.

1. `Reflect.setPrototypeOf` (`call-namespace-static.ts:1829-1990`) consults
   `__object_setPrototypeOf_status` only on one branch (p6: `null` proto →
   false is right, `{}` proto → true is wrong). The `{}` operand goes through
   `compileProtoArg` (a fresh `$Object`) and the arm returns the WRITER's
   truthiness; make the arm always `status → if 0 return 0 else write, return 1`
   (the status native already answers 0 for a non-extensible receiver,
   `object-runtime-prototype.ts:870-910`).
2. `Reflect.defineProperty` delegates to `emitDefinePropertyDescRuntime`
   (`:1769`) — the THROWING `Object.defineProperty` runtime — then
   `__is_truthy`. §28.1.6 returns the boolean of `[[DefineOwnProperty]]`.
   Mirror the #5148 predicate idiom (`__object_setPrototypeOf_status`): add
   `__defineProperty_status(obj, key, desc) -> i32` that runs
   ValidateAndApplyPropertyDescriptor's REJECTION tests (frozen/sealed bits,
   non-configurable + incompatible change, non-extensible + new key) without
   writing, and have the Reflect arm call status first and only then the
   writer. `try`/`catch` around the writer is the fallback (the `Instr` union
   has `try` — `calls.ts` uses it) but the predicate keeps ES5's
   `Object.defineProperty` throw path byte-identical.
3. `Reflect.<non-method>` (`:2639` refusal): before the refusal, when
   `reflectMethod` is not one of the 13 Reflect functions, lower the call as
   an ordinary METHOD CALL on the Reflect namespace `$Object`
   (`emitBuiltinNamespaceObject(ctx, "Reflect")`, admitted at
   `builtin-static-globals.ts:43`) — `Reflect.hasOwnProperty("enumerate")`
   then resolves through `%Object.prototype%`. The VALUE read
   `Reflect.enumerate` must answer `undefined` (same singleton; verify p6b
   bit 1).

Acceptance: p6 = 983039, p6b = 31, r2 = 0, r6 = 0.

### S5 — `Object.prototype` members: `__proto__` own-ness, the literal `getPrototypeOf` fold, `toLocaleString`

Rows: `prototype/__proto__/prop-desc`, `prototype/__proto__/set-ordinary-obj`,
`prototype/toLocaleString/primitive_this_value`,
`prototype/toLocaleString/primitive_this_value_getter`.

1. **`__proto__` is own.** `OBJECT_PROTOTYPE_OWN_NAMES`
   (`object-proto-name-in.ts:68`) deliberately excludes it "because an `in`
   answer must not claim a member the read side cannot serve" — the read side
   now exists (#5268 step 1, `object-proto-proto-accessor.ts`). Add
   `"__proto__"` to the set, and to `__hasOwnProperty`'s `Object.prototype`
   arm (`object-proto-has-own-property.ts`) and to the
   `Object.getOwnPropertyNames(Object.prototype)` answer (find the arm that
   lists the six methods + `constructor`; grep `"propertyIsEnumerable"` in
   `object-runtime-descriptors.ts`). `verifyProperty` then also needs:
   `propertyIsEnumerable("__proto__")` false (p5f bit 1 — passes today) and
   `delete Object.prototype.__proto__` to succeed and make `hasOwnProperty`
   false afterwards (configurable: true) — verify with `prop-desc.js`
   verbatim; if the delete does not tombstone the accessor, route
   `__delete_property`'s `Object.prototype` receiver through the same arm the
   Annex-B accessors use (`object-proto-annex-b-accessors.ts`).
2. **The fold.** `object-get-prototype-of.ts:534` folds
   `Object.getPrototypeOf(<id>)` to `%Object.prototype%` when the binding's
   initializer is a plain object literal. It already declines when the binding
   is passed to `Object.setPrototypeOf` (p20 bit 128) — find that escape check
   and extend it with: the identifier as the FIRST argument of any
   `<x>.call(…)`/`<x>.apply(…)`, as any argument of `Reflect.setPrototypeOf`,
   and as the receiver of a `__proto__` member write (p20 bits 32, 256). The
   S2 predicate leaf is the natural home (export a second predicate
   `bindingMayHaveItsPrototypeRewritten`).
3. **`toLocaleString`.** §20.1.3.5 is `Invoke(O, "toString")` where `O` is the
   `this` value; for a primitive receiver, GetV walks the wrapper prototype —
   i.e. the `$NativeProto` companion of `Boolean.prototype`, where the user's
   `toString` override IS stored (p4c bit 512) but never read (bits 8-256).
   NEW leaf `src/codegen/object-proto-to-locale-string.ts`: for a boolean /
   number / string / symbol receiver (static type or runtime `__typeof_*`),
   `__extern_get(<wrapper prototype singleton>, "toString")` → if it is a
   callable that is NOT the intrinsic (compare against the builtin closure
   the seeder installed, or just call whatever the companion answers — the
   intrinsic is what the seeder stored), call it with `this` = the primitive
   (the `__call_fn_method_N(thisVal, closure, …)` bridge; a strict user
   function must see the primitive, which the bridge already preserves for
   `Boolean.prototype.toString.call(true)`, p4b bit 8 measured 0 → verify
   the bridge does not box). Wire it at the `toLocaleString` arms: the
   number arm `call-receiver-method.ts:2923` (currently `number_toString`
   directly), the boolean/string spellings, and
   `Object.prototype.toLocaleString.call(x)` (`builtin-prototype-brand.ts:538`
   table). Both rows are `onlyStrict`.

Acceptance: p5a = 1023, p5d = 3, p5e = 7, p5f = 127, p20 bits 32/256, r3 = 0;
p4b = 1023, p4c = 1023, p4 = 47.

### S6 — `Object.prototype.toString` tags (§20.1.3.6 steps 3-15)

Rows: `prototype/toString/get-symbol-tag-err`, `…/proxy-revoked-during-get-call`,
`…/symbol-tag-weakset-builtin`, `…/symbol-tag-weakmap-builtin`,
`…/symbol-tag-promise-builtin`, `…/symbol-tag-non-str-builtin`,
`…/symbol-tag-generators-builtin`, `…/symbol-tag-override-primitives`.

1. **Method spelling consults the tag** (`get-symbol-tag-err`): `obj.toString()`
   on a plain `$Object` reaches `__object_proto_to_string_runtime`
   (`object-proto-tostring.ts:675`), which calls
   `emitObjectProtoToStringSymbolTagConsult` first — yet p3 bit 1 shows the
   getter does not run for `poisoned.toString()`. Measure which path the
   method spelling takes for a `defineProperty({}, @@toStringTag, {get})`
   receiver (likely the #2501 static fold on the identifier's literal type,
   `calls.ts:1351`/`:1290`); route a receiver whose static shape is a plain
   object literal through `emitObjectProtoToStringWithSymbolTag` exactly as
   the `.call` fold does (`calls.ts:9176-9200`).
2. **builtinTag before the tag** (`proxy-revoked-during-get-call`):
   `emitObjectProtoToStringWithSymbolTag` (`object-proto-symbol-tag.ts:160-200`)
   calls `__opts_symbol_tag` FIRST and banks the classifier SECOND; the get
   trap revokes the proxy, then IsArray on the revoked proxy throws. Swap the
   order: bank `builtinLocal` (classifier-or-constant) first, then consult the
   tag, then select. The runtime helper (`object-proto-tostring.ts:698`,
   `:742`, "(#6674) step 15 first") keeps tag-first because its classifier
   tail is a REFUSAL — leave it, the row uses `.call`. Note §20.1.3.6 step 3
   for a revoked proxy throws in IsArray; here the proxy is live at step 3.
3. **Builtin-prototype tag deletion** (`weakset`, `weakmap`, `promise`,
   `non-str-builtin`; `Map`/`Set` are #5116/#4777, in progress — do not
   duplicate, cross-reference): the classifier answers `WeakSet` by BRAND.
   Spec-wise `WeakSet` is not a builtinTag (steps 5-13 list only Array,
   Function, Error, Boolean, Number, String, Date, RegExp, Arguments) — the
   `[object WeakSet]` answer must come from step 14/15 finding the seeded
   `@@toStringTag` on `WeakSet.prototype`. So: (a) give the WeakMap / WeakSet /
   Promise / Symbol prototype glues a `symbolTag` (`native-proto.ts:165`,
   seeded at `:788-805` via `__defineProperty_value` on the companion —
   #5116's mechanism); (b) confirm `delete X.prototype[@@toStringTag]`
   tombstones the companion entry and `__opts_symbol_tag`'s `__extern_get`
   walk reaches the companion from an INSTANCE receiver (probe first: p3 bits
   16, 32); (c) only then demote the classifier's brand answers for those
   brands to `Object` (`emitObjectProtoToStringClassifier`, the brand ladder
   in `object-proto-tostring.ts:528-620` / `BUILTIN_BRAND_TABLE`), so the
   deleted tag yields `[object Object]`. `Math`/`JSON` already work this way
   (p3 bits 131072/262144). Symbol: `toString.call(Symbol("d"))` must
   `ToObject` to a Symbol wrapper whose prototype is `Symbol.prototype`.
4. **Generators** (`symbol-tag-generators-builtin`): `toString.call(function*
   (){})` → `[object Function]`; needs `%GeneratorFunction.prototype%`'s
   `@@toStringTag = "GeneratorFunction"` and `%GeneratorPrototype%`'s
   `"Generator"` reachable by the same walk (#6651 cluster A reified
   `%GeneratorFunction%`), then `Object.defineProperty(genProto,
   @@toStringTag, {get})` + `delete` on that prototype object. Measure after
   3; record with the exact failing assertion if the generator prototype is
   not a mutable companion.
5. **Symbol-keyed writes on primitive-wrapper prototypes**
   (`symbol-tag-override-primitives`): `Boolean.prototype[@@toStringTag] =
   'test262'` is DROPPED (sloppy) / throws "Cannot convert object to
   primitive value" (strict) — the element-assignment on a `$NativeProto`
   receiver stringifies the key. The companion is a mutable `$Object` that
   already stores a symbol key (the seeded tag), so: in the element-write
   lowering for a `$NativeProto` receiver, when the key is a `$Symbol`,
   `__extern_set(companion, key, value)`; then `toString.call(true)` must
   `ToObject` and read the tag through `Boolean.prototype`. `Object.defineProperty(Symbol.prototype, @@toStringTag, {value})` is the
   same companion write through the define path. Measure-first; if the
   wrapper `ToObject` for the tag lookup is missing, record this row.

Acceptance: p3 = 1048575 minus bit 524288 (Map, #5116's), p12 bits 128/512.

### S7 — Proxy `[[OwnPropertyKeys]]` surfaces (§10.5.11, §20.1.2.9/.10/.17, §7.3.16, §20.1.3.3)

Rows: the 4 `getOwnPropertySymbols/proxy-invariant-*`, the 2
`getOwnPropertyNames/proxy-invariant-*-symbol-key`,
`keys/proxy-non-enumerable-prop-invariant-3`,
`getOwnPropertyDescriptors/proxy-undefined-descriptor`,
`getOwnPropertyDescriptors/proxy-no-ownkeys-returned-keys-order`,
`defineProperties/proxy-no-ownkeys-returned-keys-order`,
`seal/proxy-with-defineProperty-handler`, `freeze/proxy-with-defineProperty-handler`,
`prototype/isPrototypeOf/arg-is-proxy`.

1. **One key list.** `buildOwnKeysDispatch("__getOwnPropertyNames")`
   (`object-runtime-proxy.ts:1295-1320`, forward arm `:1024-1030`) forwards
   trap-absent to `__getOwnPropertyNames(target)` — strings only — while a
   PRESENT trap returns the raw list (strings + symbols). Make the trap-absent
   forward `__getOwnPropertyNames(target) ++ __getOwnPropertySymbols(target)`
   (the integrity-proxy module already does this append at
   `object-integrity-proxy.ts:170-260`; lift that composition into the
   dispatch and delete the duplicate there). Then the CONSUMERS filter:
   `Object.getOwnPropertyNames` → strings only, `Object.getOwnPropertySymbols`
   → symbols only, `Reflect.ownKeys` → all (`call-builtin-static.ts:3686`,
   `:3716`; `call-namespace-static.ts:1488`). Verify with p9 bits 128/256.
2. **`__getOwnPropertySymbols` front-guard.** Add the `ref.test $Proxy` guard
   (the `fillProxyDispatch` idiom at `:2589-2625`) routing to the names
   dispatch + symbol filter — this alone brings the four
   `getOwnPropertySymbols/proxy-invariant-*` rows through the existing
   validator (`__proxy_inv_ownkeys`).
3. **Reconcile symbol keys.** `__proxy_inv_ownkeys`
   (`object-runtime-proxy-invariants.ts:634`) walks `__getOwnPropertyNames(target)`
   and records "own SYMBOL keys … are not reconciled — a residual". Walk
   names ++ symbols (same append). Fixes the two `getOwnPropertyNames/
   proxy-invariant-*-symbol-key` rows.
4. **`Object.keys(proxy)` enumerable filter.** `buildOwnKeysDispatch("__object_keys")`'s
   trap arm returns the validated trap list unfiltered (p9 bit 64).
   §20.1.2.17 EnumerableOwnProperties: for each STRING key,
   `desc = O.[[GetOwnProperty]](key)` (→ `__proxy_gopd_dispatch`, which fires
   the gopd trap — `proxy-keys.js` expects exactly that trap sequence) and
   keep the key only if `desc !== undefined && desc.enumerable`. Add the loop
   after the validator call in that dispatch only (not in the names one).
5. **gOPDs.** `__object_getOwnPropertyDescriptors` is SELF-HOSTED from
   `src/stdlib/object-runtime.ts` (`object-runtime-descriptors.ts:2858-2880`):
   change the TS source to iterate `__getOwnPropertyNames(obj)` then
   `__getOwnPropertySymbols(obj)` (§20.1.2.10 uses the full
   `[[OwnPropertyKeys]]`), and `if (desc !== undefined) out[key] = desc`. For
   a proxy receiver the per-key `__getOwnPropertyDescriptor` already routes to
   the gopd trap (its front-guard), which is the `["0","foo",sym]` order the
   row asserts once step 1 lands.
6. **`Object.defineProperties(o, <proxy>)`.** The props-bag chain
   (`object-runtime-descriptors.ts:740-790`: vec → closure → refusal
   `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]`) needs a `$Proxy` arm BEFORE the
   refusal: keys = names dispatch (all keys, step 1), per key `desc =
   __proxy_gopd_dispatch(bag, key)`; skip `undefined`; if enumerable,
   `descObj = __proxy_get_dispatch(bag, key)` → `ToPropertyDescriptor` →
   define. The row's trap returns `undefined` for every key, so the arm's
   observable surface is the gopd-call ORDER only. Also make the compile-time
   gate at the call site (`object-ops.ts:3668`) stop refusing a non-literal
   bag whose runtime value may be a proxy (p12 bit 4: it currently throws at
   runtime for the proxy AND silently no-ops for a call-expression bag —
   bit 32/64; fix the latter by routing every non-literal bag to the
   runtime native).
7. **seal/freeze key list.** `object-integrity-proxy.ts` (#5268 step 2)
   already asserts the exact descriptor shapes; p10 shows the trap fires
   ZERO times for a `{[sym]: 1}` literal target and for an accessor literal
   target, and correctly for `{a:1,b:2}` / an expando symbol key. With S2
   (the literal is a Proxy target → open `$Object`) and step 1 (symbols in
   the key list), re-measure p10; if the accessor literal still yields 0,
   the accessor entry is not visible to `__getOwnPropertyNames(target)` —
   fix in the `$Object` accessor-entry enumeration, not here.
8. **`isPrototypeOf` first hop.** `__isPrototypeOf`
   (`object-runtime-prototype.ts:977`) walks `candidate.$proto` raw; for a
   `$Proxy` candidate the first hop must be `candidate.[[GetPrototypeOf]]()`
   → `__getPrototypeOf(candidate)` (proxy front-guard → gpo trap, p9 bit
   4096 proves the trap path works). Replace only the FIRST read; later hops
   through a proxy prototype are #6766's arms (`fillProtoLinkArms` splices
   into this same native — merge `origin/main` before touching it and keep
   the splice points intact). The row's handler is `allowProxyTraps`, whose
   every other trap THROWS — so the walk must not touch `has`/`get`.

Acceptance: p9 = 32767, p10 = 8191, p12 bits 1, 8, 32, r9 = 0, r10 = 0.

### S8 — lazy trap lookup (GetMethod per operation) + array-like `ownKeys` result — LAST, after #6766 merges

Rows: `keys/property-traps-order-with-proxied-array`,
`entries/observable-operations`, `values/observable-operations`,
`keys/proxy-keys`.

Mechanism: `__proxy_create` (`object-runtime-proxy.ts:1546-1640`) performs
`readTrapRaw(name)` = `__extern_get(handler, name)` for all 13 traps and
stores them in `$ProxyTraps`; every dispatch reads its slot
(`struct.get F_PTRAPS; struct.get <TRAP_x>`, 13 sites: `:405-415`, `:713-723`,
`:827-837`, `:1042-1052`, `:1132-1142`, `:1376-1386`, `:1497-1507`, plus
`object-integrity-proxy.ts` `TRAP_GOPD/OWNKEYS/DEFINE` reads and any in
`object-runtime-proxy-chain.ts`). §10.5.x step "Let trap be ? GetMethod(handler,
"<name>")" runs on EVERY operation.

- NEW leaf `src/codegen/proxy-trap-read.ts`: native
  `__proxy_trap_read(proxy externref, name externref) -> externref`: read
  `$Proxy.$phandler` (F_PHANDLER = 2); `__extern_get(handler, name)` (a
  `$Proxy` handler takes its own get trap through the front-guard — that is
  the row's expected log); `__nullish_to_null`; a non-null non-callable →
  TypeError "proxy trap is not a function" (GetMethod step 3;
  `__typeof_function`). Export a `trapReadInstrs(ctx, proxyLocal, name)`
  factory (FRESH `Instr[]` per call — the #5140/#5316 double-remap hazard) that
  emits `local.get P; <string const>; call __proxy_trap_read`.
- Replace the 4-instruction slot read at each of the 13 sites with the
  factory's 3 instructions inside the existing `if ptraps==null … else …`
  (keep the shape; `__proxy_create` keeps allocating an empty `$ProxyTraps`
  so the else-arm still runs, and F_CALLABLE/F_CONSTRUCTIBLE stay
  ProxyCreate-time as §10.5.14 requires). Delete the 13 `readTrap(name)`
  calls in `__proxy_create` (the observable `[[Get]]`s the row logs).
- Array-LIKE trap result (`proxy-keys.js`, p11b illegal cast): in the ownKeys
  dispatch's CreateListFromArrayLike (§7.3.20) — when the trap result is not a
  `$ObjVec`, use `__extern_length` (`ToLength(Get(obj,"length"))`, which runs
  the row's `length` getter first) then `__extern_get_idx` per index (getters
  `0,1,2` in order) into a fresh `$ObjVec`, with the per-element string/symbol
  check (TypeError otherwise). Keep the fast path for a real `$ObjVec`.
- The two `observable-operations` rows additionally need `Object.entries/values`
  over a proxy: `ownKeys` → per key `gopd` (enumerable filter, S7.4) → `get`
  with receiver = the proxy (the row asserts `receiver === proxy`); route
  `__object_entries`/`__object_values`' `$Proxy` receiver through the keys
  dispatch + `__proxy_get_dispatch` (add the front-guard the same way
  `__object_keys` has it).

Risk / ordering: #6766 (in progress) is actively editing
`object-runtime-proxy.ts` and `object-runtime-proxy-chain.ts`. Do S8 only
after it lands (`git log origin/main --grep="#6766"`), merge `origin/main`
first, and re-measure p11a/p11b/p11c before editing. The 13 replacements are
mechanical; do them in ONE commit with p11a=15, p11b=31, p11c=31 as the pin.

### S9 — pins, controls, gates, record

- Pin suite `tests/issue-6770-object-reflect-residue.test.ts`: one `it` per
  probe listed in the acceptance lines (p1a…p21, p13, p20, r1…r10), each
  asserting the node value and marked "RED on base"; plus three guards that
  answer the same on both trees: `Object.keys({a:1,b:2})` order, `Object.freeze(o); Object.isFrozen(o)` on a plain literal, and
  `Object.prototype.toString.call([])`. Write the base verdict into the record
  (swap `.tmp/6770/base-src/` in, run, swap back).
- **ES5 control — ZERO pass→non-pass, no tolerance (completed edition).**
  S2/S3/S5/S6 touch code every ES5 object row exercises. Population: every
  ES5-classified row (`scripts/generate-editions.ts::classifyEdition`, the
  #6767 `control.mts` builder) that is `pass` in the current standalone
  baseline (`.test262-cache/test262-standalone-current.jsonl`) under
  `built-ins/Object/**`, `built-ins/Function/**` (S3.5 `length`/`name`),
  `built-ins/String/**` `S15.5.5*` + `built-ins/String/prototype/**` own-key
  rows, `built-ins/RegExp/**` `S15.10.7*` (`lastIndex`, S3.4),
  `built-ins/Boolean/**` + `built-ins/Number/prototype/toLocaleString/**`
  (S5.3), `language/expressions/object/**` and `language/statements/for-in/**`
  (S2 representation, S3 order). Run once on the merged tree under the lock
  (`--isolate`, chunked; ~1,500 rows ≈ 75 min). Named ES5 pins that must
  stay green, run after EVERY step: `built-ins/Object/getOwnPropertyNames/
  15.2.3.4-4-1.js` (Object.prototype's own names — S5.1 adds `__proto__`),
  `built-ins/Object/prototype/toString/15.2.4.2-1-1.js`…`-2-1.js` and
  `S15.2.4.2_A*` (S6 order swap), `built-ins/Object/freeze/15.2.3.9-2-*.js`
  and `built-ins/Object/defineProperty/15.2.3.6-4-*.js` (S2 representation),
  `built-ins/Object/keys/15.2.3.14-*.js` (S3), `built-ins/RegExp/S15.10.7.5_A*.js`
  (S3.4), `built-ins/Function/15.3.5.1*.js` / `built-ins/Function/instances/**`
  (S3.5), `built-ins/Object/prototype/toLocaleString/S15.2.4.3_A*.js` (S5.3).
- **ES2015 control** (0 pass→non-pass, per-path set diff): currently-passing
  standalone rows under `built-ins/Proxy/**`, `built-ins/Reflect/**`,
  `built-ins/Object/**` (the #6766 control list, ~900 rows), plus
  `built-ins/Symbol/**` and `built-ins/Promise/**` for S6.3.
- Gates, run bare and chained, with `LOC_GATE_BASE=$(git rev-parse origin/main)`:
  `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet && npm run -s check:dead-exports && node scripts/check-compiler-boundaries.mjs --mode inventory --base origin/main && npm run -s typecheck`.
  Growth grants live in THIS file's frontmatter only. New type-info queries go
  through `ctx.oracle` (`src/checker/oracle.ts`), never the raw checker.
- Record: append `### 2026-09-30 — #6770 implementation (Opus)` to THIS file
  (per-row before/after table, per-probe before/after, residuals with
  mechanisms, pins' base verdict, both control diffs, gate output), plus a
  one-paragraph pointer under a new heading in
  `plan/issues/6651-es2015-standalone-100pct-execution-plan.md`.

## Acceptance criteria

- S1–S7 rows (43) pass on standalone, `--isolate`, on the branch with
  `origin/main` merged in; S8 rows (4) pass or are recorded with the exact
  failing assertion and the #6766 merge state; the 2 #3371 rows are untouched.
- Every probe answers its node value (table above; p4 = 47, p6 = 983039, p2b
  = 32511, p3 minus the Map bit); the pin file is red on `base-src`.
- 0 pass→non-pass across the ES5 control (no tolerance) and the ES2015
  control.
- All gates green; no `checker.*` outside the oracle; new leaves registered
  in `scripts/compiler-boundaries.json`.

## Overlap and cross-references

- **#3371** (`in-progress`) owns `Reflect/construct/arguments-list-is-not-array-like`
  and `Object/subclass-object-arg` (both listed in its file, `:199`, `:1790`).
  Not planned here.
- **#6766** (`in-progress`, Proxy as `[[Prototype]]`) edits
  `object-runtime-proxy.ts`, `object-runtime-proxy-chain.ts` and splices arms
  into `__isPrototypeOf`. S7.8 and all of S8 wait for it; S7.1-S7.4 touch
  the ownKeys dispatch only (its `protoLinkReceiverSetForward` import is
  already on main) — merge `origin/main` before each S7 commit.
- **#5116 / #4777** (`in-progress`) own `Map`/`Set` prototype `@@toStringTag`
  via the same `symbolTag` glue S6.3 extends to WeakMap/WeakSet/Promise/
  Symbol; do not re-plan the Map/Set half, and coordinate the classifier
  demotion (S6.3c) with them — it affects their rows.
- **#4599** (`ready`) is `toString.call(Math)` → `[object Math]`; S6 does not
  touch the `Math` arm (p3 bit 131072 already passes).
- **#6767** (class reflective residue) recorded the `getPrototypeOf` literal
  fold (`call-builtin-static.ts` "Object.prototype not modeled"); S5.2 is the
  `{}`-binding twin of that finding in `object-get-prototype-of.ts`.
- **#5268 step 2** (`object-integrity-proxy.ts`) claims
  `freeze/proxy-with-defineProperty-handler.js` — it is non-pass on main
  because its target is a computed-symbol-key + accessor LITERAL (p10),
  which S2/S7.7 address; the descriptor-shape builder there is right.
- Realm-bound rows: none in this bucket.

## Lane protocol

- Worktree under `/home/user/js2/.claude/worktrees/issue-6770` (branch
  `issue-6770-object-reflect-residue` from `origin/main`); `ln -s
  /home/user/js2/node_modules` and `ln -s /home/user/js2/test262` into it.
  Never edit `/home/user/js2` itself.
- Every `run-test262-paths.mts` invocation goes through
  `flock /tmp/claude-0/t262.lock …` (4-core box, other lanes running). No
  row here needs the QuickJS eval provider.
- New `src/` files: add to `scripts/compiler-boundaries.json` (textual insert,
  entry shape `{ "path", "state": "unmigrated", "layer": "mixed-needs-split",
  "destination": "backend-wasmgc", "owner": "3518-coordinator", "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime." }`).
- Commit early and push the branch immediately
  (`NODE_OPTIONS=--max-old-space-size=4096 git push -u origin <branch>`; the
  pre-push hook is slow — redirect to a log and confirm with
  `git ls-remote origin <branch>`). Do NOT open a PR; the lead does.
- Commit subject ends with ` ✓`; author `Thomas Tränkler
  <git@thomas.traenkler.com>`, committer `Claude <noreply@anthropic.com>`;
  trailers `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  `Claude-Session: https://claude.ai/code/session_01FEGi3DmyPRPD5dx4kWU8hs`,
  `Model: Claude Opus 5.5 High`. Never `--no-verify`; no `git stash` (shared
  stack) — use file copies (`.tmp/6770/base-src`) for every A/B.

## Implementation record (2026-09-30 → 2026-10-02, Opus)

### Rows

Bucket = the 49 rows in `.tmp/6770/rows.txt`, run with `flock
/tmp/claude-0/t262.lock npx tsx scripts/run-test262-paths.mts .tmp/6770/rows.txt
--isolate --standalone`.

| tree | pass | fail | CE | log |
| --- | --- | --- | --- | --- |
| base `origin/main` @ `2ef807a68e` | 0 | 46 | 3 | `.tmp/6770/rows-base.log` |
| branch @ `d28a7cc156` (S1–S8 + `origin/main` @ `e473d92460` merged in) | **44** | 3 | 2 | `.tmp/6770/rows-m3.log` |
| base `origin/main` @ `f156b4ba83` (after #6771/#6774/#6775) | 3 | 43 | 3 | lead re-measure 2026-10-02 |
| branch @ `f156b4ba83` merged in | **44** | 3 | 2 | lead re-measure 2026-10-02; pins 35/35; full gate chain incl. #6797 gates green |

| step | commit | rows fail → pass |
| --- | --- | --- |
| S1 `Object.assign` ToObject | `d186279fc8` | 4 — `assign/Target-{String,Number,Boolean}`, `assign/Override-notstringtarget` |
| S2 reflective-write literals are open `$Object`s | `8ad607dc33` | 6 — `assign/ObjectOverride-sameproperty`, `assign/target-is-frozen-data-property-set-throws`, `assign/target-is-non-extensible-existing-accessor-property`, `Reflect/set/set-value-on-data-descriptor`, `Reflect/deleteProperty/delete-properties`, `entries/symbols-omitted` |
| S3 own-key order | `a6d62b339f` | 5 — `Reflect/ownKeys/order-after-define-property`, `Reflect/ownKeys/return-on-corresponding-order-large-index`, `getOwnPropertyDescriptors/order-after-define-property`, `keys/order-after-define-property-with-function`, `entries/order-after-define-property-with-function` |
| S4 Reflect residue | `9173486efc` | 3 — `Reflect/setPrototypeOf/return-false-if-target-is-not-extensible`, `Reflect/defineProperty/return-boolean`, `Reflect/enumerate/undefined` |
| S5 `Object.prototype` members | `d72d21e6bc` | 4 — `prototype/__proto__/{prop-desc,set-ordinary-obj}`, `prototype/toLocaleString/primitive_this_value{,_getter}` |
| S6 `Object.prototype.toString` tags | `b2e8173713` | 5 of 8 — `get-symbol-tag-err`, `proxy-revoked-during-get-call`, `symbol-tag-{weakset,weakmap,promise}-builtin` |
| S7 Proxy `[[OwnPropertyKeys]]` surfaces | `172c0dac29` | 13 — the six `getOwnPropertySymbols`/`getOwnPropertyNames` `proxy-invariant-*`, `keys/proxy-non-enumerable-prop-invariant-3`, `getOwnPropertyDescriptors/{proxy-undefined-descriptor,proxy-no-ownkeys-returned-keys-order}`, `defineProperties/proxy-no-ownkeys-returned-keys-order`, `{seal,freeze}/proxy-with-defineProperty-handler`, `prototype/isPrototypeOf/arg-is-proxy` |
| S8 per-operation trap lookup | `f1466dc8ed` | 4 — `keys/property-traps-order-with-proxied-array`, `entries/observable-operations`, `values/observable-operations`, `keys/proxy-keys` |

S8 ran after #6766 landed (its Proxy-as-prototype arms are on the merged tree).

### Residual rows (5)

- `Object/prototype/toString/symbol-tag-non-str-builtin.js` — L20
  `SameValue(«"[object Symbol]"», «"[object Object]"»)`. After
  `delete Symbol.prototype[Symbol.toStringTag]`, `toString.call(Symbol("desc"))`
  still answers the brand: the step-14 consult never reaches
  `Symbol.prototype` from a `$Symbol` carrier (ToObject of a symbol has no
  wrapper prototype walk in the tag consult), so the carrier arm answers.
- `Object/prototype/toString/symbol-tag-override-primitives.js` — L26
  `SameValue(«"[object Boolean]"», «"[object test262]"»)`. A symbol-keyed write
  on a primitive-wrapper prototype (`Boolean.prototype[Symbol.toStringTag] =
  "test262"`) is dropped — the wrapper prototype singletons have no
  symbol-keyed storage the consult reads (p3 bits 4096–32768).
- `Object/prototype/toString/symbol-tag-generators-builtin.js` — L20
  `SameValue(«"[object Function]"», «"[object GeneratorFunction]"»)`.
  `%GeneratorFunction.prototype%` carries no `@@toStringTag`; a generator
  function classifies as `Function` (p3 bit 512).
- `Reflect/construct/arguments-list-is-not-array-like.js`,
  `Object/subclass-object-arg.js` — CE, owned by #3371, untouched.

### Probes (standalone; `.tmp/6770/probe.mts`, node `.tmp/6770/node-ref.cjs`)

At node's value on the branch: p1, p1a–p1g, p4 = 47, p5, p5a–p5f, p6 = 983039,
p6b = 31, p7 = 32767, p7b = 1048575, p8 = 1023, p9 = 32767, p10 = 8191,
p11 = 1321, p11a = 15, p11b = 31, p11c = 31, p12 = 681, p20 = 1023, p21, and
r1–r10 = 0 (`.tmp/6770/probes-s8.cmp`). Not at node's value:

| probe | base | branch | node | missing bits — mechanism |
| --- | --- | --- | --- | --- |
| p13 | 268245 | 325589 | 522239 | 2/8/32/65536/131072 — `sv(r.valueOf(), prim)` for an `Object.assign(<prim>, …)` result bound in the SAME module as a `ty(r)` call: the wrapper's `valueOf` through that binding still answers the wrapper. The four S1 rows pass; this is the probe's extra shape |
| p2 | 232 | 766 | 2047 | 1/1024 — a DIRECT type-changing write `t9.a = "q"` on a closed literal (no reflective builtin involved; outside S2's reflective-write scope); 256 — the probe's sloppy-frozen-write control throws in the strict module |
| p2b | 29840 | 32476 | 32511 | 1/2 the same direct write; 32 a checker-folded `===` |
| p3 | 17173654 | 17174015 | 1048575 | 512/4096–32768/65536 — the three S6 residual rows above; 524288 — `Map` (#5116's); +1<<24 — the strict-module throw (see plan) |
| p4b / p4c | 0 / 518 | 959 / 767 | 1023 | 64 / 256 — an UNTYPED `v.toLocaleString()` on a primitive keeps the generic ToString lowering |

### Pins — `tests/issue-6770-object-reflect-residue.test.ts`

34 tests; branch 34/34 green. Base verdict (pin file copied into
`.tmp/6770/ms/`, a snapshot of `origin/main` from 2026-10-01, `npx vitest run`):
all 30 "RED on base" pins fail and the 3 guards pass
(`.tmp/6770/pins-base.log`); the 34th, p60 (the gopd-result reification
below, added after that run), answers 42 on that snapshot and 7 (node's) on
the branch.

### Other issues' pins moved by this work

- `tests/issue-1355e.test.ts` "the ownKeys trap's array result flows through
  Object.keys": asserted `3` for trap keys the target does not have; node
  answers `0` (§20.1.2.17 keeps only keys whose [[GetOwnProperty]] is an
  enumerable descriptor). The target now carries the keys; still `3`.
- `tests/issue-5316-r6-nonextensible-existing-key-accessor.test.ts` residual
  pin: at node parity (`5`) on the S1–S7 tree, so the pin asserts `5`.
- `tests/issue-6637-…` "Object.keys: untyped fn enumerating through an ownKeys
  trap" went red at S7 — fixed in the S8 commit, not by editing the pin. A
  getOwnPropertyDescriptor trap that returns `{value: t[k], …}` returns an
  anonymous open-descriptor struct, which deliberately has no closed-struct
  `__extern_get` arm (every other boundary reifies it). The trap driver's
  closure call did not, so the §10.5.5 validator read `configurable` as
  `undefined` and threw. Pre-existing on main for
  `Object.getOwnPropertyDescriptor(proxy, k)`; S7 routed `Object.keys` through
  the trap. The gopd driver now reifies the result
  (`__proxy_gopd_result_reify`, `proxy-trap-read.ts`).

Proxy/Reflect vitest set (`.tmp/6770/proxy-tests.txt`, 34 files + the pin
file) on the S8 tree: 18 failures, every one also failing on `origin/main`
(`.tmp/6770/vitest-proxy-main*.log`); one main failure fixed (#5268 R2-1
freeze/seal through a Reflect-forwarding defineProperty trap).

### Controls

Population: `.tmp/6770/ctl-all.txt`, 4,952 rows — the ES5 control (3,908 rows:
ES5-classified rows passing in the standalone baseline under the plan's
directories) ∪ the ES2015 control (1,044 rows: passing `built-ins/{Proxy,
Reflect,Object,Symbol,Promise}/**`). Run on a snapshot of the merged branch
tree (`.tmp/6770/snap-m3`, `d28a7cc156`) with `.tmp/6770/ctlrun.sh`: chunks
of 100, each under its own `flock /tmp/claude-0/t262.lock`, `--isolate
--standalone`, QuickJS eval provider built in the snapshot. Any non-pass row is
re-run on an `origin/main` snapshot to separate this branch's regressions from
main's own drift.

PARTIAL — stopped at session wrap-up (2026-10-02 11:25 UTC). List
`.tmp/6770/ctl-ordered.txt` (4,861 rows), output `.tmp/6770/ctl-m3/`, chunks of
100. `ctlrun.sh` is resumable, so the run spans two trees:

| chunks | rows | tree | non-pass |
| --- | --- | --- | --- |
| 00–16 | 1,700 | `snap-m3` = `d28a7cc156` (before `c53b9be2c2`) | 1 |
| 17–24 | 800 | `snap-r1` = `fd48e174ea` (final src) | 0 |
| 25–48 | 2,361 | not run | — |

The one non-pass, `built-ins/Object/assign/strings-and-symbol-order-proxy.js`
(chunk 00, 04:50 UTC), is the S7 control regression that `c53b9be2c2` fixed at
05:32. It **passes on the final tree**: 6/6 runs in `snap-r1`, and in the
branch worktree. The wrap-up note that first called it an open regression was
wrong — it read a chunk log that predates the fix. No regression is known.

### Handoff (2026-10-02, session wrap-up)

The PR was opened with `hold` on that misreading. Lifting it needs:

1. `origin/main` merged in (done: `f156b4ba83`) with rows, pins and the full
   gate chain re-run on the merged tree.
2. The control's unrun rows (2,361), plus the 1,700 rows that ran only on the
   pre-fix tree, are covered by the merge group's full standalone test262 run
   and its per-test regression diff.

Rows stand at 44 / 49 (5 residual, listed above; 2 owned by #3371).

### Gates

On the merged tree, `LOC_GATE_BASE=$(git rev-parse origin/main)`, chained:
`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check-compiler-boundaries
--mode inventory`, `typecheck` — all exit 0 (`.tmp/6770/gates.sh`).
New leaves registered in `scripts/compiler-boundaries.json`.

### Acceptance

| criterion | state |
| --- | --- |
| S1–S7 rows (43) pass on the merged tree | **40 / 43** — three S6 `toString` tag rows are residual (above) |
| S8 rows (4) pass or are recorded | **4 / 4 pass**; S8 landed after #6766 merged |
| the two #3371 rows untouched | met |
| every probe at node's value | **not met** — p13, p2, p2b, p3 (beyond the Map bit), p4b, p4c (table above) |
| pin file red on base | met — 30 RED-on-base pins red on a 2026-10-01 `origin/main` snapshot, guards green; p60 42 → 7 |
| 0 pass→non-pass on the ES5 and ES2015 controls | see Controls |
| gates green, no raw checker, leaves registered | met |

`status` stays `in-progress`: the S6 residual rows and the probe gaps are
unmet criteria, not recorded-and-accepted ones.
