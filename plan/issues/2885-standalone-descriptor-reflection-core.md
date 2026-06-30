---
id: 2885
title: "Standalone descriptor-reflection core: materialise builtin-proto intrinsic accessors for gOPD / reflection (unblocks #2875/#2876/#2872)"
status: done
assignee: ttraenkler/sr-reflect
completed: 2026-06-30
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 2874, 2875, 2876, 2872, 2175, 2651]
umbrella: 2860
blocks: [2875, 2876, 2872]
---

# Standalone descriptor-reflection core

## Problem

Under `--target standalone`, the INTRINSIC accessor/method properties of builtin
prototypes (`RegExp.prototype.global`, `String.prototype.length`-family,
`%TypedArray%.prototype.byteLength`, …) are **not reflectable**. The builtin
proto object is a virtual `$NativeProto` struct (`native-proto.ts`), not an
`$Object` carrying `$PropEntry` accessor entries, so:

```js
// test/built-ins/RegExp/prototype/global/this-val-regexp-prototype.js
var get = Object.getOwnPropertyDescriptor(RegExp.prototype, "global").get;
assert.sameValue(get.call(RegExp.prototype), undefined);
```

`Object.getOwnPropertyDescriptor(RegExp.prototype, "global")` reaches the native
`__getOwnPropertyDescriptor` (`object-runtime.ts:5149`), which `ref.test $Object`
on the receiver. The `$NativeProto` is **not** an `$Object`, so it returns
`undefined`; the test then derefs `.get` on `undefined` → Wasm TypeError. This is
the shared defect behind ~70 of #2876 (RegExp), the ~159 of #2875 (String
prototype reflection / method-body), and the reflective-accessor subset of #2872
(TypedArray `verifyProperty`/`prop-desc`).

This was masked by the exception-formatter bug (#2862/#2870); de-masking surfaced
it as a concrete, shared standalone gap.

## Three coupled defect sites (verified against current main 2026-06-30)

1. **Getter-closure factory** — `ensureStandaloneNativeMethodClosure(brand,
member, "getter")` (`native-proto.ts:387`) + the per-builtin getter body
   (`regexp-standalone.ts:emitRegExpProtoMemberBody`, `:2459`, getter arm at
   `:2470`). The brand-recovery prologue (`recoverRegExpStructFromExternref`,
   `:907`) `ref.test $NativeRegExp` and throws TypeError on failure. For a genuine
   non-RegExp `this` (`g.call({})`) the throw is correct; but for `this ===
RegExp.prototype` (the proto object) §22.2.6 step "if SameValue(R,
   %RegExp.prototype%) return undefined" requires **undefined, not a throw** —
   that arm is missing. Also `.name` is recorded as the bare member (`"global"`)
   not the accessor spelling `"get global"` (`native-proto.ts:439`).

2. **`getOwnPropertyDescriptor` call-site** — `calls.ts:6693`. Its dynamic
   fallback (`:6903`+) only special-cases a bare builtin-ctor identifier (`arg0 ==
RegExp`) via `__get_builtin`; for `arg0 == RegExp.prototype` (a property
   access) it compiles the receiver to externref and calls native
   `__getOwnPropertyDescriptor`, which finds no own entry on the `$NativeProto`
   and returns undefined. There is **no builtin-proto-accessor synthesis path**.

3. **Latent plain-read bug** — `property-access.ts:3248` →
   `tryCompileStandaloneBuiltinProtoMemberRead` (`:899`, member emit at
   `:919-927`). For **every** member kind it emits `ref.func` + `struct.new`,
   returning the closure VALUE. For a getter (`RegExp.prototype.global` plain
   read) this returns the getter CLOSURE instead of invoking it — should return
   `undefined` for a `RegExp.prototype` receiver, or the computed value for an
   instance.

## Implementation Plan

### Root cause

Builtin prototypes are modelled as a virtual `$NativeProto` struct that carries
only a member-name CSV + name (`emitLazyNativeProtoGet`, `native-proto.ts:271`),
never `$PropEntry` accessor entries. The native reflection runtime
(`__getOwnPropertyDescriptor`) only understands `$Object`, so intrinsic accessors
are invisible to gOPD / the prototype chain. Plain getter reads and `get.call(...)`
also lack the spec's proto-identity arm.

### Design decision — (b) virtual + synthesis, NOT (a) materialise

**Chosen: (b)** keep builtin protos virtual (`$NativeProto`) and add a narrow,
`ctx.standalone`-gated SYNTHESIS path in the gOPD call-site + the getter closure.
Reject (a) "materialise every intrinsic as a real `$PropEntry` accessor entry on
an `$Object`-backed proto".

Rationale:

- **Blast radius.** (a) changes the SHARED `$NativeProto` representation that
  ~30 wired builtins (`tryEnsureNativeProtoBrand`, `property-access.ts:704-840`)
  depend on — RegExp, Array, Object, String, Number, Boolean, Date, Error +
  NativeError family, Map/Set, ArrayBuffer/DataView, every TypedArray view, etc.
  Converting the proto object to an `$Object` with eagerly-built accessor entries
  touches identity (`RegExp.prototype === RegExp.prototype`), the `.length`/`.name`
  meta-fold (`tryCompileStandaloneBuiltinProtoMemberMeta`, `:861`), and the lazy
  materializer. High regression surface across all standalone builtins.
- **Allocation cost.** (a) forces every proto access to allocate the full set of
  member get/set closures up front (RegExp alone has 10 getters + 5 methods),
  vs. (b) which materialises a closure only when a member is actually reflected.
- **Uniformity is still achieved** for the surfaces that matter (gOPD,
  `desc.get`, `get.call`, plain read) because the synthesis reuses the SAME
  brand-keyed closure factory the value-read path already uses — there is one
  source of truth for the getter/method closure, just consumed in three places.

The only thing (a) would buy that (b) doesn't is `getPrototypeOf`-chain descriptor
walks landing on the intrinsic accessor automatically; for the de-masked clusters
the tests read the OWN descriptor on the proto directly, so (b) covers them.

### Changes

**Site 1 — getter closure: proto-identity arm + accessor `.name`**

_File: `src/codegen/native-proto.ts`_

- Add an exported helper `emitNativeProtoIdentityReturnUndefined(ctx, fctx,
brand, thisParamIdx, undefinedResult)` near `emitBrandCheckTypeError` (`:460`).
  It loads `this` (externref param), `any.convert_extern`, `ref.eq`-compares
  against the materialized proto global for `brand` (reuse the global from
  `nativeProtoGlobalMap` — export a `getNativeProtoGlobalIdx(ctx, brand)` or call
  `emitLazyNativeProtoGet` to force-materialize then `global.get`), and on match
  emits `undefinedResult` + `return`. Wasm pattern below. This centralizes the
  spec's "SameValue(R, %Proto%) → undefined" arm so each builtin glue opts in
  with one call, keeping the shared factory's structure intact.
- In `ensureStandaloneNativeMethodClosure` (`:439`), record the accessor name as
  `kind === "getter" ? \`get ${member}\` : member`in`nativeClosureMeta`(§10.2.9 — accessor functions are named`"get <key>"`). Spec-correct uniformly
  across all wired getter brands; verify no currently-passing test asserts the
  bare getter name (grep the standalone baseline before/after).

_File: `src/codegen/regexp-standalone.ts`_

- In `emitRegExpProtoMemberBody` getter arm (`:2470`), BEFORE
  `recoverRegExpStructFromExternref` throws, insert the proto-identity guard:
  call `emitNativeProtoIdentityReturnUndefined(ctx, fctx, brand=RegExp, 1,
<push undefined of the member's result type>)`. The member result type for
  RegExp getters is externref (flags/source) or i32/f64 (flag bits/lastIndex) —
  for the proto-identity arm return the externref-null form and unify the closure
  result type to externref for getters (box i32/f64 results via `__box_*`), so
  the "undefined" sentinel is representable. Simplest: make ALL RegExp getter
  closures return externref (already done for ref results at `:2479`; extend the
  i32/f64 flag/lastIndex results to box through `__box_boolean`/`__box_number`).
  Then proto-identity → `ref.null.extern`; brand-fail → TypeError (unchanged);
  instance → boxed field value.

**Site 2 — gOPD builtin-proto descriptor synthesis**

_File: `src/codegen/object-runtime.ts`_

- Add native `__create_accessor_descriptor(get, set, flags) -> externref` as a
  sibling of `__create_descriptor` (`:5296`). Identical scaffold
  (`__new_plain_object` + `__extern_set` of native-string keys + `__box_boolean`
  attrs), but sets `get`/`set` (externref, null → undefined) instead of
  `value`/`writable`. Reuse the exact `setKeyCd`/`boolFlagCd` closures. params:
  0=get(externref) 1=set(externref) 2=flags(i32); local 3=desc.

_File: `src/codegen/expressions/calls.ts`_

- In the gOPD handler, after the typed-receiver fast path and BEFORE the dynamic
  `__getOwnPropertyDescriptor` fallback (insert at `:6902`, just before the
  "Fallback: dynamic case" comment), add a standalone builtin-proto branch:
  - Gate: `ctx.standalone` AND `arg0` is `<Builtin>.prototype` (property access,
    inner is an unshadowed `BUILTIN_CTOR_NAMES` identifier — mirror the detection
    in `tryCompileStandaloneBuiltinProtoMemberRead`, `property-access.ts:899`)
    AND `arg1` is a string literal naming a member the glue advertises.
  - `tryEnsureNativeProtoBrand(ctx, builtinName)` → brand; `glue.memberKind(member)`.
  - getter → `ensureStandaloneNativeMethodClosure(brand, member, "getter")`,
    emit `ref.func`+`struct.new`+`extern.convert_any` for the `get` arg,
    `ref.null.extern` for `set`. Intrinsic accessors are
    `{enumerable:false, configurable:true}` (flags = `FLAG_CONFIGURABLE` = 0x04);
    call `__create_accessor_descriptor`.
  - method → `ensureStandaloneNativeMethodClosure(brand, member, "method")`,
    wrap as a DATA descriptor `{value:<closure>, writable:true, enumerable:false,
configurable:true}` via the existing `__create_descriptor` (flags =
    `FLAG_WRITABLE | FLAG_CONFIGURABLE` = 0x05).
  - Return `{kind:"externref"}`. If the member/brand doesn't resolve, fall
    through to the existing dynamic fallback (no behavior change for other cases).

**Site 3 — plain getter read invokes the closure**

_File: `src/codegen/property-access.ts`_

- In `tryCompileStandaloneBuiltinProtoMemberRead` (`:919-927`): split on
  `kind`. For `kind === "method"` keep the current closure-value emit. For
  `kind === "getter"`, instead of returning the closure value, INVOKE it on the
  receiver: materialize the closure (`ref.func`+`struct.new`), push the receiver
  (`<Builtin>.prototype`, i.e. the `$NativeProto` externref via
  `emitLazyNativeProtoGet`) as the `this` arg, and `call_ref` through the wrapper
  (reuse the existing native-closure call path — see how `calls.ts:1000` invokes
  a `"method"` closure). The proto-identity arm in Site 1 then yields `undefined`
  for the `RegExp.prototype.global` plain read; an instance receiver yields the
  computed value. (Plain reads of getters on a true RegExp instance already route
  through `tryCompileStandaloneRegExpPropertyRead` at `:3253` — this site only
  fires for the literal `<Builtin>.prototype.<getter>` shape.)

### Wasm IR pattern (Site 1 proto-identity guard)

```wasm
;; emitNativeProtoIdentityReturnUndefined(brand=RegExp, thisParamIdx=1)
local.get $this            ;; externref param 1
any.convert_extern
;; force-materialize + load the proto global (emitLazyNativeProtoGet leaves externref)
global.get $__native_proto_<brand>
any.convert_extern
ref.eq
if
  ref.null.extern          ;; undefined (getter result unified to externref)
  return
end
;; … fall through to ref.test $NativeRegExp brand check (existing) …
```

### Shared-factory regression risk + guard

- `ensureStandaloneNativeMethodClosure` and `emitNativeProtoIdentityReturnUndefined`
  are SHARED across ~30 wired brands. The `.name = "get <member>"` change and the
  getter-result-type unification to externref affect every wired getter brand
  (ArrayBuffer.byteLength, DataView.\*, TypedArray accessors, …).
  - **Guard A:** the proto-identity arm is OPT-IN per glue (only brands whose
    `emitMemberBody` calls the helper get it) — RegExp-only in PR1, so other
    brands are byte-unchanged until their cluster lands.
  - **Guard B:** the `.name` accessor spelling is universal but spec-correct;
    before merge, diff the standalone baseline jsonl for any `pass→fail` on
    `*/name.js` / `propertyHelper` getter-name assertions across ALL builtins,
    not just RegExp (this is the one change with cross-brand reach).
  - **Guard C:** getter-result externref unification — only touch a brand's
    getter bodies when that brand is in scope; keep the existing
    `fieldType.kind === "ref"` boxing as-is and ADD the i32/f64 boxing arm
    guarded so non-RegExp brands that already return externref are untouched.
- Standalone-only throughout (`ctx.standalone`): zero host-mode reach. Validate
  on full `merge_group` + the standalone high-water floor
  (`check-standalone-highwater.mjs`), never a scoped sweep (broad-impact rule).

### Slicing (2-3 senior-dev PRs)

- **PR1 — core + RegExp pilot (senior-dev):** Site 1 (`emitNativeProtoIdentityReturnUndefined`
  helper + accessor `.name` + RegExp getter proto-identity arm + getter-result
  externref unification) + Site 3 (plain getter read invokes). Native
  `__create_accessor_descriptor` (object-runtime). Validates the RegExp
  getter-reflection + plain-read subset of #2876.
- **PR2 — gOPD synthesis (senior-dev):** Site 2 (calls.ts builtin-proto
  descriptor synthesis path, getter + method arms). Unblocks the gOPD-based bulk
  of #2876 + opens #2875/#2872 reflective-accessor tests once their glue bodies
  exist.
- **PR3 — per-cluster member bodies (can split / hand to cluster owners):** wire
  the String (#2875) and `%TypedArray%`/view (#2872) getter+method
  `emitMemberBody` arms + their proto-identity opt-in. Often separable per
  cluster; PR1+PR2 land the machinery, #2875/#2876/#2872 become "fill in the
  glue" follow-ups.

### Clusters unblocked + est. tests

- **#2876 RegExp:** ~70 (the gOPD-based + getter-reflection brand-check tests).
- **#2875 String.prototype:** ~159 (reflective descriptor reads over String proto
  members + the method-body forms gated behind them).
- **#2872 TypedArray accessors:** the `verifyProperty`/`prop-desc` reflective
  subset of the 294 (accessor descriptors over `%TypedArray%.prototype` members).

PR1+PR2 (the core) are the shared lever; the per-cluster issues retag
`blocked-on #2885` until it lands.

### Test files to verify (verify-first, `runTest262File(file, cat, undefined, "standalone")`)

- `test/built-ins/RegExp/prototype/global/this-val-regexp-prototype.js`
  (proto-identity → undefined)
- `test/built-ins/RegExp/prototype/global/this-val-non-obj.js` /
  `name.js` (brand-check TypeError; `get.name === "get global"`)
- `test/built-ins/RegExp/prototype/source/length.js` (accessor `.length === 0`)
- `test/built-ins/String/prototype/*/length.js`, `*/name.js` (#2875)
- `test/built-ins/TypedArray/prototype/byteLength/length.js`,
  `*/prop-desc.js` (#2872 accessor reflection)

## Implementation Notes (sr-reflect, 2026-06-30)

**Scope landed in this PR: PR1 + PR2 together (the #2885 core).** The architect's
slicing kept PR1 (Site 1 + Site 3 + native helper) separate from PR2 (Site 2 gOPD
synthesis) for review granularity. I combined them in one PR because:

- The issue's **headline acceptance** is the gOPD verify-first
  (`Object.getOwnPropertyDescriptor(RegExp.prototype, "global")` → proper accessor
  descriptor, host-free), which is a PR2 deliverable — PR1 alone could not satisfy it.
- **Blast radius is identical.** PR2 (Site 2) is purely additive: a new
  `ctx.standalone` + `<Builtin>.prototype` + advertised-member–gated branch inserted
  _before_ the existing dynamic gOPD fallback. It adds zero reach over PR1's shared
  changes (Guard B `.name`, getter-result externref unification), which dominate the
  risk regardless.
- One merge-queue / CI cycle instead of two, unblocking #2875/#2876/#2872 faster.

PR3 (per-cluster String/TypedArray `emitMemberBody` glue) remains a follow-up under
those issues.

**What works now (verified host-free, `imports: []`):**

- gOPD returns a proper ACCESSOR descriptor `{get:<fn>, set:undefined,
enumerable:false, configurable:true}` for `RegExp.prototype.<getter>` (was
  `undefined` → deref-trap on main).
- `get.call(RegExp.prototype) === undefined` (§22.2.6 proto-identity arm).
- Plain read `RegExp.prototype.<getter>` invokes the getter → `undefined` for the
  proto receiver (was: returned the getter closure value).
- Native `__create_accessor_descriptor(get, set, flags)` carries the accessor
  descriptor host-free (sibling of `__create_descriptor`).

**Known follow-up (NOT a regression — same behaviour on main):** reflective
operations on the _opaque descriptor-retrieved_ getter closure —
`desc.get.call(<instance>)` returning the boolean, `desc.get.call(<non-RegExp>)`
throwing TypeError, and `desc.get.name === "get global"` — still do not fully
resolve. They route through `tryEmitNativeProtoReflectiveCall`, which recovers the
brand+member from the _receiver's TS symbol_; a value pulled out of a descriptor has
no such symbol, so the call falls to the legacy drop-`thisArg` path (returns
undefined). This is the pre-existing #2193 reflective-call-on-opaque-closure
limitation, independent of descriptor synthesis. Consequently
`this-val-non-obj.js` / `name.js` stay `fail` (they were `fail`/errored on main too),
while `this-val-regexp-prototype.js`, `global/length.js`, `source/length.js` flip to
`pass`.

### Changes

- `src/codegen/native-proto.ts` — `emitNativeProtoIdentityReturnUndefined()`
  helper (ref.eq identity vs the materialized proto global via `EQ_HEAP_TYPE`
  cast); accessor `.name = "get <member>"` in `ensureStandaloneNativeMethodClosure`
  (§10.2.9).
- `src/codegen/regexp-standalone.ts` — getter arm runs the proto-identity arm
  BEFORE brand recovery; getter result unified to externref (i32 flag bools box
  via `__box_boolean`, defensive f64 via `__box_number`).
- `src/codegen/object-runtime.ts` — native `__create_accessor_descriptor`.
- `src/codegen/expressions/calls.ts` — Site 2 gOPD builtin-proto descriptor
  synthesis (getter → accessor descriptor; method → data descriptor).
- `src/codegen/property-access.ts` — Site 3 plain getter read invokes the
  closure on the proto; exported `tryEnsureNativeProtoBrand` + `BUILTIN_CTOR_NAMES`.

### Test Results

- `tests/issue-2885.test.ts` — 5/5 pass (gOPD accessor shape, proto-identity
  call, plain-read undefined, host-free zero-imports, user-struct gOPD unchanged).
- `runTest262File(..., "standalone")`: `RegExp/prototype/global/this-val-regexp-prototype.js`
  `pass`, `global/length.js` `pass`, `source/length.js` `pass`
  (all errored on main); `this-val-non-obj.js` / `name.js` remain `fail`
  (follow-up above — not regressions).
- Regression smoke (identical output on main vs branch): `re.test`, `/x/g.global`,
  `Array.prototype.slice.call`, method `.name`/`.length` meta-fold, gOPD on a user
  struct — no behaviour change introduced.
- `tsc --noEmit` clean.
- Full conformance + the honest standalone floor (12,889) validated by CI
  `merge_group`.
