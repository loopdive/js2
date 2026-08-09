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
