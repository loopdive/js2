import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#1667 compile() returns ready-to-pass importObject (JS-host mode)", () => {
  it("default mode: instantiate(binary, result.importObject) runs with no hand-wiring", async () => {
    const r = await compile(`
      export function add(a: number, b: number): number {
        return a + b;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.importObject).toBeDefined();
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
    expect((instance.exports.add as Function)(2, 3)).toBe(5);
  });

  it("default mode with string literals: importObject wires string_constants", async () => {
    const r = await compile(`
      export function greet(): string {
        return "hello" + " " + "world";
      }
    `);
    expect(r.success).toBe(true);
    expect(r.importObject).toBeDefined();
    const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
    const out = (instance.exports.greet as Function)();
    expect(String(out)).toBe("hello world");
  });

  it("importObject exposes the env / wasm:js-string / string_constants namespaces", async () => {
    const r = await compile(`export function id(x: number): number { return x; }`);
    const io = r.importObject as Record<string, unknown>;
    expect(io).toBeDefined();
    expect(io.env).toBeTypeOf("object");
    expect(io["wasm:js-string"]).toBeDefined();
    expect(io.string_constants).toBeTypeOf("object");
  });

  it("importObject is cached — repeated reads return the same object", async () => {
    const r = await compile(`export function id(x: number): number { return x; }`);
    expect(r.importObject).toBe(r.importObject);
  });

  it("standalone mode: importObject is an empty object (zero-import path)", async () => {
    const r = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
      target: "standalone",
    });
    expect(r.success).toBe(true);
    expect(r.importObject).toEqual({});
  });

  it("failed compile: importObject is an empty object", async () => {
    const r = await compile(`export function bad(: { syntax error`);
    expect(r.success).toBe(false);
    expect(r.importObject).toEqual({});
  });
});
