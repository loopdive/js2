// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3494 — standalone import() with no host loader. A literal specifier naming a
// module of the compiled graph that is evaluated before its importer resolves
// to that module's namespace object through a native Promise; every other
// import() (non-literal, outside the graph, not yet evaluated, asynchronous
// graph, import options) settles as a rejected Promise carrying a TypeError.
// Neither path may import env.__dynamic_import.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

type Result = Awaited<ReturnType<typeof compileMulti>>;

function importNames(result: Result): string[] {
  return result.imports.map((entry) => `${entry.module}.${entry.name}`);
}

async function runStandalone(result: Result): Promise<number> {
  expect(result.success, result.errors.map((error) => `${error.file}:${error.line} ${error.message}`).join("\n")).toBe(
    true,
  );
  expect(importNames(result)).not.toContain("env.__dynamic_import");
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, () => number>;
  exports.__module_init?.();
  exports.__drain_microtasks?.();
  return exports.result!();
}

function compileGraph(main: string, extra: Record<string, string> = {}): Promise<Result> {
  return compileMulti({ ...extra, "./main.js": main }, "./main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
}

const DEP = `export const answer = 42;
export function twice(x) { return x * 2; }
export let counter = 1;
export function bump() { counter++; }`;

describe("#3494 standalone dynamic import from the compiled module graph", () => {
  it("resolves an evaluated in-graph module to its namespace with live bindings", async () => {
    const result = await compileGraph(
      `import { bump } from "./dep.js";
       let out = 0;
       export function result() { return out; }
       function load() { return import("./dep.js"); }
       load().then((ns) => {
         bump();
         out = ns.answer * 1000 + ns.twice(4) * 10 + ns.counter + Object.keys(ns).length * 100000;
       }, () => { out = -1; });`,
      { "./dep.js": DEP },
    );
    // 4 exports, answer 42, twice(4) = 8, counter read LIVE after bump() = 2.
    expect(await runStandalone(result)).toBe(442082);
  });

  it("returns a fresh Promise per call and one namespace identity per module", async () => {
    const result = await compileGraph(
      `import "./dep.js";
       let out = 0;
       export function result() { return out; }
       const p1 = import("./dep.js");
       const p2 = import("./dep.js");
       Promise.all([p1, p2]).then(([a, b]) => { out = (a === b ? 1 : 0) + (p1 !== p2 ? 10 : 0); }, () => { out = -1; });`,
      { "./dep.js": DEP },
    );
    expect(await runStandalone(result)).toBe(11);
  });

  it.each([
    {
      name: "top-level await",
      main: `import "./dep.js";
             const ns = await import("./dep.js");
             export function result() { return ns.answer; }`,
      expected: 42,
    },
    {
      name: "an async function",
      main: `import "./dep.js";
             let out = 0;
             export function result() { return out; }
             async function go() { const ns = await import("./dep.js"); out = ns.twice(5); }
             go();`,
      expected: 10,
    },
    {
      name: "an object getter",
      main: `import "./dep.js";
             let out = 0;
             export function result() { return out; }
             const holder = { get lazy() { return import("./dep.js").then((m) => m.answer); } };
             holder.lazy.then((value) => { out = value; });`,
      expected: 42,
    },
  ])("resolves from $name", async ({ main, expected }) => {
    expect(await runStandalone(await compileGraph(main, { "./dep.js": DEP }))).toBe(expected);
  });

  it.each([
    {
      name: "a Node builtin outside the graph (lru-cache shape)",
      main: `import("node:diagnostics_channel").then(() => { out = -9; }).catch((e) => { out = e instanceof TypeError ? 7 : -7; });`,
    },
    {
      name: "a missing relative module",
      main: `import("./missing.js").then(() => { out = -9; }, (e) => { out = e instanceof TypeError ? 7 : -7; });`,
    },
    {
      name: "a non-literal specifier",
      main: `const name = "./dep" + ".js";
             import(name).then(() => { out = -9; }, (e) => { out = e instanceof TypeError ? 7 : -7; });`,
    },
    {
      name: "a self-import that is still evaluating",
      main: `export const late = 1;
             import("./main.js").then(() => { out = -9; }, (e) => { out = e instanceof TypeError ? 7 : -7; });`,
    },
    {
      name: "import options",
      main: `import("./dep.js", { with: { type: "json" } }).then(() => { out = -9; }, (e) => { out = e instanceof TypeError ? 7 : -7; });`,
    },
  ])("rejects $name with a TypeError instead of failing the compile", async ({ main }) => {
    const result = await compileGraph(
      `import "./dep.js";
       let out = 0;
       export function result() { return out; }
       ${main}`,
      { "./dep.js": DEP },
    );
    expect(await runStandalone(result)).toBe(7);
  });

  it("rejects a target whose graph prefix uses top-level await", async () => {
    const result = await compileGraph(
      `import "./parent.js";
       let out = 0;
       export function result() { return out; }
       import("./parent.js").then(() => { out = -9; }, (e) => { out = e instanceof TypeError ? 7 : -7; });`,
      { "./tla.js": `await 0;`, "./parent.js": `import "./tla.js"; export const parent = 1;` },
    );
    expect(await runStandalone(result)).toBe(7);
  });

  it("evaluates the specifier synchronously, so its throw is not a rejection", async () => {
    const result = await compileGraph(
      `let out = 0;
       export function result() { return out; }
       function boom() { throw new RangeError("specifier"); }
       try { import(boom()); out = -3; } catch (e) { out = e instanceof RangeError ? 5 : -5; }`,
    );
    expect(await runStandalone(result)).toBe(5);
  });

  it("compiles standalone single-source import() to a rejected Promise", async () => {
    const result = await compile(
      `let out = 0;
       export function result() { return out; }
       import("./target.js").then(() => { out = -9; }, (e) => { out = e instanceof TypeError ? 7 : -7; });`,
      { target: "standalone" },
    );
    expect(await runStandalone(result)).toBe(7);
  });

  it("preserves the existing host dynamic-import lowering", async () => {
    const result = await compileMulti(
      {
        "entry.ts": `export function run(): void { void import("./target.ts"); }`,
        "target.ts": `export {};`,
      },
      "entry.ts",
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(importNames(result)).toContain("env.__dynamic_import");
  });
});
