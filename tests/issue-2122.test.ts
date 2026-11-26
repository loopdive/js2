import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// #2122 — String.fromCharCode / fromCodePoint silently dropped every argument
// after the first. Three of the four backend paths compiled only argument[0];
// only native fromCharCode looped. All paths now join the per-argument results,
// evaluating later args exactly once in order.

// Host (JS-string) backend: the export returns a JS string directly.
async function runHost(source: string): Promise<any> {
  const r = await compile(source, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject!);
  return (instance.exports.test as Function)();
}

// Native-strings (fast mode) backend: the export returns an opaque native-string
// ref, so probe its length / charCodeAt to read the contents.
async function runFast(source: string): Promise<any> {
  const r = await compile(source, { fast: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(r);
  return (instance.exports.test as Function)();
}

describe("#2122 fromCharCode/fromCodePoint keep all arguments", () => {
  it("host fromCharCode(104,105,33) === 'hi!'", async () => {
    expect(await runHost(`export function test(): string { return String.fromCharCode(104, 105, 33); }`)).toBe("hi!");
  });

  it("host fromCodePoint(97, 0x1F600) === 'a😀'", async () => {
    expect(await runHost(`export function test(): string { return String.fromCodePoint(97, 0x1F600); }`)).toBe("a😀");
  });

  it("host fromCharCode evaluates each argument exactly once, in order", async () => {
    expect(
      await runHost(
        `let n = 0; function c(x: number): number { n++; return x; }
         export function test(): number { String.fromCharCode(c(72), c(105), c(33)); return n; }`,
      ),
    ).toBe(3);
  });

  it("native fromCharCode multi-arg length / content", async () => {
    expect(await runFast(`export function test(): number { return String.fromCharCode(104, 105, 33).length; }`)).toBe(
      3,
    );
    expect(
      await runFast(`export function test(): number { return String.fromCharCode(104, 105, 33).charCodeAt(2); }`),
    ).toBe(33);
  });

  it("native fromCodePoint multi-arg concatenates with surrogate pairs", async () => {
    // "a😀" — 'a' (1) + U+1F600 surrogate pair (2) = length 3
    expect(await runFast(`export function test(): number { return String.fromCodePoint(97, 0x1F600).length; }`)).toBe(
      3,
    );
    expect(
      await runFast(`export function test(): number { return String.fromCodePoint(97, 0x1F600).charCodeAt(0); }`),
    ).toBe(97);
    expect(
      await runFast(`export function test(): number { return String.fromCodePoint(97, 0x1F600).charCodeAt(1); }`),
    ).toBe(0xd83d);
  });
});
