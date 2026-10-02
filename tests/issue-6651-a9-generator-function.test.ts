// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 A9) `%GeneratorFunction%` called or constructed in `--target standalone`.
 *
 * Two halves:
 *
 *  1. STRUCTURAL (always runs): which modules link the runtime-eval provider.
 *     A claimed `GeneratorFunction(…)` site imports exactly the two provider
 *     entries it uses and nothing else; a module that only READS the intrinsic,
 *     one compiled with `runtimeEvalProvider: false`, and one whose binding is
 *     reassigned are not claimed and import nothing.
 *  2. BEHAVIOURAL (self-gating, like the other QuickJS lanes): the provider is
 *     linked and every expectation is a value only the realm's
 *     CreateDynamicFunction can produce — a body compiled from a runtime-built
 *     string, driven through `.next()` / `for-of` / spread from compiled code.
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
const GF = "var GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;";

async function importsOf(source: string, extra: Record<string, unknown> = {}): Promise<string[]> {
  const result = await compile(source, {
    fileName: "issue-6651-a9.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone",
    ...extra,
  });
  if (!result.success) throw new Error(String(result.errors?.[0]?.message));
  const module = new WebAssembly.Module(result.binary!);
  return WebAssembly.Module.imports(module)
    .map((i) => `${i.module}::${i.name}`)
    .sort();
}

describe("#6651 A9 — which modules link the provider for %GeneratorFunction%", () => {
  it("a claimed call imports exactly the two provider entries it uses", async () => {
    expect(await importsOf(`${GF}\nvar g = GeneratorFunction("yield 1;");\n`)).toEqual([
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_apply_interpreted`,
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_indirect_eval`,
    ]);
  });

  it("`new %GeneratorFunction%()` is claimed the same way", async () => {
    expect(await importsOf(`${GF}\nvar g = new GeneratorFunction();\n`)).toEqual([
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_apply_interpreted`,
      `${RUNTIME_EVAL_IMPORT_MODULE}::__runtime_indirect_eval`,
    ]);
  });

  it("CONTROL: only reading the intrinsic links nothing", async () => {
    expect(await importsOf(`${GF}\nvar n = GeneratorFunction.length + GeneratorFunction.name;\n`)).toEqual([]);
  });

  it("CONTROL: `runtimeEvalProvider: false` leaves the site unclaimed", async () => {
    expect(await importsOf(`${GF}\nvar g = GeneratorFunction("yield 1;");\n`, { runtimeEvalProvider: false })).toEqual(
      [],
    );
  });

  it("CONTROL: a reassigned binding is not claimed", async () => {
    expect(
      await importsOf(
        `${GF}\nGeneratorFunction = function () { return 1; };\nvar g = GeneratorFunction("yield 1;");\n`,
      ),
    ).toEqual([]);
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

// Every source string is composed at run time so nothing is constant-folded.
const SOURCE = `
  ${GF}
  function join(parts: string[]): string {
    var out = "";
    for (var i = 0; i < parts.length; i += 1) out = out + parts[i];
    return out;
  }

  // Parameters and body cross as runtime strings; the realm parses them.
  var sum = -1;
  try {
    var g1: any = GeneratorFunction("a", "b", join(["yield a", " + b;"]));
    var it1: any = g1(20, 22);
    var first: any = it1.next();
    var last: any = it1.next();
    sum = first.value * 10 + (first.done ? 1000 : 0) + (last.done ? 1 : 0) + (typeof last.value === "undefined" ? 2 : 0);
  } catch (e) {}

  // \`new\` is the same CreateDynamicFunction; an empty body completes at once.
  var constructed = -1;
  try {
    var g2: any = new GeneratorFunction();
    var r2: any = g2().next();
    constructed = (r2.done ? 1 : 0) + (typeof r2.value === "undefined" ? 2 : 0);
  } catch (e) {}

  // §20.2.1.1.1: \`yield\` in the parameters of a generator is a SyntaxError.
  var early = 0;
  try { GeneratorFunction(join(["x = ", "yield"]), ""); } catch (e) { early = e instanceof SyntaxError ? 1 : 2; }

  // §27.3.4: a generator function has no [[Construct]].
  var noConstruct = 0;
  var inst: any = GeneratorFunction();
  try { new inst(); } catch (e) { noConstruct = e instanceof TypeError ? 1 : 2; }

  // §20.2.1.1.1 step 34: own \`prototype\`, [[Prototype]] %GeneratorPrototype%.
  var gp = Object.getPrototypeOf(function* () {}).prototype;
  var pd: any = Object.getOwnPropertyDescriptor(inst, "prototype");
  var proto = (Object.getPrototypeOf(inst.prototype) === gp ? 1 : 0) +
    (pd.writable ? 2 : 0) + (pd.enumerable ? 0 : 4) + (pd.configurable ? 0 : 8);

  // The realm's generator objects are driven from compiled code.
  var g3: any = GeneratorFunction("n", join(["for (var i = 1; i <= n; i++) yield i * 11;"]));
  var total = 0;
  for (var v of g3(3)) total = total + v;           // 11 + 22 + 33
  var spread: any = [...g3(2)];                      // [11, 22]
  var it3: any = g3(5);
  it3.next();
  var ret: any = it3.return(7);
  var iterated = total * 1000 + spread.length * 100 + spread[1] + (ret.value === 7 && ret.done ? 10000000 : 0);

  export function sumProbe(): number { return sum; }
  export function constructedProbe(): number { return constructed; }
  export function earlyProbe(): number { return early; }
  export function noConstructProbe(): number { return noConstruct; }
  export function protoProbe(): number { return proto; }
  export function iteratedProbe(): number { return iterated; }
`;

const availableArtifactDir = quickjsProviderAvailable();
const enabled = process.env[ENGINE_ENV] === "quickjs" || availableArtifactDir !== null;

describe.skipIf(!enabled)("#6651 A9 — %GeneratorFunction% through the QuickJS realm", () => {
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
      fileName: "issue-6651-a9-generator-function.ts",
    });
    if (!compiled.success) throw new Error(String(compiled.errors?.[0]?.message));
    const module = new WebAssembly.Module(compiled.binary!);
    expect(WebAssembly.Module.imports(module).some((i) => i.module === RUNTIME_EVAL_IMPORT_MODULE)).toBe(true);
    const instance = new WebAssembly.Instance(module, {
      [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(selection.bundle),
    });
    (instance.exports as { _start?: () => void })._start?.();
    probe = instance.exports as unknown as Record<string, () => number>;
  }, 180_000);

  it("CreateDynamicFunction runs the runtime-built body with the caller's arguments", () => {
    expect(probe.sumProbe!()).toBe(420 + 1 + 2);
  });
  it("`new GeneratorFunction()` makes a generator that completes at once", () => {
    expect(probe.constructedProbe!()).toBe(3);
  });
  it("`yield` in the parameter list is a SyntaxError", () => {
    expect(probe.earlyProbe!()).toBe(1);
  });
  it("a dynamic generator function is not a constructor", () => {
    expect(probe.noConstructProbe!()).toBe(1);
  });
  it("its own `prototype` inherits from %GeneratorPrototype% with {w:T, e:F, c:F}", () => {
    expect(probe.protoProbe!()).toBe(1 + 2 + 4 + 8);
  });
  it("its generator objects drive `for-of`, spread and `return` from compiled code", () => {
    expect(probe.iteratedProbe!()).toBe(10000000 + 66 * 1000 + 200 + 22);
  });
});
