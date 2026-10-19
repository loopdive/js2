// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { emitClosureHasRestExport } from "../src/codegen/closure-exports.js";
import { stripHostBridgeExports } from "../src/codegen/host-bridge-exports.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const SOURCE = `
 export function five():any {return function(a:number,b:number,c:number,d:number,e:number):number{return a+b+c+d+e;};}
 export function nine():any {return function(a:number,b:number,c:number,d:number,e:number,f:number,g:number,h:number,i:number):number{return a+b+c+d+e+f+g+h+i;};}
 export function rest():any {return function(this:any,...v:any[]):number{return (this?this.bias:0)+v.length;};}
 export function prefix():any {return function(a:number,b:number,...v:any[]):number{return a+b+v.length;};}
 export function argc():any {return function():number{return arguments.length*100+arguments[31];};}
 export function defaults():any {return function(a:number=40,b:number=1):number{return a+b+arguments.length;};}
 export function decimal():(a:number,b:number)=>number{return function(a:number,b:number):number{return a+b;};}
 export function throwing():any {return function(this:any,...v:any[]):number{throw this.token;};}
 export function __call_fn_apply():number{return -700;}
 export function $ci():number{return -701;}
 export function $ci$():number{return -702;}
 export function $ci_extra():number{return -703;}
`;

async function instantiate(source = SOURCE) {
  const result = await compile(source, { skipSemanticDiagnostics: true, deferTopLevelInit: true });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const ex = wrapCompiledExports(result, instance) as Record<string, (...args: any[]) => any>;
  ex.__module_init?.();
  return { result, instance, ex, raw: instance.exports as Record<string, any> };
}

describe("native complete-argv callable boundary", () => {
  let module: Awaited<ReturnType<typeof instantiate>>;
  beforeAll(async () => {
    module = await instantiate();
  });

  it("binds the complete-vector entry to its exact compiler alias", () => {
    const raw = module.raw;
    expect(raw.$cu.length).toBe(19);
    expect(raw.$cu.get(18)).toBe(raw.$ci$$);
    expect(raw.$cm.value & (1 << 18)).not.toBe(0);
    expect(module.ex.__call_fn_apply()).toBe(-700);
    expect(module.ex.$ci()).toBe(-701);
    expect(module.ex.$ci$()).toBe(-702);
    expect(module.ex.$ci_extra()).toBe(-703);
  });

  it("calls a returned five-parameter function", () => {
    expect(module.ex.five()(1, 2, 3, 4, 5)).toBe(15);
  });
  it("calls an above-cap nine-parameter function", () => {
    expect(module.ex.nine()(1, 2, 3, 4, 5, 6, 7, 8, 9)).toBe(45);
  });
  it("refuses wide fixed over-application until native extras are preserved", () => {
    expect(() => module.ex.nine()(...Array(32).fill(1))).toThrow(TypeError);
  });
  for (const count of [0, 1, 4, 5, 8, 9, 32]) {
    it(`preserves ${count} ordinary rest arguments and the receiver`, () => {
      expect(module.ex.rest().apply({ bias: 42 }, Array(count).fill(1))).toBe(42 + count);
    });
  }
  it("preserves a prefixed rest vector beyond the positional cap", () => {
    expect(module.ex.prefix()(1, 2, ...Array(30).fill(1))).toBe(33);
  });
  it("preserves arguments.length and a far extra argument", () => {
    expect(module.ex.argc()(...Array(32).fill(1))).toBe(3201);
  });
  it("does not pad actual argc when evaluating default parameters", () => {
    expect(module.ex.defaults()()).toBe(41);
    expect(module.ex.defaults()(40)).toBe(42);
    expect(module.ex.defaults()(39, 1)).toBe(42);
  });
  it("adapts non-integer numeric arguments in an isolated typed-only module", async () => {
    const typed = await instantiate(
      "export function decimal():(a:number,b:number)=>number{return function(a:number,b:number):number{return a+b;};}",
    );
    expect(typed.ex.decimal()(1.5, 40.5)).toBe(42);
    expect(typed.ex.decimal()(NaN, 1)).toBeNaN();
  });
  it("retains exact thrown tokens and restores the rest receiver", () => {
    const token = {};
    try {
      module.ex.throwing().apply({ token }, Array(32).fill(1));
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBe(token);
    }
    expect(module.ex.rest().call({ bias: 41 }, 1)).toBe(42);
  });
  it("accepts the exact raw exports object after instance association", () => {
    const ex = wrapCompiledExports(module.result, module.instance.exports) as any;
    expect(ex.nine()(1, 2, 3, 4, 5, 6, 7, 8, 9)).toBe(45);
  });
  it("refuses copied records instead of trusting complete-vector helper names", async () => {
    const result = await compile(
      "export function nine():any{return function(a:number,b:number,c:number,d:number,e:number,f:number,g:number,h:number,i:number):number{return a+b+c+d+e+f+g+h+i;};}",
      { skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    const record = { ...instance.exports };
    let calls = 0;
    record.__call_fn_apply = () => {
      calls++;
      return 99;
    };
    const ex = wrapCompiledExports(result, record) as any;
    expect(() => ex.nine()(1, 2, 3, 4, 5, 6, 7, 8, 9)).toThrow();
    expect(calls).toBe(0);
    imports.setInstance?.(instance);
    const trusted = wrapCompiledExports(result, instance) as any;
    expect(trusted.nine()(1, 2, 3, 4, 5, 6, 7, 8, 9)).toBe(45);
  });
  it("cannot redirect a pinned callable through a mutated or donor binding", async () => {
    const other = await instantiate(
      "export function nine():any{return function(a:number,b:number,c:number,d:number,e:number,f:number,g:number,h:number,i:number):number{return -999;};}",
    );
    const original = module.raw.$cu.get(18),
      fn = module.ex.nine();
    try {
      module.raw.$cu.set(18, other.raw.$cu.get(18));
      expect(fn(1, 2, 3, 4, 5, 6, 7, 8, 9)).toBe(45);
      const ex = wrapCompiledExports(module.result, { ...module.raw }) as any;
      // An already-cached facade can retain the genuine source owner even
      // when this new projection refuses authority. It must never use donor.
      try {
        const projected = ex.nine();
        expect(projected(1, 2, 3, 4, 5, 6, 7, 8, 9)).toBe(45);
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
      }
    } finally {
      module.raw.$cu.set(18, original);
    }
  });
});

function publication() {
  const mod = createEmptyModule();
  const ctx = createCodegenContext(mod, {} as ts.TypeChecker);
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  const index = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, index, {
    name: "__apply_closure",
    typeIdx,
    locals: [],
    body: [{ op: "ref.null.extern" }],
    exported: false,
  });
  ctx.funcMap.set("__apply_closure", index);
  ctx.applyClosureReserved = true;
  // A synthetic ordinary registry row is enough to demand the adapter; this
  // structural test never treats the row as execution/conformance evidence.
  ctx.closureInfoByTypeIdx.set(typeIdx, {
    structTypeIdx: typeIdx,
    funcTypeIdx: typeIdx,
    paramTypes: [],
    returnType: null,
  });
  emitClosureHasRestExport(ctx);
  const entry = mod.exports.find((e) => e.name === "__call_fn_apply");
  expect(entry).toBeDefined();
  return { ctx, mod, entry: entry! };
}

describe("complete-argv export provenance", () => {
  it("strips compiler descriptors, preserving same-spelled user copies", () => {
    const { ctx, mod, entry } = publication();
    ctx.indexSpaceFrozen = true;
    ctx.emitHostBridge = false;
    const user = { ...entry, desc: { ...entry.desc } };
    mod.exports.push(user);
    stripHostBridgeExports(ctx);
    expect(mod.exports).toContain(user);
    expect(mod.exports).not.toContain(entry);
  });
  it("rejects an unrecorded copy targeting the native adapter before freeze", () => {
    const { ctx, mod, entry } = publication();
    mod.exports.push({ ...entry, desc: { ...entry.desc } });
    expect(() => stripHostBridgeExports(ctx)).toThrow(/unrecorded closure-apply/);
  });
  it("rejects a renamed recorded descriptor before freeze", () => {
    const { ctx, entry } = publication();
    entry.name = "changed";
    expect(() => stripHostBridgeExports(ctx)).toThrow(/changed its published name/);
  });
});
