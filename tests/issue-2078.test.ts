import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2078 — a derived class's explicit `super()` must replay the base
// constructor BODY's `this.<field> = <expr>` assignments. Previously only field
// initializers + positional super(args) were applied, so `class A { x;
// constructor(){ this.x = 1; } }` left `this.x` at 0 in the subclass.
async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const env = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(env, `standalone leaked env imports: ${env.join(", ")}`).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

async function runHost(source: string): Promise<number> {
  const r = await compile(source);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as Record<string, () => number>).run();
}

const POST_SUPER = `
class A { x: number; constructor(){ this.x = 1; } }
class B extends A { y: number; constructor(){ super(); this.y = this.x + 1; } }
export function run(): number { return new B().y; }`; // 2

const BASE_FIELD = `
class A { x: number; constructor(){ this.x = 1; } }
class B extends A { y: number; constructor(){ super(); this.y = 99; } }
export function run(): number { return new B().x; }`; // 1

const METHOD_READ = `
class A { x: number; constructor(){ this.x = 1; } }
class B extends A { y: number; constructor(){ super(); this.y = 5; } getSum(): number { return this.x + this.y; } }
export function run(): number { return new B().getSum(); }`; // 6

const MULTILEVEL = `
class A { x: number; constructor(){ this.x = 1; } }
class B extends A { y: number; constructor(){ super(); this.y = this.x + 1; } }
class C extends B { z: number; constructor(){ super(); this.z = this.x + this.y + 1; } }
export function run(): number { const c = new C(); return c.x * 100 + c.y * 10 + c.z; }`; // 124

const MIXED = `
class A { x: number = 7; w: number; constructor(){ this.w = this.x + 3; } }
class B extends A { y: number; constructor(){ super(); this.y = this.w; } }
export function run(): number { const b = new B(); return b.x * 100 + b.w * 10 + b.y; }`; // 810

describe("#2078 — explicit super() replays base ctor body assignments (standalone)", () => {
  it("post-super this.x read returns 2", async () => expect(await runStandalone(POST_SUPER)).toBe(2));
  it("direct base-field read returns 1", async () => expect(await runStandalone(BASE_FIELD)).toBe(1));
  it("method read of base field returns 6", async () => expect(await runStandalone(METHOD_READ)).toBe(6));
  it("multi-level A->B->C chain returns 124", async () => expect(await runStandalone(MULTILEVEL)).toBe(124));
  it("mixed field-initializer + body assignment returns 810", async () => expect(await runStandalone(MIXED)).toBe(810));
});

describe("#2078 — host mode unchanged", () => {
  it("post-super this.x read returns 2", async () => expect(await runHost(POST_SUPER)).toBe(2));
  it("multi-level A->B->C chain returns 124", async () => expect(await runHost(MULTILEVEL)).toBe(124));
  it("mixed field-initializer + body assignment returns 810", async () => expect(await runHost(MIXED)).toBe(810));
});
