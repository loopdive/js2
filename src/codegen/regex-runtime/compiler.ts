// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6677 — the runtime (Wasm-native) RegExp compiler: full-grammar fallback for
 * `new RegExp(dynamicPattern)` under `--target standalone`.
 *
 * `__regex_compile_dynamic_simple` (regexp-standalone.ts) hand-parses a small
 * literal/alternation subset and, for anything else, returned a POISONED
 * regexp whose first use throws `TypeError: Unsupported dynamic regular
 * expression pattern` (#4439). Real programs build their rules at run time —
 * marked's `k()` builder splices regex sources with `String.prototype.replace`
 * and calls `new RegExp(src, flags)` ~40 times at module init, using classes,
 * `{n,m}`, lazy quantifiers, lookahead AND lookbehind, backreferences, named
 * groups and `\p{…}` under `u`.
 *
 * This module compiles such a pattern to the SAME bytecode `compile.ts` emits
 * at compile time (parser: parse.ts, emitter: emit.ts), in Wasm, at run time,
 * and hands back an ordinary `$NativeRegExp` — so matching, `lastIndex`,
 * `exec`/`replace`/`split`/… are the existing VM paths, unchanged. It is a
 * fallback: the simple compiler's subset keeps its own specialised lowering,
 * and only its out-of-subset patterns reach this function.
 *
 * Outcomes, per pattern:
 *   - compiles → a runnable `$NativeRegExp`;
 *   - definitely invalid (unterminated group/class, nothing to repeat,
 *     `[z-a]`, `{2,1}`, u-mode strictness, …) → `SyntaxError` at construction,
 *     as §22.2.3.1 requires;
 *   - valid-or-unknown but outside what the runtime can model (non-ASCII case
 *     folding, most Unicode properties, `v` mode, duplicate group names,
 *     `{n,m}` beyond 1000) → `null`, and the caller keeps the #4439 poison
 *     (catchable TypeError on first use). A refusal is recoverable; a wrong
 *     match is not.
 * Host imports: none.
 */
import type { Instr } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { noJsHost } from "../js-errors.js";
import { nativeStringType } from "../native-strings.js";
import { ReOp, RE_FLAG_I, RE_FLAG_M, RE_FLAG_S, RE_FLAG_U, RE_FLAG_V } from "../regex/bytecode.js";
import { addFuncType } from "../registry/types.js";
import { defineCoreHelpers } from "./core.js";
import {
  I32,
  Locals,
  add,
  and,
  block,
  br,
  c,
  call,
  drop,
  eq,
  get,
  if_,
  lt,
  mul,
  ne,
  resolveLabels,
  ret,
  set,
  type X,
} from "./dsl.js";
import { defineEmitter } from "./emit.js";
import {
  ERR_SYNTAX,
  F_CI,
  F_CLEN,
  F_CTAB,
  F_DOTALL,
  F_ERR,
  F_FLAGS,
  F_MULTI,
  F_NAMES,
  F_NCAP,
  F_NODES,
  F_NSCR,
  F_PC,
  F_PCI,
  F_PDOTALL,
  F_PEND,
  F_POS,
  F_PROG,
  F_PROPS,
  F_RP,
  F_SBASE,
  F_SLEN,
  F_SOFF,
  F_SRC,
  F_UMODE,
  STATE_FIELD_COUNT,
  makeRxEnv,
  type RxEnv,
  type RxFnName,
} from "./env.js";
import { defineParser } from "./parse.js";
import { defineUnicodeProperties, regexPropertyTableLinked } from "./unicode.js";

const HELPERS: readonly RxFnName[] = [
  "grow",
  "node",
  "emit",
  "range",
  "peek",
  "peekAt",
  "scanGroups",
  "parseName",
  "nameIndex",
  "parseAlt",
  "parseTerm",
  "parseAtom",
  "parseGroup",
  "parseEscape",
  "escapeUnit",
  "legacyOctal",
  "hex",
  "readCp",
  "braceQuant",
  "parseClass",
  "classAtom",
  "foldRange",
  "shorthand",
  "property",
  "propMask",
  "gcRanges",
  "sortMerge",
  "complementFrom",
  "classNode",
  "uChar",
  "emitNode",
  "emitList",
  "emitAlt",
  "emitStar",
  "emitOpt",
  "emitPlus",
  "emitRep",
  "emitChar",
  "emitClear",
  "canEmpty",
  "capVisit",
  "classOffset",
  "drain",
];

const FULL_COMPILER = "__regex_compile_dynamic_full";

interface FullCompilerOptions {
  /** `$NativeRegExp` struct type index. */
  regexpStruct: number;
  /** `__str_flatten` function index. */
  flattenIdx: number;
  /** Instrs that construct and throw `SyntaxError("Invalid regular expression")`. */
  throwSyntax: Instr[];
}

/**
 * Ensure `__regex_compile_dynamic_full(pattern, flagBits) -> (ref null
 * $NativeRegExp)` and its helpers exist; returns the function index.
 */
function ensureFullDynamicRegExpCompiler(ctx: CodegenContext, opts: FullCompilerOptions): number {
  const existing = ctx.nativeRegexHelpers.get(FULL_COMPILER);
  if (existing !== undefined) return existing;
  const E = makeRxEnv(ctx, HELPERS, regexPropertyTableLinked(ctx));
  const fnIdx = mintDefinedFunc(ctx);
  ctx.nativeRegexHelpers.set(FULL_COMPILER, fnIdx);
  ctx.funcMap.set(FULL_COMPILER, fnIdx);
  defineCoreHelpers(E);
  defineParser(E);
  defineUnicodeProperties(E);
  defineEmitter(E);
  defineDriver(E, fnIdx, opts);
  return fnIdx;
}

/**
 * The fallback step spliced into `__regex_compile_dynamic_simple`'s
 * out-of-subset branch: try the full compiler and return its regexp when it
 * produced one. `locals` = [pattern, flagBits, scratch `(ref null $NativeRegExp)`].
 */
export function fullDynamicRegExpAttempt(
  ctx: CodegenContext,
  regexpStruct: number,
  flattenIdx: number,
  locals: readonly [number, number, number],
  throwSyntax: Instr[],
): Instr[] {
  const [pattern, flagBits, scratch] = locals;
  const fnIdx = ensureFullDynamicRegExpCompiler(ctx, { regexpStruct, flattenIdx, throwSyntax });
  return [
    { op: "local.get", index: pattern },
    { op: "local.get", index: flagBits },
    { op: "call", funcIdx: fnIdx },
    { op: "local.tee", index: scratch },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [],
      else: [{ op: "local.get", index: scratch }, { op: "ref.as_non_null" }, { op: "return" }],
    },
  ];
}

/**
 * Instrs that AND the simple compiler's "in subset" flag with "no `i`/`u`
 * flag" (standalone only; `[]` elsewhere). The simple compiler's per-unit
 * lowering is only right for flag-free code-unit matching: under `u` its `.`
 * consumes half a surrogate pair, and under `i` it ASCII-folds every unit, so
 * `/é/i` silently missed `É`. The full compiler models both (code-point
 * classes; exact ASCII folding, refusing the rest).
 */
export function simpleSubsetFlagGate(ctx: CodegenContext, flagBitsLocal: number): Instr[] {
  if (!noJsHost(ctx)) return [];
  return [
    { op: "local.get", index: flagBitsLocal },
    { op: "i32.const", value: RE_FLAG_I | RE_FLAG_U },
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "i32.and" },
  ];
}

function defineDriver(E: RxEnv, fnIdx: number, opts: FullCompilerOptions): void {
  const { ctx } = E;
  const PATTERN = 0;
  const FBITS = 1;
  const L = new Locals(2);
  const FLAT = L.add("flat", { kind: "ref", typeIdx: ctx.nativeStrTypeIdx });
  const STATE = L.add("state", { kind: "ref", typeIdx: E.st });
  const ROOT = L.add("root");
  const PROG = L.add("prog", { kind: "ref", typeIdx: E.arr });
  const CTAB = L.add("ctab", { kind: "ref", typeIdx: E.arr });
  const field = (index: number): X => [...get(STATE), { op: "struct.get", typeIdx: E.st, fieldIdx: index }];
  const setField = (index: number, value: X): X => [
    ...get(STATE),
    ...value,
    { op: "struct.set", typeIdx: E.st, fieldIdx: index },
  ];
  const helper = (name: RxFnName, ...args: X[]): X => call(E.fn[name], get(STATE), ...args);
  const newArr = (len: number): X => [...c(len), { op: "array.new_default", typeIdx: E.arr }];
  const flag = (bit: number): X => ne(and(get(FBITS), c(bit)), c(0));
  const flat = (index: number): X => [
    ...get(FLAT),
    { op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: index },
  ];
  const init: X[] = Array.from({ length: STATE_FIELD_COUNT }, () => c(0));
  init[F_SRC] = flat(2);
  init[F_SOFF] = flat(1);
  init[F_SLEN] = flat(0);
  init[F_FLAGS] = get(FBITS);
  init[F_UMODE] = flag(RE_FLAG_U);
  init[F_NODES] = newArr(96);
  init[F_RP] = newArr(32);
  init[F_NAMES] = newArr(2);
  init[F_PROG] = newArr(96);
  init[F_CTAB] = newArr(16);
  init[F_CI] = flag(RE_FLAG_I);
  init[F_DOTALL] = flag(RE_FLAG_S);
  init[F_MULTI] = flag(RE_FLAG_M);
  init[F_PEND] = newArr(6);
  init[F_PCI] = flag(RE_FLAG_I);
  init[F_PDOTALL] = flag(RE_FLAG_S);
  init[F_PROPS] = c(E.withProps ? 1 : 0);
  const trimmed = (target: number, source: number, len: X): X => [
    ...set(target, [...len, { op: "array.new_default", typeIdx: E.arr }]),
    ...get(target),
    ...c(0),
    ...field(source),
    ...c(0),
    ...len,
    { op: "array.copy", dstTypeIdx: E.arr, srcTypeIdx: E.arr },
  ];
  const nullResult: X = [{ op: "ref.null", typeIdx: opts.regexpStruct }];
  const compile: X = [
    ...helper("scanGroups"),
    ...set(ROOT, helper("parseAlt")),
    // Input left over after a complete Disjunction can only be a stray `)`.
    ...if_(lt(field(F_POS), field(F_SLEN)), [
      ...setField(F_ERR, c(ERR_SYNTAX)),
      { op: "ref.null.extern" },
      { op: "throw", tagIdx: E.tag },
    ]),
    // Scratch (PROGRESS) slots live after the 2 * nGroups capture slots.
    ...setField(F_SBASE, mul(c(2), add(field(F_NCAP), c(1)))),
    ...drop(helper("emit", c(ReOp.SAVE), c(0), c(0))),
    ...helper("emitNode", get(ROOT)),
    ...drop(helper("emit", c(ReOp.SAVE), c(1), c(0))),
    ...drop(helper("emit", c(ReOp.MATCH), c(0), c(0))),
    ...helper("drain"),
  ];
  const body: X = [
    // `v` mode (set notation, strings) is out of scope.
    ...if_(flag(RE_FLAG_V), ret(nullResult)),
    ...set(FLAT, call(opts.flattenIdx, get(PATTERN))),
    ...init.flat(),
    { op: "struct.new", typeIdx: E.st },
    { op: "local.set", index: STATE },
    // Every bail throws out of the helper stack; nothing else can throw here
    // (no user code runs), so a catch-all is exactly "compile failed". Standard
    // `try_table` (not legacy `try`): the rest of the module uses exnref EH and
    // V8 must not see the two mixed (Node 25 aborts compiling such a module).
    ...block("compiled", [
      ...block("failed", [
        // catch_all depth 0 = the enclosing `failed` block.
        { op: "try_table", blockType: { kind: "empty" }, body: compile, catches: [{ kind: "catch_all", depth: 0 }] },
        ...br("compiled"),
      ]),
      ...if_(eq(field(F_ERR), c(ERR_SYNTAX)), opts.throwSyntax),
      ...ret(nullResult),
    ]),
    ...trimmed(PROG, F_PROG, mul(field(F_PC), c(3))),
    ...trimmed(CTAB, F_CTAB, field(F_CLEN)),
    // $NativeRegExp { flags, nGroups, prog, classTable, source, nScratch,
    //                 lastIndex, lastIndexRaw, lastIndexRawPresent, nonWritable }
    ...get(FBITS),
    ...add(field(F_NCAP), c(1)),
    ...get(PROG),
    ...get(CTAB),
    ...get(PATTERN),
    ...field(F_NSCR),
    { op: "f64.const", value: 0 },
    { op: "ref.null.extern" },
    ...c(0),
    ...c(0),
    { op: "struct.new", typeIdx: opts.regexpStruct },
  ];
  pushDefinedFunc(ctx, fnIdx, {
    name: FULL_COMPILER,
    typeIdx: addFuncType(ctx, [nativeStringType(ctx), I32], [{ kind: "ref_null", typeIdx: opts.regexpStruct }]),
    locals: L.defs,
    body: resolveLabels(body),
    exported: false,
  });
}
