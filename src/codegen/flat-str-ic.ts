// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) INLINE the cheap early-outs of `__str_flatten` and `__str_equals` at
 * their CALL SITES.
 *
 * ## The two rewrites
 *
 * 1. **`__str_flatten` sites** — the helper's body BEGINS with an already-flat
 *    early return (`ref.test $NativeString` → `ref.cast` → return; see
 *    `emitStrFlattenHelpers` in `native-strings-core.ts`). Once literals are
 *    interned the overwhelmingly common operand is already flat, so the call is
 *    pure overhead at those sites. The guard is hoisted to the site: the flat
 *    case never calls, and a rope (or `$Utf8String`) falls back to the
 *    unmodified call. Measured on the acorn self-parse: 516,717 executed calls
 *    per parse under default flags (252,367 under `JS2WASM_LAZY_STR_FLATTEN=1`,
 *    which composes with — and is orthogonal to — this pass).
 *
 * 2. **`__str_equals` sites** — the helper answers two of its three early-outs
 *    without touching character data: `ref.eq` identity → 1 and a length
 *    mismatch → 0 (see `emitStrCompareHelpers` in `native-strings-basics.ts`).
 *    Both are hoisted to the site; equal-length non-identical operands fall
 *    back to the unmodified call. Measured: 254,976 executed calls per parse.
 *
 * ## Why a wrong guess cannot be a wrong answer
 *
 * 1. **The arms are extracted, not re-written.** `extractFlattenGuard` /
 *    `extractEqualsEarlyOuts` read the emitted helper bodies at finalize and
 *    VERIFY the exact early-out shape (same discipline as
 *    `is-truthy-inline-ic.ts` / `extern-get-inline-ic.ts`, whose header notes
 *    also mandate the by-name helper lookup and `local.set`-never-`tee` rules
 *    used here). The flatten fast arm is a verbatim copy of the helper's own
 *    `then` arm with its single param re-homed; the equals answers are the
 *    helper's own extracted `i32.const` values. If either helper body ever
 *    changes shape, extraction fails and the pass declines wholesale — it
 *    cannot copy a stale arm.
 * 2. **The terminal fallback is the unmodified call** with the original
 *    operands, so every value the guards do not claim reaches exactly today's
 *    helper — the site's answer set is identical to the helper's.
 * 3. **Both hoisted answers are correct on UNFLATTENED operands**, which is the
 *    one way a site differs from the (default-flags) helper interior:
 *      - identity: `a === b` (same ref) implies equal contents; the helper
 *        answers 1 on that input too (flattening maps equal refs to equal
 *        refs — the cons memoization of #3673 is in-place and idempotent).
 *      - length: read via `struct.get $AnyString` field 0 — the JS-visible
 *        code-unit count on ALL THREE subtypes, immutable, and preserved by
 *        flattening (the load-bearing fact of `lazy-str-flatten.ts` and
 *        a0655cb6e). This is deliberately NOT the helper's own
 *        `ref.cast $NativeString ; struct.get $NativeString` spelling: that
 *        spelling is only valid after the helper's flatten preamble has run,
 *        and would TRAP on a rope at the site. The extractor still verifies
 *        the helper's spelling (field 0, `i32.ne`, the answer constants); the
 *        site re-types the read to the helper's own declared param heap type
 *        (`$AnyString`, read from the emitted signature), whose field 0 is
 *        verified to be an immutable i32.
 *      - a non-answer (guards fail) can never be wrong: it only costs the call
 *        that would have happened anyway.
 * 4. **The helper family is excluded** (`fn.name.startsWith("__str_")`):
 *    `wrapBodyWithFlatten` preambles inside string helpers already guard their
 *    flatten calls with the same `ref.test`, so a second guard there could
 *    never hit — pure tax by construction.
 *
 * Sites emitted by fills that run AFTER this pass's finalize slot (e.g.
 * `fillDynamicForinVecArms`) stay un-inlined and keep calling the helper —
 * accepted; the fallback path is always the unmodified helper.
 *
 * ## Flag — DEFAULT OFF
 *
 * `JS2WASM_FLAT_STR_IC` unset / `""` / `0` / `off` / `false` / `no` → the pass
 * returns before touching anything and the binary is byte-identical
 * (sha256-verified) to base. Any other value enables both rewrites.
 *   - `JS2WASM_FLAT_STR_IC_DEBUG=1` per-family site counts + decline reasons
 *   - `JS2WASM_FLAT_STR_IC_POISON=1` **deliberately corrupts every fast arm**
 *     (replaces it with `unreachable`). A workload that still completes under
 *     poison did not execute the fast paths — the only way to tell a real null
 *     from a mechanism that never fired (#4157 entry 22).
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

function enabled(): boolean {
  const raw = process.env.JS2WASM_FLAT_STR_IC;
  return raw !== undefined && !["", "0", "off", "false", "no"].includes(raw);
}

type AnyInstr = Instr & {
  op: string;
  index?: number;
  value?: number;
  funcIdx?: number;
  typeIdx?: number;
  fieldIdx?: number;
  body?: Instr[];
  then?: Instr[];
  else?: Instr[];
  catches?: { body?: Instr[] }[];
  catchAll?: Instr[];
  blockType?: { kind: string; type?: ValType };
};

/** `__str_flatten`'s already-flat early return, read out of the emitted body. */
interface FlattenGuard {
  /** `$NativeString` — the type the helper's own first `ref.test` screens for. */
  testTypeIdx: number;
  /** The helper's declared result (`ref $NativeString`), for the site's `if`. */
  resultType: ValType;
  /** The helper's `then` arm, verbatim; param 0 re-homed at the site. */
  thenArm: Instr[];
}

function extractFlattenGuard(ctx: CodegenContext, fn: WasmFunction): { guard?: FlattenGuard; reason?: string } {
  const b = fn.body as AnyInstr[];
  const [g0, g1, g2] = b;
  if (g0?.op !== "local.get" || g0.index !== 0) return { reason: "body[0] is not `local.get 0`" };
  if (g1?.op !== "ref.test" || typeof g1.typeIdx !== "number") return { reason: "body[1] is not `ref.test`" };
  if (g2?.op !== "if" || g2.blockType?.kind !== "val" || g2.else === undefined)
    return { reason: "body[2] is not a value-typed if/else" };
  const then = (g2.then ?? []) as AnyInstr[];
  if (then.length !== 2 || then[0]?.op !== "local.get" || then[0].index !== 0) return { reason: "then-arm shape" };
  if (then[1]?.op !== "ref.cast" || then[1].typeIdx !== g1.typeIdx) return { reason: "then-arm cast" };
  const t = ctx.mod.types[fn.typeIdx];
  if (!t || t.kind !== "func" || t.results.length !== 1 || t.results[0]!.kind !== "ref")
    return { reason: "signature is not (…) -> (ref T)" };
  return { guard: { testTypeIdx: g1.typeIdx, resultType: t.results[0]!, thenArm: then as Instr[] } };
}

/** `__str_equals`'s two rope-safe early-outs, verified in the emitted body. */
interface EqualsEarlyOuts {
  /** The helper's declared param heap type (`$AnyString`) — rope-safe length. */
  lenTypeIdx: number;
  /** The helper's own answer for `ref.eq` identity (1). */
  identityAnswer: number;
  /** The helper's own answer for a length mismatch (0). */
  mismatchAnswer: number;
}

/** Match one `wrapBodyWithFlatten`/`relocatedFlattenPreamble` guard group. */
function isFlattenPreambleGroup(b: AnyInstr[], i: number): boolean {
  const [p0, p1, p2, p3] = [b[i], b[i + 1], b[i + 2], b[i + 3]];
  if (p0?.op !== "local.get" || p1?.op !== "ref.test" || p2?.op !== "i32.eqz" || p3?.op !== "if") return false;
  const then = (p3.then ?? []) as AnyInstr[];
  return (
    p3.else === undefined &&
    then.length === 3 &&
    then[0]?.op === "local.get" &&
    then[0].index === p0.index &&
    then[1]?.op === "call" &&
    then[2]?.op === "local.set" &&
    then[2].index === p0.index
  );
}

/** `if (empty) { i32.const C ; return }` with no else → C, else undefined. */
function earlyReturnAnswer(instr: AnyInstr | undefined): number | undefined {
  if (instr?.op !== "if" || instr.blockType?.kind !== "empty" || instr.else !== undefined) return undefined;
  const then = (instr.then ?? []) as AnyInstr[];
  if (then.length !== 2 || then[0]?.op !== "i32.const" || then[1]?.op !== "return") return undefined;
  return then[0].value;
}

function extractEqualsEarlyOuts(ctx: CodegenContext, fn: WasmFunction): { outs?: EqualsEarlyOuts; reason?: string } {
  const t = ctx.mod.types[fn.typeIdx];
  if (!t || t.kind !== "func" || t.params.length !== 2) return { reason: "signature is not binary" };
  const p0 = t.params[0]!;
  if (p0.kind !== "ref" || typeof p0.typeIdx !== "number" || JSON.stringify(p0) !== JSON.stringify(t.params[1]))
    return { reason: "params are not one non-null ref type" };
  const anyStr = ctx.mod.types[p0.typeIdx];
  if (!anyStr || anyStr.kind !== "struct" || anyStr.fields.length === 0)
    return { reason: "param heap is not a struct" };
  const lenField = anyStr.fields[0]!;
  if (lenField.mutable || lenField.type.kind !== "i32") return { reason: "param field 0 is not an immutable i32" };

  const b = fn.body as AnyInstr[];
  let i = 0;
  // Zero (lazy mode) or more (default: one per param) top-of-body flatten
  // preambles — the part the site deliberately does NOT need.
  while (isFlattenPreambleGroup(b, i)) i += 4;

  // Identity: `local.get 0 ; local.get 1 ; ref.eq ; if { i32.const 1 ; return }`.
  if (b[i]?.op !== "local.get" || b[i]!.index !== 0) return { reason: "identity: local.get 0" };
  if (b[i + 1]?.op !== "local.get" || b[i + 1]!.index !== 1) return { reason: "identity: local.get 1" };
  if (b[i + 2]?.op !== "ref.eq") return { reason: "identity: ref.eq" };
  const identityAnswer = earlyReturnAnswer(b[i + 3]);
  if (identityAnswer === undefined) return { reason: "identity: early-return arm" };
  i += 4;

  // Length: `local.get 0 ; (ref.cast)? ; struct.get T 0 ; local.set L ;
  // local.get L ; local.get 1 ; (ref.cast)? ; struct.get T 0 ; i32.ne ;
  // if { i32.const 0 ; return }` — the casts are wrapBodyWithFlatten fixups,
  // present under default flags and absent under JS2WASM_LAZY_STR_FLATTEN=1.
  const lenRead = (param: number): string | undefined => {
    if (b[i]?.op !== "local.get" || b[i]!.index !== param) return `local.get ${param}`;
    i++;
    if (b[i]?.op === "ref.cast") i++;
    if (b[i]?.op !== "struct.get" || b[i]!.fieldIdx !== 0) return "struct.get field 0";
    i++;
    return undefined;
  };
  let bad = lenRead(0);
  if (bad) return { reason: `length a: ${bad}` };
  if (b[i]?.op !== "local.set") return { reason: "length: local.set len" };
  const lenLocal = b[i]!.index;
  i++;
  if (b[i]?.op !== "local.get" || b[i]!.index !== lenLocal) return { reason: "length: local.get len" };
  i++;
  bad = lenRead(1);
  if (bad) return { reason: `length b: ${bad}` };
  if (b[i]?.op !== "i32.ne") return { reason: "length: i32.ne" };
  const mismatchAnswer = earlyReturnAnswer(b[i + 1]);
  if (mismatchAnswer === undefined) return { reason: "length: early-return arm" };

  return { outs: { lenTypeIdx: p0.typeIdx, identityAnswer, mismatchAnswer } };
}

interface Stats {
  flattenSites: number;
  equalsSites: number;
  excludedFamilySites: number;
  fnsTouched: number;
}

interface Targets {
  flattenIdx: number;
  guard: FlattenGuard;
  equalsIdx: number;
  outs: EqualsEarlyOuts;
  poison: boolean;
}

const POISON_ARM: Instr[] = [{ op: "unreachable" }];

/** Count (but never patch) helper-family-internal sites, for reporting. */
function countCalls(instrs: Instr[], funcIdxs: readonly number[]): number {
  let n = 0;
  for (const instr of instrs) {
    const a = instr as AnyInstr;
    if (a.op === "call" && a.funcIdx !== undefined && funcIdxs.includes(a.funcIdx)) n++;
    if (Array.isArray(a.body)) n += countCalls(a.body, funcIdxs);
    if (Array.isArray(a.then)) n += countCalls(a.then, funcIdxs);
    if (Array.isArray(a.else)) n += countCalls(a.else, funcIdxs);
    if (Array.isArray(a.catches))
      for (const c of a.catches) if (Array.isArray(c.body)) n += countCalls(c.body, funcIdxs);
    if (Array.isArray(a.catchAll)) n += countCalls(a.catchAll, funcIdxs);
  }
  return n;
}

/** Rewrite one instruction array in place, recursing into nested bodies. */
function rewriteInstrs(instrs: Instr[], t: Targets, scratch: (which: 0 | 1) => number, stats: Stats): void {
  const out: Instr[] = [];
  for (const instr of instrs) {
    const a = instr as AnyInstr;
    if (Array.isArray(a.body)) rewriteInstrs(a.body, t, scratch, stats);
    if (Array.isArray(a.then)) rewriteInstrs(a.then, t, scratch, stats);
    if (Array.isArray(a.else)) rewriteInstrs(a.else, t, scratch, stats);
    if (Array.isArray(a.catches)) {
      for (const c of a.catches) if (Array.isArray(c.body)) rewriteInstrs(c.body, t, scratch, stats);
    }
    if (Array.isArray(a.catchAll)) rewriteInstrs(a.catchAll, t, scratch, stats);

    if (a.op === "call" && a.funcIdx === t.flattenIdx) {
      // <s> → set ; test-flat ? verbatim helper arm : unmodified call.
      const s = scratch(0);
      const arm = t.guard.thenArm.map((g) => ({ ...(g as AnyInstr), index: s }) as Instr);
      out.push(
        { op: "local.set", index: s }, // set, never tee (see extern-get-inline-ic.ts)
        { op: "local.get", index: s },
        { op: "ref.test", typeIdx: t.guard.testTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: t.guard.resultType },
          then: t.poison ? POISON_ARM : arm,
          else: [{ op: "local.get", index: s }, { op: "ref.as_non_null" }, instr],
        },
      );
      stats.flattenSites++;
      continue;
    }
    if (a.op === "call" && a.funcIdx === t.equalsIdx) {
      const sa = scratch(0);
      const sb = scratch(1);
      out.push(
        { op: "local.set", index: sb },
        { op: "local.set", index: sa },
        { op: "local.get", index: sa },
        { op: "local.get", index: sb },
        { op: "ref.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: t.poison ? POISON_ARM : [{ op: "i32.const", value: t.outs.identityAnswer }],
          else: [
            { op: "local.get", index: sa },
            { op: "struct.get", typeIdx: t.outs.lenTypeIdx, fieldIdx: 0 },
            { op: "local.get", index: sb },
            { op: "struct.get", typeIdx: t.outs.lenTypeIdx, fieldIdx: 0 },
            { op: "i32.ne" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: t.poison ? POISON_ARM : [{ op: "i32.const", value: t.outs.mismatchAnswer }],
              else: [
                { op: "local.get", index: sa },
                { op: "ref.as_non_null" },
                { op: "local.get", index: sb },
                { op: "ref.as_non_null" },
                instr,
              ],
            },
          ],
        },
      );
      stats.equalsSites++;
      continue;
    }
    out.push(instr);
  }
  instrs.length = 0;
  instrs.push(...out);
}

/**
 * (#4157) Inline `__str_flatten`'s already-flat return and `__str_equals`'s
 * identity/length early-outs at every call site outside the `__str_` family.
 *
 * MUST run at the same finalize slot as `inlineExternGetCallSites` — after the
 * helper bodies are final and BEFORE any pass that remaps type or function
 * indices — so the copied `typeIdx`/`funcIdx` operands stay in the helpers'
 * own regime. No-op unless `JS2WASM_FLAT_STR_IC` is set.
 */
export function inlineFlatStrCallSites(ctx: CodegenContext): void {
  if (!enabled()) return; // DEFAULT OFF — byte-identical to base.
  const debug = process.env.JS2WASM_FLAT_STR_IC_DEBUG === "1";
  const poison = process.env.JS2WASM_FLAT_STR_IC_POISON === "1";

  // Handles in the same regime the emitters baked into call instrs: funcMap is
  // the shift-maintained authority for __str_flatten (#1618); __str_equals
  // sites all read ctx.nativeStrHelpers, which reconcileNativeStrFinalizeShift
  // has already repaired by this point. Bodies come from BY-NAME lookup — list
  // position arithmetic is the trap extern-get-inline-ic.ts documents.
  const flattenIdx = ctx.funcMap.get("__str_flatten") ?? ctx.nativeStrHelpers.get("__str_flatten");
  const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const flattenFn = ctx.mod.functions.find((f) => f.name === "__str_flatten");
  const equalsFn = ctx.mod.functions.find((f) => f.name === "__str_equals");
  if (flattenIdx === undefined || equalsIdx === undefined || !flattenFn || !equalsFn) {
    if (debug) process.stderr.write(`[flat-str-ic] native string helpers not present (host-string mode) — declined\n`);
    return;
  }
  const { guard, reason: fReason } = extractFlattenGuard(ctx, flattenFn);
  if (!guard) {
    process.stderr.write(`[flat-str-ic] REFUSED: __str_flatten body is not the guarded shape (${fReason})\n`);
    return;
  }
  const { outs, reason: eReason } = extractEqualsEarlyOuts(ctx, equalsFn);
  if (!outs) {
    process.stderr.write(`[flat-str-ic] REFUSED: __str_equals body is not the early-out shape (${eReason})\n`);
    return;
  }

  const t: Targets = { flattenIdx, guard, equalsIdx, outs, poison };
  const stats: Stats = { flattenSites: 0, equalsSites: 0, excludedFamilySites: 0, fnsTouched: 0 };
  for (const fn of ctx.mod.functions) {
    if (fn.name.startsWith("__str_")) {
      // wrapBodyWithFlatten preambles in the helper family already guard their
      // flatten calls with the same ref.test — a site guard could never hit.
      stats.excludedFamilySites += countCalls(fn.body, [flattenIdx, equalsIdx]);
      continue;
    }
    const before = stats.flattenSites + stats.equalsSites;
    let s0 = -1;
    let s1 = -1;
    const scratch = (which: 0 | 1): number => {
      const ty = ctx.mod.types[fn.typeIdx];
      const nparams = ty && ty.kind === "func" ? ty.params.length : 0;
      if (which === 0) {
        if (s0 < 0) {
          s0 = nparams + fn.locals.length;
          fn.locals.push({ name: "__fsic_a", type: { kind: "ref_null", typeIdx: outs.lenTypeIdx } });
        }
        return s0;
      }
      if (s1 < 0) {
        s1 = nparams + fn.locals.length;
        fn.locals.push({ name: "__fsic_b", type: { kind: "ref_null", typeIdx: outs.lenTypeIdx } });
      }
      return s1;
    };
    rewriteInstrs(fn.body, t, scratch, stats);
    if (stats.flattenSites + stats.equalsSites > before) stats.fnsTouched++;
  }

  process.stderr.write(
    `[flat-str-ic] flatten-sites=${stats.flattenSites} equals-sites=${stats.equalsSites} ` +
      `functions=${stats.fnsTouched} excluded-family-sites=${stats.excludedFamilySites}` +
      `${poison ? " POISON=ON" : ""}\n`,
  );
  if (debug) {
    process.stderr.write(
      `[flat-str-ic] flatten guard: test#${guard.testTypeIdx} result=${JSON.stringify(guard.resultType)}; ` +
        `equals: len#${outs.lenTypeIdx} answers=${outs.identityAnswer}/${outs.mismatchAnswer}\n`,
    );
  }
}
