// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4542 — lower rewritten handle IR to a real `Instr[]` stream.
//
// The pass's correctness claim is about EMITTED CODE, so it is checked against
// emitted code: `cleanup` becomes `try … catch_all … rethrow`, `free` becomes a
// `call` to the engine's release entry point, `break`/`continue` become `br`
// with computed depths. Asserting on this stream is what makes the discipline
// testable with no engine present.
//
// Two operands this IR deliberately does not model — the `JSContext *` and the
// scalar arguments of an engine call (atoms, lengths, flags) — are supplied by
// caller-provided hooks. #4541's lowering owns those; inventing them here would
// bake a value encoding this pass must not assume.

import type { Instr } from "../../ir/types.js";
import type { HandleFunction, HandleId, HandleStmt } from "./handle-ir.js";

export interface RefcountRuntime {
  /** Function index of the engine's `JS_DupValue` shim. */
  dupFuncIdx: number;
  /** Function index of the engine's `JS_FreeValue` shim. */
  freeFuncIdx: number;
  /** Does the free shim leave a value on the stack? */
  freeReturnsValue?: boolean;
  /** Function index for each engine callee, keyed as the handle IR names it. */
  calleeFuncIdx: ReadonlyMap<string, number>;
  /** Wasm local index holding each handle. */
  handleLocal: ReadonlyMap<HandleId, number>;
  /** Instructions that push the `JSContext *`. */
  emitContext(): Instr[];
  /** Instructions that push argument `index` of `callee` (a non-handle operand). */
  emitScalarArg?(callee: string, index: number): Instr[];
  /** Instructions that push an `if` predicate. */
  emitCondition?(): Instr[];
  /** Instructions for a `use` marker. Nothing, by default. */
  emitUse?(handle: HandleId): Instr[];
  /** Instructions for an `opaque` statement. Nothing, by default. */
  emitOpaque?(note: string | undefined): Instr[];
  /** Exception tag index for an explicit `throw`. */
  throwTagIdx?: number;
  /** Does a callee leave a value that must be dropped when unused? */
  calleeReturnsValue?: ReadonlyMap<string, boolean>;
}

interface LabelEntry {
  label?: string;
  /** Which handle-IR branch this wasm label is the target of. */
  target?: "break" | "continue";
}

export class RefcountLoweringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefcountLoweringError";
  }
}

/** Lower a rewritten handle function body to Wasm instructions. */
export function lowerHandleFunction(func: HandleFunction, rt: RefcountRuntime): Instr[] {
  const stack: LabelEntry[] = [];

  const localOf = (h: HandleId): number => {
    const idx = rt.handleLocal.get(h);
    if (idx === undefined) {
      throw new RefcountLoweringError(`refcount lowering: no Wasm local assigned to handle h${h} in ${func.name}.`);
    }
    return idx;
  };

  const depthTo = (label: string, target: "break" | "continue"): number => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].label === label && stack[i].target === target) return stack.length - 1 - i;
    }
    throw new RefcountLoweringError(
      `refcount lowering: no Wasm label for '${target} ${label}' in ${func.name}. ` +
        "The handle-scope pass should have rejected this earlier.",
    );
  };

  /** `qjs_free_value(ctx, h)` — void in the pinned shim. */
  const freeCall = (h: HandleId): Instr[] => {
    const out: Instr[] = [
      ...rt.emitContext(),
      { op: "local.get", index: localOf(h) },
      { op: "call", funcIdx: rt.freeFuncIdx },
    ];
    if (rt.freeReturnsValue) out.push({ op: "drop" });
    return out;
  };

  /** `qjs_dup(ctx, h) -> h2` — a NEW handle, stored into its own local. */
  const dupCall = (from: HandleId, to: HandleId): Instr[] => [
    ...rt.emitContext(),
    { op: "local.get", index: localOf(from) },
    { op: "call", funcIdx: rt.dupFuncIdx },
    { op: "local.set", index: localOf(to) },
  ];

  function lower(stmts: readonly HandleStmt[]): Instr[] {
    const out: Instr[] = [];
    for (const s of stmts) {
      switch (s.kind) {
        case "call": {
          const funcIdx = rt.calleeFuncIdx.get(s.callee);
          if (funcIdx === undefined) {
            throw new RefcountLoweringError(`refcount lowering: no function index for callee '${s.callee}'.`);
          }
          for (let k = 0; k < s.args.length; k++) {
            const h = s.args[k];
            if (h === null) out.push(...(rt.emitScalarArg?.(s.callee, k) ?? [{ op: "i32.const", value: 0 }]));
            else out.push({ op: "local.get", index: localOf(h) });
          }
          out.push({ op: "call", funcIdx });
          if (s.dest !== undefined) out.push({ op: "local.set", index: localOf(s.dest) });
          else if (rt.calleeReturnsValue?.get(s.callee)) out.push({ op: "drop" });
          break;
        }
        case "dup":
          out.push(...dupCall(s.value, s.dest));
          break;
        case "free":
          out.push(...freeCall(s.value));
          break;
        case "use":
          out.push(...(rt.emitUse?.(s.value) ?? []));
          break;
        case "opaque":
          out.push(...(rt.emitOpaque?.(s.note) ?? []));
          break;
        case "scope":
          // No control-flow meaning of its own; the releases are already placed.
          out.push(...lower(s.body));
          break;
        case "if": {
          out.push(...(rt.emitCondition?.() ?? [{ op: "i32.const", value: 1 }]));
          stack.push({});
          const then = lower(s.then);
          const otherwise = s.else ? lower(s.else) : undefined;
          stack.pop();
          out.push({
            op: "if",
            blockType: { kind: "empty" },
            then,
            else: otherwise,
          });
          break;
        }
        case "block": {
          stack.push({ label: s.label, target: "break" });
          const body = lower(s.body);
          stack.pop();
          out.push({ op: "block", blockType: { kind: "empty" }, body });
          break;
        }
        case "loop": {
          // `break L` exits the loop and `continue L` restarts it, so the wasm
          // shape is the standard pair: a `block` for the exit edge wrapping a
          // `loop` for the back edge. A bare wasm `loop` label is the TOP, which
          // is why a single construct cannot serve both.
          stack.push({ label: s.label, target: "break" });
          stack.push({ label: s.label, target: "continue" });
          const body = lower(s.body);
          stack.pop();
          stack.pop();
          out.push({
            op: "block",
            blockType: { kind: "empty" },
            body: [{ op: "loop", blockType: { kind: "empty" }, body }],
          });
          break;
        }
        case "cleanup": {
          stack.push({});
          const body = lower(s.body);
          const unwind = lower(s.unwind);
          stack.pop();
          out.push({
            op: "try",
            blockType: { kind: "empty" },
            body,
            catches: [],
            catchAll: [...unwind, { op: "rethrow", depth: 0 }],
          });
          break;
        }
        case "break":
          out.push({ op: "br", depth: depthTo(s.label, "break") });
          break;
        case "continue":
          out.push({ op: "br", depth: depthTo(s.label, "continue") });
          break;
        case "return":
          if (s.value !== undefined) out.push({ op: "local.get", index: localOf(s.value) });
          out.push({ op: "return" });
          break;
        case "throw": {
          if (rt.throwTagIdx === undefined) {
            throw new RefcountLoweringError(
              `refcount lowering: ${func.name} contains an explicit throw but no exception tag was supplied.`,
            );
          }
          if (s.value !== undefined) out.push({ op: "local.get", index: localOf(s.value) });
          out.push({ op: "throw", tagIdx: rt.throwTagIdx });
          break;
        }
      }
    }
    return out;
  }

  return lower(func.body);
}

/** Flatten an instruction tree, depth-first — the shape assertions read this. */
export function* flattenInstrs(instrs: readonly Instr[]): Iterable<Instr> {
  for (const i of instrs) {
    yield i;
    if (i.op === "block" || i.op === "loop") yield* flattenInstrs(i.body);
    else if (i.op === "if") {
      yield* flattenInstrs(i.then);
      if (i.else) yield* flattenInstrs(i.else);
    } else if (i.op === "try") {
      yield* flattenInstrs(i.body);
      for (const c of i.catches) yield* flattenInstrs(c.body);
      if (i.catchAll) yield* flattenInstrs(i.catchAll);
    }
  }
}

/** Count `call funcIdx` occurrences anywhere in an instruction tree. */
export function countCalls(instrs: readonly Instr[], funcIdx: number): number {
  let n = 0;
  for (const i of flattenInstrs(instrs)) if (i.op === "call" && i.funcIdx === funcIdx) n++;
  return n;
}
