// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "../callable-bindings.js";
import { ALLOC_NAMESPACES, type AllocSiteRegistry } from "../alloc-registry.js";
import { classifyLiteral } from "../analysis/encoding.js";
import {
  collectUses,
  forEachInstrDeep,
  mapNestedBuffers,
  type IrBlock,
  type IrFunction,
  type IrInstr,
  type IrInstrStringConcat,
  type IrInstrStringConst,
  type IrValueId,
} from "../nodes.js";
import { irStringConcatManySymbol } from "../string-runtime.js";

function immutableConcat(instr: IrInstr | undefined): instr is IrInstrStringConcat {
  return (
    instr?.kind === "string.concat" && (instr.concatMode ?? "immutable") === "immutable" && instr.provider === undefined
  );
}

function recordTerminatorUses(block: IrBlock, add: (value: IrValueId) => void): void {
  const term = block.terminator;
  switch (term.kind) {
    case "br":
      for (const value of term.branch.args) add(value);
      return;
    case "br_if":
      add(term.condition);
      for (const value of term.ifTrue.args) add(value);
      for (const value of term.ifFalse.args) add(value);
      return;
    case "return":
      for (const value of term.values) add(value);
      return;
    case "unreachable":
      return;
  }
}

function recordAsyncPlanUses(fn: IrFunction, add: (value: IrValueId) => void): void {
  for (const state of fn.asyncPlan?.states ?? []) {
    for (const update of state.updates ?? []) add(update.value);
    switch (state.terminator.kind) {
      case "suspend":
        add(state.terminator.awaited);
        for (const value of state.terminator.live) add(value);
        break;
      case "branch":
        add(state.terminator.condition);
        break;
      case "resolve":
        if (state.terminator.value !== undefined) add(state.terminator.value);
        break;
      case "reject":
        add(state.terminator.reason);
        break;
      case "goto":
      case "complete":
        break;
    }
  }
}

/**
 * Fuse maximal, single-use immutable concat trees into one semantic N-ary
 * call. Adjacent, single-use unprepared literal leaves are coalesced first.
 * Leaves stay in source evaluation order; DCE removes the now-unused pure
 * pairwise nodes and retires their allocation sites. Fused literal allocation
 * sites alias the surviving literal (or an all-literal root) and have their
 * `alloc` field stripped from the dead instruction so DCE cannot retire the
 * alias after the fusion.
 */
export function batchStringConcat(
  fn: IrFunction,
  registry?: AllocSiteRegistry,
  maxArity = Number.POSITIVE_INFINITY,
): IrFunction {
  const defs = new Map<IrValueId, IrInstr>();
  const uses = new Map<IrValueId, number>();
  const consumedByConcat = new Set<IrValueId>();
  const addUse = (value: IrValueId): void => {
    uses.set(value, (uses.get(value) ?? 0) + 1);
  };

  const instructionBuffers = [
    ...fn.blocks.map((block) => block.instrs),
    ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
  ];
  for (const buffer of instructionBuffers) {
    for (const root of buffer) {
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null) defs.set(instr.result, instr);
        for (const value of collectUses(instr)) addUse(value);
        if (instr.kind === "string.concat") {
          consumedByConcat.add(instr.lhs);
          consumedByConcat.add(instr.rhs);
        }
      });
    }
  }
  for (const block of fn.blocks) recordTerminatorUses(block, addUse);
  recordAsyncPlanUses(fn, addUse);

  const flatten = (value: IrValueId, out: IrValueId[]): void => {
    const producer = defs.get(value);
    if (immutableConcat(producer) && (uses.get(value) ?? 0) === 1) {
      flatten(producer.lhs, out);
      flatten(producer.rhs, out);
      return;
    }
    out.push(value);
  };

  const coalescibleLiteral = (value: IrValueId): IrInstrStringConst | undefined => {
    const producer = defs.get(value);
    if (
      producer?.kind !== "string.const" ||
      producer.result === null ||
      producer.storage !== undefined ||
      producer.materializer !== undefined ||
      (uses.get(value) ?? 0) !== 1
    ) {
      return undefined;
    }
    if (registry && (producer.alloc === undefined || registry.resolve(producer.alloc) === null)) return undefined;
    return producer;
  };

  type RootRewrite =
    | { readonly kind: "const"; readonly value: string }
    | { readonly kind: "concat"; readonly args: readonly [IrValueId, IrValueId] }
    | { readonly kind: "many"; readonly args: readonly IrValueId[] };
  const rootRewrites = new Map<IrValueId, RootRewrite>();
  const literalValues = new Map<IrValueId, string>();
  const strippedLiteralAllocs = new Set<IrValueId>();

  const aliasLiteralRun = (
    members: readonly IrInstrStringConst[],
    survivor: IrInstrStringConst,
    combinedValue: string,
  ): void => {
    literalValues.set(survivor.result!, combinedValue);
    if (!registry || survivor.alloc === undefined) return;
    for (const member of members) {
      if (member === survivor || member.alloc === undefined) continue;
      registry.alias(member.alloc, survivor.alloc);
      strippedLiteralAllocs.add(member.result!);
    }
    registry.annotate(survivor.alloc, ALLOC_NAMESPACES.encoding, classifyLiteral(combinedValue));
  };

  // Plan every maximal root before rewriting any instruction. Literal defs
  // precede their concat root in a buffer, so discovering a fusion while
  // mapping would otherwise be too late to rewrite the surviving literal.
  for (const buffer of instructionBuffers) {
    for (const root of buffer) {
      forEachInstrDeep(root, (instr) => {
        if (!immutableConcat(instr) || instr.result === null || consumedByConcat.has(instr.result)) return;
        const flatArgs: IrValueId[] = [];
        flatten(instr.lhs, flatArgs);
        flatten(instr.rhs, flatArgs);

        const args: IrValueId[] = [];
        const runs: { readonly members: readonly IrInstrStringConst[]; readonly value: string }[] = [];
        for (let index = 0; index < flatArgs.length; ) {
          const first = coalescibleLiteral(flatArgs[index]!);
          if (!first) {
            args.push(flatArgs[index]!);
            index++;
            continue;
          }
          const members: IrInstrStringConst[] = [first];
          let cursor = index + 1;
          while (cursor < flatArgs.length) {
            const next = coalescibleLiteral(flatArgs[cursor]!);
            if (!next) break;
            members.push(next);
            cursor++;
          }
          if (members.length < 2) {
            args.push(flatArgs[index]!);
          } else {
            args.push(first.result!);
            runs.push({ members, value: members.map(({ value }) => value).join("") });
          }
          index = cursor;
        }

        const changedArgs = runs.length > 0;
        // The host backend can import every observed arity. Native strings use
        // fixed helpers whose current contract stops at eight operands; keep
        // a larger tree pairwise instead of creating an intrinsic the backend
        // cannot materialize during sealed preparation.
        if (args.length > maxArity) return;
        if (!changedArgs && flatArgs.length < 3) return;
        if (args.length === 1) {
          const only = coalescibleLiteral(args[0]!);
          if (!only || (registry && (instr.alloc === undefined || registry.resolve(instr.alloc) === null))) return;
          const value = runs[0]?.value ?? only.value;
          rootRewrites.set(instr.result, { kind: "const", value });
          if (registry && instr.alloc !== undefined) {
            for (const run of runs) {
              for (const member of run.members) {
                if (member.alloc !== undefined) registry.alias(member.alloc, instr.alloc);
                strippedLiteralAllocs.add(member.result!);
              }
            }
            registry.annotate(instr.alloc, ALLOC_NAMESPACES.encoding, classifyLiteral(value));
          }
          return;
        }

        for (const run of runs) aliasLiteralRun(run.members, run.members[0]!, run.value);
        rootRewrites.set(
          instr.result,
          args.length === 2 ? { kind: "concat", args: [args[0]!, args[1]!] } : { kind: "many", args },
        );
      });
    }
  }

  if (rootRewrites.size === 0) return fn;

  const rewriteBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] => {
    let bufferChanged = false;
    const rewritten = buffer.map((original) => {
      let instr = mapNestedBuffers(original, rewriteBuffer);
      if (instr !== original) bufferChanged = true;

      if (instr.kind === "string.const" && instr.result !== null) {
        const value = literalValues.get(instr.result);
        const stripAlloc = strippedLiteralAllocs.has(instr.result) && instr.alloc !== undefined;
        if (value !== undefined || stripAlloc) {
          const { alloc: _alloc, ...withoutAlloc } = instr;
          instr = {
            ...(stripAlloc ? withoutAlloc : instr),
            ...(value === undefined ? {} : { value }),
          };
          bufferChanged = true;
        }
      }

      if (!immutableConcat(instr) || instr.result === null) return instr;
      const plan = rootRewrites.get(instr.result);
      if (!plan) return instr;
      bufferChanged = true;
      if (plan.kind === "const") {
        return {
          kind: "string.const",
          value: plan.value,
          result: instr.result,
          resultType: instr.resultType,
          ...(instr.site === undefined ? {} : { site: instr.site }),
          ...(instr.alloc === undefined ? {} : { alloc: instr.alloc }),
        } satisfies IrInstr;
      }
      if (plan.kind === "concat") {
        return { ...instr, lhs: plan.args[0], rhs: plan.args[1] };
      }
      return {
        kind: "call",
        target: irIntrinsicFuncRef(irStringConcatManySymbol(plan.args.length)),
        args: plan.args,
        result: instr.result,
        resultType: instr.resultType,
        ...(instr.site === undefined ? {} : { site: instr.site }),
        ...(instr.alloc === undefined ? {} : { alloc: instr.alloc }),
      } satisfies IrInstr;
    });
    return bufferChanged ? rewritten : buffer;
  };

  const rewrittenBlocks = fn.blocks.map((block) => {
    const instrs = rewriteBuffer(block.instrs);
    return instrs === block.instrs ? block : { ...block, instrs };
  });
  const asyncPlan = fn.asyncPlan
    ? (() => {
        const states = fn.asyncPlan.states.map((state) => {
          const body = rewriteBuffer(state.body);
          return body === state.body ? state : { ...state, body };
        });
        return states.every((state, index) => state === fn.asyncPlan!.states[index])
          ? fn.asyncPlan
          : { ...fn.asyncPlan, states };
      })()
    : undefined;
  const blocksChanged = rewrittenBlocks.some((block, index) => block !== fn.blocks[index]);
  if (!blocksChanged && asyncPlan === fn.asyncPlan) return fn;
  return {
    ...fn,
    blocks: blocksChanged ? rewrittenBlocks : fn.blocks,
    ...(asyncPlan ? { asyncPlan } : {}),
  };
}
