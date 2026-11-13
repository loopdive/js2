// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7194) Can code that runs in this module ever hold an ECMAScript Object as a
 * value? Asked at finalize, over the functions the #6768 sweep would keep.
 *
 * Every Object on a WasmGC lane is a `struct.new`: a plain object, an array
 * (a `__vec_*` struct over its backing array), a closure, a wrapper, a Date,
 * a class instance. So the question is whether a live body or a global
 * initializer creates a struct that is not a primitive's carrier
 * (`primitiveAllocationTypes`, the list the #6651 runtime carrier test shares).
 * A raw `array.new*` is never an Object by itself (it is the backing store of
 * a string, a vec or a runtime table).
 *
 * One Object needs care: the runtime's own error constructors
 * (`__new_TypeError`, …) are live in almost every module because a primitive
 * helper can throw. Such an error is a value only if code can catch it, or if
 * a constructor's result is used for anything but an immediate `throw` (as a
 * source `new Error()` does). Otherwise it never reaches a comparison.
 *
 * The answer errs one way only: an unrecognised struct type counts as an
 * Object, and an indirect call counts as keeping an error.
 *
 * Both scans use the shared DAG walk (`walkInstructionDag`): finalized bodies
 * share child arrays, and an edge walk over them can be exponential.
 *
 * Its consumer is a function whose body handles Objects in a prelude that is
 * dead when none can exist (the loose-equality provider's ToPrimitive
 * reduction). It registers that body as provisional; `settleObjectPreludes`
 * keeps it or swaps in the Object-free body at finalize, before the #6768
 * sweep. Liveness is measured with the Object-free bodies in place, so a
 * prelude's own callees cannot vouch for it. Only bodies change: no index
 * moves. This module imports nothing from the codegen import cycle, so the
 * finalize pass that calls it stays outside that cycle.
 */
import type { Instr, WasmFunction, WasmModule } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { walkChildren, walkInstructionDag } from "../../wasm/model/instruction-walk.js";
import { definedPosition, reachableFunctionPositions } from "../function-reachability-sweep.js";
import { primitiveAllocationTypes } from "../object-model/primitive-carrier-test.js";

/** Provisional bodies per module: the function, and the body it keeps when no Object can exist. */
const provisional = new WeakMap<WasmModule, { fn: WasmFunction; withoutObjects: Instr[] }[]>();

/**
 * Keep `fn`'s current body only if the module can hold an Object; otherwise it
 * becomes `withoutObjects`, which reads only the parameters (its locals go).
 */
export function keepBodyOnlyWithObjects(mod: WasmModule, fn: WasmFunction, withoutObjects: Instr[]): void {
  const list = provisional.get(mod) ?? [];
  list.push({ fn, withoutObjects });
  provisional.set(mod, list);
}

/** Finalize, before the function sweep: settle every provisional body of `ctx.mod`. */
export function settleObjectPreludes(ctx: CodegenContext): void {
  const list = provisional.get(ctx.mod);
  if (list === undefined) return;
  provisional.delete(ctx.mod);
  const withObjects = list.map(({ fn }) => ({ body: fn.body, locals: fn.locals }));
  for (const { fn, withoutObjects } of list) {
    fn.body = withoutObjects;
    fn.locals = [];
  }
  if (!moduleCanHoldObject(ctx, reachableFunctionPositions(ctx.mod))) return;
  list.forEach(({ fn }, i) => Object.assign(fn, withObjects[i]));
}

/** True when a live function or a global initializer can produce an Object value. */
function moduleCanHoldObject(ctx: CodegenContext, live: Uint8Array): boolean {
  const { mod } = ctx;
  const primitives = primitiveAllocationTypes(ctx);
  const errorCtors = new Set<number>();
  let objectCreated = false;
  // A fresh visited set per body: an error constructor is recognised by the function it sits in.
  const scanAllocations = (body: Instr[], pos: number): void =>
    walkInstructionDag(body, (instr) => {
      if (instr.op !== "struct.new" || primitives.has(instr.typeIdx)) return;
      const inErrorCtor =
        pos >= 0 && instr.typeIdx === ctx.errorStructTypeIdx && mod.functions[pos]!.name.startsWith("__new_");
      if (inErrorCtor) errorCtors.add(pos);
      else objectCreated = true;
    });
  for (const global of mod.globals) scanAllocations(global.init, -1);
  mod.functions.forEach((fn, pos) => {
    if (live[pos] === 1) scanAllocations(fn.body, pos);
  });
  return objectCreated || (errorCtors.size > 0 && errorValueReachable(mod, live, errorCtors));
}

const INDIRECT_CALLS: ReadonlySet<string> = new Set(["call_ref", "return_call_ref", "call_indirect"]);

/**
 * Can an error that a runtime constructor in `ctors` creates become a value?
 * Yes if live code catches exceptions, makes an indirect call (its target may
 * be a constructor whose result it keeps), or calls a constructor and does
 * anything with the result but `throw` it at once.
 */
function errorValueReachable(mod: WasmModule, live: Uint8Array, ctors: Set<number>): boolean {
  const numImportFuncs = mod.imports.filter((imp) => imp.desc.kind === "func").length;
  const isCtorCall = (instr: Instr): boolean =>
    (instr.op === "call" || instr.op === "return_call") &&
    ctors.has(definedPosition(mod, numImportFuncs, instr.funcIdx));
  const keepsResult = (seq: readonly Instr[]): boolean =>
    seq.some((instr, i) => isCtorCall(instr) && (instr.op === "return_call" || seq[i + 1]?.op !== "throw"));
  let reachable = false;
  const visited = new WeakSet<Instr[]>();
  const visit = (instr: Instr): void => {
    if (instr.op === "try") reachable ||= instr.catches.length > 0 || instr.catchAll !== undefined;
    else if (instr.op === "try_table") reachable ||= instr.catches.length > 0;
    else if (INDIRECT_CALLS.has(instr.op)) reachable = true;
    walkChildren(instr, (seq) => {
      reachable ||= keepsResult(seq);
    });
  };
  for (let pos = 0; pos < mod.functions.length && !reachable; pos++) {
    if (live[pos] !== 1) continue;
    const { body } = mod.functions[pos]!;
    reachable = keepsResult(body);
    walkInstructionDag(body, visit, visited);
  }
  return reachable;
}
