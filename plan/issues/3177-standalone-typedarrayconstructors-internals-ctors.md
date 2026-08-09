---
id: 3177
title: "standalone: TypedArrayConstructors internals + ctors — integer-indexed MOP internals, ctor arg protocols, from/of, per-ctor identity (356 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-16
priority: high
feasibility: hard
model: fable
task_type: bug
area: codegen
es_edition: multi
language_feature: typedarray
goal: standalone
umbrella: 2860
sprint: current
horizon: l
related: [2860, 2872, 2893, 2901, 3057, 3027]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff; the 'TypedArray internals ~350' slice recommended by the #3027 triage"
# loc-budget-allow (#3177 slice 1): small in-place extensions of the
# subsystems that own these mechanisms — dataview-native gains the
# $__ta_ctor singleton registrar + the inline OOB-read undefined fix
# (+ 5 export keywords for the shared codec helpers ta-dyn-mop.ts imports);
# property-access-dispatch gains the <TA>.prototype.constructor static arm.
# (slice 2, +319): dataview-native gains the shared §23.2.5.1 buffer-arg
# validation core (emitTaOffsetAlignmentCheck + emitTaBufferBoundsAndLength)
# wired into both dynamic construct paths, the ToIndex Symbol/f64-out
# extensions, and the RangeError-instance throw upgrade — all owned by this
# file's TA-construct subsystem; no new module is warranted for arms that
# splice into existing emitters.
# The bulk of the new code lives in the NEW file src/codegen/ta-dyn-mop.ts.
# index.ts: +6 — one import + the fillTaDynViewMopArms(ctx) call, which MUST
# sit in the barrel's finalize sequence (ordering vs the other fills is
# load-bearing); the implementation itself is in the new module.
# (slice 3, calls.ts +29): the §23.2.5.1-step-1 without-`new` TypeError arm
# must live INSIDE tryEmitInlineDynamicCall's dynamic-callee dispatch chain
# (it is one `ref.test $__ta_ctor` arm prepended to the same chain the
# proxy/bound-fn arms extend — extracting the chain builder to a module is
# the #3182 consolidation epic's call, not this slice's); the proto/
# isExtensible arms themselves live in ta-dyn-mop.ts.
# (slice 4): the descriptor arms + expando live in ta-dyn-mop.ts (non-god);
# the god-file growth is glue that MUST sit at the owning sites:
# object-ops.ts +44 — the shared emitDefinePropertyRejectionThrow helper +
# its 4 call-site wirings (§20.1.2.4 step 3: Object.defineProperty converts
# the dyn-view [[DefineOwnProperty]]-false sentinel to TypeError — the
# Object-vs-Reflect distinction only exists at the call sites);
# object-runtime-descriptors.ts +14 — __obj_define_from_desc threads the
# sentinel out (one scratch local + null-check, inside the native's body);
# dataview-native.ts +3 — the three dyn-view struct.new sites push the new
# expando field's null initializer.
loc-budget-allow:
  - src/codegen/dataview-native.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/index.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-ops.ts
  - src/codegen/object-runtime-descriptors.ts
  # (slice 5, of/from statics): the shared native `__ta_from_arraylike`
  # builder lives in dataview-native.ts (the TA-construct subsystem, already
  # allowed above); the `$__ta_ctor` `.of`/`.from` runtime two-arm MUST sit at
  # the any-receiver method-dispatch site in call-receiver-method.ts — the same
  # emitter the #2872 dyn-view `.fill`/`.reverse` two-arm and the #3140 `.bind`
  # arm already extend (extracting that dispatch chain is the #3182 epic's call,
  # not this slice's).
  - src/codegen/expressions/call-receiver-method.ts
# func-budget-allow (slice 5): the of/from two-arm was EXTRACTED to a new
# module-level `tryEmitTaStaticOfFrom` (~130 LOC, under the 300 ceiling), so the
# already-over-300 `compileReceiverMethodCall` grows only +6 — the minimal
# gated dispatch call (`if (…) { const r = tryEmitTaStaticOfFrom(…); if (r) …}`).
# The god-function itself is not further splittable in this slice (the #3182
# consolidation epic owns that); +6 for a new method dispatch is intended.
func-budget-allow:
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
# coercion-sites-allow: the NEW module's 4 uses (number_toString ×2,
# __str_to_number, __unbox_number) are the exact §7.1.21
# CanonicalNumericIndexString round-trip + the finalize-safe ToNumber the
# vec write arms already use — intentional REUSE of the existing coercion
# natives (no hand-rolled coercion added), required by the §10.4.5 MOP arms.
coercion-sites-allow:
  - src/codegen/ta-dyn-mop.ts
---

# #3177 — standalone: TypedArrayConstructors internals + constructor protocols

## Implementation Plan (sendev-1102, 2026-07-16 — verified against live probes on main)

Full-directory standalone sweep (736 files): 127 pass / 544 fail / 65 CE.
Signature clusters: 289 wrong-value asserts (dominated by missing observable
throws + identity), 144 `Cannot access property on null or undefined`, 47 CE
`Reflect.construct` (#1472 Phase C), 19 vacuous-callback, ~50 illegal-cast
throw-path closures, 10 CE `BigInt64/BigUint64Array.prototype` static read.

Verified mechanism gaps (probe `.tmp/probe-3177-mop5.mts`, all on main):
construction/element-get/`Reflect.has`/`length`/OOB-set-noop WORK on dynamic
views; BROKEN: `.constructor` identity both directions, `sample["1.1"]`
canonical-key interception, `Object.keys`, defineProperty expandos,
`delete` result, `.buffer` (undefined → every `$DETACHBUFFER` test dead).

Explorer-verified substrate (2026-07-16):

- ALL seven standalone MOP natives (`__extern_get`/`__extern_set`/
  `__extern_has`/`__delete_property`/`__reflect_set`/`__object_keys`/
  `__defineProperty_*`) gate on `ref.test $Object` only — zero
  `$__ta_dyn_view` arms. GOPD's call-site guard THROWS on non-$Object.
- `$__ta_dyn_view = {length mut i32, buf ref null $__vec_i32_byte,
byteOffset i32, kind i32}` subtypes `$__vec_base`; detach = `buf.length`
  forced to −1 (`IsDetachedBuffer` ≡ `buf==null || buf.length<0`); bounds
  helpers already floor to 0 on detach.
- `emitTaCtorValue` (bare `Uint8Array` in value position) does `struct.new`
  PER SITE — `taCtorSingletonGlobals` (#3054 D) is initialized but NEVER
  consumed, so ctor identity is broken at the root (`ref.eq` fails between
  two mentions of the same ctor).
- `%TypedArray%` intrinsic ctor object exists (#2901) but there is NO
  per-view ctor-as-value identity, no `.constructor` on the proto glue
  (excluded from `TYPED_ARRAY_PROTO_METHODS`), and TA names are absent from
  `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` (#3006 arm).
- `.buffer` on views is a hard refusal (`emitProtoMemberBodyRefusal`,
  array-object-proto.ts ~1377; the "PR-3" residual of #2901). Buffer-backed
  views carry the backing vec ref → identity is free once read.
- Finalize-time arm precedent: `fillDynamicForinVecArms` (#3183) prepends
  `ref.test`-guarded arms into the natives; `__str_to_number` +
  `number_toString` exist for canonical-numeric-key work.

### Work packages (this PR)

- **W1 identity**: (a) make `$__ta_ctor` per-kind SINGLETON module-globals
  (immutable global with `struct.new` const initializer; `emitTaCtorValue`
  → `global.get`) — identity by construction everywhere; (b) static arm
  `<TA>.prototype.constructor` → singleton (parallel to the
  property-access-dispatch.ts:294 `%TypedArray%` arm); (c) `.constructor`
  on statically-typed view receivers via TA names in the #3006-style arm;
  (d) runtime `.constructor` for any-typed dyn-view receivers inside the
  `__extern_get` dyn-view arm (kind → singleton global switch).
- **W2 integer-indexed MOP arms** (§10.4.5), PREPENDED before the generic
  `$__vec_base` arms (dyn-view subtypes it — must intercept first):
  factor `__ta_dyn_valid_index(view,f64)->i32` (IsValidIntegerIndex:
  integral, 0≤i<effectiveLen, not detached) + reuse the runtime-kind codec
  for `__ta_dyn_get_elem`/`__ta_dyn_set_elem`; add dyn-view arms to
  `__extern_get`/`__extern_has` (canonical-numeric string key via
  `__str_to_number`+`number_toString` round-trip = CanonicalNumericIndexString),
  `__extern_get_idx`/`__extern_has_idx`/`__extern_set`/`__reflect_set`,
  `__delete_property` (index: valid→false-but-configurable-per-ES2021…
  actually [[Delete]] canonical→ IsValidIntegerIndex? false : true),
  `__object_keys` (indices 0..len−1 + expando keys), `__defineProperty_*`
  (canonical index → validate + write element; else expando), GOPD call-site
  (dyn-view + canonical index → data descriptor {value, writable:true,
  enumerable:true, configurable:true}).
  Expando bag: append `expando: mut (ref null $Object)` field to
  `$__ta_dyn_view` (update every `struct.new` site in dataview-native.ts;
  append-only field keeps existing field indices and the `$__vec_base`
  subtype prefix valid); non-canonical keys delegate Ordinary\* to the
  expando `$Object` (lazily created on first define/set).
- **W3 `.buffer` dynamic arm**: dyn-view receiver → `struct.get buf` boxed
  externref (identity + detach observability for `$DETACHBUFFER`);
  plus `byteOffset` runtime arm if missing (byteLength exists, #3054 C).

### Slice 1 — LANDED (PR: this branch, 2026-07-16)

Directory sweep (all 736 files, standalone): 127 → **156 pass (+29), 0
regressions**; the arms are generic (any Reflect/bracket/keys/delete on a
dyn-view anywhere), so cross-directory gains land in full CI.

What landed:

- W1 identity: `$__ta_ctor` per-kind singleton globals (`emitTaCtorValue` →
  `global.get`; `getOrRegisterTaCtorSingleton` in dataview-native.ts);
  `<TA>.prototype.constructor` static arm (property-access-dispatch.ts,
  #3006-parallel, declaration-file-gated — TA builtins are interface+var,
  not classes, so `isExternalDeclaredClass` can't be the gate); runtime
  `.constructor` on dyn-views via the [[Get]] arm's kind→singleton switch.
- W2 MOP arms: NEW `src/codegen/ta-dyn-mop.ts` — `__ta_dyn_get_elem` /
  `__ta_dyn_set_elem` / `__ta_dyn_has_idx` natives (synthetic-fctx #2872
  pattern, reusing the #3057 byte codec) + `fillTaDynViewMopArms` finalize
  fill prepending dyn-view arms into `__extern_get`/`__extern_has`/
  `__extern_set`/`__reflect_set`/`__delete_property`/`__object_keys`/
  `__extern_get_idx`/`__extern_has_idx`. CanonicalNumericIndexString =
  `__str_to_number`→`number_toString` round-trip + "-0" literal (exact
  §7.1.21); IsValidIntegerIndex = integral ∧ ¬-0 ∧ (u32)i<len (detach
  floors len to 0 via the buf.length=-1 sentinel — OOB covers detached).
  Value ToNumber uses `__unbox_number` (finalize-safe DEFINED func — no
  import add / funcIdx shift at finalize).
- W3: `buffer`/`byteLength`/`byteOffset`/`BYTES_PER_ELEMENT`/`length` named
  props in the [[Get]]/[[Has]] arms — `.buffer` returns the SAME backing
  byte-vec ref (ArrayBuffer IS the bare `$__vec_i32_byte`), so
  `ta.buffer === buffer` identity holds and `$DETACHBUFFER` works on
  harness-shaped receivers.
- Fix: inline dyn-view OOB element read returns the `undefined` singleton
  (was `ref.null.extern` → `ta[oob] === undefined` was false).

Verified: tests/issue-3177.test.ts (19), scoped suites 2872/2186/2190/3054\*/
3057/3058/3169/3183/3190 — failures identical to clean main (4 pre-existing
issue-3183 rows fail on main HEAD too; noted for triage, unrelated).

### Slice 2 — ctor-arg protocol throws (PR: issue-3177-slice2-ctor-arg-protocols, 2026-07-16, fable-3177)

Directory sweep (all 411 non-bigint files under TypedArrayConstructors/,
standalone): 124 → **134 pass (+10), 0 regressions** (every before/after diff
line is fail→pass; verified against the PR-#3118-tip baseline worktree).

What landed (`src/codegen/dataview-native.ts` only):

- **§23.2.5.1 InitializeTypedArrayFromArrayBuffer protocol** on BOTH dynamic
  construct paths (`emitDynamicTaViewConstruct` — statically-ArrayBuffer-typed
  arg0; the ArrayBuffer arm of `emitTaDynCtorConstructFromLocals` —
  pre-evaluated argv): ToIndex(byteOffset) → offset%elementSize RangeError
  (NEW `emitTaOffsetAlignmentCheck`, runtime es) → ToIndex(length) →
  detached-buffer TypeError → bounds RangeError / auto-length (NEW shared
  `emitTaBufferBoundsAndLength`). Key semantics:
  - bufferByteLength is RE-READ after the arg coercions, so a valueOf that
    detaches mid-construction is observed (byteoffset/length-to-number-
    detachbuffer.js) — detach ≡ `buf.length < 0` sentinel.
  - explicit-length bounds compare runs in **f64** (pre-narrowing ToIndex
    value): a spec-legal length ≤ 2^53−1 overflows i32 and wrap-around would
    pass the check.
  - length-tracking (`-1` sentinel) now keyed on a RUNTIME
    `ref.test $__resizable_ab` — the old static "module registers a RAB type"
    flag skipped fixed-buffer auto-length validation module-wide.
  - "length is undefined" (step 13): a literal-`undefined` third arg counts
    as absent on the expression path (syntactic check); the argv path probes
    nullish at RUNTIME via `__nullish_to_null` + `ref.is_null`
    (`new TA(buffer, 0, undefined)` takes the length-omitted arm).
- **ToNumber(Symbol) → TypeError (§7.1.4)** in ToIndex: static-type check in
  `emitToIndexI32` (oracle `staticJsTypeOf === "symbol"`, DataView-setter
  pattern) + RUNTIME `ref.test $Symbol` in `emitToIndexI32FromArgLocal`
  (pre-boxed argv; byte-inert when no Symbol carrier is registered). Covers
  byteoffset-is-symbol / length-is-symbol / length-arg is-symbol-throws.
- **`emitThrowRangeErrorIf` upgraded to real RangeError INSTANCES** (was bare
  string throws) via `buildThrowJsErrorInstrs` — #3104/#3285-proofing: the
  incoming typed assert_throws (`e instanceof RangeError`) rejects a bare
  string. Applies to every ToIndex/bounds throw in this file, both lanes.

**Containment (`skipAutoModulo`)**: a STATIC `new Int8Array(n)` value is a
bare `$__vec_i32_byte` — the SAME struct as an ArrayBuffer (the pun `.buffer`
identity relies on) — so the argv arm cannot tell a genuine buffer from an
int8-family view used as a copy source (`new Float64Array(int8x10)`,
ctors/typedarray-arg/\*). The step-13.a buffer-modulo throw is therefore
SUPPRESSED on the argv arm only (it would turn that pre-existing
silent-wrong-length into an UNCAUGHT RangeError); the statically-typed path —
where every corpus modulo test lives — keeps the full check. Fixing the pun
(per-kind static views vs bare vecs) is substrate work, not this slice.

Flipped: byteoffset-is-symbol, byteoffset-to-number-detachbuffer,
detachedbuffer, excessive-length, excessive-offset (+resizable-ab),
length-is-symbol, length-to-number-detachbuffer, resizable-out-of-bounds,
length-arg/is-symbol-throws.

Verified: tests/issue-3177.test.ts 34/34 (19 slice-1 + 15 new); scoped suites
2186/2190/2872\*/3054\*/3057/3058/3169 identical to the branch-base baseline
(1 pre-existing 3169 row fails on base too); host lane emits valid Wasm on
the upgraded static-windowed RangeError path.

**Found while probing (NOT this slice, for the next owner):**

- `byteoffset-throws-from-modulo-element-size.js` +
  `bufferbyteoffset-throws-from-modulo-element-size.js` fail on a HARNESS
  gap, not codegen: the `testWithTypedArrayConstructors` shim
  (tests/test262-runner.ts ~1986) IGNORES the explicit ctor-list second arg
  (`floatArrayConstructors.concat([...])`) and always iterates all 8 ctors
  starting with Int8Array — for which es=1 legitimately does NOT throw, so
  assert #1 fails. Honoring an array-valued `selected` arg would flip both
  (+ other explicit-list tests suite-wide), but it changes compiled-harness
  wasm for many tests → needs an oracle_version bump and COORDINATION with
  in-flight #3104 (which already bumps to v4 and edits the same shims).
- The `-sab` variants fail earlier with `illegal cast` — SharedArrayBuffer
  values aren't recoverable as byte vecs (separate representation slice).
- `Object.getPrototypeOf(ta) === TA.prototype` identity (≈10 rows across
  ctors/\*: defined-length/-offset, returns-new-instance, returns-object,
  as-array-returns, same-ctor-returns-new-cloned…) needs per-kind PROTO
  $Object singletons + a "prototype" [[Get]] arm on `$**ta_ctor`+ a`**getPrototypeOf` dyn-view arm — the W-C mechanism; composes #2901's
intrinsic-ctor pattern (`emitTypedArrayIntrinsicCtorObject`).
- `TA(1)` WITHOUT new → TypeError (§23.2.5.1 step 1, undefined-newtarget-
  throws ×8): calling a `$__ta_ctor` value as a function currently returns
  undefined silently — needs a `ref.test $__ta_ctor → throw TypeError` arm
  in the dynamic call fallback.
- `Object.isExtensible(dynview)` → false (new-instance-extensibility ×5).
- Static-lane parity for the new checks (statically-NAMED ctors,
  `emitTaViewConstructWindowed` has alignment/bounds but no detached check;
  static count `new Int8Array(-1)` ToIndex asymmetry) — low corpus value,
  the harness always constructs through dynamic ctor values.

### Slice 3 — proto identity + without-new + isExtensible (PR: issue-3177-slice3-proto-identity, 2026-07-16, fable-3177)

Directory sweep (411 non-bigint files, standalone): 134 → **154 pass (+20),
0 regressions** (every diff line fail→pass vs the slice-2 result).

What landed:

- **`Object.getPrototypeOf(view) === TA.prototype` identity**
  (ta-dyn-mop.ts): the per-kind proto object IS the per-view-brand
  `$NativeProto` glue SINGLETON that a static `<View>.prototype` value read
  already yields (`emitLazyNativeProtoGet` global, #2651/#2901 lineage) — no
  new object shape. The fill registers the glue for all 9 kinds
  (`ensureTypedArrayViewNativeProtoGlue`, idempotent; shared memberCsv) and
  prepends: (a) a `__getPrototypeOf` dyn-view arm (runtime kind → glue
  global, lazy-init inline), (b) an `__extern_get` `$__ta_ctor` receiver arm
  serving `prototype` (same switch — identity closes) and
  `BYTES_PER_ELEMENT`; other keys fall through to the original body.
- **`TA(1)` without `new` → TypeError** (§23.2.5.1 step 1,
  calls.ts `tryEmitInlineDynamicCall`): an outermost `ref.test $__ta_ctor`
  arm in the dynamic-callee dispatch throws a real TypeError instance;
  gated on `ctx.taCtorTypeIdx >= 0` (byte-inert without TA ctor values) and
  added to the empty-candidates early-outs so it fires even in closure-free
  modules. Flipped all 7 undefined-newtarget/invoked-with-undefined-newtarget
  rows (incl. one `-sab` — the call throws before any SAB cast).
- **`Object.isExtensible(view)` → true** (`__object_isExtensible` dyn-view
  arm) — flipped all 5 new-instance-extensibility rows.

Flipped (20): defined-length(+-and-offset)/defined-offset,
returns-new-instance, returns-object ×2, as-array-returns,
same-ctor-returns-new-cloned-typedarray, new-instance-extensibility ×5,
undefined-newtarget-throws ×4, invoked-with-undefined-newtarget ×2 (+sab),
object-arg/length-throws (collateral of the ctor-receiver [[Get]] arm).

Verified: tests/issue-3177.test.ts 45/45 (11 new — incl. plain-object
getPrototypeOf/isExtensible/closure-dispatch fall-through guards); scoped
suites 2186/2190/2872/3006/3054\*/3057/3058/3133 all green (197 tests).

Known residuals (documented, low corpus value):

- The `__extern_get` ctor arm lives inside the dyn-view-gated fill, so a
  module that mentions a TA ctor but never CONSTRUCTS a view gets no
  `TA.prototype`/`BYTES_PER_ELEMENT` runtime read (corpus always
  constructs).
- `getProto(ta).constructor` chained-dyn reads land on the glue struct
  (whose `$ctor` field is null, #2651 S1) → undefined; the corpus asserts
  `ta.constructor` (slice 1) and `<TA>.prototype.constructor` (static arm)
  instead.
- Statically-typed receivers (`getPrototypeOf(new Uint8Array(4))` with a
  B1 `$__ta_view` rep) don't reach the dyn-view arm — harness shapes are
  all any-typed.

### Slice 4 — descriptor MOP arms + expando side-table (PR: issue-3177-slice4-descriptor-expando, 2026-07-16, fable-3177)

Directory sweep (411 non-bigint files, standalone): 154 → **196 pass (+42),
0 regressions** (every diff line fail→pass vs the slice-3 result; cumulative
#3177: 124 → 196). Ordinary-object blast radius verified against a clean
origin/main baseline worktree: `built-ins/Reflect/defineProperty` identical
(9/12), `built-ins/Object/defineProperty` +1 bonus flip (coerced-P-shrink),
0 regressions.

What landed:

- **Expando side-table**: `$__ta_dyn_view` gains an APPEND-ONLY 5th field
  `expando (mut externref)` (registry/types.ts; externref so the type has no
  `$Object` registration dependency — `$__bound_fn` precedent). The three
  creation sites push a null initializer; a lazily-created `$Object` carries
  every non-index own prop + the preventExtensions state.
- **Ordinary-key delegation in the slice-1 arms** (ta-dyn-mop.ts
  `buildStringKeyArm` miss paths): non-canonical string keys AND symbol keys
  now delegate to the expando by RECURSING the same native (the expando is a
  `$Object`, so the dyn-view arm declines and the ordinary body runs —
  no new machinery). get/has/delete keep legacy miss results when no expando
  exists; set/reflect_set lazily create it. Flipped the whole
  `key-is-not-numeric-index` / `key-is-not-canonical-index` /
  `detached-buffer-key-is-*` / `key-is-symbol` families across
  Get/Set/Delete/HasProperty (§10.4.5 "Otherwise, return Ordinary\*").
- **§10.4.5.1 [[GetOwnProperty]]** — `__getOwnPropertyDescriptor` dyn-view
  arm: valid canonical index → fresh data descriptor `{value, w:T, e:T,
c:T}` (via `__new_plain_object`/`__extern_set`/`__box_boolean`); invalid →
  undefined; ordinary keys → expando read-back.
- **§10.4.5.3 [[DefineOwnProperty]]** — dyn-view arms in
  `__defineProperty_value` (validate: invalid index / accessor bit /
  attribute specified-and-false via the host flags' specified-bits → REJECT;
  else element write) and `__defineProperty_accessor` (canonical index →
  always REJECT). **Rejection channel**: the natives return the input obj on
  every ordinary path and never null, so a `ref.null.extern` SENTINEL
  signals the spec `false`: `__obj_define_from_desc` threads it out
  (+scratch local), Reflect.defineProperty's existing `__is_truthy` reads it
  as `false`, and the compile-time Object.defineProperty sites (literal
  paths in emitExternDefinePropertyValue/NoValue + the two dynamic-desc
  sites) convert it to the §20.1.2.4 TypeError via the new shared
  `emitDefinePropertyRejectionThrow` (standalone/wasi-gated; ordinary
  receivers never return null so host/ordinary behavior is untouched).
  This serves BOTH test shapes: `…-throws.js` (Object.defineProperty →
  TypeError) and the Reflect `→ false` twins.
- **preventExtensions/isExtensible over the expando**:
  `__object_preventExtensions` dyn-view arm lazily creates the expando and
  flags it; the slice-3 isExtensible arm now recurses on the expando; a NEW
  key on a non-extensible expando pre-checks (`__hasOwnProperty` +
  `__object_isExtensible`) and rejects with the sentinel (this-is-not-
  extensible: Reflect → false ✓).

Verified: tests/issue-3177.test.ts 61/61 (16 new); suites 2186/2190/2872/
3054\*/3057/3058 + 1629-S6/1629b (descriptor lineage) all green;
DefineOwnProperty bucket 1 → 24/28, GetOwnProperty 1 → 5/12 (rest are
#2940-vacuous rows + the symbol-key descriptor READ-BACK residual below).

Known residuals:

- Ordinary `$Object` gOPD has no symbol-key read-back (string-keyed
  `$PropEntry` lookup) — `gOPD(view, sym)` after a symbol-keyed define
  returns undefined (internals/GetOwnProperty/key-is-symbol.js). The
  WRITE/READ MOP paths handle symbols (#2866 interning); only the
  descriptor reflection misses.
- `desc-value-throws.js`: element-write ToNumber uses `__unbox_number`,
  which does not invoke user `valueOf` (slice-2 finding) — the Test262Error
  from a throwing valueOf can't propagate.
- Reflect.defineProperty on a SEALED ORDINARY object still throws instead
  of returning false (pre-existing: the ordinary S4 preflight throws and
  Reflect has no catch channel; fixing it needs the ordinary path moved to
  the same sentinel discipline — a follow-on, NOT this issue).
- `__object_keys` does not append expando keys yet (OwnPropertyKeys
  enumeration of non-index own props).

### Slice 5 — `%TypedArray%.of` / `.from` statics (PR: issue-3177-slice5-from-of, 2026-07-24, dev-std-2/Opus)

Measured gap (current main, host vs standalone over `TypedArray{,Constructors}/
{from,of}`, 73 files): 55 host-pass / 38 sa-pass / **23 gap**. Branch:
50 sa-pass / **11 gap** = **+12 fail→pass, 0 regressions** (host-pass count
unchanged at 55; every flip is a construction row). Verified against a clean
`origin/main` worktree — the one remaining scoped-suite failure
(`tests/issue-3177.test.ts` `[[Delete]]: valid index → false`) reproduces on
main HEAD, i.e. PRE-EXISTING, not this slice.

`TA.of(v0,…)` / `TA.from(src[, mapfn[, thisArg]])` on a `$__ta_ctor` receiver
VALUE (the `testWithTypedArrayConstructors` harness shape) were unimplemented —
the call fell to the open-object dispatcher, returned an empty/undefined result,
and every `result.length` read trapped ("uncaught Wasm-GC exception").

What landed:

- **`__ta_from_arraylike(ctor, carrier) → externref`** (dataview-native.ts) —
  the shared native builder. Reads `carrier` through the dynamic
  `__extern_length` / `__extern_get_idx` arm (so a `$ObjVec`, an array-like
  `$Object`, or a plain vec are all indexable uniformly), builds a fresh
  same-kind `$__ta_dyn_view` of length `max(ToInteger(carrier.length), 0)`, and
  byte-encodes each `ToNumber`'d element on the ctor's RUNTIME kind
  (Uint8Clamped clamp included) via the existing `emitDynEncodeDispatch` codec.
  The dyn-view rep yields `.constructor` / `Object.getPrototypeOf` identity for
  free (slices 1/3). noJsHost + defined-func only (no import shift).
- **Runtime `ref.test $__ta_ctor` two-arm** at the any-receiver method-dispatch
  site (call-receiver-method.ts, alongside the #2872 `.fill`/#3140 `.bind`
  arms). THEN builds the carrier — `of` packs its args into a `$ObjVec`; `from`
  normalizes its source via `__array_from_iter_n` (no/undefined mapfn) or
  `__array_from_mapped` (a present, non-nullish mapfn — composes
  `__array_from_iter_n` + `__hof_map`, a compile-time-known-argc runtime nullish
  branch on the mapfn) — then calls `__ta_from_arraylike`. ELSE is the ordinary
  dispatcher, byte-identical to today (Array.of/from, user objects unaffected).
  Gated `noJsHost && ctx.taCtorTypeIdx >= 0`, so host/gc and TA-free modules are
  byte-inert.

Flipped (12): of/{new-instance-empty, new-instance, nan-conversion}, from/
{new-instance-empty, new-instance-without-mapfn, new-instance-with-mapfn,
new-instance-from-zero, new-instance-from-ordinary-object,
new-instance-from-sparse-array, nan-conversion, mapfn-arguments} + the
`TypedArray/of/new-instance` twin. Verified: tests/issue-3177-fromof.test.ts
(16/16 — of values/null-coerce/clamp/signed + identity, from array/array-like/
mapfn/(value,index)/undefined-mapfn + identity, Array.of/from non-hijack guard);
scoped suites issue-3177 / issue-2872-ta-dynview-reduce-includes green (the
pre-existing `[[Delete]]` row excepted).

Deferred (documented boundary — NOT this slice):

- **Iterable (non-array-like) source** — `TA.from(new Set(…))` reads length 0
  (the `__array_from_iter_n` drain doesn't yet normalize a builtin iterable into
  an indexable carrier); the "true iterable-protocol ctor arm". A test pins the
  current non-crashing behavior.
- **`mapfn-is-not-callable` TypeError** — needs a finalize-fill IsCallable check
  (`buildClosureRefTestArms`, reserve-then-fill like `__bind_dyn`); a
  non-callable mapfn currently traps rather than throwing TypeError.
- **`this`-as-ctor / custom-ctor** rows (`new-instance-using-custom-ctor`,
  `custom-ctor-returns-smaller-instance-throws`) — need `.of`/`.from` to honor a
  caller-supplied `this` constructor (species-style).
- **Reflective `%TypedArray%.{of,from}.{length,name}` + `prop-desc`** (6 rows) —
  a different mechanism (reflective descriptor synthesis over the intrinsic
  method), not construction.

### Remaining (next slices — release+reclaim per phase)

- ~~**Ctor-arg protocol throws**~~ — DONE in slice 2 (above), EXCEPT the
  `Object.getPrototypeOf(ta) === TA.prototype` identity part (moved to the
  "found while probing" list — it is a proto-graph mechanism, not a throw)
  and the static-lane parity noted there.
- ~~**Descriptor MOP arms**~~ — DONE in slice 4 (above). #2984 coordination
  note: no in-flight #2984 PR existed at implementation time (its GOPD
  builtin-key slice had landed); the arms EXTEND the #2984/#2965 natives
  (`__getOwnPropertyDescriptor`/`__defineProperty_*`) per the anti-bloat
  directive — no parallel descriptor path was created.
- ~~**Expando side-table**~~ — DONE in slice 4 (above; field is
  `mut externref`, not `ref null $Object`, avoiding an `$Object` type
  dependency at dyn-view registration). Residual: `__object_keys` expando
  enumeration (see slice-4 residuals).
- **BigInt kinds** (~150 rows, everything `*-bigint`/`BigInt`): BigInt64/
  BigUint64 need i64 elements + ToBigInt — gated on the #1349/#1644
  i64-brand ValType decision; NOT schedulable until that ADR lands.
- **from/of statics** (~50 non-bigint rows) — on the intrinsic ctor
  objects (#2901).
- **Reflect.construct standalone** (47 CE) — #1472 Phase C class;
  `custom-proto-access-throws` observability depends on it.
- Vacuous harness-callback residue (~19, #2940 class);
  `Reflect.set` with explicit receiver CE (8).

### Deferred to follow-ons (file at PR time)

- `Reflect.construct` standalone (47 CE) + `custom-proto-access-throws`
  observability; `%TypedArray%.from/of` statics (75 fails); true
  iterable-protocol ctor arm; static literal `new TA(len)` ToIndex
  validation asymmetry (explore finding); BigInt64/BigUint64
  `.prototype` static-read CE (10); vacuous-callback residue (#2940 class).

### Hazards

- Type-index stability: register new natives/fields late+once (memory
  `project_type_index_shift_and_deadelim`, `reference_subview_type_idx_stability`).
- Never alias one Instr[] into two arms (`reference_shared_instr_object_dce_double_remap`).
- Broad-impact class: `Int8Array`-as-value / MOP natives are wide — validate
  via full CI + merge_group, not scoped sweeps
  (`project_broad_impact_validate_full_ci`); standalone floor only on
  merge_group.
- #2872 owns `built-ins/TypedArray/prototype/` arms — its branch tip is
  already an ancestor of main (no unlanded divergence, verified 2026-07-16);
  shared dyn-view plumbing edits are additive prepended arms only.

## Problem

**356 host-pass tests are not host-free-standalone passes** under
`built-ins/TypedArrayConstructors/` (331 fail + 25 CE; measured 2026-07-12
lane-baseline diff, method in #3169). This is the "TypedArray internals ~350
— next-largest single slice" follow-on the #3027 triage recommended, distinct
from the in-flight #2872 (which owns `built-ins/TypedArray/prototype/` — do
NOT touch those paths here; coordinate with the #2872 owner on shared view
plumbing).

Breakdown: `internals/` 115 (HasProperty/Get/Set/DefineOwnProperty/Delete/
OwnPropertyKeys over integer-indexed receivers, mostly detached-buffer +
non-numeric-key arms), `ctors-bigint/` 57 + `ctors/` 53 (buffer-arg /
object-arg / length-arg constructor protocols: `custom-proto-access-throws`,
iterator-vs-arraylike, `ToIndex` on length/offset, species/newTarget proto
lookup), `from/` 35 + `of/` 18 (statics over the intrinsic ctor objects
from #2901), `prototype/` 30 + per-ctor identity rows
(`Uint16Array/prototype/constructor.js`-style
`Object.getPrototypeOf(...)`/`.constructor` asserts).

Measured signatures: `TypeError: Cannot access property on null or undefined`
(30+, the internals arms fall off the dynamic reader), `illegal cast [in
__closure_N ← assert_throws …]` (17+, throw-path closures over the view),
`Object method called on null or undefined`, destructure-null, and plain
wrong-value asserts on prototype identity.

## ANTI-BLOAT directive

- The substrate EXISTS and this slice must compose it, not fork it:
  - `$__ta_dyn_view` + runtime-kind element codec (#3057,
    `src/codegen/array-methods.ts` `emitTaDynViewToVec`) for the
    integer-indexed `[[Get]]/[[Set]]/[[HasProperty]]` arms — extend the codec
    arms with the detached-buffer + canonical-numeric-key spec steps
    (`internals/*/detached-buffer-key-is-not-number.js` etc.).
  - the distinct view brand (#2893) for receiver checks.
  - the intrinsic ctor objects + getPrototypeOf chain (#2901) for identity,
    `from`/`of` statics, and `custom-proto-access-throws` (newTarget
    `.prototype` Get must be observable/throwing).
  - descriptor arms via the builtin-descriptor MOP lineage (#2984/#2965) —
    table/arms extensions, not a parallel descriptor path.
- BigInt ctors coerce via `ToBigInt`; the 25 CE rows are compile-time
  refusals that should route into the same dynamic-view arms rather than CE.

## Acceptance criteria

- ≥240 of the 356 measured gap tests under
  `built-ins/TypedArrayConstructors/` flip to host-free standalone passes.
- Sample tests:
  - `test/built-ins/TypedArrayConstructors/internals/HasProperty/detached-buffer-key-is-not-number.js`
  - `test/built-ins/TypedArrayConstructors/ctors/buffer-arg/custom-proto-access-throws.js`
  - `test/built-ins/TypedArrayConstructors/Uint16Array/prototype/constructor.js`
- Zero host-mode regressions; zero standalone high-water regressions; no
  edits under the `built-ins/TypedArray/prototype/`-serving method arms
  without syncing with #2872's owner.
- Horizon L: if the internals arms + ctor protocols land but `from`/`of`
  residual >50 tests remains, split a follow-on instead of one mega-PR.
