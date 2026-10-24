// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7089 — the Promise statics that read their receiver, on the native `$Promise`
 * regime (native-first / default gc, standalone).
 *
 * Before: `Promise.try.call(Sub, fn)` and `Promise.withResolvers.call(Sub)` reached
 * the first-class builtin value closure, which threw "… is not yet implemented in
 * --target standalone"; direct `Promise.try(fn)` was refused at compile time; and the
 * TS-cast spelling `(Promise.all as any).call(Sub, …)` of the combinators missed the
 * class-receiver arms and threw the same way. Now NewPromiseCapability(C) constructs
 * through the subclass (or uses the intrinsic capability for `%Promise%`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";
import { _installPromiseTryPolyfill } from "../src/runtime/promise-try-polyfill.js";

type Lane = "native-first" | "standalone";
const LANES: Lane[] = ["native-first", "standalone"];

process.on("unhandledRejection", () => {});
_installPromiseTryPolyfill(Promise); // Node < 23 reference only; no-op where native.

async function run(source: string, lane: Lane): Promise<unknown> {
  const result = await compile(source, {
    fileName: `issue-7089-${lane}.ts`,
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

/** The same program evaluated by Node (type annotations stripped). */
async function node(prelude: string, body: string): Promise<unknown> {
  const strip = (s: string) =>
    s
      .replace(/: (number|any)(?=[\s)=;,])/g, "")
      .replace(/ as any/g, "")
      .replace(/<any>/g, "");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (b: string) => () => Promise<unknown>;
  return new AsyncFunction(`${strip(prelude)}\n${strip(body)}`)();
}

const PRELUDE = `
let calls = 0;
let executorIsFunction = 0;
class Sub extends Promise<any> {
  constructor(executor: any) {
    super(executor);
    calls += 1;
    if (typeof executor === "function") executorIsFunction = 1;
  }
}
class Plain extends Promise<any> {}
function NotCallable(executor: any) { executor(1, 2); }`;

const program = (body: string) => `${PRELUDE}\nexport async function main(): Promise<number> {\n${body}\n}`;

// Every case returns a number so both lanes compare exactly.
const IDENTITY = (call: string) => `
  calls = 0; executorIsFunction = 0;
  const p: any = ${call};
  return (p instanceof Sub ? 1 : 0) + (p.constructor === Sub ? 2 : 0) + (calls === 1 ? 4 : 0) + (executorIsFunction ? 8 : 0);`;

const CASES: Record<string, string> = {
  "Promise.all.call(Sub, [])": IDENTITY("Promise.all.call(Sub, [])"),
  "Promise.race.call(Sub, [])": IDENTITY("Promise.race.call(Sub, [])"),
  "Promise.any.call(Sub, [])": IDENTITY("Promise.any.call(Sub, [])"),
  "Promise.allSettled.call(Sub, [])": IDENTITY("Promise.allSettled.call(Sub, [])"),
  "Promise.try.call(Sub, fn)": IDENTITY("(Promise as any).try.call(Sub, function () {})"),
  "Promise.withResolvers.call(Sub).promise": IDENTITY("(Promise as any).withResolvers.call(Sub).promise"),
  "TS-cast spelling (Promise.all as any).call(Sub, [])": IDENTITY("(Promise.all as any).call(Sub, [] as any)"),
  "TS-cast spelling (Promise.resolve as any).call(Sub, 1)": IDENTITY("(Promise.resolve as any).call(Sub, 1)"),
  "withResolvers on a default-constructor subclass": `
    const r: any = (Promise as any).withResolvers.call(Plain);
    r.resolve(41);
    const v: any = await r.promise;
    return (r.promise instanceof Plain ? 100 : 0) + v;`,
  "withResolvers.call(Sub): reject settles the subclass promise": `
    const r: any = (Promise as any).withResolvers.call(Sub);
    r.reject(7);
    const v: any = await r.promise.then(() => 0, (e: any) => e * 3);
    return v;`,
  "Promise.try forwards arguments and resolves with the return value": `
    const v: any = await (Promise as any).try(function (a: any, b: any) { return a * 10 + b; }, 4, 2);
    return v;`,
  "Promise.try turns a throw into a rejection": `
    const p: any = (Promise as any).try(function () { throw 9; });
    const v: any = await p.then(() => 0, (e: any) => e + 1);
    return v;`,
  "Promise.try.call(Sub, fn): resolution through the subclass": `
    calls = 0;
    const p: any = (Promise as any).try.call(Sub, function (x: any) { return x + 1; }, 5);
    const constructed = calls; // before the await: its then() species-constructs another Sub
    const v: any = await p;
    return (p instanceof Sub ? 100 : 0) + v * 10 + constructed;`,
  "Promise.try.call(Promise, fn) is the direct form": `
    const v: any = await (Promise as any).try.call(Promise, function (x: any) { return x; }, 3);
    return v;`,
  "a non-callable resolver is a TypeError (withResolvers)": `
    try { (Promise as any).withResolvers.call(NotCallable); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }`,
  "a non-callable resolver is a TypeError (try)": `
    try { (Promise as any).try.call(NotCallable, function () {}); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }`,
};

describe("#7089 — receiver-reading Promise statics on the native regime", () => {
  for (const lane of LANES) {
    for (const [label, body] of Object.entries(CASES)) {
      it(`${lane}: ${label}`, async () => {
        const expected = await node(PRELUDE, body);
        expect(await run(program(body), lane)).toBe(expected);
      });
    }
  }

  it("the IDENTITY cases really assert all four bits", async () => {
    expect(await node(PRELUDE, CASES["Promise.try.call(Sub, fn)"]!)).toBe(15);
  });
});
