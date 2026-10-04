// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts } from "../ts-api.js";
import type { GlobalDef, Instr, ValType } from "../ir/types.js";
import { walkInstructionDag } from "../wasm/model/instruction-walk.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitGlobalEnvironmentKey } from "./global-environment.js";
import { coerceType, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { emitUndefined } from "./expressions/late-imports.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";
import { localGlobalIdx } from "./registry/imports.js";

/** Provider operations. Checks must be side-effect-free; declaration creates
 * uninitialized cells only after the complete manifest has passed checks. */
export const SCRIPT_LEXICAL_OP = {
  checkVar: 0,
  checkLet: 1,
  checkConst: 2,
  declareLet: 3,
  declareConst: 4,
  read: 5,
  write: 6,
  initialize: 7,
  initialized: 8,
  has: 9,
} as const;
const EXT: ValType = { kind: "externref" };
interface Access {
  global: GlobalDef;
  read: number;
  write: number;
  initialize?: number;
}
const plans = new WeakMap<CodegenContext, Access[]>();
const preflights = new WeakMap<CodegenContext, number>();
const initializers = new WeakSet<Instr>();

export function emitScriptLexicalOperation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  operation: number,
  valueLocal?: number,
): void {
  const provider = ctx.standaloneScriptLexicalImport;
  if (!provider) throw new Error("Missing persistent Script lexical provider");
  const func = ensureLateImport(ctx, provider.name, [EXT, { kind: "f64" }, EXT], [EXT], provider.module);
  flushLateImportShifts(ctx, fctx);
  if (func === undefined) throw new Error("Missing persistent Script lexical operation");
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "f64.const", value: operation });
  if (valueLocal === undefined) emitUndefined(ctx, fctx);
  else fctx.body.push({ op: "local.get", index: valueLocal });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(provider.name) ?? func });
}

/** Do not create the first cell until checks for every declaration succeed. */
function emitSharedScriptLexicalDeclarations(ctx: CodegenContext, fctx: FunctionContext, source: ts.SourceFile): void {
  if (!ctx.standaloneScriptLexicalImport || ctx.sourceIsModule) return;
  const kinds = new Map<string, boolean>();
  for (const stmt of source.statements) {
    if (ts.isClassDeclaration(stmt)) throw new Error("Persistent Script class storage planning is not yet implemented");
    if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)))
      continue;
    for (const declaration of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name))
        throw new Error("Persistent Script lexical destructuring planning is not yet implemented");
      kinds.set(declaration.name.text, (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0);
    }
  }
  for (const name of new Set([...(ctx.globalObjectVarBindings ?? []), ...ctx.topLevelFunctionNames])) {
    emitScriptLexicalOperation(ctx, fctx, name, SCRIPT_LEXICAL_OP.checkVar);
    fctx.body.push({ op: "drop" });
  }
  for (const [name, immutable] of kinds) {
    emitScriptLexicalOperation(ctx, fctx, name, immutable ? SCRIPT_LEXICAL_OP.checkConst : SCRIPT_LEXICAL_OP.checkLet);
    fctx.body.push({ op: "drop" });
  }
  for (const [name, immutable] of kinds) {
    emitScriptLexicalOperation(
      ctx,
      fctx,
      name,
      immutable ? SCRIPT_LEXICAL_OP.declareConst : SCRIPT_LEXICAL_OP.declareLet,
    );
    fctx.body.push({ op: "drop" });
  }
}

/** Exact declaration-initialization store, not an arbitrary assignment that
 * happens while a private TDZ flag is clear. Called before emitTdzInit. */
export function markSharedScriptLexicalInitialization(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  if (!ctx.standaloneScriptLexicalImport || ctx.sourceIsModule || !ctx.globalLexicalBindings?.has(name)) return;
  const index = ctx.moduleGlobals.get(name);
  const store = fctx.body.at(-1);
  if (store?.op !== "global.set" || store.index !== index) {
    throw new Error(`Persistent Script lexical '${name}' has no exact initialization store`);
  }
  initializers.add(store);
}

function frame(name: string, params: ValType[], returnType: ValType | null): FunctionContext {
  return {
    name,
    params: params.map((type, index) => ({ name: `arg${index}`, type })),
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };
}

export function prepareSharedScriptLexicalAccess(ctx: CodegenContext, source: ts.SourceFile): void {
  if (!ctx.standaloneScriptLexicalImport || ctx.sourceIsModule || plans.has(ctx)) return;
  const plan: Access[] = [];
  plans.set(ctx, plan);
  const prologue = frame("__script_declarations", [], null);
  const previous = ctx.currentFunc;
  ctx.currentFunc = prologue;
  try {
    emitSharedScriptLexicalDeclarations(ctx, prologue, source);
  } finally {
    ctx.currentFunc = previous;
  }
  if (prologue.body.length) {
    const handle = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, handle, {
      name: prologue.name,
      typeIdx: addFuncType(ctx, [], []),
      locals: prologue.locals,
      body: prologue.body,
      exported: false,
    });
    preflights.set(ctx, handle);
  }
  for (const name of ctx.globalLexicalBindings ?? []) {
    const index = ctx.moduleGlobals.get(name);
    const global = index === undefined ? undefined : ctx.mod.globals[localGlobalIdx(ctx, index)];
    const immutable = source.statements.some(
      (statement) =>
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        statement.declarationList.declarations.some(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
        ),
    );
    // Const protects the binding, not an array's elements or an object's
    // fields. Only scalar primitive slots retain a cross-Script type proof.
    const scalarConst = immutable && (global?.type.kind === "f64" || global?.type.kind === "i32");
    if (!global || (global.type.kind !== "externref" && !scalarConst))
      throw new Error(
        `Persistent Script lexical '${name}' requires dynamic externref storage; private typed-slot proofs are not yet valid`,
      );
    const entry: Access = { global, read: -1, write: -1 };
    for (const operation of [SCRIPT_LEXICAL_OP.read, SCRIPT_LEXICAL_OP.write, SCRIPT_LEXICAL_OP.initialize]) {
      const read = operation === SCRIPT_LEXICAL_OP.read;
      const type = global.type;
      const fctx = frame(`__script_lexical_${operation}_${name}`, read ? [] : [type], read ? type : null);
      const previous = ctx.currentFunc;
      ctx.currentFunc = fctx;
      try {
        let valueLocal = read ? undefined : 0;
        if (!read && type.kind !== "externref") {
          fctx.body.push({ op: "local.get", index: 0 });
          coerceType(ctx, fctx, type, EXT);
          valueLocal = allocLocal(fctx, "__lexical_transport", EXT);
          fctx.body.push({ op: "local.set", index: valueLocal });
        }
        emitScriptLexicalOperation(ctx, fctx, name, operation, valueLocal);
        if (read) {
          if (type.kind !== "externref") coerceType(ctx, fctx, EXT, type);
        } else fctx.body.push({ op: "drop" });
      } finally {
        ctx.currentFunc = previous;
      }
      const handle = mintDefinedFunc(ctx);
      pushDefinedFunc(ctx, handle, {
        name: fctx.name,
        typeIdx: addFuncType(
          ctx,
          fctx.params.map((p) => p.type),
          read ? [type] : [],
        ),
        locals: fctx.locals,
        body: fctx.body,
        exported: false,
      });
      if (read) entry.read = handle;
      else if (operation === SCRIPT_LEXICAL_OP.write) entry.write = handle;
      else entry.initialize = handle;
    }
    plan.push(entry);
  }
}

export function finalizeSharedScriptLexicalAccess(ctx: CodegenContext): void {
  const preflight = preflights.get(ctx);
  if (preflight !== undefined) {
    const initializer = ctx.mod.functions.find((func) => func.name === "__module_init");
    if (!initializer) throw new Error("Persistent Script declarations require a canonical initializer entry");
    initializer.body.unshift({ op: "call", funcIdx: preflight });
    preflights.delete(ctx);
  }
  const plan = plans.get(ctx);
  if (!plan?.length) return;
  const imports = ctx.mod.imports.filter((entry) => entry.desc.kind === "global").length;
  const byIndex = new Map(
    plan.map((entry) => {
      const position = ctx.mod.globals.indexOf(entry.global);
      if (position < 0) throw new Error("Persistent lexical storage disappeared before finalization");
      return [imports + position, entry] as const;
    }),
  );
  const rewrite = (instruction: Instr): void => {
    if (instruction.op !== "global.get" && instruction.op !== "global.set") return;
    const entry = byIndex.get(instruction.index);
    if (!entry) return;
    const funcIdx =
      instruction.op === "global.get"
        ? entry.read
        : initializers.has(instruction) || instruction.initializesBinding
          ? entry.initialize
          : entry.write;
    if (funcIdx === undefined) throw new Error("Missing lexical initialization helper");
    (instruction as Partial<{ index: number }>).index = undefined;
    Object.assign(instruction, { op: "call", funcIdx });
  };
  const visited = new WeakSet<Instr[]>();
  for (const func of ctx.mod.functions) walkInstructionDag(func.body, rewrite, visited);
}
