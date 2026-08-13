import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string, ...args: unknown[]): Promise<unknown> {
  const result = await compile(source, { fileName: "issue-4383.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, (...values: unknown[]) => unknown>).test(...args);
}

describe("#4383 — typed-array identity across internal calls", () => {
  it("writes through an any-typed direct-call parameter into the caller's Uint8Array", async () => {
    expect(
      await run(`
        // @ts-nocheck
        function fill(buffer: any) {
          buffer[0] = 42;
        }

        export function test() {
          const buffer = new Uint8Array(1);
          fill(buffer);
          return buffer[0];
        }
      `),
    ).toBe(42);
  });

  it("keeps strict identity when an any-typed direct call returns the same Uint8Array", async () => {
    expect(
      await run(`
        function identity(buffer: any): any {
          return buffer;
        }

        export function test() {
          const buffer = new Uint8Array(1);
          return identity(buffer) === buffer;
        }
      `),
    ).toBe(1);
  });

  it("keeps identity when the values enter an object-literal assertion method", async () => {
    expect(
      await run(`
        const assert = {
          strictEqual(actual: any, expected: any) {
            return actual === expected;
          },
        };
        function identity(buffer: any): any {
          return buffer;
        }

        export function test() {
          const buffer = new Uint8Array(1);
          return assert.strictEqual(buffer, identity(buffer));
        }
      `),
    ).toBe(1);
  });

  it("preserves a short Uint8Array returned by an optional callable property", async () => {
    expect(
      await run(`
        function requireRandom(options: any) {
          const bytes = options.rng?.();
          if (bytes.length < 16) throw new Error("too short");
        }

        export function test() {
          try {
            requireRandom({ rng: () => Uint8Array.of(0) });
          } catch {
            return 1;
          }
          return 0;
        }
      `),
    ).toBe(1);
  });

  it("does not treat a short typed-array result as nullish", async () => {
    expect(
      await run(`
        function requireRandom(options: any) {
          const bytes = options.random ?? options.rng?.() ?? Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
          if (bytes.length < 16) throw new Error("too short");
        }

        export function test() {
          try {
            requireRandom({ rng: () => Uint8Array.of(0) });
          } catch {
            return 1;
          }
          return 0;
        }
      `),
    ).toBe(1);
  });

  it("captures a local callable that shadows a same-named module function", async () => {
    expect(
      await run(`
        function rng() {
          return Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
        }

        export function test() {
          const rng = () => Uint8Array.of(0);
          const invoke = () => rng().length;
          return invoke();
        }
      `),
    ).toBe(1);
  });

  it("copies an any-typed Uint8Array source with TypedArray.prototype.set", async () => {
    expect(
      await run(`
        function copy(bytes: any) {
          const out = new Uint8Array(bytes.length + 1);
          out.set(bytes);
          return out[0] * 100 + out[1] * 10 + out[2];
        }

        export function test() {
          return copy(Uint8Array.of(1, 2, 3));
        }
      `),
    ).toBe(123);
  });

  it("preserves undefined through a nullish-defaulted numeric parameter", async () => {
    expect(
      await run(
        `
          // @ts-nocheck
          export function test(offset: any) {
            offset ??= 5;
            return offset + 1;
          }
        `,
        undefined,
      ),
    ).toBe(6);
  });

  it("preserves a missing property through an internal nullish-defaulted parameter", async () => {
    expect(
      await run(`
        // @ts-nocheck
        function withDefault(value: any) {
          value ??= 5;
          return value;
        }

        export function test() {
          const options = { present: 1 };
          return withDefault(options.missing);
        }
      `),
    ).toBe(5);
  });

  it("preserves missing option fields across a multi-argument internal call", async () => {
    expect(
      await run(`
        // @ts-nocheck
        function consume(random: any, msecs: any, nsecs: any, clockseq: any, node: any, buffer: any, offset = 0) {
          nsecs ??= 0;
          clockseq ??= ((random[8] << 8) | random[9]) & 0x3fff;
          return nsecs * 100000 + clockseq;
        }
        function fromOptions(options: any) {
          return consume(
            options.random,
            options.msecs,
            options.nsecs,
            options.clockseq,
            options.node,
            undefined,
            undefined,
          );
        }

        export function test() {
          return fromOptions({
            msecs: 1645557742000,
            random: Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0x33, 0xc8, 0, 0, 0, 0, 0, 0),
          });
        }
      `),
    ).toBe(0x33c8);
  });

  it("preserves typed-array elements read through an object property across an internal call", async () => {
    expect(
      await run(`
        // @ts-nocheck
        function readClockseq(random: any) {
          return ((random[8] << 8) | random[9]) & 0x3fff;
        }
        function fromOptions(options: any) {
          return readClockseq(options.random);
        }

        export function test() {
          return fromOptions({
            random: Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0x33, 0xc8, 0, 0, 0, 0, 0, 0),
          });
        }
      `),
    ).toBe(0x33c8);
  });

  it("reads typed-array elements through an object property before forwarding", async () => {
    expect(
      await run(`
        // @ts-nocheck
        function fromOptions(options: any) {
          return ((options.random[8] << 8) | options.random[9]) & 0x3fff;
        }

        export function test() {
          return fromOptions({
            random: Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0x33, 0xc8, 0, 0, 0, 0, 0, 0),
          });
        }
      `),
    ).toBe(0x33c8);
  });

  it("keeps computed values before a spread in Uint8Array.of", async () => {
    expect(
      await run(`
        export function test() {
          const options = {
            clockseq: 0x33c8,
            node: Uint8Array.of(0x9f, 0x68, 0xde, 0xce, 0xd8, 0x46),
          };
          const bytes = Uint8Array.of(
            0, 0, 0, 0, 0, 0, 0, 0,
            options.clockseq >> 8,
            options.clockseq & 0xff,
            ...options.node,
          );
          return bytes[8] * 256 + bytes[9];
        }
      `),
    ).toBe(0x33c8);
  });

  it("defaults a dynamic value from typed-array bitwise reads", async () => {
    expect(
      await run(`
        // @ts-nocheck
        function clockSequence(bytes: any, value: any) {
          value ??= ((bytes[8] << 8) | bytes[9]) & 0x3fff;
          return value;
        }
        export function test() {
          return clockSequence(Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0x33, 0xc8), undefined);
        }
      `),
    ).toBe(0x33c8);
  });

  it("preserves undefined when reading a missing numeric-looking object property", async () => {
    expect(
      await run(`
        // @ts-nocheck
        function readClockseq(options: any) {
          return options.clockseq === undefined ? 1 : 100 + Number(options.clockseq);
        }

        export function test() {
          return readClockseq({ msecs: 1, random: Uint8Array.of(2) });
        }
      `),
    ).toBe(1);
  });

  it("does not confuse a shorter object with a collision-stamped numeric property shape", async () => {
    expect(
      await run(`
        // @ts-nocheck
        const complete = {
          msecs: 1,
          nsecs: 2,
          clockseq: 3,
          node: Uint8Array.of(4),
        };
        function readClockseq(options: any) {
          return options.clockseq === undefined ? 1 : 100 + Number(options.clockseq);
        }

        export function test() {
          void complete;
          return readClockseq({ msecs: 1, random: Uint8Array.of(2) });
        }
      `),
    ).toBe(1);
  });

  it("does not route a statically typed property argument through the dynamic nullish reader", async () => {
    expect(
      await run(`
        function present(value: any) {
          return value === null || value === undefined ? 0 : 1;
        }
        class Example {}

        export function test() {
          return present(Example.prototype);
        }
      `),
    ).toBe(1);
  });
});
