// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachNestedBuffer, type IrFunction, type IrInstr, type IrValueId } from "../../core/nodes.js";
import type { IrType } from "../../core/types.js";
import { ALLOC_NAMESPACES, type AllocSiteRegistry } from "../alloc-registry.js";
import { AccessSet, joinAnnotations, annotationsEqual, topAnnotation, type OwnershipAnnotation } from "../lattice.js";
import type { EscapeClass } from "../contracts/allocations.js";

function nativeVector(type: IrType | null | undefined): boolean {
  return (
    type?.kind === "vec" &&
    type.layout === undefined &&
    type.elementType.kind === "val" &&
    type.elementType.val.kind === "f64"
  );
}
const pure = new Set([
  "const",
  "binary",
  "unary",
  "slot.read",
  "slot.write",
  "vec.new_fixed",
  "if",
  "if.stmt",
  "for.loop",
  "while.loop",
  "early.return",
]);
/** Native annotation producer over actual synchronous vector regions; no IR or sites are synthesized. */
export function analyzeNativeVectorControl(fn: IrFunction, registry: AllocSiteRegistry, escapeEnabled: boolean): void {
  if (
    (fn.funcKind !== undefined && fn.funcKind !== "regular") ||
    fn.asyncPlan !== undefined ||
    fn.closureSubtype !== undefined
  )
    return;
  const values = new Map<IrValueId, OwnershipAnnotation>();
  const constructors = new Map<IrValueId, number>();
  const inputs = new Map<IrValueId, readonly IrValueId[]>();
  const aliases: [IrValueId, IrValueId][] = [];
  const all: IrInstr[] = [],
    active = new Set<readonly IrInstr[]>();
  const collect = (buffer: readonly IrInstr[]): void => {
    if (active.has(buffer)) throw new Error("native vector analysis: cyclic executable buffer");
    active.add(buffer);
    for (const instr of buffer) {
      all.push(instr);
      if (
        instr.kind === "vec.new_fixed" &&
        instr.result !== null &&
        instr.alloc !== undefined &&
        nativeVector(instr.resultType)
      ) {
        constructors.set(instr.result, instr.alloc);
        values.set(instr.result, { ownership: "owned", access: AccessSet.empty() });
      }
      if (instr.kind === "if" && instr.result !== null && nativeVector(instr.resultType)) {
        inputs.set(instr.result, [instr.thenValue, instr.elseValue]);
        aliases.push([instr.result, instr.thenValue], [instr.result, instr.elseValue]);
        values.set(instr.result, { ownership: "owned", access: AccessSet.empty() });
      }
      if (instr.kind === "call" && instr.result !== null && nativeVector(instr.resultType))
        values.set(instr.result, { ownership: "shared", access: AccessSet.of("read") });
      forEachNestedBuffer(instr, collect);
    }
    active.delete(buffer);
  };
  for (const param of fn.params) values.set(param.value, { ownership: "shared", access: AccessSet.of("read") });
  for (const block of fn.blocks) collect(block.instrs);
  if (!constructors.size) return;
  const returned = new Set<IrValueId>(),
    opaque = new Set<IrValueId>();
  const touch = (value: IrValueId, op: "read" | "write" | "escape" | "identity"): void => {
    const previous = values.get(value) ?? { ownership: "shared", access: AccessSet.of("read") };
    values.set(value, {
      ownership: op === "escape" ? "escaped" : previous.ownership,
      access: previous.access.with(op),
    });
  };
  let unknown = false;
  for (const instr of all) {
    if (instr.kind === "vec.get" || instr.kind === "vec.len") touch(instr.vec, "read");
    else if (instr.kind === "vec.set") {
      touch(instr.vec, "write");
      touch(instr.newValue, "escape");
    } else if (instr.kind === "call")
      for (const arg of instr.args) {
        touch(arg, "escape");
        opaque.add(arg);
      }
    else if (instr.kind === "early.return" && instr.value !== null) {
      touch(instr.value, "escape");
      returned.add(instr.value);
    } else if (instr.kind === "binary" && (instr.op === "i32.eq" || instr.op === "i32.ne")) {
      touch(instr.lhs, "identity");
      touch(instr.rhs, "identity");
    } else if (!pure.has(instr.kind)) unknown = true;
  }
  for (const block of fn.blocks)
    if (block.terminator.kind === "return")
      for (const value of block.terminator.values) {
        touch(value, "escape");
        returned.add(value);
      }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of aliases) {
      const left = values.get(a) ?? topAnnotation(),
        right = values.get(b) ?? topAnnotation();
      const joined = joinAnnotations(left, right);
      if (!annotationsEqual(left, joined) || !annotationsEqual(right, joined)) changed = true;
      values.set(a, joined);
      values.set(b, joined);
    }
  }
  const classifications = new Map<IrValueId, EscapeClass>();
  const attribute = (roots: ReadonlySet<IrValueId>, classification: "returned" | "opaque"): void => {
    for (const root of roots) {
      const pending = [root],
        seen = new Set<IrValueId>();
      while (pending.length) {
        const value = pending.pop()!;
        if (seen.has(value)) continue;
        seen.add(value);
        if (constructors.has(value)) classifications.set(value, classification);
        pending.push(...(inputs.get(value) ?? []));
      }
    }
  };
  attribute(returned, "returned");
  attribute(opaque, "opaque");
  for (const [value, id] of constructors) {
    const annotation = unknown ? topAnnotation() : values.get(value)!;
    registry.annotate(id as never, ALLOC_NAMESPACES.ownership, {
      state: annotation.ownership,
      ops: annotation.access.toArray(),
    });
    if (escapeEnabled) {
      const classification = unknown
        ? "opaque"
        : (classifications.get(value) ??
          (annotation.ownership === "owned" && !annotation.access.has("escape") ? "local" : "opaque"));
      registry.annotate(id as never, ALLOC_NAMESPACES.escape, {
        classification,
        stackAllocatable: classification === "local",
      });
    }
  }
}
