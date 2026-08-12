// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4098 — native Error instances use their existing `$props` slot as the one
// ordinary-own-property store shared by prepared IR and every reflective MOP.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    fileName: "issue-4098-error-expando.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    trackIrOutcomes: true,
    emitWat: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return { result, exports: instance.exports as Record<string, () => number> };
}

describe("#4098 native Error own-property substrate", () => {
  it("round-trips an assigned expando through get / hasOwn / in on prepared IR", async () => {
    const { result, exports } = await compileStandalone(`
function exercise(error: Error): number {
  const carrier: any = error;
  carrier.value = 12;
  return carrier.value;
}
function reflect(error: any): number {
  let mask = 0;
  if (error.hasOwnProperty("value")) mask = mask + 10;
  if ("value" in error) mask = mask + 100;
  return mask;
}
function legacyRoundTrip(): number {
  const error: any = new Error("x");
  const value = exercise(error);
  return (value === 12 ? 1 : 0) + reflect(error);
}
export function test(): number { return legacyRoundTrip(); }
export function preparedRead(error: any): any { return error.value; }
`);

    expect(exports.test()).toBe(111);
    expect(
      result.irOutcomes?.find((outcome) => outcome.displayName === "preparedRead"),
      JSON.stringify(result.irOutcomes),
    ).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
      stage: "patch",
    });
    expect(result.wat).toContain("__dyn_member_get");
    expect(result.wat).toContain("__extern_get");
  });

  it("keeps define/read/descriptor/enumeration/delete on one authoritative store", async () => {
    const { exports } = await compileStandalone(`
export function test(): number {
  const error: any = new Error("x");
  Object.defineProperty(error, "p", {
    value: 7, writable: true, enumerable: true, configurable: true
  });
  if (error.p !== 7 || !error.hasOwnProperty("p") || !("p" in error)) return 2;
  const d: any = Object.getOwnPropertyDescriptor(error, "p");
  if (d === undefined || d.value !== 7 || !d.writable || !d.enumerable || !d.configurable) return 3;
  const keys: any = Object.keys(error);
  if (keys.length !== 1 || keys[0] !== "p") return 4;
  let seen = 0;
  for (const key in error) { if (key === "p") seen = seen + 1; else seen = seen + 100; }
  if (seen !== 1) return 5;
  error.nil = null;
  if (!error.hasOwnProperty("nil") || error.nil !== null) return 8;
  if (!(delete error.p)) return 6;
  if (error.hasOwnProperty("p") || ("p" in error) || error.p !== undefined) return 7;
  if (!(delete error.nil)) return 9;
  if (error.hasOwnProperty("nil") || ("nil" in error) || error.nil !== undefined) return 10;
  return 1;
}
`);
    expect(exports.test()).toBe(1);
  });

  it("invokes sidecar accessors with the original Error receiver", async () => {
    const { exports } = await compileStandalone(`
export function test(): number {
  const error: any = new Error("x");
  let getThis = 0;
  let setThis = 0;
  let stored = 0;
  Object.defineProperty(error, "p", {
    get: function (): number { if (this === error) getThis = 1; return stored; },
    set: function (value: number): void { if (this === error) setThis = 1; stored = value; },
    enumerable: true,
    configurable: true
  });
  error.p = 9;
  if (error.p !== 9) return 2;
  if (getThis !== 1 || setThis !== 1) return 3;
  return 1;
}
`);
    expect(exports.test()).toBe(1);
  });

  it("uses the Error bag for preventExtensions integrity state", async () => {
    const { exports } = await compileStandalone(`
export function test(): number {
  const error: any = new Error("x");
  if (!Object.isExtensible(error)) return 2;
  Object.preventExtensions(error);
  if (Object.isExtensible(error)) return 3;
  try { error.named = 1; } catch (_) {}
  try { error["0"] = 2; } catch (_) {}
  if (error.hasOwnProperty("named") || error.hasOwnProperty("0")) return 4;
  return 1;
}
`);
    expect(exports.test()).toBe(1);
  });

  it("keeps dynamic Error writes and reads coherent through compileMulti", async () => {
    const result = await compileMulti(
      {
        "entry.ts": `
export function test(): number {
  const error: any = new Error("x");
  error.value = 14;
  return error.value;
}
`,
      },
      "entry.ts",
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(14);
  });

  it("keeps compileMulti Error accessors receiver-correct", async () => {
    const result = await compileMulti(
      {
        "entry.ts": `
export function test(): number {
  const error: any = new Error("x");
  let mask = 0;
  let stored = 0;
  Object.defineProperty(error, "value", {
    get: function (): number { if (this === error) mask = mask + 1; return stored; },
    set: function (value: number): void { if (this === error) mask = mask + 10; stored = value; },
    configurable: true
  });
  error.value = 17;
  if (error.value !== 17) return 2;
  return mask;
}
`,
      },
      "entry.ts",
      { target: "standalone", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    expect((instance.exports.test as () => number)()).toBe(11);
  });

  it("accepts Error instances as descriptors, Properties maps, and define targets", async () => {
    const { exports } = await compileStandalone(`
export function test(): number {
  const descriptor: any = new Error();
  descriptor.value = 8;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  const first: any = {};
  Object.defineProperty(first, "a", descriptor);
  if (first.a !== 8) return 2;

  const properties: any = new Error();
  let correctThis = 0;
  Object.defineProperty(properties, "b", {
    get: function (): any { if (this === properties) correctThis = 1; return { value: 9, enumerable: true }; },
    enumerable: true,
    configurable: true
  });
  const second: any = {};
  Object.defineProperties(second, properties);
  if (second.b !== 9 || correctThis !== 1) return 3;

  const target: any = new Error();
  Object.defineProperties(target, { c: { value: 10, enumerable: true, configurable: true } });
  if (target.c !== 10 || Object.keys(target)[0] !== "c") return 4;
  return 1;
}
`);
    expect(exports.test()).toBe(1);
  });

  it("does not fabricate native Error struct internals as own enumerable keys", async () => {
    const { exports } = await compileStandalone(`
export function test(): number {
  const fresh: any = new Error("x");
  if (Object.keys(fresh).length !== 0) return 2;
  const names: any = Object.getOwnPropertyNames(fresh);
  for (let i = 0; i < names.length; i = i + 1) {
    if (names[i] === "tag" || names[i] === "userClassId" || names[i] === "props") return 3;
  }
  fresh.user = 1;
  const keys: any = Object.keys(fresh);
  if (keys.length !== 1 || keys[0] !== "user") return 4;
  return 1;
}
`);
    expect(exports.test()).toBe(1);
  });
});
