// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3101 / E1 — the register+accumulator dispatch loop + the AOT↔interp call
// protocol (`__interp_enter`). Authored in the js2wasm-compilable subset; the
// pieces that necessarily differ between Node and Wasm are marked as the E1↔E2
// SEAM (see below).
//
// ── Frame-stack machine (doc §"calls", constraint 3 — suspension-ready) ───────
// interp→interp calls do NOT recurse the host stack: a `Call` to an interpreted
// callee pushes a `$Frame` and swaps the loop's cached state, exactly as
// `src/ir/backend/bytecode-vm.ts::runProgram` does (save/restore code+consts+
// regs+pc on Call/Return; call-site-PC rescan on Throw). Only the host boundary
// (host→interp entry, interp→host builtin/callback) uses host recursion. This is
// the shape #2929 suspends by writing pc+regs into the heap `$Frame`.
//
// ── Exception model (side table, not opcodes) ─────────────────────────────────
// The loop wraps dispatch in a `try` (the Node analogue of the Wasm `try_table`
// E4 will use). On catch it scans the current frame's `exnTable` for the
// innermost row covering the throwing PC; on a hit it writes the caught value
// into `regs[handlerReg]` and jumps to `handlerPC`; on a miss it unwinds one
// frame (rescanning the caller at its call-site PC) and, if the stack empties,
// rethrows across the host boundary. `Op.Throw` throws the raw acc value;
// genuine interpreter-invariant violations use {@link InterpInternalError} and
// bypass routing so a loop bug can never be masked by a program `try/catch`.
//
// ── E1↔E2 SEAM ────────────────────────────────────────────────────────────────
// (1) Interpreted-function value: in E1 a *branded JS function* (WeakMap) that
//     calls `interpEnter`; in E2 an ordinary closure struct whose code pointer is
//     the exported `__interp_enter` trampoline and whose capture slot holds the
//     `$FuncMeta` (doc §"Call protocol") — indistinguishable from a compiled
//     closure, so codegen needs zero interpreter-awareness. (2) Host dispatch
//     (`callee.apply`, fixed-arity positional construction) is E1's stand-in
//     for the #3098 classifier / `__apply_closure`. (3) The global env backing
//     (`Object.create(globalThis)`) is E1's stand-in for the module globalThis
//     `$Object` (#369). None of these three change the opcode semantics.

import { Builtin, OP_MASK, Op, OPERAND_MASK, WIDE_FLAG } from "./opcodes.js";
import {
  buildArrayLiteral,
  buildObjectLiteral,
  anyAdd,
  anyDiv,
  anyGe,
  anyGet,
  anyGt,
  anyLe,
  anyLogicalNot,
  anyLooseEq,
  anyLt,
  anyMod,
  anyMul,
  anyNeg,
  anySet,
  anyStrictEq,
  anySub,
  anyTypeof,
  isTruthy,
} from "./runtime-ops.js";
import {
  ENV_DECLARATIVE,
  type EnvRec,
  EXN_ROW,
  FLAG_STRICT,
  Frame,
  type FuncMeta,
  type JSValue,
  type Regs,
} from "./types.js";

/** A genuine interpreter-invariant violation (bad opcode, stalled decode). Never
 *  routed through the exception table — rethrown so it cannot be masked by a
 *  program `try/catch`. */
export class InterpInternalError extends Error {
  constructor(message: string) {
    super(`interp/loop: ${message}`);
    this.name = "InterpInternalError";
  }
}

/** Bounded step guard — a malformed stream (bad backpatch, missing Return) fails
 *  loud instead of hanging. */
const MAX_STEPS = 100000000;

// ── The interpreted-closure brand (E1↔E2 SEAM #1) ────────────────────────────
// A WeakMap keeps the FuncMeta+envRec off the function object itself (so the
// interpreted value's own `name`/`length` stay clean for introspection).
interface InterpBinding {
  meta: FuncMeta;
  envRec: EnvRec | null;
}
const INTERP_BINDINGS: WeakMap<object, InterpBinding> = new WeakMap();

/** Callable carrier shared with the standalone generic closure ABI. */
export type InterpCallable = (
  a0?: JSValue,
  a1?: JSValue,
  a2?: JSValue,
  a3?: JSValue,
  a4?: JSValue,
  a5?: JSValue,
  a6?: JSValue,
  a7?: JSValue,
) => JSValue;

/** Is `v` an interpreted-function value (a branded closure)? */
export function isInterpClosure(v: JSValue): boolean {
  return typeof v === "function" && INTERP_BINDINGS.has(v as object);
}

/** Build an interpreted-function value from a FuncMeta + captured env record. */
export function makeInterpClosure(meta: FuncMeta, envRec: EnvRec | null): InterpCallable {
  // A regular (non-arrow) function so `.prototype` exists for
  // construct/instanceof. Keep eight explicit formal slots: the standalone
  // generic closure dispatcher classifies a rest-only function as arity zero,
  // which would discard the AOT call's arguments before this trampoline runs.
  // Eight is the shared Phase-1 closure ABI ceiling (#3310). Keep the body free
  // of `arguments`: the standalone compiler already pads under-applied closure
  // calls to their declared arity, and its `arguments` side channel belongs to
  // `__apply_closure`, not a statically typed returned closure.
  // Keep this expression anonymous. A named expression currently takes the
  // standalone fnctor-escape path and loses the returned closure carrier.
  const closure: InterpCallable = function (
    this: JSValue,
    a0?: JSValue,
    a1?: JSValue,
    a2?: JSValue,
    a3?: JSValue,
    a4?: JSValue,
    a5?: JSValue,
    a6?: JSValue,
    a7?: JSValue,
  ): JSValue {
    const receiver = (meta.flags & FLAG_STRICT) !== 0 ? this : normalizeSloppyThis(envRec, this);
    return interpEnter(meta, envRec, receiver, [a0, a1, a2, a3, a4, a5, a6, a7]);
  };
  const nm = typeof meta.name === "string" ? meta.name : "";
  try {
    Object.defineProperty(closure, "name", { value: nm, configurable: true });
    Object.defineProperty(closure, "length", { value: meta.paramCount, configurable: true });
  } catch {
    // Non-configurable in some engines — introspection is best-effort in E1.
  }
  INTERP_BINDINGS.set(closure, { meta, envRec });
  return closure;
}

/**
 * Invoke a non-interpreted callable at the runtime boundary.
 *
 * In ordinary TypeScript/Node execution this is exactly Function#apply. The
 * standalone compiler recognizes this deliberately private intrinsic name and
 * lowers it straight to `__apply_closure(callee, receiver, args)`, avoiding a
 * second dynamic lookup of the foreign carrier's `.apply` property.
 */
export function __runtime_eval_apply_callable(
  callee: (...a: JSValue[]) => JSValue,
  receiver: JSValue,
  args: JSValue[],
): JSValue {
  return callee.apply(receiver, args);
}

/**
 * `__interp_enter` — the single exported AOT↔interp trampoline (doc §"Call
 * protocol"). Allocates the bottom `$Frame` (regs from `regCount`), seeds
 * regs[0]=thisArg and regs[1..1+paramCount)=args, runs the loop, returns `acc`.
 */
export function interpEnter(meta: FuncMeta, envRec: EnvRec | null, thisArg: JSValue, args: JSValue[]): JSValue {
  const regs: Regs = new Array(meta.regCount);
  for (let i = 0; i < meta.regCount; i += 1) regs[i] = undefined;
  regs[0] = thisArg;
  const np = args.length < meta.paramCount ? args.length : meta.paramCount;
  for (let i = 0; i < np; i += 1) regs[1 + i] = args[i];
  return run(new Frame(meta, 0, regs, envRec, null));
}

// ── environment resolution (doc §14; Phase 1 = global record only) ────────────
function envLookup(env: EnvRec | null, name: JSValue): JSValue {
  let e = env;
  for (;;) {
    if (e === null) throw new ReferenceError(`${String(name)} is not defined`);
    if (e.kind === ENV_DECLARATIVE) {
      // Declarative records (#2925/#2929) — not constructed in Phase 1.
    } else if (name in e.backing) {
      return e.backing[name];
    }
    e = e.parent;
  }
}

/** Phase-1 functions are non-strict unless/until directive flags land. A bare
 * call therefore substitutes the captured realm's global object for a
 * null/undefined receiver; explicit method receivers pass through unchanged. */
function normalizeSloppyThis(env: EnvRec | null, receiver: JSValue): JSValue {
  if (receiver !== undefined && receiver !== null) return receiver;
  let e = env;
  let globalBacking: JSValue = undefined;
  for (;;) {
    if (e === null) break;
    if (e.kind !== ENV_DECLARATIVE) globalBacking = e.backing;
    e = e.parent;
  }
  return globalBacking;
}
function envAssign(env: EnvRec | null, name: JSValue, value: JSValue): void {
  // Phase 1 (non-strict): assign to the nearest record that already has the
  // binding, else create it on the root global backing. Strict-mode ReferenceError
  // on an undeclared assignment is deferred (#2929).
  let e = env;
  let root: EnvRec | null = null;
  for (;;) {
    if (e === null) break;
    if (e.kind !== ENV_DECLARATIVE && name in e.backing) {
      e.backing[name] = value;
      return;
    }
    root = e;
    e = e.parent;
  }
  if (root !== null && root.kind !== ENV_DECLARATIVE) root.backing[name] = value;
}
function typeofName(env: EnvRec | null, name: JSValue): JSValue {
  // `typeof <undeclared>` must be "undefined", never ReferenceError.
  let e = env;
  for (;;) {
    if (e === null) return "undefined";
    if (e.kind !== ENV_DECLARATIVE && name in e.backing) return typeof e.backing[name];
    e = e.parent;
  }
}

// ── exception-table scan ──────────────────────────────────────────────────────
// Returns the packed [handlerPC, handlerReg] of the innermost (tightest-span)
// covering row, or -1 in `.pc` when there is no handler.
interface Handler {
  pc: number;
  reg: number;
}
function findHandler(exnTable: number[] | null, throwPc: number): Handler {
  if (exnTable === null) return { pc: -1, reg: -1 };
  let bestPc = -1;
  let bestReg = -1;
  let bestSpan = Number.POSITIVE_INFINITY;
  let i = 0;
  const n = exnTable.length;
  for (;;) {
    if (i + EXN_ROW > n) break;
    const s = exnTable[i]!;
    const end = exnTable[i + 1]!;
    if (s <= throwPc && throwPc < end) {
      const span = end - s;
      if (span < bestSpan) {
        bestSpan = span;
        bestPc = exnTable[i + 2]!;
        bestReg = exnTable[i + 3]!;
      }
    }
    i += EXN_ROW;
  }
  return { pc: bestPc, reg: bestReg };
}

/** Run a whole activation to completion, returning its `Return` value. */
function run(bottom: Frame): JSValue {
  // Explicit frame stack (suspended callers) + parallel call-site PCs (needed for
  // correct exn-region coverage on unwind — the return PC is one past the Call,
  // which would fall on `tryEnd` and miss the half-open interval).
  const frames: Frame[] = [];
  const callSites: number[] = [];

  let frame = bottom;
  let meta = frame.meta;
  let code = meta.code;
  let consts = meta.consts;
  let regs = frame.regs;
  let pc = frame.pc;
  let acc: JSValue = undefined;
  let curInstrPc = 0;
  let steps = 0;

  for (;;) {
    try {
      for (;;) {
        steps += 1;
        if (steps > MAX_STEPS) throw new InterpInternalError("step budget exceeded (malformed bytecode?)");
        curInstrPc = pc;
        const word = code[pc]!;
        pc += 1;
        const op = word & OP_MASK;
        const b = (word >>> 20) & OPERAND_MASK;
        let a: number;
        if ((word & WIDE_FLAG) !== 0) {
          a = code[pc]!;
          pc += 1;
        } else {
          a = (word >>> 8) & OPERAND_MASK;
        }

        switch (op) {
          // ── const / register moves ──
          case Op.LdaConst:
            acc = consts[a];
            break;
          case Op.LdaUndef:
            acc = undefined;
            break;
          case Op.LdaNull:
            acc = null;
            break;
          case Op.LdaTrue:
            acc = true;
            break;
          case Op.LdaFalse:
            acc = false;
            break;
          case Op.LdaZero:
            acc = 0;
            break;
          case Op.Star:
            regs[a] = acc;
            break;
          case Op.Ldar:
            acc = regs[a];
            break;
          case Op.Mov:
            regs[b] = regs[a];
            break;

          // ── arithmetic / comparison (acc = op(regs[a], acc)) ──
          case Op.Add:
            acc = anyAdd(regs[a], acc);
            break;
          case Op.Sub:
            acc = anySub(regs[a], acc);
            break;
          case Op.Mul:
            acc = anyMul(regs[a], acc);
            break;
          case Op.Div:
            acc = anyDiv(regs[a], acc);
            break;
          case Op.Mod:
            acc = anyMod(regs[a], acc);
            break;
          case Op.Neg:
            acc = anyNeg(acc);
            break;
          case Op.Not:
            acc = anyLogicalNot(acc);
            break;
          case Op.TypeOf:
            acc = anyTypeof(acc);
            break;
          case Op.Eq:
            acc = anyLooseEq(regs[a], acc);
            break;
          case Op.StrictEq:
            acc = anyStrictEq(regs[a], acc);
            break;
          case Op.Lt:
            acc = anyLt(regs[a], acc);
            break;
          case Op.Le:
            acc = anyLe(regs[a], acc);
            break;
          case Op.Gt:
            acc = anyGt(regs[a], acc);
            break;
          case Op.Ge:
            acc = anyGe(regs[a], acc);
            break;

          // ── property (the shared dynamic MOP) ──
          case Op.GetProp:
            acc = anyGet(acc, consts[a]);
            break;
          case Op.GetElem:
            acc = anyGet(acc, regs[a]);
            break;
          case Op.SetProp:
            acc = anySet(regs[b], consts[a], acc);
            break;
          case Op.SetElem:
            acc = anySet(regs[b], regs[a], acc);
            break;

          // ── variables (env-record chain, doc §14) ──
          case Op.LdGlobal:
          case Op.LdName:
            acc = envLookup(frame.envRec, consts[a]);
            break;
          case Op.StGlobal:
          case Op.StName:
            envAssign(frame.envRec, consts[a], acc);
            break;

          // ── calls ──
          case Op.Call: {
            const base = a;
            const argc = b;
            const callee = acc;
            if (isInterpClosure(callee)) {
              const binding = INTERP_BINDINGS.get(callee as object)!;
              const cm = binding.meta;
              const cregs: Regs = new Array(cm.regCount);
              for (let i = 0; i < cm.regCount; i += 1) cregs[i] = undefined;
              cregs[0] = (cm.flags & FLAG_STRICT) !== 0 ? regs[base] : normalizeSloppyThis(binding.envRec, regs[base]); // receiver → this
              const np = argc < cm.paramCount ? argc : cm.paramCount;
              for (let i = 0; i < np; i += 1) cregs[1 + i] = regs[base + 1 + i];
              // Suspend the caller, install the callee frame (no host recursion).
              frame.pc = pc;
              frames.push(frame);
              callSites.push(curInstrPc);
              frame = new Frame(cm, 0, cregs, binding.envRec, frame);
              meta = cm;
              code = cm.code;
              consts = cm.consts;
              regs = cregs;
              pc = 0;
            } else {
              // Host boundary (E1↔E2 SEAM #2). TypeError on a non-callable is a
              // real JS exception → routed through the exn table like any other.
              if (typeof callee !== "function") {
                throw new TypeError(`${describe(callee)} is not a function`);
              }
              const recv = regs[base];
              const args: JSValue[] = new Array(argc);
              for (let i = 0; i < argc; i += 1) args[i] = regs[base + 1 + i];
              acc = __runtime_eval_apply_callable(callee as (...a: JSValue[]) => JSValue, recv, args);
            }
            break;
          }
          case Op.Construct: {
            const base = a;
            const argc = b;
            const callee = acc;
            const args: JSValue[] = new Array(argc);
            for (let i = 0; i < argc; i += 1) args[i] = regs[base + 1 + i];
            if (isInterpClosure(callee)) {
              const binding = INTERP_BINDINGS.get(callee as object)!;
              const proto = (callee as { prototype?: JSValue }).prototype;
              const self: JSValue = Object.create(proto && typeof proto === "object" ? proto : Object.prototype);
              const r = interpEnter(binding.meta, binding.envRec, self, args); // boundary recursion (Phase 1)
              acc = r !== null && (typeof r === "object" || typeof r === "function") ? r : self;
            } else if (typeof callee === "function") {
              acc = constructValue(callee, args);
            } else {
              throw new TypeError(`${describe(callee)} is not a constructor`);
            }
            break;
          }
          case Op.CallBuiltin: {
            const builtinId = a;
            const base = b;
            const argc = code[pc]!;
            pc += 1;
            acc = callBuiltin(builtinId, regs, base, argc, frame);
            break;
          }

          // ── control (absolute PCs; jumps are always WIDE so `a` = target) ──
          case Op.Jump:
            pc = a;
            break;
          case Op.JumpIfTrue:
            if (isTruthy(acc)) pc = a;
            break;
          case Op.JumpIfFalse:
            if (!isTruthy(acc)) pc = a;
            break;
          case Op.Return: {
            const result = acc;
            if (frames.length === 0) return result;
            const caller = frames.pop()!;
            callSites.pop();
            frame = caller;
            meta = caller.meta;
            code = meta.code;
            consts = meta.consts;
            regs = caller.regs;
            pc = caller.pc;
            acc = result; // callee's result becomes the caller's acc
            break;
          }

          // ── exceptions ──
          case Op.Throw:
            throw new ThrowSignal(acc);

          default:
            throw new InterpInternalError(`unknown opcode ${op} at pc ${curInstrPc}`);
        }
      }
    } catch (e) {
      if (e instanceof InterpInternalError) throw e; // never route interpreter bugs
      const value: JSValue = e instanceof ThrowSignal ? e.value : e;
      // Unwind: scan the current frame, then callers (at their call-site PCs).
      let throwPc = curInstrPc;
      for (;;) {
        const h = findHandler(meta.exnTable, throwPc);
        if (h.pc >= 0) {
          regs[h.reg] = value;
          pc = h.pc;
          break; // resume dispatch at the handler
        }
        if (frames.length === 0) {
          // Escape across the host boundary (E4 replaces this with a Wasm EH tag).
          // Rethrow the RAW value so a host `try/catch` sees the real exception.
          throw value;
        }
        const caller = frames.pop()!;
        const cs = callSites.pop()!;
        frame = caller;
        meta = caller.meta;
        code = meta.code;
        consts = meta.consts;
        regs = caller.regs;
        throwPc = cs;
      }
      // loop back to the outer `for`, re-entering dispatch at the handler pc
    }
  }
}

/**
 * Construct a non-interpreted callable at the E1/E2 runtime seam.
 *
 * Standalone Reflect.construct deliberately accepts only an array-literal
 * argsList (#3371). Keeping the arity dispatch here lets the self-compiled E2
 * payload use positional `new` lowering while Node E1 retains real constructor
 * semantics. Eight arguments matches the generic standalone call/closure ABI
 * raised by #3310; arities above eight remain an explicit Phase-1 limit.
 * Preserving dynamic constructor arguments in AOT code remains the #3098
 * classifier's responsibility.
 */
function constructValue(callee: JSValue, args: JSValue[]): JSValue {
  switch (args.length) {
    case 0:
      return new (callee as new (...a: JSValue[]) => JSValue)();
    case 1:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0]);
    case 2:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0], args[1]);
    case 3:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0], args[1], args[2]);
    case 4:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0], args[1], args[2], args[3]);
    case 5:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0], args[1], args[2], args[3], args[4]);
    case 6:
      return new (callee as new (...a: JSValue[]) => JSValue)(args[0], args[1], args[2], args[3], args[4], args[5]);
    case 7:
      return new (callee as new (...a: JSValue[]) => JSValue)(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
      );
    case 8:
      return new (callee as new (...a: JSValue[]) => JSValue)(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
        args[6],
        args[7],
      );
    default:
      throw new RangeError("interpreter Construct supports at most 8 arguments in Phase 1");
  }
}

/** Op.Throw's carrier so the catch can recover the exact thrown value (which may
 *  itself be an Error, a primitive, or undefined). */
class ThrowSignal {
  readonly value: JSValue;
  constructor(value: JSValue) {
    this.value = value;
  }
}

/** Dispatch an interpreter-intrinsic builtin. Args are regs[base..base+argc). */
function callBuiltin(builtinId: number, regs: Regs, base: number, argc: number, frame: Frame): JSValue {
  switch (builtinId) {
    case Builtin.ObjectLiteral: {
      const pairs: JSValue[] = new Array(argc);
      for (let i = 0; i < argc; i += 1) pairs[i] = regs[base + i];
      return buildObjectLiteral(pairs);
    }
    case Builtin.ArrayLiteral: {
      const elems: JSValue[] = new Array(argc);
      for (let i = 0; i < argc; i += 1) elems[i] = regs[base + i];
      return buildArrayLiteral(elems);
    }
    case Builtin.MakeClosure:
      return makeInterpClosure(regs[base] as FuncMeta, frame.envRec);
    case Builtin.GlobalThis:
      return frame.envRec !== null ? frame.envRec.backing : undefined;
    case Builtin.TypeofName:
      return typeofName(frame.envRec, regs[base]);
    case Builtin.Error:
      return argc === 0 ? new Error() : new Error(String(regs[base]));
    case Builtin.TypeError:
      return argc === 0 ? new TypeError() : new TypeError(String(regs[base]));
    case Builtin.RangeError:
      return argc === 0 ? new RangeError() : new RangeError(String(regs[base]));
    case Builtin.SyntaxError:
      return argc === 0 ? new SyntaxError() : new SyntaxError(String(regs[base]));
    case Builtin.ReferenceError:
      return argc === 0 ? new ReferenceError() : new ReferenceError(String(regs[base]));
    case Builtin.Number:
      return argc === 0 ? 0 : Number(regs[base]);
    case Builtin.MathMax:
      return builtinMathExtremum(regs, base, argc, true);
    case Builtin.MathMin:
      return builtinMathExtremum(regs, base, argc, false);
    case Builtin.MathAbs:
      return Math.abs(Number(regs[base]));
    case Builtin.MathFloor:
      return Math.floor(Number(regs[base]));
    case Builtin.MathCeil:
      return Math.ceil(Number(regs[base]));
    case Builtin.MathRound:
      return Math.round(Number(regs[base]));
    default:
      throw new InterpInternalError(`unknown builtin id ${builtinId}`);
  }
}

/** Host-free Math.max/min over the bytecode argument window. The signed-zero
 * tie-breaks match ECMA-262: max prefers +0 and min prefers -0. */
function builtinMathExtremum(regs: Regs, base: number, argc: number, wantMax: boolean): JSValue {
  let result = wantMax ? -Infinity : Infinity;
  let i = 0;
  for (;;) {
    if (i >= argc) break;
    const value = Number(regs[base + i]);
    if (Number.isNaN(value)) return NaN;
    if (wantMax) {
      if (value > result || (value === 0 && result === 0 && 1 / value === Infinity)) result = value;
    } else if (value < result || (value === 0 && result === 0 && 1 / value === -Infinity)) {
      result = value;
    }
    i += 1;
  }
  return result;
}

/** A short description of a non-callable value for TypeError messages. */
function describe(v: JSValue): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "number" || t === "boolean") return String(v);
  return t;
}
