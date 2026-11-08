// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7291) Lowers an IR `stringBuilder` slot to buffer locals: the empty
 * initializer and each owned append write the buffer in place, and a read
 * materialises the cached string. Matches legacy's #1210 rewrite.
 */
import type { BackendEmitter } from "../backend/emitter.js";
import type { StringBuilderEmitter } from "../backend/string-contract.js";
import type {
  StringBuilderPresize,
  StringBuilderScratch,
  StringBuilderSlots,
} from "../../backend/wasmgc/lowering/wasm-string-builder.js";
import type { IrInstr, IrSlotDef, IrValueId } from "../core/nodes.js";
import type { ValType } from "../types.js";

export interface IrStringBuilderLocals {
  readonly slots: StringBuilderSlots;
  readonly presize: StringBuilderPresize | undefined;
  readonly scratch: StringBuilderScratch;
}

export interface StringBuilderLoweringContext<S> {
  readonly builder: StringBuilderEmitter<S>;
  readonly builders: ReadonlyMap<number, IrStringBuilderLocals>;
  readonly emitValue: (value: IrValueId, out: S) => void;
  readonly emitI32Const: (value: number, out: S) => void;
  /** The defining instruction of a single-use value its consumer emits inline. */
  readonly inlineDef: (value: IrValueId) => IrInstr | undefined;
}

/**
 * The builder lowering of a function, when it has builder slots and the
 * backend keeps them as buffer locals. Each slot's own local, typed like the
 * string it would have held, becomes the `mat` cache.
 */
export function createStringBuilderLowering<S>(
  slotDefs: readonly IrSlotDef[],
  emitter: BackendEmitter<S>,
  slotLocal: (slotIndex: number) => number,
  allocLocal: (name: string, type: ValType) => number,
  values: Pick<StringBuilderLoweringContext<S>, "emitValue" | "inlineDef">,
): StringBuilderLoweringContext<S> | undefined {
  const builder = slotDefs.some((slot) => slot.stringBuilder) ? emitter.stringBuilder?.() : undefined;
  if (!builder) return undefined;
  const builders = new Map<number, IrStringBuilderLocals>();
  const i32: ValType = { kind: "i32" };
  for (const slot of slotDefs) {
    const role = slot.stringBuilder;
    if (!role) continue;
    const local = (suffix: string, type: ValType): number => allocLocal(`$slot_${slot.name}$${suffix}`, type);
    const [buf, len, cap] = [local("buf", builder.bufType), local("len", i32), local("cap", i32)];
    const presize = role.presize && {
      bound: slotLocal(role.presize.boundSlot),
      boundTmp: local("boundTmp", i32),
      unitsPerIter: role.presize.unitsPerIter,
    };
    builders.set(slot.index, {
      slots: { buf, len, cap, mat: slotLocal(slot.index), presized: presize !== undefined },
      presize,
      scratch: {
        needed: local("needed", i32),
        oldBuf: presize ? undefined : local("oldBuf", builder.bufType),
        rhs: local("rhs", builder.flatType),
        rhsLen: local("rhsLen", i32),
        cu: local("cu", i32),
        receiver: local("receiver", builder.flatType),
        receiverAny: local("receiverAny", builder.stringType),
        index: local("index", i32),
      },
    });
  }
  return { builder, builders, emitI32Const: (value, out) => emitter.emitScalarConst("i32", value, out), ...values };
}

/** A builder slot's read materialises the cached string; `false` for any other slot. */
export function tryEmitStringBuilderRead<S>(slotIndex: number, cx: StringBuilderLoweringContext<S>, out: S): boolean {
  const locals = cx.builders.get(slotIndex);
  if (locals) cx.builder.read(locals.slots, out);
  return locals !== undefined;
}

/** A builder slot's write is its empty initializer or an owned append; `false` for any other slot. */
export function tryEmitStringBuilderWrite<S>(
  slotIndex: number,
  value: IrValueId,
  cx: StringBuilderLoweringContext<S>,
  out: S,
): boolean {
  const locals = cx.builders.get(slotIndex);
  if (!locals) return false;
  const def = cx.inlineDef(value);
  if (def?.kind === "string.const") cx.builder.init(locals.slots, locals.presize, out);
  else if (def?.kind === "string.concat") emitStringBuilderAppend(locals, def.rhs, cx, out);
  else throw new Error("ir/lower: a string-builder slot write is neither its initializer nor an owned append");
  return true;
}

/** `s.length` of a builder reads `len`; `false` when `value` is not a builder read. */
export function tryEmitStringBuilderLength<S>(value: IrValueId, cx: StringBuilderLoweringContext<S>, out: S): boolean {
  const def = cx.inlineDef(value);
  const locals = def?.kind === "slot.read" ? cx.builders.get(def.slotIndex) : undefined;
  if (locals) cx.builder.length(locals.slots, out);
  return locals !== undefined;
}

/** One code unit (`"c"`, `x.charAt(i)`) skips the one-unit string. */
function emitStringBuilderAppend<S>(
  { slots, scratch }: IrStringBuilderLocals,
  rhs: IrValueId,
  cx: StringBuilderLoweringContext<S>,
  out: S,
): void {
  const def = cx.inlineDef(rhs);
  if (def?.kind === "string.const" && def.value.length === 1) {
    cx.emitI32Const(def.value.charCodeAt(0), out);
    cx.builder.appendCodeUnit(slots, scratch, out);
  } else if (def?.kind === "string.char_at") {
    cx.emitValue(def.value, out);
    cx.emitValue(def.index, out);
    cx.builder.appendCharAt(slots, scratch, out);
  } else {
    cx.emitValue(rhs, out);
    cx.builder.appendString(slots, scratch, out);
  }
}
