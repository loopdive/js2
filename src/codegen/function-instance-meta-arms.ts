// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4437) The RUNTIME half of the per-function metadata carrier: the
 * `__fninst_meta` resolver body, and the three small instruction shapes the
 * reflective arms in `function-instance-props.ts` splice around it.
 *
 * `function-instance-meta.ts` owns the COMPILE-time half (minting the
 * `$__fn_instance_meta` struct, growing the `$fnmeta` slot, registering
 * families). This module owns the read side. They are split so neither the
 * closure-mint sites nor the reflective fill has to import the other's
 * concerns, and so `fillFunctionInstanceProps` stays a sequence of splices
 * rather than absorbing a second subsystem.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { FN_META_LENGTH_FIELD_IDX, FN_META_NAME_FIELD_IDX } from "./function-instance-meta.js";
import { FNINST_META } from "./function-instance-props.js";

/** How `fillFunctionInstanceProps` installs a reserved native's body. */
export type SetNativeBody = (name: string, locals: { name: string; type: ValType }[], body: Instr[]) => void;

export interface FnMetaArms {
  /**
   * Is there anything to read? False when the module minted no `$fnmeta` slot
   * (no user closure, or a non-standalone target), in which case every consumer
   * emits its pre-#4437 instructions and the reserved resolver keeps its
   * `ref.null.extern` placeholder.
   */
  readonly available: boolean;
  /**
   * `i32` — 1 iff the receiver (param 0) carries metadata. Leaves the metadata
   * externref in `metaLocal` so {@link name} / {@link boxedLength} can read it
   * without asking twice.
   */
  present(metaLocal: number): Instr[];
  /** `metaLocal` (known non-null) → its §10.2.9 `name`, already an externref. */
  name(metaLocal: number): Instr[];
  /** `metaLocal` (known non-null) → its §15.1.5 `length`, as a boxed number. */
  boxedLength(metaLocal: number, boxNumIdx: number): Instr[];
  /** Install the `__fninst_meta` body. No-op when {@link available} is false. */
  fillResolver(setFn: SetNativeBody): void;
}

/**
 * Bind the metadata read surface for this module.
 *
 * Every field index and type index is resolved ONCE here, so a consumer cannot
 * accidentally read `length` out of the `name` slot — the two are only ever
 * named through {@link FnMetaArms.name} / {@link FnMetaArms.boxedLength}.
 */
export function fnMetaArms(ctx: CodegenContext): FnMetaArms {
  const structTypeIdx = ctx.fnInstanceMetaStructTypeIdx;
  const families = ctx.fnInstanceMetaFamilies;
  const metaIdx = ctx.funcMap.get(FNINST_META);
  const available = structTypeIdx !== undefined && families !== undefined && families.size > 0 && metaIdx !== undefined;

  const field = (metaLocal: number, fieldIdx: number): Instr[] => [
    { op: "local.get", index: metaLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: structTypeIdx! },
    { op: "struct.get", typeIdx: structTypeIdx!, fieldIdx },
  ];

  return {
    available,
    present: (metaLocal) => [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: metaIdx! },
      { op: "local.tee", index: metaLocal },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
    ],
    name: (metaLocal) => field(metaLocal, FN_META_NAME_FIELD_IDX),
    boxedLength: (metaLocal, boxNumIdx) => [
      ...field(metaLocal, FN_META_LENGTH_FIELD_IDX),
      { op: "f64.convert_i32_s" },
      { op: "call", funcIdx: boxNumIdx },
    ],
    fillResolver: (setFn) => {
      if (!available) return;
      // One `ref.test` arm per registered family. Families are SIBLINGS, never
      // subtypes of one another (each is `<some closure struct> + $fnmeta`), so
      // arm order is immaterial and at most one can match. The `$fnmeta` type
      // is nominal and unreachable from user source, so a family `ref.test`
      // cannot be satisfied by a structurally-similar non-metadata closure —
      // see function-instance-meta.ts on why a bare `i32` id could.
      const body: Instr[] = [];
      for (const [famTypeIdx, fieldIdx] of families!) {
        body.push(
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: famTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: famTypeIdx },
              { op: "struct.get", typeIdx: famTypeIdx, fieldIdx },
              { op: "local.tee", index: 1 },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 1 },
                  { op: "ref.as_non_null" },
                  { op: "extern.convert_any" },
                  { op: "return" },
                ],
              },
            ],
          },
        );
      }
      body.push({ op: "ref.null.extern" });
      setFn(FNINST_META, [{ name: "__m", type: { kind: "ref_null", typeIdx: structTypeIdx! } }], body);
    },
  };
}
