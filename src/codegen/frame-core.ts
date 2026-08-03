// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Resumable-frame core (#2895 PR1) — the host-free state-machine substrate
 * shared by the Wasm-native suspendable lowerings.
 *
 * This module is the **mechanism layer** extracted from `generators-native.ts`
 * (#680/#2079/#2864): the frame ABI (state-struct field offsets + resume modes),
 * the per-spill default initialiser, and the small state-struct field-I/O +
 * spill-store emit helpers. It is generator-agnostic — every helper operates on
 * the structural {@link FrameLayout} subset of a frame's state struct, so the
 * Wasm-native **generator** path (`generators-native.ts`) and the upcoming
 * host-free **async** path (#2895 PATH B: `await`-suspend → microtask resume)
 * both consume the exact same primitives instead of forking the substrate.
 *
 * PR1 is a pure extraction: the helpers emit byte-identical instructions to the
 * copies they replaced (`NativeGeneratorInfo` structurally satisfies
 * `FrameLayout`, so generator call sites pass `info` unchanged). No behaviour
 * change; the ~250 native-generator tests are the safety gate. The async result/
 * drive layer (`$Promise` + microtask) builds on this stable core in PR2+.
 */
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { FunctionContext } from "./context/types.js";

// ── Frame ABI ──────────────────────────────────────────────────────────────
// Fixed leading fields of every resumable frame's state struct, followed by the
// captured params (at PARAM_FIELD_OFFSET) and the live-across-suspend spills.

/** State-struct field: the i32 resume state (`br_table` selector). */
export const STATE_FIELD = 0;
/** State-struct field: the value delivered on resume (`.next(v)` / awaited value). */
export const SENT_FIELD = 1;
/** State-struct field: the i32 resume mode (see MODE_*). */
export const MODE_FIELD = 2;
/** State-struct field: the value passed to `.return(v)` (abrupt completion). */
export const ABRUPT_FIELD = 3;
/**
 * State-struct field: the error payload for a `.throw(e)` abrupt resume (#2864
 * F2). Always externref (an Error object), independent of the carrier — the
 * `sent`/`abrupt` carrier fields can be f64 in a numeric generator, so the
 * thrown value needs its own slot. Resume mode 2 reads it and re-throws after
 * running enclosing finalizers.
 */
export const ERROR_FIELD = 4;
/** First field index of the captured params in the state struct. */
export const PARAM_FIELD_OFFSET = 5;

/** Result-struct (`{value, done}`) field: the yielded/returned value. */
export const RESULT_VALUE_FIELD = 0;
/** Result-struct field: the i32 `done` flag. */
export const RESULT_DONE_FIELD = 1;

/** Resume modes stored in MODE_FIELD. */
export const MODE_NEXT = 0;
export const MODE_THROW = 2;

/**
 * The structural subset of a frame's state-struct layout the field-I/O helpers
 * below depend on. {@link import("./context/types.js").NativeGeneratorInfo}
 * satisfies this, and the async-frame info (#2895 PR2) will too, so both drive
 * the shared helpers without a wrapper.
 */
export interface FrameLayout {
  /** Per-frame state struct type index. */
  stateTypeIdx: number;
  /** Field index of the i32 resume mode. */
  modeFieldIdx: number;
  /** Function-local names spilled into the state struct across suspensions. */
  spillNames: string[];
  /** Wasm ValType of each spilled local, aligned 1:1 with `spillNames`. */
  spillTypes: ValType[];
  /** Field index where spilled locals start in the state struct. */
  spillFieldOffset: number;
}

export type FrameSpillCellMap = ReadonlyMap<number, { refCellTypeIdx: number; valType: ValType }>;

export function sanitizeTypeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_$]/g, "_");
}

/**
 * The inert default a spill field is constructed with, by ValType (#2864 F1b).
 * Overwritten by the body's declaration on first entry into the owning state, so
 * it only has to satisfy `struct.new`'s field type.
 */
export function defaultSpillInstr(type: ValType): Instr {
  switch (type.kind) {
    case "f64":
      return { op: "f64.const", value: NaN };
    case "i32":
      return { op: "i32.const", value: 0 };
    case "i64":
      return { op: "i64.const", value: 0n };
    case "externref":
      return { op: "ref.null.extern" };
    default:
      return { op: "ref.null", typeIdx: (type as { typeIdx: number }).typeIdx };
  }
}

export function setStateInstrs(layout: FrameLayout, selfLocal: number, state: number): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "i32.const", value: state },
    { op: "struct.set", typeIdx: layout.stateTypeIdx, fieldIdx: STATE_FIELD },
  ];
}

export function setModeInstrs(layout: FrameLayout, selfLocal: number, mode: number): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "i32.const", value: mode },
    { op: "struct.set", typeIdx: layout.stateTypeIdx, fieldIdx: layout.modeFieldIdx },
  ];
}

export function setStateFieldFromLocal(
  layout: FrameLayout,
  selfLocal: number,
  fieldIdx: number,
  valueLocal: number,
): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "local.get", index: valueLocal },
    { op: "struct.set", typeIdx: layout.stateTypeIdx, fieldIdx },
  ];
}

export function setStateI32FromConst(layout: FrameLayout, selfLocal: number, fieldIdx: number, value: number): Instr[] {
  return [
    { op: "local.get", index: selfLocal },
    { op: "i32.const", value },
    { op: "struct.set", typeIdx: layout.stateTypeIdx, fieldIdx },
  ];
}

/** Allocate resume locals and optionally hydrate them from every spill field. */
export function initializeSpillLocals(
  layout: FrameLayout,
  fctx: FunctionContext,
  selfLocal: number,
  restoreEagerly: boolean,
  spillCells?: FrameSpillCellMap,
): void {
  if (spillCells) fctx.boxedCaptures = new Map(fctx.boxedCaptures ?? []);
  for (let index = 0; index < layout.spillNames.length; index++) {
    const name = layout.spillNames[index]!;
    const local = allocLocal(fctx, name, layout.spillTypes[index]!);
    if (restoreEagerly) {
      fctx.body.push({ op: "local.get", index: selfLocal });
      fctx.body.push({ op: "struct.get", typeIdx: layout.stateTypeIdx, fieldIdx: layout.spillFieldOffset + index });
      fctx.body.push({ op: "local.set", index: local });
    }
    const cell = spillCells?.get(index);
    if (cell) (fctx.boxedCaptures ??= new Map()).set(name, cell);
  }
}

/**
 * Store each live spill local back into its state-struct field before a
 * suspension. Skips spills not currently bound in `fctx.localMap` (a spill whose
 * owning state has not declared it yet).
 */
export function storeSpills(
  layout: FrameLayout,
  fctx: FunctionContext,
  selfLocal: number,
  selectedNames?: readonly string[],
): Instr[] {
  const body: Instr[] = [];
  for (let i = 0; i < layout.spillNames.length; i++) {
    const name = layout.spillNames[i]!;
    if (selectedNames && !selectedNames.includes(name)) continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "local.get", index: localIdx });
    body.push({ op: "struct.set", typeIdx: layout.stateTypeIdx, fieldIdx: layout.spillFieldOffset + i });
  }
  return body;
}

/** Restore an exact verified subset of spill fields into their resume locals. */
export function restoreSpills(
  layout: FrameLayout,
  fctx: FunctionContext,
  selfLocal: number,
  selectedNames: readonly string[],
): Instr[] {
  const body: Instr[] = [];
  for (const name of selectedNames) {
    const spillIndex = layout.spillNames.indexOf(name);
    const localIndex = fctx.localMap.get(name);
    if (spillIndex < 0 || localIndex === undefined) {
      throw new Error(`internal: async CFG restore names unknown spill ${name}`);
    }
    body.push({ op: "local.get", index: selfLocal });
    body.push({ op: "struct.get", typeIdx: layout.stateTypeIdx, fieldIdx: layout.spillFieldOffset + spillIndex });
    body.push({ op: "local.set", index: localIndex });
  }
  return body;
}
