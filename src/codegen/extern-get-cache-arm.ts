// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Read the per-key cache-hit arm back OUT of the emitted `__extern_get`
 * body, so a call-site copy of it cannot go stale.
 *
 * `unshiftExternGetProtoCacheArm` (object-runtime.ts, #3673 round 9b) prepends
 * the arm; its soundness rests entirely on being **first** in the final body —
 * it is unshifted LAST precisely so a hit short-circuits every ladder unshifted
 * before it. That is also the ONLY reason a call site may answer from the arm
 * without consulting anything else, so this extractor re-establishes the
 * property rather than assuming it: it accepts the body only when the first
 * four instructions ARE the arm, and it hands back the arm's own `then` tree
 * verbatim. Later `__extern_get` fills exist and DO unshift in front of it
 * (`fillDynamicForinVecArms`, `fillObjVecReflectionHelpers`); on a module where
 * one of them fires, the shape check fails and every consumer declines. That is
 * the intended outcome, not a limitation to work around.
 *
 * The `is-truthy-ladder.ts` lesson applied: never re-derive a helper's fast
 * path from a reading of its source. Copy what was emitted, or decline.
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** The extracted arm, plus everything a copier needs to re-home it. */
export interface ExternGetCacheArm {
  /** The arm's `then` body, verbatim. Falls through on a miss. */
  readonly then: readonly Instr[];
  /** `$HashedString` type index the outer guard tested. */
  readonly hstrTypeIdx: number;
  /** Local indices the arm reads/writes, excluding params 0 and 1. */
  readonly scratchLocals: readonly number[];
  /** Nesting depth of the arm's single `return`, counted from `then`'s top level. */
  readonly returnDepth: number;
}

type AnyInstr = Instr & {
  op: string;
  index?: number;
  typeIdx?: number;
  funcIdx?: number;
  body?: Instr[];
  then?: Instr[];
  else?: Instr[];
  blockType?: { kind: string };
};

function isLocalOp(op: string): boolean {
  return op === "local.get" || op === "local.set" || op === "local.tee";
}

/** Walk `instrs`, collecting local indices and locating the single `return`. */
function scan(
  instrs: readonly Instr[],
  depth: number,
  acc: { locals: Set<number>; returns: number[]; calls: number },
): void {
  for (const raw of instrs) {
    const i = raw as AnyInstr;
    if (isLocalOp(i.op) && i.index !== undefined) acc.locals.add(i.index);
    if (i.op === "return") acc.returns.push(depth);
    if (i.op === "call" || i.op === "call_ref" || i.op === "call_indirect") acc.calls++;
    // Any structured instruction adds one frame to a `br` target distance.
    if (Array.isArray(i.body)) scan(i.body, depth + 1, acc);
    if (Array.isArray(i.then)) scan(i.then, depth + 1, acc);
    if (Array.isArray(i.else)) scan(i.else, depth + 1, acc);
  }
}

/**
 * Extract the cache-hit arm from `fn`'s FINAL body, or `undefined` with a
 * reason when the body is not the accepted shape.
 *
 * Accepted shape — exactly what `unshiftExternGetProtoCacheArm` emits:
 *
 *     local.get 1 ; any.convert_extern ; ref.test $HashedString
 *     if (empty) then <arm> end          ;; no `else`
 */
export function extractExternGetCacheArm(
  ctx: CodegenContext,
  fn: WasmFunction,
): { arm?: ExternGetCacheArm; reason?: string } {
  const b = fn.body as AnyInstr[];
  if (b.length < 4) return { reason: "body-too-short" };
  if (b[0]!.op !== "local.get" || b[0]!.index !== 1) return { reason: "prefix-not-key-load" };
  if (b[1]!.op !== "any.convert_extern") return { reason: "prefix-not-convert" };
  if (b[2]!.op !== "ref.test") return { reason: "prefix-not-ref-test" };
  const hstrTypeIdx = b[2]!.typeIdx;
  if (hstrTypeIdx === undefined || hstrTypeIdx !== ctx.hashedStrTypeIdx) return { reason: "prefix-not-hashed-string" };
  const gate = b[3]!;
  if (gate.op !== "if" || gate.blockType?.kind !== "empty") return { reason: "prefix-not-empty-if" };
  if (!Array.isArray(gate.then) || gate.else !== undefined) return { reason: "prefix-if-has-else" };

  const acc = { locals: new Set<number>(), returns: [] as number[], calls: 0 };
  scan(gate.then, 0, acc);
  // One `return` — the value-producing hit. A second would need a second `br`
  // target and is not a shape this extractor claims to understand.
  if (acc.returns.length !== 1) return { reason: `returns=${acc.returns.length}` };
  const scratchLocals = [...acc.locals].filter((i) => i !== 0 && i !== 1).sort((x, y) => x - y);
  // Every scratch must be a declared local (not a param) so a copier can mint
  // a same-typed twin at the site.
  const t = ctx.mod.types[fn.typeIdx];
  const numParams = t && t.kind === "func" ? t.params.length : 2;
  for (const idx of scratchLocals) {
    if (idx < numParams || fn.locals[idx - numParams] === undefined) return { reason: `scratch-local-${idx}` };
  }
  return { arm: { then: gate.then, hstrTypeIdx, scratchLocals, returnDepth: acc.returns[0]! } };
}
