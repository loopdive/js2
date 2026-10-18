// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6981 — native-regime defects surfaced by flipping the default semantic
// provider policy to native-first in a JavaScript environment (#6708). Each
// construct runs under BOTH regime lanes: `semanticProviders: "native-first"`
// (JS environment, exports read through the compiled JS value adapter) and
// `target: "standalone"`. Results are checked, never WAT shape; every probe
// returns a number so the standalone lane needs no string marshalling.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "native-first" | "standalone";
const LANES: readonly Lane[] = ["native-first", "standalone"];

async function run(
  source: string,
  lane: Lane,
  fn: string,
  args: unknown[] = [],
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const options =
    lane === "standalone" ? { target: "standalone" as const } : { semanticProviders: "native-first" as const };
  const r = await compile(source, { ...options, ...extra });
  if (!r.success) throw new Error(`compile failed (${lane}): ${r.errors.map((e) => e.message).join("\n")}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  imports.setInstance?.(instance);
  const exports =
    lane === "standalone" ? (instance.exports as Record<string, Function>) : wrapCompiledExports(r, instance);
  return exports[fn]!(...args);
}

describe("#6981 native regime: IR path and direct-path defects", () => {
  for (const lane of LANES) {
    describe(lane, () => {
      it('new Error() without a message inherits %Error.prototype%.message ("")', async () => {
        const src = `
          export function run(): number {
            const e = new Error();
            const t: any = new TypeError();
            let r = 0;
            if (e.message === "") r += 1;
            if (t.message === "") r += 10;
            if (typeof t.message === "string") r += 100;
            if (new RangeError("m").message === "m") r += 1000;
            return r;
          }`;
        for (const experimentalIR of [true, false]) {
          expect(await run(src, lane, "run", [], { experimentalIR })).toBe(1111);
        }
      });

      // The intrinsic "" default must not shadow the real prototype: writes,
      // deletes and accessor redefinitions on Error.prototype stay observable.
      it("Error.prototype message write / delete / getter stay observable", async () => {
        const written = `
          export function run(): number {
            Error.prototype.message = "changed";
            return new Error().message === "changed" ? 1 : 0;
          }`;
        const deleted = `
          export function run(): number {
            var d = delete (Error.prototype as any).message;
            var e: any = new Error();
            return (d ? 1 : 0) + (e.message === undefined ? 2 : 0);
          }`;
        const getter = `
          export function run(): number {
            Object.defineProperty(Error.prototype, "message", { get() { return "got"; }, configurable: true });
            const e: any = new TypeError();
            return e.message === "got" ? 1 : 0;
          }`;
        const materialized = `
          export function run(): number {
            const p: any = Error.prototype;
            const e: any = new Error();
            return (e.message === "" ? 1 : 0) + (p.message === "" ? 10 : 0);
          }`;
        for (const experimentalIR of [true, false]) {
          expect(await run(written, lane, "run", [], { experimentalIR })).toBe(1);
          expect(await run(deleted, lane, "run", [], { experimentalIR })).toBe(3);
          expect(await run(getter, lane, "run", [], { experimentalIR })).toBe(1);
          expect(await run(materialized, lane, "run", [], { experimentalIR })).toBe(11);
        }
      });

      it("Set construction stays off the IR in a host-free lane (no capability violation)", async () => {
        const src = `
          export function empty(): number {
            const s = new Set();
            return s.size;
          }
          export function run(): number {
            const s = new Set();
            s.add("x");
            s.add("y");
            s.add("x");
            if (s.has("x") && s.has("y")) return s.size;
            return 0;
          }`;
        for (const experimentalIR of [true, false]) {
          expect(await run(src, lane, "empty", [], { experimentalIR })).toBe(0);
          expect(await run(src, lane, "run", [], { experimentalIR })).toBe(2);
        }
      });

      it("typeof on a usage-specialized any local reads a boxed tag (fast mode)", async () => {
        const src = `
          export function isNumber(x: number): number {
            let a: any = x;
            if (typeof a === "number") return 1;
            return 0;
          }
          export function isNotString(x: number): number {
            let a: any = x;
            if (typeof a !== "string") return 1;
            return 0;
          }
          export function testNum(): number {
            let a: any = 42;
            if (typeof a === "number") return 1;
            return 0;
          }`;
        expect(await run(src, lane, "isNumber", [42], { fast: true })).toBe(1);
        expect(await run(src, lane, "isNotString", [5], { fast: true })).toBe(1);
        expect(await run(src, lane, "testNum", [], { fast: true })).toBe(1);
      });

      it("let {} = <number> is coercible", async () => {
        const src = `
          export function test(): number {
            let r = 0;
            try { let o: any = 5; let {} = o; r = 1; } catch (e) { r = (e instanceof TypeError) ? 2 : 3; }
            return r;
          }
          export function field(): number {
            let o: any = 5;
            let { a } = o;
            return a === undefined ? 1 : 0;
          }`;
        expect(await run(src, lane, "test")).toBe(1);
        expect(await run(src, lane, "field")).toBe(1);
      });

      it("a boolean-or-number && / || stored as any keeps its boolean tag", async () => {
        const src = `
          function f(): number { return 5; }
          export function run(): number {
            const x: any = false && f();
            const y: any = true || f();
            const z: any = true && f();
            let r = 0;
            if (typeof x === "boolean") r += 1;
            if (String(x) === "false") r += 10;
            if (typeof y === "boolean") r += 100;
            if (typeof z === "number") r += 1000;
            return r;
          }`;
        expect(await run(src, lane, "run")).toBe(1111);
      });

      it("numeric-key write then read on an any-typed object", async () => {
        const src = `
          export function run(): number {
            const o: any = {};
            o[0] = 42;
            o[1] = "s";
            return (o[0] === 42 ? 1 : 0) + (o[1] === "s" ? 10 : 0);
          }`;
        expect(await run(src, lane, "run")).toBe(11);
      });
    });
  }

  it("native-first: numeric-key write then read on a JS object crossing the boundary", async () => {
    const src = `
      export function test(obj: any): any {
        obj[0] = 42;
        return obj[0];
      }
      export function str(obj: any): any {
        obj[1] = "s";
        return obj[1];
      }`;
    const o: Record<string, unknown> = {};
    expect(await run(src, "native-first", "test", [o])).toBe(42);
    expect(o[0]).toBe(42);
    expect(await run(src, "native-first", "str", [{}])).toBe("s");
  });
});
