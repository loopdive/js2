// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7092 — `%Promise.prototype%`'s data properties read off a native promise.
 *
 * Before: on the native regime (default gc / native-first, standalone) the
 * `$Promise` arm of `__extern_get` answered only `then`/`catch`/`finally`, so
 * `p.constructor` read `undefined`, `p.constructor.resolve(…)` threw,
 * `p[Symbol.toStringTag]` read `undefined` and `Object.prototype.toString.call(p)`
 * answered `"[object Object]"`. Now the arm answers `constructor` with the
 * identity-stable `%Promise%` (the same reference the bare `Promise` value read
 * yields) and `@@toStringTag` with `"Promise"`, through the prototype's live
 * companion when the program wrote or deleted the key.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "native-first" | "standalone";

async function run(body: string, lane: Lane): Promise<unknown> {
  const result = await compile(`export function main(): number {\n${body}\n}`, {
    fileName: `issue-7092-${lane}.ts`,
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : { semanticProviders: "native-first" as const }),
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result) as ReturnType<typeof buildCompiledImports> & {
    setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  if (lane === "standalone") {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  }
  return (wrapCompiledExports(result, instance) as { main(): unknown }).main();
}

/** The same body evaluated by Node in a fresh realm (cases mutate `Promise.prototype`). */
function node(body: string): unknown {
  return runInNewContext(
    `(function () {\n${body
      .replace(/: any/g, "")
      .replace(/ as any/g, "")
      .replace(/<number>/g, "")}\n})()`,
  );
}

// Every case returns a number so both lanes are compared exactly.
const CASES: Record<string, string> = {
  "new Promise: constructor is the intrinsic": `
    const p: any = new Promise((r: any) => r(1));
    return p.constructor === Promise ? 1 : 0;`,
  "untyped receiver": `
    const p = new Promise((r: any) => r(1));
    const id = (x: any) => x;
    return (id(p).constructor === Promise ? 10 : 0) + (typeof id(p).constructor === "function" ? 1 : 0);`,
  "literal element key": `
    const p: any = new Promise((r: any) => r(1));
    return p["constructor"] === Promise ? 1 : 0;`,
  "withResolvers promise": `
    const p: any = Promise.withResolvers().promise;
    return p.constructor === Promise ? 1 : 0;`,
  "Promise.resolve and a then result": `
    const a: any = Promise.resolve(3);
    const b: any = a.then((x: any) => x);
    return (a.constructor === Promise ? 10 : 0) + (b.constructor === Promise ? 1 : 0);`,
  "constructor.resolve is callable": `
    const p: any = new Promise((r: any) => r(1));
    return p.constructor.resolve(4) instanceof Promise ? 1 : 0;`,
  "then and constructor together": `
    const p: any = new Promise((r: any) => r(1));
    return (typeof p.then === "function" ? 10 : 0) + (p.constructor === Promise ? 1 : 0);`,
  "an own constructor shadows": `
    const p: any = new Promise((r: any) => r(1));
    p.constructor = 7;
    return p.constructor === 7 ? 1 : 0;`,
  "an overwritten Promise.prototype.constructor is observed": `
    const p: any = new Promise((r: any) => r(1));
    (Promise.prototype as any).constructor = 5;
    return p.constructor === 5 ? 1 : 0;`,
  "subclass instance answers the subclass": `
    class C extends Promise<number> {}
    const c: any = new C((r: any) => r(1));
    return c.constructor === C ? 1 : 0;`,
  "Symbol.toStringTag": `
    const p: any = new Promise((r: any) => r(1));
    return p[Symbol.toStringTag] === "Promise" ? 1 : 0;`,
  "Object.prototype.toString": `
    const p = new Promise((r: any) => r(1));
    return Object.prototype.toString.call(p) === "[object Promise]" ? 1 : 0;`,
  "a redefined @@toStringTag is observed": `
    const p: any = new Promise((r: any) => r(1));
    Object.defineProperty(Promise.prototype, Symbol.toStringTag, { value: "Xy" });
    return p[Symbol.toStringTag] === "Xy" ? 1 : 0;`,
  "a deleted @@toStringTag falls back to Object": `
    const p = new Promise((r: any) => r(1));
    delete (Promise.prototype as any)[Symbol.toStringTag];
    return Object.prototype.toString.call(p) === "[object Object]" ? 1 : 0;`,
  "other names stay absent": `
    const p: any = new Promise((r: any) => r(1));
    return (p.foo === undefined ? 10 : 0) + (p[Symbol.iterator] === undefined ? 1 : 0);`,
};

describe("#7092 Promise.prototype data properties on a native promise", () => {
  for (const lane of ["native-first", "standalone"] as const) {
    describe(lane, () => {
      for (const [name, body] of Object.entries(CASES)) {
        it(name, async () => {
          expect(await run(body, lane)).toBe(node(body));
        });
      }
    });
  }
});
