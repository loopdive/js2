---
id: 2515
title: "host-independence: complete the standalone Wasm-native open-object/property runtime (residual of #1472)"
status: ready
sprint: 64
created: 2026-06-19
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: objects, property access, descriptors, prototype chain, Reflect
goal: host-independence
related: [1472, 1591]
---

# #2515 — Complete the standalone open-object/property runtime (residual of #1472)

## Problem

`#1472` shipped the Wasm-native open-`$Object` runtime core and most of its
slices (new/get/set/delete + proto walk; `$ObjVec` enumeration;
keys/values/entries/assign; `__extern_has`/`in`; hasOwn; getPrototypeOf /
Object.create / isPrototypeOf; freeze/seal/preventExtensions + integrity
predicates; `__defineProperty_value`/`__defineProperty_accessor`/
`__getOwnPropertyDescriptor`; read-side descriptor reflection
`__getOwnPropertyNames`/`__getOwnPropertySymbols`/
`__object_getOwnPropertyDescriptors`; `__to_property_key` key hardening;
boxed-wrapper `__new_Number`/`String`/`Boolean`; `__extern_method_call`
any-receiver dispatch; native Reflect `get`/`set`/`has`/`deleteProperty`/
`ownKeys`). It is marked `done`, but a well-defined **residual tail** still
keeps the standalone lane far behind JS-host (standalone ≈ 50.8% high-water vs
host 72.7%).

This issue closes that residual. It is **NOT** a re-spec of landed work — every
slice below was confirmed against current `src/codegen/object-runtime.ts`,
`src/codegen/expressions/calls.ts`, and `src/codegen/property-access.ts` on
`origin/main` (45dab28e0) and against the freshest full standalone run.

### Authoritative measurement (full standalone run `test262-standalone-results-20260616-175848.jsonl`, 21,253 pass / 44.3% reached-rate)

Residual error clusters in the open-object/property family, by raw row count in
that run (each is a **distinct** failure shape; numbers are the dominant
sub-counts, indicative ±):

| Residual cluster | rows | shape | this issue? |
|---|---:|---|---|
| Late-import / global-index-shift emit bug (`global index out of range — -1`, `u32 out of range: -1`) | **626** | binary-emit CE; poisoned funcIdx/globalIdx after a deferred late-import flush | **S0 (keystone)** |
| `__defineProperty_desc` refusal (generic `Object.defineProperty(o,k,descObj)` / `Object.create(o, descs)`) | **514** | Phase-B refusal — helper deliberately unregistered, blocked on S0 | **S1** |
| ValidateAndApplyPropertyDescriptor semantics (`verifyProperty` asserts, redefine-TypeError, attribute defaults) | ~300 | `assertion_fail` / missing catchable TypeError | **S2** (depends on S1) |
| `Object.prototype.toString.call(...)` / `@@toStringTag` (`[object X]`) | **225** | refusal | **S3** |
| `Reflect.construct` (and `Reflect.defineProperty` once S1 lands) | **170** + 53 | Phase-C refusal | **S4** (S1 first for defineProperty) |
| Boxed-wrapper ToPrimitive residual in operator contexts | ~200 | `Cannot convert object to primitive` over `new Number/String/Boolean` | **S5** (coordinate #1910) |

### Explicitly OUT of scope (route elsewhere — do not slice here)

- **Built-in static property value reads** — the single largest refusal cluster
  in the run (`Symbol.iterator` 777, `Int8Array.prototype` 528,
  `Array.prototype` 522, `Object.prototype` 337, `String.prototype` 330,
  `Symbol.species`/`Symbol.toStringTag`, `*.BYTES_PER_ELEMENT`, …; `__get_builtin`
  refusal 404). This is the **built-in prototype-graph / `globalThis[name]`**
  epic, in flight as **#2193 / #2158 / #49** (PR-A for `Array.prototype` /
  `Object.prototype` already merged). The S3 `@@toStringTag` slice here is the
  *only* overlap and is scoped to `Object.prototype.toString.call` specifically.
  Cross-link, do not absorb.
- `with`-statement (#1387), Temporal, Atomics static reads, dynamic-import —
  claimed by earlier buckets (first-match-wins), not in this family.
- Array.prototype generic borrowed-receiver invalid-Wasm — **#2036** (S6 there).
- Descriptor-bucket semantics already specced in **#2042** (S1/S3/S4) — this
  issue's S1/S2 are the *call-site activation + VAPD* completion of #2042's
  runtime groundwork once S0 unblocks the emitter.

---

## Implementation Plan

Ordered by impact-per-effort. **S0 is the keystone** — it unblocks S1 (and
S1 unblocks S2 and half of S4). S3 and S5 are independent and can run in
parallel by separate devs. Each slice is an independently-landable PR with
net ≥ 0 on the regression gate.

> **Dispatch order:** S0 → (S1 ∥ S3 ∥ S5) → S2 → S4.

### Established pattern (read before touching anything)

`src/codegen/object-runtime.ts` `ensureObjectRuntime(ctx)` registers every
native helper as a **DEFINED** func (no import added ⇒ no late-import index
shift) with the **same name + externref signature** as the host import.
`OBJECT_RUNTIME_HELPER_NAMES` (object-runtime.ts ~L6530) is the routing set:
`ensureLateImport` (`src/codegen/expressions/late-imports.ts:377`) checks it
under `ctx.standalone` BEFORE the Phase-A `refuseStandaloneObjectImport` gate
(late-imports.ts:80) — so adding a name to the set + registering its body is the
whole "activate native" change, with **zero per-call-site retargeting**. Every
new helper MUST go through `registerNative(...)` and be added to the set.
Internal helpers (`__obj_hash`/`__obj_find`/`__obj_insert`/`__obj_grow`) are
NOT in the set.

---

### S0 — Kill the residual late-import / global-index-shift emit bug (KEYSTONE)

**Payoff: ~626 rows directly + unblocks S1's 514 + S4's 53 = the highest-leverage slice.**

**Root cause.** `#2043` (status: done, 2026-06-10) ratified the structural fix
(always-on emit-time index validation + stale-proof func references), but the
run still shows **626** `global index out of range — -1` / `u32 out of range: -1`
binary-emit CEs. These are residual instances where a funcIdx/globalIdx is
captured into a JS variable, a deferred `flushLateImportShifts` /
`addUnionImports` / `addStringImports` shifts the index space, and the captured
value goes stale (or a failed `funcMap.get` bakes `-1`). The
`__defineProperty_desc` registration is **explicitly blocked on this** — see the
NOTE at `object-runtime.ts:4754` ("its sole call site … currently trips the
#2043 late-import index-shift emit bug, so registering it converts a clean
refusal into a messier #2043 binary-emit error with no test gain").

**Changes.**

**File: `src/emit/binary.ts`** (~L105, `validateFuncRefs`)
- Confirm `validateFuncRefs` is **always-on** (not env-gated behind
  `JS2WASM_VALIDATE_FUNCREFS`) per #2043's ratified scope, and that it walks
  **every** index space the encoder writes, not just `call`/`return_call`/
  `ref.func`: also `call_ref`/`struct.*`/`array.*` type indices, **global
  indices** (`global.get`/`global.set`), table/element/export/start entries, and
  exception tags. The 626 rows are `-1` *global* indices, which the original
  walker (func-only) does not catch — extend it to globals.
- Each finding must report a **named, located** `Codegen error:` at compile time
  (file + funcIdx + op), not an opaque `u32 out of range: -1` at the encoder.

**File: `src/codegen/expressions/late-imports.ts`** (`shiftLateImportIndices`, L139; `flushLateImportShifts`)
- Audit the shift walker (it already shifts `funcIdx` in nested instr arrays via
  the `shifted: Set<Instr[]>` dedup, L150) for the two stale-capture sites the
  run still hits:
  1. **Global indices baked into `global.get`/`global.set`** emitted before a
     flush — the walker shifts `funcIdx` but NOT `globalIdx`. If late imports
     can shift the global space (they can when string/union imports add globals),
     add a `globalIdx` shift arm mirroring the `funcIdx` arm (L155).
  2. **Captured `funcMap.get(name)` returning `-1`** baked into an instr before
     the helper is registered. The fix is to register-then-capture (move the
     `ensureObjectRuntime`/`ensureLateImport` call ABOVE the capture), or
     re-resolve `funcMap.get(name)` at flush time. The `__defineProperty_desc`
     call site (next slice) is the canonical instance — fix it there as the
     S0 acceptance proof.

**Edge cases.**
- A nested block (`then`/`else`/`loop` body) reachable from both `fctx.body` and
  a `savedBody` must be shifted exactly once (the existing `shifted` set handles
  funcIdx; ensure the new globalIdx arm reuses the same dedup walk).
- `body: []` (not `body: func.body`) in any new FunctionContext — shared
  references break the savedBody/swap pattern (CLAUDE.md invariant).

**Per-slice test approach.**
- Repro: the `Object.create(o, descs)` with an identifier descriptor value
  pattern (the documented S0 trigger). Compile under `--target standalone`,
  assert the module **validates** + instantiates under empty imports (no
  `global index out of range`).
- Targeted test262 subset: re-run the 626-row set
  (`grep -l "global index out of range" ...` from the JSONL → file list);
  assert ≥ 500 flip from CE to pass/fail (some will surface a *real*
  downstream gap — that's S1/S2, still net-positive vs a binary-emit CE).
- New unit test in `tests/issue-2515.test.ts`: emit a module that forces a late
  global-import shift after a `global.get`, assert `validateFuncRefs` reports a
  located error (not an encoder panic) when artificially poisoned.

---

### S1 — Register & activate `__defineProperty_desc` (generic descriptor define)

**Payoff: ~514 rows. Depends on S0.**

**Root cause.** `__defineProperty_desc(obj, key, descriptorObj)` — the generic
`Object.defineProperty(o, k, descObj)` / `Object.create(o, descs)` entry used
when the descriptor shape is a runtime `$Object` rather than a statically-known
literal — is **not registered** (object-runtime.ts:4754 NOTE) and not in
`OBJECT_RUNTIME_HELPER_NAMES`, so it hits the Phase-A refusal (514 rows). The
delegate it needs (`__defineProperties` — a one-entry `{ [key]: desc }` map) is
already native and verified working; only S0 (emitter) blocked landing it.

**Changes.**

**File: `src/codegen/object-runtime.ts`** (register near `__defineProperties`, ~L4754)
- Register `__defineProperty_desc(externref obj, externref key, externref descriptor) -> externref`
  via `registerNative(...)`. Algorithm (ES §10.1.6 [[DefineOwnProperty]] →
  ToPropertyDescriptor §6.2.6.5):
  1. `any.convert_extern obj; ref.test $Object; i32.eqz; if (return obj)` —
     non-`$Object` receiver is a lenient no-op (matches host import / sloppy).
  2. `key = __to_property_key(key)` (#2042 key hardening already exists at
     object-runtime.ts:409 — reuse so a numeric/boxed key is decimal-stringified
     before the `$AnyString` cast).
  3. Read the six descriptor fields off the descriptor `$Object` via
     `__extern_get(descriptor, "value"|"get"|"set"|"writable"|"enumerable"|"configurable")`
     and `__extern_has` to distinguish "absent" from "present-undefined"
     (§6.2.6.5 ToPropertyDescriptor only copies *present* fields).
  4. Dispatch: if `get`/`set` present → `__defineProperty_accessor`; else →
     `__defineProperty_value`. Pass a flags word built from the present
     writable/enumerable/configurable bits (use `__to_bool` on each present
     field; default-absent handling is S2's job — for S1 forward what's present).
- Add `"__defineProperty_desc"` to `OBJECT_RUNTIME_HELPER_NAMES` (~L6560) and
  **delete the deferral NOTE** at L4754.

**File: `src/codegen/expressions/calls.ts`** (`Object.defineProperty` / `Object.create` handlers)
- Confirm the call site that emits `__defineProperty_desc` (the
  `Object.create(o, descs)` identifier-descriptor path the NOTE references)
  registers the helper via `ensureLateImport(ctx, "__defineProperty_desc", …)`
  and `flushLateImportShifts` BEFORE capturing the funcIdx (the S0 register-then-
  capture discipline). This site is the S0 acceptance proof.

**Edge cases.**
- Descriptor object that is itself a closed struct (TS narrowed `{value:1}`) vs
  open `$Object` — both must route here; the call site already builds the
  descriptor as externref in the dynamic path.
- `value` present AND (`get`|`set`) present → §6.2.6.5 throws TypeError. S1 may
  forward to the accessor arm (slightly wrong); S2 adds the catchable TypeError.
  Note this in the PR as an S2 follow-up, do not block S1.
- `__to_property_key` refuses Symbol keys loudly — preserve that (string-keyed
  `$Object` cannot hold symbols).

**Test approach.**
- Run-test (`tests/issue-2515.test.ts`, instantiate empty imports): computed-key
  `Object.defineProperty(o, k, {value: 7, enumerable: true})` then read back `o[k]`
  → 7; `Object.getOwnPropertyDescriptor(o, k).enumerable === true`. Use computed
  keys to defeat closed-struct inference (the #1472 test convention).
- test262 subset: `built-ins/Object/defineProperty/*` and
  `built-ins/Object/create/*` standalone rows — assert the 514 `__defineProperty_desc`
  refusals move off CE.

---

### S2 — ValidateAndApplyPropertyDescriptor semantics (depends on S1)

**Payoff: ~250–350 `assertion_fail` rows in `object-property-semantics`.**

**Root cause.** The native define path
(`__defineProperty_value`/`__defineProperty_accessor`/S1 `__defineProperty_desc`)
writes the `$PropEntry` without implementing §10.1.6.3
ValidateAndApplyPropertyDescriptor / §6.2.6.6 CompletePropertyDescriptor:
attribute **defaults** (writable/enumerable/configurable default **false** for a
fresh descriptor), the **[[Configurable]]:false transition rejection** table, and
the **catchable TypeError** on invalid redefinition. `verifyProperty` (the
test262 harness in these rows) makes the step order observable.

**SPEC-FIRST (mandatory).** Fetch the exact algorithm text before implementing —
do not work from memory:
- §10.1.6.3 ValidateAndApplyPropertyDescriptor (tc39.es/ecma262, ordinary-and-
  exotic-objects-behaviours page)
- §6.2.6.6 CompletePropertyDescriptor and §6.2.6.5 ToPropertyDescriptor
  (abstract-operations page)
Cite the section + step numbers in the commit message.

**Changes.**

**File: `src/codegen/object-runtime.ts`** — in `__defineProperty_value`,
`__defineProperty_accessor`, and S1 `__defineProperty_desc`, BEFORE writing the
`$PropEntry`:
1. `existing = __obj_find(o, key)` (already available internally).
2. If `existing == null` AND `o.flags & OBJ_FLAG_NONEXTENSIBLE` → throw catchable
   TypeError (use the existing `emitThrowTypeError` / exn-tag pattern; reuse the
   `Reflect.deleteProperty` throw machinery at calls.ts:5624 as the reference
   pattern).
3. If `existing != null` AND `(existing.$flags & FLAG_CONFIGURABLE) == 0` →
   enforce the §10.1.6.3 transition table:
   - reject changing configurable / enumerable
   - reject data↔accessor flip
   - reject writable false→true
   - reject value change when writable:false
   → throw catchable TypeError.
4. For a NEW entry, apply CompletePropertyDescriptor defaults to the flag word:
   any attribute the descriptor did NOT supply defaults to **false**
   (writable/enumerable/configurable) — this is observably different from S1's
   "forward what's present"; a fresh data descriptor with only `{value}` →
   writable:false.

**Edge cases (all `verifyProperty`-observable — follow step order exactly).**
- Redefine a configurable property freely (no throw).
- `value` change to the **SameValue** existing value when writable:false → allowed
  (§10.1.6.3 step special-cases SameValue).
- Accessor with only `get` (no `set`) → `set` defaults to undefined, not absent.
- The TypeError must be **catchable** (test262 `assert.throws(TypeError, …)`) —
  route through the exn-tag, not a host abort/trap.

**Test approach.**
- Run-test: `Object.defineProperty(o,'x',{value:1})` then
  `assert.throws(TypeError, () => Object.defineProperty(o,'x',{value:2}))` (non-
  configurable, non-writable redefine) — assert it throws and is caught.
- test262: `built-ins/Object/defineProperty/15.2.3.6-4-*` (redefinition-throws)
  and the `verifyProperty`-based rows in `built-ins/Object/defineProperties/*`.

---

### S3 — `Object.prototype.toString.call(...)` / `@@toStringTag` → `[object X]`

**Payoff: ~225 rows. Independent — run in parallel.**

**Root cause.** `Object.prototype.toString.call(x)` (and bare `({}).toString()`)
refuses under standalone ("Object.prototype.toString.call(...) is not yet
supported"). §20.1.3.6 requires returning `"[object " + tag + "]"` where `tag`
is derived from the value's builtin class (`Undefined`/`Null`/`Array`/
`Function`/`Error`/`Boolean`/`Number`/`String`/`Date`/`RegExp`/`Arguments`,
else `"Object"`) unless the object has a string `@@toStringTag` own/inherited
property.

**SPEC-FIRST.** Fetch §20.1.3.6 Object.prototype.toString (fundamental-objects
page) for the exact builtin-tag dispatch order and the `@@toStringTag` override
rule.

**Changes.**

**File: `src/codegen/object-runtime.ts`** — register
`__object_proto_toString(externref) -> externref` (returns a `$AnyString`):
1. `ref.is_null` → `"[object Object]"` (standalone's null externref also encodes
   undefined; the §19 Null/Undefined special cases cannot be distinguished for
   the conflated null — note the approximation; for a `.call(null)` / `.call(undefined)`
   site that passes a real boxed value, distinguish where possible).
2. `ref.test $Object` → check for a string `@@toStringTag` slot. The string-keyed
   `$Object` cannot hold a Symbol key, so a symbol `@@toStringTag` is out of
   reach — return `"[object Object]"` for a plain `$Object` (correct for the
   common case). Document this as the same string-keyed approximation used across
   the runtime.
3. `ref.test $ObjVec` (array) → `"[object Array]"`; boxed-wrapper brands
   (`__new_Number`/`String`/`Boolean`-shaped) → `"[object Number/String/Boolean]"`;
   closure wrapper → `"[object Function]"`; Error brand → `"[object Error]"`.
4. Add `"__object_proto_toString"` to `OBJECT_RUNTIME_HELPER_NAMES`.

**File: the current refusal site** (grep
`"Object.prototype.toString.call(...) is not yet"` — locate it; likely
`property-access.ts` method-dispatch or `calls.ts`). Replace the `ctx.standalone`
refusal with `ensureLateImport(ctx, "__object_proto_toString", [externref],
[externref])` + flush.

**Edge cases.**
- `Object.prototype.toString.call(null)` → `"[object Null]"`,
  `.call(undefined)` → `"[object Undefined]"` (§19.1 special cases — distinguish
  where the call site passes a real boxed value; approximate to
  `"[object Object]"` for the null-externref-conflated case and note it).
- A user object with a *string-keyed* `"@@toStringTag"`-equivalent is not real
  spec behaviour; only `Symbol.toStringTag` matters, which is out of reach —
  `"[object Object]"` is the correct approximation.

**Test approach.**
- Run-test: `Object.prototype.toString.call([])` → `"[object Array]"`;
  `({}).toString()` → `"[object Object]"`; `Object.prototype.toString.call(42)`
  via boxing → `"[object Number]"`.
- test262: `built-ins/Object/prototype/toString/*` standalone rows (the
  symbol-tag rows will still fail — string-keyed limitation; assert the
  builtin-tag rows pass).

---

### S4 — `Reflect.construct` + `Reflect.defineProperty` natives

**Payoff: ~170 (construct) + 53 (defineProperty) rows. defineProperty depends on S1.**

**Root cause.** The standalone Reflect block (`calls.ts` ~L5558+) routes
`get`/`set`/`has`/`deleteProperty`/`ownKeys` to natives but `defineProperty`,
`construct`, `getOwnPropertyDescriptor`, `apply` still hit the Phase-C refusal at
calls.ts:5684 (`Reflect.${method} not supported in standalone mode`).

**Changes.**

**File: `src/codegen/expressions/calls.ts`** (Reflect block, before the L5684 refusal)
- `Reflect.getOwnPropertyDescriptor(t, k)` → route to the existing native
  `__getOwnPropertyDescriptor` (already in `OBJECT_RUNTIME_HELPER_NAMES`).
  Cheapest win — land first. Returns externref.
- `Reflect.defineProperty(t, k, desc)` → route to S1's `__defineProperty_desc`
  and return its boolean **success** as i32 (§28.1.3: Reflect returns false on
  failure rather than throwing). Give `__defineProperty_desc` a `boolean strict`
  param, or add a sibling `__reflect_defineProperty` that swallows the S2
  validation TypeError and returns 0. **Depends on S1.**
- `Reflect.construct(target, argsList[, newTarget])` → the hard one. **Refuse the
  3-arg `newTarget` form** (keep the loud refusal), but route the **2-arg form**
  to the same standalone construct path `new target(...args)` uses (coordinate
  with the class/construct owner #2158 — the construct ABI). If the construct
  plumbing for a spread-args list over a dynamic `$ObjVec` is not ready,
  **split**: land getOwnPropertyDescriptor + defineProperty first, keep construct
  refused with a narrowed message, so the cheaper wins are not blocked.

**Edge cases.**
- `Reflect.defineProperty` on a non-extensible/non-configurable conflict →
  return false (not throw). This is the Reflect-vs-Object semantic split — gate
  at the call site, do NOT change the shared `__defineProperty_desc` throw
  behaviour (Object.defineProperty must still throw).
- `Reflect.getOwnPropertyDescriptor` on a missing prop → undefined externref
  (native already returns that).

**Test approach.**
- Run-test: `Reflect.defineProperty(o, 'x', {value:5})` → true + `o.x === 5`;
  `Reflect.getOwnPropertyDescriptor(o,'x').value === 5`.
- test262: `built-ins/Reflect/defineProperty/*`,
  `built-ins/Reflect/getOwnPropertyDescriptor/*`,
  `built-ins/Reflect/construct/*` (2-arg) standalone rows.

---

### S5 — Boxed primitive-wrapper ToPrimitive residual (coordinate #1910)

**Payoff: ~200 `Cannot convert object to primitive` rows. Independent.**

**Root cause.** `new Number/String/Boolean` now build a `$Object` carrying the
`[[PrimitiveValue]]` slot (`__new_Number/String/Boolean`, object-runtime.ts:6622)
and `__to_primitive` is supposed to read it first (object-runtime.ts ~L1670). The
residual `Cannot convert object to primitive` rows are operator contexts
(`new Number(1) % "1"`, `new String("1") + new Number(1)`) where `__to_primitive`
still falls through to `throwTypeError` for some wrapper/hint combinations.

**Changes.**

**File: `src/codegen/object-runtime.ts`** (`__to_primitive`, ~L1670)
- Verify the `[[PrimitiveValue]]`-slot read fires for ALL three wrapper brands
  and BOTH hints (number/string/default) BEFORE the toString/valueOf own-prop
  probe (§7.1.1.1 OrdinaryToPrimitive: the wrapper's intrinsic `valueOf` returns
  the slot). If the slot is stored under a reserved non-enumerable string key,
  read it via `__obj_find` first; if a dedicated brand, `ref.test` it first.
- Audit the hint plumbing: a default-hint `+` and a number-hint `%` must both
  reach the slot. Coordinate with #1910's `__to_primitive` owner before editing
  (file overlap) — this should land as a sub-slice under **#1910**, cross-linked
  here, since the four buckets share the `object-to-primitive` classification.

**Test approach.**
- Run-test: `new Number(1) % "1" === 0`; `new String("1") + new Number(1) === "11"`;
  `String(new Number(1)) === "1"`.
- test262: `language/expressions/compound-assignment/S11.13.2_A4.*` and the
  relational/shift `*_A3*`/`*_A4*` wrapper rows.

---

## Acceptance criteria

- [ ] **S0**: zero `global index out of range — -1` / `u32 out of range: -1`
      binary-emit CEs in a standalone run; `validateFuncRefs` always-on and
      covers globals; the `Object.create(o, descs)` repro validates+instantiates.
- [ ] **S1**: `__defineProperty_desc` registered + in `OBJECT_RUNTIME_HELPER_NAMES`;
      deferral NOTE removed; the 514 refusal rows move off CE.
- [ ] **S2**: catchable TypeError on §10.1.6.3-invalid redefinition; attribute
      defaults applied; ≥150 of the ~300 `verifyProperty` rows pass.
- [ ] **S3**: `Object.prototype.toString.call(x)` returns spec `[object X]` for
      the builtin-tag cases; 225 refusals move off CE.
- [ ] **S4**: `Reflect.getOwnPropertyDescriptor` + `Reflect.defineProperty` native;
      2-arg `Reflect.construct` native (or split-refused with narrowed message).
- [ ] **S5**: boxed-wrapper ToPrimitive recovers the primitive in operator
      contexts for all three wrappers × number/string/default hints.
- [ ] Each slice: instantiate-under-empty-imports run-test green; zero new
      `env::__*` host imports leaked (`assertNoHostObjectImports`); net ≥ 0 on
      the regression gate; no GC/host-mode regression (all changes
      `ctx.standalone`-gated or inside `ensureObjectRuntime`).

## Files to modify (anchors verified on 45dab28e0)

- `src/emit/binary.ts` (~L105 `validateFuncRefs`) — S0
- `src/codegen/expressions/late-imports.ts` (L139 `shiftLateImportIndices`, L377 routing, L80 refusal gate) — S0
- `src/codegen/object-runtime.ts` (L4754 deferral NOTE / `__defineProperty_desc`; L1670 `__to_primitive`; L6530 `OBJECT_RUNTIME_HELPER_NAMES`; `registerNative`) — S1/S2/S3/S5
- `src/codegen/expressions/calls.ts` (L5558+ Reflect block; L5684 refusal; `Object.defineProperty`/`Object.create` handlers) — S1/S4
- `src/codegen/property-access.ts` (locate the `Object.prototype.toString.call` refusal) — S3
- `tests/issue-2515.test.ts` (new) — per-slice run-tests

## Cross-links

- #1472 (parent — open-object runtime core + landed slices)
- #2042 (descriptor reflection groundwork — S1/S2 activate it)
- #2046 (Reflect spec gaps — S4 completes it)
- #2043 (late-import index-shift structural fix — S0 closes residual instances)
- #2193 / #2158 / #49 (built-in prototype-graph epic — OUT of scope, owns the
  `*.prototype` / `Symbol.iterator` static-read cluster)
- #1910 / #1900 (ToPrimitive family — S5 lands as a sub-slice there)
- #2036 (array generic borrowed-receiver — separate)
