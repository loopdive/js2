// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1599 Phase 2 — standalone `JSON.stringify` over every ordinary carrier.
 *
 * Before: a statically array-typed value (`number[]`, `T[]`, `any[]`) hit the
 * #1599 compile refusal, and a closed struct (class instance, typed object
 * literal) serialised as the literal `null`. three.js's
 * `JSON.parse(JSON.stringify(groups))` (#6667) was the first blocker of its
 * standalone lane. Cycles answered a silent `null` instead of a TypeError, and a
 * function replacer was ignored for a primitive root value.
 *
 * Every result is compared IN-WASM against the Node answer, and every module
 * must instantiate with ZERO imports (no host fallback).
 */
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

type Exports = Record<string, unknown> & { test: () => number; _start?: () => void };

async function instantiateHostFree(r: {
  success: boolean;
  errors: { message: string }[];
  binary: Uint8Array;
  imports: { module: string; name: string }[];
}): Promise<Exports> {
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports, `unexpected env imports: ${envImports.join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Exports;
  exports._start?.();
  return exports;
}

async function runTs(body: string): Promise<number> {
  const r = await compile(`export function test(): number { ${body} }`, {
    fileName: "t.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  return (await instantiateHostFree(r)).test();
}

/** 1 iff `JSON.stringify(<call args>)` equals `want`. */
function stringifiesTo(setup: string, call: string, want: string): Promise<number> {
  return runTs(`${setup} const s: any = ${call}; return s === ${JSON.stringify(want)} ? 1 : 0;`);
}

/** 1 iff the call throws a TypeError, 0 if it returns, 2 on another error. */
function throwsTypeError(setup: string, call: string): Promise<number> {
  return runTs(`${setup} try { ${call}; return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }`);
}

describe("#1599 standalone JSON.stringify carriers", () => {
  it("serialises a statically typed number array", async () => {
    expect(
      await stringifiesTo(`const v: number[] = [10, 20, 30]; v.push(4.5);`, `JSON.stringify(v)`, `[10,20,30,4.5]`),
    ).toBe(1);
  });

  it("serialises a typed array of objects (the three.js BufferGeometry.groups shape)", async () => {
    expect(
      await stringifiesTo(
        `const v: { start: number; count: number; materialIndex?: number }[] = [];
         v.push({ start: 0, count: 3, materialIndex: 1 });`,
        `JSON.stringify(v)`,
        `[{"start":0,"count":3,"materialIndex":1}]`,
      ),
    ).toBe(1);
  });

  it("serialises a class instance and a nested typed literal", async () => {
    expect(
      await stringifiesTo(
        `class C { a = 1; b = [2]; m() { return 1; } } const v = new C();`,
        `JSON.stringify(v)`,
        `{"a":1,"b":[2]}`,
      ),
    ).toBe(1);
    expect(
      await stringifiesTo(
        `const v = { g: [{ s: 1 }] as { s: number }[], n: "x" };`,
        `JSON.stringify(v)`,
        `{"g":[{"s":1}],"n":"x"}`,
      ),
    ).toBe(1);
  });

  it("threads space and a function replacer through array carriers", async () => {
    expect(await stringifiesTo(`const v: number[] = [1, 2];`, `JSON.stringify(v, null, 2)`, `[\n  1,\n  2\n]`)).toBe(1);
    expect(
      await stringifiesTo(
        `const v: number[] = [1, 2];`,
        `JSON.stringify(v, (k: string, x: any) => (typeof x === "number" ? x * 2 : x))`,
        `[2,4]`,
      ),
    ).toBe(1);
  });

  it("calls toJSON on an own method and on a class prototype method", async () => {
    expect(await stringifiesTo(`const v = { toJSON() { return [1, 2]; } };`, `JSON.stringify(v)`, `[1,2]`)).toBe(1);
    expect(
      await stringifiesTo(
        `class D { a = 1; toJSON() { return "D" + this.a; } } const v = [new D()];`,
        `JSON.stringify(v)`,
        `["D1"]`,
      ),
    ).toBe(1);
  });

  it("throws a TypeError on a cycle, and not on a shared (acyclic) reference", async () => {
    expect(await throwsTypeError(`const v: any = {}; v.self = v;`, `JSON.stringify(v)`)).toBe(1);
    expect(
      await throwsTypeError(`const o: any = { x: { y: {} } }; o.x.y.z = o; const v = { w: o };`, `JSON.stringify(v)`),
    ).toBe(1);
    expect(await throwsTypeError(`const o: any = {}; const a: any[] = [o]; o.a = a;`, `JSON.stringify(a)`)).toBe(1);
    expect(
      await throwsTypeError(`class N { next: any = null; } const v = new N(); v.next = v;`, `JSON.stringify(v)`),
    ).toBe(1);
    expect(
      await stringifiesTo(
        `const a = { x: 1 }; const v = [a, a, { b: a }];`,
        `JSON.stringify(v)`,
        `[{"x":1},{"x":1},{"b":{"x":1}}]`,
      ),
    ).toBe(1);
  });

  it("keeps a re-entrant stringify from toJSON independent of its caller", async () => {
    expect(
      await stringifiesTo(
        `const inner = { q: 2 }; const v = { a: { toJSON() { return JSON.stringify(inner); } }, b: 3 };`,
        `JSON.stringify(v)`,
        `{"a":"{\\"q\\":2}","b":3}`,
      ),
    ).toBe(1);
  });

  it("applies a function replacer to a primitive root value", async () => {
    expect(await stringifiesTo(`const v = 1;`, `JSON.stringify(v, (k: any, x: any) => "w:" + x)`, `"w:1"`)).toBe(1);
    expect(await stringifiesTo(`const v = "x";`, `JSON.stringify(v, (k: any, x: any) => x)`, `"x"`)).toBe(1);
    expect(
      await stringifiesTo(``, `JSON.stringify(null, (k: any, x: any) => (k === "" ? { a: 1 } : x))`, `{"a":1}`),
    ).toBe(1);
  });

  it("round-trips an untyped two-file JS project (three.js BufferGeometry.toJSON shape)", async () => {
    const r = await compileMulti(
      {
        "./geometry.js": `
export class Geometry {
  constructor() { this.groups = []; }
  addGroup(start, count, materialIndex = 0) {
    this.groups.push({ start: start, count: count, materialIndex: materialIndex });
  }
  toJSON() {
    const data = { data: {} };
    data.data.groups = JSON.parse(JSON.stringify(this.groups));
    return data;
  }
}
`,
        "./main.js": `
import { Geometry } from "./geometry.js";
export function test() {
  const g = new Geometry();
  g.addGroup(0, 3, 1);
  g.addGroup(3, 6);
  const s = JSON.stringify(g.groups);
  const back = g.toJSON().data.groups;
  return s === '[{"start":0,"count":3,"materialIndex":1},{"start":3,"count":6,"materialIndex":0}]' &&
    back.length === 2 && back[1].count === 6 ? 1 : 0;
}
`,
      },
      "./main.js",
      { target: "standalone", allowJs: true, skipSemanticDiagnostics: true },
    );
    expect((await instantiateHostFree(r)).test()).toBe(1);
  });

  it("still refuses a tuple (no codec arm reads it positionally)", async () => {
    const r = await compile(
      `export function test(): number { const v: [number, string] = [1, "x"]; return JSON.stringify(v).length; }`,
      {
        fileName: "t.ts",
        target: "standalone",
        skipSemanticDiagnostics: true,
      },
    );
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join(" ")).toContain("#1599");
  });
});
