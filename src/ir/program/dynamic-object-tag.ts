// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 M1, G1, W2) `Object.prototype.toString.call(v)`, which from-ast intercepts (`dyn.object_tag`): a tag per kind
 * `v` may hold (§20.1.3.6). `undefined` and `null` are named before ToObject (steps 1-2), a primitive answers its
 * wrapper's builtinTag, and an object a wrapper's kind by its slot (W2), "Error" for [[ErrorData]] (G1), else "Object";
 * its `@@toStringTag` is reachable only by naming `Symbol`, which refuses by name.
 *
 * (W2) A program that can obtain Object.prototype can replace its `toString`, which the realm's Object.prototype
 * otherwise lacks: the intercepted call then is the run-time abort.
 */
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { WRAPPER_DATA, WRAPPER_OF_PRIMITIVE } from "../../runtime/contracts/native-realm-catalog.js";
import { realmCall } from "./dynamic-realm-calls.js";
import type { ChainBuilders } from "./dynamic-value-chains.js";
import { gap } from "./dynamic-value-gap.js";
import { OBJECT_TAG, type CarrierKind, type LegalizationProgram } from "./dynamic-value-kinds.js";
import { CARRIER, carried } from "./dynamic-value-types.js";

type ObjectTag = Extract<IrInstr, { kind: "dyn.object_tag" }>;

/** What the tag depends on in the program: errors may exist, wrappers may, a prototype is obtainable. */
export interface ObjectTagProgram {
  readonly program: LegalizationProgram;
  readonly errors: boolean;
  readonly wrappers: boolean;
  readonly prototypes: boolean;
}

/** The legalized `dyn.object_tag` into its result. */
export function dynamicObjectTag(b: ChainBuilders, p: ObjectTagProgram, instr: ObjectTag): IrInstr[] {
  const tag = (r: IrValueId) =>
    b.kindChain(
      instr,
      instr.value,
      r,
      (kind, result) => {
        if (kind === "object" && p.program.objects.namesSymbol)
          gap("Object.prototype.toString of an object in a program that names 'Symbol'");
        return kind === "object" ? objectTag(b, p, instr, result) : [b.text(`[object ${OBJECT_TAG[kind]}]`, result)];
      },
      b.kinds.kindsOf(instr.value),
    );
  if (!p.prototypes) return tag(instr.result!);
  const [prototype, name, key, replaced] = [b.fresh(), b.fresh(), b.fresh(), b.fresh()];
  return [
    ...b.realmIntrinsic("%Object.prototype%", prototype),
    b.text("toString", name),
    carried(name, key),
    ...b.selectorCall("js.object.has-own", [prototype, key], 0, replaced),
    b.branch(replaced, (r) => [b.intrinsic(instr, "js.value.unsupported", [], r)], tag, instr.result!),
  ];
}

/** An object's tag: a wrapper's kind by its slot (`undefined` for no wrapper), "Error", else "Object". */
function objectTag(b: ChainBuilders, p: ObjectTagProgram, instr: ObjectTag, result: IrValueId): IrInstr[] {
  const object = instr.value;
  const plain = (r: IrValueId): IrInstr[] => {
    if (!p.errors) return [b.text("[object Object]", r)];
    const isError = b.fresh();
    return [
      realmCall("js.object.is-error", [object], isError),
      b.branch(
        isError,
        (s) => [b.text("[object Error]", s)],
        (s) => [b.text("[object Object]", s)],
        r,
      ),
    ];
  };
  if (!p.wrappers) return plain(result);
  const [absent, data] = [b.fresh(), b.fresh()];
  const slots = b.admitted.filter((kind) => kind === "undefined" || kind in WRAPPER_OF_PRIMITIVE);
  return [
    { kind: "const", value: { kind: "null", ty: CARRIER }, result: absent, resultType: CARRIER },
    ...b.selectorCall("js.object.wrapper-data", [object, absent], WRAPPER_DATA.slot, data),
    ...b.kindChain(
      instr,
      data,
      result,
      (kind: CarrierKind, r) => (kind === "undefined" ? plain(r) : [b.text(`[object ${OBJECT_TAG[kind]}]`, r)]),
      slots,
    ),
  ];
}
