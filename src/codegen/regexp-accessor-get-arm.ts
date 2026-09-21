// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B4 / #5198 Slice F) The READ half of §22.2.6's
 * accessor family: a RUNTIME-keyed `Get(rx, "flags")` / `Get(rx, "global")` on
 * a `$NativeRegExp` receiver must answer what the ACCESSOR answers, not what
 * the struct happens to store under that field name.
 *
 * ## The measured defect
 *
 * A `$NativeRegExp` is a closed nominal struct whose DECLARED FIELD NAMES
 * include `flags` (the i32 bitfield) and `source`. `fillClosedStructExternGetArms`
 * gives every closed struct a declared-field ladder in `__extern_get`, so a
 * runtime-keyed read walked straight into it. Measured on this slice's base
 * (`--target standalone`, original-harness assembly, `var re = /a/g`):
 *
 * | expression        | base                | spec    |
 * | ----------------- | ------------------- | ------- |
 * | `re.flags`        | `"g"`               | `"g"`   |
 * | `re[k]` k=`flags` | **`1`** (a number!) | `"g"`   |
 * | `re.global`       | `true`              | `true`  |
 * | `re[k]` k=`global`| **`undefined`**     | `true`  |
 * | `re[k]` k=`source`| `"a"`               | `"a"`   |
 *
 * `source` looked right purely by coincidence — the field holds the escaped
 * pattern string the getter would have returned. `flags` returned the RAW
 * BITFIELD, and the seven flag booleans are not fields at all, so they missed.
 *
 * This is not a spelling curiosity. §22.2.6.8 step 4 is
 * `ToString(? Get(rx, "flags"))`, and `"1"` contains no `g` — so slice B3's
 * §22.2.6.8 step-6 global collect loop, which is implemented and tested, was
 * DEAD on every real RegExp receiver: the non-global arm was taken always.
 *
 * ## The shape of the fix
 *
 * One prologue on `__extern_get`, in the `unshiftExternGet…Arm` family:
 *
 * ```
 * if (__regexp_getter_only_set(obj, key))      // $NativeRegExp + a §22.2.6 name
 *   if (!__carrier_bag_has(obj, key))          // no OWN property shadowing it
 *     return __regexp_accessor_get(obj, key);
 * ```
 *
 * The own-property consult is not defensive dressing — it is what two manifest
 * rows measure. `@@match/get-global-err` installs a THROWING own `global`
 * accessor with `Object.defineProperty(re, 'global', …)` and requires the throw
 * to propagate; `@@match/coerce-global` installs an own data `global` and
 * requires its ToBoolean. Both live in the instance expando bag, which the
 * ordinary `__extern_get` path already reads and already runs accessors from —
 * so "fall through" is the whole implementation of shadowing.
 *
 * The predicate is `regexp-accessor-set-guard.ts`'s, reused verbatim. That
 * module is the WRITE half of the same §22.2.6 fact (a write to a getter-only
 * member is a sloppy no-op); sharing the name test means presence and
 * mutability cannot disagree about which members are accessors.
 *
 * ## Why `flags` re-enters `[[Get]]` instead of reading the bitfield
 *
 * `__regexp_flags_generic` is §22.2.6.4 verbatim: eight ordered
 * `ToBoolean(? Get(R, <name>))` calls, appending `d g i m s u v y`. It does NOT
 * read the struct, even when the receiver is a real RegExp, because the spec's
 * own observable is those eight Gets: `coerce-global` overrides `global` on the
 * instance and requires `flags` to see the override, and `get-global-err`
 * requires a poisoned `global` getter to abort the `flags` read. Reading the
 * bitfield would answer both wrongly while looking right on every ordinary
 * regexp. The recursion is one level deep and terminates: the eight flag names
 * are answered from the struct, and none of them is `flags`.
 *
 * That same native is ALSO the body of the reified `RegExp.prototype.flags`
 * getter (see `emitRegExpProtoMemberBody`), which is #5198 Slice F: the getter
 * is generic over ANY Object receiver, so
 * `Object.getOwnPropertyDescriptor(RegExp.prototype, "flags").get.call({global: 86})`
 * answers `"g"` rather than brand-checking its way to a TypeError. One native,
 * both entry points — the instance-side and prototype-side halves of this
 * defect cannot drift apart.
 *
 * ## Demand gating
 *
 * Everything here declines — leaving `__extern_get` byte-identical — unless the
 * module already has a `$NativeRegExp` struct, an `__extern_get`, and the
 * natives the bodies call (`__is_truthy`, `__box_boolean`, the native-string
 * helpers). Nothing is registered as a LATE IMPORT from the finalize path: a
 * late import shifts every defined-function index at or above it, and doing
 * that after `__extern_get`'s callers are compiled is the #2043 class (B3 hit
 * its quietest form — no crash, no validation error, just wrong answers).
 * Minting defined funcs here is append-only and their `call`s are baked in the
 * same pass.
 */
import type { Instr, ValType } from "../ir/types.js";
import { CARRIER_BAG_HAS, CARRIER_BAG_OF } from "./carrier-bag-visibility.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addUnionImports } from "./index.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { registerRegExpGetterOnlySet } from "./regexp-accessor-set-guard.js";
import {
  REGEXP_FLAG_BOOL_PROPS,
  RE_FIELD_FLAGS,
  RE_FIELD_SOURCE,
  standaloneRegExpStructTypeIdx,
} from "./regexp-standalone.js";
import { addFuncType } from "./registry/types.js";

const EXTERNREF: ValType = { kind: "externref" };

const ACCESSOR_GET_FN = "__regexp_accessor_get";
const FLAGS_GENERIC_FN = "__regexp_flags_generic";
const STRUCT_FIELD_KEY_FN = "__regexp_struct_field_key";

/**
 * §22.2.6.4 step 3-17 — the eight flag accessors in getter order, each with the
 * code unit it contributes. Identical order and units to `__regex_flags_str`
 * (native-regex.ts), which is the STATIC twin of this native.
 */
const FLAGS_SPEC_ORDER: readonly (readonly [name: string, codeUnit: number])[] = [
  ["hasIndices", 0x64], // d
  ["global", 0x67], // g
  ["ignoreCase", 0x69], // i
  ["multiline", 0x6d], // m
  ["dotAll", 0x73], // s
  ["unicode", 0x75], // u
  ["unicodeSets", 0x76], // v
  ["sticky", 0x79], // y
];

/** `[] → [externref]` — an ordinary string key, materialised as an interned literal. */
function keyInstrs(ctx: CodegenContext, key: string): Instr[] {
  return [...nativeStringLiteralInstrs(ctx, key), { op: "extern.convert_any" }];
}

/**
 * Register `__regexp_flags_generic(R externref) -> externref` — §22.2.6.4's
 * getter body over an ARBITRARY receiver.
 *
 * Callers own the Type(R)-is-Object check (§22.2.6.4 step 2); this native
 * performs only steps 3-17, which are eight ordered `[[Get]]`s. An abrupt
 * completion from any of them propagates out of the `call` unchanged.
 *
 * Returns the funcIdx, or `undefined` when a prerequisite native is missing —
 * declining is always safe (the caller keeps its previous lowering).
 */
export function ensureRegExpGenericFlagsGetter(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(FLAGS_GENERIC_FN);
  if (existing !== undefined) return existing;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const isTruthyIdx = ctx.funcMap.get("__is_truthy");
  if (externGetIdx === undefined || isTruthyIdx === undefined) return undefined;
  const strDataIdx = ctx.nativeStrDataTypeIdx; // array i16
  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString
  if (strDataIdx < 0 || strTypeIdx < 0) return undefined;

  // param 0 = R · local 1 = the 8-slot code-unit buffer · local 2 = length.
  // Eight slots is the exact maximum (one per flag), so no growth is possible.
  const BUF = 1;
  const N = 2;
  const body: Instr[] = [
    { op: "i32.const", value: 8 },
    { op: "array.new_default", typeIdx: strDataIdx },
    { op: "local.set", index: BUF },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: N },
  ];
  for (const [name, codeUnit] of FLAGS_SPEC_ORDER) {
    body.push(
      { op: "local.get", index: 0 },
      ...keyInstrs(ctx, name),
      { op: "call", funcIdx: externGetIdx },
      { op: "call", funcIdx: isTruthyIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: BUF },
          { op: "local.get", index: N },
          { op: "i32.const", value: codeUnit },
          { op: "array.set", typeIdx: strDataIdx },
          { op: "local.get", index: N },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: N },
        ],
      },
    );
  }
  body.push(
    { op: "local.get", index: N },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: BUF },
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "extern.convert_any" },
  );

  const typeIdx = addFuncType(ctx, [EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(FLAGS_GENERIC_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: FLAGS_GENERIC_FN,
    typeIdx,
    locals: [
      { name: "buf", type: { kind: "ref", typeIdx: strDataIdx } },
      { name: "n", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Register `__regexp_accessor_get(obj externref, key externref) -> externref` —
 * the §22.2.6 accessor answer for a `$NativeRegExp` receiver and one of the
 * getter-only member names.
 *
 * Only ever called behind `__regexp_getter_only_set`, which has already proved
 * both the receiver brand and that the key is one of those names, so the
 * `ref.cast` cannot trap and the final fall-through is unreachable.
 */
function registerRegExpAccessorGet(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(ACCESSOR_GET_FN);
  if (existing !== undefined) return existing;
  const reTypeIdx = standaloneRegExpStructTypeIdx(ctx);
  if (reTypeIdx === undefined) return undefined;
  const flagsGenericIdx = ensureRegExpGenericFlagsGetter(ctx);
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (flagsGenericIdx === undefined || boxBooleanIdx === undefined) return undefined;
  const anyStr = ctx.anyStrTypeIdx;
  const natStr = ctx.nativeStrTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (anyStr < 0 || natStr < 0 || flattenIdx === undefined || equalsIdx === undefined) return undefined;

  // params: 0 obj, 1 key · local 2 = the recovered struct · local 3 = flat key
  const L_RE = 2;
  const L_KEY = 3;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: reTypeIdx },
    { op: "local.set", index: L_RE },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: L_KEY },
  ];
  /** `if (key === <member>) { <then> }` — the ladder's one rung. */
  const rung = (member: string, then: Instr[]): void => {
    body.push(
      { op: "local.get", index: L_KEY },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, member),
      { op: "call", funcIdx: equalsIdx },
      { op: "if", blockType: { kind: "empty" }, then: [...then, { op: "return" }] },
    );
  };
  // §22.2.6.4 — re-enters `[[Get]]` eight times; see the module header for why
  // this does NOT shortcut to the bitfield even on a genuine RegExp.
  rung("flags", [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: flagsGenericIdx },
  ]);
  // §22.2.6.13 — the source field is stored pre-escaped, which is exactly the
  // getter's result (`EscapeRegExpPattern` runs at construction).
  rung("source", [
    { op: "local.get", index: L_RE },
    { op: "struct.get", typeIdx: reTypeIdx, fieldIdx: RE_FIELD_SOURCE },
    { op: "extern.convert_any" },
  ]);
  // §22.2.6.5-.12 RegExpHasFlag — a JS boolean, not the number 0/1.
  for (const [member, bit] of Object.entries(REGEXP_FLAG_BOOL_PROPS)) {
    rung(member, [
      { op: "local.get", index: L_RE },
      { op: "struct.get", typeIdx: reTypeIdx, fieldIdx: RE_FIELD_FLAGS },
      { op: "i32.const", value: bit },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "call", funcIdx: boxBooleanIdx },
    ]);
  }
  body.push({ op: "ref.null.extern" });

  const typeIdx = addFuncType(ctx, [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(ACCESSOR_GET_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: ACCESSOR_GET_FN,
    typeIdx,
    locals: [
      { name: "re", type: { kind: "ref_null", typeIdx: reTypeIdx } },
      { name: "fkey", type: { kind: "ref_null", typeIdx: natStr } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Register `__regexp_struct_field_key(key externref) -> i32` — 1 iff `key` is
 * one of the two §22.2.6 member names that is ALSO a physical `$NativeRegExp`
 * field (`flags`, `source`), i.e. one the closed-struct field ladder would
 * answer ahead of the expando bag.
 */
function registerRegExpStructFieldKey(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(STRUCT_FIELD_KEY_FN);
  if (existing !== undefined) return existing;
  const anyStr = ctx.anyStrTypeIdx;
  const natStr = ctx.nativeStrTypeIdx;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  if (anyStr < 0 || natStr < 0 || flattenIdx === undefined || equalsIdx === undefined) return undefined;

  const L_KEY = 1;
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: flattenIdx },
    { op: "local.set", index: L_KEY },
  ];
  for (const member of ["flags", "source"]) {
    body.push(
      { op: "local.get", index: L_KEY },
      { op: "ref.as_non_null" },
      ...nativeStringLiteralInstrs(ctx, member),
      { op: "call", funcIdx: equalsIdx },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
    );
  }
  body.push({ op: "i32.const", value: 0 });

  const typeIdx = addFuncType(ctx, [EXTERNREF], [{ kind: "i32" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set(STRUCT_FIELD_KEY_FN, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: STRUCT_FIELD_KEY_FN,
    typeIdx,
    locals: [{ name: "fkey", type: { kind: "ref_null", typeIdx: natStr } }],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * Finalize splice: answer a runtime-keyed §22.2.6 accessor read off a
 * `$NativeRegExp` from the ACCESSOR, ahead of the declared-field ladder.
 *
 * MUST run after `fillClosedStructExternGetArms` (the ladder this pre-empts)
 * and BEFORE `unshiftExternGetProtoCacheArm`, which has to stay the body's
 * prefix — `inlineExternGetCallSites` accepts the body only while that arm is
 * first, and declines wholesale otherwise.
 *
 * No-op unless the module has both a `$NativeRegExp` struct and an
 * `__extern_get`; when `__carrier_bag_has` is missing there is no expando side
 * table in this module at all, so nothing can shadow and the consult is
 * skipped rather than the whole arm declined.
 */
export function unshiftRegExpAccessorGetArm(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!fn) return;
  const predIdx = registerRegExpGetterOnlySet(ctx);
  if (predIdx === undefined) return;
  const getIdx = registerRegExpAccessorGet(ctx);
  if (getIdx === undefined) return;
  const bagHasIdx = ctx.funcMap.get(CARRIER_BAG_HAS);
  const bagOfIdx = ctx.funcMap.get(CARRIER_BAG_OF);
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const fieldKeyIdx = registerRegExpStructFieldKey(ctx);
  const answer: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: getIdx },
    { op: "return" },
  ];
  // An OWN entry in the instance expando bag shadows the inherited accessor.
  // For seven of the nine names that is just "fall through": the ordinary path
  // reads the bag and RUNS an accessor found there
  // (`Object.defineProperty(re, 'global', {get(){throw}})`).
  //
  // `flags` and `source` cannot fall through, because they are ALSO declared
  // FIELD names on `$NativeRegExp` and the closed-struct field ladder answers
  // them before the bag is ever consulted — measured: an own `flags` getter
  // returning `"XY"` read back as `0`, the bitfield. Those two are re-entered
  // against the bag object directly. Narrowing recorded on purpose: the bag is
  // then the accessor's `this`, not the regexp. No corpus row reads the
  // receiver inside such a getter, and threading the #1888 explicit-receiver
  // globals from a prologue that runs BEFORE `__extern_get` consumes them would
  // leak a receiver into the next call.
  const bagRescue: Instr[] =
    bagOfIdx === undefined || externGetIdx === undefined || fieldKeyIdx === undefined
      ? []
      : [
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: fieldKeyIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: bagOfIdx },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: externGetIdx },
              { op: "return" },
            ],
          },
        ];
  const guarded: Instr[] =
    bagHasIdx === undefined
      ? answer
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: bagHasIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: answer, else: bagRescue },
        ];
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: predIdx },
    { op: "if", blockType: { kind: "empty" }, then: guarded },
  );
}

/**
 * (#5198 Slice F) Emit the reified `RegExp.prototype.flags` getter body over an
 * ARBITRARY receiver: §22.2.6.4 step 2's Object check, then the eight ordered
 * Gets — no brand check, no struct read.
 *
 * `Object.getOwnPropertyDescriptor(RegExp.prototype, "flags").get` is a plain
 * function that five test262 rows `.call()` on a bare object literal
 * (`flags/coercion-{global,ignoreCase,multiline,sticky,unicode}`), so brand-
 * recovering the receiver answered TypeError where the spec answers a string.
 * Those rows fail on the HOST lane too, which is what makes this a getter
 * defect rather than a standalone one.
 *
 * MEASURED, and narrower than it reads: fixing the brand check does NOT make
 * those five rows pass. Their failure moves from the first assert (`TypeError:
 * Method called on incompatible receiver`) to the first TRUTHY value
 * (`SameValue(«""», «"g"»)`), and the remaining half is not §22.2.6.4 — the
 * identical value sequence on a plain object answers correctly when compiled
 * as TypeScript. What is left is the row's script-scope `var` receiver losing
 * a later string in its property slot: an object-runtime row family. See the
 * B4 residual table in `plan/issues/6651-…-execution-plan.md`.
 *
 * `thisParam` is the closure's externref `this` local. Returns the emitted
 * result ValType, or `null` when a prerequisite native is missing — in which
 * case the caller keeps its previous (brand-recovered) lowering.
 *
 * Known narrowing, deliberate: `__typeof_object` implements `typeof`, so a
 * CALLABLE receiver reports 0 and takes the TypeError arm even though §6.1.7
 * calls a function an Object. No row in the RegExp corpus reads `flags` off a
 * function, and the alternative — a second brand-independent object predicate —
 * is the #2885 reflective core, not a line in this slice.
 */
export function emitGenericFlagsGetterBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  thisParam: number,
): ValType | null {
  // Every native is registered BEFORE a single index is read or a single
  // instruction is pushed: a late import shifts every defined-function index at
  // or above it (#2043), and `ensureRegExpGenericFlagsGetter` below bakes the
  // resolved `__extern_get` / `__is_truthy` indices into a minted body.
  ensureObjectRuntime(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  if (ctx.standalone) addUnionImports(ctx);
  ensureLateImport(ctx, "__is_truthy", [EXTERNREF], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, fctx);
  const genericIdx = ensureRegExpGenericFlagsGetter(ctx);
  const typeofObjectIdx = ctx.funcMap.get("__typeof_object");
  if (genericIdx === undefined || typeofObjectIdx === undefined) return null;

  // §22.2.6.4 step 2 — `typeof null === "object"`, so the null externref is
  // screened separately (the same pairing `regexp-exec-protocol.ts` uses).
  const throwInstrs = buildThrowJsErrorInstrs(ctx, "TypeError", "RegExp.prototype.flags requires an Object receiver", {
    flush: fctx,
  });
  fctx.body.push(
    { op: "local.get", index: thisParam },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: thisParam },
        { op: "call", funcIdx: typeofObjectIdx },
      ],
    },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
    { op: "local.get", index: thisParam },
    { op: "call", funcIdx: genericIdx },
  );
  return EXTERNREF;
}
