import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, (result as any).importObject ?? { env: {} });
  return (instance.exports as any)[fn](...args);
}

describe("Private accessor setter dispatch (#1680)", () => {
  it("writing a private setter invokes the setter, not a struct-field write", async () => {
    const src = `
      class C {
        #a_: number = 0;
        set #a(v: number) { this.#a_ = v; }
        setA(v: number): void { this.#a = v; }
        getA(): number { return this.#a_; }
      }
      export function test(): number {
        const c = new C();
        c.setA(7);
        return c.getA();
      }
    `;
    expect(await run(src, "test")).toBe(7);
  });

  it("two stacked private setters do not cross-talk", async () => {
    const src = `
      class C {
        #a_: number = 0; #b_: number = 0;
        set #a(v: number) { this.#a_ = v; }
        set #b(v: number) { this.#b_ = v; }
        setA(v: number): void { this.#a = v; }
        setB(v: number): void { this.#b = v; }
        getA(): number { return this.#a_; }
        getB(): number { return this.#b_; }
      }
      export function test(): number {
        const c = new C();
        c.setA(10);
        c.setB(20);
        return c.getA() * 100 + c.getB();
      }
    `;
    expect(await run(src, "test")).toBe(1020);
  });

  it("get/set private accessor pair roundtrips through the backing field", async () => {
    const src = `
      class C {
        #v_: number = 0;
        get #v(): number { return this.#v_; }
        set #v(x: number) { this.#v_ = x; }
        set(x: number): void { this.#v = x; }
        get(): number { return this.#v_; }
      }
      export function test(): number {
        const c = new C();
        c.set(42);
        return c.get();
      }
    `;
    expect(await run(src, "test")).toBe(42);
  });
});
