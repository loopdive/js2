// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Canonical cross-module marker for provider-owned interpreted callbacks. */

import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureAnyHelpers } from "./any-helpers.js";
import { lastFunctionImplementations, registersTopLevelFunction } from "./ast-modifiers.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { withSourceBindings } from "./module-bindings/source-binding-projection.js";
import { ensureExnTag, nextModuleGlobalIdx } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { buildRestoreOnUnwind } from "../wasm/physical/exception-control.js";
import { recordScriptVarBindingNames } from "./source-scan-predicates.js";

/** The helpers that mirror eval-visible bindings onto the global object (push) and back into their globals (pull). */
export const RUNTIME_EVAL_PUSH_GLOBALS = "__runtime_eval_push_globals";
export const RUNTIME_EVAL_PULL_GLOBALS = "__runtime_eval_pull_globals";

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

/*
 * (#7644) The active flag also says whose bindings the push and pull mirror: 0 inactive, 1 the shared view, 2 + i
 * the i-th tagged source. The global object is one namespace, so where two sources mirror the same name, only the
 * entering source's binding may cross; indirect eval and `new Function` run at global scope (tag 1) and see none.
 */
const RUNTIME_EVAL_INACTIVE_TAG = 0;
export const RUNTIME_EVAL_SHARED_TAG = 1;
const RUNTIME_EVAL_FIRST_SOURCE_TAG = 2;

export interface RuntimeEvalSourceTags {
  readonly tagOf: ReadonlyMap<ts.SourceFile, number>;
  /** Each name two or more sources mirror, with the tagged sources among them. */
  readonly bindersOf: ReadonlyMap<string, readonly ts.SourceFile[]>;
}

/** The names the push mirrors from one source: its registered top-level functions and its top-level `var`s. */
function mirroredSourceNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const implementations = lastFunctionImplementations(sourceFile.statements);
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      registersTopLevelFunction(statement, implementations)
    ) {
      names.add(statement.name.text);
    }
  }
  recordScriptVarBindingNames(names, sourceFile);
  return names;
}

/**
 * Tag each source that holds a direct eval and mirrors a name another source also mirrors. Decided from the AST
 * before declaration collection, so every emitter, including one reached while bindings are still being registered,
 * reads the same answer. Undefined when no source is tagged: then none of the tag code emits anything.
 */
export function planRuntimeEvalSourceTags(
  sourceFiles: readonly ts.SourceFile[],
  evalSourceFiles: ReadonlySet<ts.SourceFile>,
): RuntimeEvalSourceTags | undefined {
  if (sourceFiles.length < 2 || evalSourceFiles.size === 0) return undefined;
  const names = sourceFiles.map(mirroredSourceNames);
  const mirrorCount = new Map<string, number>();
  for (const sourceNames of names) {
    for (const name of sourceNames) mirrorCount.set(name, (mirrorCount.get(name) ?? 0) + 1);
  }
  const colliding = [...mirrorCount].filter(([, count]) => count > 1).map(([name]) => name);
  const tagOf = new Map<ts.SourceFile, number>();
  sourceFiles.forEach((sourceFile, index) => {
    if (evalSourceFiles.has(sourceFile) && colliding.some((name) => names[index]!.has(name))) {
      tagOf.set(sourceFile, RUNTIME_EVAL_FIRST_SOURCE_TAG + tagOf.size);
    }
  });
  if (tagOf.size === 0) return undefined;
  const bindersOf = new Map<string, ts.SourceFile[]>();
  for (const name of colliding) {
    bindersOf.set(
      name,
      sourceFiles.filter((sourceFile, index) => tagOf.has(sourceFile) && names[index]!.has(name)),
    );
  }
  return { tagOf, bindersOf };
}

/** The tag a direct eval in `sourceFile` enters the provider with. */
export function runtimeEvalSourceTag(ctx: CodegenContext, sourceFile: ts.SourceFile): number {
  return ctx.runtimeEvalSourceTags?.tagOf.get(sourceFile) ?? RUNTIME_EVAL_SHARED_TAG;
}

/** Is any source tagged? Every provider entry keeps its untagged code when not. */
export function runtimeEvalTagsInUse(ctx: CodegenContext): boolean {
  return ctx.runtimeEvalSourceTags !== undefined;
}

/** Set the active flag to `tag`. */
export function emitRuntimeEvalProviderActive(ctx: CodegenContext, fctx: FunctionContext, tag: number): void {
  const globalIdx = ensureRuntimeEvalProviderActiveGlobal(ctx);
  fctx.body.push({ op: "i32.const", value: tag }, { op: "global.set", index: globalIdx });
}

/**
 * Save the caller's tag in a fresh local and set `tag`, ahead of the push, so the push already mirrors the entering
 * source and the exit puts a nested entry's outer tag back. Undefined, emitting nothing, when no source is tagged.
 */
export function emitRuntimeEvalTagEnter(ctx: CodegenContext, fctx: FunctionContext, tag: number): number | undefined {
  if (!runtimeEvalTagsInUse(ctx)) return undefined;
  const savedLocal = allocLocal(fctx, `__runtime_eval_saved_tag_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push(
    { op: "global.get", index: ensureRuntimeEvalProviderActiveGlobal(ctx) },
    { op: "local.set", index: savedLocal },
  );
  emitRuntimeEvalProviderActive(ctx, fctx, tag);
  return savedLocal;
}

/** Put the saved tag back, or clear the flag when none was saved. */
export function runtimeEvalTagRestore(ctx: CodegenContext, savedTagLocal: number | undefined): Instr[] {
  return [
    savedTagLocal === undefined
      ? { op: "i32.const", value: RUNTIME_EVAL_INACTIVE_TAG }
      : { op: "local.get", index: savedTagLocal },
    { op: "global.set", index: ensureRuntimeEvalProviderActiveGlobal(ctx) },
  ];
}

/** Leave the provider: pull the bindings back, then {@link runtimeEvalTagRestore}. */
export function runtimeEvalProviderExit(ctx: CodegenContext, savedTagLocal: number | undefined): Instr[] {
  const pullIdx = ctx.funcMap.get(RUNTIME_EVAL_PULL_GLOBALS);
  return [
    ...(pullIdx === undefined ? [] : [{ op: "call", funcIdx: pullIdx } satisfies Instr]),
    ...runtimeEvalTagRestore(ctx, savedTagLocal),
  ];
}

/**
 * Protect the provider call emitted from `fctx.body[from]` on, so a throw through it with this module's own tag (the
 * provider rethrows a caller's exception with the caller's tag) still pulls and restores the saved tag. Nothing when
 * no tag was saved.
 */
export function emitRuntimeEvalRestoreOnUnwind(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: number,
  savedTagLocal: number | undefined,
): void {
  if (savedTagLocal === undefined) return;
  const unwindLocal = allocLocal(fctx, `__runtime_eval_unwind_${fctx.locals.length}`, { kind: "externref" });
  const call = fctx.body.splice(from);
  const restore = runtimeEvalProviderExit(ctx, savedTagLocal);
  fctx.body.push(
    buildRestoreOnUnwind({ kind: "val", type: { kind: "externref" } }, call, ensureExnTag(ctx), unwindLocal, restore),
  );
}

/** Do two sources mirror `name`, so that the push and pull carry it per tagged source? */
export function runtimeEvalMirrorsPerSource(ctx: CodegenContext, name: string): boolean {
  return ctx.runtimeEvalSourceTags?.bindersOf.has(name) ?? false;
}

/**
 * Where two sources mirror `name`, emit `emitOne` once per tagged source that binds it, behind a test of its tag and
 * under its own binding view, with no default arm. Any other name is emitted once, as is.
 */
export function emitPerSourceArms(ctx: CodegenContext, fctx: FunctionContext, name: string, emitOne: () => void): void {
  const binders = ctx.runtimeEvalSourceTags?.bindersOf.get(name);
  if (binders === undefined) {
    emitOne();
    return;
  }
  for (const sourceFile of binders) {
    const arm: Instr[] = [];
    // The `if` joins the attached body before its arm is filled, so global-index fixups reach the arm meanwhile.
    fctx.body.push(
      { op: "global.get", index: ensureRuntimeEvalProviderActiveGlobal(ctx) },
      { op: "i32.const", value: runtimeEvalSourceTag(ctx, sourceFile) },
      { op: "i32.eq" },
      { op: "if", blockType: { kind: "empty" }, then: arm },
    );
    const saved = pushBody(fctx);
    fctx.body = arm;
    withSourceBindings(ctx, sourceFile, emitOne);
    popBody(fctx, saved);
  }
}

/**
 * The tag an interpreted callback runs under: the active one, so a callback inside a source's eval keeps that
 * source's arms, else the shared view.
 */
export function runtimeEvalCallbackTag(ctx: CodegenContext, activeBeforeLocal: number): Instr[] {
  if (!runtimeEvalTagsInUse(ctx)) return [{ op: "i32.const", value: RUNTIME_EVAL_SHARED_TAG }];
  return [
    { op: "local.get", index: activeBeforeLocal },
    { op: "i32.const", value: RUNTIME_EVAL_SHARED_TAG },
    { op: "local.get", index: activeBeforeLocal },
    { op: "select" },
  ];
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
    ctx.undefinedSingleton === true && ctx.undefinedGlobalIdx !== undefined
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
