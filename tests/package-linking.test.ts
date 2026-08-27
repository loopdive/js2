// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2527 — separately compiled npm function providers.

import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject, decodeBundleManifest, instantiateLinkedProject } from "../src/index.js";

function project(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `js2-${prefix}-`));
}

function writePackage(root: string, name: string, source: string): void {
  writePackageFiles(root, name, { "index.ts": source });
}

function writePackageFiles(root: string, name: string, files: Record<string, string>): void {
  const packageRoot = join(root, "node_modules", ...name.split("/"));
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name, main: "index.ts" }));
  for (const [file, source] of Object.entries(files)) {
    const filePath = join(packageRoot, file);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, source);
  }
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

  it("links a bare package after TypeScript realpaths its node_modules symlink", async () => {
    const root = project("package-link-symlink");
    const physicalRoot = join(root, ".store", "linked-pkg");
    mkdirSync(physicalRoot, { recursive: true });
    writeFileSync(join(physicalRoot, "package.json"), JSON.stringify({ name: "linked-pkg", main: "index.ts" }));
    writeFileSync(join(physicalRoot, "index.ts"), "export function answer(): number { return 42; }\n");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(physicalRoot, join(root, "node_modules", "linked-pkg"), "dir");
    writeFileSync(
      join(root, "main.ts"),
      'import { answer } from "linked-pkg"; export function run(): number { return answer(); }\n',
    );

    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 1 });
    expect(result.linkedModules?.[0]?.packageName).toBe("linked-pkg");
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(42);
  });

  it("returns a failed linked root directly without recompiling provider sources as a bundle", async () => {
    const root = project("package-link-root-failure");
    writePackage(root, "root-failure-provider", "export function limit(): number { return 3; }\n");
    writeFileSync(
      join(root, "main.ts"),
      `import { limit } from "root-failure-provider";
export async function run(): Promise<number> {
  let i = 0;
  try {
    while (i < limit()) {
      await Promise.reject(1);
      i++;
    }
  } catch (error) {
    return error as number;
  }
  return i;
}
`,
    );

    const entry = join(root, "main.ts");
    const cacheDir = join(root, ".cache");
    const compileSeparate = () =>
      compileProject(entry, {
        allowJs: true,
        emitWat: false,
        packageCacheDir: cacheDir,
        packageLinking: "separate",
      });

    const first = await compileSeparate();
    const second = await compileSeparate();

    for (const result of [first, second]) {
      expect(result.success).toBe(false);
      expect(result.errors.some((error) => error.message.includes("#3587"))).toBe(true);
      expect(result.linkPlan?.mode).toBe("separate");
      expect(result.linkPlan?.fallbackReason).toBeUndefined();
      expect(result.linkedModules).toBeUndefined();
    }
    expect(first.linkPlan).toMatchObject({
      mode: "separate",
      compiledProviders: 1,
      cachedProviders: 0,
    });
    expect(second.linkPlan).toMatchObject({
      mode: "separate",
      compiledProviders: 0,
      cachedProviders: 1,
    });

    const automatic = await compile(root, "main.ts", cacheDir);
    expect(automatic.success).toBe(false);
    expect(automatic.linkPlan).toMatchObject({
      mode: "bundled",
      fallbackReason: expect.stringMatching(/linked root compilation failed/i),
    });
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

  it("statically merges cached direct-function providers and embeds the bundle manifest", async () => {
    const root = project("package-link-merge");
    writePackage(root, "merge-base", "export function double(x: number): number { return x * 2; }\n");
    writePackage(
      root,
      "merge-top",
      'import { double } from "merge-base"; export function answer(x: number): number { return double(x) + 1; }\n',
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { answer } from "merge-top"; export function run(): number { return answer(3); }\n',
    );
    const cacheDir = join(root, ".cache");
    const result = await compileProject(join(root, "main.ts"), {
      emitWat: false,
      optimize: 1,
      packageCacheDir: cacheDir,
      packageLinking: "merge",
    });

    expect(result.success).toBe(true);
    expect(result.linkPlan?.mergeFallbackReason).toBeUndefined();
    expect(result.linkPlan).toMatchObject({ mode: "merged", compiledProviders: 2, cachedProviders: 0 });
    expect(result.linkedModules).toBeUndefined();
    expect(result.wat).toBe("");
    expect(result.bundleCacheKey).toMatch(/^[0-9a-f]{64}$/);
    const manifest = decodeBundleManifest(result.binary);
    expect(manifest.providers.map((provider) => provider.packageName)).toEqual(["merge-base", "merge-top"]);
    expect(manifest.providers[1]?.dependencies).toEqual([manifest.providers[0]?.namespace]);
    expect(result.bundleManifest).toEqual(manifest);
    expect(result.stringPool).toEqual(manifest.hostMetadata.stringPool);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
    expect(imports.some((entry) => entry.module.startsWith("js2wasm:npm:"))).toBe(false);
    const exports = WebAssembly.Module.exports(new WebAssembly.Module(result.binary)).map((entry) => entry.name);
    expect(exports).toContain("run");
    expect(exports).not.toContain("answer");
    expect(exports).not.toContain("double");
    const instantiated = await WebAssembly.instantiate(result.binary, result.importObject);
    expect(instantiated.instance.exports.run?.()).toBe(7);

    const cached = await compileProject(join(root, "main.ts"), {
      emitWat: false,
      optimize: 1,
      packageCacheDir: cacheDir,
      packageLinking: "merge",
    });
    expect(cached.linkPlan).toMatchObject({ mode: "merged", compiledProviders: 0, cachedProviders: 2 });
    expect(cached.bundleCacheKey).toBe(result.bundleCacheKey);
  });

  it("reports an explicit separate-module fallback for merge-unsafe JavaScript values", async () => {
    const root = project("package-link-merge-value-fallback");
    writePackage(root, "merge-value", "export const answer = 42;\n");
    writeFileSync(
      join(root, "main.ts"),
      'import { answer } from "merge-value"; export function run(): number { return answer; }\n',
    );
    const result = await compileProject(join(root, "main.ts"), {
      emitWat: false,
      packageCacheDir: join(root, ".cache"),
      packageLinking: "merge",
    });

    expect(result.success).toBe(true);
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkPlan?.mergeFallbackReason).toMatch(/getter JavaScript value boundary/);
    expect(result.linkedModules).toHaveLength(1);
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(42);
  });

  it("links cross-package named/default/star re-exports in dependency order and cache", async () => {
    const root = project("package-link-cross-barrel");
    writePackage(
      root,
      "leaf-fn",
      "export function inc(x: number): number { return x + 1; }\nexport function double(x: number): number { return x * 2; }\nexport default function triple(x: number): number { return x * 3; }\nexport class Unused {}\n",
    );
    writePackage(
      root,
      "barrel-fn",
      'export { inc as plusOne } from "leaf-fn";\nexport { default as timesThree } from "leaf-fn";\nexport * from "leaf-fn";\n',
    );
    writeFileSync(
      join(root, "first.ts"),
      'import { plusOne, timesThree, double } from "barrel-fn"; export function run(): number { return plusOne(2) + timesThree(2) + double(2); }\n',
    );
    writeFileSync(
      join(root, "second.ts"),
      'import { double as twice } from "barrel-fn"; export function run(): number { return twice(5); }\n',
    );
    const cacheDir = join(root, ".cache");
    const first = await compile(root, "first.ts", cacheDir);
    expect(first.linkPlan?.mode).toBe("separate");
    expect(first.linkedModules?.map((artifact) => artifact.packageName)).toEqual(["leaf-fn", "barrel-fn"]);
    expect(first.linkedModules?.[1]?.dependencies).toContain(first.linkedModules?.[0]?.namespace);
    expect(first.linkedModules?.[1]?.exports).toEqual(["double", "plusOne", "timesThree"]);
    const firstLinked = await instantiateLinkedProject(first);
    expect(firstLinked.instance.exports.run?.()).toBe(13);

    const second = await compile(root, "second.ts", cacheDir);
    expect(second.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 0, cachedProviders: 2 });
    expect(second.linkedModules?.every((artifact) => artifact.cacheHit)).toBe(true);
    const secondLinked = await instantiateLinkedProject(second);
    expect(secondLinked.instance.exports.run?.()).toBe(10);
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

  it("links a requested function even when the package also exports unused values/classes", async () => {
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
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.exports).toEqual(["add"]);
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(5);
  });

  it("links a primitive package value through a getter boundary", async () => {
    const root = project("package-link-requested-value");
    writePackage(
      root,
      "mixed-value",
      "export function add(a: number, b: number): number { return a + b; }\nexport const answer = 42;\nexport class Box {}\n",
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { answer } from "mixed-value"; export function run(): number { return answer; }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.exportBoundaries?.answer).toMatchObject({ kind: "getter" });
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(42);
    const direct = await WebAssembly.instantiate(result.binary, result.importObject);
    expect(direct.instance.exports.run?.()).toBe(42);
  });

  it("links a stateful object through one isolated getter value", async () => {
    const root = project("package-link-object-getter");
    writePackage(
      root,
      "object-pkg",
      "export const state = { count: 0, next() { this.count += 1; return this.count; } };\n",
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { state } from "object-pkg"; export function run(): number { return state.next(); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.exportBoundaries?.state).toMatchObject({ kind: "getter" });
    const first = await instantiateLinkedProject(result);
    const second = await instantiateLinkedProject(result);
    expect(first.instance.exports.run?.()).toBe(1);
    expect(first.instance.exports.run?.()).toBe(2);
    expect(second.instance.exports.run?.()).toBe(1);
  });

  it("links exported closures through a getter while preserving calls", async () => {
    const root = project("package-link-closure-getter");
    writePackage(root, "closure-pkg", "export const add = (x: number): number => x + 7;\n");
    writeFileSync(
      join(root, "main.ts"),
      'import { add } from "closure-pkg"; export function run(): number { return add(5); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.exportBoundaries?.add).toMatchObject({ kind: "getter" });
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(12);
  });

  it("links an exported class constructor through an isolated getter", async () => {
    const root = project("package-link-class-getter");
    writePackage(
      root,
      "class-pkg",
      "export class Box { value: number; constructor(value: number) { this.value = value; } get(): number { return this.value; } }\n",
    );
    writeFileSync(
      join(root, "main.ts"),
      'import { Box } from "class-pkg"; export function run(): number { return new Box(9).get(); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.exportBoundaries?.Box).toMatchObject({ kind: "getter" });
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(9);
  });

  it("links a default object value and a complete namespace getter", async () => {
    const root = project("package-link-namespace-getter");
    writePackage(
      root,
      "namespace-pkg",
      "export const answer = 4; export function inc(x: number): number { return x + 1; } export default { answer };\n",
    );
    writeFileSync(
      join(root, "main.ts"),
      'import value, * as ns from "namespace-pkg"; export function run(): number { return value.answer + ns.inc(ns.answer); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.exportBoundaries?.["*"]).toMatchObject({ kind: "namespaceGetter" });
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(9);
  });

  it("falls back for a TypeScript type-position value boundary", async () => {
    const root = project("package-link-type-position");
    writePackage(root, "type-pkg", "export class Box {}\n");
    writeFileSync(
      join(root, "main.ts"),
      'import { Box } from "type-pkg"; let value: Box | undefined; export function run(): number { return value ? 1 : 0; }\n',
    );
    const result = await compileProject(join(root, "main.ts"), {
      allowJs: false,
      emitWat: false,
      packageCacheDir: join(root, ".cache"),
    });
    expect(result.success).toBe(true);
    expect(result.linkPlan?.mode).toBe("bundled");
    expect(result.linkPlan?.fallbackReason).toMatch(/type-position/i);
  });

  it("links relative barrels, aliases, export-star functions, and default re-exports", async () => {
    const root = project("package-link-barrel");
    writePackageFiles(root, "barrel-fn", {
      "index.ts":
        'function local(x: number): number { return x - 1; }\nexport { local as localAlias };\nexport { add as sum } from "./impl";\nexport { default as inc } from "./default";\nexport * from "./more";\nexport const unused = 99;\nexport class Unused {}\n',
      "impl.ts": "export function add(a: number, b: number): number { return a + b; }\n",
      "default.ts": "export default function inc(x: number): number { return x + 1; }\n",
      "more.ts": "export function triple(x: number): number { return x * 3; }\n",
    });
    writeFileSync(
      join(root, "main.ts"),
      'import { sum as add, inc, triple, localAlias } from "barrel-fn"; export function run(): number { return add(2, 3) + inc(4) + triple(2) + localAlias(4); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.exports).toEqual(["inc", "localAlias", "sum", "triple"]);
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(5 + 5 + 6 + 3);
  });

  it("links a direct default function export", async () => {
    const root = project("package-link-default");
    writePackage(root, "default-fn", "export default function scale(x: number): number { return x * 4; }\n");
    writeFileSync(
      join(root, "main.ts"),
      'import scale from "default-fn"; export function run(): number { return scale(3); }\n',
    );
    const result = await compile(root, "main.ts", join(root, ".cache"));
    expect(result.linkPlan?.mode).toBe("separate");
    expect(result.linkedModules?.[0]?.exports).toEqual(["default"]);
    const linked = await instantiateLinkedProject(result);
    expect(linked.instance.exports.run?.()).toBe(12);
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
