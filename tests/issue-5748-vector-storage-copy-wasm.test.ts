// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildRawExternrefStorageCopyBody } from "../src/runtime/wasmgc/values/vector-storage-copy-body.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, LocalDef, ValType } from "../src/wasm/model/instructions.js";

interface Api {
  token(): unknown;
  emptyStruct(): unknown;
  array(length: number, fill: unknown): unknown;
  get(array: unknown, index: number): unknown;
  set(array: unknown, index: number, value: unknown): void;
  copy(
    src: unknown,
    dst: unknown,
    srcToken: unknown,
    dstToken: unknown,
    srcStart: number,
    dstStart: number,
    count: number,
  ): void;
}

/** Real builder body in a tiny Wasm module; test-only exports expose private tokens.
 * This deliberately does NOT model or authenticate the future resident provider ABI.
 */
function fixture() {
  const mod = createEmptyModule();
  const arrayTypeIndex = 0,
    holeTypeIndex = 1;
  mod.types.push(
    { kind: "array", name: "slots", element: { kind: "externref" }, mutable: true },
    { kind: "struct", name: "Hole", fields: [] },
  );
  mod.globals.push({
    name: "token",
    type: { kind: "ref", typeIdx: holeTypeIndex },
    mutable: false,
    init: [{ op: "struct.new", typeIdx: holeTypeIndex }],
  });
  const add = (name: string, params: ValType[], results: ValType[], body: Instr[], locals: LocalDef[] = []) => {
    const typeIdx = mod.types.length;
    mod.types.push({ kind: "func", params, results });
    const index = mod.functions.length;
    mod.functions.push({ name, typeIdx, locals, body, exported: true });
    mod.exports.push({ name, desc: { kind: "func", index } });
  };
  const arrayRef: ValType = { kind: "ref", typeIdx: arrayTypeIndex };
  const holeRef: ValType = { kind: "ref", typeIdx: holeTypeIndex };
  add("token", [], [holeRef], [{ op: "global.get", index: 0 }]);
  add("emptyStruct", [], [holeRef], [{ op: "struct.new", typeIdx: holeTypeIndex }]);
  add(
    "array",
    [{ kind: "i32" }, { kind: "externref" }],
    [arrayRef],
    [
      { op: "local.get", index: 1 },
      { op: "local.get", index: 0 },
      { op: "array.new", typeIdx: arrayTypeIndex },
    ],
  );
  add(
    "get",
    [arrayRef, { kind: "i32" }],
    [{ kind: "externref" }],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "array.get", typeIdx: arrayTypeIndex },
    ],
  );
  add(
    "set",
    [arrayRef, { kind: "i32" }, { kind: "externref" }],
    [],
    [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "array.set", typeIdx: arrayTypeIndex },
    ],
  );
  const copy = buildRawExternrefStorageCopyBody({ arrayTypeIndex, holeTypeIndex });
  add("copy", copy.params, copy.results, copy.body, copy.locals);
  const bytes = Uint8Array.from(emitBinary(mod));
  expect(WebAssembly.validate(bytes)).toBe(true);
  const module = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instantiate = () => new WebAssembly.Instance(module).exports as unknown as Api;
  return { api: instantiate(), instantiate };
}

function array(api: Api, values: readonly unknown[]): unknown {
  const result = api.array(values.length, null);
  values.forEach((value, index) => api.set(result, index, value));
  return result;
}

function read(api: Api, value: unknown, length: number): unknown[] {
  return Array.from({ length }, (_, index) => api.get(value, index));
}

describe("dormant raw vector copy on actual Wasm", () => {
  it("translates only exact source-token identity and preserves every other externref", () => {
    const { api, instantiate } = fixture();
    const other = instantiate();
    const srcToken = api.token(),
      dstToken = other.token();
    expect(Object.is(srcToken, dstToken)).toBe(false);
    let observations = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          observations++;
          throw new Error("must not Get");
        },
      },
    );
    const values = [srcToken, undefined, null, api.emptyStruct(), {}, proxy, () => 1, Symbol("v"), 9n, NaN, -0, 3];
    const src = array(api, values),
      dst = other.array(values.length + 2, "outside");
    other.copy(src, dst, srcToken, dstToken, 0, 1, values.length);
    expect(other.get(dst, 0)).toBe("outside");
    expect(other.get(dst, values.length + 1)).toBe("outside");
    expect(other.get(dst, 1)).toBe(dstToken);
    for (let i = 1; i < values.length; i++) expect(other.get(dst, i + 1)).toBe(values[i]);
    for (let i = 0; i < values.length; i++) expect(api.get(src, i)).toBe(values[i]);
    expect(observations).toBe(0);
  });

  it("normalizes A to B and B back to A through the same-binary foreign copy function", () => {
    const { api: a, instantiate } = fixture();
    const b = instantiate(),
      aToken = a.token(),
      bToken = b.token();
    const value = {};
    const av = array(a, [aToken, value, undefined]);
    const bv = b.array(3, bToken),
      result = a.array(3, null);
    b.copy(av, bv, aToken, bToken, 0, 0, 3);
    a.copy(bv, result, bToken, aToken, 0, 0, 3);
    expect(a.get(result, 0)).toBe(aToken);
    expect(a.get(result, 1)).toBe(value);
    expect(a.get(result, 2)).toBeUndefined();
  });

  it.each([
    { srcStart: 0, dstStart: 1, expected: [0, 0, 1, 2, 3] },
    { srcStart: 1, dstStart: 0, expected: [1, 2, 3, 4, 4] },
    { srcStart: 0, dstStart: 0, expected: [0, 1, 2, 3, 4] },
  ])("uses memmove for overlap $srcStart -> $dstStart", ({ srcStart, dstStart, expected }) => {
    const { api } = fixture(),
      token = api.token();
    const values = array(api, [0, 1, 2, 3, 4]);
    api.copy(values, values, token, token, srcStart, dstStart, 4);
    expect(read(api, values, 5)).toEqual(expected);
  });

  it.each([0, 2])("rejects inconsistent alias domains even with count=%s without writes", (count) => {
    const { api, instantiate } = fixture();
    const token = api.token(),
      foreignToken = instantiate().token();
    const values = array(api, [token, "retained", undefined]);
    expect(() => api.copy(values, values, token, foreignToken, 0, 1, count)).toThrow(WebAssembly.RuntimeError);
    expect(api.get(values, 0)).toBe(token);
    expect(api.get(values, 1)).toBe("retained");
    expect(api.get(values, 2)).toBeUndefined();
  });

  it.each([
    [-1, 0, 1],
    [0, -1, 1],
    [4, 0, 0],
    [0, 4, 0],
    [2, 0, 2],
    [0, 2, 2],
    [0, 0, -1],
    [1, 1, 0x7fffffff],
  ])("preflights invalid ranges (%s,%s,%s) before any destination mutation", (srcStart, dstStart, count) => {
    const { api, instantiate } = fixture();
    const srcToken = api.token(),
      dstToken = instantiate().token();
    const src = array(api, [srcToken, 11, 12]),
      dst = array(api, [21, 22, 23]);
    for (const token of [srcToken, dstToken]) {
      expect(() => api.copy(src, dst, srcToken, token, srcStart, dstStart, count)).toThrow(WebAssembly.RuntimeError);
      expect(read(api, dst, 3)).toEqual([21, 22, 23]);
      expect(api.get(src, 0)).toBe(srcToken);
      expect(api.get(src, 1)).toBe(11);
      expect(api.get(src, 2)).toBe(12);
    }
  });

  it("accepts zero-length copies exactly at both ends", () => {
    const { api, instantiate } = fixture();
    const src = array(api, [1]),
      dst = array(api, [2]);
    api.copy(src, dst, api.token(), instantiate().token(), 1, 1, 0);
    expect(read(api, dst, 1)).toEqual([2]);
  });
});

describe("Hume supplemental equal-domain raw-copy controls", () => {
  it("copies holes between distinct arrays with equal tokens without changing source or outside slots", () => {
    const { api } = fixture();
    const token = api.token();
    const present = {};
    const emptyStruct = api.emptyStruct();
    const values = [token, undefined, null, present, emptyStruct, token];
    const src = array(api, values);
    const dst = api.array(values.length + 2, "outside");
    expect(Object.is(src, dst)).toBe(false);
    expect(Object.is(emptyStruct, token)).toBe(false);

    api.copy(src, dst, token, token, 0, 1, values.length);

    expect(api.get(dst, 0)).toBe("outside");
    expect(api.get(dst, values.length + 1)).toBe("outside");
    for (let i = 0; i < values.length; i++) {
      expect(api.get(src, i)).toBe(values[i]);
      expect(api.get(dst, i + 1)).toBe(values[i]);
    }
  });

  it("accepts exact-end zero-count copying on the equal-token branch without changing either array", () => {
    const { api } = fixture();
    const token = api.token();
    const srcValues = [token, undefined];
    const dstValues = [null, "retained", token];
    const src = array(api, srcValues);
    const dst = array(api, dstValues);

    api.copy(src, dst, token, token, srcValues.length, dstValues.length, 0);

    for (let i = 0; i < srcValues.length; i++) expect(api.get(src, i)).toBe(srcValues[i]);
    for (let i = 0; i < dstValues.length; i++) expect(api.get(dst, i)).toBe(dstValues[i]);
  });
});
