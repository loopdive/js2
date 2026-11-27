// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 M1, B-tag, G1, #7561) Object.prototype.toString's algorithm, for `Object.prototype.toString.call(v)` (which
 * from-ast intercepts as `dyn.object_tag`) and (#7574) a call of the realm's method (`dynamic-builtin-methods.ts`): a
 * tag per kind `v` may hold (§20.1.3.6). The algorithm alone; which method a call reaches is the method table's
 * (`dynamic-builtin-methods.ts`), which imports this module, so the two stay apart without an import cycle. `undefined` and `null` are named before ToObject (steps 1-2), a primitive
 * answers its wrapper's builtinTag, and an object a wrapper's kind by its primitive data (#7561), "Error" for
 * [[ErrorData]] (G1), else "Object"; its `@@toStringTag` is reachable only by naming `Symbol`, which refuses by name.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { REALM_BRAND, WRAPPER_DATA, WRAPPER_OF_PRIMITIVE } from "./builtin-prototype-keys.js";
import type { ChainBuilders } from "./dynamic-value-chains.js";
import { gap } from "./dynamic-value-gap.js";
import { OBJECT_TAG, holdsFamily, type LegalizationProgram } from "./dynamic-value-kinds.js";
import { CARRIER } from "./dynamic-value-types.js";

/** The builtinTag of each realm brand (§20.1.3.6 steps 5 and 9). */
const BRAND_TAG = { array: "Array", error: "Error" } as const satisfies Record<keyof typeof REALM_BRAND, string>;

/** The tag of `value` (Object.prototype.toString's algorithm, called with `value` as `this`) into `result`. */
export function objectTagOf(
  b: ChainBuilders,
  program: LegalizationProgram,
  instr: IrInstr,
  value: IrValueId,
  result: IrValueId,
): IrInstr[] {
  return b.kindChain(
    instr,
    value,
    result,
    (kind, r) => {
      if (kind === "object" && program.objects.namesSymbol)
        gap("Object.prototype.toString of an object in a program that names 'Symbol'");
      return kind === "object" ? objectTag(b, program, instr, value, r) : [b.text(`[object ${OBJECT_TAG[kind]}]`, r)];
    },
    b.kinds.kindsOf(value),
  );
}

/**
 * An object's tag: a wrapper's kind by its primitive data (`undefined` for no wrapper), else each realm brand a value of
 * the program may carry in turn, (#7352) "Array" and "Error", else "Object".
 */
function objectTag(
  b: ChainBuilders,
  program: LegalizationProgram,
  instr: IrInstr,
  value: IrValueId,
  result: IrValueId,
): IrInstr[] {
  const brands = (["array", "error"] as const).filter((family) => holdsFamily(program, family));
  const plain = brands.reduceRight(
    (otherwise: (r: IrValueId) => IrInstr[], brand) =>
      (r: IrValueId): IrInstr[] => {
        const branded = b.fresh();
        return [
          ...b.selectorCall("js.object.has-brand", [value], REALM_BRAND[brand], branded),
          b.branch(branded, (s) => [b.text(`[object ${BRAND_TAG[brand]}]`, s)], otherwise, r),
        ];
      },
    (r: IrValueId): IrInstr[] => [b.text(`[object ${OBJECT_TAG.object}]`, r)],
  );
  if (program.objects.wrappers.size === 0) return plain(result);
  const [absent, data] = [b.fresh(), b.fresh()];
  const slots = b.admitted.filter((kind) => kind === "undefined" || kind in WRAPPER_OF_PRIMITIVE);
  return [
    { kind: "const", value: { kind: "null", ty: CARRIER }, result: absent, resultType: CARRIER },
    ...b.selectorCall("js.object.wrapper-data", [value, absent], WRAPPER_DATA.slot, data),
    ...b.kindChain(
      instr,
      data,
      result,
      (kind, r) => (kind === "undefined" ? plain(r) : [b.text(`[object ${OBJECT_TAG[kind]}]`, r)]),
      slots,
    ),
  ];
}
