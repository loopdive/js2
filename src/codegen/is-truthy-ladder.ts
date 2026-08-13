// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Read the emitted `__is_truthy` body back and recover its ToBoolean
 * ladder as data, so the call-site fast path in `is-truthy-inline-ic.ts` can be
 * a LITERAL COPY of an arm rather than a re-derivation of what the arm ought to
 * be.
 *
 * ## Why extract instead of rebuild
 *
 * `addUnionImportsAsNativeFuncs` builds the body from `ctx` state that is not
 * all reachable at finalize: the `$AnyValue` arm exists only under
 * `undefinedSingletonActive`, the `$AnyString` arm only when a native-string
 * type is registered, and #4173's `fastStrictEq` changes how the operand is
 * internalized. Re-deriving those conditions in a second place would create two
 * sources of truth that can silently diverge — and a truthiness answer that
 * diverges from the helper is a WRONG ANSWER, not a slow path. Reading the
 * ladder out of the body it will shadow makes divergence impossible by
 * construction: if the body ever changes shape, extraction fails the shape
 * check and the whole pass declines.
 *
 * ## The shape it accepts (and nothing else)
 *
 *     local.get 0 ; ref.is_null ; if { i32.const 0 ; return }
 *     (local.get 0 ; any.convert_extern ; local.tee $any | local.get $any)*
 *     ref.test $T ; if { local.get $any ; <tail…> ; return }        ×N
 *     i32.const 1                                                   (default)
 *
 * Every arm tail must be straight-line arithmetic over `$any` and at most one
 * scratch local — no calls, no branches, no other locals, no parameter reads.
 * Anything else and the arm is not extracted, so it can never be inlined.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** One extracted `ref.test $T -> <tail>` arm of the ToBoolean ladder. */
export interface TruthyArm {
  /** Heap type tested (`-20` = i31, otherwise a concrete struct index). */
  typeIdx: number;
  /** Short stable name used by the flag's arm selector (`i31`, `boxbool`, …). */
  name: string;
  /** Arm body with the leading `local.get $any` and trailing `return` removed. */
  tail: Instr[];
  /** True when `tail` uses the helper's f64 scratch local. */
  usesF64Scratch: boolean;
}

export interface TruthyLadder {
  arms: TruthyArm[];
  /** Local index holding the internalized (anyref) operand inside the helper. */
  anyLocal: number;
  /** Local index of the helper's f64 scratch, when one exists. */
  f64Local: number;
}

/** Ops an arm tail may contain. Anything else declines the arm. */
const TAIL_OPS = new Set([
  "ref.cast",
  "struct.get",
  "struct.get_s",
  "struct.get_u",
  "i31.get_s",
  "i31.get_u",
  "array.len",
  "local.get",
  "local.tee",
  "i32.const",
  "f64.const",
  "i64.const",
  "i32.eq",
  "i32.ne",
  "i32.eqz",
  "i32.and",
  "i32.or",
  "i32.gt_u",
  "i32.lt_u",
  "i32.gt_s",
  "i32.lt_s",
  "f64.eq",
  "f64.ne",
  "i64.eqz",
]);

type AnyInstr = Instr & { op: string; index?: number; typeIdx?: number; then?: Instr[]; else?: Instr[] };

/** Human-stable arm name, so the flag can select arms by meaning not position. */
function armName(ctx: CodegenContext, typeIdx: number): string {
  if (typeIdx === -20) return "i31";
  if (typeIdx === ctx.anyValueTypeIdx) return "anyval";
  if (typeIdx === ctx.nativeBoxNumberTypeIdx) return "boxnum";
  if (typeIdx === ctx.nativeBoxBooleanTypeIdx) return "boxbool";
  if (typeIdx === ctx.nativeBigIntTypeIdx) return "bigint";
  if (typeIdx === ctx.anyStrTypeIdx) return "str";
  return `t${typeIdx}`;
}

/** `local.get 0 ; ref.is_null ; if { i32.const 0 ; return }` — required prologue. */
function matchesNullPrologue(body: Instr[]): boolean {
  const a = body[0] as AnyInstr | undefined;
  const b = body[1] as AnyInstr | undefined;
  const c = body[2] as AnyInstr | undefined;
  if (a?.op !== "local.get" || a.index !== 0) return false;
  if (b?.op !== "ref.is_null") return false;
  if (c?.op !== "if" || !Array.isArray(c.then) || c.else !== undefined) return false;
  const t0 = c.then[0] as AnyInstr | undefined;
  const t1 = c.then[1] as AnyInstr | undefined;
  return c.then.length === 2 && t0?.op === "i32.const" && (t0 as { value?: number }).value === 0 && t1?.op === "return";
}

/**
 * Validate an arm's `then` block and strip its framing. Returns the tail
 * (everything between the leading `local.get $any` and the trailing `return`)
 * or `undefined` when the arm is not a pure straight-line read of `$any`.
 */
function extractTail(
  then: Instr[],
  anyLocal: number,
  f64Local: number,
): { tail: Instr[]; usesF64: boolean } | undefined {
  if (then.length < 2) return undefined;
  const first = then[0] as AnyInstr;
  const last = then[then.length - 1] as AnyInstr;
  if (first.op !== "local.get" || first.index !== anyLocal) return undefined;
  if (last.op !== "return") return undefined;
  const tail = then.slice(1, -1);
  let usesF64 = false;
  for (const raw of tail) {
    const i = raw as AnyInstr;
    if (!TAIL_OPS.has(i.op)) return undefined;
    if (i.op === "local.get" || i.op === "local.tee") {
      if (i.index === anyLocal) continue;
      if (i.index === f64Local) {
        usesF64 = true;
        continue;
      }
      return undefined; // touches a local this pass cannot re-home
    }
  }
  return { tail, usesF64 };
}

/**
 * Recover the ladder from `__is_truthy`'s body, or `undefined` when the body
 * does not have exactly the accepted shape.
 *
 * `f64Local` is taken as "the first local that is not `anyLocal`" — the helper
 * declares `$any_temp` then `$f64_temp`, and `extractTail` rejects any arm that
 * reads a local outside that pair, so a mis-guess cannot widen what is copied.
 */
export function extractTruthyLadder(ctx: CodegenContext, body: Instr[], numParams: number): TruthyLadder | undefined {
  if (!matchesNullPrologue(body)) return undefined;
  const anyLocal = numParams; // first declared local ($any_temp)
  const f64Local = numParams + 1;
  const arms: TruthyArm[] = [];
  let i = 3;
  while (i < body.length) {
    const cur = body[i] as AnyInstr;
    // Operand-internalization filler between arms — skipped, never copied.
    if (
      (cur.op === "local.get" && (cur.index === 0 || cur.index === anyLocal)) ||
      cur.op === "any.convert_extern" ||
      (cur.op === "local.tee" && cur.index === anyLocal)
    ) {
      i++;
      continue;
    }
    if (cur.op !== "ref.test" || cur.typeIdx === undefined) break;
    const next = body[i + 1] as AnyInstr | undefined;
    if (next?.op !== "if" || !Array.isArray(next.then) || next.else !== undefined) return undefined;
    const got = extractTail(next.then, anyLocal, f64Local);
    if (!got) return undefined;
    arms.push({ typeIdx: cur.typeIdx, name: armName(ctx, cur.typeIdx), tail: got.tail, usesF64Scratch: got.usesF64 });
    i += 2;
  }
  // The only thing that may remain is the ladder's `-> truthy` default.
  const restIsDefault = body.length - i === 1 && (body[i] as AnyInstr | undefined)?.op === "i32.const";
  if (!restIsDefault || arms.length === 0) return undefined;
  return { arms, anyLocal, f64Local };
}
