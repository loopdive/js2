// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { emitBinary } from "../src/emit/binary.js";

// Integer literal indices exercise typed vec.get, rather than admitting new
// source-level fractional indexing semantics. Native allocation capacity can
// exceed logical length: memory address validity is not element validity.
const source = `
export function first(): number { const values = [11, 22]; return values[0]; }
export function last(): number { const values = [11, 22]; return values[1]; }
export function atLength(): number { const values = [11, 22]; return values[2]; }
export function negative(): number { const values = [11, 22]; return values[-1]; }
`;
let prepared: PreparedIrProgram;
beforeAll(() => {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "linear", target: "standalone" },
    runtimePolicies: [
      { backend: "linear", target: "standalone" },
      { backend: "linear", target: "wasi" },
      { backend: "wasmgc", target: "standalone" },
      { backend: "wasmgc", target: "wasi" },
    ],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  prepared = result.program;
  let gets = 0;
  for (const fn of prepared.ir.functions)
    for (const block of fn.blocks)
      for (const instr of block.instrs)
        forEachInstrDeep(instr, (nested) => {
          if (nested.kind === "vec.get") gets++;
        });
  expect(gets).toBe(4);
});
for (const backend of ["linear", "wasmgc"] as const)
  for (const target of ["standalone", "wasi"] as const)
    for (const replay of [false, true])
      it(`${backend}/${target} source safe-read preservation, codec=${replay}`, async () => {
        const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(prepared)) : prepared;
        const accepted = acceptPreparedIrProgram(program, {
          backend,
          target,
          moduleName: "vector-bounds",
          sourceMap: false,
          utf8Storage: false,
          sharedExceptionTag: false,
        });
        expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
        if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
        const emitted = emitAcceptedIrProgram(accepted);
        const binary = new Uint8Array(emitBinary(emitted.module));
        expect(WebAssembly.validate(binary)).toBe(true);
        expect(WebAssembly.Module.imports(new WebAssembly.Module(binary))).toEqual([]);
        const { instance } = await WebAssembly.instantiate(binary, {});
        const call = (name: string) => Reflect.apply(instance.exports[name] as Function, undefined, []);
        expect(call("first")).toBe(11);
        expect(call("last")).toBe(22);
        expect(call("atLength")).toBeNaN();
        expect(call("negative")).toBeNaN();
      });

// Direct IR access is a separate contract from the frontend safe-read wrapper.
// Use real runtime construction/forwarding, with no direct source generator.
import { IrFunctionBuilder, irVal, planLinearVectorLayout, defaultOperationsForLayout } from "../src/ir/index.js";
import { lowerIrFunctionToWasm } from "../src/ir/lower.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import type { IrLowerResolver } from "../src/ir/lower.js";
import type { IrVectorLowering } from "../src/ir/backend/handles.js";
import { createEmptyModule, type FuncTypeDef } from "../src/ir/types.js";
import { addRuntime, addArrayRuntime, addLinearIrVecRuntime } from "../src/codegen-linear/runtime.js";
import { irUnitFuncRef, irCallableBindingKey } from "../src/ir/callable-bindings.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

for (const backend of ["linear", "wasmgc"] as const) {
  for (const empty of [false, true]) {
    for (const access of ["get", "set"] as const) {
      it(`${backend} terminal typed get/set use requested backing extent, empty=${empty}, access=${access}`, async () => {
        const mod = createEmptyModule();
        const f64 = irVal({ kind: "f64" });
        const i32 = irVal({ kind: "i32" });
        const vecType = { kind: "vec" as const, elementType: f64, nullable: false };
        const functionIndex = (name: string) => {
          const local = mod.functions.findIndex((fn) => fn.name === name);
          if (local < 0) throw Error(`missing real runtime ${name}`);
          return mod.imports.filter((entry) => entry.desc.kind === "func").length + local;
        };
        let layout: IrVectorLowering;
        if (backend === "linear") {
          addRuntime(mod);
          addArrayRuntime(mod);
          addLinearIrVecRuntime(mod);
          const memoryLayout = planLinearVectorLayout(f64);
          const operations = defaultOperationsForLayout(memoryLayout);
          layout = {
            elementValType: { kind: "f64" },
            linearMemory: {
              layout: memoryLayout,
              allocate: operations.find((op) => op.family === "vector" && op.operation === "allocate")!,
              initializeElement: operations.find(
                (op) => op.family === "vector" && op.operation === "initialize-element",
              )!,
            },
          };
        } else {
          mod.types.push({ kind: "array", name: "elements", element: { kind: "f64" }, mutable: true });
          mod.types.push({
            kind: "struct",
            name: "vector",
            fields: [
              { name: "length", type: { kind: "i32" }, mutable: true },
              { name: "data", type: { kind: "ref", typeIdx: 0 }, mutable: true },
            ],
          });
          layout = {
            vecStructTypeIdx: 1,
            lengthFieldIdx: 0,
            dataFieldIdx: 1,
            arrayTypeIdx: 0,
            elementValType: { kind: "f64" },
          };
        }
        const ids = createTestIrFunctionIdentityFactory(`vector-bounds-${backend}`);
        const effects = mod.globals.length;
        mod.globals.push({
          name: "operandEffects",
          type: { kind: "i32" },
          mutable: true,
          init: [{ op: "i32.const", value: 0 }],
        });
        mod.exports.push({ name: "operandEffects", desc: { kind: "global", index: effects } });
        const callBindings = new Map<string, number>();
        const effectRefs = [];
        for (const [name, type, digit] of [
          ["indexEffect", { kind: "i32" }, 1],
          ["valueEffect", { kind: "f64" }, 2],
        ] as const) {
          const ref = irUnitFuncRef(ids.next(name));
          effectRefs.push(ref);
          const typeIdx = mod.types.length;
          mod.types.push({ kind: "func", params: [type], results: [type] });
          mod.functions.push({
            name,
            typeIdx,
            exported: false,
            locals: [],
            body: [
              { op: "global.get", index: effects },
              { op: "i32.const", value: 10 },
              { op: "i32.mul" },
              { op: "i32.const", value: digit },
              { op: "i32.add" },
              { op: "global.set", index: effects },
              { op: "local.get", index: 0 },
            ],
          });
          callBindings.set(irCallableBindingKey(ref.binding!), functionIndex(name));
        }
        const resolver: IrLowerResolver = {
          vectorRepresentation: backend,
          resolveFunc: (ref) => {
            const index = callBindings.get(irCallableBindingKey(ref.binding!));
            if (index === undefined) throw Error("unexpected function binding");
            return index;
          },
          resolveGlobal: () => {
            throw Error("unexpected global binding");
          },
          resolveType: () => {
            throw Error("unexpected persisted type binding");
          },
          resolveVecForElement: () => layout,
          internFuncType: (type: FuncTypeDef) => {
            const index = mod.types.length;
            mod.types.push(type);
            return index;
          },
        };
        let runtimeResolutions = 0;
        const emitter =
          backend === "linear"
            ? new LinearEmitter({
                resolveRuntimeOperation: (op) => {
                  runtimeResolutions++;
                  if (op.family !== "vector") throw Error("unexpected runtime family");
                  const names = {
                    allocate: "__arr_new",
                    "initialize-element": "__linear_ir_vec_init_f64",
                    "resolve-forwarding": "__arr_resolve",
                  };
                  if (!(op.operation in names)) throw Error("unexpected runtime operation");
                  return functionIndex(names[op.operation as keyof typeof names]);
                },
              })
            : new WasmGcEmitter();
        for (const write of [false, true]) {
          const name = write ? "writeFixed" : "readFixed";
          const b = new IrFunctionBuilder(ids.next(name), [f64], true);
          const index = b.addParam("index", i32);
          const newValue = write ? b.addParam("newValue", f64) : null;
          b.openBlock();
          const elements = empty
            ? []
            : [b.emitConst({ kind: "f64", value: 11 }, f64), b.emitConst({ kind: "f64", value: 22 }, f64)];
          const vec = b.emitVecNewFixed(elements, f64, vecType, empty ? 4 : 2);
          const observedIndex = b.emitCall(effectRefs[0]!, [index], i32)!;
          if (newValue !== null) {
            const observedValue = b.emitCall(effectRefs[1]!, [newValue], f64)!;
            b.emitVecSet(vec, observedIndex, observedValue);
          }
          const readIndex = write ? b.emitConst({ kind: "i32", value: 0 }, i32) : observedIndex;
          const value = b.emitVecGet(vec, readIndex, f64);
          b.terminate({ kind: "return", values: [value] });
          const lowered = lowerIrFunctionToWasm(b.finish(), resolver, emitter).func;
          mod.functions.push(lowered);
          mod.exports.push({ name, desc: { kind: "func", index: functionIndex(name) } });
        }
        // Two constructors and three accesses request their real bindings once.
        if (backend === "linear") expect(runtimeResolutions).toBe(7);
        const binary = new Uint8Array(emitBinary(mod));
        expect(WebAssembly.validate(binary)).toBe(true);
        const { instance } = await WebAssembly.instantiate(binary, {});
        const read = instance.exports.readFixed as (index: number) => number;
        const write = instance.exports.writeFixed as (index: number, value: number) => number;
        expect(read(0)).toBe(empty ? 0 : 11);
        expect(read(1)).toBe(empty ? 0 : 22);
        if (empty) {
          expect(read(3)).toBe(0);
          expect(write(3, 99)).toBe(0);
        }
        expect(write(0, 99)).toBe(99);
        const counter = instance.exports.operandEffects as WebAssembly.Global;
        for (const index of [empty ? 4 : 2, 15, -1, -2147483648]) {
          counter.value = 0;
          expect(() => (access === "get" ? read(index) : write(index, 99))).toThrow(WebAssembly.RuntimeError);
          expect(counter.value).toBe(access === "get" ? 1 : 12);
        }
      });
    }
  }
}

it("retains GC refusal for nonempty fixed constructors with greater requested capacity", () => {
  const f64 = irVal({ kind: "f64" });
  const ids = createTestIrFunctionIdentityFactory("vector-bounds-nonempty-capacity");
  const b = new IrFunctionBuilder(ids.next("nonemptyCapacity"), [f64], true);
  b.openBlock();
  const values = [11, 22].map((value) => b.emitConst({ kind: "f64", value }, f64));
  const vec = b.emitVecNewFixed(values, f64, { kind: "vec", elementType: f64, nullable: false }, 4);
  const index = b.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" }));
  const value = b.emitVecGet(vec, index, f64);
  b.terminate({ kind: "return", values: [value] });
  const resolver: IrLowerResolver = {
    vectorRepresentation: "wasmgc",
    resolveFunc: () => {
      throw Error("unexpected function");
    },
    resolveGlobal: () => {
      throw Error("unexpected global");
    },
    resolveType: () => {
      throw Error("unexpected type");
    },
    resolveVecForElement: () => ({
      vecStructTypeIdx: 1,
      lengthFieldIdx: 0,
      dataFieldIdx: 1,
      arrayTypeIdx: 0,
      elementValType: { kind: "f64" },
    }),
    internFuncType: () => 2,
  };
  expect(() => lowerIrFunctionToWasm(b.finish(), resolver, new WasmGcEmitter())).toThrow(
    "WasmGcEmitter: vec capacity 4 unsupported for logical length 2",
  );
});
