// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  directUses,
  forEachNestedBuffer,
  type AllocSiteId,
  type IrFunction,
  type IrInstr,
  type IrModule,
  type IrValueId,
} from "../../core/nodes.js";
import { irTypeEquals, type IrType } from "../../core/types.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import { ALLOC_NAMESPACES } from "../contracts/allocations.js";
import { AccessSet } from "../lattice.js";
import { primitiveKind, profileFunctionExclusion, profileInstructionExclusion } from "./effect-rules.js";
import { indexRegistryEvidence } from "./metadata.js";
import type { AllocationEvidenceCheck, AllocationEvidenceFailure, AllocationEvidenceCensus } from "./contracts.js";

function vector(type: IrType | null | undefined): boolean {
  return type?.kind === "vec" && type.layout === undefined && primitiveKind(type.elementType) === "f64";
}

function irTypeAssignable(actual: IrType, expected: IrType): boolean {
  return (
    irTypeEquals(actual, expected) ||
    (actual.kind === "vec" &&
      expected.kind === "vec" &&
      !actual.nullable &&
      expected.nullable &&
      irTypeEquals(actual.elementType, expected.elementType))
  );
}

/** This separate profile does not widen the historical local-only checker. */
export function hasNumericVectorCallBoundary(module: IrModule): boolean {
  if (!module.functions.some((fn) => fn.params.some((param) => vector(param.type)) || fn.resultTypes.some(vector)))
    return false;
  const functions = new Map(module.functions.map((fn) => [fn.unitId, fn]));
  const pending: (readonly IrInstr[])[] = module.functions.flatMap((fn) => fn.blocks.map((block) => block.instrs));
  const seen = new Set<readonly IrInstr[]>();
  while (pending.length) {
    const buffer = pending.pop()!;
    if (seen.has(buffer)) continue;
    seen.add(buffer);
    for (const instr of buffer) {
      if (instr.kind === "call") {
        const target = instr.target.binding.kind === "unit" ? functions.get(instr.target.binding.unitId) : undefined;
        if (vector(instr.resultType) || target?.params.some((param) => vector(param.type))) return true;
      }
      forEachNestedBuffer(instr, (child) => pending.push(child));
    }
  }
  return false;
}

interface SiteEvidence {
  access: AccessSet;
  escape: "local" | "returned" | "opaque";
}

function equalRecord(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => {
      const left = (actual as Record<string, unknown>)[key],
        right = expected[key];
      return Array.isArray(right)
        ? Array.isArray(left) && left.length === right.length && left.every((item, index) => item === right[index])
        : left === right;
    })
  );
}

/** Replay conservative, intraprocedural producer annotations; never infer a callee's effects. */
export function verifyNumericVectorCallEvidence(
  module: IrModule,
  registry: AllocRegistrySnapshot,
): AllocationEvidenceCheck {
  const index = indexRegistryEvidence(registry);
  const sites = new Map<AllocSiteId, SiteEvidence>();
  const functions = new Map(module.functions.map((fn) => [fn.unitId, fn]));
  const census = {
    functions: 0,
    buffers: 0,
    instructions: 0,
    allocations: 0,
    vectorReads: 0,
    vectorWrites: 0,
    registrySlots: registry.size,
  };
  if (functions.size !== module.functions.length)
    return { kind: "invalid", code: "occurrence-mismatch", at: { kind: "module" } };
  for (const fn of module.functions) {
    census.functions++;
    const at = { kind: "function" as const, unitId: fn.unitId };
    // Keep all shape exclusions; only the synchronous vector carrier arm is new.
    const shape = profileFunctionExclusion({ ...fn, params: [], resultTypes: [] });
    if (shape) return { kind: "not-covered", reason: shape, at };
    if (
      fn.params.some((param) => !primitiveKind(param.type) && !vector(param.type)) ||
      fn.resultTypes.some((type) => !primitiveKind(type) && !vector(type))
    )
      return { kind: "not-covered", reason: "reference-carrier", at };
    const visible = new Map(fn.params.map((param) => [param.value, param.type]));
    const seen = new Set(visible.keys());
    const roots = new Map<IrValueId, AllocSiteId>();
    const failure = replayVectorCallBody(fn, functions, registry, visible, seen, roots, sites, census);
    if (failure) return failure;
  }
  for (let id = 0; id < registry.size; id++) {
    const evidence = sites.get(id as AllocSiteId),
      row = index.rows.get(id as AllocSiteId);
    const at = { kind: "site" as const, site: id as AllocSiteId };
    if (!evidence) {
      if (
        row?.has(ALLOC_NAMESPACES.ownership) ||
        row?.has(ALLOC_NAMESPACES.escape) ||
        row?.has(ALLOC_NAMESPACES.encoding)
      )
        return { kind: "invalid", code: "unused-site-evidence", at };
      continue;
    }
    if (row?.has(ALLOC_NAMESPACES.encoding)) return { kind: "invalid", code: "namespace-presence", at };
    if (
      index.ownership &&
      !equalRecord(row?.get(ALLOC_NAMESPACES.ownership), {
        state: evidence.access.has("escape") ? "escaped" : "owned",
        ops: evidence.access.toArray(),
      })
    )
      return {
        kind: "invalid",
        code: row?.has(ALLOC_NAMESPACES.ownership) ? "namespace-value" : "namespace-presence",
        at,
      };
    if (
      index.escape &&
      !equalRecord(row?.get(ALLOC_NAMESPACES.escape), {
        classification: evidence.escape,
        stackAllocatable: evidence.escape === "local",
      })
    )
      return {
        kind: "invalid",
        code: row?.has(ALLOC_NAMESPACES.escape) ? "namespace-value" : "namespace-presence",
        at,
      };
  }
  return { kind: "verified", profile: "single-block-numeric-vector-call-v1", namespaces: index.mode, census };
}

function replayVectorCallBody(
  fn: IrFunction,
  functions: ReadonlyMap<IrFunction["unitId"], IrFunction>,
  registry: AllocRegistrySnapshot,
  visible: Map<IrValueId, IrType>,
  seen: Set<IrValueId>,
  roots: Map<IrValueId, AllocSiteId>,
  sites: Map<AllocSiteId, SiteEvidence>,
  census: { -readonly [K in keyof AllocationEvidenceCensus]: number },
): AllocationEvidenceFailure | undefined {
  const at = { kind: "function" as const, unitId: fn.unitId };
  const invalid = (
    code: Extract<AllocationEvidenceFailure, { kind: "invalid" }>["code"],
  ): AllocationEvidenceFailure => ({ kind: "invalid", code, at });
  const unsupported = (): AllocationEvidenceFailure => ({ kind: "not-covered", reason: "instruction-kind", at });
  const markEscape = (value: IrValueId, classification: "returned" | "opaque"): void => {
    const id = roots.get(value),
      site = id === undefined ? undefined : sites.get(id);
    if (!site) return;
    site.access = site.access.with("escape");
    if (classification === "opaque" || site.escape === "local") site.escape = classification;
  };
  const activeBuffers = new Set<readonly IrInstr[]>();
  const visit = (
    buffer: readonly IrInstr[],
    scope: Map<IrValueId, IrType>,
    nested: boolean,
  ): AllocationEvidenceFailure | undefined => {
    if (activeBuffers.has(buffer)) return invalid("occurrence-mismatch");
    activeBuffers.add(buffer);
    census.buffers++;
    for (const instr of buffer) {
      census.instructions++;
      if (directUses(instr).some((value) => !scope.has(value)) && instr.kind !== "if")
        return invalid("lexical-definition");
      if (instr.kind === "call") {
        const target = instr.target.binding.kind === "unit" ? functions.get(instr.target.binding.unitId) : undefined;
        if (!target || target.params.length !== instr.args.length || target.resultTypes.length > 1)
          return unsupported();
        if (
          instr.args.some(
            (value, ordinal) => !scope.get(value) || !irTypeAssignable(scope.get(value)!, target.params[ordinal]!.type),
          ) ||
          (target.resultTypes.length === 0
            ? instr.result !== null || instr.resultType !== null
            : !instr.resultType || !irTypeEquals(instr.resultType, target.resultTypes[0]!))
        )
          return invalid("lexical-definition");
        for (const value of instr.args) markEscape(value, "opaque");
      } else if (instr.kind === "unary" || instr.kind === "binary") {
        if (!primitiveKind(instr.resultType) || directUses(instr).some((value) => !primitiveKind(scope.get(value))))
          return unsupported();
      } else {
        const exclusion = profileInstructionExclusion(instr);
        if (exclusion) return { kind: "not-covered", reason: exclusion, at };
        if (instr.kind === "vec.new_fixed") {
          if (nested || instr.alloc === undefined || instr.result === null) return unsupported();
          const entry = registry.entries[instr.alloc];
          if (
            entry?.state !== "live" ||
            entry.site.kind !== "array" ||
            !irTypeEquals(entry.site.type, instr.resultType!)
          )
            return invalid("allocation-provenance");
          if (sites.has(instr.alloc)) return invalid("occurrence-mismatch");
          if (instr.elements.some((value) => primitiveKind(scope.get(value)) !== "f64")) return unsupported();
          roots.set(instr.result, instr.alloc);
          sites.set(instr.alloc, { access: AccessSet.empty(), escape: "local" });
          census.allocations++;
        } else if (instr.kind === "vec.get" || instr.kind === "vec.len" || instr.kind === "vec.set") {
          if (!vector(scope.get(instr.vec))) return unsupported();
          const id = roots.get(instr.vec),
            site = id === undefined ? undefined : sites.get(id);
          if (site) site.access = site.access.with(instr.kind === "vec.set" ? "write" : "read");
          if (instr.kind === "vec.set") {
            if (primitiveKind(scope.get(instr.index)) !== "i32" || primitiveKind(scope.get(instr.newValue)) !== "f64")
              return unsupported();
            census.vectorWrites++;
          } else {
            if (instr.kind === "vec.get" && primitiveKind(scope.get(instr.index)) !== "i32") return unsupported();
            census.vectorReads++;
          }
        } else if (instr.kind === "if") {
          if (primitiveKind(scope.get(instr.cond)) !== "i32") return unsupported();
          for (const arm of ["then", "else"] as const) {
            const child = new Map(scope),
              error = visit(instr[arm], child, true);
            if (error) return error;
            if (
              !child.has(arm === "then" ? instr.thenValue : instr.elseValue) ||
              !irTypeEquals(child.get(arm === "then" ? instr.thenValue : instr.elseValue)!, instr.resultType!)
            )
              return invalid("lexical-definition");
          }
        }
      }
      if (instr.result !== null) {
        if (seen.has(instr.result) || instr.resultType === null) return invalid("lexical-definition");
        seen.add(instr.result);
        scope.set(instr.result, instr.resultType);
      }
    }
    activeBuffers.delete(buffer);
    return undefined;
  };
  const failure = visit(fn.blocks[0]!.instrs, visible, false);
  if (failure) return failure;
  const term = fn.blocks[0]!.terminator;
  if (term.kind === "return") {
    if (term.values.length !== fn.resultTypes.length) return invalid("lexical-definition");
    for (const [index, value] of term.values.entries()) {
      if (!visible.has(value) || !irTypeAssignable(visible.get(value)!, fn.resultTypes[index]!))
        return invalid("lexical-definition");
      markEscape(value, "returned");
    }
  }
  return undefined;
}
