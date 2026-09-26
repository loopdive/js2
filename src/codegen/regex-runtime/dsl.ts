// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6677 — a small structured builder for hand-authored Wasm helper bodies.
 *
 * The runtime RegExp compiler (`regex-runtime/*`) is a few dozen Wasm helper
 * functions written as `Instr[]`. Writing those with raw `br` depths is the
 * classic source of silent mis-targeted branches: every enclosing `if` shifts
 * the depth. This module lets a body name its `block`/`loop` targets instead
 * and resolves the names to depths ONCE, in {@link resolveLabels}, when the
 * function is finalized. It adds nothing to the emitted Wasm — the output is
 * ordinary `Instr[]`.
 */
import type { BlockType, Instr, ValType } from "../../ir/types.js";

/** A value-producing (or statement) instruction sequence. */
export type X = Instr[];

export const I32: ValType = { kind: "i32" };
const EMPTY: BlockType = { kind: "empty" };

/** Label names attached to `block`/`loop` instrs and to pseudo-branches. */
const containerLabel = new WeakMap<object, string>();
const branchLabel = new WeakMap<object, string>();

export const c = (value: number): X => [{ op: "i32.const", value: value | 0 }];
export const get = (index: number): X => [{ op: "local.get", index }];
export const set = (index: number, ...value: X[]): X => [...value.flat(), { op: "local.set", index }];
export const tee = (index: number, ...value: X[]): X => [...value.flat(), { op: "local.tee", index }];
export const drop = (value: X): X => [...value, { op: "drop" }];

type BinOp =
  | "i32.add"
  | "i32.sub"
  | "i32.mul"
  | "i32.and"
  | "i32.or"
  | "i32.xor"
  | "i32.shl"
  | "i32.shr_s"
  | "i32.shr_u"
  | "i32.eq"
  | "i32.ne"
  | "i32.lt_s"
  | "i32.le_s"
  | "i32.gt_s"
  | "i32.ge_s"
  | "i32.lt_u"
  | "i32.le_u"
  | "i32.gt_u"
  | "i32.ge_u"
  | "i32.div_s"
  | "i32.rem_s";
const bin =
  (op: BinOp) =>
  (a: X, b: X): X => [...a, ...b, { op } as Instr];
export const add = bin("i32.add");
export const sub = bin("i32.sub");
export const mul = bin("i32.mul");
export const and = bin("i32.and");
export const or = bin("i32.or");
export const shl = bin("i32.shl");
export const shrU = bin("i32.shr_u");
export const eq = bin("i32.eq");
export const ne = bin("i32.ne");
export const lt = bin("i32.lt_s");
export const le = bin("i32.le_s");
export const gt = bin("i32.gt_s");
export const ge = bin("i32.ge_s");
export const remS = bin("i32.rem_s");
export const eqz = (a: X): X => [...a, { op: "i32.eqz" }];
export const inc = (local: number, by = 1): X => set(local, add(get(local), c(by)));
/** `lo <= v && v <= hi` for constant bounds (both operands evaluated). */
export const between = (v: X, lo: number, hi: number): X => and(ge(v, c(lo)), le(v, c(hi)));
/** OR of several i32 truth values. */
export const anyOf = (...conds: X[]): X => conds.reduce((acc, next) => or(acc, next));
/** AND of several i32 truth values. Evaluates EVERY operand — use
 *  {@link andThen} when a later operand is only safe once an earlier holds. */
export const allOf = (...conds: X[]): X => conds.reduce((acc, next) => and(acc, next));

export const if_ = (cond: X, then: X, otherwise?: X): X => [
  ...cond,
  otherwise === undefined || otherwise.length === 0
    ? { op: "if", blockType: EMPTY, then }
    : { op: "if", blockType: EMPTY, then, else: otherwise },
];
/** Value-producing `if`. */
export const sel = (type: ValType, cond: X, then: X, otherwise: X): X => [
  ...cond,
  { op: "if", blockType: { kind: "val", type }, then, else: otherwise },
];
/** Short-circuit `a && b` (as 0/1 when `b` is a truth value). */
export const andThen = (a: X, b: X): X => sel(I32, a, b, c(0));
export const ret = (...value: X[]): X => [...value.flat(), { op: "return" }];
export const call = (funcIdx: number, ...args: X[]): X => [...args.flat(), { op: "call", funcIdx }];

export function block(label: string, body: X): X {
  const instr: Instr = { op: "block", blockType: EMPTY, body };
  containerLabel.set(instr, label);
  return [instr];
}

export function loop(label: string, body: X): X {
  const instr: Instr = { op: "loop", blockType: EMPTY, body };
  containerLabel.set(instr, label);
  return [instr];
}

/** Branch to a named container (resolved by {@link resolveLabels}). */
export function br(label: string): X {
  const instr: Instr = { op: "br", depth: -1 };
  branchLabel.set(instr, label);
  return [instr];
}

export function brIf(label: string, cond: X): X {
  const instr: Instr = { op: "br_if", depth: -1 };
  branchLabel.set(instr, label);
  return [...cond, instr];
}

/**
 * `while (cond) body`. Inside `body`, {@link brk} leaves the loop and
 * {@link cont} re-tests the condition.
 */
export function whileLoop(label: string, cond: X, body: X): X {
  return block(
    `${label}:exit`,
    loop(`${label}:top`, [...brIf(`${label}:exit`, eqz(cond)), ...body, ...br(`${label}:top`)]),
  );
}
export const brk = (label: string): X => br(`${label}:exit`);
export const cont = (label: string): X => br(`${label}:top`);

/**
 * Replace every labelled pseudo-branch with its structural depth. Containers
 * without a label (`if`, `try`, unlabelled blocks) still count as one level.
 * Returns fresh containers/branches, so a sub-sequence reused at two nesting
 * depths resolves correctly at each.
 */
export function resolveLabels(body: X): X {
  const stack: Array<string | null> = [];
  const depthOf = (label: string): number => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i] === label) return stack.length - 1 - i;
    }
    throw new Error(`regex-runtime dsl: branch to unknown label '${label}'`);
  };
  const walk = (instrs: X): X =>
    instrs.map((instr): Instr => {
      switch (instr.op) {
        case "block":
        case "loop": {
          stack.push(containerLabel.get(instr) ?? null);
          const body = walk(instr.body);
          stack.pop();
          return { ...instr, body };
        }
        case "if": {
          stack.push(null);
          const then = walk(instr.then);
          const otherwise = instr.else === undefined ? undefined : walk(instr.else);
          stack.pop();
          return otherwise === undefined ? { ...instr, then } : { ...instr, then, else: otherwise };
        }
        case "try": {
          stack.push(null);
          const body = walk(instr.body);
          const catches = instr.catches.map((clause) => ({ ...clause, body: walk(clause.body) }));
          const catchAll = instr.catchAll === undefined ? undefined : walk(instr.catchAll);
          stack.pop();
          return catchAll === undefined ? { ...instr, body, catches } : { ...instr, body, catches, catchAll };
        }
        case "br":
        case "br_if": {
          const label = branchLabel.get(instr);
          return label === undefined ? instr : { ...instr, depth: depthOf(label) };
        }
        default:
          return instr;
      }
    });
  return walk(body);
}

/** Local allocation for one helper body: params first, then named locals. */
export class Locals {
  readonly defs: Array<{ name: string; type: ValType }> = [];
  constructor(private readonly paramCount: number) {}
  add(name: string, type: ValType = I32): number {
    this.defs.push({ name, type });
    return this.paramCount + this.defs.length - 1;
  }
}
