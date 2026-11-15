// (#3227 S3) `yield* <async generator>` inside an `async function*` drained
// ZERO values: __gen_yield_star (src/runtime.ts) iterated the inner object
// with a sync for...of gated on Symbol.iterator, but async-generator objects
// carry only Symbol.asyncIterator — the outer async gen then reported
// {value: undefined, done: true} on the first .next(). Our async generators
// are eagerly buffered (_AsyncGeneratorState), so the settled values are
// synchronously available: the helper now drains the inner buffer directly
// and rethrows a pendingThrow (§27.6.3.8).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { jsFacingExports } from "./helpers/compile.js";

interface HostRun {
  test: () => unknown;
  getLog: () => string;
}

async function runHost(src: string): Promise<HostRun> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors?.[0]?.message).toBe(true);
  const imports = buildImports(r.imports ?? [], undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary!, imports as unknown as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return jsFacingExports(r, instance) as unknown as HostRun; // (#6979 S7-f) the embedder-facing view
}

const drain = () => new Promise((res) => setTimeout(res, 15));

describe("#3227 S3 — async-gen yield* delegation delivers inner values", () => {
  it("yield* over an inner async generator (was {undefined, true})", async () => {
    const ex = await runHost(`
let log: string = "";
export function getLog(): string { return log; }
async function* inner() { yield 5; }
async function* outer() { yield* inner(); }
export function test(): number {
  outer().next().then((v: any) => { log = "value=" + v.value + ",done=" + v.done; });
  return 0;
}
`);
    ex.test();
    await drain();
    expect(ex.getLog()).toBe("value=5,done=false");
  });

  it("delegated stream exhausts correctly across chained .next()", async () => {
    const ex = await runHost(`
let log: string = "";
export function getLog(): string { return log; }
async function* inner() { yield 1; yield 2; }
async function* outer() { yield* inner(); }
export function test(): number {
  const it = outer();
  it.next().then((a: any) => {
    log = log + "[" + a.value + "," + a.done + "]";
    it.next().then((b: any) => {
      log = log + "[" + b.value + "," + b.done + "]";
      it.next().then((c: any) => {
        log = log + "[" + c.value + "," + c.done + "]";
      });
    });
  });
  return 0;
}
`);
    ex.test();
    await drain();
    expect(ex.getLog()).toBe("[1,false][2,false][undefined,true]");
  });

  it("inner abrupt completion propagates out of the yield* (reject on the outer)", async () => {
    const ex = await runHost(`
let log: string = "";
export function getLog(): string { return log; }
async function* inner() { yield 1; throw new Error("boom"); }
async function* outer() { yield* inner(); }
export function test(): number {
  const it = outer();
  it.next().then((a: any) => {
    log = log + "[" + a.value + "," + a.done + "]";
    it.next().then(
      (b: any) => { log = log + "[" + b.value + "," + b.done + "]"; },
      () => { log = log + "[reject]"; },
    );
  });
  return 0;
}
`);
    ex.test();
    await drain();
    expect(ex.getLog()).toBe("[1,false][reject]");
  });

  // (#6979 S7-f, #7010) This control rode the eager async-generator host
  // buffer, which is retired. The shape has no host-free lowering yet, so it is
  // a compile-time refusal now rather than a `__gen_*` fallback.
  it("yield* await <array> in a static async-gen class method is refused, not host-buffered", async () => {
    const r = await compile(
      `class C {
  static async * m(value: any) { yield * await value; }
}
export function test(): number {
  C.m([1]).next();
  return 0;
}
`,
      { fileName: "test.ts" },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.[0]?.message ?? "").toContain("generator-no-host-free-lowering");
  });
});
