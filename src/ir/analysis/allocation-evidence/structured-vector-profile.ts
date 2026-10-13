// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  forEachNestedBuffer,
  type IrBlock,
  type IrBlockId,
  type IrFunction,
  type IrInstr,
  type IrModule,
} from "../../core/nodes.js";
import { irTypeEquals } from "../../core/types.js";
import type { AllocRegistrySnapshot } from "../contracts/allocations.js";
import { verifyAllocationEvidence } from "./verify.js";
import { primitiveKind } from "./effect-rules.js";
import { indexRegistryEvidence } from "./metadata.js";
import { numericVector, compareStructuredVectorFacts } from "./structured-vector-facts.js";
import {
  StructuredVectorBody,
  StructuredEvidenceRefusal,
  copyStructuredScope,
  type StructuredScope,
} from "./structured-vector-body.js";
import type { AllocationEvidenceCheck } from "./contracts.js";
import {
  checkNativeModuleVectorWriters,
  checkNativeModuleVectorReads,
  type NativeModuleGlobalEvidence,
} from "./module-vector-globals.js";

import { collectNativeNumericAppendProtocol, isNativeNumericAppendCall } from "./numeric-append-protocol.js";
import { IrInvariantError, IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";

/** Select only genuine numeric-vector programs whose bodies require the new control checker. */
export function hasStructuredNumericVectors(module: IrModule): boolean {
  let vectors = false,
    control = false;
  const pending = module.functions.flatMap((fn) => {
    vectors ||= fn.params.some((p) => numericVector(p.type)) || fn.resultTypes.some(numericVector);
    control ||= fn.blocks.length > 1 || !!fn.slots?.length;
    return fn.blocks.map((block) => block.instrs);
  });
  const seen = new Set<readonly IrInstr[]>();
  while (pending.length) {
    const buffer = pending.pop()!;
    if (seen.has(buffer)) continue;
    seen.add(buffer);
    for (const instr of buffer) {
      vectors ||= numericVector(instr.resultType);
      control ||=
        (instr.kind === "if" && numericVector(instr.resultType)) ||
        instr.kind === "if.stmt" ||
        instr.kind === "while.loop" ||
        instr.kind === "for.loop" ||
        instr.kind === "global.set" ||
        instr.kind === "early.return" ||
        isNativeNumericAppendCall(instr);
      forEachNestedBuffer(instr, (child) => pending.push(child));
    }
  }
  return vectors && control;
}
function successors(block: IrBlock): readonly IrBlockId[] {
  const term = block.terminator;
  return term.kind === "br"
    ? [term.branch.target]
    : term.kind === "br_if"
      ? [term.ifTrue.target, term.ifFalse.target]
      : [];
}
function mergeScopes(scopes: readonly StructuredScope[]): StructuredScope {
  const first = scopes[0]!;
  return {
    values: new Map(
      [...first.values].filter(([value, type]) =>
        scopes.every((scope) => {
          const actual = scope.values.get(value);
          return actual && irTypeEquals(type, actual);
        }),
      ),
    ),
    initialized: new Set([...first.initialized].filter((slot) => scopes.every((scope) => scope.initialized.has(slot)))),
    normal: scopes.every((scope) => scope.normal),
  };
}
/** Acyclic outer CFG branches; iteration lives in authenticated structured loop buffers. */
function replayFunction(checker: StructuredVectorBody): void {
  const fn = checker.fn;
  if (
    !fn.blocks.length ||
    (fn.funcKind !== undefined && fn.funcKind !== "regular") ||
    ["asyncPlan", "asyncRuntime", "generatorBufferSlot", "closureSubtype", "captures"].some((key) =>
      Object.hasOwn(fn, key),
    )
  )
    checker.refuse("function-shape");
  if (
    fn.params.some((p) => !primitiveKind(p.type) && !numericVector(p.type)) ||
    fn.resultTypes.some((t) => !primitiveKind(t) && !numericVector(t))
  )
    checker.refuse("reference-carrier");
  for (const [index, slot] of (fn.slots ?? []).entries())
    if (slot.index !== index || !primitiveKind({ kind: "val", val: slot.type })) checker.refuse("reference-carrier");
  const blocks = new Map(fn.blocks.map((block) => [block.id, block]));
  if (blocks.size !== fn.blocks.length) checker.fail("occurrence-mismatch");
  const predecessors = new Map<IrBlockId, IrBlockId[]>();
  for (const block of fn.blocks) {
    if (block.blockArgs.length || block.blockArgTypes.length) checker.refuse("function-shape");
    const term = block.terminator;
    const branches = term.kind === "br" ? [term.branch] : term.kind === "br_if" ? [term.ifTrue, term.ifFalse] : [];
    if (branches.some((branch) => branch.args.length || !blocks.has(branch.target))) checker.fail("lexical-definition");
    for (const target of new Set(successors(block)))
      predecessors.set(target, [...(predecessors.get(target) ?? []), block.id]);
  }
  const entry = fn.blocks[0]!,
    initial: StructuredScope = { values: new Map(), initialized: new Set(), normal: true };
  if (predecessors.has(entry.id)) checker.refuse("function-shape");
  for (const param of fn.params) {
    checker.define(param.value, param.type, initial);
    checker.facts.parameter(param.value);
  }
  const exits = new Map<IrBlockId, StructuredScope>(),
    pending = new Map(blocks);
  while (pending.size) {
    let progress = false;
    for (const [id, block] of pending) {
      const parents = predecessors.get(id) ?? [];
      if (id !== entry.id && (!parents.length || parents.some((parent) => !exits.has(parent)))) continue;
      const incoming = parents.map((parent) => exits.get(parent)!);
      const normal = incoming.filter((scope) => scope.normal);
      const scope = id === entry.id ? copyStructuredScope(initial) : mergeScopes(normal.length ? normal : incoming);
      checker.visit(block.instrs, scope);
      const term = block.terminator;
      if (term.kind === "return") checker.returns(term.values, scope);
      else if (term.kind === "br_if" && primitiveKind(scope.values.get(term.condition)) !== "i32")
        checker.fail("lexical-definition");
      exits.set(id, scope);
      pending.delete(id);
      progress = true;
    }
    if (!progress) checker.refuse("function-shape");
  }
  checker.facts.finish();
}
export function verifyStructuredNumericVectorEvidence(
  module: IrModule,
  registry: AllocRegistrySnapshot,
  globals?: ReadonlyMap<string, NativeModuleGlobalEvidence>,
): AllocationEvidenceCheck {
  let appends: ReturnType<typeof collectNativeNumericAppendProtocol>;
  try {
    appends = collectNativeNumericAppendProtocol(module.functions);
  } catch (error) {
    if (error instanceof IrInvariantError)
      return { kind: "invalid", code: "lexical-definition", at: { kind: "module" } };
    if (error instanceof IrUnsupportedError)
      return { kind: "not-covered", reason: "instruction-kind", at: { kind: "module" } };
    throw error;
  }
  const globalFailure =
    globals && (checkNativeModuleVectorWriters(module, globals) ?? checkNativeModuleVectorReads(module, globals));
  if (globalFailure) return globalFailure;
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
  const sites: StructuredVectorBody["facts"]["sites"] = new Map();
  if (functions.size !== module.functions.length)
    return { kind: "invalid", code: "occurrence-mismatch", at: { kind: "module" } };
  try {
    for (const fn of module.functions) {
      census.functions++;
      const checker = new StructuredVectorBody(fn, functions, registry, census, globals);
      replayFunction(checker);
      for (const [id, site] of checker.facts.sites) {
        if (sites.has(id)) checker.fail("occurrence-mismatch");
        sites.set(id, site);
      }
    }
  } catch (error) {
    if (error instanceof StructuredEvidenceRefusal) return error.report;
    throw error;
  }
  const failure = compareStructuredVectorFacts(registry, sites);
  return (
    failure ?? {
      kind: "verified",
      profile: appends.length ? "structured-numeric-vector-append-v1" : "structured-numeric-vector-control-v1",
      namespaces: indexRegistryEvidence(registry).mode,
      census,
    }
  );
}

/** Whole native preparation selects control coverage after canonical contextual validation. */
export function verifyNativeAllocationEvidence(
  module: IrModule,
  registry: AllocRegistrySnapshot,
  globals?: ReadonlyMap<string, NativeModuleGlobalEvidence>,
): AllocationEvidenceCheck {
  return hasStructuredNumericVectors(module)
    ? verifyStructuredNumericVectorEvidence(module, registry, globals)
    : verifyAllocationEvidence(module, registry);
}
