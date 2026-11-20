// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as bodies from "../src/runtime/wasmgc/values/object-key-bodies.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import * as binaryEmitter from "../src/emit/binary.js";
import { mintDefinedFunc, commitDefinedFuncOrdinal, appendDefinedFunc } from "../src/wasm/physical/function-handles.js";
import { internFunctionType } from "../src/wasm/physical/function-types.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
function resources(symbols: boolean, cached: boolean, nativeFirst: boolean) {
  return {
    anyStrTypeIdx: 10,
    nativeStrTypeIdx: 11,
    nativeStrRef: { kind: "ref", typeIdx: 11 } as ValType,
    strDataTypeIdx: 12,
    hashedStrTypeIdx: cached ? 13 : -1,
    symbolTypeIdx: symbols ? 14 : -1,
    symbolKeysEnabled: symbols,
    nativeFirst,
    strFlattenIdx: 20,
    strEqualsIdx: 21,
    objectTypeIdx: 30,
    propMapTypeIdx: 31,
    propEntryTypeIdx: 32,
    keyEqualsIdx: 22,
    objHashIdx: 23,
    tombstoneFlag: 0x80,
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => setImmediate(resolve));
});

describe("object key bodies", () => {
  it("retains exact body identity when key coercion is absent", () => {
    const body: Instr[] = [{ op: "local.get", index: 4 }];
    expect(bodies.prependObjectKeyCoercion(undefined, 1, body)).toBe(body);
    expect(bodies.prependObjectKeyCoercion(24, 1, body)[3]).toBe(body[0]);
  });
  it("shares no emitted instructions across independent builds", () => {
    const instructions = (value: unknown, found = new Set<object>()): Set<object> => {
      if (value && typeof value === "object") {
        if ("op" in value) {
          expect(found.has(value)).toBe(false);
          found.add(value);
        }
        for (const child of Object.values(value)) instructions(child, found);
      }
      return found;
    };
    const r = resources(true, true, true);
    const first = instructions(bodies.buildObjectFindBody(r));
    const second = instructions(bodies.buildObjectFindBody(r));
    expect(first.size).toBeGreaterThan(60);
    expect([...second].some((row) => first.has(row))).toBe(false);
  });
});

it("executes hash-cache write-back and its cached fast path on real reserved string resources", () => {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "keys",
    utf8Storage: false,
    literals: [{ value: "" }, { value: "ab" }],
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings),
    l = strings.layout;
  const hash = tx.reserveFunction("hash", "hash", { params: [{ kind: "externref" }], results: [{ kind: "i32" }] });
  const probe = tx.reserveFunction("probe", "probe", {
    params: [],
    results: [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
  });
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, flatten);
  const literal = requireNativeStringLiteral(tx, strings, "ab", "wtf16");
  if (literal.kind !== "global") throw Error("missing issued literal");
  const r: bodies.ObjectHashResources = {
    anyStrTypeIdx: l.anyStrTypeIdx,
    nativeStrTypeIdx: l.nativeStrTypeIdx,
    nativeStrRef: { kind: "ref", typeIdx: l.nativeStrTypeIdx },
    strDataTypeIdx: l.nativeStrDataTypeIdx,
    hashedStrTypeIdx: l.hashedStrTypeIdx,
    symbolTypeIdx: -1,
    symbolKeysEnabled: false,
    nativeFirst: true,
    strFlattenIdx: flatten.flatten.handle,
  };
  tx.fillFunction(hash, {
    locals: [
      { name: "str", type: r.nativeStrRef },
      { name: "data", type: { kind: "ref", typeIdx: r.strDataTypeIdx } },
      ...["len", "off", "i", "h"].map((name) => ({ name, type: { kind: "i32" as const } })),
      { name: "keyAny", type: { kind: "anyref" } },
      { name: "keyStr", type: { kind: "ref", typeIdx: r.anyStrTypeIdx } },
    ],
    body: bodies.buildObjectHashBody(r),
  });
  const load = (): Instr[] => [{ op: "local.get", index: 0 }, { op: "ref.as_non_null" }];
  tx.fillFunction(probe, {
    locals: [{ name: "key", type: { kind: "ref_null", typeIdx: l.hashedStrTypeIdx } }],
    body: [
      { op: "i32.const", value: 2 },
      { op: "i32.const", value: 0 },
      { op: "global.get", index: tx.physicalIndex(literal.global) },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "ref.null", typeIdx: -18 },
      { op: "struct.new", typeIdx: l.hashedStrTypeIdx },
      { op: "local.set", index: 0 },
      ...load(),
      { op: "struct.get", typeIdx: l.hashedStrTypeIdx, fieldIdx: 3 },
      ...load(),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: hash.handle },
      ...load(),
      { op: "struct.get", typeIdx: l.hashedStrTypeIdx, fieldIdx: 3 },
      ...load(),
      { op: "i32.const", value: -2147483525 },
      { op: "struct.set", typeIdx: l.hashedStrTypeIdx, fieldIdx: 3 },
      ...load(),
      { op: "extern.convert_any" },
      { op: "call", funcIdx: hash.handle },
    ],
  });
  tx.defineExport("probe-export", "probe", probe);
  tx.seal();
  const compiled = new WebAssembly.Module(Uint8Array.from(binaryEmitter.emitBinary(module)));
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  const instance = new WebAssembly.Instance(compiled, {});
  let expected = 0x811c9dc5 | 0;
  for (const unit of [97, 98]) expected = Math.imul(expected ^ unit, 0x01000193);
  expected &= 0x7fffffff;
  expect((instance.exports.probe as () => number[])()).toEqual([0, expected, expected | -0x80000000, 123]);
});

it("observes actual hash collisions and lookup crossing a deleted production table slot", async () => {
  const emission = vi.spyOn(binaryEmitter, "emitBinary");
  const { compile } = await import("../src/index.js");
  const source = `
    export function key(n: number): string { return n === 0 ? "a" : n === 1 ? "A" : "!"; }
    export function make(): any {
      const o: any = {}; o[key(0)] = 1; o[key(1)] = 2; o[key(2)] = 3;
      delete o[key(0)]; return o;
    }
    export function read(o: any, k: any): number { return o[k] as number; }
  `;
  const result = await compile(source, {
    fileName: "actual-table-probe.ts",
    target: "standalone",
    nativeStrings: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = emission.mock.calls.at(-1)?.[0];
  if (!module) throw Error("missing actual compiler emission");
  emission.mockRestore();
  // The original artifact runs first. Diagnostic exports below only expose its
  // real bodies/table; no hash, equality, layout or provider is substituted.
  const original = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {});
  const api = original.exports as { key(n: number): unknown; make(): unknown; read(o: unknown, k: unknown): unknown };
  expect(api.read(api.make(), api.key(1))).toBe(2);
  const originalFunctions = structuredClone(module.functions);
  const functionIndex = (name: string) => {
    const matches = module.functions.flatMap((fn, i) => (fn.name === name ? [i] : []));
    expect(matches, name).toHaveLength(1);
    return module.imports.filter((row) => row.desc.kind === "func").length + matches[0]!;
  };
  const structIndex = (name: string) => {
    const index = module.types.findIndex((row) => row.kind === "struct" && row.name === name);
    expect(index, name).toBeGreaterThanOrEqual(0);
    return index;
  };
  const object = structIndex("$Object"),
    entry = structIndex("$PropEntry");
  const map = module.types.findIndex((row) => row.kind === "array" && row.name === "$PropMap");
  expect(map).toBeGreaterThanOrEqual(0);
  const hash = functionIndex("__obj_hash"),
    find = functionIndex("__obj_find");
  const E: ValType = { kind: "externref" },
    I: ValType = { kind: "i32" };
  const objectFromParam = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: object },
  ];
  const table = (): Instr[] => [...objectFromParam(), { op: "struct.get", typeIdx: object, fieldIdx: 1 }];
  const start = (): Instr[] => [
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: hash },
    ...table(),
    { op: "array.len" },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "i32.and" },
  ];
  const addDiagnostic = (name: string, results: ValType[], body: Instr[]) => {
    const handle = mintDefinedFunc(module);
    const typeIdx = internFunctionType(module.types, new Map(), [E, E], results);
    commitDefinedFuncOrdinal(module, handle);
    appendDefinedFunc(module, { name, typeIdx, locals: [], body, exported: true });
    module.exports.push({ name, desc: { kind: "func", index: handle } });
  };
  addDiagnostic(
    "observe",
    [I, I],
    [
      ...table(),
      { op: "array.len" },
      ...table(),
      ...start(),
      { op: "array.get", typeIdx: map },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: entry, fieldIdx: 2 },
    ],
  );
  addDiagnostic(
    "found",
    [I],
    [
      ...objectFromParam(),
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: find },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
    ],
  );
  addDiagnostic(
    "eraseFirstSlot",
    [],
    [...table(), ...start(), { op: "ref.null", typeIdx: entry }, { op: "array.set", typeIdx: map }],
  );
  module.exports.push({ name: "actualHash", desc: { kind: "func", index: hash } });
  expect(module.functions.slice(0, -3)).toEqual(originalFunctions);
  const diagnostic = new WebAssembly.Module(binaryEmitter.emitBinary(module));
  expect(WebAssembly.Module.imports(diagnostic)).toEqual([]);
  const run = new WebAssembly.Instance(diagnostic, {}).exports as typeof api & {
    actualHash(k: unknown): number;
    observe(o: unknown, k: unknown): number[];
    found(o: unknown, k: unknown): number;
    eraseFirstSlot(o: unknown, k: unknown): void;
  };
  const keys = [0, 1, 2].map((n) => run.key(n)),
    o = run.make();
  const [capacity, flags] = run.observe(o, keys[1]);
  expect(capacity).toBe(8);
  expect(flags & 0x80).toBe(0x80);
  const slots = keys.map((key) => run.actualHash(key) & (capacity! - 1));
  expect(new Set(slots).size).toBe(1);
  expect(run.found(o, keys[0])).toBe(0);
  expect(run.found(o, keys[1])).toBe(1);
  expect(run.read(o, keys[1])).toBe(2);
  // Replacing the measured first tombstone by an empty slot terminates the
  // actual lookup before the still-present next entry: this proves traversal.
  run.eraseFirstSlot(o, keys[1]);
  expect(run.found(o, keys[1])).toBe(0);
});
