import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

async function run(source: string) {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile error: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if ((instance.exports as any).__module_init) (instance.exports as any).__module_init();
  return (instance.exports as any).test();
}

// #1999 — compileStringCompoundAssignment ignored boxedCaptures, so string `+=`
// on a closure-captured variable passed the `(struct (mut externref))` ref cell
// straight into js-string concat → "illegal cast" at runtime, or invalid wasm
// (call expected externref, found ref-null) when an i32 index was concatenated.
describe("#1999 string += on a closure-captured variable", () => {
  it("numeric += inside an array HOF callback concatenates as string", async () => {
    expect(
      await run(`export function test(): string {
        let acc = "";
        [1, 2, 3].forEach((x: number) => { acc += x; });
        return acc;
      }`),
    ).toBe("123");
  });

  it("the i32-index CE variant emits valid wasm and concatenates", async () => {
    expect(
      await run(`export function test(): string {
        let s = "";
        const a = [10, 20];
        a.forEach((v: number, i: number) => { s += i + ":" + v; });
        return s;
      }`),
    ).toBe("0:101:20");
  });

  it("string += inside a captured inner function appends", async () => {
    expect(
      await run(`export function test(): string {
        let log = "x";
        function inner(): void { log += "a"; }
        inner();
        return log;
      }`),
    ).toBe("xa");
  });

  it("string += in the outer scope after capture still appends", async () => {
    expect(
      await run(`export function test(): string {
        let acc = "";
        const f = (x: number): void => { acc += x; };
        f(1);
        acc += "Z";
        f(2);
        return acc;
      }`),
    ).toBe("1Z2");
  });

  it("captured string += inside an async function appends", async () => {
    const src = `export async function test(): Promise<string> {
      let log = "";
      async function step(s: string): Promise<void> { log += s; }
      await step("a");
      await step("b");
      return log;
    }`;
    const r = await compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error("compile error: " + r.errors[0]?.message);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    expect(await (instance.exports as any).test()).toBe("ab");
  });

  // Controls — these worked before the fix and must keep working.
  it("control: acc = acc + x inside the same closure", async () => {
    expect(
      await run(`export function test(): string {
        let acc = "";
        [1, 2, 3].forEach((x: number) => { acc = acc + x; });
        return acc;
      }`),
    ).toBe("123");
  });

  it("control: numeric captured += is unchanged", async () => {
    expect(
      await run(`export function test(): number {
        let n = 0;
        [1, 2, 3].forEach((x: number) => { n += x; });
        return n;
      }`),
    ).toBe(6);
  });

  it("control: uncaptured string += is unchanged", async () => {
    expect(
      await run(`export function test(): string {
        let acc = "";
        acc += "a";
        acc += "b";
        return acc;
      }`),
    ).toBe("ab");
  });
});
