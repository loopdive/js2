// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6677 — shared plumbing for the runtime (Wasm-native) RegExp compiler.
 *
 * The compiler keeps all of its working state in ONE GC struct (`$__RxState`)
 * that every helper receives as local 0. Its layout, the AST node layout and
 * the helper-function registry live here so the parser and the emitter agree
 * on them by construction.
 *
 * AST nodes are 6-slot records in one growable `i32` array:
 *   [kind, a, b, c, child, next]
 * `child` is the first operand / first list element, `next` the following
 * sibling in the parent's list (CAT parts, ALT options). Character-class
 * ranges live in a separate growable pool of `[lo, hi]` pairs.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { regexI32ArrayType } from "../native-regex.js";
import { addFuncType } from "../registry/types.js";
import { ensureExnTag } from "../registry/physical-imports.js";
import { Locals, add, c, get, mul, resolveLabels, type X } from "./dsl.js";

// ---- state struct fields -------------------------------------------------
export const F_SRC = 0; // (ref $strData) pattern code units
export const F_SOFF = 1; // pattern offset into F_SRC
export const F_SLEN = 2; // pattern length
export const F_POS = 3; // parse cursor
export const F_FLAGS = 4; // RE_FLAG_* bits
export const F_UMODE = 5; // 1 under the `u` flag
export const F_ERR = 6; // bail reason (ERR_*)
export const F_NODES = 7; // (ref $i32arr) AST node records
export const F_NCOUNT = 8; // number of nodes
export const F_RP = 9; // (ref $i32arr) range pool
export const F_RLEN = 10; // used i32 slots in F_RP
export const F_NCAP = 11; // captures seen so far by the parser
export const F_TCAP = 12; // total captures (pre-scan)
export const F_NAMES = 13; // (ref $i32arr) [start, len] of each group name, by capture index
export const F_HASNAMES = 14; // 1 when the pattern declares a named group
export const F_PROG = 15; // (ref $i32arr) bytecode
export const F_PC = 16; // emitted instruction count
export const F_CTAB = 17; // (ref $i32arr) class table
export const F_CLEN = 18; // used slots in F_CTAB
export const F_NSCR = 19; // PROGRESS scratch slots allocated
export const F_SBASE = 20; // first scratch slot (2 * nGroups)
export const F_CI = 21; // emitter: case-insensitive (modifier-scoped)
export const F_DOTALL = 22; // emitter: dotAll
export const F_MULTI = 23; // emitter: multiline
export const F_REV = 24; // emitter: reversed (lookbehind body)
export const F_PEND = 25; // (ref $i32arr) pending lookaround bodies [node, patchPc, state]
export const F_PENDLEN = 26; // used slots in F_PEND
export const F_T0 = 27; // scratch result slot
export const F_T1 = 28; // scratch result slot
export const F_PCI = 29; // parser: case-insensitive (modifier-scoped)
export const F_PDOTALL = 30; // parser: dotAll (modifier-scoped)
export const F_PROPS = 31; // 1 when the General_Category table is linked in

const ARR_FIELDS = new Set([F_NODES, F_RP, F_NAMES, F_PROG, F_CTAB, F_PEND]);
export const STATE_FIELD_COUNT = 32;

// ---- AST node kinds (mirror regex/parse.ts ReNode) ------------------------
export const K_CHAR = 0; // a = code point
export const K_ANY = 1; // non-u `.`
export const K_CLASS = 2; // a = pool start, b = pair count, c = negated, child = cached ctab offset
export const K_CPCLASS = 3; // same layout; code-point class (u mode)
export const K_BOL = 4;
export const K_EOL = 5;
export const K_WB = 6; // a = negated
export const K_BACKREF = 7; // a = group index
export const K_LOOK = 8; // child = body, a = negated, b = behind
export const K_MOD = 9; // child = body, a = add flags, b = remove flags
export const K_CAT = 11; // child = first part
export const K_ALT = 12; // child = first option
export const K_STAR = 13; // child, a = greedy
export const K_PLUS = 14; // child, a = greedy
export const K_OPT = 15; // child, a = greedy
export const K_REP = 16; // child, a = min, b = max (-1 unbounded), c = greedy
export const K_GROUP = 17; // child, a = capture index

export const NODE_W = 6;
export const N_KIND = 0;
export const N_A = 1;
export const N_B = 2;
export const N_C = 3;
export const N_CHILD = 4;
export const N_NEXT = 5;

// ---- bail reasons ---------------------------------------------------------
/** Valid-or-unknown pattern outside the runtime grammar → poisoned value. */
export const ERR_UNSUPPORTED = 1;
/** Definitely invalid pattern → SyntaxError. */
export const ERR_SYNTAX = 2;

/** Largest `{n,m}` bound the emitter expands (matches compile.ts). */
export const MAX_REPEAT = 1000;

export type RxFnName =
  | "grow"
  | "node"
  | "emit"
  | "range"
  | "peek"
  | "peekAt"
  | "scanGroups"
  | "parseName"
  | "nameIndex"
  | "parseAlt"
  | "parseTerm"
  | "parseAtom"
  | "parseGroup"
  | "parseEscape"
  | "escapeUnit"
  | "legacyOctal"
  | "hex"
  | "readCp"
  | "braceQuant"
  | "parseClass"
  | "classAtom"
  | "foldRange"
  | "shorthand"
  | "property"
  | "propMask"
  | "gcRanges"
  | "sortMerge"
  | "complementFrom"
  | "classNode"
  | "uChar"
  | "emitNode"
  | "emitList"
  | "emitAlt"
  | "emitStar"
  | "emitOpt"
  | "emitPlus"
  | "emitRep"
  | "emitChar"
  | "emitClear"
  | "canEmpty"
  | "capVisit"
  | "classOffset"
  | "drain";

export interface RxEnv {
  readonly ctx: CodegenContext;
  /** `$__RxState` struct type. */
  readonly st: number;
  /** Growable `i32` array type (shared with the VM's program arrays). */
  readonly arr: number;
  /** Native string code-unit array type. */
  readonly sdata: number;
  readonly tag: number;
  readonly fn: Record<RxFnName, number>;
  /** Whether the General_Category span table is linked into this module. */
  readonly withProps: boolean;
}

export const stRef = (E: RxEnv): ValType => ({ kind: "ref", typeIdx: E.st });
export const arrRef = (E: RxEnv): ValType => ({ kind: "ref", typeIdx: E.arr });

/** Ensure the `$__RxState` struct and return its type index. */
export function ensureRxStateType(ctx: CodegenContext): number {
  const name = "__RxState";
  const existing = ctx.structMap.get(name);
  if (existing !== undefined) return existing;
  const arr = regexI32ArrayType(ctx);
  const fields = Array.from({ length: STATE_FIELD_COUNT }, (_, i) => ({
    name: `f${i}`,
    type: (i === F_SRC
      ? { kind: "ref", typeIdx: ctx.nativeStrDataTypeIdx }
      : ARR_FIELDS.has(i)
        ? { kind: "ref", typeIdx: arr }
        : { kind: "i32" }) as ValType,
    mutable: true,
  }));
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name, fields });
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
  return typeIdx;
}

export function makeRxEnv(ctx: CodegenContext, fnNames: readonly RxFnName[], withProps: boolean): RxEnv {
  const fn = {} as Record<RxFnName, number>;
  for (const name of fnNames) fn[name] = mintDefinedFunc(ctx);
  return {
    ctx,
    st: ensureRxStateType(ctx),
    arr: regexI32ArrayType(ctx),
    sdata: ctx.nativeStrDataTypeIdx,
    tag: ensureExnTag(ctx),
    fn,
    withProps,
  };
}

/**
 * Define helper `name`: params are `[state, ...extra]`, the body is built
 * against a {@link Locals} allocator and label-resolved here.
 */
export function defineRxFn(
  E: RxEnv,
  name: RxFnName,
  extraParams: ValType[],
  results: ValType[],
  build: (L: Locals) => X,
  withoutState = false,
): void {
  const params = withoutState ? extraParams : [stRef(E), ...extraParams];
  const L = new Locals(params.length);
  const built = build(L);
  // Helper bodies rely on zero-initialised i32 locals (counters, flags, the
  // quantifier kind). Make that explicit: the IR inliner (ir-inline.ts)
  // relocates a callee's locals into its caller WITHOUT re-zeroing them, so an
  // inlined copy inside a caller's loop would otherwise see the previous
  // iteration's values.
  const zeroInit: X = L.defs.flatMap((def, i) =>
    def.type.kind === "i32" ? [...c(0), { op: "local.set", index: params.length + i } as Instr] : [],
  );
  const body = resolveLabels([...zeroInit, ...built]);
  pushDefinedFunc(E.ctx, E.fn[name], {
    name: `__rx_${name}`,
    typeIdx: addFuncType(E.ctx, params, results),
    locals: L.defs,
    body,
    exported: false,
  });
}

// ---- accessors -----------------------------------------------------------
/** Read a state field (state is local 0). */
export const sg = (E: RxEnv, field: number): X => [
  { op: "local.get", index: 0 },
  { op: "struct.get", typeIdx: E.st, fieldIdx: field },
];
/** Write a state field. */
export const ss = (E: RxEnv, field: number, value: X): X => [
  { op: "local.get", index: 0 },
  ...value,
  { op: "struct.set", typeIdx: E.st, fieldIdx: field },
];
export const ag = (E: RxEnv, array: X, index: X): X => [...array, ...index, { op: "array.get", typeIdx: E.arr }];
export const as = (E: RxEnv, array: X, index: X, value: X): X => [
  ...array,
  ...index,
  ...value,
  { op: "array.set", typeIdx: E.arr },
];
/** Pattern code unit at absolute index `index`. */
export const src = (E: RxEnv, index: X): X => [
  ...sg(E, F_SRC),
  ...add(sg(E, F_SOFF), index),
  { op: "array.get_u", typeIdx: E.sdata },
];
/** Node field read. */
export const nf = (E: RxEnv, node: X, field: number): X => ag(E, sg(E, F_NODES), add(mul(node, c(NODE_W)), c(field)));
/** Node field write. */
export const nset = (E: RxEnv, node: X, field: number, value: X): X =>
  as(E, sg(E, F_NODES), add(mul(node, c(NODE_W)), c(field)), value);
/** Record the bail reason and unwind to the driver's catch. */
export const bail = (E: RxEnv, reason: number): X => [
  ...ss(E, F_ERR, c(reason)),
  { op: "ref.null.extern" },
  { op: "throw", tagIdx: E.tag },
];
/** `state` local for passing along. */
export const ST: X = get(0);
/** Advance the parse cursor by `n`. */
export const advance = (E: RxEnv, n = 1): X => ss(E, F_POS, add(sg(E, F_POS), c(n)));

export type { Instr };
