// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B5) §22.2.6.11 **`RegExp.prototype[@@replace]`**, the
 * generic body, standalone — the collect loop, the per-result reads and
 * GetSubstitution (§22.1.3.19.1), over B2's observable `RegExpExec` substrate.
 *
 * ```
 *   1-3.  rx = this; Type(rx) must be Object; S = ? ToString(string)
 *   5-6.  functionalReplace = IsCallable(replaceValue);
 *         otherwise replaceValue = ? ToString(replaceValue)
 *   7-9.  flags = ? ToString(? Get(rx, "flags")); global = flags contains "g";
 *         if global: fullUnicode = flags contains "u"/"v"; ? Set(rx, "lastIndex", +0)
 *   10-12. results = []; repeat: result = ? RegExpExec(rx, S); null ⇒ stop;
 *         append; not global ⇒ stop; matchStr = ? ToString(? Get(result, "0"));
 *         "" ⇒ ? Set(rx, "lastIndex", AdvanceStringIndex(S, ToLength(lastIndex)))
 *   14-15. for each result:
 *         nCaptures = max(? LengthOfArrayLike(result) - 1, 0)
 *         matched = ? ToString(? Get(result, "0")); position = clamp(
 *           ? ToIntegerOrInfinity(? Get(result, "index")), 0, lengthS)
 *         captures[n] = ? Get(result, n), ToString'd unless undefined
 *         namedCaptures = ? Get(result, "groups")
 *         replacement = functional ? ToString(Call(fn, undefined, «matched,
 *           …captures, position, S[, namedCaptures]»)) : GetSubstitution(…)
 *         position ≥ nextSourcePosition ⇒ accumulate S[next, position) +
 *           replacement; next = position + len(matched)
 *   16-17. return accumulated + S[next, lengthS)
 * ```
 *
 * ## Why every read is a `[[Get]]` on the RESULT object
 *
 * The test262 rows that pin this method (`result-{get,coerce}-*`,
 * `g-pos-{increment,decrement}`, `fn-invoke-args-empty-result`) all install a
 * custom `exec` returning a plain object, and each poisons or coerces exactly
 * one of `length` / `0` / `index` / `n` / `groups`. The static native core
 * reads a capture-offset array and never performs those reads, so the body is
 * written the way the spec writes it: over an arbitrary result Object, with the
 * RESULTS collected before any of them is read (the collect loop and the
 * substitution loop are observably ordered with respect to each other).
 *
 * ## GetSubstitution is emitted inline over captured STRINGS
 *
 * `__regex_get_substitution` (native-regex.ts) expands a template against a
 * populated capture-OFFSET array. The generic method only has captured values
 * (whatever the result object's `n` properties coerced to), so this module
 * emits the §22.1.3.19.1 walk over the template itself — `$$`, `$&`, `` $` ``,
 * `$'`, `$n` / `$nn` (two digits preferred when that index is in range, `$0`
 * and out-of-range indices literal) and `$<name>` (literal when there are no
 * named captures) — with the literal runs between substitutions copied as
 * O(1) substring views.
 */
import type { Instr, ValType } from "../ir/types.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import {
  type BuiltinExecEmitter,
  type MatchLoopDeps,
  type RegExpExecProtocolDeps,
  buildAdvanceStringIndexInstrs,
  buildFlagsContainInstrs,
  buildGetInstrs,
  buildRegExpExecInstrs,
  buildRequireObjectReceiver,
  buildSetInstrs,
  captureInto,
  flagsContainAvailable,
  flattenExternStringInstrs,
  prepareMatchLoopDeps,
  prepareRegExpExecProtocol,
} from "./regexp-exec-protocol.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { prepareStandaloneExternrefToNumberProviders } from "./tonumber-fast-paths.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

/** 2^53 - 1, ToLength's ceiling. */
const MAX_SAFE_INTEGER = 9007199254740991;

const CH_DOLLAR = 0x24;
const CH_AMP = 0x26;
const CH_BACKTICK = 0x60;
const CH_QUOTE = 0x27;
const CH_LT = 0x3c;
const CH_GT = 0x3e;
const CH_0 = 0x30;

/** Everything the `@@replace` body needs beyond the RegExpExec substrate and the match-loop readers. */
interface ReplaceDeps {
  readonly isUndefined: number;
  readonly externGetIdx: number;
  readonly strConcat: number;
  readonly strSubstring: number;
  /** `[externref] → [f64]` ToNumber; a builder so no Instr object is shared between sites. */
  readonly toNumber: () => Instr[];
}

function prepareReplaceDeps(ctx: CodegenContext, fctx: FunctionContext): ReplaceDeps | undefined {
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__extern_get_idx", [EXTERNREF, F64], [EXTERNREF]);
  for (const key of ["0", "index", "length", "groups", "", "$"]) addStringConstantGlobal(ctx, key);
  const providers = prepareStandaloneExternrefToNumberProviders(ctx, fctx);
  if (providers !== undefined) addStringConstantGlobal(ctx, "number");
  flushLateImportShifts(ctx, fctx);
  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const isUndefined = get("__extern_is_undefined");
  const externGetIdx = get("__extern_get_idx");
  const strConcat = ctx.nativeStrHelpers.get("__str_concat");
  const strSubstring = ctx.nativeStrHelpers.get("__str_substring");
  const unbox = get("__unbox_number");
  if (
    isUndefined === undefined ||
    externGetIdx === undefined ||
    strConcat === undefined ||
    strSubstring === undefined ||
    unbox === undefined
  ) {
    return undefined;
  }
  // Resolved by NAME after the flush: the provider handles predate it.
  const fused = providers?.fusedToNumber !== undefined ? get("__to_number") : undefined;
  const toPrimitive = providers !== undefined ? get("__to_primitive") : undefined;
  const toNumber = (): Instr[] =>
    fused !== undefined
      ? [{ op: "call", funcIdx: fused }]
      : toPrimitive !== undefined
        ? [
            ...stringConstantExternrefInstrs(ctx, "number"),
            { op: "call", funcIdx: toPrimitive },
            { op: "call", funcIdx: unbox },
          ]
        : [{ op: "call", funcIdx: unbox }];
  return { isUndefined, externGetIdx, strConcat, strSubstring, toNumber };
}

/** The locals and resolved natives every builder below reads. */
interface ReplaceState {
  readonly ctx: CodegenContext;
  readonly fctx: FunctionContext;
  readonly deps: RegExpExecProtocolDeps;
  readonly loop: MatchLoopDeps;
  readonly rep: ReplaceDeps;
  /** Scratch f64 / i32 locals for the numeric coercions. */
  readonly numLocal: number;
  readonly tmpLocal: number;
}

// Every builder returns FRESH Instr objects: the finalize walks remap every
// Instr object they reach, so one object at two body positions would be
// remapped twice.

/** `[externref] → [ref $AnyString]` — narrow a string externref. */
function asAnyString(st: ReplaceState): Instr[] {
  return [{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: st.loop.anyStr }];
}

/** `[] → [ref $AnyString]` — the string constant `text`. */
function constString(st: ReplaceState, text: string): Instr[] {
  return [...stringConstantExternrefInstrs(st.ctx, text), ...asAnyString(st)];
}

/** `[] → [i32]` — the code unit `flat[idx + offset]` of a flat string local. */
function unitAt(st: ReplaceState, flatLocal: number, idxLocal: number, offset: number): Instr[] {
  const nativeStr = st.loop.nativeStr;
  return [
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: nativeStr, fieldIdx: 2 },
    { op: "local.get", index: flatLocal },
    { op: "struct.get", typeIdx: nativeStr, fieldIdx: 1 },
    { op: "local.get", index: idxLocal },
    { op: "i32.add" },
    { op: "i32.const", value: offset },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: st.loop.dataTypeIdx },
  ];
}

/** `[] → [ref $AnyString]` — `flat[from, to)` as an O(1) view. */
function substringOf(st: ReplaceState, flatLocal: number, from: Instr[], to: Instr[]): Instr[] {
  // `ref.as_non_null`: the template local is nullable (it is only set on the
  // non-functional arm), and a non-null local passes through unchanged.
  return [
    { op: "local.get", index: flatLocal },
    { op: "ref.as_non_null" },
    ...from,
    ...to,
    { op: "call", funcIdx: st.rep.strSubstring },
  ];
}

/** `[ref $AnyString a, ref $AnyString b] → [ref $AnyString]` — `a + b`. */
function concat(st: ReplaceState): Instr {
  return { op: "call", funcIdx: st.rep.strConcat };
}

/**
 * `[externref] → [f64]` — ℝ(ToLength(v)): ToNumber, NaN/negative ⇒ 0,
 * truncated, capped at 2^53 - 1. Kept in f64 because `coerce-lastindex` asserts
 * `lastIndex === 2^53` after an AdvanceStringIndex from the cap.
 */
function toLengthF64(st: ReplaceState): Instr[] {
  return [
    ...st.rep.toNumber(),
    { op: "local.set", index: st.numLocal },
    { op: "local.get", index: st.numLocal },
    { op: "local.get", index: st.numLocal },
    { op: "f64.ne" }, // NaN
    {
      op: "if",
      blockType: { kind: "val", type: F64 },
      then: [{ op: "f64.const", value: 0 }],
      else: [
        { op: "local.get", index: st.numLocal },
        { op: "f64.trunc" },
        { op: "f64.const", value: 0 },
        { op: "f64.max" },
        { op: "f64.const", value: MAX_SAFE_INTEGER },
        { op: "f64.min" },
      ],
    },
  ];
}

/** `[externref] → [i32]` — ToLength clamped into i32 (saturating; NaN ⇒ 0; negative ⇒ 0). */
function toLengthI32(st: ReplaceState): Instr[] {
  return [
    ...st.rep.toNumber(),
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: st.tmpLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: st.tmpLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "select" },
  ];
}

/**
 * `[externref] → [i32]` — clamp(ToIntegerOrInfinity(v), 0, lenLocal). NaN is 0;
 * ±∞ saturate into the clamp.
 */
function positionOf(st: ReplaceState, lenLocal: number): Instr[] {
  return [
    ...st.rep.toNumber(),
    { op: "local.set", index: st.numLocal },
    { op: "local.get", index: st.numLocal },
    { op: "local.get", index: st.numLocal },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: st.numLocal },
        { op: "f64.trunc" },
        { op: "f64.const", value: 0 },
        { op: "f64.max" },
        { op: "local.get", index: lenLocal },
        { op: "f64.convert_i32_s" },
        { op: "f64.min" },
        { op: "i32.trunc_sat_f64_s" },
      ],
    },
  ];
}

/** Inputs of one GetSubstitution expansion. */
interface SubstitutionLocals {
  readonly matched: number; // ref $AnyString
  readonly flatS: number; // flat subject
  readonly lenS: number; // i32
  readonly position: number; // i32
  readonly matchLength: number; // i32
  readonly caps: number; // externref $ObjVec of captures (strings or undefined)
  readonly nCaps: number; // i32
  readonly named: number; // externref namedCaptures (undefined ⇒ none)
  readonly repl: number; // flat template
  readonly out: number; // ref null $AnyString — the result (set on one arm, read after the join)
}

/** `[] → [i32]` — is the code unit on the stack an ASCII digit? */
function isDigitInstrs(unit: Instr[]): Instr[] {
  return [
    ...unit,
    { op: "i32.const", value: CH_0 },
    { op: "i32.sub" },
    { op: "i32.const", value: 10 },
    { op: "i32.lt_u" },
  ];
}

/** GetSubstitution's scratch locals (all i32 except `piece`). */
interface GsScratch {
  readonly i: number;
  readonly run: number;
  readonly rlen: number;
  readonly d: number;
  readonly idx: number;
  readonly consumed: number;
  readonly gt: number;
  readonly piece: number;
}

/** `$n` / `$nn` at template index `g.i` (the digit is in `g.d`). */
function buildCaptureArm(st: ReplaceState, L: SubstitutionLocals, g: GsScratch): Instr[] {
  const { rep } = st;
  // `$n` / `$nn`: prefer two digits when that index is 1..m, else one digit
  // when THAT is 1..m; otherwise the sequence is literal (consumed stays 0).
  // `value - 1 <u m` is `1 <= value <= m` in one compare.
  const inRange = (valueLocal: number): Instr[] => [
    { op: "local.get", index: valueLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.get", index: L.nCaps },
    { op: "i32.lt_u" },
  ];
  const choose = (valueLocal: number, consumed: number): Instr[] => [
    { op: "local.get", index: valueLocal },
    { op: "local.set", index: g.idx },
    { op: "i32.const", value: consumed },
    { op: "local.set", index: g.consumed },
  ];
  return [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: g.idx },
    // nn = the two-digit reading, when a second digit exists.
    { op: "local.get", index: g.i },
    { op: "i32.const", value: 2 },
    { op: "i32.add" },
    { op: "local.get", index: g.rlen },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...isDigitInstrs(unitAt(st, L.repl, g.i, 2)),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: g.d },
            { op: "i32.const", value: CH_0 },
            { op: "i32.sub" },
            { op: "i32.const", value: 10 },
            { op: "i32.mul" },
            ...unitAt(st, L.repl, g.i, 2),
            { op: "i32.const", value: CH_0 },
            { op: "i32.sub" },
            { op: "i32.add" },
            { op: "local.set", index: g.gt },
            ...inRange(g.gt),
            { op: "if", blockType: { kind: "empty" }, then: choose(g.gt, 3), else: [] },
          ],
          else: [],
        },
      ],
      else: [],
    },
    { op: "local.get", index: g.idx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: g.d },
        { op: "i32.const", value: CH_0 },
        { op: "i32.sub" },
        { op: "local.set", index: g.gt },
        ...inRange(g.gt),
        { op: "if", blockType: { kind: "empty" }, then: choose(g.gt, 2), else: [] },
      ],
      else: [],
    },
    { op: "local.get", index: g.idx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // capture = captures[idx - 1]; undefined ⇒ "".
        { op: "local.get", index: L.caps },
        { op: "local.get", index: g.idx },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: rep.externGetIdx },
        { op: "local.tee", index: g.piece },
        { op: "call", funcIdx: rep.isUndefined },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...stringConstantExternrefInstrs(st.ctx, ""), { op: "local.set", index: g.piece }],
          else: [],
        },
      ],
      else: [],
    },
  ];
}

/** `$<name>` at template index `g.i`: literal unless there are named captures AND a closing `>`. */
function buildNamedArm(st: ReplaceState, L: SubstitutionLocals, g: GsScratch): Instr[] {
  const { deps, rep } = st;
  return [
    { op: "local.get", index: L.named },
    { op: "call", funcIdx: rep.isUndefined },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // gt = index of the first `>` at or after i + 2, or -1.
        { op: "i32.const", value: -1 },
        { op: "local.set", index: g.gt },
        { op: "local.get", index: g.i },
        { op: "i32.const", value: 2 },
        { op: "i32.add" },
        { op: "local.set", index: g.idx },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: g.idx },
                { op: "local.get", index: g.rlen },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...unitAt(st, L.repl, g.idx, 0),
                { op: "i32.const", value: CH_GT },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "local.get", index: g.idx },
                    { op: "local.set", index: g.gt },
                    { op: "br", depth: 2 },
                  ],
                  else: [],
                },
                { op: "local.get", index: g.idx },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: g.idx },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: g.gt },
        { op: "i32.const", value: 0 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // capture = ? Get(namedCaptures, groupName); undefined ⇒ "", else ToString.
            { op: "local.get", index: L.named },
            ...substringOf(
              st,
              L.repl,
              [{ op: "local.get", index: g.i }, { op: "i32.const", value: 2 }, { op: "i32.add" }],
              [{ op: "local.get", index: g.gt }],
            ),
            { op: "extern.convert_any" },
            { op: "call", funcIdx: deps.externGet },
            { op: "local.tee", index: g.piece },
            { op: "call", funcIdx: rep.isUndefined },
            {
              op: "if",
              blockType: { kind: "val", type: EXTERNREF },
              then: stringConstantExternrefInstrs(st.ctx, ""),
              else: [
                { op: "local.get", index: g.piece },
                { op: "call", funcIdx: deps.externToString },
              ],
            },
            { op: "local.set", index: g.piece },
            { op: "local.get", index: g.gt },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: g.i },
            { op: "i32.sub" },
            { op: "local.set", index: g.consumed },
          ],
          else: [],
        },
      ],
      else: [],
    },
  ];
}

/**
 * `[] → []` — §22.1.3.19.1 **GetSubstitution**, the result left in `L.out`.
 *
 * One pass over the template; a literal run is flushed as a substring view each
 * time a `$` sequence expands, and `$` sequences that do not expand stay part of
 * the run (so they are copied verbatim, which is the spec's answer for them).
 */
function buildGetSubstitution(st: ReplaceState, L: SubstitutionLocals): Instr[] {
  const { fctx, deps, rep } = st;
  const local = (name: string, type: ValType): number =>
    allocLocal(fctx, `__rrp_gs_${name}_${fctx.locals.length}`, type);
  const iLocal = local("i", I32);
  const runLocal = local("run", I32);
  const rlenLocal = local("rlen", I32);
  const dLocal = local("d", I32);
  const idxLocal = local("idx", I32);
  const consumedLocal = local("n", I32);
  const gtLocal = local("gt", I32);
  const pieceLocal = local("piece", EXTERNREF);

  const setPiece = (value: Instr[], consumed: Instr[]): Instr[] => [
    ...value,
    { op: "local.set", index: pieceLocal },
    ...consumed,
    { op: "local.set", index: consumedLocal },
  ];
  const g: GsScratch = {
    i: iLocal,
    run: runLocal,
    rlen: rlenLocal,
    d: dLocal,
    idx: idxLocal,
    consumed: consumedLocal,
    gt: gtLocal,
    piece: pieceLocal,
  };
  const captureArm = buildCaptureArm(st, L, g);
  const namedArm = buildNamedArm(st, L, g);

  // Dispatch on the code unit after `$`.
  const on = (ch: number, then: Instr[], otherwise: Instr[]): Instr[] => [
    { op: "local.get", index: dLocal },
    { op: "i32.const", value: ch },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then, else: otherwise },
  ];
  const tailStart: Instr[] = [
    // min(position + matchLength, lengthS)
    { op: "local.get", index: L.position },
    { op: "local.get", index: L.matchLength },
    { op: "i32.add" },
    { op: "local.tee", index: idxLocal },
    { op: "local.get", index: L.lenS },
    { op: "local.get", index: idxLocal },
    { op: "local.get", index: L.lenS },
    { op: "i32.lt_s" },
    { op: "select" },
  ];
  const two = (): Instr[] => [{ op: "i32.const", value: 2 }];
  const dispatch: Instr[] = on(
    CH_DOLLAR,
    setPiece(stringConstantExternrefInstrs(st.ctx, "$"), two()),
    on(
      CH_AMP,
      setPiece([{ op: "local.get", index: L.matched }, { op: "extern.convert_any" }], two()),
      on(
        CH_BACKTICK,
        setPiece(
          [
            ...substringOf(st, L.flatS, [{ op: "i32.const", value: 0 }], [{ op: "local.get", index: L.position }]),
            { op: "extern.convert_any" },
          ],
          two(),
        ),
        on(
          CH_QUOTE,
          setPiece(
            [
              ...substringOf(st, L.flatS, tailStart, [{ op: "local.get", index: L.lenS }]),
              { op: "extern.convert_any" },
            ],
            two(),
          ),
          on(CH_LT, namedArm, [
            ...isDigitInstrs([{ op: "local.get", index: dLocal }]),
            { op: "if", blockType: { kind: "empty" }, then: captureArm, else: [] },
          ]),
        ),
      ),
    ),
  );

  return [
    { op: "local.get", index: L.repl },
    { op: "struct.get", typeIdx: st.loop.nativeStr, fieldIdx: 0 },
    { op: "local.set", index: rlenLocal },
    ...constString(st, ""),
    { op: "local.set", index: L.out },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: iLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: runLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // i + 1 >= rlen ⇒ no `$x` pair can start here: done.
            { op: "local.get", index: iLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.get", index: rlenLocal },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: consumedLocal },
            ...unitAt(st, L.repl, iLocal, 0),
            { op: "i32.const", value: CH_DOLLAR },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [...unitAt(st, L.repl, iLocal, 1), { op: "local.set", index: dLocal }, ...dispatch],
              else: [],
            },
            { op: "local.get", index: consumedLocal },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // out = out + repl[run, i) + piece; i += consumed; run = i.
                { op: "local.get", index: L.out },
                { op: "ref.as_non_null" },
                ...substringOf(
                  st,
                  L.repl,
                  [{ op: "local.get", index: runLocal }],
                  [{ op: "local.get", index: iLocal }],
                ),
                concat(st),
                { op: "local.get", index: pieceLocal },
                ...asAnyString(st),
                concat(st),
                { op: "local.set", index: L.out },
                { op: "local.get", index: iLocal },
                { op: "local.get", index: consumedLocal },
                { op: "i32.add" },
                { op: "local.tee", index: iLocal },
                { op: "local.set", index: runLocal },
              ],
              else: [
                { op: "local.get", index: iLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: iLocal },
              ],
            },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // the trailing literal run
    { op: "local.get", index: L.out },
    { op: "ref.as_non_null" },
    ...substringOf(st, L.repl, [{ op: "local.get", index: runLocal }], [{ op: "local.get", index: rlenLocal }]),
    concat(st),
    { op: "local.set", index: L.out },
  ];
}

/** Locals of the collect loop and the per-result pass. */
interface ReplaceLocals {
  readonly rx: number;
  readonly s: number; // externref subject
  readonly flatS: number;
  readonly lenS: number;
  readonly replaceValue: number; // the raw argument
  readonly functional: number; // i32
  readonly repl: number; // flat template (when not functional)
  readonly flags: number;
  readonly global: number; // i32
  readonly unicode: number; // i32
  readonly results: number; // $ObjVec
  readonly nResults: number; // i32
  readonly result: number;
  readonly k: number; // i32 — result cursor
  readonly acc: number; // ref $AnyString
  readonly next: number; // i32 nextSourcePosition
}

/**
 * Steps 10-12 — the collect loop. `[] → []`.
 *
 * In the global case an empty match advances `lastIndex` from
 * ℝ(ToLength(Get(rx, "lastIndex"))) — computed in f64, because `coerce-lastindex`
 * sets it to 2^54 and requires 2^53 back — by AdvanceStringIndex, whose unicode
 * arm only ever applies below `lengthS` (where the index fits an i32).
 */
function buildCollectLoop(st: ReplaceState, R: ReplaceLocals, builtinArm: Instr[], idxLocal: number): Instr[] {
  const { ctx, fctx, deps } = st;
  const advance: Instr[] = [
    ...buildGetInstrs(ctx, deps, R.rx, "lastIndex"),
    ...toLengthF64(st),
    { op: "local.set", index: st.numLocal },
    // f64 index + 1, unless unicode AND index + 1 < lengthS (then the surrogate test).
    { op: "local.get", index: R.unicode },
    { op: "local.get", index: st.numLocal },
    { op: "f64.const", value: 1 },
    { op: "f64.add" },
    { op: "local.get", index: R.lenS },
    { op: "f64.convert_i32_s" },
    { op: "f64.lt" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: F64 },
      then: [
        { op: "local.get", index: st.numLocal },
        { op: "i32.trunc_sat_f64_s" },
        { op: "local.set", index: idxLocal },
        ...buildAdvanceStringIndexInstrs(st.loop, R.flatS, idxLocal, R.unicode),
        { op: "f64.convert_i32_s" },
      ],
      else: [{ op: "local.get", index: st.numLocal }, { op: "f64.const", value: 1 }, { op: "f64.add" }],
    },
    { op: "local.set", index: st.numLocal },
    ...buildSetInstrs(ctx, deps, R.rx, "lastIndex", [
      { op: "local.get", index: st.numLocal },
      { op: "call", funcIdx: deps.boxNumber },
    ]),
  ];
  return [
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: R.results },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: R.nResults },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            ...buildRegExpExecInstrs(ctx, fctx, deps, R.rx, R.s, builtinArm),
            { op: "local.tee", index: R.result },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: R.results },
            { op: "local.get", index: R.result },
            { op: "call", funcIdx: deps.objVecPush },
            { op: "local.get", index: R.nResults },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: R.nResults },
            { op: "local.get", index: R.global },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // matchStr = ? ToString(? Get(result, "0")); "" ⇒ advance.
            ...buildGetInstrs(ctx, deps, R.result, "0"),
            { op: "call", funcIdx: deps.externToString },
            ...flattenExternStringInstrs(st.loop),
            { op: "struct.get", typeIdx: st.loop.nativeStr, fieldIdx: 0 },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: advance, else: [] },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/** Step 15 for one result (in `R.result`) — accumulates into `R.acc` / `R.next`. `[] → []`. */
function buildProcessResult(st: ReplaceState, R: ReplaceLocals): Instr[] {
  const { ctx, fctx, deps, rep } = st;
  const local = (name: string, type: ValType): number => allocLocal(fctx, `__rrp_${name}_${fctx.locals.length}`, type);
  const nCaps = local("ncap", I32);
  const matched = local("matched", { kind: "ref", typeIdx: st.loop.anyStr });
  const matchLength = local("mlen", I32);
  const position = local("pos", I32);
  const caps = local("caps", EXTERNREF);
  const args = local("args", EXTERNREF);
  const n = local("n", I32);
  const cap = local("cap", EXTERNREF);
  const named = local("named", EXTERNREF);
  const replacement = local("replacement", { kind: "ref_null", typeIdx: st.loop.anyStr });

  const substitution = buildGetSubstitution(st, {
    matched,
    flatS: R.flatS,
    lenS: R.lenS,
    position,
    matchLength,
    caps,
    nCaps,
    named,
    repl: R.repl,
    out: replacement,
  });
  const functionalArm: Instr[] = [
    // «…, position, S [, namedCaptures]» after the captures already pushed.
    { op: "local.get", index: args },
    { op: "local.get", index: position },
    { op: "f64.convert_i32_s" },
    { op: "call", funcIdx: deps.boxNumber },
    { op: "call", funcIdx: deps.objVecPush },
    { op: "local.get", index: args },
    { op: "local.get", index: R.s },
    { op: "call", funcIdx: deps.objVecPush },
    { op: "local.get", index: named },
    { op: "call", funcIdx: rep.isUndefined },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [
        { op: "local.get", index: args },
        { op: "local.get", index: named },
        { op: "call", funcIdx: deps.objVecPush },
      ],
    },
    // replacement = ? ToString(? Call(replaceValue, undefined, replacerArgs)).
    { op: "local.get", index: R.replaceValue },
    ...canonicalUndefinedExternInstrs(ctx),
    { op: "local.get", index: args },
    { op: "call", funcIdx: deps.applyClosure },
    { op: "call", funcIdx: deps.externToString },
    ...asAnyString(st),
    { op: "local.set", index: replacement },
  ];

  return [
    // 15.a-b — nCaptures = max(LengthOfArrayLike(result) - 1, 0).
    ...buildGetInstrs(ctx, deps, R.result, "length"),
    ...toLengthI32(st),
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.tee", index: nCaps },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: nCaps },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "select" },
    { op: "local.set", index: nCaps },
    // 15.c-d — matched = ? ToString(? Get(result, "0")).
    ...buildGetInstrs(ctx, deps, R.result, "0"),
    { op: "call", funcIdx: deps.externToString },
    ...asAnyString(st),
    { op: "local.tee", index: matched },
    { op: "call", funcIdx: st.loop.flatten },
    { op: "struct.get", typeIdx: st.loop.nativeStr, fieldIdx: 0 },
    { op: "local.set", index: matchLength },
    // 15.e-f — position.
    ...buildGetInstrs(ctx, deps, R.result, "index"),
    ...positionOf(st, R.lenS),
    { op: "local.set", index: position },
    // 15.g-i — captures (and the replacer's argument list, which starts with `matched`).
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: caps },
    { op: "call", funcIdx: deps.objVecNew },
    { op: "local.set", index: args },
    { op: "local.get", index: args },
    { op: "local.get", index: matched },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: deps.objVecPush },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: n },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: n },
            { op: "local.get", index: nCaps },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // capN = ? Get(result, ! ToString(𝔽(n))); not undefined ⇒ ? ToString(capN).
            { op: "local.get", index: R.result },
            { op: "local.get", index: n },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: deps.boxNumber },
            { op: "call", funcIdx: deps.externToString },
            { op: "call", funcIdx: deps.externGet },
            { op: "local.tee", index: cap },
            { op: "call", funcIdx: rep.isUndefined },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [],
              else: [
                { op: "local.get", index: cap },
                { op: "call", funcIdx: deps.externToString },
                { op: "local.set", index: cap },
              ],
            },
            { op: "local.get", index: caps },
            { op: "local.get", index: cap },
            { op: "call", funcIdx: deps.objVecPush },
            { op: "local.get", index: args },
            { op: "local.get", index: cap },
            { op: "call", funcIdx: deps.objVecPush },
            { op: "local.get", index: n },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: n },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // 15.j — namedCaptures = ? Get(result, "groups").
    ...buildGetInstrs(ctx, deps, R.result, "groups"),
    { op: "local.set", index: named },
    // 15.k-l
    { op: "local.get", index: R.functional },
    { op: "if", blockType: { kind: "empty" }, then: functionalArm, else: substitution },
    // 15.m — position ≥ nextSourcePosition ⇒ accumulate.
    { op: "local.get", index: position },
    { op: "local.get", index: R.next },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: R.acc },
        ...substringOf(st, R.flatS, [{ op: "local.get", index: R.next }], [{ op: "local.get", index: position }]),
        concat(st),
        { op: "local.get", index: replacement },
        { op: "ref.as_non_null" },
        concat(st),
        { op: "local.set", index: R.acc },
        { op: "local.get", index: position },
        { op: "local.get", index: matchLength },
        { op: "i32.add" },
        { op: "local.set", index: R.next },
      ],
      else: [],
    },
  ];
}

/**
 * Emit the §22.2.6.11 body. Params are the reflective-closure ABI: `thisParam`
 * is the externref `this`, `strParam` / `replaceParam` the two arguments (a
 * missing one arrives as `undefined`). Leaves an externref string on the stack;
 * returns `null` — having emitted NOTHING — when a dependency is unavailable.
 */
export function emitRegExpSymbolReplaceBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  thisParam: number,
  strParam: number,
  replaceParam: number,
  emitBuiltinExec: BuiltinExecEmitter,
): ValType | null {
  // Every decline happens before the first `fctx.body.push` (B2's lesson).
  const deps0 = prepareRegExpExecProtocol(ctx, fctx);
  if (deps0 === undefined || !flagsContainAvailable(ctx)) return null;
  const loop0 = prepareMatchLoopDeps(ctx, fctx);
  if (loop0 === undefined) return null;
  const rep0 = prepareReplaceDeps(ctx, fctx);
  if (rep0 === undefined) return null;
  let deps = prepareRegExpExecProtocol(ctx, fctx) ?? deps0;

  // steps 1-2
  for (const instr of buildRequireObjectReceiver(ctx, fctx, deps, thisParam)) fctx.body.push(instr);

  const local = (name: string, type: ValType): number => allocLocal(fctx, `__rrp_${name}_${fctx.locals.length}`, type);
  const anyStr: ValType = { kind: "ref", typeIdx: loop0.anyStr };
  const flatRef: ValType = { kind: "ref", typeIdx: loop0.nativeStr };
  const R: ReplaceLocals = {
    rx: thisParam,
    s: local("s", EXTERNREF),
    flatS: local("fs", flatRef),
    lenS: local("lens", I32),
    replaceValue: replaceParam,
    functional: local("fn", I32),
    repl: local("repl", { kind: "ref_null", typeIdx: loop0.nativeStr }),
    flags: local("flags", EXTERNREF),
    global: local("g", I32),
    unicode: local("u", I32),
    results: local("results", EXTERNREF),
    nResults: local("nres", I32),
    result: local("result", EXTERNREF),
    k: local("k", I32),
    acc: local("acc", anyStr),
    next: local("next", I32),
  };
  const idxLocal = local("idx", I32);

  // step 3 — S = ? ToString(string), once; its flat view and length.
  fctx.body.push({ op: "local.get", index: strParam }, { op: "call", funcIdx: deps.externToString });
  fctx.body.push({ op: "local.tee", index: R.s }, ...flattenExternStringInstrs(loop0));
  fctx.body.push({ op: "local.tee", index: R.flatS });
  fctx.body.push({ op: "struct.get", typeIdx: loop0.nativeStr, fieldIdx: 0 }, { op: "local.set", index: R.lenS });

  // steps 5-6 — functionalReplace; otherwise ToString(replaceValue), BEFORE the
  // `flags` Get (`arg-1-coerce-err` vs `get-flags-err`).
  fctx.body.push({ op: "local.get", index: replaceParam }, { op: "call", funcIdx: deps.isCallable });
  fctx.body.push({ op: "local.tee", index: R.functional }, { op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "local.get", index: replaceParam },
      { op: "call", funcIdx: deps.externToString },
      ...flattenExternStringInstrs(loop0),
      { op: "local.set", index: R.repl },
    ],
    else: [],
  });

  // steps 7-9
  for (const instr of buildGetInstrs(ctx, deps, thisParam, "flags")) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: deps.externToString }, { op: "local.set", index: R.flags });

  // The builtin arm is emitted through the real context and spliced out BEFORE
  // any further index is read (B2/B3's discipline), then every dependency is
  // re-resolved.
  const builtinArm = captureInto(fctx, () => emitBuiltinExec(thisParam, R.s));
  deps = prepareRegExpExecProtocol(ctx, fctx) ?? deps;
  const loop = prepareMatchLoopDeps(ctx, fctx) ?? loop0;
  const rep = prepareReplaceDeps(ctx, fctx) ?? rep0;
  const st: ReplaceState = {
    ctx,
    fctx,
    deps,
    loop,
    rep,
    numLocal: local("num", F64),
    tmpLocal: local("t", I32),
  };

  fctx.body.push(...buildFlagsContainInstrs(ctx, R.flags, "g"), { op: "local.set", index: R.global });
  fctx.body.push(
    ...buildFlagsContainInstrs(ctx, R.flags, "u"),
    ...buildFlagsContainInstrs(ctx, R.flags, "v"),
    { op: "i32.or" },
    { op: "local.get", index: R.global },
    { op: "i32.and" },
    { op: "local.set", index: R.unicode },
  );
  fctx.body.push({ op: "local.get", index: R.global });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildSetInstrs(ctx, deps, thisParam, "lastIndex", [
      { op: "f64.const", value: 0 },
      { op: "call", funcIdx: deps.boxNumber },
    ]),
    else: [],
  });

  // steps 10-12
  fctx.body.push(...buildCollectLoop(st, R, builtinArm, idxLocal));

  // steps 13-15
  fctx.body.push(...constString(st, ""), { op: "local.set", index: R.acc });
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: R.next });
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: R.k });
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: R.k },
          { op: "local.get", index: R.nResults },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: R.results },
          { op: "local.get", index: R.k },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: rep.externGetIdx },
          { op: "local.set", index: R.result },
          ...buildProcessResult(st, R),
          { op: "local.get", index: R.k },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: R.k },
          { op: "br", depth: 0 },
        ],
      },
    ],
  });

  // steps 16-17 — the tail S[next, lengthS) (empty when next ≥ lengthS).
  fctx.body.push({ op: "local.get", index: R.acc });
  fctx.body.push(
    ...substringOf(
      st,
      R.flatS,
      [
        { op: "local.get", index: R.next },
        { op: "local.get", index: R.lenS },
        { op: "local.get", index: R.next },
        { op: "local.get", index: R.lenS },
        { op: "i32.lt_s" },
        { op: "select" },
      ],
      [{ op: "local.get", index: R.lenS }],
    ),
    concat(st),
    { op: "extern.convert_any" },
  );
  return EXTERNREF;
}
