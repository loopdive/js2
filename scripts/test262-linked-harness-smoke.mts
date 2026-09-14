// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3451 slice 2 — minimal linked-harness smoke.
//
// Compiles the Test262 harness prefix ONCE per include-set as a separately
// linked provider module (the #2527 / Temporal-provider mechanism), compiles
// each test body against it, instantiates the pair, and prints the verdict and
// compile time next to the honest single-module assembly of the same test.
//
// This is a MEASUREMENT harness, not a runner lane: the "honest" column here
// instantiates with a plain import object (no runner sandbox, no negative-test
// or async handling), so only the body-compile timings and the linked/honest
// verdict AGREEMENT are meaningful. See the slice-2 notes in
// plan/issues/3451-linked-harness-wasm-separate-compilation.md for what it
// found.
//
//   pnpm run build:compiler-bundle && pnpm run build:runtime-bundle
//   node --import tsx scripts/test262-linked-harness-smoke.mts test262/test/built-ins/Array/prototype/map 12
//   JS2WASM_LINKED_SMOKE_CACHE=.tmp/linked-smoke   # provider project dir (default)

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ts } from "../src/ts-api.js";
import type { CompileResult, LinkedModuleArtifact } from "../src/index.js";
import { compile, compileMulti, compileProject } from "./compiler-bundle.mjs";
import * as runtimeBundle from "./runtime-bundle.mjs";
import { instantiateTest262Module } from "./test262-import-object.mjs";
import { assembleLinkedHarness } from "../tests/test262-original-harness.js";
import { parseMeta } from "../tests/test262-runner.js";

const CACHE = resolve(process.env.JS2WASM_LINKED_SMOKE_CACHE ?? ".tmp/linked-smoke");
const PKG = "test262-harness-linked";

interface HarnessProvider {
  artifact: LinkedModuleArtifact;
  namespace: string;
  /** harness top-level name → provider getter field */
  getters: Map<string, string>;
  names: string[];
  buildMs: number;
}

/** Top-level `var`/`function`/`class` names of a script — the harness ABI surface. */
function topLevelValueNames(src: string): string[] {
  const sf = ts.createSourceFile("harness.js", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set<string>();
  const bind = (n: ts.BindingName): void => {
    if (ts.isIdentifier(n)) names.add(n.text);
    else for (const e of n.elements) if (ts.isBindingElement(e)) bind(e.name);
  };
  for (const s of sf.statements) {
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name) names.add(s.name.text);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) bind(d.name);
  }
  return [...names];
}

const exportAlias = (name: string): string => `__h_${name.replace(/\$/g, "S_")}`;

const providerCache = new Map<string, HarnessProvider>();

/**
 * Materialise the harness prefix as a synthetic npm package whose `index.js`
 * is the prefix plus `export const __h_<name> = <name>` for every top-level
 * binding (a `const` alias forces a getter boundary so constructors and
 * objects cross as values, not as typed function imports), then compile a
 * probe entry that imports all of them so every boundary is published.
 */
async function buildHarnessProvider(harnessPrefix: string, key: string): Promise<HarnessProvider> {
  const cached = providerCache.get(key);
  if (cached) return cached;
  const started = performance.now();
  const names = topLevelValueNames(harnessPrefix);
  const aliases = names.map(exportAlias);
  const root = join(CACHE, `proj-${key}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "node_modules", PKG), { recursive: true });
  writeFileSync(
    join(root, "node_modules", PKG, "package.json"),
    JSON.stringify({ name: PKG, version: "0.0.0-linked", main: "index.js" }),
  );
  writeFileSync(
    join(root, "node_modules", PKG, "index.js"),
    `${harnessPrefix}\n${names.map((n) => `export const ${exportAlias(n)} = ${n};`).join("\n")}\n`,
  );
  const entry = join(root, "__entry.js");
  writeFileSync(
    entry,
    `import { ${aliases.join(", ")} } from "${PKG}";\n` +
      `export function __probe() { return [${aliases.map((a) => `typeof ${a}`).join(", ")}].length; }\n`,
  );
  const result = await compileProject(entry, {
    allowJs: true,
    emitWat: false,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(CACHE, "providers"),
  });
  if (!result.success) {
    const errors = (result.errors ?? [])
      .slice(0, 3)
      .map((e) => e.message)
      .join("; ");
    throw new Error(`harness provider compile failed: ${errors}`);
  }
  if (result.linkPlan?.mode !== "separate")
    throw new Error(`harness provider not linked separately: ${result.linkPlan?.mode}`);
  const artifact = result.linkedModules?.find((m) => m.packageName === PKG);
  if (!artifact) throw new Error("harness provider artifact missing");
  const getters = new Map<string, string>();
  for (const n of names) {
    const boundary = artifact.exportBoundaries?.[exportAlias(n)];
    if (boundary?.kind === "getter") getters.set(n, boundary.field);
  }
  const provider: HarnessProvider = {
    artifact,
    namespace: artifact.namespace,
    getters,
    names,
    buildMs: performance.now() - started,
  };
  providerCache.set(key, provider);
  return provider;
}

const bodyOptions = {
  allowJs: true,
  fileName: "test.js",
  sourceMap: true,
  sourceMapUrl: "test.wasm.map",
  emitWat: false,
  skipSemanticDiagnostics: true,
  // Mirrors the worker's original-harness lane: an `import` must not make the
  // sloppy variant strict.
  inferModuleStrictArguments: false,
};

function referencedHarnessNames(provider: HarnessProvider, body: string): string[] {
  return provider.names.filter(
    (n) => provider.getters.has(n) && new RegExp(`(?<![\\w$])${n.replace(/[$]/g, "\\$&")}(?![\\w$])`).test(body),
  );
}

async function compileLinkedBody(
  provider: HarnessProvider,
  body: string,
  strict: boolean,
): Promise<{ result: CompileResult; used: string[] }> {
  const used = referencedHarnessNames(provider, body);
  const getters = used.map((n) => provider.getters.get(n) as string);
  const stubKey = "./__js2wasm_harness_stub.ts";
  const stub = `${getters.map((g) => `export declare function ${g}(): any;`).join("\n")}\n`;
  const prelude =
    (strict ? '"use strict";\n' : "") +
    `import { ${getters.join(", ")} } from "./__js2wasm_harness_stub";\n` +
    `${used.map((n, i) => `var ${n} = ${getters[i]}();`).join(" ")}\n`;
  const bindings = new Map(getters.map((g) => [g, { module: provider.namespace, field: g }]));
  const result = await compileMulti({ [stubKey]: stub, "test.js": prelude + body }, "test.js", {
    ...bodyOptions,
    canonicalRuntimeTypes: true,
    sharedExceptionTag: true,
    link: [provider.namespace],
    linkedPackageBindings: bindings,
  });
  (result as { linkedModules?: LinkedModuleArtifact[] }).linkedModules = [provider.artifact];
  return { result, used };
}

async function runVerdict(result: CompileResult): Promise<string> {
  if (!result.success) {
    const errors = (result.errors ?? [])
      .slice(0, 2)
      .map((e) => e.message)
      .join("; ");
    return `compile_error: ${errors.slice(0, 120)}`;
  }
  const importObj = runtimeBundle.buildImports(result.imports, { console }, result.stringPool);
  try {
    await instantiateTest262Module(result.binary, importObj, {
      linkedModules: result.linkedModules ?? [],
      linkedRuntime: runtimeBundle,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error).slice(0, 100)}`;
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node --import tsx scripts/test262-linked-harness-smoke.mts <test262 dir> [count]");
    process.exit(2);
  }
  const count = Number(process.argv[3] ?? 12);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".js") && !f.endsWith("_FIXTURE.js"))
    .slice(0, count);
  let agree = 0;
  let compared = 0;
  for (const f of files) {
    const source = readFileSync(join(dir, f), "utf8");
    const assembly = assembleLinkedHarness(source, parseMeta(source));
    if (assembly.raw) {
      console.log(`${f.padEnd(48)} raw — skipped`);
      continue;
    }
    const key = `${assembly.harnessParts.map((p) => p.name).join("+")}-${assembly.harnessPrefix.length}`.replace(
      /[^\w+.-]/g,
      "_",
    );
    let provider: HarnessProvider;
    try {
      provider = await buildHarnessProvider(assembly.harnessPrefix, key);
    } catch (error) {
      console.log(`${f.padEnd(48)} PROVIDER FAIL ${(error as Error).message}`);
      continue;
    }
    let started = performance.now();
    const honest = await compile(assembly.harnessPrefix + assembly.primary.bodySource, bodyOptions);
    const honestMs = performance.now() - started;
    const honestVerdict = await runVerdict(honest);
    started = performance.now();
    const { result: linked, used } = await compileLinkedBody(provider, assembly.primary.body, assembly.primary.strict);
    const linkedMs = performance.now() - started;
    const linkedVerdict = await runVerdict(linked);
    compared++;
    if (honestVerdict.split(":")[0] === linkedVerdict.split(":")[0]) agree++;
    console.log(
      `${f.padEnd(48)} honest ${honestMs.toFixed(0).padStart(5)}ms ${honestVerdict.slice(0, 40).padEnd(40)} | ` +
        `linked ${linkedMs.toFixed(0).padStart(5)}ms ${linkedVerdict}  [uses ${used.join(",")}]`,
    );
  }
  for (const [key, p] of providerCache) {
    console.log(
      `provider ${key}: build ${p.buildMs.toFixed(0)} ms, ${p.artifact.binary.length} bytes, ` +
        `${p.getters.size}/${p.names.length} getter boundaries`,
    );
  }
  console.log(`verdict agreement (status only): ${agree}/${compared}`);
}

await main();
