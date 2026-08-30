import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { compileProject, ModuleResolver, resolveAllImports } from "../src/index.js";

const fixtureRoots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "js2-consumer-barrel-"));
  fixtureRoots.push(root);
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  return root;
}

function graph(root: string, consumerDrivenBarrels: boolean): Map<string, string> {
  const entry = join(root, "entry.ts");
  const resolver = new ModuleResolver(root, { resolve: { consumerDrivenBarrels } });
  return resolveAllImports(entry, resolver);
}

function graphNames(root: string, consumerDrivenBarrels: boolean): string[] {
  return Array.from(graph(root, consumerDrivenBarrels).keys(), (filePath) => basename(filePath)).sort();
}

function graphContent(contents: ReadonlyMap<string, string>, fileName: string): string {
  return Array.from(contents).find(([filePath]) => basename(filePath) === fileName)?.[1] ?? "";
}

afterEach(() => {
  while (fixtureRoots.length > 0) rmSync(fixtureRoots.pop()!, { recursive: true, force: true });
});

describe("#1058 consumer-driven pure barrels", () => {
  it("keeps the historical complete graph by default and prunes unused named re-exports only when opted in", () => {
    const root = fixture({
      "entry.ts": `import { run } from "./barrel.js"; export function test(): number { return run(); }`,
      "barrel.ts": `export * from "./provider.js"; export * from "./unused.js";`,
      "provider.ts": `import { value } from "./deps.js"; export function run(): number { return value + 1; }`,
      "deps.ts": `export * from "./value.js"; export * from "./unused-dep.js";`,
      "value.ts": `export const value = 41;`,
      "unused.ts": `export const unused = 99;`,
      "unused-dep.ts": `export const unusedDep = 100;`,
    });

    expect(graphNames(root, false)).toEqual([
      "barrel.ts",
      "deps.ts",
      "entry.ts",
      "provider.ts",
      "unused-dep.ts",
      "unused.ts",
      "value.ts",
    ]);
    expect(graphNames(root, true)).toEqual(["barrel.ts", "deps.ts", "entry.ts", "provider.ts", "value.ts"]);
  });

  it("threads aliased imports and re-exports back to the provider's original name", () => {
    const root = fixture({
      "entry.ts": `import { publicRun } from "./barrel.js"; export const test = publicRun;`,
      "barrel.ts": `
        import { run as localRun } from "./provider.js";
        export { localRun as publicRun };
      `,
      "provider.ts": `export function run(): number { return 42; } export function unused(): number { return 0; }`,
    });

    const contents = graph(root, true);
    const provider = graphContent(contents, "provider.ts");
    expect(provider).toContain("function run");
    expect(provider).not.toContain("function unused");
  });

  it("derives statically named demand from a namespace consumer", () => {
    const root = fixture({
      "entry.ts": `import * as api from "./barrel.js"; export function test(): number { return api.used(); }`,
      "barrel.ts": `export * from "./used.js"; export * from "./also-evaluated.js";`,
      "used.ts": `export function used(): number { return 42; }`,
      "also-evaluated.ts": `export const other = 1;`,
    });

    expect(graphNames(root, true)).toEqual(["barrel.ts", "entry.ts", "used.ts"]);
  });

  it("retains the complete barrel for a dynamic namespace consumer", () => {
    const root = fixture({
      "entry.ts": `
        import * as api from "./barrel.js";
        export function test(name: string): number { return (api as any)[name](); }
      `,
      "barrel.ts": `export * from "./used.js"; export * from "./also-evaluated.js";`,
      "used.ts": `export function used(): number { return 42; }`,
      "also-evaluated.ts": `export function other(): number { return 1; }`,
    });

    expect(graphNames(root, true)).toEqual(["also-evaluated.ts", "barrel.ts", "entry.ts", "used.ts"]);
  });

  it("specializes declaration bodies inside a demanded provider", () => {
    const root = fixture({
      "entry.ts": `import { run } from "./provider.js"; export const test = run;`,
      "provider.ts": `
        export function run(input: number): number { return helper(input); }
        function helper(input: number): number { return input + 1; }
        export function unused(): number { return 99; }
      `,
    });

    const contents = graph(root, true);
    const provider = graphContent(contents, "provider.ts");
    expect(provider).toContain("function run");
    expect(provider).toContain("function helper");
    expect(provider).not.toContain("function unused");
  });

  it("retains the transitive heritage of a demanded interface", () => {
    const root = fixture({
      "entry.ts": `
        import { run, type Leaf } from "./provider.js";
        const retainedType: Leaf | undefined = undefined;
        export function test(): number { return retainedType ? 0 : run(); }
      `,
      "provider.ts": `
        export interface Leaf extends Middle { text: string; }
        interface Unrelated { dead: number; }
        interface Middle extends Root { middle: number; }
        interface Root { kind: number; }
        export function run(): number { return 42; }
      `,
    });

    const provider = graphContent(graph(root, true), "provider.ts");
    expect(provider).toContain("interface Leaf");
    expect(provider).toContain("interface Middle");
    expect(provider).toContain("interface Root");
    expect(provider).not.toContain("interface Unrelated");
  });

  it("specializes a static namespace member and drops its now-unused import", () => {
    const root = fixture({
      "entry.ts": `import { Debug } from "./provider.js"; export const test = Debug.assert;`,
      "provider.ts": `
        import {
          deadValue,
          liveValue,
        } from "./dead.js";
        export namespace Debug {
          export function assert(value: boolean): number { return value ? liveValue : 0; }
          export function fail(): number { return deadValue; }
        }
      `,
      "dead.ts": `export const deadValue = 99; export const liveValue = 1;`,
    });

    const contents = graph(root, true);
    expect(Array.from(contents.keys(), (filePath) => basename(filePath)).sort()).toEqual([
      "dead.ts",
      "entry.ts",
      "provider.ts",
    ]);
    const provider = graphContent(contents, "provider.ts");
    expect(provider).toContain("function assert");
    expect(provider).not.toContain("function fail");
    expect(provider).not.toContain("deadValue");
    expect(provider).toContain("liveValue");
    expect(provider.split(/\r?\n/)).toHaveLength(10);
  });

  it("retains outer helpers used by live namespace members without retaining dead-member helpers", async () => {
    const root = fixture({
      "entry.ts": `import { Parser } from "./provider.js"; export function test(): number { return Parser.parse(); }`,
      "provider.ts": `
        export namespace Parser {
          export function parse(): number { return parseWorker(); }
          function parseWorker(): number { return liveHelper() + namespaceOnly(); }
          function namespaceOnly(): number { return 1; }
          export function unused(): number { return deadHelper(); }
          const eagerValue = eagerHelper();
        }
        function liveHelper(): number { return liveLeaf(); }
        function liveLeaf(): number { return 42; }
        function namespaceOnly(): number { return 100; }
        function eagerHelper(): number { return eagerLeaf(); }
        function eagerLeaf(): number { return 7; }
        function deadHelper(): number { return 99; }
      `,
    });

    const contents = graph(root, true);
    const provider = graphContent(contents, "provider.ts");
    expect(provider).toContain("function parse");
    expect(provider).toContain("function parseWorker");
    expect(provider).toContain("function liveHelper");
    expect(provider).toContain("function liveLeaf");
    expect(provider).toContain("function eagerHelper");
    expect(provider).toContain("function eagerLeaf");
    expect(provider.match(/function namespaceOnly/g)).toHaveLength(1);
    expect(provider).not.toContain("function unused");
    expect(provider).not.toContain("function deadHelper");

    const result = await compileProject(join(root, "entry.ts"), {
      skipSemanticDiagnostics: true,
      resolve: { consumerDrivenBarrels: true },
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
    expect((instance.exports.test as () => number)()).toBe(43);
  });

  it("ignores type-only namespace references when tracing runtime member liveness", async () => {
    const root = fixture({
      "entry.ts": `import { Api } from "./provider.js"; export function test(): number { return Api.run(); }`,
      "provider.ts": `
        export namespace Api {
          type Keys = keyof typeof Api;
          const cache: Partial<Record<Keys, unknown>> = {};
          export function run(): number { return 42; }
          export function formatControlFlowGraph(): number {
            const enum BoxCharacter { horizontal = "----" }
            const enum Connection { Up = 1 << 0, Down = 1 << 1, UpDown = Up | Down }
            return BoxCharacter.horizontal.length * 10 + Connection.UpDown;
          }
        }
      `,
    });

    const contents = graph(root, true);
    const provider = graphContent(contents, "provider.ts");
    expect(provider).toContain("const cache");
    expect(provider).toContain("function run");
    expect(provider).not.toContain("type Keys");
    expect(provider).not.toContain("function formatControlFlowGraph");
    expect(provider).not.toContain("const enum");

    const result = await compileProject(join(root, "entry.ts"), {
      skipSemanticDiagnostics: true,
      resolve: { consumerDrivenBarrels: true },
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
    expect((instance.exports.test as () => number)()).toBe(42);
  });

  it("revisits a partially specialized namespace when an outer helper retains its whole value", () => {
    const root = fixture({
      "entry.ts": `import { Api } from "./provider.js"; export const test = Api.run;`,
      "provider.ts": `
        export namespace Api {
          export function run(): number { return outerHelper(); }
          export function retainedAfterEscape(): number { return retainedOuterHelper(); }
        }
        function outerHelper(): number {
          const namespaceValue = Api;
          return namespaceValue ? 42 : 0;
        }
        function retainedOuterHelper(): number { return retainedOuterLeaf(); }
        function retainedOuterLeaf(): number { return 1; }
      `,
    });

    const provider = graphContent(graph(root, true), "provider.ts");
    expect(provider).toContain("function retainedAfterEscape");
    expect(provider).toContain("function retainedOuterHelper");
    expect(provider).toContain("function retainedOuterLeaf");
  });

  it("compiles and executes a transitive named-demand graph with the same dynamic result", async () => {
    const root = fixture({
      "entry.ts": `
        import { run } from "./barrel.js";
        export function test(input: number): number { return run(input); }
      `,
      "barrel.ts": `export * from "./provider.js"; export * from "./unused.js";`,
      "provider.ts": `
        import { value } from "./deps.js";
        export function run(input: number): number { return input + value; }
      `,
      "deps.ts": `export * from "./value.js"; export * from "./unused-dep.js";`,
      "value.ts": `export const value = 41;`,
      "unused.ts": `export const unused = 99;`,
      "unused-dep.ts": `export const unusedDep = 100;`,
    });

    const result = await compileProject(join(root, "entry.ts"), {
      skipSemanticDiagnostics: true,
      resolve: { consumerDrivenBarrels: true },
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
    expect((instance.exports.test as (input: number) => number)(1)).toBe(42);
    expect((instance.exports.test as (input: number) => number)(9)).toBe(50);
  });

  it("initializes an object imported through a cyclic generated-style barrel", async () => {
    const root = fixture({
      "entry.ts": `
        import { parse } from "./parser.js";
        export function test(): number { return parse(); }
      `,
      "barrel.ts": `
        export * from "./diagnostics.js";
        export * from "./parser.js";
      `,
      "diagnostics.ts": `
        export const Diagnostics = {
          invalid_mode: { code: 1456, message: "invalid mode" },
          unused: { code: 9999, message: "unused" },
        };
      `,
      "parser.ts": `
        import { Diagnostics } from "./barrel.js";
        export function parse(): number { return Diagnostics.invalid_mode.code; }
      `,
    });

    const result = await compileProject(join(root, "entry.ts"), {
      skipSemanticDiagnostics: true,
      resolve: { consumerDrivenBarrels: true },
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
    expect((instance.exports.test as () => number)()).toBe(1456);
  });

  it("compiles type-only declarations nested in a runtime namespace", async () => {
    const root = fixture({
      "entry.ts": `
        namespace ParserApi {
          export interface Parsed { statements: number; }
          export type SourceValue = number;
          export function count(source: SourceValue): number {
            return source + 1;
          }
        }
        export function test(input: number): number { return ParserApi.count(input); }
      `,
    });

    const result = await compileProject(join(root, "entry.ts"), {
      skipSemanticDiagnostics: true,
      resolve: { consumerDrivenBarrels: true },
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
