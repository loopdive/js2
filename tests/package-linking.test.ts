// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2527 — separately compiled npm function providers.

import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject, instantiateLinkedProject } from "../src/index.js";

function project(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `js2-${prefix}-`));
}

function writePackage(root: string, name: string, source: string): void {
  const packageRoot = join(root, "node_modules", ...name.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, main: "index.ts" }));
  writeFileSync(join(packageRoot, "index.ts"), source);
}

async function compile(root: string, entry: string, cacheDir: string) {
  return compileProject(join(root, entry), {
    allowJs: true,
    emitWat: false,
    packageCacheDir: cacheDir,
  });
}

describe("#2527 npm package module linking", () => {
  it("links an aliased named function and keeps direct instantiate callers working", async () => {
    const root = project("package-link-alias");
    writePackage(root, "fn", "export function add(a: number, b: number): number { return a + b; }\n");
    writeFileSync(
      join(root, "main.ts"),
      'import { add as sum } from "fn"; export function run(): number { return sum(2, 3); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));

    expect(result.success).toBe(true);
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules).toHaveLength(1);
    expect(result.linkedModules?.[0]?.exports).toEqual(["add"]);
    expect(result.linkedModules?.[0]?.exportSignatures?.add).toContain("(a: number, b: number)");
    const moduleImports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
    expect(moduleImports.some((entry) => entry.module.startsWith("js2wasm:npm:fn:") && entry.name === "add")).toBe(
      true,
    );

    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(5);
    // Compatibility contract: callers do not need to know about the provider
    // graph when using the longstanding result.importObject convenience path.
    const direct = await WebAssembly.instantiate(result.binary, result.importObject);
    expect(direct.instance.exports.run?.()).toBe(5);
  });

  it("compiles a package provider once and serves repeated consumers from binary cache", async () => {
    const root = project("package-link-cache");
    writePackage(
      root,
      "cached-fn",
      "// unique cache fixture\nexport function inc(x: number): number { return x + 1; }\n",
    );
    writeFileSync(
      join(root, "first.ts"),
      'import { inc } from "cached-fn"; export function run(): number { return inc(4); }\n',
    );
    writeFileSync(
      join(root, "second.ts"),
      'import { inc as plus } from "cached-fn"; export function run(): number { return plus(8); }\n',
    );
    const cacheDir = join(root, ".cache");

    const first = await compile(root, "first.ts", cacheDir);
    expect(readdirSync(cacheDir).some((name) => name.endsWith(".wasm"))).toBe(true);
    expect(readdirSync(cacheDir).some((name) => name.endsWith(".json"))).toBe(true);
    const second = await compile(root, "second.ts", cacheDir);
    expect(first.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 1, cachedProviders: 0 });
    expect(second.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 0, cachedProviders: 1 });
    expect(second.linkedModules?.[0]?.cacheHit).toBe(true);
    expect(second.linkedModules?.[0]?.exportSignatures?.inc).toContain("(x: number)");
    const linked = await instantiateLinkedProject(second);
    expect(linked.instance.exports.run?.()).toBe(9);
  });

  it("links a package dependency DAG provider-before-consumer", async () => {
    const root = project("package-link-dag");
    writePackage(root, "base-fn", "export function double(x: number): number { return x * 2; }\n");
    writePackage(
      root,
      "top-fn",
      'import { double as scale } from "base-fn"; export function answer(x: number): number { return scale(x) + 1; }\n',
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { answer } from "top-fn"; export function run(): number { return answer(3); }\n',
    );

    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules).toHaveLength(2);
    expect(result.linkedModules?.[0]?.packageName).toBe("base-fn");
    expect(result.linkedModules?.[1]?.packageName).toBe("top-fn");
    expect(result.linkedModules?.[1]?.dependencies).toContain(result.linkedModules?.[0]?.namespace);
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(7);
  });

  it("defers provider initialization until its own runtime is wired and isolates state", async () => {
    const root = project("package-link-lifecycle");
    writePackage(
      root,
      "stateful",
      "let counter = 0; export function next(): number { counter += 1; return counter; }\n",
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { next } from "stateful"; export function run(): number { return next(); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.initExport).toBe("__module_init");

    const first = await instantiateLinkedProject(result);
    const second = await instantiateLinkedProject(result);
    expect(first.instance.exports.run?.()).toBe(1);
    expect(first.instance.exports.run?.()).toBe(2);
    expect(second.instance.exports.run?.()).toBe(1);
  });

  it("builds provider and consumer host/runtime adapters independently", async () => {
    const root = project("package-link-host-runtime");
    writePackage(root, "formatter", "export function format(value: number): string { return value.toFixed(2); }\n");
    writeFileSync(
      join(root, "main.ts"),
      'import { format } from "formatter"; export function run(): string { return format(1.5) + (2.5).toFixed(1); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.providerMetadata?.imports.some((entry) => entry.module === "env")).toBe(true);
    const first = await instantiateLinkedProject(result);
    const second = await instantiateLinkedProject(result);
    expect(first.instance.exports.run?.()).toBe("1.502.5");
    expect(second.instance.exports.run?.()).toBe("1.502.5");
  });

  it("validates provider-only host imports with the provider adapter", async () => {
    const root = project("package-link-provider-host-only");
    writePackage(
      root,
      "formatter-only",
      "export function format(value: number): string { return value.toFixed(2); }\n",
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { format } from "formatter-only"; export function run(): string { return format(1.5); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe("1.50");
  });

  it("falls back monolithically for value/class exports instead of dropping them", async () => {
    const root = project("package-link-boundary");
    writePackage(
      root,
      "mixed",
      "export function add(a: number, b: number): number { return a + b; }\nexport const answer = 42;\nexport class Box {}\n",
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { add } from "mixed"; export function run(): number { return add(2, 3); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("bundled");
    expect(result.linkedModules).toBeUndefined();
    expect(result.linkPlan?.fallbackReason).toMatch(/value|class/i);
    const instance = await WebAssembly.instantiate(result.binary, result.importObject);
    expect(instance.instance.exports.run?.()).toBe(5);
  });

  it("falls back deterministically for package cycles", async () => {
    const root = project("package-link-cycle");
    writePackage(
      root,
      "cycle-a",
      'import { b } from "cycle-b"; export function a(x: number): number { return b(x); }\n',
    );
    writePackage(
      root,
      "cycle-b",
      'import { a } from "cycle-a"; export function b(x: number): number { return x === 0 ? 0 : a(x - 1); }\n',
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { a } from "cycle-a"; export function run(): number { return a(0); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("bundled");
    expect(result.linkPlan?.fallbackReason).toMatch(/cyclic/i);
  });
});
