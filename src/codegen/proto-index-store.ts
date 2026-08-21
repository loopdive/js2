// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4160, generalized by #4176) Prototype-PROPERTY store for `--target
 * standalone` — the runtime substrate that makes a property written onto a
 * builtin prototype object (`Object.prototype` / `Array.prototype` /
 * `Function.prototype` / …) VISIBLE through the prototype chain.
 *
 * ## The gap this closes (measured — #4159 architect-spec probes P2/P3; #4176
 * ## probes pA1-pA3)
 *
 * In standalone, a builtin `.prototype` evaluates to the `$NativeProto` glue
 * singleton (native-proto.ts) — NOT a `$Object` — so BOTH
 * `Object.prototype[1] = 111` (#4160) and `Function.prototype.value = "x"` /
 * `Object.prototype.zzz = 1` (#4176) routed into `__extern_set`'s
 * non-`$Object` miss arm and landed NOWHERE. And the read chokepoints
 * answered OWN-ONLY, so even with a store the inherited property stayed
 * invisible to instance receivers (`funObj.value`, `({}).zzz`,
 * `arrObj.enumerable` — the dominant §8.10.5 "inherited descriptor field"
 * test262 idiom).
 *
 * ## The mechanism (mirrors the host lane's ratified `_protoIndexHas` /
 * `_protoIndexGet`, src/runtime.ts:409/417, widened per-brand)
 *
 * A lazily-minted per-BRAND table of `$Object` COMPANIONS (`(array (mut
 * externref))`, one slot per `BUILTIN_BRAND_TABLE` entry) holds the
 * prototype-installed properties. Everything delegates to the existing
 * `$Object` machinery (`__new_plain_object`, `__obj_find`, `__extern_set`,
 * `__defineProperty_*`), never re-implements it:
 *
 *  - WRITE arms (finalize-spliced, substitution-by-recursion — the #4161
 *    `closureBagSubstitutionArm` idea): `__extern_set` /
 *    `__defineProperty_value` / `__defineProperty_accessor` get a prepended
 *    `$NativeProto`-brand arm. A builtin-branded receiver whose key is a
 *    string (or number — #4176 dropped #4160's canonical-integer-only gate;
 *    the named form was a silent no-op before, so participation only converts
 *    no-ops into stores) re-targets the call at the brand's companion
 *    (minting it on first write) and RECURSES, so the whole existing
 *    machinery (accessor-set gate, #2042-S4 preflight, flag translation,
 *    frozen checks) applies unchanged. Symbol/object keys and non-builtin
 *    brands fall through byte-unchanged (object keys are deliberately not
 *    ToPrimitive'd here — the fall-through coerces them exactly once).
 *  - READ fallbacks: the chokepoints consult the companions only after every
 *    own/chain probe missed. Consult order is the receiver's implicit chain:
 *    its own proto brand first (`__protoidx_brand_off` classifies the
 *    receiver — vec ⇒ Array, closure ⇒ Function, `__StandaloneRegExp` ⇒
 *    RegExp, `__Date` ⇒ Date, `$Error_struct` ⇒ Error, a `$NativeProto`
 *    receiver ⇒ its OWN brand for direct proto reads), then the implicit
 *    chain end `Object.prototype`. Sites: `__extern_get` / `__extern_has` at
 *    their terminal proto-walk miss, the `__extern_has` non-`$Object`
 *    bag-miss, `__closure_prop_get` / `__vec_prop_get` at their miss tails,
 *    the `$__vec_base` arms on OOB, and the closed-struct arms on
 *    field-ladder miss. Presence is value-independent (§7.3.12); Get invokes
 *    a companion accessor with the ORIGINAL receiver bound as `this`
 *    (§6.2.5.5) via `__call_accessor_get`.
 *
 * ## Gate — `ctx.standalone && (ctx.protoIndexDirty || ctx.protoNamedDirty)`;
 * ## byte-identity by construction
 *
 * Both flags are PRE-SCAN flags (array-holes.ts, set before any body compiles
 * — #4128/#4176), so the reserve below simply never runs for a clean module:
 * no globals, no helpers, and every consult site resolves
 * `funcMap.get(...) === undefined` and emits its exact pre-existing
 * instructions. `protoNamedDirty` is deliberately SEPARATE from
 * `protoIndexDirty` so a named polyfill write (`String.prototype.foo = …`)
 * reserves the store WITHOUT disabling the HOF hole visit-skip / typed
 * element lanes that key on `protoIndexDirty` (named keys can never be
 * inherited integer indices). Host/gc output is additionally untouched
 * because the reserve is standalone-gated.
 *
 * ## Reserve-then-fill (the established funcIdx discipline)
 *
 * The helpers are reserved as typed stubs from `ensureObjectRuntime` BEFORE
 * the `__extern_*` bodies bake their `call <idx>` (the vec-props /
 * closure-props pattern); bodies are filled at FINALIZE
 * (`fillProtoIndexStore`), when `$NativeProto` + the builtin brands + every
 * dependency funcIdx are known and resolvable from `funcMap`. Spliced arms
 * append locals only (never renumber) and build fresh Instr objects per use
 * (the shared-instr double-remap hazard,
 * `reference_shared_instr_object_dce_double_remap`).
 *
 * ## Known boundaries (deliberate, recorded)
 *
 *  - `Object.defineProperties(Object.prototype, {...})` (the PLURAL form) is
 *    not armed — its receiver head keeps the lenient no-op for a
 *    `$NativeProto`, as before. The singular forms (the test262-dominant
 *    shapes) are covered.
 *  - A companion SETTER invoked via the `__extern_set` recursion receives the
 *    companion (not the proto object) as `this` — the same receiver
 *    approximation the delegation buys everywhere else on the write side.
 *    The GET side does bind the spec receiver (see `__protoidx_get_k`).
 *  - In-bounds vec HOLES still answer present/undefined (dense carriers; a
 *    `$Hole`-aware Has/Get is #2001/#3185 scope, not widened here).
 *  - A name stored on a companion never overrides a BUILTIN member read
 *    (`Array.prototype.push = polyfill` stays invisible to `arr.push`): the
 *    builtin-member arms answer before the terminal miss, exactly as before
 *    this store existed. Same-as-before, not worse.
 *  - Chain depth is 2 (`brand → Object.prototype`). The Error-subclass
 *    3-level chain (`TypeError.prototype → Error.prototype → Object.prototype`)
 *    resolves the subclass brand then Object — the middle hop is a measured
 *    follow-up if it ever surfaces.
 */
import { inheritedSetAnyDirty } from "./inherited-set-gate.js"; // (#4602) per-key #4504 gate
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { BUILTIN_BRAND_BASE, BUILTIN_BRAND_COUNT, builtinBrandOffsetOf } from "./builtin-brands.js";
import { nativeStringLiteralInstrs } from "./native-strings.js"; // (#4176) wrapper-slot key at FILL time
import { nativeProtoSeedersByBrandOffset } from "./native-proto.js"; // (#2175 V2-S3b-1) companion seeding
import { addFuncType } from "./registry/types.js";

/** Reserved helper names (all internal, never exported from the module). */
const PROTOIDX_COMPANION = "__protoidx_companion";
const PROTOIDX_NORM_KEY = "__protoidx_norm_key";
const PROTOIDX_HAS_K = "__protoidx_has_k";
const PROTOIDX_GET_K = "__protoidx_get_k";
const PROTOIDX_HAS_F = "__protoidx_has_f";
const PROTOIDX_GET_F = "__protoidx_get_f";
/** (#4176) receiver-brand classifier + receiver-aware consult pair. */
const PROTOIDX_BRAND_OFF = "__protoidx_brand_off";
const PROTOIDX_FORIN_PUSH = "__protoidx_forin_push";
const PROTOIDX_HAS_R = "__protoidx_has_r";
const PROTOIDX_GET_R = "__protoidx_get_r";
/** (#4504) Receiver-aware inherited [[Set]] descriptor decision. */
const PROTOIDX_SET_R = "__protoidx_set_r";
/** (#2175 P2) own-view receiver substitution: `$NativeProto` → its companion. */
const PROTOIDX_OWN_RECV = "__protoidx_own_recv";

/** Static brand OFFSETS (0-based slots in the brand band — native-proto.ts). */
const OBJ_OFF = builtinBrandOffsetOf("Object")!;
const ARR_OFF = builtinBrandOffsetOf("Array")!;
const FUN_OFF = builtinBrandOffsetOf("Function")!;
const REGEXP_OFF = builtinBrandOffsetOf("RegExp")!;
const DATE_OFF = builtinBrandOffsetOf("Date")!;
const ERROR_OFF = builtinBrandOffsetOf("Error")!;
const STRING_OFF = builtinBrandOffsetOf("String")!;
const NUMBER_OFF = builtinBrandOffsetOf("Number")!;
const BOOLEAN_OFF = builtinBrandOffsetOf("Boolean")!;

/**
 * (#4176) The boxed-primitive wrapper internal-slot key — MUST equal
 * `WRAPPER_PRIMITIVE_KEY` in object-runtime.ts (not imported: object-runtime
 * imports this module, and a value import back would close an ESM cycle).
 * A standalone wrapper (`new String()` …) is a plain `$Object` carrying its
 * [[StringData]]/[[NumberData]]/[[BooleanData]] under this key, so the brand
 * classifier recovers the wrapper's prototype brand from the slot value's box
 * type.
 */
const WRAPPER_PRIMITIVE_KEY = "[[PrimitiveValue]]";

/** `$PropEntry` field indices (object-runtime.ts layout — value/flags/get). */
const ENTRY_VALUE = 1;
const ENTRY_FLAGS = 2;
const ENTRY_GET = 4;
const ENTRY_SET = 5;
/** `$PropEntry.$flags` accessor bit (object-runtime.ts `FLAG_ACCESSOR`). */
const FLAG_ACCESSOR = 0x08;
/** `$PropEntry.$flags` writable bit (object-runtime.ts `FLAG_WRITABLE`). */
const FLAG_WRITABLE = 0x01;
/** `$Object.flags` frozen bit (object-runtime.ts `OBJ_FLAG_FROZEN`). */
const OBJ_FLAG_FROZEN = 0x04;
/** i31 abstract heap type (signed LEB -20) — small-int boxed numbers (#3673). */
const I31_HEAP_TYPE = -20;

/** Shared four-state internal [[Set]] decision ABI. */
export const SET_DECISION_MISS = 0;
export const SET_DECISION_ALLOW_OWN = 1;
export const SET_DECISION_HANDLED = 2;
export const SET_DECISION_REFUSED = 3;

/**
 * Reserve the proto-property-store table global + helper stubs. Called from
 * `ensureObjectRuntime` right after the closure/vec side-table reserves,
 * BEFORE the `__extern_*` bodies bake their `call <idx>`. Self-gated on
 * `ctx.standalone && (ctx.protoIndexDirty || ctx.protoNamedDirty)` (see
 * module header) and idempotent. Appends types/globals/funcs only — never
 * shifts an existing index.
 */
export function reserveProtoIndexStore(ctx: CodegenContext): void {
  // (#2175 V2-S3b-1) `protoMemberDirty` arms the store for the READ-ONLY
  // reflective case. Both older flags are write-shaped pre-scans, so a program
  // that only reads a builtin proto through a runtime value (the dominant
  // test262 reflection idiom) reserved nothing and every consult site emitted
  // its pre-existing miss.
  if (!ctx.standalone || !(ctx.protoIndexDirty || ctx.protoNamedDirty || ctx.protoMemberDirty)) return;
  if (ctx.protoIndexStoreReserved) return;
  ctx.protoIndexStoreReserved = true;

  // --- $__protoidx_carr: (array (mut externref)) — the per-brand table ---
  const arrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "array", name: "__protoidx_carr", element: { kind: "externref" }, mutable: true });
  ctx.protoIndexCompanionsArrTypeIdx = arrTypeIdx;

  // --- companion table global: (mut ref null $__protoidx_carr) = null ---
  const tableGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__protoidx_companions",
    type: { kind: "ref_null", typeIdx: arrTypeIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: arrTypeIdx }],
  });
  ctx.protoIndexCompanionsGlobalIdx = tableGlobalIdx;

  // --- helper stubs (bodies filled by fillProtoIndexStore at finalize).
  // Stub bodies are FRESH arrays per helper — never a shared Instr list.
  const reserve = (name: string, params: ValType[], results: ValType[], stub: () => Instr[]): void => {
    if (ctx.funcMap.get(name) !== undefined) return;
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const placeholder: WasmFunction = { name, typeIdx, locals: [], body: stub(), exported: false };
    pushDefinedFunc(ctx, funcIdx, placeholder);
    ctx.funcMap.set(name, funcIdx);
  };
  const ext: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const nullExt = (): Instr[] => [{ op: "ref.null.extern" }];
  const zero = (): Instr[] => [{ op: "i32.const", value: 0 }];
  const objOff = (): Instr[] => [{ op: "i32.const", value: OBJ_OFF }];
  // (which: brand OFFSET, create: 0/1) -> companion externref (null when
  // absent and create=0).
  reserve(PROTOIDX_COMPANION, [i32, i32], [ext], nullExt);
  // Key normalizer: string key -> itself; boxed-number / i31 key -> its
  // decimal string; null-extern when the key does not participate (symbol /
  // object — deliberately untouched so no user ToPrimitive ever runs twice).
  reserve(PROTOIDX_NORM_KEY, [ext], [ext], nullExt);
  // (key, firstOff) -> 1 iff the firstOff or Object companion carries the key
  // (§7.3.12 — presence only, value-independent).
  reserve(PROTOIDX_HAS_K, [ext, i32], [i32], zero);
  // (origRecv, key, firstOff) -> [[Get]] through the companions: data value,
  // accessor invoked with origRecv as `this`, or the undefined miss.
  reserve(PROTOIDX_GET_K, [ext, ext, i32], [ext], nullExt);
  // f64-index conveniences for the numeric chokepoints (canonicalise via
  // number_toString — a non-integer index stringifies to "1.5" and misses).
  reserve(PROTOIDX_HAS_F, [f64, i32], [i32], zero);
  reserve(PROTOIDX_GET_F, [ext, f64, i32], [ext], nullExt);
  // (#4176) receiver classifier: externref -> the brand OFFSET of the
  // receiver's implicit prototype (vec ⇒ Array, closure ⇒ Function, …,
  // default ⇒ Object; a $NativeProto receiver answers its OWN brand so
  // direct proto reads see their own companion first).
  reserve(PROTOIDX_BRAND_OFF, [ext], [i32], objOff);
  // Append enumerable keys from the receiver's implicit builtin prototype
  // companion to an in-progress for-in snapshot. The third argument is the
  // caller's shadow set, already populated from ordinary prototype levels.
  reserve(PROTOIDX_FORIN_PUSH, [ext, ext, ext], [], () => []);
  // (#4176) receiver-aware consults for the non-$Object miss chokepoints.
  reserve(PROTOIDX_HAS_R, [ext, ext], [i32], zero);
  reserve(PROTOIDX_GET_R, [ext, ext], [ext], nullExt);
  // (#4504) `(origRecv, key, value) -> decision` over the receiver-aware
  // native-prototype companions.  It never creates a companion while deciding.
  // This helper is deliberately absent from descriptor-free modules so the
  // existing proto-store function space remains byte-identical.
  if (inheritedSetAnyDirty(ctx)) {
    reserve(PROTOIDX_SET_R, [ext, ext, ext], [i32], zero);
  }
  // (#2175 P2) `recv -> recv'` for the OWN-property views: a `$NativeProto`
  // receiver becomes its brand companion, everything else passes through.
  // Reserved as a stub that RETURNS ITS ARGUMENT, so an unfilled body is an
  // exact no-op; the real body is filled at FINALIZE, where
  // `ctx.nativeProtoTypeIdx` is final. Baking that type index at registration
  // time is what shipped invalid Wasm in the first cut of P2 — a later type
  // registration shifted indices and the `ref.test` ended up naming a type
  // outside the `any` hierarchy (`CompileError: … has to be in the same
  // reference type hierarchy as (ref 59)`, reproduced on an accessor
  // descriptor over `Array.prototype`). Every other arm in this module already
  // resolves that index at fill time; this one now matches them structurally so
  // the split cannot be reintroduced.
  reserve(PROTOIDX_OWN_RECV, [ext], [ext], () => [{ op: "local.get", index: 0 }]);
}

/**
 * Append the receiver brand's enumerable prototype-companion keys to the
 * in-progress for-in vector. `seenLocal` is the `$Object` shadow set maintained
 * by `__object_keys_forin`; the helper also checks receiver own properties so
 * non-`$Object` carrier bags and builtin-function own names cannot duplicate or
 * expose a shadowed prototype key.
 */
export function protoIndexForInPushInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  vecLocal: number,
  seenLocal: number,
): Instr[] {
  const pushIdx = ctx.funcMap.get(PROTOIDX_FORIN_PUSH);
  if (pushIdx === undefined) return [];
  return [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: vecLocal },
    { op: "local.get", index: seenLocal },
    { op: "call", funcIdx: pushIdx },
  ];
}

/**
 * (#4176) Receiver-aware GET consult `[recv, key] -> externref` for a
 * non-`$Object` miss chokepoint (`__closure_prop_get` / `__vec_prop_get`
 * tails): classifies the receiver's proto brand at runtime and consults that
 * companion, then Object's. `undefined` when unreserved — the caller keeps
 * its pre-existing miss byte-identically.
 */
export function protoIndexRecvGetMissInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  keyLocal: number,
): Instr[] | undefined {
  const getRIdx = ctx.funcMap.get(PROTOIDX_GET_R);
  if (getRIdx === undefined) return undefined;
  return [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: getRIdx },
  ];
}

/**
 * (#4504) Receiver-aware native-companion [[Set]] decision.
 *
 * The caller reaches this only after its explicit `$Object` / fnctor chain
 * exhausted.  A live descriptor returns one of the non-MISS states immediately,
 * so a nearer writable data descriptor cannot fall through to a farther Object
 * companion accessor.
 */
export function protoIndexSetDecisionInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  keyLocal: number,
  valueLocal: number,
): Instr[] | undefined {
  const setRIdx = ctx.funcMap.get(PROTOIDX_SET_R);
  if (setRIdx === undefined) return undefined;
  return [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: keyLocal },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: setRIdx },
  ];
}

/**
 * (#2175 P2) OWN-LAYER receiver substitution for the own-property views.
 *
 * An entry written by `Object.defineProperty(<Builtin>.prototype, k, d)` lives
 * in the brand COMPANION (the write arms below re-target and recurse), and
 * #4176 wired the companion into `__extern_get` / `__extern_has` only. So a
 * read and `in` see it while `hasOwnProperty` and `getOwnPropertyDescriptor`
 * answer false/undefined — measured on `Date.prototype` and `Object.prototype`
 * alike (`.tmp/p5.js`), for both syntactic and flowing receivers.
 *
 * This rewrites `recvParam` IN PLACE: when the receiver is a `$NativeProto`
 * whose companion exists, the param is replaced by the companion `$Object`, and
 * the caller's existing `$Object` path then runs unchanged. Substitution rather
 * than a bespoke probe is what makes the descriptor correct for free — the
 * companion entry is an ordinary `$PropEntry` whose flags the write arm already
 * populated (`__defineProperty_value` recursion passes the caller's flag word
 * straight through), so gOPD reads real writable/enumerable/configurable bits
 * instead of synthesized ones.
 *
 * OWN-ONLY, deliberately: `__protoidx_brand_off` answers a `$NativeProto`'s OWN
 * brand, and this uses `create = 0` and performs **no chain walk**. An ordinary
 * object is left untouched (the `ref.test` fails), so `hasOwnProperty` cannot
 * start reporting inherited keys.
 *
 * Emits nothing when the store is unreserved — callers keep their exact bytes.
 */
export function protoIndexOwnViewSubstituteInstrs(ctx: CodegenContext, recvParam: number): Instr[] {
  const ownRecvIdx = ctx.funcMap.get(PROTOIDX_OWN_RECV);
  if (ownRecvIdx === undefined) return [];
  // NO type index is baked here: the helper owns the `ref.test`, and its body is
  // written at FINALIZE. That is the whole point — see the reserve site. It also
  // means the caller needs no scratch local.
  return [
    { op: "local.get", index: recvParam },
    { op: "call", funcIdx: ownRecvIdx },
    { op: "local.set", index: recvParam },
  ];
}

/**
 * FINALIZE — fill `__protoidx_own_recv`. `ctx.nativeProtoTypeIdx` is read HERE,
 * where it is final, exactly as `fillBrandOffBody` does. Leaving the reserved
 * identity stub in place is a correct no-op, so a module without the
 * `$NativeProto` type or the companion helpers simply keeps pass-through
 * behaviour.
 */
function fillOwnRecvBody(ctx: CodegenContext): void {
  const fn = findFn(ctx, PROTOIDX_OWN_RECV);
  if (!fn) return;
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  const brandOffIdx = ctx.funcMap.get(PROTOIDX_BRAND_OFF);
  const companionIdx = ctx.funcMap.get(PROTOIDX_COMPANION);
  if (npTypeIdx === undefined || brandOffIdx === undefined || companionIdx === undefined) return;
  // params: 0=recv ; locals: 1=companion
  fn.locals = [{ name: "c", type: { kind: "externref" } }];
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: npTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: brandOffIdx },
        { op: "i32.const", value: 0 }, // own-layer probe: never mint here
        { op: "call", funcIdx: companionIdx },
        { op: "local.tee", index: 1 },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          // Substitute ONLY when a companion exists. A brand nobody ever wrote
          // to has none (create = 0 above), and the receiver must pass through
          // so the caller's existing arms behave exactly as before.
          then: [{ op: "local.get", index: 1 }, { op: "return" }],
        },
      ],
    },
    { op: "local.get", index: 0 },
  ];
}

/** (#4176) Receiver-aware HAS consult `[recv, key] -> i32`; see get twin. */
export function protoIndexRecvHasMissInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  keyLocal: number,
): Instr[] | undefined {
  const hasRIdx = ctx.funcMap.get(PROTOIDX_HAS_R);
  if (hasRIdx === undefined) return undefined;
  return [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: keyLocal },
    { op: "call", funcIdx: hasRIdx },
  ];
}

/**
 * Numeric-index consult `[idx, firstOff] -> i32` for the `$__vec_base` /
 * closed-struct Has arms. `consultArray` keeps its legacy 0/1 signature at
 * the call sites and is translated to a brand offset here. `undefined` when
 * unreserved.
 */
export function protoIndexHasIdxInstrs(
  ctx: CodegenContext,
  idxLocal: number,
  consultArray: 0 | 1,
): Instr[] | undefined {
  const hasFIdx = ctx.funcMap.get(PROTOIDX_HAS_F);
  if (hasFIdx === undefined) return undefined;
  return [
    { op: "local.get", index: idxLocal },
    { op: "i32.const", value: consultArray ? ARR_OFF : OBJ_OFF },
    { op: "call", funcIdx: hasFIdx },
  ];
}

/**
 * Numeric-index consult `[recv, idx, firstOff] -> externref` for the Get
 * miss points of the vec / closed-struct arms. `undefined` when unreserved.
 */
export function protoIndexGetIdxMissInstrs(
  ctx: CodegenContext,
  recvLocal: number,
  idxLocal: number,
  consultArray: 0 | 1,
): Instr[] | undefined {
  const getFIdx = ctx.funcMap.get(PROTOIDX_GET_F);
  if (getFIdx === undefined) return undefined;
  return [
    { op: "local.get", index: recvLocal },
    { op: "local.get", index: idxLocal },
    { op: "i32.const", value: consultArray ? ARR_OFF : OBJ_OFF },
    { op: "call", funcIdx: getFIdx },
  ];
}

/** Everything the finalize fill needs; null when some dependency is absent. */
interface ProtoIndexFillDeps {
  objectTypeIdx: number;
  propEntryTypeIdx: number;
  propMapTypeIdx: number;
  companionIdx: number;
  newPlainObjectIdx: number;
  objFindIdx: number;
  unboxNumberIdx: number;
  numberToStringIdx: number;
  callAccessorGetIdx: number;
  callAccessorSetIdx: number;
  tableGlobalIdx: number;
  tableArrTypeIdx: number;
}

function resolveFillDeps(ctx: CodegenContext): ProtoIndexFillDeps | null {
  const types = ctx.objectRuntimeTypes;
  if (!types) return null;
  const companionIdx = ctx.funcMap.get(PROTOIDX_COMPANION);
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const unboxNumberIdx = ctx.funcMap.get("__unbox_number");
  const numberToStringIdx = ctx.funcMap.get("number_toString");
  const callAccessorGetIdx = ctx.funcMap.get("__call_accessor_get");
  const callAccessorSetIdx = ctx.funcMap.get("__call_accessor_set");
  const tableGlobalIdx = ctx.protoIndexCompanionsGlobalIdx;
  const tableArrTypeIdx = ctx.protoIndexCompanionsArrTypeIdx;
  if (
    companionIdx === undefined ||
    newPlainObjectIdx === undefined ||
    objFindIdx === undefined ||
    unboxNumberIdx === undefined ||
    numberToStringIdx === undefined ||
    callAccessorGetIdx === undefined ||
    callAccessorSetIdx === undefined ||
    tableGlobalIdx === undefined ||
    tableArrTypeIdx === undefined
  ) {
    return null;
  }
  return {
    objectTypeIdx: types.objectTypeIdx,
    propEntryTypeIdx: types.propEntryTypeIdx,
    propMapTypeIdx: types.propMapTypeIdx,
    companionIdx,
    newPlainObjectIdx,
    objFindIdx,
    unboxNumberIdx,
    numberToStringIdx,
    callAccessorGetIdx,
    callAccessorSetIdx,
    tableGlobalIdx,
    tableArrTypeIdx,
  };
}

function findFn(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const idx = ctx.funcMap.get(name);
  return idx === undefined ? undefined : definedFuncAt(ctx, idx);
}

/**
 * FINALIZE — fill the reserved helper bodies and splice the `$NativeProto`
 * write/read arms, all funcIdx/typeIdx resolved NOW from `funcMap`/ctx (the
 * `fillExternArrayLikeStructArms` discipline). Idempotent. No-op unless
 * `reserveProtoIndexStore` ran (flag-set standalone modules only).
 */
export function fillProtoIndexStore(ctx: CodegenContext): void {
  if (!ctx.protoIndexStoreReserved || ctx.protoIndexStoreFilled) return;
  ctx.protoIndexStoreFilled = true;
  const deps = resolveFillDeps(ctx);
  if (!deps) return; // dependencies absent — stubs keep answering "miss" (safe)

  fillCompanionBody(ctx, deps);
  fillNormKeyBody(ctx, deps);
  fillHasKBody(ctx, deps);
  fillGetKBody(ctx, deps);
  if (inheritedSetAnyDirty(ctx)) fillSetRBody(ctx, deps);
  fillHasFBody(ctx, deps);
  fillGetFBody(ctx, deps);
  fillBrandOffBody(ctx);
  fillForInPushBody(ctx, deps);
  fillRecvConsultBodies(ctx);
  fillOwnRecvBody(ctx); // (#2175 P2) own-view substitution — type idx resolved HERE
  spliceNativeProtoWriteArms(ctx);
  spliceNativeProtoDirectReadArms(ctx);
}

/**
 * `__protoidx_forin_push(recv, vec, seen) -> void` — enumerate the receiver's
 * first implicit builtin-prototype companion. The ordinary for-in helper owns
 * the snapshot and shadow set; this adapter only exposes the companion through
 * that same backend-neutral runtime ABI, so prepared IR and legacy emission
 * cannot diverge.
 */
function fillForInPushBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_FORIN_PUSH);
  const brandOffIdx = ctx.funcMap.get(PROTOIDX_BRAND_OFF);
  const objectHasOwnIdx = ctx.funcMap.get("__object_hasOwn");
  const objOrderedIdx = ctx.funcMap.get("__obj_ordered");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (
    !fn ||
    brandOffIdx === undefined ||
    objectHasOwnIdx === undefined ||
    objOrderedIdx === undefined ||
    objVecPushIdx === undefined
  ) {
    return;
  }

  const objectRefNull: ValType = { kind: "ref_null", typeIdx: deps.objectTypeIdx };
  const propMapRef: ValType = { kind: "ref_null", typeIdx: deps.propMapTypeIdx };
  const entryRefNull: ValType = { kind: "ref_null", typeIdx: deps.propEntryTypeIdx };
  // params: 0=recv 1=vec 2=seen ; locals: 3=off 4=companion 5=o 6=arr
  // 7=cap 8=i 9=entry 10=key
  fn.locals = [
    { name: "off", type: { kind: "i32" } },
    { name: "companion", type: { kind: "externref" } },
    { name: "o", type: objectRefNull },
    { name: "arr", type: propMapRef },
    { name: "cap", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "entry", type: entryRefNull },
    { name: "key", type: { kind: "externref" } },
  ];
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: brandOffIdx },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 3 },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: deps.companionIdx },
    { op: "local.tee", index: 4 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "return" }],
    },
    { op: "local.get", index: 4 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: deps.objectTypeIdx },
    { op: "local.tee", index: 5 },
    { op: "call", funcIdx: objOrderedIdx },
    { op: "local.tee", index: 6 },
    { op: "array.len" },
    { op: "local.set", index: 7 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 8 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: 8 },
            { op: "local.get", index: 7 },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 6 },
            { op: "ref.as_non_null" },
            { op: "local.get", index: 8 },
            { op: "array.get", typeIdx: deps.propMapTypeIdx },
            { op: "local.tee", index: 9 },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: 9 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: 0 },
            { op: "extern.convert_any" },
            { op: "local.set", index: 10 },
            // A receiver own key or a closer ordinary-prototype key shadows
            // this inherited companion key, regardless of enumerability.
            { op: "local.get", index: 0 },
            { op: "local.get", index: 10 },
            { op: "call", funcIdx: objectHasOwnIdx },
            { op: "local.get", index: 2 },
            { op: "local.get", index: 10 },
            { op: "call", funcIdx: objectHasOwnIdx },
            { op: "i32.or" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "local.get", index: 10 },
                { op: "call", funcIdx: objVecPushIdx },
              ],
            },
            { op: "local.get", index: 8 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 8 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/**
 * `__protoidx_companion(whichOff, create) -> externref` — the lazily-minted
 * per-brand store. The table array itself is minted on the first CREATE
 * (reads on a null table answer null without allocating).
 */
function fillCompanionBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_COMPANION);
  if (!fn) return;
  const arrRefNull: ValType = { kind: "ref_null", typeIdx: deps.tableArrTypeIdx };
  // params: 0=whichOff 1=create ; locals: 2=arr 3=c
  fn.locals = [
    { name: "arr", type: arrRefNull },
    { name: "c", type: { kind: "externref" } },
  ];
  fn.body = [
    // (#2175 V2-S3b-1) A brand with a SEEDER always materializes its companion,
    // even on a pure read. Both read probes (`__protoidx_get_k` /
    // `__protoidx_has_k`) call in with `create = 0` — correct for #4176, where a
    // companion only exists once the program has WRITTEN to that prototype, so
    // "absent slot" genuinely means "nothing stored". A seeded brand inverts
    // that: its own members are waiting to be installed and the slot is absent
    // only because nobody has asked yet. Forcing `create = 1` for exactly the
    // seeded offsets makes the read paths self-materializing without changing
    // behaviour for any unseeded brand (whose slot keeps its create-on-write
    // rule) — and, because both probes go through here, GET and `in` agree by
    // construction instead of by accident.
    ...buildSeededOffsetForceCreateArms(ctx, 0, 1),
    { op: "global.get", index: deps.tableGlobalIdx },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "ref.null.extern" }, { op: "return" }],
        },
        { op: "i32.const", value: BUILTIN_BRAND_COUNT },
        { op: "array.new_default", typeIdx: deps.tableArrTypeIdx },
        { op: "local.set", index: 2 },
        { op: "local.get", index: 2 },
        { op: "global.set", index: deps.tableGlobalIdx },
      ],
    },
    // c = arr[whichOff]
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 0 },
    { op: "array.get", typeIdx: deps.tableArrTypeIdx },
    { op: "local.set", index: 3 },
    // absent && create → mint a plain $Object companion into the slot
    { op: "local.get", index: 3 },
    { op: "ref.is_null" },
    { op: "local.get", index: 1 },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: deps.newPlainObjectIdx },
        { op: "local.set", index: 3 },
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 3 },
        { op: "array.set", typeIdx: deps.tableArrTypeIdx },
        // (#2175 V2-S3b-1) Seed the fresh companion with the brand's BUILTIN
        // own members, so a `$NativeProto` flowing as a runtime value answers
        // `p.exec` / `TypedArray.prototype.find` through the ordinary consult.
        // Placed AFTER the slot store, which is what makes it re-entrancy-safe:
        // a seeder body calls `__defineProperty_value`/`_accessor`, whose own
        // #4176 write arms can route back into `__protoidx_companion` for the
        // same offset — by then the slot is non-null, so that re-entry takes
        // the cached path instead of minting a second companion and recursing.
        ...buildCompanionSeedArms(ctx, 0, 3),
      ],
    },
    { op: "local.get", index: 3 },
  ];
}

/**
 * (#2175 V2-S3b-1) The brand-offset dispatch that seeds a freshly minted
 * companion: `if (whichOff == <off>) __nativeproto_seed_<brand>(companion)`,
 * one arm per brand whose `$NativeProto` was materialized during codegen.
 *
 * Empty when nothing registered (no arms, no bytes) — which is the case for
 * every module that is not `protoMemberDirty`, so this fill stays
 * byte-identical for them. funcIdx is resolved from `funcMap` HERE, at fill
 * time, never captured at mint time: a late import between the two shifts every
 * defined-func index (#2043), and a stale `call` would silently target the
 * wrong function.
 */
/**
 * (#2175 V2-S3b-1) `if (whichOff == <seededOff>) create = 1` — one arm per
 * seeded brand. Empty (and therefore byte-inert) when no seeder registered.
 */
function buildSeededOffsetForceCreateArms(ctx: CodegenContext, whichOffLocal: number, createLocal: number): Instr[] {
  const seeders = nativeProtoSeedersByBrandOffset(ctx);
  if (seeders.size === 0) return [];
  const arms: Instr[] = [];
  for (const [off, funcName] of seeders) {
    if (ctx.funcMap.get(funcName) === undefined) continue;
    arms.push(
      { op: "local.get", index: whichOffLocal },
      { op: "i32.const", value: off },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: createLocal },
        ],
      },
    );
  }
  return arms;
}

function buildCompanionSeedArms(ctx: CodegenContext, whichOffLocal: number, companionLocal: number): Instr[] {
  const seeders = nativeProtoSeedersByBrandOffset(ctx);
  if (seeders.size === 0) return [];
  const arms: Instr[] = [];
  for (const [off, funcName] of seeders) {
    const funcIdx = ctx.funcMap.get(funcName);
    if (funcIdx === undefined) continue;
    arms.push(
      { op: "local.get", index: whichOffLocal },
      { op: "i32.const", value: off },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: companionLocal },
          { op: "call", funcIdx },
        ],
      },
    );
  }
  return arms;
}

/**
 * `__protoidx_norm_key(key) -> externref` — which keys participate in the
 * store. #4176: string keys participate AS-IS (named-property widening; the
 * #4160 canonical-integer gate protected nothing — a refused key was a
 * silent no-op on the proto singleton, not a store elsewhere). Boxed-number /
 * i31 keys canonicalise via `number_toString` so `p[1]` and `p["1"]` share a
 * slot. Symbols/objects return null-extern (do not participate — the
 * fall-through path coerces object keys exactly once, and running a user
 * `toString` twice would double its side effects).
 */
function fillNormKeyBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_NORM_KEY);
  if (!fn || ctx.anyStrTypeIdx < 0) return;
  const anyStr = ctx.anyStrTypeIdx;
  const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
  // locals: 1=any(anyref)
  fn.locals = [{ name: "any", type: { kind: "anyref" } }];
  const miss = (): Instr[] => [{ op: "ref.null.extern" }, { op: "return" }];
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: anyStr },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
    },
    ...(boxNumTypeIdx >= 0
      ? ([
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: boxNumTypeIdx },
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: I31_HEAP_TYPE },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: deps.unboxNumberIdx },
              { op: "call", funcIdx: deps.numberToStringIdx },
              { op: "return" },
            ],
          },
        ] satisfies Instr[])
      : []),
    ...miss().slice(0, 1), // bare null-extern in tail position
  ];
}

/**
 * Probe one companion (LOOKUP, never ensure — reads must not allocate): if it
 * exists and `__obj_find` answers a live entry for the key, run `hit`.
 * `whichInstrs` pushes the brand offset (a param read or a constant);
 * `cLocal` is an externref scratch local of the enclosing helper.
 */
function companionProbeArm(
  deps: ProtoIndexFillDeps,
  whichInstrs: Instr[],
  keyLocal: number,
  cLocal: number,
  hit: Instr[],
): Instr[] {
  return [
    ...whichInstrs,
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: deps.companionIdx },
    { op: "local.set", index: cLocal },
    { op: "local.get", index: cLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: cLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: deps.objectTypeIdx },
        { op: "local.get", index: keyLocal },
        { op: "call", funcIdx: deps.objFindIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: hit },
      ],
    },
  ];
}

/** `__protoidx_has_k(key, firstOff) -> i32` — §7.3.12 presence. */
function fillHasKBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_HAS_K);
  if (!fn) return;
  // params: 0=key 1=firstOff ; locals: 2=c(externref)
  fn.locals = [{ name: "c", type: { kind: "externref" } }];
  const hit = (): Instr[] => [{ op: "i32.const", value: 1 }, { op: "return" }];
  fn.body = [
    // firstOff companion, then — when firstOff is not Object's — the implicit
    // chain end Object.prototype.
    ...companionProbeArm(deps, [{ op: "local.get", index: 1 }], 0, 2, hit()),
    { op: "local.get", index: 1 },
    { op: "i32.const", value: OBJ_OFF },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: companionProbeArm(deps, [{ op: "i32.const", value: OBJ_OFF }], 0, 2, hit()),
    },
    { op: "i32.const", value: 0 },
  ];
}

/** `__protoidx_get_k(origRecv, key, firstOff) -> externref` — §6.2.5.5 Get. */
function fillGetKBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_GET_K);
  if (!fn) return;
  const entryRefNull: ValType = { kind: "ref_null", typeIdx: deps.propEntryTypeIdx };
  // params: 0=origRecv 1=key 2=firstOff
  // locals: 3=c(externref) 4=e(ref null $PropEntry, default null) 5=getter(externref)
  fn.locals = [
    { name: "c", type: { kind: "externref" } },
    { name: "e", type: entryRefNull },
    { name: "getter", type: { kind: "externref" } },
  ];
  const miss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }];
  const probeInto = (whichInstrs: Instr[]): Instr[] => [
    ...whichInstrs,
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: deps.companionIdx },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 3 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 3 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: deps.objectTypeIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: deps.objFindIdx },
        { op: "local.set", index: 4 },
      ],
    },
  ];
  fn.body = [
    // firstOff companion first (the receiver's own proto brand)…
    ...probeInto([{ op: "local.get", index: 2 }]),
    // …then Object.prototype's when nothing was found and firstOff differs.
    { op: "local.get", index: 4 },
    { op: "ref.is_null" },
    { op: "local.get", index: 2 },
    { op: "i32.const", value: OBJ_OFF },
    { op: "i32.ne" },
    { op: "i32.and" },
    { op: "if", blockType: { kind: "empty" }, then: probeInto([{ op: "i32.const", value: OBJ_OFF }]) },
    // No entry anywhere → undefined miss.
    { op: "local.get", index: 4 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...miss(), { op: "return" }],
    },
    // Accessor entry → invoke the getter with the ORIGINAL receiver
    // (§6.2.5.5 step 8 — Receiver is the object the Get started on).
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
    { op: "i32.const", value: FLAG_ACCESSOR },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 4 },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_GET },
        { op: "extern.convert_any" },
        { op: "local.tee", index: 5 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...miss(), { op: "return" }],
        },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 5 },
        { op: "call", funcIdx: deps.callAccessorGetIdx },
        { op: "return" },
      ],
    },
    // Data entry → its value.
    { op: "local.get", index: 4 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
    { op: "extern.convert_any" },
  ];
}

/**
 * `__protoidx_set_r(origRecv, key, value) -> decision`.
 *
 * This is the native-companion tail of #4504's ordinary descriptor walk.  The
 * explicit `$Object` / fnctor links are owned by `__extern_set_decide`; only
 * after they exhaust does it arrive here.  Probe the receiver brand companion
 * first and Object's companion second, returning on the first live entry.
 */
function fillSetRBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_SET_R);
  const brandOffIdx = ctx.funcMap.get(PROTOIDX_BRAND_OFF);
  if (!fn || brandOffIdx === undefined) return;
  const entryRefNull: ValType = { kind: "ref_null", typeIdx: deps.propEntryTypeIdx };
  // params: 0=origRecv 1=key 2=value ; locals: 3=firstOff 4=c 5=e 6=setter
  fn.locals = [
    { name: "firstOff", type: { kind: "i32" } },
    { name: "c", type: { kind: "externref" } },
    { name: "e", type: entryRefNull },
    { name: "setter", type: { kind: "externref" } },
  ];
  const probe = (which: Instr[]): Instr[] => [
    ...which,
    { op: "i32.const", value: 0 }, // lookup only: deciding must not allocate
    { op: "call", funcIdx: deps.companionIdx },
    { op: "local.tee", index: 4 },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 4 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: deps.objectTypeIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: deps.objFindIdx },
        { op: "local.tee", index: 5 },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 5 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
            { op: "i32.const", value: FLAG_ACCESSOR },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 5 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_SET },
                { op: "extern.convert_any" },
                { op: "local.tee", index: 6 },
                { op: "ref.is_null" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: SET_DECISION_REFUSED }, { op: "return" }],
                },
                { op: "local.get", index: 0 }, // ORIGINAL receiver
                { op: "local.get", index: 6 },
                { op: "local.get", index: 2 },
                { op: "call", funcIdx: deps.callAccessorSetIdx },
                { op: "i32.const", value: SET_DECISION_HANDLED },
                { op: "return" },
              ],
            },
            // Freeze is stored as an object-level integrity bit in this
            // runtime rather than eagerly clearing every data entry's
            // writable flag. It changes only data descriptors: an accessor
            // setter above remains callable on a frozen prototype.
            { op: "local.get", index: 4 },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: deps.objectTypeIdx },
            { op: "struct.get", typeIdx: deps.objectTypeIdx, fieldIdx: 4 },
            { op: "i32.const", value: OBJ_FLAG_FROZEN },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: SET_DECISION_REFUSED }, { op: "return" }],
            },
            // A data descriptor is also terminal.  In particular, a writable
            // one authorizes an own create and must not expose a farther
            // companion accessor/non-writable data descriptor.
            { op: "local.get", index: 5 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: deps.propEntryTypeIdx, fieldIdx: ENTRY_FLAGS },
            { op: "i32.const", value: FLAG_WRITABLE },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: SET_DECISION_ALLOW_OWN }, { op: "return" }],
              else: [{ op: "i32.const", value: SET_DECISION_REFUSED }, { op: "return" }],
            },
          ],
        },
      ],
    },
  ];
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: brandOffIdx },
    { op: "local.set", index: 3 },
    ...probe([{ op: "local.get", index: 3 }]),
    { op: "local.get", index: 3 },
    { op: "i32.const", value: OBJ_OFF },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: probe([{ op: "i32.const", value: OBJ_OFF }]),
    },
    { op: "i32.const", value: SET_DECISION_MISS },
  ];
}

/** `__protoidx_has_f(idx, firstOff)` = has_k(ToString(idx), firstOff). */
function fillHasFBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_HAS_F);
  const hasKIdx = ctx.funcMap.get(PROTOIDX_HAS_K);
  if (!fn || hasKIdx === undefined) return;
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: deps.numberToStringIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: hasKIdx },
  ];
}

/** `__protoidx_get_f(recv, idx, firstOff)` = get_k(recv, ToString(idx), fo). */
function fillGetFBody(ctx: CodegenContext, deps: ProtoIndexFillDeps): void {
  const fn = findFn(ctx, PROTOIDX_GET_F);
  const getKIdx = ctx.funcMap.get(PROTOIDX_GET_K);
  if (!fn || getKIdx === undefined) return;
  fn.body = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: deps.numberToStringIdx },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: getKIdx },
  ];
}

/**
 * (#4176) `__protoidx_brand_off(externref v) -> i32` — the brand OFFSET of
 * the receiver's implicit [[Prototype]]. Structural `ref.test` ladder over
 * the carrier kinds present in this module (absent types are skipped, so a
 * module without Dates emits no Date test). Order matters: the
 * `__StandaloneRegExp` / `__Date` tests must run BEFORE the closure-carrier
 * predicate, whose #4008 widening accepts those structs too.
 */
function fillBrandOffBody(ctx: CodegenContext): void {
  const fn = findFn(ctx, PROTOIDX_BRAND_OFF);
  if (!fn) return;
  // params: 0=v ; locals: 1=any(anyref) 2=off(i32)
  fn.locals = [
    { name: "any", type: { kind: "anyref" } },
    { name: "off", type: { kind: "i32" } },
  ];
  const ret = (off: number): Instr[] => [{ op: "i32.const", value: off }, { op: "return" }];
  const testArm = (typeIdx: number | undefined, off: number): Instr[] =>
    typeIdx === undefined
      ? []
      : [
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx },
          { op: "if", blockType: { kind: "empty" }, then: ret(off) },
        ];

  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];

  // $NativeProto receiver → its OWN brand offset (direct proto reads see
  // their own companion first; out-of-band brands — user-class protos — fall
  // back to Object).
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  if (npTypeIdx !== undefined) {
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: npTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: npTypeIdx },
          { op: "struct.get", typeIdx: npTypeIdx, fieldIdx: 0 }, // $brand
          { op: "i32.const", value: BUILTIN_BRAND_BASE },
          { op: "i32.sub" },
          { op: "local.tee", index: 2 },
          { op: "i32.const", value: BUILTIN_BRAND_COUNT },
          { op: "i32.lt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: 2 }, { op: "return" }],
          },
          ...ret(OBJ_OFF),
        ],
      },
    );
  }
  // Boxed-primitive WRAPPER (`new String()` / `new Number()` / `new
  // Boolean()`) — a plain `$Object` carrying the [[PrimitiveValue]] internal
  // slot (see WRAPPER_PRIMITIVE_KEY above). Classify by the slot value's box
  // type so the wrapper's chain starts at its OWN prototype brand
  // (`String.prototype.enumerable = true; Object.defineProperty(o, "p",
  // new String())` — the 15.2.3.6-3-{35,141,220,250}-1 family). An ordinary
  // `$Object` (no slot) falls through to the OBJ default. The key is built
  // with `nativeStringLiteralInstrs` — finalize-safe (no import-global adds).
  {
    const types = ctx.objectRuntimeTypes;
    const objFindIdx = ctx.funcMap.get("__obj_find");
    const anyStr = ctx.anyStrTypeIdx;
    if (types && objFindIdx !== undefined && anyStr >= 0) {
      const entryRefNull: ValType = { kind: "ref_null", typeIdx: types.propEntryTypeIdx };
      const eLocal = fn.locals.length + 1; // params: 1 → locals start at 1
      fn.locals.push({ name: "we", type: entryRefNull });
      const slotValue = (): Instr[] => [
        { op: "local.get", index: eLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: types.propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
      ];
      const boxNum = ctx.nativeBoxNumberTypeIdx;
      const boxBool = ctx.nativeBoxBooleanTypeIdx;
      body.push(
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: types.objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 1 },
            { op: "ref.cast", typeIdx: types.objectTypeIdx },
            ...nativeStringLiteralInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
            { op: "extern.convert_any" },
            { op: "call", funcIdx: objFindIdx },
            { op: "local.set", index: eLocal },
            { op: "local.get", index: eLocal },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...slotValue(),
                { op: "ref.test", typeIdx: anyStr },
                { op: "if", blockType: { kind: "empty" }, then: ret(STRING_OFF) },
                ...(boxNum >= 0
                  ? ([
                      ...slotValue(),
                      { op: "ref.test", typeIdx: boxNum },
                      ...slotValue(),
                      { op: "ref.test", typeIdx: I31_HEAP_TYPE },
                      { op: "i32.or" },
                      { op: "if", blockType: { kind: "empty" }, then: ret(NUMBER_OFF) },
                    ] satisfies Instr[])
                  : []),
                ...(boxBool >= 0
                  ? ([
                      ...slotValue(),
                      { op: "ref.test", typeIdx: boxBool },
                      { op: "if", blockType: { kind: "empty" }, then: ret(BOOLEAN_OFF) },
                    ] satisfies Instr[])
                  : []),
              ],
            },
            ...ret(OBJ_OFF),
          ],
        },
      );
    }
  }
  body.push(...testArm(ctx.vecPropBaseTypeIdx, ARR_OFF));
  body.push(...testArm(ctx.structMap.get("__StandaloneRegExp"), REGEXP_OFF));
  body.push(...testArm(ctx.structMap.get("__Date"), DATE_OFF));
  // (#4207) BARE primitive receiver — a native string / boxed number / boxed
  // boolean that never went through `ToObject`. The wrapper arm above only
  // classifies a `$Object` carrying [[PrimitiveValue]]; a primitive reaching a
  // consult site directly (`Number.prototype.m = f; (5).m()`, which lowers to
  // `__extern_method_call(__box_number(5), "m", …)`) fell through every test
  // and answered `Object`, so `Number.prototype`'s companion was never
  // consulted and the inherited method was invisible. §10.4.3 says the
  // receiver's implicit chain starts at its OWN wrapper prototype, so this is
  // the same rule the wrapper arm states, applied one representation earlier.
  // Ordered boolean-before-number because the boxes are distinct struct types
  // and i31 is claimed by Number (a boxed boolean is never an i31 here).
  body.push(...testArm(ctx.nativeBoxBooleanTypeIdx >= 0 ? ctx.nativeBoxBooleanTypeIdx : undefined, BOOLEAN_OFF));
  body.push(...testArm(ctx.nativeBoxNumberTypeIdx >= 0 ? ctx.nativeBoxNumberTypeIdx : undefined, NUMBER_OFF));
  body.push(...testArm(I31_HEAP_TYPE, NUMBER_OFF));
  body.push(...testArm(ctx.anyStrTypeIdx >= 0 ? ctx.anyStrTypeIdx : undefined, STRING_OFF));
  body.push(...testArm(ctx.errorStructTypeIdx >= 0 ? ctx.errorStructTypeIdx : undefined, ERROR_OFF));
  const isClosureCarrierIdx = ctx.funcMap.get("__is_closure_prop_carrier");
  if (isClosureCarrierIdx !== undefined) {
    body.push(
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: isClosureCarrierIdx },
      { op: "if", blockType: { kind: "empty" }, then: ret(FUN_OFF) },
    );
  }
  body.push({ op: "i32.const", value: OBJ_OFF });
  fn.body = body;
}

/** (#4176) `__protoidx_has_r` / `__protoidx_get_r` — receiver-aware consults. */
function fillRecvConsultBodies(ctx: CodegenContext): void {
  const brandOffIdx = ctx.funcMap.get(PROTOIDX_BRAND_OFF);
  const hasKIdx = ctx.funcMap.get(PROTOIDX_HAS_K);
  const getKIdx = ctx.funcMap.get(PROTOIDX_GET_K);
  if (brandOffIdx === undefined) return;
  const hasR = findFn(ctx, PROTOIDX_HAS_R);
  if (hasR && hasKIdx !== undefined) {
    // (recv, key) -> has_k(key, brand_off(recv))
    hasR.body = [
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: brandOffIdx },
      { op: "call", funcIdx: hasKIdx },
    ];
  }
  const getR = findFn(ctx, PROTOIDX_GET_R);
  if (getR && getKIdx !== undefined) {
    // (recv, key) -> get_k(recv, key, brand_off(recv))
    getR.body = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: brandOffIdx },
      { op: "call", funcIdx: getKIdx },
    ];
  }
}

/**
 * The `$NativeProto` brand head shared by the write arms: runs `then` when
 * the receiver (param 0) is a builtin-branded proto glue singleton and the
 * key (param `keyParam`) normalises to a participating key (left in
 * `nkLocal`; the brand OFFSET left in `offLocal`). Falls through untouched
 * otherwise.
 */
function nativeProtoWriteArmHead(
  ctx: CodegenContext,
  opts: { offLocal: number; nkLocal: number; keyParam: number; then: Instr[] },
): Instr[] | undefined {
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  const normKeyIdx = ctx.funcMap.get(PROTOIDX_NORM_KEY);
  if (npTypeIdx === undefined || normKeyIdx === undefined) return undefined;
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: npTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: npTypeIdx },
        { op: "struct.get", typeIdx: npTypeIdx, fieldIdx: 0 }, // $brand
        { op: "i32.const", value: BUILTIN_BRAND_BASE },
        { op: "i32.sub" },
        { op: "local.tee", index: opts.offLocal },
        { op: "i32.const", value: BUILTIN_BRAND_COUNT },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: opts.keyParam },
            { op: "call", funcIdx: normKeyIdx },
            { op: "local.tee", index: opts.nkLocal },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: opts.then },
          ],
        },
      ],
    },
  ];
}

/** `[offLocal, create=1] -> call companion` (externref). */
function companionForOffInstrs(companionIdx: number, offLocal: number): Instr[] {
  return [
    { op: "local.get", index: offLocal },
    { op: "i32.const", value: 1 }, // create — this is the write side
    { op: "call", funcIdx: companionIdx },
  ];
}

/**
 * FINALIZE — prepend the `$NativeProto` write arms (substitution-by-recursion)
 * onto `__extern_set` / `__defineProperty_value` / `__defineProperty_accessor`.
 * The arm re-targets the call at the brand's companion `$Object` and RECURSES
 * (the companion is a plain `$Object`, so the recursion takes the ordinary
 * path and terminates), which keeps the accessor-set gate, the #2042-S4
 * preflight, the flag translation and the frozen checks all working
 * unchanged; the define arms still return the ORIGINAL receiver
 * (defineProperty returns O). Locals are appended, never renumbered.
 */
function spliceNativeProtoWriteArms(ctx: CodegenContext): void {
  const companionIdx = ctx.funcMap.get(PROTOIDX_COMPANION);
  if (companionIdx === undefined) return;

  const spliceInto = (
    name: string,
    numParams: number,
    inner: (offLocal: number, nkLocal: number, selfIdx: number) => Instr[],
  ): void => {
    const selfIdx = ctx.funcMap.get(name);
    const fn = selfIdx === undefined ? undefined : definedFuncAt(ctx, selfIdx);
    if (!fn || selfIdx === undefined) return;
    const offLocal = numParams + fn.locals.length;
    const nkLocal = offLocal + 1;
    const arm = nativeProtoWriteArmHead(ctx, {
      offLocal,
      nkLocal,
      keyParam: 1,
      then: inner(offLocal, nkLocal, selfIdx),
    });
    if (!arm) return;
    fn.locals.push(
      { name: "__protoidx_off", type: { kind: "i32" } },
      { name: "__protoidx_nk", type: { kind: "externref" } },
    );
    fn.body.splice(0, 0, ...arm);
  };

  // __extern_set(obj, key, value) -> void
  spliceInto("__extern_set", 3, (offLocal, nkLocal, selfIdx) => [
    ...companionForOffInstrs(companionIdx, offLocal),
    { op: "local.get", index: nkLocal },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: selfIdx },
    { op: "return" },
  ]);
  // __defineProperty_value(obj, key, value, flagsF64) -> externref (returns O)
  spliceInto("__defineProperty_value", 4, (offLocal, nkLocal, selfIdx) => [
    ...companionForOffInstrs(companionIdx, offLocal),
    { op: "local.get", index: nkLocal },
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "call", funcIdx: selfIdx },
    { op: "drop" },
    { op: "local.get", index: 0 }, // return the ORIGINAL proto receiver
    { op: "return" },
  ]);
  // __defineProperty_accessor(obj, key, getter, setter, flagsF64) -> externref
  spliceInto("__defineProperty_accessor", 5, (offLocal, nkLocal, selfIdx) => [
    ...companionForOffInstrs(companionIdx, offLocal),
    { op: "local.get", index: nkLocal },
    { op: "local.get", index: 2 },
    { op: "local.get", index: 3 },
    { op: "local.get", index: 4 },
    { op: "call", funcIdx: selfIdx },
    { op: "drop" },
    { op: "local.get", index: 0 },
    { op: "return" },
  ]);
}

/**
 * FINALIZE — read-your-writes coherence for DIRECT indexed reads on the proto
 * objects themselves (`Object.prototype[1]` / `Array.prototype[1]` as
 * receivers): prepend a `$NativeProto` brand arm onto `__extern_get_idx` /
 * `__extern_has_idx` that consults the companions (the Array brand consults
 * the Array companion first — its own chain ends at Object.prototype). Other
 * brands fall through to today's behaviour (their direct NAMED reads route
 * through `__protoidx_brand_off`'s `$NativeProto` arm at the key
 * chokepoints).
 */
function spliceNativeProtoDirectReadArms(ctx: CodegenContext): void {
  const npTypeIdx = ctx.nativeProtoTypeIdx;
  const getFIdx = ctx.funcMap.get(PROTOIDX_GET_F);
  const hasFIdx = ctx.funcMap.get(PROTOIDX_HAS_F);
  if (npTypeIdx === undefined) return;
  if (getFIdx === undefined || hasFIdx === undefined) return;
  const objBrand = OBJ_OFF + BUILTIN_BRAND_BASE;
  const arrBrand = ARR_OFF + BUILTIN_BRAND_BASE;

  const splice = (name: string, isHas: boolean, consultIdx: number): void => {
    const fn = findFn(ctx, name);
    if (!fn) return;
    // params: 0=v(externref) 1=idx(f64); append a brand scratch local.
    const brandLocal = 2 + fn.locals.length;
    fn.locals.push({ name: "__protoidx_brand", type: { kind: "i32" } });
    // has_f takes (idx, firstOff); get_f takes (recv, idx, firstOff).
    const consult = (firstOff: number): Instr[] => [
      ...(isHas ? [] : ([{ op: "local.get", index: 0 }] satisfies Instr[])),
      { op: "local.get", index: 1 },
      { op: "i32.const", value: firstOff },
      { op: "call", funcIdx: consultIdx },
      { op: "return" },
    ];
    const arm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: npTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: npTypeIdx },
          { op: "struct.get", typeIdx: npTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: brandLocal },
          { op: "local.get", index: brandLocal },
          { op: "i32.const", value: objBrand },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: consult(OBJ_OFF) },
          { op: "local.get", index: brandLocal },
          { op: "i32.const", value: arrBrand },
          { op: "i32.eq" },
          { op: "if", blockType: { kind: "empty" }, then: consult(ARR_OFF) },
          // other brands: fall through unchanged
        ],
      },
    ];
    fn.body.splice(0, 0, ...arm);
  };
  splice("__extern_get_idx", false, getFIdx);
  splice("__extern_has_idx", true, hasFIdx);
}
