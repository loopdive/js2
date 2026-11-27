// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 M1, B-tag, G1, #7561) `Object.prototype.toString.call(v)`, which from-ast intercepts (`dyn.object_tag`): a
 * tag per kind `v` may hold (§20.1.3.6). `undefined` and `null` are named before ToObject (steps 1-2), a primitive
 * answers its wrapper's builtinTag, and an object a wrapper's kind by its primitive data (#7561), "Error" for
 * [[ErrorData]] (G1), else "Object"; its `@@toStringTag` is reachable only by naming `Symbol`, which refuses by name.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { WRAPPER_DATA } from "../../runtime/contracts/native-realm-catalog.js";
import { WRAPPER_OF_PRIMITIVE } from "./builtin-prototype-keys.js";
import { realmCall } from "./dynamic-realm-calls.js";
import type { ChainBuilders } from "./dynamic-value-chains.js";
import { gap } from "./dynamic-value-gap.js";
import { OBJECT_TAG, holdsFamily, type LegalizationProgram } from "./dynamic-value-kinds.js";
import { CARRIER } from "./dynamic-value-types.js";

type ObjectTag = Extract<IrInstr, { kind: "dyn.object_tag" }>;

/** The legalized `dyn.object_tag` into its result. */
export function dynamicObjectTag(b: ChainBuilders, program: LegalizationProgram, instr: ObjectTag): IrInstr[] {
  return b.kindChain(
    instr,
    instr.value,
    instr.result!,
    (kind, result) => {
      if (kind === "object" && program.objects.namesSymbol)
        gap("Object.prototype.toString of an object in a program that names 'Symbol'");
      return kind === "object"
        ? objectTag(b, program, instr, result)
        : [b.text(`[object ${OBJECT_TAG[kind]}]`, result)];
    },
    b.kinds.kindsOf(instr.value),
  );
}

/** An object's tag: a wrapper's kind by its primitive data (`undefined` for no wrapper), "Error", else "Object". */
function objectTag(b: ChainBuilders, program: LegalizationProgram, instr: ObjectTag, result: IrValueId): IrInstr[] {
  const plain = (r: IrValueId): IrInstr[] => {
    if (!holdsFamily(program, "error")) return [b.text(`[object ${OBJECT_TAG.object}]`, r)];
    const isError = b.fresh();
    return [
      realmCall("js.object.is-error", [instr.value], isError),
      b.branch(
        isError,
        (s) => [b.text("[object Error]", s)],
        (s) => [b.text("[object Object]", s)],
        r,
      ),
    ];
  };
  if (program.objects.wrappers.size === 0) return plain(result);
  const [absent, data] = [b.fresh(), b.fresh()];
  const slots = b.admitted.filter((kind) => kind === "undefined" || kind in WRAPPER_OF_PRIMITIVE);
  return [
    { kind: "const", value: { kind: "null", ty: CARRIER }, result: absent, resultType: CARRIER },
    ...b.selectorCall("js.object.wrapper-data", [instr.value, absent], WRAPPER_DATA.slot, data),
    ...b.kindChain(
      instr,
      data,
      result,
      (kind, r) => (kind === "undefined" ? plain(r) : [b.text(`[object ${OBJECT_TAG[kind]}]`, r)]),
      slots,
    ),
  ];
}
