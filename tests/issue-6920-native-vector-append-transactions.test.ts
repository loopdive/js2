// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitVectorElementAccess } from "../src/ir/backend/vector-element-access.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import type { IrVecBackendLowering } from "../src/ir/backend/handles.js";
import { resolveIrVecRepresentation } from "../src/ir/backend/vector-representation.js";
import type { BackendEmitter } from "../src/ir/backend/emitter.js";
import type { IrInstr, IrValueId } from "../src/ir/core/nodes.js";
import { planLinearVectorLayout } from "../src/ir/analysis/linear-memory-plan.js";
import type { FunctionReservation } from "../src/wasm/physical/module-reservations.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { describeLinearBumpArena, buildLinearBumpAllocationBody } from "../src/wasm/physical/linear-bump-allocation.js";
import {
  describeLinearArrayConstructor,
  buildLinearArrayConstructorBody,
} from "../src/wasm/physical/linear-array-constructor.js";
import { buildArrayForwardingResolverBody } from "../src/codegen-linear/runtime/arrays/forwarding-resolver.js";
import { LINEAR_ARRAY_FORWARDING } from "../src/shared/contracts/linear-memory-layout.js";
import {
  describeLinearNumericVectorAppend,
  buildLinearNumericVectorAppendBody,
} from "../src/wasm/physical/linear-vector-append.js";
import {
  describeGcNumericVectorAppend,
  buildGcNumericVectorAppendBody,
} from "../src/wasm/physical/gc-vector-append.js";
import {
  createVectorBaseType,
  createVectorBackingArrayType,
  createVectorCarrierType,
} from "../src/runtime/wasmgc/values/vector-grow-store.js";
const i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
const get = (index: number): Instr => ({ op: "local.get", index });
const integer = (value: number): Instr => ({ op: "i32.const", value });

// These terminal-access fixtures test actual execution; they confer no Program admission authority.
function rawAccessPack(
  tx: PhysicalModuleReservations,
  ref: ValType,
  layout: IrVecBackendLowering,
  append: FunctionReservation,
  emitter: BackendEmitter<Instr[]>,
) {
  // #6920: the access receives the representation resolved for the emitter's backend.
  const representation = resolveIrVecRepresentation(
    {
      backend: emitter.backend,
      type: { kind: "vec", elementType: { kind: "val", val: f64 }, nullable: false },
      elementValType: f64,
      resolver: {
        resolveType: () => {
          throw new Error("raw access fixture has no persisted layout");
        },
        resolveVecForElement: () => layout,
      },
      where: "raw-access",
    },
    "operation",
  );
  if (!representation) throw new Error("raw access fixture has no vector representation");
  const effects = tx.reserveGlobal("raw:effects", "rawEffects", i32, true);
  const functions = ["getAfterIndex", "setAfterRhs", "compoundAfterRhs", "readPlain", "readEmpty"].map((name) =>
    tx.reserveFunction(`raw:${name}`, name, { params: [ref, i32, f64], results: [f64] }),
  );
  return {
    functions,
    fill: () => {
      tx.fillGlobal(effects, [integer(0)]);
      for (const fn of functions) {
        const body: Instr[] = [],
          locals: { name: string; type: ValType }[] = [];
        const scratch = (type: ValType) => {
          const index = 3 + locals.length;
          locals.push({ name: `scratch${index}`, type });
          return index;
        };
        let old: number | undefined;
        const mark = (digit: number, out: Instr[]) =>
          out.push(
            { op: "global.get", index: tx.physicalIndex(effects) },
            integer(10),
            { op: "i32.mul" },
            integer(digit),
            { op: "i32.add" },
            { op: "global.set", index: tx.physicalIndex(effects) },
          );
        const grow = (out: Instr[]) => {
          out.push(get(0), get(0));
          emitter.emitVecLen(layout as never, out);
          out.push(get(2), { op: "call", funcIdx: tx.physicalIndex(append) });
        };
        const emitValue = (value: IrValueId, out: Instr[]) => {
          mark(Number(value) + 1, out);
          if (value === 0) out.push(get(0));
          else if (value === 1) {
            if (fn.object.name === "getAfterIndex") grow(out);
            out.push(get(1));
          } else {
            grow(out);
            out.push(get(0));
            emitter.emitVecLen(layout as never, out);
            out.push({ op: "f64.convert_i32_u" });
            if (old !== undefined) out.push(get(old), { op: "f64.add" });
          }
        };
        const access = (kind: "vec.get" | "vec.set") => {
          const instr = {
            kind,
            result: null,
            resultType: null,
            vec: 0 as IrValueId,
            index: 1 as IrValueId,
            ...(kind === "vec.set" ? { newValue: 2 as IrValueId } : {}),
          } as Extract<IrInstr, { kind: "vec.get" | "vec.set" }>;
          emitVectorElementAccess(
            instr,
            representation,
            {
              emitter,
              emitValue,
              construction: undefined,
              requestedCapacity: fn.object.name === "readEmpty" ? 0 : 2,
              receiverScratch: () => scratch(ref),
              indexScratch: () => scratch(i32),
              elementScratch: (type) => scratch(type),
            },
            body,
          );
        };
        if (fn.object.name === "compoundAfterRhs") {
          access("vec.get");
          old = scratch(f64);
          body.push({ op: "local.set", index: old });
        }
        const store = fn.object.name === "setAfterRhs" || fn.object.name === "compoundAfterRhs";
        access(store ? "vec.set" : "vec.get");
        if (store) {
          body.push(get(0));
          emitter.emitVecDataPtr(layout as never, body);
          body.push(get(1));
          emitter.emitElemGet(layout as never, body);
        }
        tx.fillFunction(fn, { locals, body });
        tx.defineExport(`export:${fn.key}`, fn.object.name, fn);
      }
      tx.defineExport("export:rawEffects", "rawEffects", effects);
    },
  };
}

// Physical recipe execution only. These modules do not confer native Program or source admission authority.
function linear(allocatorReturn?: number, raw = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const arena = describeLinearBumpArena();
  const memory = tx.reserveMemory("memory", arena.memory);
  const heap = tx.reserveGlobal("heap", "heap", i32, true);
  const malloc = tx.reserveFunction("malloc", "malloc", arena.allocatorType);
  const construction = describeLinearArrayConstructor();
  const make = tx.reserveFunction("make", "make", construction);
  const resolve = tx.reserveFunction("resolve", "resolve", { params: [i32], results: [i32] });
  const recipe = describeLinearNumericVectorAppend();
  const append = tx.reserveFunction("append", "append", recipe);
  const rawLayout: IrVecBackendLowering = {
    valueType: i32,
    elementValType: f64,
    linearMemory: {
      layout: planLinearVectorLayout({ kind: "val", val: f64 }),
      allocate: { family: "vector", operation: "allocate", allocationClass: "arena", elementStorage: "f64" },
      initializeElement: {
        family: "vector",
        operation: "initialize-element",
        allocationClass: "arena",
        elementStorage: "f64",
      },
    },
  };
  const accesses = raw
    ? rawAccessPack(
        tx,
        i32,
        rawLayout,
        append,
        new LinearEmitter({
          resolveRuntimeOperation: () => tx.physicalIndex(resolve),
        }),
      )
    : undefined;
  tx.freezeReservations();
  tx.fillGlobal(heap, arena.heapPointer.init);
  tx.fillFunction(malloc, {
    locals: arena.allocatorLocals,
    body:
      allocatorReturn === undefined
        ? buildLinearBumpAllocationBody(tx.physicalIndex(heap))
        : [integer(allocatorReturn)],
  });
  tx.fillFunction(make, {
    locals: construction.locals,
    body: buildLinearArrayConstructorBody(tx.physicalIndex(malloc)),
  });
  tx.fillFunction(resolve, { locals: [], body: buildArrayForwardingResolverBody(LINEAR_ARRAY_FORWARDING) });
  tx.fillFunction(append, {
    locals: recipe.locals,
    body: buildLinearNumericVectorAppendBody(tx.physicalIndex(malloc), tx.physicalIndex(resolve)),
  });
  for (const fn of [make, resolve, append, malloc]) tx.defineExport(`export:${fn.key}`, fn.object.name, fn);
  tx.defineExport("heap-export", "heap", heap);
  tx.defineExport("memory-export", "memory", memory);
  accesses?.fill();
  tx.seal();
  const binary = Uint8Array.from(emitBinary(module));
  expect(WebAssembly.validate(binary)).toBe(true);
  const wasm = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  const exports = new WebAssembly.Instance(wasm, {}).exports as unknown as {
    make(n: number): number;
    resolve(p: number): number;
    append(p: number, i: number, n: number): void;
    malloc(n: number): number;
    heap: WebAssembly.Global;
    memory: WebAssembly.Memory;
    getAfterIndex(p: number, i: number, v: number): number;
    setAfterRhs(p: number, i: number, v: number): number;
    compoundAfterRhs(p: number, i: number, v: number): number;
    readPlain(p: number, i: number, v: number): number;
    readEmpty(p: number, i: number, v: number): number;
    rawEffects: WebAssembly.Global;
  };
  const view = () => new DataView(exports.memory.buffer);
  const current = (p: number) => exports.resolve(p);
  return {
    exports,
    make: exports.make,
    append: exports.append,
    current,
    view,
    length: (p: number) => view().getUint32(current(p) + 8, true),
    capacity: (p: number) => view().getUint32(current(p) + 12, true),
    value: (p: number, i: number) => view().getFloat64(current(p) + 16 + i * 8, true),
    bits: (p: number, i: number) => view().getBigUint64(current(p) + 16 + i * 8, true),
    setLength: (p: number, n: number) => view().setUint32(current(p) + 8, n, true),
    setBits: (p: number, i: number, n: bigint) => view().setBigUint64(current(p) + 16 + i * 8, n, true),
  };
}
function gc(raw = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const base = tx.reserveType("base", createVectorBaseType());
  const array = tx.reserveType("array", createVectorBackingArrayType("f64-array", f64));
  const carrier = tx.reserveType(
    "carrier",
    createVectorCarrierType({ name: "f64-vector", baseTypeIndex: base.typeIndex, arrayTypeIndex: array.typeIndex }),
  );
  const ref: ValType = { kind: "ref", typeIdx: carrier.typeIndex };
  const recipe = describeGcNumericVectorAppend(carrier.typeIndex, array.typeIndex);
  const make = tx.reserveFunction("make", "make", { params: [i32], results: [ref] });
  const append = tx.reserveFunction("append", "append", recipe);
  const length = tx.reserveFunction("length", "length", { params: [ref], results: [i32] });
  const capacity = tx.reserveFunction("capacity", "capacity", { params: [ref], results: [i32] });
  const value = tx.reserveFunction("value", "value", { params: [ref, i32], results: [f64] });
  const bits = tx.reserveFunction("bits", "bits", { params: [ref, i32], results: [{ kind: "i64" }] });
  const setLength = tx.reserveFunction("setLength", "setLength", { params: [ref, i32], results: [] });
  const setBits = tx.reserveFunction("setBits", "setBits", { params: [ref, i32, { kind: "i64" }], results: [] });
  const accesses = raw
    ? rawAccessPack(
        tx,
        ref,
        {
          vecStructTypeIdx: carrier.typeIndex,
          arrayTypeIdx: array.typeIndex,
          elementValType: f64,
          lengthFieldIdx: 0,
          dataFieldIdx: 1,
        },
        append,
        new WasmGcEmitter(),
      )
    : undefined;
  tx.freezeReservations();
  tx.fillFunction(make, {
    locals: [],
    body: [
      integer(0),
      get(0),
      { op: "array.new_default", typeIdx: array.typeIndex },
      { op: "struct.new", typeIdx: carrier.typeIndex },
    ],
  });
  tx.fillFunction(append, {
    locals: recipe.locals,
    body: buildGcNumericVectorAppendBody(carrier.typeIndex, array.typeIndex),
  });
  const data: Instr[] = [get(0), { op: "struct.get", typeIdx: carrier.typeIndex, fieldIdx: 1 }];
  tx.fillFunction(length, {
    locals: [],
    body: [get(0), { op: "struct.get", typeIdx: carrier.typeIndex, fieldIdx: 0 }],
  });
  tx.fillFunction(capacity, { locals: [], body: [...data, { op: "array.len" }] });
  tx.fillFunction(value, { locals: [], body: [...data, get(1), { op: "array.get", typeIdx: array.typeIndex }] });
  tx.fillFunction(bits, {
    locals: [],
    body: [...data, get(1), { op: "array.get", typeIdx: array.typeIndex }, { op: "i64.reinterpret_f64" }],
  });
  tx.fillFunction(setLength, {
    locals: [],
    body: [get(0), get(1), { op: "struct.set", typeIdx: carrier.typeIndex, fieldIdx: 0 }],
  });
  tx.fillFunction(setBits, {
    locals: [],
    body: [...data, get(1), get(2), { op: "f64.reinterpret_i64" }, { op: "array.set", typeIdx: array.typeIndex }],
  });
  for (const fn of [make, append, length, capacity, value, bits, setLength, setBits])
    tx.defineExport(`export:${fn.key}`, fn.object.name, fn);
  accesses?.fill();
  tx.seal();
  const binary = Uint8Array.from(emitBinary(module));
  expect(WebAssembly.validate(binary)).toBe(true);
  const wasm = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  return new WebAssembly.Instance(wasm, {}).exports as unknown as {
    make(n: number): object;
    append(p: object, i: number, n: number): void;
    length(p: object): number;
    capacity(p: object): number;
    value(p: object, i: number): number;
    bits(p: object, i: number): bigint;
    setLength(p: object, n: number): void;
    setBits(p: object, i: number, n: bigint): void;
    getAfterIndex(p: object, i: number, v: number): number;
    setAfterRhs(p: object, i: number, v: number): number;
    compoundAfterRhs(p: object, i: number, v: number): number;
    readPlain(p: object, i: number, v: number): number;
    readEmpty(p: object, i: number, v: number): number;
    rawEffects: WebAssembly.Global;
  };
}
for (const backend of ["linear", "wasmgc"] as const) {
  const instance = () => (backend === "linear" ? linear() : gc());
  describe(`${backend} checked native numeric append physical transaction`, () => {
    for (const capacity of [0, 2, 16])
      it(`preserves two aliases and 44 values through growth from capacity ${capacity}`, () => {
        const api = instance(),
          a = api.make(capacity),
          b = a;
        for (let i = 0; i < 44; i++) {
          api.append(a as never, i, i + 0.25);
          expect(api.length(b as never)).toBe(i + 1);
          expect(api.value(b as never, i)).toBe(i + 0.25);
          for (let j = 0; j <= i; j++) expect(api.value(a as never, j)).toBe(j + 0.25);
        }
        expect(api.capacity(a as never)).toBeGreaterThanOrEqual(44);
      });
    it("preserves existing NaN payload bits across copying and appended negative zero", () => {
      const api = instance(),
        p = api.make(2),
        payload = 0x7ff8000000000137n;
      api.setBits(p as never, 0, payload);
      api.setBits(p as never, 1, 0x8000000000000000n);
      api.setLength(p as never, 2);
      api.append(p as never, 2, -0);
      expect(BigInt.asUintN(64, api.bits(p as never, 0))).toBe(payload);
      expect(BigInt.asUintN(64, api.bits(p as never, 1))).toBe(0x8000000000000000n);
      expect(Object.is(api.value(p as never, 2), -0)).toBe(true);
    });
    for (const index of [-1, 0, 3, 0x7fffffff])
      it(`rejects wrong supplied index ${index} before mutation`, () => {
        const api = instance(),
          p = api.make(2);
        api.append(p as never, 0, 2);
        api.append(p as never, 1, 5);
        const before = [
          api.length(p as never),
          api.capacity(p as never),
          api.value(p as never, 0),
          api.value(p as never, 1),
        ];
        expect(() => api.append(p as never, index, 11)).toThrow(WebAssembly.RuntimeError);
        expect([
          api.length(p as never),
          api.capacity(p as never),
          api.value(p as never, 0),
          api.value(p as never, 1),
        ]).toEqual(before);
      });
    it("rejects injected length beyond capacity before mutation", () => {
      const api = instance(),
        p = api.make(2);
      api.setLength(p as never, 3);
      expect(() => api.append(p as never, 3, 11)).toThrow(WebAssembly.RuntimeError);
      expect(api.length(p as never)).toBe(3);
      expect(api.capacity(p as never)).toBe(2);
      expect(api.value(p as never, 0)).toBe(0);
    });
  });
}
it("rejects a nullable GC call before touching a carrier", () => {
  const api = gc();
  expect(() => Reflect.apply(api.append, undefined, [null, 0, 11])).toThrow(WebAssembly.RuntimeError);
});
describe("Linear append allocator and forwarding transaction", () => {
  for (const tag of [0, 2, 0xffffffff])
    it(`refuses contradictory resolved tag ${tag} before mutation`, () => {
      const api = linear(),
        p = api.make(2);
      api.view().setUint32(p, tag, true);
      const before = Array.from(new Uint8Array(api.exports.memory.buffer, p, 32));
      expect(() => api.append(p, 0, 11)).toThrow(WebAssembly.RuntimeError);
      expect(Array.from(new Uint8Array(api.exports.memory.buffer, p, 32))).toEqual(before);
    });
  it("refuses an unaddressable old backing range before mutation", () => {
    const api = linear(),
      p = api.make(2);
    api.view().setUint32(p + 12, 8192, true);
    const before = Array.from(new Uint8Array(api.exports.memory.buffer));
    expect(() => api.append(p, 0, 11)).toThrow(WebAssembly.RuntimeError);
    expect(Array.from(new Uint8Array(api.exports.memory.buffer))).toEqual(before);
  });

  it("publishes a complete forwarding record and resolves stale original handles", () => {
    const api = linear(),
      p = api.make(2);
    api.append(p, 0, 2);
    api.append(p, 1, 5);
    api.append(p, 2, 11);
    expect(api.view().getUint32(p, true)).toBe(LINEAR_ARRAY_FORWARDING.tag);
    expect(api.view().getUint32(p + 4, true)).toBe(api.current(p));
    expect(api.current(p)).toBeGreaterThan(p);
    expect(api.value(p, 0)).toBe(2);
    expect(api.value(p, 1)).toBe(5);
    expect(api.value(p, 2)).toBe(11);
  });
  it("preserves vector, forwarding, heap and memory on actual default memory.grow failure", () => {
    const api = linear(),
      p = api.make(16);
    for (let i = 0; i < 16; i++) api.append(p, i, i + 0.5);
    const e = api.exports;
    e.malloc(256 * 65536 - Number(e.heap.value) - 8);
    expect(e.memory.buffer.byteLength).toBe(256 * 65536);
    const before = {
      bytes: Array.from(new Uint8Array(e.memory.buffer, p, 16 + 16 * 8)),
      heap: Number(e.heap.value),
      size: e.memory.buffer.byteLength,
    };
    expect(() => api.append(p, 16, 99)).toThrow(WebAssembly.RuntimeError);
    expect({
      bytes: Array.from(new Uint8Array(e.memory.buffer, p, 16 + 16 * 8)),
      heap: Number(e.heap.value),
      size: e.memory.buffer.byteLength,
    }).toEqual(before);
    expect(api.current(p)).toBe(p);
    expect(api.length(p)).toBe(16);
  });
  for (const returned of [1024, 1025, 0xfffffff8])
    it(`refuses invalid allocator endpoint ${returned >>> 0} before vector publication`, () => {
      const api = linear(returned),
        p = 2048;
      api.view().setUint32(p, 1, true);
      api.view().setUint32(p + 8, 2, true);
      api.view().setUint32(p + 12, 2, true);
      api.view().setFloat64(p + 16, 2, true);
      api.view().setFloat64(p + 24, 5, true);
      const before = Array.from(new Uint8Array(api.exports.memory.buffer, p, 32));
      expect(() => api.append(p, 2, 11)).toThrow(WebAssembly.RuntimeError);
      expect(Array.from(new Uint8Array(api.exports.memory.buffer, p, 32))).toEqual(before);
    });
  for (const capacity of [0x1ffffffe, 0xffffffff])
    it(`refuses overflowing injected capacity ${capacity}`, () => {
      const api = linear(),
        p = api.make(2);
      api.view().setUint32(p + 12, capacity, true);
      const before = Array.from(new Uint8Array(api.exports.memory.buffer, p, 32));
      expect(() => api.append(p, 0, 11)).toThrow(WebAssembly.RuntimeError);
      expect(Array.from(new Uint8Array(api.exports.memory.buffer, p, 32))).toEqual(before);
    });
  for (const offset of [0, 4])
    it(`refuses null or misaligned receiver (${offset}) before publication`, () => {
      const api = linear(),
        p = offset === 0 ? 0 : api.make(2) + offset;
      const before = Array.from(new Uint8Array(api.exports.memory.buffer));
      expect(() => api.append(p, 0, 11)).toThrow(WebAssembly.RuntimeError);
      expect(Array.from(new Uint8Array(api.exports.memory.buffer))).toEqual(before);
    });
});

for (const backend of ["linear", "wasmgc"] as const)
  it(`${backend} refreshes both backing and extent after index/RHS effects, preserves compound old value and rejects padding`, () => {
    const api = backend === "linear" ? linear(undefined, true).exports : gc(true);
    const filled = () => {
      const p = api.make(2);
      for (let i = 0; i < 16; i++) api.append(p as never, i, i === 0 ? 2 : i);
      return p;
    };
    let p = filled();
    api.rawEffects.value = 0;
    expect(api.getAfterIndex(p as never, 16, 99)).toBe(99);
    expect(api.rawEffects.value).toBe(12);
    expect(api.readPlain(p as never, 16, 0)).toBe(99);
    for (const index of [17, 31, -1])
      expect(() => api.readPlain(p as never, index, 0)).toThrow(WebAssembly.RuntimeError);
    p = filled();
    api.rawEffects.value = 0;
    expect(api.setAfterRhs(p as never, 0, 99)).toBe(17);
    expect(api.rawEffects.value).toBe(123);
    expect(api.readPlain(p as never, 16, 0)).toBe(99);
    p = filled();
    api.rawEffects.value = 0;
    expect(api.compoundAfterRhs(p as never, 0, 99)).toBe(19);
    expect(api.rawEffects.value).toBe(12123);
    const empty = api.make(0);
    expect(() => api.readEmpty(empty as never, 0, 0)).toThrow(WebAssembly.RuntimeError);
    api.append(empty as never, 0, 73);
    expect(api.readEmpty(empty as never, 0, 0)).toBe(73);
  });
