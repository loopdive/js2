// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4248) `(new Number()).toString` must BE `Number.prototype.toString` —
 * inherited builtin-method VALUE reads under `--target standalone`.
 *
 * ## The gap
 *
 * A static `Number.prototype.toString` read resolves through
 * `resolveStandaloneProtoMemberValueClosure` to the identity-stable
 * per-(brand, member) singleton (#2175 V2-S2). The DYNAMIC read of the same
 * member off an INSTANCE — `(new Number()).toString` — goes through
 * `__extern_get`, whose proto-walk follows `$Object.$proto` links. A wrapper's
 * [[Prototype]] is a `$NativeProto`, not a `$Object`, so the walk terminates
 * immediately and the read answers `undefined`. §21.1.5's whole point is that
 * the two spellings name ONE function object:
 *
 * ```js
 * (new Number()).hasOwnProperty("toString")            // false  (already right)
 * (new Number()).toString === Number.prototype.toString // was undefined vs fn
 * ```
 *
 * Note what a naive test would report here. Before #4248 both sides of that
 * comparison could read as absent, and `undefined === undefined` is `true` —
 * #4234 recorded exactly that trap. Any assertion has to establish each side
 * is a real function FIRST; the paired suite does.
 *
 * ## The demand gate is the closure table itself
 *
 * The arm answers only for (brand, member) pairs whose closure the module has
 * ALREADY minted, discovered by scanning `ctx.funcMap` for
 * `__proto_method_<brand>_<member>`. Nothing new is materialized: a module
 * that never reads `Number.prototype.toString` gets no Number arm, and one
 * that reads no builtin-proto member at all gets no arm and no touched body.
 *
 * That gate is not merely cheap, it is the RIGHT one. The identity question
 * cannot arise unless the module also names the prototype member — you need
 * both sides to compare them — so the demanded set and the answerable set
 * coincide. The alternative (materialize every member of every brand whose
 * prototype is present) is the unconditional pull-in #4232 §5 stands against:
 * `String.prototype` alone would mint 36 closures, each with a body.
 *
 * ## Two receiver shapes, one answer
 *
 *  - a WRAPPER `$Object` — brand recovered from the `[[PrimitiveValue]]`
 *    slot's box type, exactly as #4223's `.constructor` arm does (i31 or
 *    `$__box_number` ⇒ Number, `$AnyString` ⇒ String, the boolean box ⇒
 *    Boolean);
 *  - the `$NativeProto` ITSELF — brand read straight off the struct. This is
 *    the `var NP = Number.prototype; NP.toString` spelling, which the static
 *    fold cannot see because the receiver at the read site is an identifier.
 *
 * §7.3.2 shadowing is honored by probing `__obj_find` for an OWN entry first
 * (wrapper case); the arm answers nothing when one exists.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { BUILTIN_BRAND_TABLE } from "./builtin-brands.js";
import { ensureStandaloneNativeMethodClosure, seededNativeProtoDataMembersByBrand } from "./native-proto.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";

/** `$PropEntry.$value` field index (object-runtime.ts layout). */
const ENTRY_VALUE = 1;
/** `$NativeProto` field index (native-proto.ts layout). */
const NP_BRAND = 0;
const NP_IS_CLASS = 1;
/** i31 abstract heap type (signed LEB -20) — small-int boxed numbers (#3673). */
const I31_HEAP_TYPE = -20;
/** MUST equal `WRAPPER_PRIMITIVE_KEY` in object-runtime.ts (ESM-cycle-free). */
const WRAPPER_PRIMITIVE_KEY = "[[PrimitiveValue]]";

/** `__proto_method_<brand>_<member>` — getters (`_get_<member>`) are excluded. */
const CLOSURE_KEY = /^__proto_method_(-?\d+)_(.+)$/;

/**
 * The already-minted METHOD closures, grouped by brand. Getters are skipped:
 * a plain read of an accessor member must INVOKE it (§22.2.6 and friends), and
 * that decision belongs to the static read site, not to a generic
 * `__extern_get` arm.
 */
function mintedMethodsByBrand(ctx: CodegenContext): Map<number, string[]> {
  const byBrand = new Map<number, string[]>();
  for (const name of ctx.funcMap.keys()) {
    const m = CLOSURE_KEY.exec(name);
    if (!m) continue;
    const member = m[2]!;
    if (member.startsWith("get_")) continue;
    const brand = Number(m[1]);
    if (!Number.isFinite(brand)) continue;
    const list = byBrand.get(brand);
    if (list) list.push(member);
    else byBrand.set(brand, [member]);
  }
  return byBrand;
}

/**
 * Prepend the inherited-builtin-method value arm onto `__extern_get`.
 *
 * MUST run before `unshiftExternGetProtoCacheArm` (which has to stay last) and
 * after the closed-struct fills, so the receiver-shape arms compose in the
 * order the existing fills already establish.
 */
export function unshiftExternGetProtoMethodArm(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const protoTypeIdx = ctx.nativeProtoTypeIdx;
  const objTypes = ctx.objectRuntimeTypes;
  const anyStr = ctx.anyStrTypeIdx;
  if (protoTypeIdx === undefined || objTypes === undefined || anyStr < 0) return;
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (strFlattenIdx === undefined || strEqualsIdx === undefined || objFindIdx === undefined) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!fn) return;

  const byBrand = mintedMethodsByBrand(ctx);
  const seededByBrand = seededNativeProtoDataMembersByBrand(ctx);
  const protoGetIdx = ctx.funcMap.get("__protoidx_get_r");
  if (byBrand.size === 0 && (seededByBrand.size === 0 || protoGetIdx === undefined)) return;

  const { objectTypeIdx, propEntryTypeIdx } = objTypes;
  const objLocal = 2 + fn.locals.length;
  const slotLocal = objLocal + 1;
  const keyLocal = slotLocal + 1;
  const newLocals: { name: string; type: ValType }[] = [
    { name: "pmo", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
    { name: "pme", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
    { name: "pmk", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
  ];

  /** For one brand: a `key == <member>` ladder answering the singleton value. */
  const memberLadder = (brand: number): Instr[] => {
    const seededMembers = new Set(seededByBrand.get(brand) ?? []);
    const members = new Set(byBrand.get(brand) ?? []);
    if (protoGetIdx !== undefined) {
      for (const member of seededMembers) members.add(member);
    }
    if (members.size === 0) return [];
    const out: Instr[] = [];
    for (const member of [...members].sort()) {
      if (protoGetIdx !== undefined && seededMembers.has(member)) {
        out.push(
          { op: "local.get", index: keyLocal },
          { op: "ref.as_non_null" },
          ...nativeStringLiteralInstrs(ctx, member),
          { op: "call", funcIdx: strEqualsIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // The seeded companion is the mutable own-property table. It
              // contains the initial singleton, then records replacement or
              // absence after assignment/delete. The shortcut must observe it.
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: protoGetIdx },
              { op: "return" },
            ],
          },
        );
        continue;
      }
      // Idempotent: the closure exists (that is how we found it), so this
      // resolves the handle without minting or emitting anything new.
      const closure = ensureStandaloneNativeMethodClosure(ctx, brand, member, "method", {
        refusalBodyFallback: true,
      });
      if (!closure) continue;
      out.push(
        { op: "local.get", index: keyLocal },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, member),
        { op: "call", funcIdx: strEqualsIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...pushBuiltinFnSingletonValueInstrs(ctx, closure), { op: "extern.convert_any" }, { op: "return" }],
        },
      );
    }
    return out;
  };

  const slotValue = (): Instr[] => [
    { op: "local.get", index: slotLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: ENTRY_VALUE },
  ];

  /** Wrapper-brand classification from the [[PrimitiveValue]] box type (#4223). */
  const boxNum = ctx.nativeBoxNumberTypeIdx;
  const boxBool = ctx.nativeBoxBooleanTypeIdx;
  const wrapperClassify: Instr[] = [];
  {
    const stringLadder = memberLadder(BUILTIN_BRAND_TABLE.String!);
    if (stringLadder.length > 0) {
      wrapperClassify.push(
        ...slotValue(),
        { op: "ref.test", typeIdx: anyStr },
        { op: "if", blockType: { kind: "empty" }, then: stringLadder },
      );
    }
    const numberLadder = memberLadder(BUILTIN_BRAND_TABLE.Number!);
    if (numberLadder.length > 0 && boxNum >= 0) {
      wrapperClassify.push(
        ...slotValue(),
        { op: "ref.test", typeIdx: boxNum },
        ...slotValue(),
        { op: "ref.test", typeIdx: I31_HEAP_TYPE },
        { op: "i32.or" },
        { op: "if", blockType: { kind: "empty" }, then: numberLadder },
      );
    }
    const booleanLadder = memberLadder(BUILTIN_BRAND_TABLE.Boolean!);
    if (booleanLadder.length > 0 && boxBool >= 0) {
      wrapperClassify.push(
        ...slotValue(),
        { op: "ref.test", typeIdx: boxBool },
        { op: "if", blockType: { kind: "empty" }, then: booleanLadder },
      );
    }
  }

  /** The `$NativeProto`-receiver arm: brand straight off the struct. */
  const protoArms: Instr[] = [];
  const brands = new Set([...byBrand.keys(), ...(protoGetIdx === undefined ? [] : seededByBrand.keys())]);
  for (const brand of [...brands].sort((a, b) => a - b)) {
    const ladder = memberLadder(brand);
    if (ladder.length === 0) continue;
    protoArms.push(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: protoTypeIdx },
      { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_BRAND },
      { op: "i32.const", value: brand },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: ladder },
    );
  }

  if (wrapperClassify.length === 0 && protoArms.length === 0) return;

  const body: Instr[] = [
    // Only a string key can name a prototype METHOD.
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: strFlattenIdx },
    { op: "local.set", index: keyLocal },
    // (a) the `$NativeProto` itself — `var NP = Number.prototype; NP.toString`.
    ...(protoArms.length > 0
      ? ([
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: protoTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: protoTypeIdx },
              { op: "struct.get", typeIdx: protoTypeIdx, fieldIdx: NP_IS_CLASS },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [],
                else: protoArms,
              },
            ],
          },
        ] satisfies Instr[])
      : []),
    // (b) a wrapper `$Object` whose [[PrimitiveValue]] names the brand.
    ...(wrapperClassify.length > 0
      ? ([
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: objectTypeIdx },
          { op: "i32.eqz" },
          { op: "br_if", depth: 0 },
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.set", index: objLocal },
          // §7.3.2 — an OWN entry (even an expando holding undefined) shadows.
          { op: "local.get", index: objLocal },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: objFindIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          { op: "br_if", depth: 0 },
          { op: "local.get", index: objLocal },
          { op: "ref.as_non_null" },
          ...nativeStringLiteralInstrs(ctx, WRAPPER_PRIMITIVE_KEY),
          { op: "extern.convert_any" },
          { op: "call", funcIdx: objFindIdx },
          { op: "local.tee", index: slotLocal },
          { op: "ref.is_null" },
          { op: "br_if", depth: 0 },
          ...wrapperClassify,
        ] satisfies Instr[])
      : []),
  ];

  fn.locals.push(...newLocals);
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}
