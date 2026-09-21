// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster C) The missing prototype edge of the `$Error_struct`
 * representation: an instance of a USER subclass of a builtin Error inherits
 * from that subclass's own prototype carrier.
 *
 * ## The gap, measured on the branch base (standalone, `.tmp/w6651C/e4.ts`)
 *
 * ```
 * class Err extends TypeError {}
 * Err.prototype.tagx = "T";
 * Err.prototype["tag"+"x"]                  // "T"       — the carrier IS reachable
 * new Err()["tag"+"x"]                      // undefined — the instance never looks
 * class Plain {} … new Plain()["tag"+"y"]   // "Y"       — a plain class DOES
 * ```
 *
 * The carrier, the write and the ordinary class rule all already work; the one
 * missing edge is instance → subclass prototype for this representation.
 * `emitStandaloneClassProtoObject` declines for a class with a builtin parent,
 * so there is no `$Object` prototype link to walk, and the instance's identity
 * lives instead in `$Error_struct.$userClassId` (fieldIdx 4, written by
 * `emitSetSubclassUserBrand`). The ladder below turns that brand back into the
 * class's prototype global and delegates the whole lookup — including the rest
 * of the chain — to `__extern_get` on the carrier, rather than re-implementing
 * a walk.
 *
 * ## Narrowing, deliberate
 *
 * - Only a brand this module actually minted AND whose class has a prototype
 *   global. Everything else falls through byte-unchanged.
 * - A NULL global means the prototype was never materialised, so nothing was
 *   ever installed on it: skipped, not consulted.
 * - The carrier is consulted with `__extern_get` and a NULL answer keeps
 *   today's miss. Presence was NOT gated with `__extern_has` on purpose:
 *   `Err.prototype.message = "…"` stores into the carrier's own
 *   `$Error_struct` message FIELD, which `__extern_get` reads and
 *   `__extern_has` does not know about — a presence gate would skip exactly
 *   the property the #6651 `NativeError/*-message` rows are about.
 * - An ACCESSOR on the subclass prototype is invoked with the CARRIER as
 *   receiver, not the error instance. That is a known deviation from
 *   §10.1.8.1; it is strictly better than the current answer (`undefined`),
 *   and every row in scope reads a data property.
 *
 * Lives in its own leaf module so `fillExternGetErrorProps` — already a
 * 300-LOC-budgeted function — does not absorb a subsystem (#3102/#3400).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { externrefBackedOwnFieldBacking } from "./registry/error-types.js";

export interface ErrorSubclassProtoChainArm {
  /** Instructions to splice into `__extern_get`'s `$Error_struct` string-key block. */
  readonly instrs: Instr[];
  /** Locals the caller must APPEND to `__extern_get` (never renumber existing ones). */
  readonly locals: readonly { name: string; type: ValType }[];
}

/**
 * Build the `$userClassId` → subclass-prototype consult ladder.
 *
 * @param errTypeIdx  the `$Error_struct` type index
 * @param errRef      emits the receiver already cast to `$Error_struct`
 * @param brandLocal  index of the appended i32 local for `$userClassId`
 * @param valueLocal  index of the appended externref local for the consult result
 *
 * Returns `undefined` — so the caller emits nothing and the module stays
 * byte-identical — when this module has no error-subclass brand with a
 * prototype global, or no `__extern_get` to delegate to.
 */
export function buildErrorSubclassProtoChainArm(
  ctx: CodegenContext,
  errTypeIdx: number,
  errRef: () => Instr[],
  brandLocal: number,
  valueLocal: number,
): ErrorSubclassProtoChainArm | undefined {
  const externGetIdx = ctx.funcMap.get("__extern_get");
  if (externGetIdx === undefined) return undefined;

  const rungs: Instr[] = [];
  for (const [className, tag] of ctx.classTagMap) {
    if (externrefBackedOwnFieldBacking(ctx, className) !== "error-struct") continue;
    const protoGlobalIdx = ctx.protoGlobals.get(className);
    if (protoGlobalIdx === undefined) continue;
    rungs.push(
      { op: "local.get", index: brandLocal },
      { op: "i32.const", value: tag },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: protoGlobalIdx },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [],
            else: [
              { op: "global.get", index: protoGlobalIdx },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: externGetIdx },
              { op: "local.tee", index: valueLocal },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [],
                else: [{ op: "local.get", index: valueLocal }, { op: "return" }],
              },
            ],
          },
        ],
      },
    );
  }
  if (rungs.length === 0) return undefined;

  return {
    locals: [
      { name: "__err_brand_id", type: { kind: "i32" } },
      { name: "__err_proto_val", type: { kind: "externref" } },
    ],
    instrs: [
      ...errRef(),
      { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 4 },
      { op: "local.tee", index: brandLocal },
      { op: "i32.const", value: -1 },
      { op: "i32.ne" },
      { op: "if", blockType: { kind: "empty" }, then: rungs },
    ],
  };
}
