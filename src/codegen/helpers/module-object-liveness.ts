// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7194) Can code that runs in this module ever hold an ECMAScript Object as a
 * value? Asked at finalize, over the functions the #6768 sweep would keep.
 *
 * Every Object on a WasmGC lane is a `struct.new`: a plain object, an array
 * (a `__vec_*` struct over its backing array), a closure, a wrapper, a Date,
 * a class instance. So the question is whether a live body or a global
 * initializer creates a struct that is not a primitive's carrier. The
 * primitive carriers are the string forms, the number / boolean boxes,
 * `$AnyValue`, BigInt and Symbol. A raw `array.new*` is never an Object by
 * itself (it is the backing store of a string, a vec or a runtime table).
 *
 * One Object needs care: the runtime's own error constructors
 * (`__new_TypeError`, …) are live in almost every module because a primitive
 * helper can throw. Such an error is a value only if code can catch it, or if
 * a constructor's result is used for anything but an immediate `throw` (as a
 * source `new Error()` does). Otherwise it never reaches a comparison.
 *
 * The answer errs one way only: an unrecognised struct type counts as an
 * Object.
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
import { definedPosition, reachableFunctionPositions } from "../function-reachability-sweep.js";

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

/** Struct types that carry a primitive value, never an Object. */
function primitiveCarrierTypes(ctx: CodegenContext): Set<number> {
  return new Set(
    [
      ctx.anyStrTypeIdx,
      ctx.nativeStrTypeIdx,
      ctx.consStrTypeIdx,
      ctx.hashedStrTypeIdx,
      ctx.utf8StrTypeIdx,
      ctx.anyValueTypeIdx,
      ctx.nativeBoxNumberTypeIdx,
      ctx.nativeBoxBooleanTypeIdx,
      ctx.nativeBigIntTypeIdx,
      ctx.symbolTypeIdx,
    ].filter((idx) => idx >= 0),
  );
}

/** Every instruction of `body`, nested blocks included. */
function* instructions(body: readonly Instr[]): Generator<Instr> {
  for (const instr of body) {
    yield instr;
    const n = instr as { body?: Instr[]; then?: Instr[]; else?: Instr[]; catchAll?: Instr[]; catches?: unknown };
    if (n.body) yield* instructions(n.body);
    if (n.then) yield* instructions(n.then);
    if (n.else) yield* instructions(n.else);
    if (n.catchAll) yield* instructions(n.catchAll);
    if (Array.isArray(n.catches))
      for (const c of n.catches as { body?: Instr[] }[]) if (c.body) yield* instructions(c.body);
  }
}

/** Does any of `bodies` catch an exception as a value? */
function catchesExceptions(bodies: readonly (readonly Instr[])[]): boolean {
  for (const body of bodies) {
    for (const instr of instructions(body)) {
      if (instr.op === "try_table" && instr.catches.length > 0) return true;
      if (instr.op === "try" && (instr.catches.length > 0 || instr.catchAll !== undefined)) return true;
    }
  }
  return false;
}

/** Is a call to one of `ctors` used as anything but the operand of an immediate `throw`? */
function errorResultEscapes(mod: WasmModule, bodies: readonly (readonly Instr[])[], ctors: Set<number>): boolean {
  const numImportFuncs = mod.imports.filter((imp) => imp.desc.kind === "func").length;
  const isCtorCall = (instr: Instr | undefined): boolean =>
    (instr?.op === "call" || instr?.op === "return_call") &&
    ctors.has(definedPosition(mod, numImportFuncs, instr.funcIdx));
  for (const body of bodies) {
    const seqs: (readonly Instr[])[] = [body];
    for (const instr of instructions(body)) {
      const n = instr as { body?: Instr[]; then?: Instr[]; else?: Instr[]; catchAll?: Instr[] };
      for (const seq of [n.body, n.then, n.else, n.catchAll]) if (seq) seqs.push(seq);
    }
    for (const seq of seqs) {
      for (let i = 0; i < seq.length; i++) {
        if (isCtorCall(seq[i]) && (seq[i]!.op === "return_call" || seq[i + 1]?.op !== "throw")) return true;
      }
    }
  }
  return false;
}

/** True when a live function or a global initializer can produce an Object value. */
function moduleCanHoldObject(ctx: CodegenContext, live: Uint8Array): boolean {
  const { mod } = ctx;
  const carriers = primitiveCarrierTypes(ctx);
  const liveBodies = mod.functions.filter((_, pos) => live[pos] === 1).map((fn) => fn.body);
  const errorCtors = new Set<number>();
  const createsObject = (body: readonly Instr[], pos: number): boolean => {
    for (const instr of instructions(body)) {
      if (instr.op !== "struct.new" || carriers.has(instr.typeIdx)) continue;
      const ctor =
        pos >= 0 && instr.typeIdx === ctx.errorStructTypeIdx && mod.functions[pos]!.name.startsWith("__new_");
      if (!ctor) return true;
      errorCtors.add(pos);
    }
    return false;
  };
  if (mod.globals.some((g) => createsObject(g.init, -1))) return true;
  for (let pos = 0; pos < mod.functions.length; pos++) {
    if (live[pos] === 1 && createsObject(mod.functions[pos]!.body, pos)) return true;
  }
  if (errorCtors.size === 0) return false;
  return catchesExceptions(liveBodies) || errorResultEscapes(mod, liveBodies, errorCtors);
}
