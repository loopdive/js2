// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { objectReferenceCallables, deriveObjectReferencePlan } from "../src/ir/program/object-reference-plan.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import { irCallableBindingKey } from "../src/ir/core/callable-bindings.js";
import { irVal } from "../src/ir/core/types.js";
import { lowerIrFunctionToWasm } from "../src/ir/backend/wasm-lowering.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { createGvnCounters } from "../src/ir/passes/gvn-core.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";

const policy = { backend: "wasmgc", target: "standalone" } as const;
const source = `
type Input={n:number};
export function read(input:Input):number{return input.n;}
export function discard(input:Input):number{input.n;return 42;}
export function pair(input:Input):number{const a=input.n;const b=input.n;return b*10+a;}
export function write(input:Input,value:number):number{input.n=value;return value;}
export function echo(input:Input):Input{return input;}
`;

function input(text = source, more: Record<string, string> = {}) {
  const graph = analyzeMultiSource({ ...more, "./entry.ts": text }, "./entry.ts");
  return {
    sourceFiles: graph.sourceFiles,
    entrySource: graph.entryFile,
    checker: graph.checker,
    deferTopLevelInit: false,
    policy,
  };
}
function prepare(text = source, live = true, more: Record<string, string> = {}): PreparedIrProgram {
  const result = prepareWholeIrProgram({
    ...input(text, more),
    ...(live ? { objectReferenceProjection: "live" as const } : {}),
  });
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw Error("source preparation failed");
  return result.program;
}
function instructions(program: PreparedIrProgram) {
  const rows: IrInstr[] = [];
  for (const fn of program.ir.functions)
    for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (row) => rows.push(row));
  return rows;
}

/** Test-only physical binding. Production acceptance must reject these unmaterialized providers. */
function execute(program: PreparedIrProgram) {
  const plan = program.objectReferences!;
  const declarations = objectReferenceCallables(plan),
    module = createEmptyModule();
  const byKey = new Map<string, number>();
  const fail = (): never => {
    throw Error("missing fixture physical contract");
  };
  const resolver: IrLowerResolver = {
    resolveFunc: (ref) => byKey.get(irCallableBindingKey(ref.binding)) ?? fail(),
    resolveGlobal: fail,
    resolveType: fail,
    resolveObjectReference: (shape) => {
      const rows = declarations.filter((row) => JSON.stringify(row.receiver.shape) === JSON.stringify(shape));
      if (!rows.length) return null;
      return {
        carrier: { kind: "externref" },
        fields: new Map(
          shape.fields.map((field) => [
            field.name,
            {
              get: rows.find((row) => row.field === field.name && row.operation === "get")?.ref,
              set: rows.find((row) => row.field === field.name && row.operation === "set")?.ref,
              setSloppy: rows.find((row) => row.field === field.name && row.operation === "setSloppy")?.ref,
            },
          ]),
        ),
      };
    },
    internFuncType(type) {
      const i = module.types.findIndex((row) => JSON.stringify(row) === JSON.stringify(type));
      if (i >= 0) return i;
      module.types.push(type);
      return module.types.length - 1;
    },
  };
  const primitives: Record<string, (receiver: object, value?: number) => unknown> = {};
  const admitted = new WeakSet<object>();
  for (const [index, declaration] of declarations.entries()) {
    expect(declaration.field).toBe("n");
    const name = `p${index}`;
    byKey.set(irCallableBindingKey(declaration.ref.binding), index);
    module.imports.push({
      module: "fixture",
      name,
      desc: {
        kind: "func",
        typeIdx: resolver.internFuncType({
          kind: "func",
          params: declaration.operation === "get" ? [{ kind: "externref" }] : [{ kind: "externref" }, { kind: "f64" }],
          results: declaration.operation === "get" ? [{ kind: "f64" }] : [],
        }),
      },
    });
    primitives[name] = (receiver, value) => {
      if (!admitted.has(receiver)) throw TypeError("unadmitted receiver");
      if (declaration.operation === "get") return Reflect.get(receiver, declaration.field, receiver);
      const accepted = Reflect.set(receiver, declaration.field, value, receiver);
      if (!accepted && declaration.operation === "set") throw TypeError("refused strict write");
    };
  }
  program.ir.functions.forEach((fn, index) =>
    byKey.set(irCallableBindingKey({ kind: "unit", unitId: fn.unitId }), declarations.length + index),
  );
  for (const fn of program.ir.functions) {
    module.functions.push(lowerIrFunctionToWasm(fn, resolver).func);
    module.exports.push({
      name: fn.name,
      desc: { kind: "func", index: byKey.get(irCallableBindingKey({ kind: "unit", unitId: fn.unitId }))! },
    });
  }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module)), { fixture: primitives });
  return {
    exports: instance.exports as Record<string, (...values: any[]) => any>,
    admit(value: object) {
      admitted.add(value);
      return value;
    },
  };
}

describe("whole-program reference contracts before optimization", () => {
  it("executes the same empty-reference-plan scalar program on linear/WASI", () => {
    const text = "export function run(n:number):number{return n+1;}",
      selected = { backend: "linear", target: "wasi" } as const;
    const binaries: Uint8Array[] = [];
    for (const live of [false, true]) {
      const prepared = prepareWholeIrProgram({
        ...input(text),
        policy: selected,
        ...(live ? { objectReferenceProjection: "live" as const } : {}),
      });
      expect(prepared.kind, JSON.stringify(prepared)).toBe("prepared");
      if (prepared.kind !== "prepared") throw Error("linear scalar preparation failed");
      const accepted = acceptPreparedIrProgram(prepared.program, selected);
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error("linear scalar acceptance failed");
      const binary = emitBinary(emitAcceptedIrProgram(accepted).module),
        module = new WebAssembly.Module(binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const run = new WebAssembly.Instance(module, {}).exports.run as (n: number) => number;
      expect([run(41), run(6)]).toEqual([42, 7]);
      binaries.push(binary);
    }
    expect(binaries[0]).toEqual(binaries[1]);
  });
  it("executes an unchanged scalar-only no-import program in both projection modes", () => {
    const text = "export function run(n:number):number{return n+1;}",
      native = prepare(text, false),
      projected = prepare(text);
    expect(projected.objectReferences?.shapes).toEqual([]);
    const binaries: Uint8Array[] = [];
    for (const program of [native, projected]) {
      const accepted = acceptPreparedIrProgram(program, { backend: "wasmgc", target: "standalone" });
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error("scalar entry not accepted");
      const binary = emitBinary(emitAcceptedIrProgram(accepted).module),
        module = new WebAssembly.Module(binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const run = new WebAssembly.Instance(module, {}).exports.run as (n: number) => number;
      expect([run(41), run(6)]).toEqual([42, 7]);
      binaries.push(binary);
    }
    expect(binaries[0]).toEqual(binaries[1]);
  });
  it("declares exact field providers in the one ABI and projects before hygiene", () => {
    const program = prepare();
    expect(program.objectReferences?.shapes).toHaveLength(1);
    const declarations = objectReferenceCallables(program.objectReferences!);
    expect(declarations).toHaveLength(3);
    expect(instructions(program).some((row) => row.kind === "object.get" || row.kind === "object.set")).toBe(false);
    for (const declaration of declarations)
      expect(
        program.abi.entries.filter(
          (entry) => entry.plan.structuralReferenceKey === irCallableBindingKey(declaration.ref.binding),
        ),
      ).toHaveLength(1);
    const discard = program.ir.functions.find((fn) => fn.name === "discard")!;
    expect(discard.blocks.flatMap((block) => block.instrs).filter((row) => row.kind === "call")).toHaveLength(1);
    const native = prepare(source, false);
    expect(native.objectReferences).toBeUndefined();
    expect(
      native.ir.functions
        .find((fn) => fn.name === "discard")!
        .blocks.flatMap((block) => block.instrs)
        .some((row) => row.kind === "object.get"),
    ).toBe(false);
  });
  it("retains exact plans, ABI contracts and call effects after codec replay", () => {
    const program = prepare(),
      replay = decodePreparedIrProgram(encodePreparedIrProgram(program));
    expect(replay.objectReferences).toEqual(program.objectReferences);
    expect(encodePreparedIrProgram(replay)).toBe(encodePreparedIrProgram(program));
    assertPreparedIrProgram(replay);
    expect(
      instructions(replay).filter((row) => row.kind === "call" && row.target.binding.kind === "support"),
    ).toHaveLength(5);
  });
  it("covers the entire source/callee graph across an imported alias", () => {
    const program = prepare(
      `import {read as helper} from './helper';export function run(input:{n:number}):number{return helper(input);}`,
      true,
      { "./helper.ts": "export function read(input:{n:number}):number{input.n;return input.n;}" },
    );
    expect(program.inventory.sources).toHaveLength(2);
    expect(program.ir.functions).toHaveLength(2);
    expect(instructions(program).some((row) => row.kind === "object.get")).toBe(false);
    expect(
      program.abi.entries.some(
        (entry) => entry.plan.intent.kind === "callable" && entry.plan.intent.origin === "module-alias",
      ),
    ).toBe(true);
    assertPreparedIrProgram(program);
  });
  it("includes nested record contracts, rather than treating a source annotation as layout", () => {
    const program = prepare(
      "type Inner={n:number};type Outer={child:Inner};export function echo(input:Outer):Outer{return input;}",
    );
    expect(program.objectReferences?.shapes).toHaveLength(2);
    expect(objectReferenceCallables(program.objectReferences!)).toHaveLength(6);
    expect(acceptPreparedIrProgram(program, { backend: "wasmgc", target: "standalone" }).kind).toBe("unsupported");
  });
  for (const text of [source, "export function run(n:number):number{const obj={n};return obj.n;}"])
    it("does not publish an entry before physical resources exist", () => {
      const result = acceptPreparedIrProgram(prepare(text), { backend: "wasmgc", target: "standalone" });
      expect(result.kind, JSON.stringify(result)).toBe("unsupported");
    });
  it("executes optimized source Get effects with admitted live references", () => {
    const fixture = execute(prepare());
    const log: string[] = [],
      token = {};
    const value = fixture.admit(
      new Proxy(
        { n: 0 },
        {
          get(target, key, receiver) {
            log.push(String(key));
            return Reflect.get(target, key, receiver) + log.length;
          },
        },
      ),
    );
    expect(fixture.exports.discard!(value)).toBe(42);
    expect(log).toEqual(["n"]);
    expect(fixture.exports.pair!(value)).toBe(32);
    expect(log).toEqual(["n", "n", "n"]);
    const throwing = fixture.admit({
      get n() {
        throw token;
      },
    });
    try {
      fixture.exports.discard!(throwing);
      throw Error("getter did not throw");
    } catch (error) {
      expect(error).toBe(token);
    }
    expect(fixture.exports.echo!(value)).toBe(value);
  });
  it("retains strict refused-write and exact setter exceptions after preparation", () => {
    const fixture = execute(prepare()),
      token = {};
    expect(() => fixture.exports.write!(fixture.admit(Object.freeze({ n: 1 })), 42)).toThrow(TypeError);
    try {
      fixture.exports.write!(
        fixture.admit({
          set n(value: number) {
            throw token;
          },
        }),
        42,
      );
      throw Error("setter did not throw");
    } catch (error) {
      expect(error).toBe(token);
    }
  });
  it("selects the sloppy setter from genuine script source through whole preparation", () => {
    const program = prepare("function store(input:{n:number},value:number):number{input.n=value;return value;}");
    const rows = instructions(program).filter((row) => row.kind === "call");
    expect(rows).toHaveLength(1);
    const sloppy = objectReferenceCallables(program.objectReferences!).find((row) => row.operation === "setSloppy")!;
    expect(rows[0]).toMatchObject({ target: sloppy.ref });
    const fixture = execute(program),
      value = fixture.admit(Object.freeze({ n: 1 }));
    expect(fixture.exports.store!(value, 42)).toBe(42);
    expect(value).toEqual({ n: 1 });
  });
  it("does not treat an unknown projection request as native-only permission", () => {
    expect(() => prepareWholeIrProgram({ ...input(), objectReferenceProjection: "future" as "live" })).toThrow(
      /unknown object reference projection/,
    );
  });
  it("rejects missing, reordered or foreign type populations", () => {
    const program = prepare();
    for (const plan of [
      { ...program.objectReferences!, shapes: [] },
      { ...program.objectReferences!, sourceId: "foreign" },
      { ...program.objectReferences!, schema: "future" },
    ])
      expect(() => assertPreparedIrProgram({ ...program, objectReferences: plan } as PreparedIrProgram)).toThrow(
        /reference object program/,
      );
  });
  it("rejects provider removal, forged signature and false provider identity", () => {
    const program = prepare(),
      provider = program.abi.entries.find(
        (entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "support",
      )!;
    expect(() =>
      assertPreparedIrProgram({
        ...program,
        abi: { entries: program.abi.entries.filter((entry) => entry !== provider) },
      }),
    ).toThrow(/reference object program/);
    for (const contract of [
      { ...provider.contract, params: [irVal({ kind: "f64" })] },
      {
        ...provider.contract,
        ref: { kind: "func", name: "misleading", binding: { kind: "runtime", symbol: "invented" } },
      },
    ])
      expect(() =>
        assertPreparedIrProgram({
          ...program,
          abi: { entries: program.abi.entries.map((entry) => (entry === provider ? { ...entry, contract } : entry)) },
        } as PreparedIrProgram),
      ).toThrow(/reference object program/);
    const { objectReferences: _, ...orphan } = program;
    expect(() => assertPreparedIrProgram(orphan)).toThrow(/cannot outlive its plan/);
  });
  it("rejects an incomplete raw plan before optimizing the input", () => {
    const captured = prepareIrProgramSources(input());
    if (captured.kind !== "prepared") throw Error(JSON.stringify(captured));
    const typed = captureTypedIrProgramInput(captured),
      plan = deriveObjectReferencePlan(typed);
    const options = {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "on" as const,
        ownership: true,
        escape: true,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: false,
      },
    };
    expect(() => prepareTypedIrProgram({ ...typed, objectReferences: { ...plan, shapes: [] } }, options)).toThrow(
      /complete current logical type population/,
    );
    expect(() => prepareTypedIrProgram({ ...typed, objectReferences: undefined }, options)).toThrow(
      /complete current logical type population/,
    );
    expect(
      typed.ir.functions
        .flatMap((fn) => fn.blocks.flatMap((block) => block.instrs))
        .some((row) => row.kind === "object.get"),
    ).toBe(true);
  });
  it("rejects undeclared and shape-incompatible callees before the optimizer runs", () => {
    const captured = prepareIrProgramSources(
      input(
        "function read(input:{n:number}):number{return input.n;}export function run(input:{n:number}):number{return read(input);}",
      ),
    );
    if (captured.kind !== "prepared") throw Error(JSON.stringify(captured));
    const typed = captureTypedIrProgramInput(captured);
    const run = typed.ir.functions.find((fn) => fn.name === "run")!,
      read = typed.ir.functions.find((fn) => fn.name === "read")!;
    const options = {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "on" as const,
        ownership: true,
        escape: true,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: false,
      },
    };
    for (const kind of ["missing", "argument-shape", "result-shape"]) {
      const ir = {
        ...typed.ir,
        functions: typed.ir.functions.map((fn) => {
          if (kind === "argument-shape" && fn === read)
            return {
              ...fn,
              params: fn.params.map((param) => ({
                ...param,
                type: {
                  kind: "object" as const,
                  shape: {
                    fields: [
                      { name: "n", type: irVal({ kind: "f64" }) },
                      { name: "other", type: irVal({ kind: "f64" }) },
                    ],
                  },
                },
              })),
            };
          if (fn !== run) return fn;
          return {
            ...fn,
            blocks: fn.blocks.map((block) => ({
              ...block,
              instrs: block.instrs.map((row) =>
                row.kind === "call"
                  ? {
                      ...row,
                      ...(kind === "missing"
                        ? {
                            target: irUnitFuncRef({
                              name: read.name,
                              unitId: (read.unitId + ":foreign") as typeof read.unitId,
                            }),
                          }
                        : {}),
                      ...(kind === "result-shape" ? { resultType: irVal({ kind: "i32" }) } : {}),
                    }
                  : row,
              ),
            })),
          };
        }),
      };
      const packet = { ...typed, ir },
        plan = deriveObjectReferencePlan(packet),
        counters = createGvnCounters();
      expect(() => prepareTypedIrProgram({ ...packet, objectReferences: plan }, options, counters)).toThrow(
        kind === "missing" ? /body|reference object call closure/ : /reference object call closure/,
      );
      expect(counters.functions).toBe(0);
    }
  });
  it("does not silently discard or alter the plan during codec authentication", () => {
    const program = prepare(),
      changed = { ...program, objectReferences: { ...program.objectReferences!, shapes: [] } };
    expect(() => decodePreparedIrProgram(encodePreparedIrProgram(changed))).toThrow(/reference object program/);
    const provider = program.abi.entries.find(
      (entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "support",
    )!;
    const missing = { ...program, abi: { entries: program.abi.entries.filter((entry) => entry !== provider) } };
    expect(() => decodePreparedIrProgram(encodePreparedIrProgram(missing))).toThrow();
  });
});
