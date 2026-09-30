// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { GlobalDef, Instr, ValType } from "../ir/types.js";
import { walkInstructionDag } from "../wasm/model/instruction-walk.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import {
  emitGlobalEnvironmentKey,
  emitGlobalEnvironmentObject,
  ensureGlobalEnvironmentOperation,
} from "./global-environment.js";
import { localGlobalIdx } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

interface Access {
  global: GlobalDef;
  read: number;
  write: number;
}
const accessPlans = new WeakMap<CodegenContext, Access[]>();
const EXT: ValType = { kind: "externref" };

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

/** Prepare dependencies before deferred native helper fills. These globals
 * become Context object-record bindings, not private mutable caches. Typed
 * slots are refused until planning can invalidate their private-value proofs. */
export function prepareSharedScriptVarAccess(ctx: CodegenContext): void {
  if (!ctx.standaloneScriptVarBindings || ctx.sourceIsModule) return;
  if (accessPlans.has(ctx)) return;
  const plan: Access[] = [];
  accessPlans.set(ctx, plan);
  for (const name of ctx.globalObjectVarBindings ?? []) {
    const index = ctx.moduleGlobals.get(name);
    if (index === undefined) throw new Error(`Shared Script var '${name}' has no canonical global storage plan`);
    const global = ctx.mod.globals[localGlobalIdx(ctx, index)];
    if (!global) throw new Error(`Missing Script var storage: ${name}`);
    if (global.type.kind !== "externref") {
      throw new Error(
        `Shared Script var '${name}' requires a dynamic externref carrier; private typed-slot proofs are not yet valid across Scripts`,
      );
    }
    const read = frame(`__script_var_read_${name}`, [], EXT);
    const write = frame(`__script_var_write_${name}`, [EXT], null);
    for (const [fctx, operation] of [
      [read, "__extern_get"],
      [write, "__extern_set"],
    ] as const) {
      const previous = ctx.currentFunc;
      ctx.currentFunc = fctx;
      try {
        if (!emitGlobalEnvironmentObject(ctx, fctx)) throw new Error("Script var has no realm object");
        const func = ensureGlobalEnvironmentOperation(ctx, fctx, operation);
        if (func === undefined) throw new Error(`Script var has no ${operation} implementation`);
        emitGlobalEnvironmentKey(ctx, fctx, name);
        if (operation === "__extern_set") fctx.body.push({ op: "local.get", index: 0 });
        fctx.body.push({ op: "call", funcIdx: func });
      } finally {
        ctx.currentFunc = previous;
      }
      const params = fctx.params.map((param) => param.type);
      const handle = mintDefinedFunc(ctx);
      pushDefinedFunc(ctx, handle, {
        name: fctx.name,
        typeIdx: addFuncType(ctx, params, fctx.returnType ? [fctx.returnType] : []),
        locals: fctx.locals,
        body: fctx.body,
        exported: false,
      });
      if (operation === "__extern_get") plan.push({ global, read: handle, write: -1 });
      else plan[plan.length - 1]!.write = handle;
    }
  }
}

/** Rewrite every emitted global load/store, including callback and IR bodies.
 * Resolve GlobalDef identity only now, after late string globals have settled.
 * Global initializers cannot legally read these mutable globals. */
export function finalizeSharedScriptVarAccess(ctx: CodegenContext): void {
  const plan = accessPlans.get(ctx);
  if (!plan?.length) return;
  const imports = ctx.mod.imports.filter((entry) => entry.desc.kind === "global").length;
  const access = new Map(
    plan.map((entry) => {
      const position = ctx.mod.globals.indexOf(entry.global);
      if (position < 0) throw new Error("Shared Script var storage was removed before finalization");
      return [imports + position, entry] as const;
    }),
  );
  const rewrite = (instruction: Instr): void => {
    if (instruction.op !== "global.get" && instruction.op !== "global.set") return;
    const entry = access.get(instruction.index);
    if (!entry) return;
    const call: Instr = { op: "call", funcIdx: instruction.op === "global.get" ? entry.read : entry.write };
    (instruction as Partial<{ index: number }>).index = undefined;
    Object.assign(instruction, call);
  };
  const visited = new WeakSet<Instr[]>();
  for (const func of ctx.mod.functions) walkInstructionDag(func.body, rewrite, visited);
}
