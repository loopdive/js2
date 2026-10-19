// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { lowerIrFunctionToWasm, projectIrFunctionSignature } from "../src/ir/backend/wasm-lowering.js";
import { projectObjectReferenceFunction } from "../src/ir/lowering/object-reference-projection.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { createGvnCounters, gvnCore } from "../src/ir/passes/gvn-core.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import type { IrObjectReferenceLowering } from "../src/ir/backend/handles.js";
import { irCallableBindingKey, irSupportFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { irVal, type IrFuncRef, type IrFunction, type IrType } from "../src/ir/nodes.js";
import { createEmptyModule, type Instr } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const ext = { kind: "externref" } as const,
  f64 = { kind: "f64" } as const;
const source = `
export function read(input:{n:number}):number{return input.n;}
export function store(input:{n:number},value:number):void{input.n=value;}
export function echo(input:{n:number}):{n:number}{return input;}
export function make(n:number):{n:number}{return {n};}
export function allocated(n:number):{n:number}{const input={n};input.n=n+1;return input;}
export function discard(input:{n:number}):number{input.n;return 42;}
export function pair(input:{n:number}):number{const first=input.n;const second=input.n;return second*10+first;}
export function choose(input:{n:number},flag:number):number{return flag?input.n:input.n;}
`;
const identities = createTestIrFunctionIdentityFactory("6979-reference-object");
const objectType: IrType = { kind: "object", shape: { fields: [{ name: "n", type: irVal(f64) }] } };
const ast = analyzeSource(source);
const functions = ast.sourceFile.statements.filter(ts.isFunctionDeclaration).map(
  (decl) =>
    lowerFunctionAstToIr(decl, {
      exported: true,
      ownerUnitId: identities.next(decl.name!.text).unitId,
      paramTypeOverrides: decl.parameters.map((p) => (p.name.getText() === "input" ? objectType : irVal(f64))),
      returnTypeOverride: decl.type && ts.isTypeLiteralNode(decl.type) ? objectType : undefined,
    }).main,
);
const get = irSupportFuncRef(functions[0]!.unitId, "field-get:n", "misleading-get-label");
const set = irSupportFuncRef(functions[0]!.unitId, "field-set:n", "misleading-set-label");
const reference: IrObjectReferenceLowering = { carrier: ext, fields: new Map([["n", { get, set }]]) };

function build(
  name: string,
  result: IrType,
  body: (
    builder: IrFunctionBuilder,
    input: ReturnType<IrFunctionBuilder["addParam"]>,
  ) => ReturnType<IrFunctionBuilder["addParam"]>,
) {
  const b = new IrFunctionBuilder(identities.next(name), [result], true);
  const input = b.addParam("input", objectType);
  b.openBlock();
  b.terminate({ kind: "return", values: [body(b, input)] });
  return b.finish();
}
functions.push(
  build("relay", objectType, (b, input) => {
    const value = b.emitConst({ kind: "f64", value: 42 }, irVal(f64));
    b.emitCall(irUnitFuncRef(functions[1]!), [input, value], null);
    return b.emitCall(irUnitFuncRef(functions[2]!), [input], objectType)!;
  }),
);
functions.push(build("erase", irVal(ext), (b, input) => b.emitCoerceToExternref(input)));

/**
 * A backend contract fixture, NOT public compile()/prepared-entry publication.
 * The only JS imports are positively-admitted foreign Get/Set primitives.
 * Native record operations use the very same source IR with the native ABI;
 * the test's provider dispatch chooses those bodies before the foreign arm.
 */
function fixture(byReference: boolean, displaced = false) {
  const mod = createEmptyModule();
  if (displaced) mod.types.push({ kind: "struct", name: "Prefix", fields: [] });
  const typeIdx = mod.types.length;
  mod.types.push({ kind: "struct", name: "NativeRecord", fields: [{ name: "n", type: f64, mutable: true }] });
  const functionsByBinding = new Map<string, number>();
  const fail = (): never => {
    throw Error("undeclared fixture binding");
  };
  const resolver: IrLowerResolver = {
    resolveFunc: (ref) => functionsByBinding.get(irCallableBindingKey(ref.binding)) ?? fail(),
    resolveGlobal: fail,
    resolveType: fail,
    internFuncType(type) {
      const index = mod.types.findIndex((row) => JSON.stringify(row) === JSON.stringify(type));
      if (index >= 0) return index;
      mod.types.push(type);
      return mod.types.length - 1;
    },
    resolveObject: () => ({ typeIdx, fieldIdx: (name) => (name === "n" ? 0 : fail()) }),
  };
  if (byReference) {
    for (const [name, params, results] of [
      ["get", [ext], [f64]],
      ["set", [ext, f64], []],
    ] as const)
      mod.imports.push({
        module: "foreign",
        name,
        desc: {
          kind: "func",
          typeIdx: resolver.internFuncType({ kind: "func", params: [...params], results: [...results] }),
        },
      });
    // Actual native Get/Set bodies from the same source IR, not JS stand-ins.
    for (const fn of functions.slice(0, 2)) mod.functions.push(lowerIrFunctionToWasm(fn, resolver).func);
    const native = (param: number): Instr[] => [
      { op: "local.get", index: param },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx },
    ];
    for (const [ref, params, results, index] of [
      [get, [ext], [f64], 0],
      [set, [ext, f64], [], 1],
    ] as const) {
      const extra: Instr[] = index === 1 ? [{ op: "local.get", index: 1 }] : [];
      functionsByBinding.set(irCallableBindingKey(ref.binding), mod.imports.length + mod.functions.length);
      mod.functions.push({
        name: "provider",
        typeIdx: resolver.internFuncType({ kind: "func", params: [...params], results: [...results] }),
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx },
          {
            op: "if",
            blockType: index === 0 ? { kind: "val", type: f64 } : { kind: "empty" },
            then: [...native(0), ...extra, { op: "call", funcIdx: mod.imports.length + index }],
            else: [{ op: "local.get", index: 0 }, ...extra, { op: "call", funcIdx: index }],
          },
        ],
      });
    }
    resolver.resolveObjectReference = () => reference;
  }
  const start = mod.imports.length + mod.functions.length;
  functions.forEach((fn, index) =>
    functionsByBinding.set(irCallableBindingKey(irUnitFuncRef(fn).binding), start + index),
  );
  for (const fn of functions) {
    const projected = byReference ? projectObjectReferenceFunction(fn, () => reference) : fn;
    const optimized = deadCode(gvnCore(projected, {}, createGvnCounters()));
    const lowered = lowerIrFunctionToWasm(optimized, resolver).func;
    mod.exports.push({ name: fn.name, desc: { kind: "func", index: mod.imports.length + mod.functions.length } });
    mod.functions.push(lowered);
  }
  const wasm = new WebAssembly.Module(emitBinary(mod));
  const admitted = new WeakSet<object>();
  const instance = new WebAssembly.Instance(
    wasm,
    byReference
      ? {
          foreign: {
            get(receiver: object) {
              if (!admitted.has(receiver)) throw TypeError("unadmitted receiver");
              return Reflect.get(receiver, "n", receiver);
            },
            set(receiver: object, value: number) {
              if (!admitted.has(receiver)) throw TypeError("unadmitted receiver");
              if (!Reflect.set(receiver, "n", value, receiver)) throw TypeError("read-only receiver");
            },
          },
        }
      : {},
  );
  return {
    wasm,
    resolver,
    instance,
    api: instance.exports as Record<string, (...args: any[]) => any>,
    admit: (value: object) => {
      admitted.add(value);
      return value;
    },
  };
}

for (const displaced of [false, true])
  describe(`explicit reference-object lowering (${displaced ? "displaced" : "ordinary"} coordinates)`, () => {
    const f = fixture(true, displaced),
      api = f.api;
    it("projects source signatures to externref without changing the semantic IR", () => {
      expect(projectIrFunctionSignature(functions[0]!, f.resolver).params[0]!.slots).toEqual([ext]);
      expect(functions[0]!.params[0]!.type.kind).toBe("object");
      expect(functions[0]!.blocks[0]!.instrs.some((i) => i.kind === "object.get")).toBe(true);
      expect(WebAssembly.Module.imports(f.wasm).map((i) => i.module + "." + i.name)).toEqual([
        "foreign.get",
        "foreign.set",
      ]);
    });
    it("keeps foreign reads, writes and round trips live across IR-to-IR calls", () => {
      const value = f.admit({ n: 41 });
      expect(api.read!(value)).toBe(41);
      expect(api.relay!(value)).toBe(value);
      expect(value.n).toBe(42);
      value.n = 43;
      expect(api.read!(value)).toBe(43);
      expect(api.erase!(value)).toBe(value);
    });
    it("preserves same-content distinct identities, null and opaque echo values", () => {
      const a = { n: 1 },
        b = { n: 1 };
      expect(api.echo!(a)).toBe(a);
      expect(api.echo!(b)).toBe(b);
      expect(api.echo!(a)).not.toBe(b);
      expect(api.echo!(null)).toBeNull();
    });
    it("does not enumerate, traverse, or pre-read Proxy arguments", () => {
      const log: string[] = [];
      const value = f.admit(
        new Proxy(
          { n: 41 },
          {
            ownKeys() {
              throw Error("eager ownKeys");
            },
            getPrototypeOf() {
              throw Error("eager prototype");
            },
            get(target, key, receiver) {
              log.push("get:" + String(key));
              return Reflect.get(target, key, receiver);
            },
            set(target, key, value, receiver) {
              log.push("set:" + String(key));
              return Reflect.set(target, key, value, receiver);
            },
          },
        ),
      );
      expect(api.echo!(value)).toBe(value);
      expect(log).toEqual([]);
      expect(api.relay!(value)).toBe(value);
      expect(log).toEqual(["set:n"]);
      expect(api.read!(value)).toBe(42);
      expect(log).toEqual(["set:n", "get:n"]);
    });
    it("retains inherited getter/setter receivers and reentrant calls", () => {
      const nested = f.admit({ n: 7 });
      let seen: unknown;
      let stored = 34;
      const value = f.admit(
        Object.create({
          get n() {
            seen = this;
            return stored + api.read!(nested);
          },
          set n(v) {
            seen = this;
            stored = v;
          },
        }),
      );
      expect(api.read!(value)).toBe(41);
      expect(seen).toBe(value);
      api.store!(value, 42);
      expect(seen).toBe(value);
      expect(stored).toBe(42);
    });
    for (const operation of ["read", "store"] as const)
      it(`retains the exact ${operation} thrown token`, () => {
        const token = {};
        const value = f.admit(
          Object.create(null, {
            n:
              operation === "read"
                ? {
                    get() {
                      throw token;
                    },
                  }
                : {
                    set() {
                      throw token;
                    },
                  },
          }),
        );
        let thrown: unknown;
        try {
          api[operation]!(value, 42);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBe(token);
      });
    it("rejects foreign operations lacking admission without reading fields", () => {
      expect(() =>
        api.read!({
          get n() {
            throw Error("unadmitted Get");
          },
        }),
      ).toThrow("unadmitted receiver");
      expect(() => api.store!(f.admit(Object.freeze({ n: 1 })), 42)).toThrow("read-only receiver");
    });
    it("allocates native objects once and handles them through the same reference ABI", () => {
      const value = api.make!(41);
      expect(api.read!(value)).toBe(41);
      expect(api.relay!(value)).toBe(value);
      expect(api.read!(value)).toBe(42);
      expect(api.erase!(value)).toBe(value);
      const spilled = api.allocated!(41);
      expect(api.read!(spilled)).toBe(42);
      expect(api.echo!(spilled)).toBe(spilled);
    });
    it("keeps unused Gets and original Get order through DCE, GVN and scheduling", () => {
      let count = 0;
      const value = f.admit(
        Object.create(null, {
          n: {
            get() {
              return ++count;
            },
          },
        }),
      );
      expect(api.discard!(value)).toBe(42);
      expect(count).toBe(1);
      count = 0;
      expect(api.pair!(value)).toBe(21);
      expect(count).toBe(2);
      count = 0;
      expect(api.choose!(value, 1)).toBe(1);
      expect(count).toBe(1);
      count = 0;
      expect(api.choose!(value, 0)).toBe(1);
      expect(count).toBe(1);
    });
  });

describe("reference-object ABI fail-closed and native controls", () => {
  const native = fixture(false);
  it("keeps native-only Wasm executable with an empty import object", () => {
    expect(WebAssembly.Module.imports(native.wasm)).toEqual([]);
    const value = native.api.make!(41);
    expect(native.api.read!(value)).toBe(41);
    expect(native.api.relay!(value)).toBe(value);
    expect(native.api.read!(value)).toBe(42);
    expect(native.api.erase!(value)).toBe(value);
    expect(native.api.read!(native.api.allocated!(41))).toBe(42);
  });
  it("never falls back to a native cast when a reference shape is unsupported", () => {
    const resolver = { ...native.resolver, resolveObjectReference: () => null };
    expect(() => lowerIrFunctionToWasm(functions[0]!, resolver)).toThrow("no declared reference carrier");
    expect(() => projectIrFunctionSignature(functions[2]!, resolver)).toThrow("no declared reference carrier");
  });
  for (const [operation, fn] of [
    ["get", functions[0]!],
    ["set", functions[1]!],
  ] as const)
    it(`rejects missing ${operation} provider rather than raw struct access`, () => {
      const resolver = { ...native.resolver, resolveObjectReference: () => ({ ...reference, fields: new Map() }) };
      expect(() => projectObjectReferenceFunction(fn, resolver.resolveObjectReference)).toThrow(
        `no declared provider (n)`,
      );
    });
  it("refuses late reference field lowering that could have lost getter effects", () => {
    expect(() =>
      lowerIrFunctionToWasm(functions[0]!, { ...native.resolver, resolveObjectReference: () => reference }),
    ).toThrow("must be projected before optimization");
    expect(() => native.api.read!({ n: 42 })).toThrow(TypeError);
  });
  it("rejects a field projection whose logical result contract changed", () => {
    const read = functions[0]!;
    const changed = {
      ...read,
      blocks: read.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instruction) =>
          instruction.kind === "object.get"
            ? { ...instruction, resultType: irVal({ kind: "i32", boolean: true }) }
            : instruction,
        ),
      })),
    };
    expect(() => projectObjectReferenceFunction(changed, () => reference)).toThrow("different logical field contract");
  });
});
