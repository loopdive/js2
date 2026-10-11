// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B5) §22.2.6.14 **`RegExp.prototype[@@split]`**, the
 * generic body, standalone — wired onto B2's observable `RegExpExec` substrate.
 *
 * ```
 *   1-3. rx = this; Type(rx) must be Object; S = ? ToString(string)
 *   4.   C = ? SpeciesConstructor(rx, %RegExp%)
 *   5.   flags = ? ToString(? Get(rx, "flags"))
 *   6.   unicodeMatching = flags contains "u" (or "v")
 *   7.   newFlags = flags contains "y" ? flags : flags + "y"
 *   8.   splitter = ? Construct(C, « rx, newFlags »)
 *   9-10. A = ArrayCreate(0); lengthA = 0
 *   11.  lim = limit is undefined ? 2^32 - 1 : ℝ(? ToUint32(limit))
 *   12.  if lim = 0, return A
 *   13.  if S is empty: z = ? RegExpExec(splitter, S);
 *        if z is not null return A; else A[0] = S; return A
 *   14-17. p = q = 0; while q < size:
 *          ? Set(splitter, "lastIndex", q); z = ? RegExpExec(splitter, S)
 *          z null ⇒ q = AdvanceStringIndex(S, q, unicodeMatching)
 *          else e = min(ℝ(? ToLength(? Get(splitter, "lastIndex"))), size)
 *               e = p ⇒ q = AdvanceStringIndex(S, q, unicodeMatching)
 *               else push S[p, q); p = e;
 *                    captures = max(? LengthOfArrayLike(z) - 1, 0)
 *                    push ? Get(z, ToString(i)) for i in 1..captures
 *                    (each push: lengthA = lim ⇒ return A); q = p
 *   18-20. push S[p, size); return A
 * ```
 *
 * ## Why the splitter is the whole method
 *
 * Every observable the test262 `@@split` directory checks hangs off step 4's
 * SpeciesConstructor and step 8's Construct: a user species constructor
 * receives `(rx, newFlags)` (`species-ctor`, `species-ctor-y`), returns an
 * arbitrary object whose `exec` / `lastIndex` accessors the walk then drives
 * (`str-*`), and the `constructor` / `@@species` reads each have a poisoned-
 * getter row. So the walk is written over the SPLITTER as an arbitrary Object
 * through `[[Get]]`/`[[Set]]` and B2's `RegExpExec`, exactly like the `@@match`
 * collect loop, and never touches the `$NativeRegExp` struct directly.
 *
 * ## Where the `$NativeRegExp` struct is touched
 *
 * Twice, and only at the edges. `emitBuiltinExec(splitterLocal, sLocal)` —
 * RegExpExec steps 5-6 for a genuine RegExp SPLITTER (the splitter local, not
 * `this`) — is passed in by `regexp-standalone.ts`, as for B2's bodies.
 * {@link emitDefaultRegExpSplitter} — `Construct(%RegExp%, « rx, newFlags »)`,
 * the default lane of step 4 — lives here, built from the struct accessors
 * `regexp-standalone.ts` exports.
 *
 * ## SpeciesConstructor's default lane is decided by identity, not by absence
 *
 * In standalone `/a/.constructor` IS the reified `RegExp` carrier and
 * `RegExp[Symbol.species]` answers that same carrier (measured). Treating it as
 * an ordinary constructor would hand the carrier to the ordinary-function
 * `[[Construct]]` driver, which knows nothing about RegExp. So an `@@species`
 * value that is SameValue to the `%RegExp%` identity global
 * (`reserveBuiltinConstructorIdentityGlobal`) takes the default lane — which is
 * what §10.1.13 step 7 returns for it anyway (`IsConstructor(%RegExp%)` holds
 * and the default constructor IS `%RegExp%`), so the shortcut is exact.
 *
 * ## What the emitted code uses
 *
 * The B2 substrate's natives plus `__box_symbol`, `__extern_is_undefined`,
 * `__typeof_function`, `__reflect_is_constructor`, the ordinary-constructor
 * driver `__native_construct_2` (#3981), `__str_concat` / `__str_substring`,
 * and the standalone ToNumber chain. No new host import.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { moduleTouchesConstructorProp } from "./builtin-instance-constructor-prototype.js";
import { emitBuiltinConstructorIdentity, reserveBuiltinConstructorIdentityGlobal } from "./builtin-static-globals.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { getWellKnownSymbolId } from "./literals.js";
import { reserveNativeConstructDriver } from "./native-construct.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureReflectIsConstructor } from "./reflect-construct-native.js";
import { RE_FLAG_Y } from "./regex/bytecode.js";
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
import {
  ensureDynamicStandaloneRegExpCompiler,
  ensureRuntimeToStringIdx,
  ensureStandaloneRegExpStruct,
} from "./regexp-standalone.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { compileExpression } from "./shared.js";
import { prepareStandaloneExternrefToNumberProviders } from "./tonumber-fast-paths.js";
import { coerceType } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

/** `@@species` — the well-known symbol id interned by the native `$Symbol` carrier. */
const SYMBOL_SPECIES_ID = 5;

/** 2^32, the ToUint32 modulus. */
const TWO_POW_32 = 4294967296;

/** Everything the `@@split` body needs beyond the RegExpExec substrate and the match-loop readers. */
export interface SplitDeps {
  readonly boxSymbol: number;
  readonly isUndefined: number;
  readonly typeofFunction: number;
  readonly isConstructor: number;
  readonly construct2: number;
  readonly strConcat: number;
  readonly strSubstring: number;
  /**
   * `[externref] → [f64]` ToNumber: the fused `__to_number`, or `[toPrimitive,
   * unbox]`. A BUILDER, not an array: it is spliced at three sites, and one
   * Instr object at two body positions is remapped twice by the finalize walks.
   */
  readonly toNumber: () => Instr[];
  readonly regexpCtorGlobal: number;
}

export function prepareSplitDeps(ctx: CodegenContext, fctx: FunctionContext): SplitDeps | undefined {
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  ensureReflectIsConstructor(ctx);
  for (const key of ["constructor", "flags", "length", "prototype", "y", "u", "v"]) addStringConstantGlobal(ctx, key);
  reserveNativeConstructDriver(ctx, 2, stringConstantExternrefInstrs(ctx, "prototype"));
  const providers = prepareStandaloneExternrefToNumberProviders(ctx, fctx);
  if (providers !== undefined) addStringConstantGlobal(ctx, "number");
  const regexpCtorGlobal = reserveBuiltinConstructorIdentityGlobal(ctx, "RegExp");
  flushLateImportShifts(ctx, fctx);

  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const boxSymbol = get("__box_symbol");
  const isUndefined = get("__extern_is_undefined");
  const typeofFunction = get("__typeof_function");
  const isConstructor = get("__reflect_is_constructor");
  const construct2 = get("__native_construct_2");
  const strConcat = ctx.nativeStrHelpers.get("__str_concat");
  const strSubstring = ctx.nativeStrHelpers.get("__str_substring");
  const unbox = get("__unbox_number");
  if (
    boxSymbol === undefined ||
    isUndefined === undefined ||
    typeofFunction === undefined ||
    isConstructor === undefined ||
    construct2 === undefined ||
    strConcat === undefined ||
    strSubstring === undefined ||
    unbox === undefined
  ) {
    return undefined;
  }
  // Resolved by NAME after the flush, never from the `providers` handles: the
  // handles were captured before `flushLateImportShifts` ran.
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
  return {
    boxSymbol,
    isUndefined,
    typeofFunction,
    isConstructor,
    construct2,
    strConcat,
    strSubstring,
    toNumber,
    regexpCtorGlobal,
  };
}

/**
 * `[] → [i32]` — "is `local` the value `undefined`" (NOT `null`).
 *
 * `__extern_is_undefined` answers 1 for a bare `ref.null.extern` too. Under the
 * #2106 singleton regime null and undefined are distinct values, and the two
 * places this is asked both care: SpeciesConstructor step 3 makes an explicit
 * `constructor = null` a TypeError (`species-ctor-ctor-non-obj`), and
 * `ToUint32(null)` is 0, not "no limit". Without the regime they share one
 * representation and the conservative answer is the only one available.
 */
export function isUndefinedInstrs(ctx: CodegenContext, split: SplitDeps, local: number): Instr[] {
  const base: Instr[] = [
    { op: "local.get", index: local },
    { op: "call", funcIdx: split.isUndefined },
  ];
  if (!undefinedSingletonActive(ctx)) return base;
  return [...base, { op: "local.get", index: local }, { op: "ref.is_null" }, { op: "i32.eqz" }, { op: "i32.and" }];
}

/** `[] → [i32]` — `Type(local) is Object`, counting callables (a species constructor is a function). */
function isObjectOrFunctionInstrs(deps: RegExpExecProtocolDeps, split: SplitDeps, local: number): Instr[] {
  return [
    { op: "local.get", index: local },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        { op: "local.get", index: local },
        { op: "call", funcIdx: deps.typeofObject },
        { op: "local.get", index: local },
        { op: "call", funcIdx: split.typeofFunction },
        { op: "i32.or" },
      ],
    },
  ];
}

/**
 * `[] → []` — §10.1.13 **SpeciesConstructor**(rx, %RegExp%). Sets `useDefLocal`
 * to 1 for the default lane, else leaves the constructor in `ctorLocal`.
 */
function buildSpeciesConstructorInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deps: RegExpExecProtocolDeps,
  split: SplitDeps,
  rxLocal: number,
  ctorLocal: number,
  useDefLocal: number,
): Instr[] {
  const throwNonObj = buildThrowJsErrorInstrs(ctx, "TypeError", "SpeciesConstructor: constructor is not an Object", {
    flush: fctx,
  });
  const throwNonCtor = buildThrowJsErrorInstrs(ctx, "TypeError", "SpeciesConstructor: @@species is not a constructor", {
    flush: fctx,
  });
  const nullish: Instr[] = [
    { op: "local.get", index: ctorLocal },
    { op: "ref.is_null" },
    { op: "local.get", index: ctorLocal },
    { op: "call", funcIdx: split.isUndefined },
    { op: "i32.or" },
  ];
  const isIntrinsicRegExp: Instr[] = [
    { op: "local.get", index: ctorLocal },
    { op: "global.get", index: split.regexpCtorGlobal },
    { op: "call", funcIdx: deps.sameValueZero },
  ];
  // steps 4-7, reached only for an Object C.
  const speciesArm: Instr[] = [
    { op: "local.get", index: ctorLocal },
    { op: "i32.const", value: SYMBOL_SPECIES_ID },
    { op: "call", funcIdx: split.boxSymbol },
    { op: "call", funcIdx: deps.externGet },
    { op: "local.set", index: ctorLocal },
    ...nullish,
    ...isIntrinsicRegExp,
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: useDefLocal },
      ],
      else: [
        { op: "local.get", index: ctorLocal },
        { op: "call", funcIdx: split.isConstructor },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwNonCtor, else: [] },
      ],
    },
  ];
  return [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: useDefLocal },
    // step 1 — C = ? Get(O, "constructor"); a poisoned getter throws here.
    ...buildGetInstrs(ctx, deps, rxLocal, "constructor"),
    { op: "local.set", index: ctorLocal },
    // step 2 — undefined ⇒ default.
    ...isUndefinedInstrs(ctx, split, ctorLocal),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 1 },
        { op: "local.set", index: useDefLocal },
      ],
      else: [
        // step 3 — a primitive (or null) C is a TypeError.
        ...isObjectOrFunctionInstrs(deps, split, ctorLocal),
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: throwNonObj, else: [] },
        ...speciesArm,
      ],
    },
  ];
}

/**
 * `[externref] → [f64]` — ℝ(ToUint32(v)) for a value already known not to be
 * undefined: ToNumber, then NaN/±∞ ⇒ 0, else truncate and reduce modulo 2^32.
 */
export function buildToUint32Instrs(split: SplitDeps, nLocal: number): Instr[] {
  return [
    ...split.toNumber(),
    { op: "local.set", index: nLocal },
    // n - n is NaN exactly for NaN and ±∞.
    { op: "local.get", index: nLocal },
    { op: "local.get", index: nLocal },
    { op: "f64.sub" },
    { op: "f64.const", value: 0 },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "val", type: F64 },
      then: [{ op: "f64.const", value: 0 }],
      else: [
        { op: "local.get", index: nLocal },
        { op: "f64.trunc" },
        { op: "local.tee", index: nLocal },
        { op: "local.get", index: nLocal },
        { op: "f64.const", value: TWO_POW_32 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "f64.const", value: TWO_POW_32 },
        { op: "f64.mul" },
        { op: "f64.sub" },
      ],
    },
  ];
}

/**
 * `[externref] → [i32]` — ℝ(ToLength(v)) clamped into i32. `i32.trunc_sat`
 * answers 0 for NaN (ToLength's own answer) and saturates a huge value, which
 * every consumer here immediately clamps to the subject size; a negative
 * value is ToLength's 0.
 */
function buildToLengthI32Instrs(split: SplitDeps, tmpLocal: number): Instr[] {
  return [
    ...split.toNumber(),
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: tmpLocal },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: tmpLocal },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "select" },
  ];
}

/**
 * (#6651 B5) `Construct(%RegExp%, « rx, newFlags »)` — §22.2.6.14 step 8's
 * DEFAULT lane — leaving the splitter as an externref.
 *
 * §22.2.4.1 step 1 `IsRegExp(pattern)` reads `pattern[@@match]` first, and that
 * `Get` is observable (Annex B `Symbol.match-getter-recompiles-source`
 * recompiles the receiver from inside the getter), so it runs before the
 * receiver's internal slots are read. Then:
 *
 * - a genuine `$NativeRegExp` (it has [[RegExpMatcher]], so P is its
 *   [[OriginalSource]]) is CLONED: same program, class table, source and group
 *   counts, a fresh `lastIndex` of 0, and the flag bits OR'd with `y`
 *   (`newFlags` always contains `y` by step 7). Deliberate narrowing: the other
 *   flag bits are the receiver's own rather than re-parsed from `newFlags`,
 *   because the program is compiled for them — so a program that overrides
 *   `flags` on a real RegExp to ADD `i`/`m`/`s`/`u` splits with the receiver's
 *   matcher.
 * - anything else is `RegExpInitialize(ToString(rx), newFlags)` through the
 *   runtime compiler (`__regex_compile_dynamic_simple`), which raises the
 *   SyntaxError for invalid flags (`"undefinedy"` for a receiver with no
 *   `flags`) and poisons an out-of-subset pattern. `IsRegExp`'s
 *   `Get(rx, "source")` arm for a non-RegExp that claims `@@match` is not
 *   modelled (P is `rx` itself).
 */
function emitDefaultRegExpSplitter(
  ctx: CodegenContext,
  fctx: FunctionContext,
  rxLocal: number,
  newFlagsLocal: number,
): void {
  const structTypeIdx = ensureStandaloneRegExpStruct(ctx);
  const dynMinted = ensureDynamicStandaloneRegExpCompiler(ctx);
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const toStringIdx = ensureRuntimeToStringIdx(ctx, fctx); // also flushes the two registrations above
  const dynIdx = ctx.nativeRegexHelpers.get("__regex_compile_dynamic_simple") ?? dynMinted;
  const boxSymbol = ctx.funcMap.get("__box_symbol");
  const externGet = ctx.funcMap.get("__extern_get");
  const matchId = getWellKnownSymbolId("match");
  if (toStringIdx === undefined || boxSymbol === undefined || externGet === undefined || matchId === undefined) {
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  const reLocal = allocLocal(fctx, `__rsp_src_${fctx.locals.length}`, { kind: "ref", typeIdx: structTypeIdx });
  const field = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: reLocal },
    { op: "struct.get", typeIdx: structTypeIdx, fieldIdx },
  ];
  const asAnyString = (): Instr[] => [{ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx }];
  fctx.body.push(
    { op: "local.get", index: rxLocal },
    { op: "i32.const", value: matchId },
    { op: "call", funcIdx: boxSymbol },
    { op: "call", funcIdx: externGet },
    { op: "drop" },
    { op: "local.get", index: rxLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: structTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        { op: "local.get", index: rxLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: structTypeIdx },
        { op: "local.set", index: reLocal },
        // `$NativeRegExp` field order: flags, nGroups, prog, classTable,
        // source, nScratch, lastIndex, lastIndexRaw, lastIndexRawPresent,
        // $lastIndexNonWritable.
        ...field(0),
        { op: "i32.const", value: RE_FLAG_Y },
        { op: "i32.or" },
        ...field(1),
        ...field(2),
        ...field(3),
        ...field(4),
        ...field(5),
        { op: "f64.const", value: 0 },
        { op: "ref.null.extern" },
        { op: "i32.const", value: 0 },
        { op: "i32.const", value: 0 },
        { op: "struct.new", typeIdx: structTypeIdx },
        { op: "extern.convert_any" },
      ],
      else: [
        { op: "local.get", index: rxLocal },
        { op: "call", funcIdx: toStringIdx },
        ...asAnyString(),
        { op: "local.get", index: newFlagsLocal },
        ...asAnyString(),
        { op: "call", funcIdx: dynIdx },
        { op: "extern.convert_any" },
      ],
    },
  );
}

/**
 * (#6651 B5) The STATIC `re.constructor` read on a RegExp-typed receiver, in a
 * module that writes, deletes or defines a `constructor` property somewhere.
 *
 * The #3006 fold answers the identity-stable `%RegExp%` carrier without looking
 * at the receiver, which is exact until a program installs an OWN `constructor`
 * — the SpeciesConstructor idiom `re.constructor = function () {};
 * re.constructor[Symbol.species] = …` then wrote `@@species` onto `%RegExp%`
 * itself, and the split body (which reads `constructor` through a real
 * `[[Get]]`) never saw it. So an own property wins, and the carrier answers
 * otherwise: `__hasOwnProperty(re, "constructor") ? __extern_get(re,
 * "constructor") : %RegExp%`. (`__extern_get` alone is not enough: it answers
 * `undefined` for an unmodified RegExp, where §20.1.3.1 says `%RegExp%`.)
 *
 * Returns `undefined` — having emitted nothing — outside that shape or when a
 * native is unavailable; the caller then keeps the #3006 fold.
 */
export function tryEmitRegExpOwnConstructorRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  builtinName: string,
): ValType | undefined {
  if (builtinName !== "RegExp" || !moduleTouchesConstructorProp(expr.getSourceFile())) return undefined;
  ensureLateImport(ctx, "__hasOwnProperty", [EXTERNREF, EXTERNREF], [I32]);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  addStringConstantGlobal(ctx, "constructor");
  flushLateImportShifts(ctx, fctx);
  if (ctx.funcMap.get("__hasOwnProperty") === undefined || ctx.funcMap.get("__extern_get") === undefined) {
    return undefined;
  }
  const recvLocal = allocLocal(fctx, `__rsp_ctor_recv_${fctx.locals.length}`, EXTERNREF);
  const recv = compileExpression(ctx, fctx, expr.expression, EXTERNREF);
  if (recv === null) return undefined;
  if (recv.kind !== "externref") coerceType(ctx, fctx, recv, EXTERNREF);
  fctx.body.push({ op: "local.set", index: recvLocal });
  const carrier = captureInto(fctx, () => void emitBuiltinConstructorIdentity(ctx, fctx, builtinName));
  // Resolved AFTER the carrier emission, which may register natives of its own.
  const hasOwn = ctx.funcMap.get("__hasOwnProperty")!;
  const externGet = ctx.funcMap.get("__extern_get")!;
  fctx.body.push(
    { op: "local.get", index: recvLocal },
    ...stringConstantExternrefInstrs(ctx, "constructor"),
    { op: "call", funcIdx: hasOwn },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [
        { op: "local.get", index: recvLocal },
        ...stringConstantExternrefInstrs(ctx, "constructor"),
        { op: "call", funcIdx: externGet },
      ],
      else: carrier,
    },
  );
  return EXTERNREF;
}

/** The locals and resolved natives the §22.2.6.14 walk builders read. */
interface SplitWalk {
  readonly ctx: CodegenContext;
  readonly fctx: FunctionContext;
  readonly deps: RegExpExecProtocolDeps;
  readonly loop: MatchLoopDeps;
  readonly split: SplitDeps;
  readonly sLocal: number;
  readonly splitterLocal: number;
  readonly uLocal: number;
  readonly aLocal: number;
  readonly lenALocal: number;
  readonly limLocal: number;
  readonly flatSLocal: number;
  readonly sizeLocal: number;
  readonly pLocal: number;
  readonly qLocal: number;
  readonly eLocal: number;
  readonly zLocal: number;
  readonly nCapLocal: number;
  readonly iLocal: number;
  readonly tmpLocal: number;
}

// Every builder below returns FRESH Instr objects: the finalize walks remap
// every Instr object they reach, so one object at two body positions would be
// remapped twice.

/** `[] → []` — `CreateDataProperty(A, lengthA, <value>)`; `lengthA += 1`. */
function pushValueInstrs(w: SplitWalk, value: Instr[]): Instr[] {
  return [
    { op: "local.get", index: w.aLocal },
    ...value,
    { op: "call", funcIdx: w.deps.objVecPush },
    { op: "local.get", index: w.lenALocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: w.lenALocal },
  ];
}

/** `[] → [externref]` — the substring S[fromLocal, toLocal) as a string externref. */
function substringInstrs(w: SplitWalk, fromLocal: number, toLocal: number): Instr[] {
  return [
    { op: "local.get", index: w.flatSLocal },
    { op: "local.get", index: fromLocal },
    { op: "local.get", index: toLocal },
    { op: "call", funcIdx: w.split.strSubstring },
    { op: "extern.convert_any" },
  ];
}

/** `[] → [i32]` — `lengthA = lim`. */
function atLimitInstrs(w: SplitWalk): Instr[] {
  return [
    { op: "local.get", index: w.lenALocal },
    { op: "f64.convert_i32_u" },
    { op: "local.get", index: w.limLocal },
    { op: "f64.eq" },
  ];
}

/** `q = AdvanceStringIndex(S, q, unicodeMatching)`. */
function advanceQInstrs(w: SplitWalk): Instr[] {
  return [
    ...buildAdvanceStringIndexInstrs(w.loop, w.flatSLocal, w.qLocal, w.uLocal),
    { op: "local.set", index: w.qLocal },
  ];
}

/**
 * Step 17.d.iv.9 — push `? Get(z, ToString(i))` for i in 1..numberOfCaptures,
 * returning A as soon as `lengthA = lim`. Depths are relative to its position:
 * loop $C(0) > block $caps(1) > if e≠p(2) > if z(3) > loop $L(4) >
 * block $walk(5) > if size=0(6) > block $done(7).
 */
function buildCaptureLoopInstrs(w: SplitWalk): Instr[] {
  return [
    { op: "i32.const", value: 1 },
    { op: "local.set", index: w.iLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: w.iLocal },
            { op: "local.get", index: w.nCapLocal },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            ...pushValueInstrs(w, [
              { op: "local.get", index: w.zLocal },
              { op: "local.get", index: w.iLocal },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: w.deps.boxNumber },
              { op: "call", funcIdx: w.deps.externToString },
              { op: "call", funcIdx: w.deps.externGet },
            ]),
            { op: "local.get", index: w.iLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: w.iLocal },
            ...atLimitInstrs(w),
            { op: "br_if", depth: 7 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

/** Step 17.d — the exec matched (`z` is not null). */
function buildOnMatchInstrs(w: SplitWalk): Instr[] {
  const { ctx, deps, split } = w;
  return [
    // 17.d.i-ii — e = min(ToLength(Get(splitter, "lastIndex")), size).
    ...buildGetInstrs(ctx, deps, w.splitterLocal, "lastIndex"),
    ...buildToLengthI32Instrs(split, w.tmpLocal),
    { op: "local.tee", index: w.eLocal },
    { op: "local.get", index: w.sizeLocal },
    { op: "local.get", index: w.eLocal },
    { op: "local.get", index: w.sizeLocal },
    { op: "i32.lt_s" },
    { op: "select" },
    { op: "local.set", index: w.eLocal },
    { op: "local.get", index: w.eLocal },
    { op: "local.get", index: w.pLocal },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: advanceQInstrs(w),
      else: [
        ...pushValueInstrs(w, substringInstrs(w, w.pLocal, w.qLocal)),
        ...atLimitInstrs(w),
        // if e≠p(0) > if z(1) > loop $L(2) > block $walk(3) > if size=0(4) > block $done(5)
        { op: "br_if", depth: 5 },
        { op: "local.get", index: w.eLocal },
        { op: "local.set", index: w.pLocal },
        // 17.d.iv.6-7 — numberOfCaptures = max(LengthOfArrayLike(z) - 1, 0).
        ...buildGetInstrs(ctx, deps, w.zLocal, "length"),
        ...buildToLengthI32Instrs(split, w.tmpLocal),
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.tee", index: w.nCapLocal },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: w.nCapLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.gt_s" },
        { op: "select" },
        { op: "local.set", index: w.nCapLocal },
        ...buildCaptureLoopInstrs(w),
        { op: "local.get", index: w.pLocal },
        { op: "local.set", index: w.qLocal },
      ],
    },
  ];
}

/** Steps 14-20 — the walk over a non-empty subject, then the tail S[p, size). */
function buildWalkInstrs(w: SplitWalk, builtinArm: Instr[]): Instr[] {
  const { ctx, fctx, deps } = w;
  return [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: w.pLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: w.qLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: w.qLocal },
            { op: "local.get", index: w.sizeLocal },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            // 17.a — ? Set(splitter, "lastIndex", 𝔽(q), true).
            ...buildSetInstrs(ctx, deps, w.splitterLocal, "lastIndex", [
              { op: "local.get", index: w.qLocal },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: deps.boxNumber },
            ]),
            // 17.b
            ...buildRegExpExecInstrs(ctx, fctx, deps, w.splitterLocal, w.sLocal, builtinArm),
            { op: "local.tee", index: w.zLocal },
            { op: "ref.is_null" },
            { op: "if", blockType: { kind: "empty" }, then: advanceQInstrs(w), else: buildOnMatchInstrs(w) },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // steps 18-20 — the tail S[p, size).
    ...pushValueInstrs(w, substringInstrs(w, w.pLocal, w.sizeLocal)),
  ];
}

/** Step 13 — an empty subject: one RegExpExec; a match (even an empty one) yields []. */
function buildEmptySubjectInstrs(w: SplitWalk, builtinArm: Instr[]): Instr[] {
  return [
    ...buildRegExpExecInstrs(w.ctx, w.fctx, w.deps, w.splitterLocal, w.sLocal, builtinArm),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: pushValueInstrs(w, [{ op: "local.get", index: w.sLocal }]),
      else: [],
    },
  ];
}

/** Steps 6-7 — `[] → []`: unicodeMatching into `uLocal`, newFlags into `newFlagsLocal`. */
function buildNewFlagsInstrs(
  ctx: CodegenContext,
  loop: MatchLoopDeps,
  split: SplitDeps,
  flagsLocal: number,
  uLocal: number,
  newFlagsLocal: number,
): Instr[] {
  return [
    ...buildFlagsContainInstrs(ctx, flagsLocal, "u"),
    ...buildFlagsContainInstrs(ctx, flagsLocal, "v"),
    { op: "i32.or" },
    { op: "local.set", index: uLocal },
    ...buildFlagsContainInstrs(ctx, flagsLocal, "y"),
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: [{ op: "local.get", index: flagsLocal }],
      else: [
        { op: "local.get", index: flagsLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: loop.anyStr },
        ...stringConstantExternrefInstrs(ctx, "y"),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: loop.anyStr },
        { op: "call", funcIdx: split.strConcat },
        { op: "extern.convert_any" },
      ],
    },
    { op: "local.set", index: newFlagsLocal },
  ];
}

/**
 * Emit the §22.2.6.14 body. Params are the reflective-closure ABI: `thisParam`
 * is the externref `this`, `strParam` / `limitParam` the two arguments (a
 * missing argument arrives as `undefined`). Leaves an externref (the `$ObjVec`
 * result array) on the stack; returns `null` — having emitted NOTHING — when a
 * dependency is unavailable.
 */
export function emitRegExpSymbolSplitBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  thisParam: number,
  strParam: number,
  limitParam: number,
  emitBuiltinExec: BuiltinExecEmitter,
): ValType | null {
  // EVERY decline happens before the first `fctx.body.push` (B2's lesson: a
  // body that bails half-emitted leaves the operand stack unbalanced).
  const deps0 = prepareRegExpExecProtocol(ctx, fctx);
  if (deps0 === undefined || !flagsContainAvailable(ctx)) return null;
  const loop0 = prepareMatchLoopDeps(ctx, fctx);
  if (loop0 === undefined) return null;
  const split0 = prepareSplitDeps(ctx, fctx);
  if (split0 === undefined) return null;
  // Re-resolve: the registrations above may have shifted indices captured by
  // the earlier prepares (#2043 late-shift class).
  let deps = prepareRegExpExecProtocol(ctx, fctx) ?? deps0;

  // steps 1-2
  for (const instr of buildRequireObjectReceiver(ctx, fctx, deps, thisParam)) fctx.body.push(instr);

  // step 3 — ToString(string), once.
  const sLocal = allocLocal(fctx, `__rsp_s_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.get", index: strParam });
  fctx.body.push({ op: "call", funcIdx: deps.externToString });
  fctx.body.push({ op: "local.set", index: sLocal });

  const local = (name: string, type: ValType): number => allocLocal(fctx, `__rsp_${name}_${fctx.locals.length}`, type);
  const ctorLocal = local("c", EXTERNREF);
  const useDefLocal = local("def", I32);
  const flagsLocal = local("flags", EXTERNREF);
  const newFlagsLocal = local("nflags", EXTERNREF);
  const uLocal = local("u", I32);
  const splitterLocal = local("splitter", EXTERNREF);
  const aLocal = local("a", EXTERNREF);
  const lenALocal = local("la", I32);
  const limLocal = local("lim", F64);
  const numLocal = local("num", F64);
  const flatSLocal = local("fs", { kind: "ref", typeIdx: loop0.nativeStr });
  const sizeLocal = local("size", I32);
  const pLocal = local("p", I32);
  const qLocal = local("q", I32);
  const eLocal = local("e", I32);
  const zLocal = local("z", EXTERNREF);
  const nCapLocal = local("ncap", I32);
  const iLocal = local("i", I32);
  const tmpLocal = local("t", I32);

  // step 4 — SpeciesConstructor, BEFORE the `flags` Get (`species-ctor-*` vs
  // `get-flags-err`/`coerce-flags-err`: the spec order is constructor first).
  for (const instr of buildSpeciesConstructorInstrs(ctx, fctx, deps, split0, thisParam, ctorLocal, useDefLocal)) {
    fctx.body.push(instr);
  }

  // step 5
  for (const instr of buildGetInstrs(ctx, deps, thisParam, "flags")) fctx.body.push(instr);
  fctx.body.push({ op: "call", funcIdx: deps.externToString });
  fctx.body.push({ op: "local.set", index: flagsLocal });

  // The struct-aware arms are emitted through the real context and spliced out
  // BEFORE any further index is read (B2/B3's discipline). Each captured arm is
  // registered in `liveBodies` while the next is emitted, so a late import
  // registered by a LATER emission still shifts an EARLIER capture. The builtin
  // arm is captured twice rather than spliced into both exec sites (one Instr
  // object at two body positions would be remapped twice).
  const defaultSplitterArm = captureInto(fctx, () => emitDefaultRegExpSplitter(ctx, fctx, thisParam, newFlagsLocal));
  ctx.liveBodies.add(defaultSplitterArm);
  let builtinArmWalk: Instr[] = [];
  let builtinArmEmpty: Instr[];
  try {
    builtinArmWalk = captureInto(fctx, () => emitBuiltinExec(splitterLocal, sLocal));
    ctx.liveBodies.add(builtinArmWalk);
    builtinArmEmpty = captureInto(fctx, () => emitBuiltinExec(splitterLocal, sLocal));
  } finally {
    ctx.liveBodies.delete(defaultSplitterArm);
    ctx.liveBodies.delete(builtinArmWalk);
  }
  deps = prepareRegExpExecProtocol(ctx, fctx) ?? deps;
  const loop = prepareMatchLoopDeps(ctx, fctx) ?? loop0;
  const split = prepareSplitDeps(ctx, fctx) ?? split0;

  // steps 6-7
  fctx.body.push(...buildNewFlagsInstrs(ctx, loop, split, flagsLocal, uLocal, newFlagsLocal));

  // step 8 — splitter = ? Construct(C, « rx, newFlags »).
  fctx.body.push({ op: "local.get", index: useDefLocal });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: defaultSplitterArm,
    else: [
      { op: "local.get", index: ctorLocal },
      { op: "ref.null.extern" },
      { op: "local.get", index: thisParam },
      { op: "local.get", index: newFlagsLocal },
      { op: "call", funcIdx: split.construct2 },
    ],
  });
  fctx.body.push({ op: "local.set", index: splitterLocal });

  // steps 9-10
  fctx.body.push({ op: "call", funcIdx: deps.objVecNew }, { op: "local.set", index: aLocal });
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: lenALocal });

  // step 11 — lim.
  fctx.body.push(...isUndefinedInstrs(ctx, split, limitParam));
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: F64 },
    then: [{ op: "f64.const", value: TWO_POW_32 - 1 }],
    else: [{ op: "local.get", index: limitParam }, ...buildToUint32Instrs(split, numLocal)],
  });
  fctx.body.push({ op: "local.set", index: limLocal });

  // The flat subject and its size, for the walk and the substrings.
  fctx.body.push({ op: "local.get", index: sLocal }, ...flattenExternStringInstrs(loop));
  fctx.body.push({ op: "local.tee", index: flatSLocal });
  fctx.body.push({ op: "struct.get", typeIdx: loop.nativeStr, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: sizeLocal });

  const w: SplitWalk = {
    ctx,
    fctx,
    deps,
    loop,
    split,
    sLocal,
    splitterLocal,
    uLocal,
    aLocal,
    lenALocal,
    limLocal,
    flatSLocal,
    sizeLocal,
    pLocal,
    qLocal,
    eLocal,
    zLocal,
    nCapLocal,
    iLocal,
    tmpLocal,
  };
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      // step 12 — lim = 0 ⇒ A, before ANY exec (`limit-0-bail`).
      { op: "local.get", index: limLocal },
      { op: "f64.const", value: 0 },
      { op: "f64.eq" },
      { op: "br_if", depth: 0 },
      { op: "local.get", index: sizeLocal },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: buildEmptySubjectInstrs(w, builtinArmEmpty),
        else: buildWalkInstrs(w, builtinArmWalk),
      },
    ],
  });
  fctx.body.push({ op: "local.get", index: aLocal });
  return EXTERNREF;
}
