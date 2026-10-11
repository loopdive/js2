// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A14) `%GeneratorFunction%` residuals in `--target standalone`.
 *
 *  1. DISPATCH: reifying `%GeneratorFunction.prototype%` anywhere in a module
 *     must not break `.next()` on the module's own generators (the opaque
 *     resume dispatcher was reserved twice, re-entrantly, and the protocol
 *     closure kept the `unreachable` placeholder).
 *  2. CLAIM + POISON: `var Generator = Object.getPrototypeOf(function* () {});
 *     Generator.constructor` is `%GeneratorFunction%` too, and a generator it
 *     makes has no own `caller`/`arguments` — reads and writes throw.
 *  3. CARRIER META: `length` / `name` of a realm function reached through the
 *     runtime-eval carrier are configurable own data properties — a real
 *     descriptor, a refused write, and a `delete` that takes effect.
 *  4. PROTOTYPE: `Object.getPrototypeOf(g)` for `var g = GeneratorFunction()`
 *     answers %GeneratorFunction.prototype% (static, like A7's expression arm).
 *
 * Each mechanism has a GUARD: the neighbouring behaviour that must not move.
 */
import { existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  instantiateRuntimeEvalNamespace,
  runtimeEvalProviderCacheKey,
  selectCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";
import {
  buildQuickjsAdapterSource,
  quickjsAdapterCachePath,
  quickjsArtifactCacheDir,
  quickjsArtifactCacheKey,
  readQuickjsArtifact,
} from "../scripts/quickjs-eval-provider.mjs";

const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";
const ENGINE_ENV = "JS2WASM_EVAL_ENGINE";

async function compileStandalone(source: string, fileName = "issue-6651-a14.ts") {
  const result = await compile(source, {
    fileName,
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone",
  });
  if (!result.success) throw new Error(String(result.errors?.[0]?.message));
  return result;
}

function importNames(binary: Uint8Array): string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(binary))
    .map((i) => `${i.module}::${i.name}`)
    .sort();
}

describe("#6651 A14 — generator resume dispatch beside a reified %GeneratorFunction.prototype%", () => {
  async function run(source: string): Promise<number> {
    const result = await compileStandalone(source);
    expect(result.imports).toEqual([]);
    expect(importNames(result.binary)).toEqual([]);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {});
    return (instance.exports as { probe: () => number }).probe();
  }

  it("`.next()` on a generator works after the intrinsic is read (was `unreachable`)", async () => {
    expect(
      await run(`
        var GP = Object.getPrototypeOf(function* () {});
        function* w() { yield 7; }
        export function probe(): number { var r: any = w().next(); return r.value; }
      `),
    ).toBe(7);
  });

  it("…and inside a generator body that reads it", async () => {
    expect(
      await run(`
        var w: any = function* () { Object.getPrototypeOf(function* () {}); yield 11; };
        export function probe(): number { var r: any = w().next(); return r.value; }
      `),
    ).toBe(11);
  });

  it("GUARD: a module that never reads the intrinsic is unchanged", async () => {
    expect(
      await run(`
        function* w() { yield 7; yield 8; }
        export function probe(): number { var it: any = w(); it.next(); var r: any = it.next(); return r.value; }
      `),
    ).toBe(8);
  });
});

describe("#6651 A14 — `Generator.constructor` is claimed like the one-expression spelling", () => {
  const TWO_HOP = "var Generator = Object.getPrototypeOf(function* () {});\nvar GF = Generator.constructor;\n";

  it("`new GF()` through the two-binding spelling links the two provider entries", async () => {
    const result = await compileStandalone(`${TWO_HOP}var g = new GF();\n`, "issue-6651-a14.js");
    expect(importNames(result.binary)).toEqual([
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_apply_interpreted`,
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_indirect_eval`,
    ]);
  });

  it("GUARD: a reassigned `Generator` binding is not claimed", async () => {
    const result = await compileStandalone(
      `${TWO_HOP}Generator = Object.getPrototypeOf(function () {});\nvar g = new GF();\n`,
      "issue-6651-a14.js",
    );
    expect(importNames(result.binary)).toEqual([]);
  });
});

function quickjsProviderAvailable(): string | null {
  try {
    const cacheDir = defaultRuntimeEvalProviderCacheDir();
    const artifactDir =
      process.env.JS2WASM_QUICKJS_ARTIFACT_DIR ?? quickjsArtifactCacheDir(cacheDir, quickjsArtifactCacheKey());
    const artifact = readQuickjsArtifact(artifactDir);
    if (!artifact) return null;
    const key = runtimeEvalProviderCacheKey(buildQuickjsAdapterSource(artifact.abi), computeCompilerBundleHash());
    return existsSync(quickjsAdapterCachePath(cacheDir, key)) ? artifactDir : null;
  } catch {
    return null;
  }
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const SOURCE = `
  var GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
  var Generator = Object.getPrototypeOf(function* () {});
  var GF2 = Generator.constructor;

  // Descriptor flags as one number: value*100 + w + 2e + 4c, -1 when absent.
  function d(o: any, k: string): number {
    var desc: any = Object.getOwnPropertyDescriptor(o, k);
    if (desc === undefined) return -1;
    return (desc.writable ? 1 : 0) + (desc.enumerable ? 2 : 0) + (desc.configurable ? 4 : 0) +
      (typeof desc.value === "number" ? 100 * desc.value : 0) + (typeof desc.value === "string" ? 1000 : 0);
  }

  // (2) no own caller/arguments; reads and writes hit %ThrowTypeError%.
  var poisoned = new GF2();
  var ownCaller = poisoned.hasOwnProperty("caller") ? 1 : 0;
  function throwsType(f: () => void): number { try { f(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }
  var poison = throwsType(function () { return poisoned.caller; }) + 10 * throwsType(function () { poisoned.caller = {}; }) +
    100 * throwsType(function () { return poisoned.arguments; }) + 1000 * throwsType(function () { poisoned.arguments = {}; });
  // GUARD: a sloppy ordinary function still reads \`caller\` without throwing.
  function sloppy() {}
  var sloppyCaller = throwsType(function () { return (sloppy as any).caller; });

  // (3) length / name through the carrier.
  var f: any = GeneratorFunction("a", "b", "");
  var g: any = GeneratorFunction();
  var lengthDesc = d(f, "length");
  var nameDesc = d(g, "name");
  f.length = 9;
  var afterWrite = f.length;
  var enumerated = 0;
  for (var k in f) { if (k === "length") enumerated++; }
  var deleted = (delete f.length ? 1 : 0) + (f.hasOwnProperty("length") ? 10 : 0) + (d(f, "length") === -1 ? 100 : 0);
  var deletedName = (delete g.name ? 1 : 0) + (g.hasOwnProperty("name") ? 10 : 0) + (d(g, "name") === -1 ? 100 : 0);
  // GUARD: the A9-seeded \`prototype\` keeps {w:T, e:F, c:F}; an absent key stays absent.
  var h: any = GeneratorFunction();
  var protoDesc = d(h, "prototype");
  var absent = d(h, "foo");

  // (4) [[Prototype]] of the product is %GeneratorFunction.prototype%.
  var inst: any = GeneratorFunction();
  var protoLink = (Object.getPrototypeOf(inst) === GeneratorFunction.prototype ? 1 : 0) +
    (Object.getPrototypeOf(inst.prototype) === Object.getPrototypeOf(inst).prototype ? 10 : 0);
  // GUARD: a binding handed to setPrototypeOf is not folded.
  var moved: any = GeneratorFunction();
  Object.setPrototypeOf(moved, {});
  var movedFolded = Object.getPrototypeOf(moved) === GeneratorFunction.prototype ? 1 : 0;

  export function ownCallerProbe(): number { return ownCaller; }
  export function poisonProbe(): number { return poison; }
  export function sloppyCallerProbe(): number { return sloppyCaller; }
  export function lengthDescProbe(): number { return lengthDesc; }
  export function nameDescProbe(): number { return nameDesc; }
  export function afterWriteProbe(): number { return afterWrite; }
  export function enumeratedProbe(): number { return enumerated; }
  export function deletedProbe(): number { return deleted; }
  export function deletedNameProbe(): number { return deletedName; }
  export function protoDescProbe(): number { return protoDesc; }
  export function absentProbe(): number { return absent; }
  export function protoLinkProbe(): number { return protoLink; }
  export function movedFoldedProbe(): number { return movedFolded; }
`;

const availableArtifactDir = quickjsProviderAvailable();
const enabled = process.env[ENGINE_ENV] === "quickjs" || availableArtifactDir !== null;

describe.skipIf(!enabled)("#6651 A14 — %GeneratorFunction% products through the QuickJS realm", () => {
  let probe: Record<string, () => number>;

  beforeAll(async () => {
    const selection = withEnv(
      {
        [ENGINE_ENV]: "quickjs",
        ...(availableArtifactDir ? { JS2WASM_QUICKJS_ARTIFACT_DIR: availableArtifactDir } : {}),
      },
      () => selectCachedRuntimeEvalProvider(),
    ) as { engine?: string; bundle?: unknown };
    expect(selection.engine).toBe("quickjs");
    const compiled = await compile(SOURCE, {
      target: "standalone" as const,
      experimentalIR: false,
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      fileName: "issue-6651-a14-genfn-residuals.ts",
    });
    if (!compiled.success) throw new Error(String(compiled.errors?.[0]?.message));
    const module = new WebAssembly.Module(compiled.binary!);
    const instance = new WebAssembly.Instance(module, {
      [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(selection.bundle),
    });
    (instance.exports as { _start?: () => void })._start?.();
    probe = instance.exports as unknown as Record<string, () => number>;
  }, 180_000);

  it("a dynamic generator has no own `caller`", () => {
    expect(probe.ownCallerProbe!()).toBe(0);
  });
  it("`caller` / `arguments` reads and writes throw TypeError", () => {
    expect(probe.poisonProbe!()).toBe(1111);
  });
  it("GUARD: a sloppy ordinary function's `caller` read does not throw", () => {
    expect(probe.sloppyCallerProbe!()).toBe(0);
  });
  it("`length` is an own {w:F, e:F, c:T} data property with the realm's value", () => {
    expect(probe.lengthDescProbe!()).toBe(200 + 4);
  });
  it("`name` is an own {w:F, e:F, c:T} string data property", () => {
    expect(probe.nameDescProbe!()).toBe(1000 + 4);
  });
  it("a write to `length` is refused", () => {
    expect(probe.afterWriteProbe!()).toBe(2);
  });
  it("`length` is not enumerable", () => {
    expect(probe.enumeratedProbe!()).toBe(0);
  });
  it("`delete f.length` removes the own property", () => {
    expect(probe.deletedProbe!()).toBe(1 + 100);
  });
  it("`delete g.name` removes the own property", () => {
    expect(probe.deletedNameProbe!()).toBe(1 + 100);
  });
  it("GUARD: the seeded `prototype` keeps {w:T, e:F, c:F}", () => {
    expect(probe.protoDescProbe!()).toBe(1);
  });
  it("GUARD: a key the function does not own stays absent", () => {
    expect(probe.absentProbe!()).toBe(-1);
  });
  it("`Object.getPrototypeOf(GeneratorFunction())` is %GeneratorFunction.prototype%", () => {
    expect(probe.protoLinkProbe!()).toBe(11);
  });
  it("GUARD: a binding passed to `Object.setPrototypeOf` is not folded", () => {
    expect(probe.movedFoldedProbe!()).toBe(0);
  });
});
