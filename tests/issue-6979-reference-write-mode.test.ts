// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeSource, analyzeMultiSource } from "../src/checker/index.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { projectObjectReferenceFunction } from "../src/ir/lowering/object-reference-projection.js";
import { lowerIrFunctionToWasm } from "../src/ir/backend/wasm-lowering.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { irSupportFuncRef, irCallableBindingKey } from "../src/ir/callable-bindings.js";
import { forEachInstrDeep, irVal, type IrFunction, type IrInstr, type IrType } from "../src/ir/nodes.js";
import { createEmptyModule } from "../src/ir/types.js";
import { deadCode } from "../src/ir/passes/dead-code.js";
import { createGvnCounters, gvnCore } from "../src/ir/passes/gvn-core.js";
import { emitBinary } from "../src/emit/binary.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("6979-reference-write-mode");
const ext = { kind: "externref" } as const,
  f64 = { kind: "f64" } as const;
const record: IrType = { kind: "object", shape: { fields: [{ name: "n", type: irVal(f64) }] } };
const get = irSupportFuncRef(identities.unit(0), "get", "same-label");
const set = irSupportFuncRef(identities.unit(0), "strict-set", "same-label");
const setSloppy = irSupportFuncRef(identities.unit(0), "sloppy-set", "same-label");
const reference = { carrier: ext, fields: new Map([["n", { get, set, setSloppy }]]) };
type Context = { prefix?: string; suffix?: string; directive?: string; inferModuleStrict?: boolean };

function sourceFunction(context: Context = {}, body = "input.n=value;return value;") {
  const source = `${context.prefix ?? ""}\nfunction store(input:{n:number},other:{n:number},value:number):number{${context.directive ?? ""}${body}}\n${context.suffix ?? ""}`;
  const ast = analyzeSource(source);
  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "store") declarations.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast.sourceFile);
  expect(declarations).toHaveLength(1);
  const fn = lowerFunctionAstToIr(declarations[0]!, {
    ownerUnitId: identities.next("store").unitId,
    exported: true,
    paramTypeOverrides: [record, record, irVal(f64)],
    resolver: { inferModuleStrict: () => context.inferModuleStrict !== false },
  }).main;
  return { fn, source };
}
function stores(fn: IrFunction) {
  const rows: Extract<IrInstr, { kind: "object.set" }>[] = [];
  for (const block of fn.blocks)
    for (const instruction of block.instrs)
      forEachInstrDeep(instruction, (row) => {
        if (row.kind === "object.set") rows.push(row);
      });
  return rows;
}
/** Emitted reference-ABI fixture; imports implement only admitted foreign Get/Set. */
function execute(fn: IrFunction) {
  const module = createEmptyModule();
  const refs = [get, set, setSloppy];
  const resolver: IrLowerResolver = {
    resolveFunc(ref) {
      const index = refs.findIndex((r) => irCallableBindingKey(r.binding) === irCallableBindingKey(ref.binding));
      if (index < 0) throw Error("foreign binding");
      return index;
    },
    resolveType() {
      throw Error("unexpected type");
    },
    resolveGlobal() {
      throw Error("unexpected global");
    },
    internFuncType(type) {
      const index = module.types.findIndex((row) => JSON.stringify(row) === JSON.stringify(type));
      if (index >= 0) return index;
      module.types.push(type);
      return module.types.length - 1;
    },
    resolveObjectReference: () => reference,
  };
  for (const [index, name] of ["get", "strict", "sloppy"].entries())
    module.imports.push({
      module: "foreign",
      name,
      desc: {
        kind: "func",
        typeIdx: resolver.internFuncType({
          kind: "func",
          params: index ? [ext, f64] : [ext],
          results: index ? [] : [f64],
        }),
      },
    });
  const projected = projectObjectReferenceFunction(fn, () => reference);
  const optimized = deadCode(gvnCore(projected, {}, createGvnCounters()));
  module.functions.push(lowerIrFunctionToWasm(optimized, resolver).func);
  module.exports.push({ name: "store", desc: { kind: "func", index: 3 } });
  const admitted = new WeakSet<object>();
  const requireReceiver = (receiver: object) => {
    if (!admitted.has(receiver)) throw TypeError("unadmitted receiver");
  };
  const instance = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module)), {
    foreign: {
      get(receiver: object) {
        requireReceiver(receiver);
        return Reflect.get(receiver, "n", receiver);
      },
      strict(receiver: object, value: number) {
        requireReceiver(receiver);
        if (!Reflect.set(receiver, "n", value, receiver)) throw TypeError("refused strict write");
      },
      sloppy(receiver: object, value: number) {
        requireReceiver(receiver);
        Reflect.set(receiver, "n", value, receiver);
      },
    },
  });
  return {
    run: instance.exports.store as (a: object, b: object, value: number) => number,
    admit: (value: object) => {
      admitted.add(value);
      return value;
    },
    projected,
  };
}

describe("source property-write semantics before reference ABI planning", () => {
  const contexts: [string, Context, "throw" | "ignore"][] = [
    ["script", {}, "ignore"],
    ["function directive", { directive: '"use strict";' }, "throw"],
    ["source directive", { prefix: '"use strict";' }, "throw"],
    ["module", { prefix: "export {};" }, "throw"],
    ["synthetic script wrapper", { prefix: "export {};", inferModuleStrict: false }, "ignore"],
    [
      "wrapper with explicit directive",
      { prefix: "export {};", inferModuleStrict: false, directive: '"use strict";' },
      "throw",
    ],
    ["escaped directive", { directive: '"use str\\u0069ct";' }, "ignore"],
    ["continued directive", { directive: "'use str\\\nict';" }, "ignore"],
    ["template is not a directive", { directive: "`use strict`;" }, "ignore"],
    ["strict enclosing arrow", { prefix: 'const outer=()=>{"use strict";', suffix: "};" }, "throw"],
    ["strict enclosing accessor", { prefix: 'const object={get x(){"use strict";', suffix: "return 0;}};" }, "throw"],
    ["class body", { prefix: "class Box{method(){", suffix: "}}" }, "throw"],
  ];
  for (const [name, context, mode] of contexts)
    it(`preserves ${name} failed-write behavior`, () => {
      const { fn } = sourceFunction(context);
      expect(stores(fn).map((row) => row.failureMode)).toEqual([mode]);
      const f = execute(fn),
        input = f.admit(Object.freeze({ n: 1 })),
        other = f.admit({ n: 2 });
      if (mode === "throw") expect(() => f.run(input, other, 42)).toThrow(TypeError);
      else expect(f.run(input, other, 42)).toBe(42);
      expect(Reflect.get(input, "n")).toBe(1);
    });
  for (const strict of [false, true])
    for (const [name, body, count] of [
      ["plain", "input.n=value;return value;", 1],
      ["compound", "input.n+=value;return value;", 1],
      ["increment", "input.n++;return value;", 1],
      ["chain", "input.n=other.n=value;return value;", 2],
    ] as const)
      it(`${strict ? "strict" : "sloppy"} ${name} stores retain their source policy`, () => {
        const { fn } = sourceFunction({ directive: strict ? '"use strict";' : "" }, body);
        expect(stores(fn).map((row) => row.failureMode)).toEqual(Array(count).fill(strict ? "throw" : "ignore"));
        const f = execute(fn),
          input = f.admit(Object.freeze({ n: 1 })),
          other = f.admit({ n: 2 });
        if (strict) expect(() => f.run(input, other, 42)).toThrow(TypeError);
        else expect(f.run(input, other, 42)).toBe(42);
        expect(Reflect.get(input, "n")).toBe(1);
        if (name === "chain") expect(Reflect.get(other, "n")).toBe(42);
      });
  it("preserves the source policy of supported inline-with field writes", () => {
    const { fn } = sourceFunction({}, "with({n:1}){n=value;}return value;");
    expect(stores(fn).map((row) => row.failureMode)).toEqual(["ignore"]);
    const projected = projectObjectReferenceFunction(fn, () => reference);
    const calls = projected.blocks.flatMap((block) => block.instrs).filter((row) => row.kind === "call");
    expect(
      calls.some(
        (row) =>
          row.kind === "call" && irCallableBindingKey(row.target.binding) === irCallableBindingKey(setSloppy.binding),
      ),
    ).toBe(true);
  });
  it("executes a refused sloppy write without converting it to a strict failure", () => {
    const f = execute(sourceFunction().fn),
      input = f.admit(Object.freeze({ n: 1 }));
    expect(f.run(input, input, 42)).toBe(42);
    expect(Reflect.get(input, "n")).toBe(1);
  });
  it("executes a refused strict write as TypeError", () => {
    const f = execute(sourceFunction({ directive: '"use strict";' }).fn),
      input = f.admit(Object.freeze({ n: 1 }));
    expect(() => f.run(input, input, 42)).toThrow(TypeError);
  });
  it("selects different structural setter identities even when labels match", () => {
    const calls = [sourceFunction().fn, sourceFunction({ directive: '"use strict";' }).fn].map((fn) =>
      projectObjectReferenceFunction(fn, () => reference)
        .blocks.flatMap((block) => block.instrs)
        .find((row) => row.kind === "call"),
    );
    expect(calls.every((row) => row?.kind === "call" && row.target.name === "same-label")).toBe(true);
    expect(calls.map((row) => row?.kind === "call" && irCallableBindingKey(row.target.binding))).toEqual([
      irCallableBindingKey(setSloppy.binding),
      irCallableBindingKey(set.binding),
    ]);
  });
  for (const strict of [false, true])
    it(`does not swallow setter throws in ${strict ? "strict" : "sloppy"} code`, () => {
      const f = execute(sourceFunction({ directive: strict ? '"use strict";' : "" }).fn),
        token = {};
      const input = f.admit(
        Object.create(null, {
          n: {
            set() {
              throw token;
            },
          },
        }),
      );
      let thrown: unknown;
      try {
        f.run(input, input, 42);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(token);
    });
  it("keeps write policy explicit across reentrant strict/sloppy calls", () => {
    const strict = execute(sourceFunction({ directive: '"use strict";' }).fn),
      sloppy = execute(sourceFunction().fn);
    const frozen = sloppy.admit(Object.freeze({ n: 1 }));
    let receiver: unknown,
      stored = 0;
    const input = strict.admit(
      Object.create(null, {
        n: {
          set(value) {
            receiver = this;
            expect(sloppy.run(frozen, frozen, 7)).toBe(7);
            stored = value;
            return false;
          },
        },
      }),
    );
    expect(strict.run(input, input, 42)).toBe(42);
    expect(receiver).toBe(input);
    expect(stored).toBe(42);
  });
  it("refuses an unknown source policy or a missing sloppy provider", () => {
    const b = new IrFunctionBuilder(identities.next("unknown"), []);
    const input = b.addParam("input", record),
      value = b.addParam("value", irVal(f64));
    b.openBlock();
    b.emitObjectSet(input, "n", value);
    b.terminate({ kind: "return", values: [] });
    expect(() => projectObjectReferenceFunction(b.finish(), () => reference)).toThrow("requires its source write mode");
    const sloppy = sourceFunction().fn;
    expect(() =>
      projectObjectReferenceFunction(sloppy, () => ({ carrier: ext, fields: new Map([["n", { get, set }]]) })),
    ).toThrow("no declared provider");
  });
  it("retains write-failure semantics in whole-program preparation and codec replay", () => {
    const text = "export function store(input:{n:number},value:number):number{input.n=value;return value;}";
    const source = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    const result = prepareWholeIrProgram({
      sourceFiles: source.sourceFiles,
      entrySource: source.entryFile,
      checker: source.checker,
      deferTopLevelInit: false,
      policy: { backend: "wasmgc", target: "standalone", numberBoundary: { box: "native", unbox: "native" } },
    });
    expect(result.kind, JSON.stringify(result)).toBe("prepared");
    if (result.kind !== "prepared") throw Error("whole-program source failed");
    for (const program of [result.program, decodePreparedIrProgram(encodePreparedIrProgram(result.program))]) {
      const write = program.ir.functions.flatMap(stores);
      expect(write).toHaveLength(1);
      expect(write[0]!.failureMode).toBe("throw");
    }
  });
});

describe("whole-program logical record contracts are source facts, not physical layouts", () => {
  function prepare(text: string) {
    const source = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    return prepareWholeIrProgram({
      sourceFiles: source.sourceFiles,
      entrySource: source.entryFile,
      checker: source.checker,
      deferTopLevelInit: false,
      policy: { backend: "wasmgc", target: "standalone" },
    });
  }
  for (const [name, declaration, annotation, fields] of [
    ["inline", "", "{n:number}", ["n"]],
    ["alias", "type Input={n:number};", "Input", ["n"]],
    ["interface", "interface Input{n:number}", "Input", ["n"]],
    ["inherited interface", "interface Base{n:number} interface Input extends Base{s:string}", "Input", ["n", "s"]],
    [
      "nested",
      "type Child={n:number};type Input={child:Child,flag:boolean,label:string};",
      "Input",
      ["child", "flag", "label"],
    ],
    ["generic alias", "type Cell<T>={value:T};type Input=Cell<number>;", "Input", ["value"]],
    [
      "canonical field order",
      "type Input={z:number,a:boolean,'10':string,'2':number};",
      "Input",
      ["10", "2", "a", "z"],
    ],
  ] as const)
    it(`prepares and replays an exact ${name} parameter/result contract`, () => {
      const result = prepare(`${declaration} export function echo(input:${annotation}):${annotation}{return input;}`);
      expect(result.kind, JSON.stringify(result)).toBe("prepared");
      if (result.kind !== "prepared") throw Error("source contract preparation failed");
      for (const program of [result.program, decodePreparedIrProgram(encodePreparedIrProgram(result.program))]) {
        const functions = program.ir.functions.filter((fn) => fn.params[0]?.type.kind === "object");
        expect(functions).toHaveLength(1);
        const fn = functions[0]!,
          type = fn.params[0]!.type;
        if (type.kind !== "object") throw Error("logical object lost");
        expect(type.shape.fields.map((field) => field.name)).toEqual(fields);
        expect(Object.keys(type).sort()).toEqual(["kind", "shape"]);
        const entry = program.abi.entries.find(
          (row) =>
            row.contract.kind === "callable" &&
            row.contract.ref.binding.kind === "unit" &&
            row.contract.ref.binding.unitId === fn.unitId,
        )!;
        expect(entry.contract).toMatchObject({ kind: "callable", params: [type], results: [type] });
        expect(
          program.abi.entries.some((row) => row.contract.kind === "export" && row.contract.targetId === entry.plan.id),
        ).toBe(true);
      }
    });
  for (const [name, declaration, annotation] of [
    ["recursive", "type Input={next:Input};", "Input"],
    ["expanding generic recursion", "type Input<T>={next:Input<T[]>};", "Input<number>"],
    ["optional", "type Input={n?:number};", "Input"],
    ["indexed", "type Input={[key:string]:number};", "Input"],
    ["empty", "type Input={};", "Input"],
    ["mixed union", "type Input={n:number}|{s:string};", "Input"],
    ["nominal or method-bearing", "", "Date"],
  ] as const)
    it(`does not invent an ABI for a ${name} record contract`, () => {
      const result = prepare(`${declaration} export function echo(input:${annotation}):${annotation}{return input;}`);
      expect(result.kind).toBe("unsupported");
      expect(result).toMatchObject({ code: "type-resolution-unsupported" });
    });
});
