// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7090 — `Promise.withResolvers()` on the native `$Promise` regime.
 *
 * Before: the default gc lane (native-first since #6708), `--target standalone`
 * and native-first refused the call with the #1472 `__get_builtin` codegen
 * error; WASI compiled it with a host-import warning and stubbed the call out.
 * Now `__promise_with_resolvers` builds a pending native promise plus its
 * resolving-function pair (the same capability `new Promise(executor)` makes,
 * without an executor) and returns `{ promise, resolve, reject }`.
 *
 * Subclass receivers (`Promise.withResolvers.call(Sub)`) are #7089.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "native-first" | "standalone";

async function run(source: string, lane: Lane): Promise<unknown> {
  const result = await compile(source, {
    fileName: `issue-7090-${lane}.ts`,
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
  const exports = wrapCompiledExports(result, instance) as { main(): unknown };
  let value = exports.main();
  (instance.exports as { __drain_microtasks?: () => void }).__drain_microtasks?.();
  if (value && typeof (value as Promise<unknown>).then === "function") value = await value;
  return value;
}

/** The same source evaluated by Node, as an async function body. */
async function node(body: string): Promise<unknown> {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (b: string) => () => Promise<unknown>;
  return new AsyncFunction(body.replace(/: (number|any)(?=[\s)=;,])/g, ""))();
}

const program = (body: string) => `export async function main(): Promise<number> {\n${body}\n}`;

// Every case returns a number so the standalone lane (no host string
// boundary) is compared exactly like the JS-environment lane.
const CASES: Record<string, string> = {
  "resolve then await": `
    const { promise, resolve } = Promise.withResolvers();
    resolve(41);
    const v: any = await promise;
    return v + 1;`,
  "reject is observed by then(_, onRejected)": `
    const r = Promise.withResolvers();
    r.reject(7);
    const v: any = await r.promise.then(() => 0, (e: any) => e * 2);
    return v;`,
  "only the first settlement counts": `
    const r = Promise.withResolvers();
    r.resolve(1);
    r.resolve(2);
    r.reject(3);
    const v: any = await r.promise;
    return v;`,
  "a then reaction sees the resolution value": `
    const r = Promise.withResolvers();
    const chained = r.promise.then((v: any) => v * 3);
    r.resolve(5);
    const v: any = await chained;
    return v;`,
  "result is an ordinary object: promise, resolve, reject in order": `
    const r = Promise.withResolvers();
    const keys = Object.keys(r);
    let ok = keys.length === 3 && keys[0] === "promise" && keys[1] === "resolve" && keys[2] === "reject" ? 1 : 0;
    ok = ok * 10 + (r.promise instanceof Promise ? 1 : 0);
    ok = ok * 10 + (typeof r.resolve === "function" && typeof r.reject === "function" ? 1 : 0);
    ok = ok * 10 + (r.resolve.length === 1 && r.reject.length === 1 ? 1 : 0);
    return ok;`,
  "each call makes a fresh capability": `
    const a = Promise.withResolvers();
    const b = Promise.withResolvers();
    a.resolve(1);
    b.resolve(2);
    const x: any = await a.promise;
    const y: any = await b.promise;
    return (a.promise !== b.promise ? 100 : 0) + x * 10 + y;`,
  "a non-constructor this throws TypeError": `
    let caught = 0;
    try {
      Promise.withResolvers.call(86);
    } catch (e) {
      caught = e instanceof TypeError ? 1 : 2;
    }
    return caught;`,
};

// Standalone runs this ordering differently for EVERY native promise (the same
// 13-vs-123 result with `Promise.resolve(0)` in place of withResolvers, measured
// 2026-10-19), so it is a pre-existing standalone await-ordering gap, not a
// withResolvers one; it is checked in the JS environment only.
const JS_ENV_ONLY_CASES: Record<string, string> = {
  "reactions run after the synchronous code, before the await resumes": `
    let order = 0;
    const r = Promise.withResolvers();
    r.promise.then(() => { order = order * 10 + 2; });
    r.resolve(0);
    order = order * 10 + 1;
    await r.promise;
    order = order * 10 + 3;
    return order;`,
};

describe("#7090 Promise.withResolvers on the native regime", () => {
  for (const [name, body] of Object.entries(CASES)) {
    for (const lane of ["native-first", "standalone"] as const) {
      it(`${name} (${lane})`, async () => {
        expect(await run(program(body), lane)).toBe(await node(body));
      });
    }
  }
  for (const [name, body] of Object.entries(JS_ENV_ONLY_CASES)) {
    it(`${name} (native-first)`, async () => {
      expect(await run(program(body), "native-first")).toBe(await node(body));
    });
  }

  it("compiles host-free on --target wasi and on the default lane", async () => {
    const source = program(
      `const { promise, resolve } = Promise.withResolvers(); resolve(1); const v: any = await promise; return v;`,
    );
    const wasi = await compile(source, {
      fileName: "issue-7090-wasi.ts",
      target: "wasi",
      skipSemanticDiagnostics: true,
    });
    expect(wasi.success, wasi.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(wasi.errors).toEqual([]);
    const wasiImports = WebAssembly.Module.imports(new WebAssembly.Module(wasi.binary));
    expect(wasiImports.filter((i) => i.module !== "wasi_snapshot_preview1")).toEqual([]);
    const gc = await compile(source, {
      fileName: "issue-7090-default.ts",
      skipSemanticDiagnostics: true,
    });
    expect(gc.success, gc.errors.map((e) => e.message).join("\n")).toBe(true);
  });
});
