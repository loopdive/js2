// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 B7) §22.2.4.1 `RegExp(pattern, flags)` over a pattern that may be an
 * OBJECT at run time — the IsRegExp / regexp-like half of the constructor.
 *
 * `compileStandaloneRegExpConstructor` decides almost everything statically: a
 * RegExp-typed pattern clones (or, called as a function, returns itself), a
 * string pattern compiles. An object pattern took the string lane —
 * `ToString(obj)`, i.e. the pattern `[object Object]` — which is wrong on every
 * step of the spec's object branch:
 *
 *   1. patternIsRegExp = ? IsRegExp(pattern)          — reads `pattern[@@match]`
 *   2. called as a function, patternIsRegExp, flags undefined:
 *        C = ? Get(pattern, "constructor"); SameValue(C, %RegExp%) ⇒ return pattern
 *   4. pattern has [[RegExpMatcher]] ⇒ P = [[OriginalSource]],
 *        F = flags undefined ? [[OriginalFlags]] : flags
 *   5. else patternIsRegExp ⇒ P = ? Get(pattern, "source"),
 *        F = flags undefined ? ? Get(pattern, "flags") : flags
 *   6. else P = pattern, F = flags
 *   8. RegExpInitialize: P/F undefined ⇒ "", else ? ToString (a Symbol throws)
 *
 * This module emits that sequence inline, host-free, from the B2 protocol
 * substrate (`__extern_get`, `__same_value_zero`, the §7.1.17 spec ToString)
 * plus the dynamic pattern compiler. The gate is STATIC and narrow: only a
 * pattern whose type fact says it is (or may be) an ordinary object takes this
 * lane, so every string / RegExp-typed / literal constructor keeps its existing
 * lowering byte-for-byte.
 *
 * Result type: `new RegExp(obj)` always yields a fresh RegExp, so the `new`
 * spelling keeps the `$NativeRegExp` struct type. The CALL spelling may return
 * the pattern itself (step 2), so it answers externref.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { undefinedExternInstrs, undefinedSingletonActive } from "./any-helpers.js";
import { reserveBuiltinConstructorIdentityGlobal } from "./builtin-static-globals.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { getWellKnownSymbolId } from "./literals.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { prepareRegExpExecProtocol } from "./regexp-exec-protocol.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { compileExpression } from "./shared.js";
import { coerceType } from "./type-coercion.js";
import { emitToBoolean, getExternrefToStringProvider } from "./coercion-engine.js";
import {
  ensureDynamicStandaloneRegExpCompiler,
  ensureStandaloneRegExpStruct,
  hasStandaloneRegExpEngine,
  RE_FIELD_CLASS_TABLE,
  RE_FIELD_FLAGS,
  RE_FIELD_NGROUPS,
  RE_FIELD_NSCRATCH,
  RE_FIELD_PROG,
  RE_FIELD_SOURCE,
} from "./regexp-standalone.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/**
 * Type-fact kinds that can hold an ordinary object at run time. `class` is
 * load-bearing: in a JS file an expando object (`var obj = {}; obj.x = …`) gets
 * the variable's own symbol, so its fact is `{kind:"class", name:"obj"}`.
 */
const OBJECT_FACT_KINDS: ReadonlySet<string> = new Set(["object", "class"]);

/**
 * Is `pattern` an expression this lane owns — statically an ordinary object
 * (or a union with one), and NOT a RegExp (whose arms stay where they are)?
 */
function patternIsObjectLike(ctx: CodegenContext, pattern: ts.Expression): boolean {
  if (ts.isRegularExpressionLiteral(pattern)) return false;
  const fact = ctx.oracle.typeFactOf(pattern);
  if (fact.kind === "union") return fact.parts.some((part) => OBJECT_FACT_KINDS.has(part.kind));
  return OBJECT_FACT_KINDS.has(fact.kind);
}

/**
 * Carrier fields a clone copies verbatim; the four `lastIndex` slots start
 * fresh. A function, not a module constant: `regexp-standalone.ts` imports this
 * module, so its `RE_FIELD_*` bindings are still in TDZ while this one loads.
 */
const cloneFields = (): number[] => [
  RE_FIELD_FLAGS,
  RE_FIELD_NGROUPS,
  RE_FIELD_PROG,
  RE_FIELD_CLASS_TABLE,
  RE_FIELD_SOURCE,
  RE_FIELD_NSCRATCH,
];
/** Fresh `lastIndex` state: f64 0, no raw value, not present, writable. */
const CLONE_TAIL: readonly Instr[] = [
  { op: "f64.const", value: 0 },
  { op: "ref.null.extern" },
  { op: "i32.const", value: 0 },
  { op: "i32.const", value: 0 },
];

/**
 * Emit §22.2.4.1 for an object-typed `pattern`. Returns the result ValType, or
 * `undefined` when the lane does not apply (the caller keeps its path; nothing
 * has been emitted).
 */
export function tryCompileRegExpCtorFromObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  node: ts.Node,
): ValType | null | undefined {
  const patternArg = args[0];
  const flagsArg = args[1];
  if (patternArg === undefined || args.length > 2 || !hasStandaloneRegExpEngine(ctx)) return undefined;
  if (!patternIsObjectLike(ctx, patternArg)) return undefined;
  const isCall = ts.isCallExpression(node);

  const matchId = getWellKnownSymbolId("match");
  if (matchId === undefined) return undefined;
  // Register every native BEFORE any operand is compiled, then resolve all of
  // them by NAME after the operands: compiling an operand may register a late
  // import, which shifts every defined-function index (#2043).
  if (prepareRegExpExecProtocol(ctx, fctx) === undefined) return undefined;
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  emitToBoolean(ctx, EXTERNREF, []); // registers the ToBoolean provider; output discarded
  for (const key of ["constructor", "source", "flags", ""]) addStringConstantGlobal(ctx, key);
  const ctorGlobal = isCall ? reserveBuiltinConstructorIdentityGlobal(ctx, "RegExp") : -1;
  // Flush BEFORE the compiler registration: its own flush runs without this
  // function's body and would leave the calls above stale.
  flushLateImportShifts(ctx, fctx);
  ensureDynamicStandaloneRegExpCompiler(ctx);
  const structTypeIdx = ensureStandaloneRegExpStruct(ctx);
  flushLateImportShifts(ctx, fctx);

  const patLocal = allocLocal(fctx, `__rector_pat_${fctx.locals.length}`, EXTERNREF);
  const flgLocal = allocLocal(fctx, `__rector_flg_${fctx.locals.length}`, EXTERNREF);
  const isReLocal = allocLocal(fctx, `__rector_isre_${fctx.locals.length}`, I32);
  const tmpLocal = allocLocal(fctx, `__rector_tmp_${fctx.locals.length}`, EXTERNREF);
  const pLocal = allocLocal(fctx, `__rector_p_${fctx.locals.length}`, EXTERNREF);
  const fLocal = allocLocal(fctx, `__rector_f_${fctx.locals.length}`, EXTERNREF);

  // Operands, left to right, before any step runs.
  const pt = compileExpression(ctx, fctx, patternArg);
  if (pt === null) return null;
  if (pt.kind !== "externref") coerceType(ctx, fctx, pt, EXTERNREF);
  fctx.body.push({ op: "local.set", index: patLocal });
  if (flagsArg === undefined) {
    // An absent `flags` IS `undefined` (§22.2.4.1 steps 2/4/5): push the
    // regime's own undefined, not a bare null (the #2106 regime reads that as null).
    fctx.body.push(...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" as const }]));
  } else {
    const ft = compileExpression(ctx, fctx, flagsArg);
    if (ft === null) return null;
    if (ft.kind !== "externref") coerceType(ctx, fctx, ft, EXTERNREF);
  }
  fctx.body.push({ op: "local.set", index: flgLocal });
  flushLateImportShifts(ctx, fctx);

  const boxSymbol = ctx.funcMap.get("__box_symbol");
  const isUndefinedFn = ctx.funcMap.get("__extern_is_undefined");
  const toBoolean = emitToBoolean(ctx, EXTERNREF, []);
  const externGet = ctx.funcMap.get("__extern_get");
  const sameValueZero = ctx.funcMap.get("__same_value_zero");
  const toStr = ctx.funcMap.get("__extern_to_string_spec") ?? getExternrefToStringProvider(ctx);
  const dynamicCompiler = ctx.nativeRegexHelpers.get("__regex_compile_dynamic_simple");
  const re = { structTypeIdx, anyStrTypeIdx: ctx.anyStrTypeIdx };
  if (
    boxSymbol === undefined ||
    isUndefinedFn === undefined ||
    externGet === undefined ||
    sameValueZero === undefined ||
    toStr === undefined ||
    dynamicCompiler === undefined
  ) {
    // Operands are already on the books; keep the stack shape honest.
    fctx.body.push({ op: "unreachable" });
    return isCall ? EXTERNREF : { kind: "ref", typeIdx: re.structTypeIdx };
  }

  /** `[] → [i32]` — the value in `local` is `undefined` (null too, outside the #2106 regime). */
  const isUndef = (local: number): Instr[] => {
    const base: Instr[] = [
      { op: "local.get", index: local },
      { op: "call", funcIdx: isUndefinedFn },
    ];
    if (!undefinedSingletonActive(ctx)) return base;
    return [...base, { op: "local.get", index: local }, { op: "ref.is_null" }, { op: "i32.eqz" }, { op: "i32.and" }];
  };
  /** `[] → [i32]` — `local` holds a `$NativeRegExp` ([[RegExpMatcher]] present). */
  const hasMatcher = (local: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: re.structTypeIdx },
  ];
  const getKey = (local: number, key: string): Instr[] => [
    { op: "local.get", index: local },
    ...stringConstantExternrefInstrs(ctx, key),
    { op: "call", funcIdx: externGet },
  ];

  // Step 1 — IsRegExp(pattern). §7.2.8: a non-Object is never a RegExp.
  fctx.body.push(
    { op: "i32.const", value: 0 },
    { op: "local.set", index: isReLocal },
    { op: "local.get", index: patLocal },
    { op: "ref.is_null" },
    ...isUndef(patLocal),
    { op: "i32.or" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: patLocal },
        { op: "i32.const", value: matchId },
        { op: "call", funcIdx: boxSymbol },
        { op: "call", funcIdx: externGet },
        { op: "local.tee", index: tmpLocal },
        { op: "call", funcIdx: isUndefinedFn },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: hasMatcher(patLocal),
          else: [{ op: "local.get", index: tmpLocal }, ...toBoolean],
        },
        { op: "local.set", index: isReLocal },
      ],
    },
  );

  const structRef: ValType = { kind: "ref", typeIdx: re.structTypeIdx };
  /** `[] → [(ref $AnyString)]` — RegExpInitialize's `undefined ⇒ ""`, else ? ToString. */
  const initString = (local: number): Instr[] => [
    ...isUndef(local),
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: stringConstantExternrefInstrs(ctx, ""),
      else: [
        { op: "local.get", index: local },
        { op: "call", funcIdx: toStr },
      ],
    },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: re.anyStrTypeIdx },
  ];

  // Step 4 — a genuine RegExp: clone (flags undefined) or recompile the source.
  const cloneInstrs: Instr[] = [];
  for (const fieldIdx of cloneFields()) {
    cloneInstrs.push(
      { op: "local.get", index: patLocal },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: re.structTypeIdx },
      { op: "struct.get", typeIdx: re.structTypeIdx, fieldIdx },
    );
  }
  cloneInstrs.push(...CLONE_TAIL.map((i) => ({ ...i })), { op: "struct.new", typeIdx: re.structTypeIdx });
  const brandedArm: Instr[] = [
    ...isUndef(flgLocal),
    {
      op: "if",
      blockType: { kind: "val", type: structRef },
      then: cloneInstrs,
      else: [
        { op: "local.get", index: patLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: re.structTypeIdx },
        { op: "struct.get", typeIdx: re.structTypeIdx, fieldIdx: RE_FIELD_SOURCE },
        ...initString(flgLocal),
        { op: "call", funcIdx: dynamicCompiler },
      ],
    },
  ];
  // Steps 5/6 — P and F, then RegExpInitialize.
  const objectArm: Instr[] = [
    { op: "local.get", index: isReLocal },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getKey(patLocal, "source"),
        { op: "local.set", index: pLocal },
        ...isUndef(flgLocal),
        {
          op: "if",
          blockType: { kind: "val", type: EXTERNREF },
          then: getKey(patLocal, "flags"),
          else: [{ op: "local.get", index: flgLocal }],
        },
        { op: "local.set", index: fLocal },
      ],
      else: [
        { op: "local.get", index: patLocal },
        { op: "local.set", index: pLocal },
        { op: "local.get", index: flgLocal },
        { op: "local.set", index: fLocal },
      ],
    },
    ...initString(pLocal),
    ...initString(fLocal),
    { op: "call", funcIdx: dynamicCompiler },
  ];
  const construct: Instr[] = [
    ...hasMatcher(patLocal),
    { op: "if", blockType: { kind: "val", type: structRef }, then: brandedArm, else: objectArm },
  ];

  if (!isCall) {
    fctx.body.push(...construct);
    return structRef;
  }

  // Step 2 — the call spelling's identity short-circuit.
  fctx.body.push({
    op: "block",
    blockType: { kind: "val", type: EXTERNREF },
    body: [
      { op: "local.get", index: isReLocal },
      ...isUndef(flgLocal),
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...getKey(patLocal, "constructor"),
          { op: "global.get", index: ctorGlobal },
          { op: "call", funcIdx: sameValueZero },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: patLocal },
              { op: "br", depth: 2 },
            ],
          },
        ],
      },
      ...construct,
      { op: "extern.convert_any" },
    ],
  });
  return EXTERNREF;
}
