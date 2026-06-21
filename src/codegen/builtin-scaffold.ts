// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Per-builtin representation scaffold (#2088).
 *
 * Many string-producing builtins (`Array.prototype.join`,
 * `String.fromCharCode`, `String.fromCodePoint`, …) re-derive the same three
 * primitives once *per representation*:
 *
 *   1. element load (`array.get` family — already a one-liner),
 *   2. element → string (the "ToString" matrix), and
 *   3. concatenation + separator / empty-string handling.
 *
 * Because the concatenation/null-handling primitive was copied independently
 * into the host, native-string, and standalone lanes of each builtin, a bug
 * fixed in one lane silently survived in the others — `join` bred #1968 /
 * #1998 / #2074 / #2075 (one per variant) and `fromCharCode` bred #2122 /
 * #1955 (the single-arg drop copied into all four arms).
 *
 * This module owns that primitive **once**, parameterized by a
 * {@link StringRepr} strategy. Each builtin supplies only the parts that are
 * genuinely representation-specific (how a single element becomes a string);
 * the fold / separator / empty-string structure is shared, so a deliberate
 * bug in `emitStringJoinFold` / `emitVariadicStringConcat` regresses **every**
 * lane at once — the structural guarantee #2088 asks for.
 *
 * Scope note: the externref-receiver `join` fallback (`__array_join_any`) is a
 * single host delegation with no per-element matrix, so it is intentionally
 * NOT routed through here — it never bred a drift bug because there is nothing
 * to drift.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import {
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  nativeStringType,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/**
 * A string representation strategy: the minimal per-representation seam the
 * shared builtin lowerings need. Each builtin lane picks one of the concrete
 * reprs ({@link hostStringRepr} / {@link nativeStringRepr}); everything else
 * — the fold structure, the separator placement, the empty-string fallback —
 * is shared.
 */
export interface StringRepr {
  /** Wasm type of a value produced by this representation's string operations. */
  readonly resultType: ValType;
  /**
   * Materialize a string literal (separator, empty string, …) onto the stack.
   * Host repr emits a `string_constants` global; native repr emits a
   * `$NativeString` cast up to `$AnyString`.
   */
  literal(value: string): Instr[];
  /**
   * Concatenate two operands. `a` and `b` are instruction sequences that each
   * leave exactly one {@link resultType} value on the stack; the returned
   * sequence leaves their concatenation. Host repr calls the `wasm:js-string`
   * `concat` builtin; native repr calls the pure-Wasm `__str_concat` helper.
   */
  concat(a: Instr[], b: Instr[]): Instr[];
}

/**
 * Host (JS-string) representation: results are `externref`, concatenation is
 * the `wasm:js-string` `concat` builtin, literals are `string_constants`
 * globals. Returns `undefined` if the `concat` builtin is not registered (the
 * caller must already have ensured string support).
 */
export function hostStringRepr(ctx: CodegenContext): StringRepr | undefined {
  const concatIdx = ctx.jsStringImports.get("concat");
  if (concatIdx === undefined) return undefined;
  return {
    resultType: { kind: "externref" },
    literal(value: string): Instr[] {
      addStringConstantGlobal(ctx, value);
      return stringConstantExternrefInstrs(ctx, value);
    },
    concat(a: Instr[], b: Instr[]): Instr[] {
      return [...a, ...b, { op: "call", funcIdx: concatIdx } as Instr];
    },
  };
}

/**
 * Native-string (standalone / WASI) representation: results are
 * `(ref $AnyString)`, concatenation is the pure-Wasm `__str_concat` helper,
 * literals are inline `$NativeString` values cast up to `$AnyString`. Zero
 * host imports. Returns `undefined` if the native string helpers cannot be
 * provisioned.
 */
export function nativeStringRepr(ctx: CodegenContext): StringRepr | undefined {
  ensureNativeStringHelpers(ctx);
  const strConcatIdx = ctx.nativeStrHelpers.get("__str_concat");
  if (strConcatIdx === undefined || ctx.anyStrTypeIdx < 0) return undefined;
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  return {
    resultType: nativeStringType(ctx),
    literal(value: string): Instr[] {
      // `nativeStringLiteralInstrs` yields a `$NativeString`; cast up to the
      // `$AnyString` supertype so it composes with `__str_concat` (which is
      // typed over `$AnyString`).
      return [...nativeStringLiteralInstrs(ctx, value), { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr];
    },
    concat(a: Instr[], b: Instr[]): Instr[] {
      return [...a, ...b, { op: "call", funcIdx: strConcatIdx } as Instr];
    },
  };
}

/**
 * Shared variadic string-concatenation primitive (#2088).
 *
 * Folds `parts[0] ++ parts[1] ++ … ++ parts[n-1]` left-to-right using the
 * representation's `concat`. Each `parts[i]` is an instruction sequence that
 * leaves exactly one `repr.resultType` value on the stack. Used by the
 * `String.fromCharCode` / `String.fromCodePoint` lanes (each argument's code
 * unit becomes a one-char string `part`); the spec's left-to-right argument
 * evaluation order is preserved because the parts are already compiled in
 * order by the caller.
 *
 * With a single part this is the identity (no `concat` call), matching the
 * spec for a 1-argument call. Callers must pass at least one part.
 */
export function emitVariadicStringConcat(repr: StringRepr, parts: Instr[][]): Instr[] {
  if (parts.length === 0) {
    // Empty arg list is not produced by the current callers (fromCharCode
    // requires ≥1 arg); fall back to the empty string defensively.
    return repr.literal("");
  }
  let acc = parts[0]!;
  for (let i = 1; i < parts.length; i++) {
    acc = repr.concat(acc, parts[i]!);
  }
  return acc;
}

/** Locals threaded through {@link emitStringJoinFold}. */
export interface JoinFoldLocals {
  /** i32 — current iteration index. */
  iTmp: number;
  /** i32 — element count. */
  lenTmp: number;
  /** `repr.resultType` — accumulator (also the eventual return). */
  resultTmp: number;
  /** `repr.resultType` — separator. */
  sepTmp: number;
}

/**
 * Shared array-join fold (#2088).
 *
 * Emits, into `fctx.body`, the canonical join loop shared by every `join`
 * representation:
 *
 *   for (i = 0; i < len; i++)
 *     result = (i == 0) ? toStr(elem_i)
 *                       : concat(concat(result, sep), toStr(elem_i))
 *
 * followed by the empty-array fallback (`result` left null / unset ⇒ `""`,
 * never `null`, which downstream string consumers would render as `"null"` —
 * the #1968 bug). `elemToStr` is the only representation- *and* element-type-
 * specific input: an instruction sequence that loads element `iTmp` from the
 * backing array and leaves its string form (a `repr.resultType` value) on the
 * stack.
 *
 * The caller is responsible for:
 *   - allocating + initializing the locals in `locals` (sep, result="", i=0),
 *   - setting `lenTmp` from the receiver length,
 *   - emitting any post-fold conversion (e.g. native `extern.convert_any`).
 *
 * Because both the host and native `join` lanes emit their loop body here, a
 * bug in this function regresses both lanes simultaneously.
 */
export function emitStringJoinFold(
  ctx: CodegenContext,
  fctx: FunctionContext,
  repr: StringRepr,
  locals: JoinFoldLocals,
  elemToStr: Instr[],
): void {
  const { iTmp, lenTmp, resultTmp, sepTmp } = locals;

  const concatWithSep = repr.concat(
    [{ op: "local.get", index: resultTmp } as Instr],
    [{ op: "local.get", index: sepTmp } as Instr],
  );

  const loopBody: Instr[] = [
    { op: "local.get", index: iTmp },
    { op: "local.get", index: lenTmp },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },

    // result = (i == 0) ? elem : concat(concat(result, sep), elem)
    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 0 },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...elemToStr, { op: "local.set", index: resultTmp } as Instr],
      else: [...repr.concat(concatWithSep, elemToStr), { op: "local.set", index: resultTmp } as Instr],
    } as Instr,

    { op: "local.get", index: iTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: iTmp },
    { op: "br", depth: 0 },
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
  });
}

/**
 * Allocate the standard join-fold locals for `repr`. The accumulator and
 * separator carry `repr.resultType`; the index/length are i32.
 */
export function allocJoinFoldLocals(fctx: FunctionContext, repr: StringRepr, tag: string): JoinFoldLocals {
  return {
    lenTmp: allocLocal(fctx, `__${tag}_len_${fctx.locals.length}`, { kind: "i32" }),
    iTmp: allocLocal(fctx, `__${tag}_i_${fctx.locals.length}`, { kind: "i32" }),
    resultTmp: allocLocal(fctx, `__${tag}_res_${fctx.locals.length}`, repr.resultType),
    sepTmp: allocLocal(fctx, `__${tag}_sep_${fctx.locals.length}`, repr.resultType),
  };
}
