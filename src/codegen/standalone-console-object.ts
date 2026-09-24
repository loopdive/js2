// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6671) `console` read as a VALUE in a host-free `--target standalone` module.
 *
 * `console.log(...)` CALLS have had a host-free lowering since #3469 (each
 * argument rendered into the in-module `__stdout_acc` rope). A bare `console`
 * VALUE had none: it fell to the graceful `ref.null.extern` default, so react's
 * module-init feature test
 *
 *     createTask = console.createTask ? console.createTask : function () { … };
 *
 * threw `TypeError: Cannot access property on null or undefined`.
 *
 * Every engine react targets has a `console`, so the honest standalone value is
 * a real object: one identity-stable plain `$Object` whose `log`/`warn`/`error`/
 * `info`/`debug` own properties are first-class callables writing to the SAME
 * stdout sink the direct-call lowering uses, and whose other members are simply
 * absent — `console.createTask` reads `undefined`, so react takes its fallback.
 * No host import is involved.
 *
 * The method callables are REST closures: lifted `(self, (ref null
 * $vec_externref)) -> externref`, the shape a `(...data) => …` closure lowers
 * to — which is what the lib type of every console method says, so statically
 * typed call sites pack their arguments into that vector. Each method's
 * builtin-fn metadata subtype carries a ClosureInfo copy flagged
 * `hasRestParam`, so the reflective dispatchers (`__call_fn_method_<n>`,
 * reached by method calls on the object, `.call`, `.apply`) and any-callee call
 * sites pack every argument too. All five share one body (the sink has one
 * channel) but have distinct metadata subtypes, so `console.log !==
 * console.error` and `.name` is right.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import { ensureBuiltinFnMetaType, pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { getOrCreateFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { runtimeEvalStateMayShadowBinding } from "./direct-eval-environment.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import {
  emitStandaloneStdoutAppendValue,
  ensureAnyToStringHelper,
  STANDALONE_STDOUT_APPEND_FN,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import { ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import { compileStringLiteral } from "./string-ops.js";

/** The console methods the direct-call lowering (`compileConsoleCall`) serves. */
export const STANDALONE_CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"] as const;

const METHOD_FN = "__standalone_console_method";
const OBJECT_FN = "__standalone_console_object";

/**
 * True when `id` is a read of the AMBIENT `console` in a host-free standalone
 * module. A user binding (`var console = …`, a parameter, an eval-introduced
 * name) keeps its ordinary lowering; a linked standalone module reads globals
 * from its owning realm; WASI keeps its `fd_write` path.
 */
function isStandaloneAmbientConsoleRead(ctx: CodegenContext, fctx: FunctionContext, id: ts.Identifier): boolean {
  if (!ctx.standalone || ctx.wasi || ctx.standaloneGlobalThisImport !== undefined) return false;
  if (id.text !== "console") return false;
  if (fctx.localMap.has("console") || (fctx.boxedCaptures?.has("console") ?? false)) return false;
  if (runtimeEvalStateMayShadowBinding(ctx, fctx, "console")) return false;
  const declaration = ctx.oracle.valueDeclarationOf(id);
  return declaration === undefined || declaration.getSourceFile().isDeclarationFile;
}

/**
 * Import-collector probe: is `node` a `console` identifier used as a VALUE
 * rather than as the receiver of a direct `console.<method>(…)` call (which has
 * its own lowering) or as a property name? Over-approximating only mints the
 * stdout sink the console object's methods write to.
 */
export function isConsoleValueIdentifier(node: ts.Node): boolean {
  if (!ts.isIdentifier(node) || node.text !== "console") return false;
  const parent = node.parent;
  if (parent === undefined || !ts.isPropertyAccessExpression(parent)) return true;
  if (parent.name === node) return false;
  const call = parent.parent;
  const methods: readonly string[] = STANDALONE_CONSOLE_METHODS;
  return !(ts.isCallExpression(call) && call.expression === parent && methods.includes(parent.name.text));
}

interface ConsoleMethodSignature {
  wrappers: NonNullable<ReturnType<typeof getOrCreateFuncRefWrapperTypes>>;
  funcIdx: number;
}

/** Emit the shared variadic body: args joined by " ", then "\n", into the sink. */
function emitConsoleMethodBody(ctx: CodegenContext, fctx: FunctionContext, vecTypeIdx: number, arrTypeIdx: number) {
  const appendLiteral = (text: string): Instr[] => {
    const saved = fctx.body;
    fctx.body = [];
    compileStringLiteral(ctx, fctx, text);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(STANDALONE_STDOUT_APPEND_FN)! });
    const out = fctx.body;
    fctx.body = saved;
    return out;
  };
  const renderElement = (iLocal: number, arrLocal: number): Instr[] => {
    const saved = fctx.body;
    fctx.body = [
      { op: "local.get", index: arrLocal },
      { op: "ref.as_non_null" },
      { op: "local.get", index: iLocal },
      { op: "array.get", typeIdx: arrTypeIdx },
    ];
    emitStandaloneStdoutAppendValue(ctx, fctx, { kind: "externref" });
    const out = fctx.body;
    fctx.body = saved;
    return out;
  };

  if (ctx.funcMap.get(STANDALONE_STDOUT_APPEND_FN) !== undefined && arrTypeIdx >= 0) {
    const iLocal = allocLocal(fctx, "console_i", { kind: "i32" });
    const nLocal = allocLocal(fctx, "console_n", { kind: "i32" });
    const arrLocal = allocLocal(fctx, "console_arr", { kind: "ref_null", typeIdx: arrTypeIdx });
    const loopBody: Instr[] = [
      { op: "local.get", index: iLocal },
      { op: "local.get", index: nLocal },
      { op: "i32.ge_s" },
      { op: "br_if", depth: 1 },
      { op: "local.get", index: iLocal },
      { op: "if", blockType: { kind: "empty" }, then: appendLiteral(" ") },
      ...renderElement(iLocal, arrLocal),
      { op: "local.get", index: iLocal },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "local.set", index: iLocal },
      { op: "br", depth: 0 },
    ];
    fctx.body.push(
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: nLocal },
          { op: "local.get", index: 1 },
          { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
          { op: "local.set", index: arrLocal },
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
          },
        ],
      },
      ...appendLiteral("\n"),
    );
  }
  fctx.body.push(...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }]));
}

function ensureConsoleMethodSignature(ctx: CodegenContext): ConsoleMethodSignature | null {
  // Register every helper the body needs BEFORE minting it (#2704).
  ensureAnyToStringHelper(ctx);
  const { vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  // `(self, (ref null $vec_externref)) -> externref` — the lifted shape of a
  // `(...data) => …` closure, which is what the lib type of every console
  // method says, so statically typed call sites pack their arguments for it.
  const wrappers = getOrCreateFuncRefWrapperTypes(
    ctx,
    [{ kind: "ref_null", typeIdx: vecTypeIdx }],
    [{ kind: "externref" }],
  );
  if (!wrappers) return null;

  let funcIdx = ctx.funcMap.get(METHOD_FN);
  if (funcIdx === undefined) {
    const fctx: FunctionContext = {
      name: METHOD_FN,
      params: [
        { name: "__self", type: { kind: "ref", typeIdx: wrappers.liftedSelfTypeIdx } },
        { name: "args", type: { kind: "ref_null", typeIdx: vecTypeIdx } },
      ],
      locals: [],
      localMap: new Map([
        ["__self", 0],
        ["args", 1],
      ]),
      returnType: { kind: "externref" },
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
      labelMap: new Map(),
      savedBodies: [],
    };
    emitConsoleMethodBody(ctx, fctx, vecTypeIdx, arrTypeIdx);
    flushLateImportShifts(ctx, fctx);
    funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: METHOD_FN,
      typeIdx: wrappers.liftedFuncTypeIdx,
      locals: fctx.locals,
      body: fctx.body,
      exported: false,
    });
    ctx.funcMap.set(METHOD_FN, funcIdx);
  }
  return { wrappers, funcIdx };
}

/** `__standalone_console_object() -> externref`: the lazily built singleton. */
function ensureConsoleObjectFunction(ctx: CodegenContext): number | undefined {
  const existing = ctx.funcMap.get(OBJECT_FN);
  if (existing !== undefined) return existing;
  ensureObjectRuntime(ctx);
  const signature = ensureConsoleMethodSignature(ctx);
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const setIdx = ctx.funcMap.get("__extern_set");
  if (!signature || newObjectIdx === undefined || setIdx === undefined) return undefined;

  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__native_console",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });

  const objLocal = 0;
  const initBody: Instr[] = [
    { op: "call", funcIdx: newObjectIdx },
    { op: "local.set", index: objLocal },
  ];
  for (const method of STANDALONE_CONSOLE_METHODS) {
    const metaTypeIdx = ensureBuiltinFnMetaType(
      ctx,
      signature.wrappers.structTypeIdx,
      signature.wrappers.closureInfo,
      `console:${method}`,
      method,
      0,
    );
    // Host/reflective dispatch (`__call_fn_method_<n>` — method calls on the
    // object, `.call`, `.apply`) packs every argument into the rest vector of
    // a rest-param closure. Mark this metadata subtype's own ClosureInfo copy
    // so those dispatchers treat the args vector as a `...rest` formal instead
    // of casting the first argument to it (which handed the body no args).
    const info = ctx.closureInfoByTypeIdx.get(metaTypeIdx);
    if (info && info.hasRestParam !== true) ctx.closureInfoByTypeIdx.set(metaTypeIdx, { ...info, hasRestParam: true });
    addStringConstantGlobal(ctx, method);
    initBody.push(
      { op: "local.get", index: objLocal },
      ...stringConstantExternrefInstrs(ctx, method),
      ...pushBuiltinFnSingletonValueInstrs(ctx, {
        type: { kind: "ref", typeIdx: metaTypeIdx },
        funcIdx: signature.funcIdx,
      }),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: setIdx },
    );
  }
  initBody.push({ op: "local.get", index: objLocal }, { op: "global.set", index: globalIdx });

  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: OBJECT_FN,
    typeIdx: addFuncType(ctx, [], [{ kind: "externref" }]),
    locals: [{ name: "console_obj", type: { kind: "externref" } }],
    body: [
      { op: "global.get", index: globalIdx },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: initBody },
      { op: "global.get", index: globalIdx },
    ],
    exported: false,
  });
  ctx.funcMap.set(OBJECT_FN, funcIdx);
  return funcIdx;
}

/** Lower an ambient `console` value read, or return `null` to decline. */
export function tryEmitStandaloneConsoleValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  id: ts.Identifier,
): ValType | null {
  if (!isStandaloneAmbientConsoleRead(ctx, fctx, id)) return null;
  const funcIdx = ensureConsoleObjectFunction(ctx);
  flushLateImportShifts(ctx, fctx);
  if (funcIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(OBJECT_FN) ?? funcIdx });
  return { kind: "externref" };
}
