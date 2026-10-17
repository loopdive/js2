// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Canonical cross-module marker for provider-owned interpreted callbacks. */

import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureAnyHelpers } from "./any-helpers.js";
import { definedFuncAt, funcSignatureOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureExnTag, localGlobalIdx, nextModuleGlobalIdx } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { emitRuntimeEvalGlobalLexicalReadOrFallback } from "./global-environment.js";
import { coerceType } from "./shared.js";

export const RUNTIME_EVAL_INTERP_CALLBACK_BRAND_A = 0x2928;
export const RUNTIME_EVAL_INTERP_CALLBACK_BRAND_B = 0x4556414c;
export const RUNTIME_EVAL_INTERP_CALLBACK_KIND_GENERIC = 0;
export const RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_EVAL = 1;
export const RUNTIME_EVAL_INTERP_CALLBACK_KIND_INTRINSIC_FUNCTION = 2;
export const RUNTIME_EVAL_AOT_CALLABLE_BRAND_A = 0x2928;
export const RUNTIME_EVAL_AOT_CALLABLE_BRAND_B = 0x414f5443;
export const RUNTIME_EVAL_CALL_RESULT_BRAND_A = 0x2928;
export const RUNTIME_EVAL_CALL_RESULT_BRAND_B = 0x52534c54;

export const RUNTIME_EVAL_VALUE_KIND_REFERENCE = 0;
export const RUNTIME_EVAL_VALUE_KIND_UNDEFINED = 1;
export const RUNTIME_EVAL_VALUE_KIND_NULL = 2;
export const RUNTIME_EVAL_VALUE_KIND_NUMBER = 3;
export const RUNTIME_EVAL_VALUE_KIND_BOOLEAN = 4;
export const RUNTIME_EVAL_VALUE_KIND_STRING = 5;
export const RUNTIME_EVAL_VALUE_KIND_BIGINT = 6;

/**
 * Runtime bit distinguishing a genuine provider re-entry from an in-module
 * use of the same callable carrier. Syntax pre-scans deliberately over-enable
 * the carrier (for example Test262's dead `$262.evalScript` helper), so a
 * compile-time "module has an import" test is insufficient after DCE.
 */
export function ensureRuntimeEvalProviderActiveGlobal(ctx: CodegenContext): number {
  const cached = ctx.runtimeEvalProviderActiveGlobalIdx;
  if (cached !== undefined) return cached;
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__runtime_eval_provider_active",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.runtimeEvalProviderActiveGlobalIdx = globalIdx;
  return globalIdx;
}

/**
 * A provider callback cannot cross as an ordinary closure: any exception it
 * throws carries the provider module's private Wasm tag. This non-callable
 * marker is structurally canonical across modules; the caller's apply bridge
 * recognizes it, invokes the provider's envelope entry point, and rethrows
 * through the caller's own tag.
 */
export function ensureRuntimeEvalInterpretedCallbackType(ctx: CodegenContext): number {
  const cached = ctx.runtimeEvalInterpretedCallbackTypeIdx;
  if (cached !== undefined) return cached;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$RuntimeEvalInterpretedCallback",
    fields: [
      { name: "target", type: { kind: "externref" }, mutable: false },
      { name: "brandA", type: { kind: "i32" }, mutable: false },
      { name: "brandB", type: { kind: "i32" }, mutable: false },
      { name: "kind", type: { kind: "i32" }, mutable: false },
      // Provider closures are nominal module-local structs. Carry the two
      // standard scalar Function metadata fields explicitly so the caller's
      // property bridge does not have to introspect that foreign struct.
      { name: "name", type: { kind: "externref" }, mutable: false },
      { name: "length", type: { kind: "f64" }, mutable: false },
      { name: "constructor", type: { kind: "externref" }, mutable: false },
    ],
    superTypeIdx: -1,
  });
  ctx.runtimeEvalInterpretedCallbackTypeIdx = typeIdx;
  return typeIdx;
}

/** Canonical provider→caller value carrier. Primitive boxes are module-local
 * implementation details and cannot be passed through the result envelope by
 * identity; this non-recursive shape transports their scalar payloads and
 * leaves genuine references untouched. */
export function ensureRuntimeEvalValueType(ctx: CodegenContext): number {
  const cached = ctx.runtimeEvalValueTypeIdx;
  if (cached !== undefined) return cached;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$RuntimeEvalValue",
    fields: [
      { name: "kind", type: { kind: "i32" }, mutable: false },
      { name: "i32val", type: { kind: "i32" }, mutable: false },
      { name: "f64val", type: { kind: "f64" }, mutable: false },
      { name: "i64val", type: { kind: "i64" }, mutable: false },
      { name: "refval", type: { kind: "externref" }, mutable: false },
    ],
    superTypeIdx: -1,
  });
  ctx.runtimeEvalValueTypeIdx = typeIdx;
  return typeIdx;
}

/**
 * Canonical result envelope for the caller-owned AOT trampoline.
 *
 * WebAssembly exception tags are nominal instance objects: an exception
 * thrown with the app module's private tag cannot be caught by JavaScript
 * compiled into the separately instantiated runtime-eval provider. The app
 * trampoline therefore catches its own tag and returns this structurally
 * canonical `(value, ok)` record. The receiving module unwraps it and, on the
 * error arm, throws the same JavaScript value through its own local tag.
 *
 * `value` is itself the existing canonical `$RuntimeEvalValue`: primitive
 * boxes are module-local implementation details, so both success values and
 * thrown payloads must cross as scalar data. Two brands prevent an unrelated
 * user struct with the same leading fields from being mistaken for an
 * exception envelope. A non-envelope value remains an old-carrier fallback.
 */
export function ensureRuntimeEvalCallResultType(ctx: CodegenContext): number {
  const cached = ctx.runtimeEvalCallResultTypeIdx;
  if (cached !== undefined) return cached;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$RuntimeEvalCallResult",
    fields: [
      { name: "value", type: { kind: "externref" }, mutable: false },
      { name: "ok", type: { kind: "i32" }, mutable: false },
      { name: "brandA", type: { kind: "i32" }, mutable: false },
      { name: "brandB", type: { kind: "i32" }, mutable: false },
    ],
    superTypeIdx: -1,
  });
  ctx.runtimeEvalCallResultTypeIdx = typeIdx;
  return typeIdx;
}

/** Consume an externref value and return its canonical AOT-call envelope. */
export function buildRuntimeEvalCallResultWrap(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  paramCount: number,
  ok: boolean,
): Instr[] {
  const typeIdx = ensureRuntimeEvalCallResultType(ctx);
  return [
    ...buildRuntimeEvalValueWrap(ctx, locals, paramCount),
    { op: "i32.const", value: ok ? 1 : 0 },
    { op: "i32.const", value: RUNTIME_EVAL_CALL_RESULT_BRAND_A },
    { op: "i32.const", value: RUNTIME_EVAL_CALL_RESULT_BRAND_B },
    { op: "struct.new", typeIdx },
    { op: "extern.convert_any" },
  ];
}

/**
 * Return a module-local decoder for the canonical AOT-call envelope. It
 * reconstructs primitive boxes locally and rethrows failures through this
 * module's own exception tag. Keeping the scratch locals inside one helper
 * lets every dynamic call lane share the same boundary contract.
 */
export function ensureRuntimeEvalCallResultUnwrapHelper(ctx: CodegenContext): number {
  const cached = ctx.runtimeEvalCallResultUnwrapFuncIdx;
  if (cached !== undefined) return cached;
  const typeIdx = ensureRuntimeEvalCallResultType(ctx);
  const locals: { name: string; type: ValType }[] = [];
  const decodeValue = buildRuntimeEvalValueUnwrap(ctx, locals, 1);
  const decodedValueLocal = 1 + locals.length;
  locals.push({ name: "decodedValue", type: { kind: "externref" } });
  const loadField = (fieldIdx: 0 | 1 | 2 | 3): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
    { op: "struct.get", typeIdx, fieldIdx },
  ];
  const brandsMatch: Instr[] = [
    ...loadField(2),
    { op: "i32.const", value: RUNTIME_EVAL_CALL_RESULT_BRAND_A },
    { op: "i32.eq" },
    ...loadField(3),
    { op: "i32.const", value: RUNTIME_EVAL_CALL_RESULT_BRAND_B },
    { op: "i32.eq" },
    { op: "i32.and" },
  ];
  const decodeEnvelope: Instr[] = [
    ...loadField(0),
    ...decodeValue,
    { op: "local.set", index: decodedValueLocal },
    ...loadField(1),
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [{ op: "local.get", index: decodedValueLocal }],
      else: [
        { op: "local.get", index: decodedValueLocal },
        { op: "throw", tagIdx: ensureExnTag(ctx) },
      ],
    },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        ...brandsMatch,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: decodeEnvelope,
          else: [{ op: "local.get", index: 0 }],
        },
      ],
      else: [{ op: "local.get", index: 0 }],
    },
  ];
  const funcTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__runtime_eval_unwrap_call_result",
    typeIdx: funcTypeIdx,
    locals,
    body,
    exported: false,
  });
  ctx.funcMap.set("__runtime_eval_unwrap_call_result", funcIdx);
  ctx.runtimeEvalCallResultUnwrapFuncIdx = funcIdx;
  return funcIdx;
}

/** Encode one caller-local value as the canonical cross-module value carrier.
 * This is the argument/result counterpart of {@link buildRuntimeEvalValueUnwrap}:
 * module-private `$AnyValue` and primitive boxes are reduced to scalar fields,
 * while genuine references cross unchanged. The returned sequence consumes an
 * externref and leaves the canonical carrier as externref. */
export function buildRuntimeEvalValueWrap(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  paramCount: number,
): Instr[] {
  ensureAnyHelpers(ctx);
  const externref: ValType = { kind: "externref" };
  const valueTypeIdx = ensureRuntimeEvalValueType(ctx);
  const anyTypeIdx = ctx.anyValueTypeIdx;
  const valueLocal = paramCount + locals.length;
  locals.push({ name: `__runtime_eval_wrap_value_${locals.length}`, type: externref });
  const anyLocal = paramCount + locals.length;
  locals.push({
    name: `__runtime_eval_wrap_any_${locals.length}`,
    type: { kind: "ref_null", typeIdx: anyTypeIdx },
  });

  const makeValue = (
    kind: number,
    i32Value: Instr[] = [{ op: "i32.const", value: 0 }],
    f64Value: Instr[] = [{ op: "f64.const", value: 0 }],
    i64Value: Instr[] = [{ op: "i64.const", value: 0n }],
    refValue: Instr[] = [{ op: "ref.null.extern" }],
  ): Instr[] => [
    { op: "i32.const", value: kind },
    ...i32Value,
    ...f64Value,
    ...i64Value,
    ...refValue,
    { op: "struct.new", typeIdx: valueTypeIdx },
    { op: "extern.convert_any" },
  ];
  const anyField = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: anyLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx },
  ];
  const anyTagCase = (tag: number, then: Instr[], otherwise: Instr[]): Instr[] => [
    ...anyField(0),
    { op: "i32.const", value: tag },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then,
      else: otherwise,
    },
  ];
  const anyReference: Instr[] = [
    ...anyField(3),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: anyField(4),
      else: [...anyField(3), { op: "extern.convert_any" }],
    },
  ];
  const anyValue: Instr[] = anyTagCase(
    0,
    makeValue(RUNTIME_EVAL_VALUE_KIND_NULL),
    anyTagCase(
      1,
      makeValue(RUNTIME_EVAL_VALUE_KIND_UNDEFINED),
      anyTagCase(
        2,
        makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, [...anyField(1), { op: "f64.convert_i32_s" }]),
        anyTagCase(
          3,
          makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, anyField(2)),
          anyTagCase(
            4,
            makeValue(RUNTIME_EVAL_VALUE_KIND_BOOLEAN, anyField(1)),
            anyTagCase(
              5,
              makeValue(RUNTIME_EVAL_VALUE_KIND_STRING, undefined, undefined, undefined, anyField(4)),
              anyTagCase(
                6,
                makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, anyReference),
                makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, [
                  { op: "local.get", index: valueLocal },
                ]),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  const helperPayload = (name: string, result: ValType): Instr[] => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) {
      if (result.kind === "i32") return [{ op: "i32.const", value: 0 }];
      if (result.kind === "f64") return [{ op: "f64.const", value: 0 }];
      return [{ op: "i64.const", value: 0n }];
    }
    return [
      { op: "local.get", index: valueLocal },
      { op: "call", funcIdx: idx },
    ];
  };
  const helperTest = (name: string, then: Instr[], otherwise: Instr[]): Instr[] => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return otherwise;
    return [
      { op: "local.get", index: valueLocal },
      { op: "call", funcIdx: idx },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then,
        else: otherwise,
      },
    ];
  };
  const fallbackReference = makeValue(RUNTIME_EVAL_VALUE_KIND_REFERENCE, undefined, undefined, undefined, [
    { op: "local.get", index: valueLocal },
  ]);
  const classifiedValue = helperTest("__typeof_undefined", makeValue(RUNTIME_EVAL_VALUE_KIND_UNDEFINED), [
    { op: "local.get", index: valueLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: makeValue(RUNTIME_EVAL_VALUE_KIND_NULL),
      else: helperTest(
        "__typeof_number",
        makeValue(RUNTIME_EVAL_VALUE_KIND_NUMBER, undefined, helperPayload("__unbox_number", { kind: "f64" })),
        helperTest(
          "__typeof_boolean",
          makeValue(RUNTIME_EVAL_VALUE_KIND_BOOLEAN, helperPayload("__unbox_boolean", { kind: "i32" })),
          helperTest(
            "__typeof_string",
            makeValue(RUNTIME_EVAL_VALUE_KIND_STRING, undefined, undefined, undefined, [
              { op: "local.get", index: valueLocal },
            ]),
            helperTest(
              "__typeof_bigint",
              makeValue(
                RUNTIME_EVAL_VALUE_KIND_BIGINT,
                undefined,
                undefined,
                helperPayload("__to_bigint", { kind: "i64" }),
              ),
              fallbackReference,
            ),
          ),
        ),
      ),
    },
  ]);

  return [
    { op: "local.set", index: valueLocal },
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyTypeIdx },
        { op: "local.set", index: anyLocal },
        ...anyValue,
      ],
      else: classifiedValue,
    },
  ];
}

/** Decode a provider-owned `$RuntimeEvalValue` into caller-local primitive
 * boxes. The input and output are both `externref`; the returned instruction
 * sequence consumes the input from the stack and leaves the decoded value.
 *
 * This builder is intentionally independent of FunctionContext so finalize-
 * time bridges such as `__apply_closure` can share the exact same decode as
 * direct eval/new Function result sites. `locals` is the target function's
 * mutable local list and `paramCount` is used to allocate stable indices.
 */
export function buildRuntimeEvalValueUnwrap(
  ctx: CodegenContext,
  locals: { name: string; type: ValType }[],
  paramCount: number,
): Instr[] {
  const externref: ValType = { kind: "externref" };
  const valueTypeIdx = ensureRuntimeEvalValueType(ctx);
  const valueLocal = paramCount + locals.length;
  locals.push({ name: `__runtime_eval_value_${locals.length}`, type: externref });
  const carrierLocal = paramCount + locals.length;
  locals.push({
    name: `__runtime_eval_value_carrier_${locals.length}`,
    type: { kind: "ref_null", typeIdx: valueTypeIdx },
  });

  const carrierField = (fieldIdx: number): Instr[] => [
    { op: "local.get", index: carrierLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: valueTypeIdx, fieldIdx },
  ];
  const kindCase = (kind: number, then: Instr[], otherwise: Instr[]): Instr[] => [
    ...carrierField(0),
    { op: "i32.const", value: kind },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then,
      else: otherwise,
    },
  ];
  const undefinedValue: Instr[] =
    ctx.undefinedSingleton === true && (ctx.standalone || ctx.nativeStrings) && ctx.undefinedGlobalIdx !== undefined
      ? [{ op: "global.get", index: ctx.undefinedGlobalIdx }, { op: "extern.convert_any" }]
      : [{ op: "ref.null.extern" }];
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  const boxBigIntIdx = ctx.funcMap.get("__box_bigint");
  const decoded = kindCase(
    RUNTIME_EVAL_VALUE_KIND_REFERENCE,
    carrierField(4),
    kindCase(
      RUNTIME_EVAL_VALUE_KIND_UNDEFINED,
      undefinedValue,
      kindCase(
        RUNTIME_EVAL_VALUE_KIND_NULL,
        [{ op: "ref.null.extern" }],
        kindCase(
          RUNTIME_EVAL_VALUE_KIND_NUMBER,
          boxNumberIdx === undefined
            ? [{ op: "ref.null.extern" }]
            : [...carrierField(2), { op: "call", funcIdx: boxNumberIdx }],
          kindCase(
            RUNTIME_EVAL_VALUE_KIND_BOOLEAN,
            boxBooleanIdx === undefined
              ? [{ op: "ref.null.extern" }]
              : [...carrierField(1), { op: "call", funcIdx: boxBooleanIdx }],
            kindCase(
              RUNTIME_EVAL_VALUE_KIND_STRING,
              carrierField(4),
              kindCase(
                RUNTIME_EVAL_VALUE_KIND_BIGINT,
                boxBigIntIdx === undefined
                  ? [{ op: "ref.null.extern" }]
                  : [...carrierField(3), { op: "call", funcIdx: boxBigIntIdx }],
                carrierField(4),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  return [
    { op: "local.set", index: valueLocal },
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: valueTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: externref },
      then: [
        { op: "local.get", index: valueLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: valueTypeIdx },
        { op: "local.set", index: carrierLocal },
        ...decoded,
      ],
      else: [{ op: "local.get", index: valueLocal }],
    },
  ];
}

/**
 * Out-of-line live-binding calls for runtime-eval modules (#6990).
 *
 * In a standalone module that links the runtime-eval provider, eval may
 * replace a script function binding (`eval("function f(){…}")`), so every call
 * of a top-level function is lowered as a LIVE call: read the binding (global
 * lexical sidecar, then the module global), then dispatch dynamically. That
 * sequence is inlined at every call site — ~375 WAT lines and ~8 fresh locals
 * each. Octane mandreel's `global_init` has ~150k such calls; the function
 * needed ~1.2M locals (V8's limit is 50k) and never finished compiling.
 *
 * Here an eligible call site compiles exactly like a plain direct call, and its
 * `call` is retargeted at finalize to a per-callee trampoline with the callee's
 * own signature:
 *
 *   if (provider never entered) call $f(params)      ;; nothing can have rebound f
 *   else                        <live read + __apply_closure, boxed args>
 *
 * Before the first provider entry no evaluated code has run, so the binding
 * still holds the declaration — the direct call is exact. After it, the slow
 * path is the same live read + dynamic dispatch the inline lowering performed.
 * Retargeting happens at finalize (not at the call site) because the callee's
 * Wasm signature can still change while the module compiles; the trampoline is
 * typed from the FINAL signature, and only calls still aimed at the callee's
 * current index are moved.
 */
/** Private `moduleGlobals` key of the "provider ever entered" flag. */
const EVER_ENTERED_GLOBAL = "\0runtime-eval-ever-entered";

interface LiveCallSites {
  /** callee name → the `call` instructions to retarget at finalize. */
  readonly byName: Map<string, Instr[]>;
}

const sitesByCtx = new WeakMap<CodegenContext, LiveCallSites>();

/** Index of the i32 "provider ever entered" flag, created on first use. */
export function ensureRuntimeEvalEverEnteredGlobal(ctx: CodegenContext): number {
  const existing = ctx.moduleGlobals.get(EVER_ENTERED_GLOBAL);
  if (existing !== undefined) return existing;
  const idx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__runtime_eval_ever_entered",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.moduleGlobals.set(EVER_ENTERED_GLOBAL, idx);
  return idx;
}

/** Set the flag; emitted at every provider entry (the global-binding seed). */
export function emitRuntimeEvalEverEntered(ctx: CodegenContext, fctx: FunctionContext): void {
  const idx = ensureRuntimeEvalEverEnteredGlobal(ctx);
  fctx.body.push({ op: "i32.const", value: 1 }, { op: "global.set", index: idx });
}

/**
 * Can this live call take the direct-call-plus-trampoline lowering? Only an
 * unshadowed call of an ordinary, never-reassigned top-level function
 * declaration whose binding is live SOLELY because the module consumes the
 * runtime-eval provider (`evalOnlyLiveFuncBindings`); Annex B and syntactically
 * reassigned bindings keep the inline lowering.
 */
export function runtimeEvalLiveCallFastPathEligible(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): boolean {
  if (!(ctx.standalone || ctx.wasi) || ctx.runtimeEvalGlobalFunctionBindings !== true) return false;
  if (!ts.isIdentifier(expr.expression) || expr.arguments.some((a) => ts.isSpreadElement(a))) return false;
  const name = expr.expression.text;
  if (fctx.localMap.has(name) || fctx.boxedCaptures?.has(name)) return false;
  if (fctx.annexBRepeatedOuterBindings?.has(name) || fctx.annexBExistingDirectFunctionBindings?.has(name)) return false;
  if (ctx.annexBModuleBindings?.has(name)) return false;
  if (ctx.liveFuncBindingGlobals?.has(name) !== true) return false;
  const declaration = ctx.topLevelFunctionDeclarations.get(name);
  if (!declaration || !declaration.body || declaration.asteriskToken) return false;
  if (declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  // Live only because eval may rebind it — a syntactic reassignment (also in
  // `reassignedFunctionDeclarations`) keeps the inline live lowering.
  if (ctx.evalOnlyLiveFuncBindings?.has(name) !== true) return false;
  if (ctx.oracle.valueDeclarationOf(expr.expression) !== declaration) return false;
  // A call in compile-time-inlined eval code (`eval("f();")` with a constant
  // string) lives in a synthetic source file whose bodies compile more than
  // once; its recorded site is lost and the call vanishes (test262
  // built-ins/Function/15.3.5.4_2-57gs.js), so it keeps the inline lowering.
  if (sourceFileOf(expr) !== declaration.getSourceFile()) return false;
  const funcIdx = ctx.funcMap.get(name);
  return funcIdx !== undefined && definedFuncAt(ctx, funcIdx) !== undefined;
}

/**
 * Record every `call <name>` emitted into `fctx.body` from `start` onwards (at
 * any nesting depth) for finalize-time retargeting. Returns how many were found.
 */
export function recordRuntimeEvalLiveCallSites(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  start: number,
): number {
  const funcIdx = ctx.funcMap.get(name);
  if (funcIdx === undefined) return 0;
  let sites = sitesByCtx.get(ctx);
  if (!sites) sitesByCtx.set(ctx, (sites = { byName: new Map() }));
  const list = sites.byName.get(name) ?? [];
  let found = 0;
  const visit = (instrs: Instr[]): void => {
    for (const instr of instrs) {
      if ((instr.op === "call" || instr.op === "return_call") && instr.funcIdx === funcIdx) {
        list.push(instr);
        found++;
      }
      for (const key of ["body", "then", "else"] as const) {
        const nested = (instr as Record<string, unknown>)[key];
        if (Array.isArray(nested)) visit(nested as Instr[]);
      }
      const catches = (instr as { catches?: { body?: Instr[] }[] }).catches;
      if (Array.isArray(catches)) for (const c of catches) if (Array.isArray(c.body)) visit(c.body);
    }
  };
  visit(fctx.body.slice(start));
  if (found > 0) sites.byName.set(name, list);
  return found;
}

/** Finalize: build each trampoline from the callee's final signature and retarget its sites. */
export function fillRuntimeEvalLiveCallTrampolines(ctx: CodegenContext): void {
  const sites = sitesByCtx.get(ctx);
  if (!sites) return;
  sitesByCtx.delete(ctx);
  for (const [name, list] of sites.byName) {
    const targetIdx = ctx.funcMap.get(name);
    const liveGlobalIdx = ctx.moduleGlobals.get(name);
    if (targetIdx === undefined || liveGlobalIdx === undefined) continue;
    const sig = funcSignatureOf(ctx, targetIdx);
    if (!sig || sig.results.length > 1) continue;
    const trampolineIdx = buildTrampoline(ctx, name, targetIdx, liveGlobalIdx, sig.params, sig.results);
    if (trampolineIdx === undefined) continue;
    const liveTarget = ctx.funcMap.get(name);
    for (const instr of list) {
      if ((instr.op === "call" || instr.op === "return_call") && instr.funcIdx === liveTarget) {
        instr.funcIdx = trampolineIdx;
      }
    }
  }
}

function buildTrampoline(
  ctx: CodegenContext,
  name: string,
  targetIdx: number,
  liveGlobalIdx: number,
  params: readonly ValType[],
  results: readonly ValType[],
): number | undefined {
  const externref: ValType = { kind: "externref" };
  const flagIdx = ensureRuntimeEvalEverEnteredGlobal(ctx);
  const funcIdx = mintDefinedFunc(ctx);
  const fctx: FunctionContext = {
    name: `__runtime_eval_live_call_${name}`,
    params: params.map((type, i) => ({ name: `p${i}`, type })),
    locals: [],
    localMap: new Map(),
    returnType: results[0] ?? null,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
  // Attach before filling: late imports registered while building shift every
  // reachable body, this one included.
  pushDefinedFunc(ctx, funcIdx, {
    name: fctx.name,
    typeIdx: addFuncType(ctx, [...params], [...results]),
    locals: fctx.locals,
    body: fctx.body,
    exported: false,
  });
  // The trampoline is not a source function, so the ES5 §15.3.5.4 caller-strict
  // marker must sit on the call INTO it, as for the #1058 outlined dyn-call
  // helpers (test262 built-ins/Function/15.3.5.4_2-57gs.js).
  (ctx.outlinedDynamicCallHelpers ??= new Map()).set(fctx.name, fctx.name);

  const direct: Instr[] = [
    ...params.map((_, i) => ({ op: "local.get", index: i }) as Instr),
    { op: "call", funcIdx: targetIdx },
  ];

  // Slow path, built in a scratch body: the same live read the inline
  // lowering performs (sidecar lexical, else the module binding), then the
  // generic apply bridge with an unbound receiver and boxed arguments.
  const { newIdx, pushIdx } = ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const outer = fctx.body;
  const slow: Instr[] = [];
  fctx.body = slow;
  const liveType = ctx.mod.globals[localGlobalIdx(ctx, liveGlobalIdx)]?.type ?? externref;
  const fallback: Instr[] = [{ op: "global.get", index: liveGlobalIdx }];
  if (liveType.kind !== "externref") {
    const saved = fctx.body;
    fctx.body = fallback;
    coerceType(ctx, fctx, liveType, externref);
    fctx.body = saved;
  }
  if (emitRuntimeEvalGlobalLexicalReadOrFallback(ctx, fctx, name, fallback, externref) === null) {
    fctx.body = outer;
    return undefined;
  }
  fctx.body.push({ op: "ref.null.extern" });
  const argsLocal = fctx.params.length + fctx.locals.length;
  fctx.locals.push({ name: "args", type: externref });
  fctx.body.push({ op: "call", funcIdx: newIdx }, { op: "local.set", index: argsLocal });
  params.forEach((type, i) => {
    fctx.body.push({ op: "local.get", index: argsLocal }, { op: "local.get", index: i });
    if (type.kind !== "externref") coerceType(ctx, fctx, type, externref);
    fctx.body.push({ op: "call", funcIdx: pushIdx });
  });
  fctx.body.push(
    { op: "local.get", index: argsLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? applyIdx },
  );
  if (results.length === 0) fctx.body.push({ op: "drop" });
  else if (results[0]!.kind !== "externref") coerceType(ctx, fctx, externref, results[0]!);
  fctx.body = outer;

  outer.push(
    { op: "global.get", index: flagIdx },
    {
      op: "if",
      blockType: results.length === 0 ? { kind: "empty" } : { kind: "val", type: results[0]! },
      then: slow,
      else: direct,
    },
  );
  const fn = definedFuncAt(ctx, funcIdx);
  if (fn) fn.locals = fctx.locals;
  return funcIdx;
}

function sourceFileOf(node: ts.Node): ts.SourceFile | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) current = current.parent;
  return current;
}
