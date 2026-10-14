// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6982 — four native-regime value-semantics defects that surfaced when the
 * default flipped to `native-first` in a JavaScript environment (#6708 slice A):
 *
 *  1. `[Symbol.toPrimitive]` on a class instance in `+` / relationals.
 *  2. `indexOf()` / `lastIndexOf()` with no argument on a `(string | undefined)[]`.
 *  3. `await <settled>` must yield a microtask turn (JS environment).
 *  4. `import.meta.url` must read the loader-injected value (JS environment).
 *
 * Every case runs in the native regime in a JS environment (exports read
 * through `wrapCompiledExports`, as an embedder sees them) AND under
 * `--target standalone`. Results are checked, never WAT shape.
 */
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "native-first" | "standalone";
const LANES: Lane[] = ["native-first", "standalone"];
const META_URL = "file:///example/module.wasm";

async function run(source: string, lane: Lane): Promise<Record<string, any>> {
  const options =
    lane === "standalone" ? { target: "standalone" as const } : { semanticProviders: "native-first" as const };
  const result = (await compile(source, options as never)) as CompileResult;
  expect(result.success, result.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports ?? [], { importMetaUrl: META_URL }, result.stringPool) as any;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return wrapCompiledExports(result, instance);
}

const TO_PRIMITIVE_CLASS = `
class MyNum {
  value: number;
  constructor(v: number) { this.value = v; }
  [Symbol.toPrimitive](hint: string): number { return this.value; }
}
class Hinted {
  value: number;
  constructor(v: number) { this.value = v; }
  [Symbol.toPrimitive](hint: string): number { return hint === "number" ? this.value : -this.value; }
}
`;

describe("#6982 Symbol.toPrimitive on a class operand", () => {
  for (const lane of LANES) {
    it(`a + b calls the method (${lane})`, async () => {
      const ex = await run(
        `${TO_PRIMITIVE_CLASS}
export function test(): number { const a = new MyNum(10); const b = new MyNum(3); return a + b; }`,
        lane,
      );
      expect(ex.test()).toBe(13);
    });

    it(`relational operators call the method (${lane})`, async () => {
      const ex = await run(
        `${TO_PRIMITIVE_CLASS}
export function test(): number {
  const a = new MyNum(5); const b = new MyNum(3);
  return (a > b ? 1 : 0) + (a < b ? 10 : 0) + (a >= b ? 100 : 0) + (a <= b ? 1000 : 0);
}`,
        lane,
      );
      expect(ex.test()).toBe(101);
    });

    it(`+ passes hint "default" and relationals pass hint "number" (${lane})`, async () => {
      const ex = await run(
        `${TO_PRIMITIVE_CLASS}
export function test(): number {
  const a = new Hinted(1); const b = new Hinted(2);
  return (a < b ? 100 : 0) + (a + b);
}`,
        lane,
      );
      // JS: a < b uses hint number (1 < 2), a + b uses hint default (-1 + -2).
      expect(ex.test()).toBe(97);
    });
  }
});

describe("#6982 indexOf()/lastIndexOf() with no argument find an undefined element", () => {
  for (const lane of LANES) {
    it(`indexOf() (${lane})`, async () => {
      const ex = await run(
        `export function test(): number {
  var arr: (string | undefined)[] = ["x", undefined, "z"];
  return arr.indexOf() as number;
}`,
        lane,
      );
      expect(ex.test()).toBe(1);
    });

    it(`lastIndexOf() (${lane})`, async () => {
      const ex = await run(
        `export function test(): number {
  var arr: (string | undefined)[] = ["x", undefined, "z", undefined];
  return arr.lastIndexOf() as number;
}`,
        lane,
      );
      expect(ex.test()).toBe(3);
    });

    it(`agrees with the explicit indexOf(undefined) and answers -1 without one (${lane})`, async () => {
      const ex = await run(
        `export function test(): number {
  var arr: (string | undefined)[] = ["x", undefined, "z"];
  var none: (string | undefined)[] = ["x", "y"];
  return (arr.indexOf() as number) * 10 + (arr.indexOf(undefined) as number) + (none.indexOf() as number) * 100;
}`,
        lane,
      );
      expect(ex.test()).toBe(11 - 100);
    });
  }
});

// `shared`/`log` record what ran before the caller resumed (test) and after the
// microtask checkpoint (after). JS: test() = 1000123, after() = 2012345.
const AWAIT_SETTLED = `
let shared = 0;
let log = 0;
const af = async (): Promise<void> => { shared = 1; await null; shared = 2; };
async function f1(): Promise<void> { log = log * 10 + 1; await null; log = log * 10 + 4; }
async function f2(): Promise<void> { log = log * 10 + 2; await null; log = log * 10 + 5; }
export function test(): number { af(); f1(); f2(); log = log * 10 + 3; return shared * 1000000 + log; }
export function after(): number { return shared * 1000000 + log; }
`;

describe("#6982 await of a settled operand", () => {
  it("yields a microtask turn in a JS environment (native-first)", async () => {
    const ex = await run(AWAIT_SETTLED, "native-first");
    expect(ex.test()).toBe(1000123);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ex.after()).toBe(2012345);
  });

  it("an awaiting async export returns to the caller first (native-first)", async () => {
    const ex = await run(
      `const out: string[] = [];
let shared = 0;
const af = async (): Promise<number> => { shared = 1; await null; shared = 2; return shared; };
export async function test(): Promise<string> {
  const p = af();
  out.push("after-call shared=" + shared);
  const v = await p;
  out.push("resolved v=" + v + " shared=" + shared);
  return out.join(",");
}`,
      "native-first",
    );
    expect(await ex.test()).toBe("after-call shared=1,resolved v=2 shared=2");
  });

  // Host-free embedders keep the synchronous fast path their drain contract
  // relies on (#2865/#2906); the continuations still run to completion.
  it("standalone settles every continuation (host-free fast path kept)", async () => {
    const ex = await run(AWAIT_SETTLED, "standalone");
    ex.test();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Math.floor(ex.after() / 1000000)).toBe(2);
  });
});

describe("#6982 import.meta.url", () => {
  it("reads the loader-injected value in a JS environment (native-first)", async () => {
    const ex = await run(`export function test(): string { const url = import.meta.url; return url; }`, "native-first");
    expect(ex.test()).toBe(META_URL);
  });

  it("is undefined, not a trap, when no loader supplies it (native-first)", async () => {
    const result = (await compile(`export function test(): number { return import.meta.url === undefined ? 1 : 0; }`, {
      semanticProviders: "native-first",
    } as never)) as CompileResult;
    expect(result.success).toBe(true);
    const imports = buildImports(result.imports ?? [], {}, result.stringPool) as any;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect(wrapCompiledExports(result, instance).test()).toBe(1);
  });

  it("standalone keeps its host-free lowering", async () => {
    const ex = await run(
      `export function test(): number { return typeof import.meta === "object" ? 1 : 0; }`,
      "standalone",
    );
    expect(ex.test()).toBe(1);
  });
});
