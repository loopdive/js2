import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors?.[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as Record<string, () => unknown>).test?.();
}

// #1330 — RegExp.prototype[Symbol.search] protocol dispatch must work when the
// receiver flows through an `any`-typed variable (the common test262 shape), not
// only when the receiver's static type resolves to RegExp.
describe("#1330 RegExp Symbol.search protocol dispatch", () => {
  it("typed RegExp receiver: re[Symbol.search](s) returns match index", async () => {
    expect(
      await run(`export function test(): number {
        const re: RegExp = /ring/;
        return re[Symbol.search]("a string");
      }`),
    ).toBe(4);
  });

  it("any-typed receiver: re[Symbol.search](s) returns match index", async () => {
    expect(
      await run(`export function test(): number {
        const re: any = /ring/;
        return re[Symbol.search]("a string");
      }`),
    ).toBe(4);
  });

  it("any-typed receiver: no match returns -1", async () => {
    expect(
      await run(`export function test(): number {
        const re: any = /zzz/;
        return re[Symbol.search]("a string");
      }`),
    ).toBe(-1);
  });

  it("any-typed receiver: re[Symbol.match](s) returns captures", async () => {
    expect(
      await run(`export function test(): number {
        const re: any = /r(i)ng/;
        const m: any = re[Symbol.match]("a string");
        return m == null ? -1 : (m[1] === "i" ? 1 : 0);
      }`),
    ).toBe(1);
  });

  it("any-typed receiver: re[Symbol.split](s) splits", async () => {
    expect(
      await run(`export function test(): number {
        const re: any = /,/;
        const parts: any = re[Symbol.split]("a,b,c");
        return parts.length;
      }`),
    ).toBe(3);
  });

  it("String.prototype.search still works (delegates to @@search)", async () => {
    expect(
      await run(`export function test(): number {
        return ("a string" as any).search(/ring/);
      }`),
    ).toBe(4);
  });
});
