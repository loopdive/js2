// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Compile-once Test262 **harness** provider (#3451 slice 3, P1).
 *
 * The authoritative runner prepends the literal upstream harness prefix to
 * every test and compiles the whole assembly. #3451's slice-1 inventory
 * measured that there are only **64 distinct harness sources** behind ~82,600
 * body variants, and slice 2 measured the consequence: a body compiled against
 * a pre-built harness costs 30-96 ms where the honest single-module assembly
 * costs 600-1,400 ms.
 *
 * This module is the reusable form of that slice-2 prototype. It is a
 * one-to-one sibling of `src/temporal-provider.ts` and drives the SAME
 * machinery — the npm package linker (`src/package-linker.ts`, #2527), which
 * compiles a bare-package edge into its own binary, content-addresses it into
 * a provider cache, and hands the consumer an import map over the frozen
 * cross-module type group. The harness prefix is presented to that linker as
 * an ordinary one-file package.
 *
 * Two things differ from the Temporal case and both are load-bearing:
 *
 * 1. **Many exports, not one.** Temporal publishes a single `Temporal` object;
 *    the harness publishes every top-level binding it declares (`assert`,
 *    `Test262Error`, `verifyProperty`, `compareArray`, …). Each is re-exported
 *    as `export const __h_<name> = <name>` — a `const` alias, because that is
 *    what forces the linker to publish a **getter** boundary, so constructors
 *    and objects cross as values rather than as typed function imports.
 * 2. **The consumer binds only what it references.** A body that uses `assert`
 *    alone must not pay an import (and a getter call) for 70 other names, so
 *    {@link harnessBindingPrelude} filters by the #3461 identifier-token scan.
 *
 * SOURCE ACQUISITION IS DELIBERATELY NOT HERE. The caller passes the assembled
 * harness prefix text (`assembleLinkedHarness(...).harnessPrefix` in
 * `tests/test262-original-harness.ts`), so `src/` carries no test262 fixture
 * path and this module stays a general "compile this script once and expose
 * its top-level bindings" service.
 *
 * SCOPE — this is a NON-AUTHORITATIVE shadow lane (#3451 slice 3/P3). Slice 2
 * proved the wiring sound (12/12 verdict agreement on
 * `built-ins/Array/prototype/map`) but also that parity across the module
 * boundary is not free; see the substrate notes in the issue file.
 */

import * as path from "path";
import * as nodeCrypto from "node:crypto";

import { ts } from "./ts-api.js";
import type { CompileOptions, CompileResult, LinkedModuleArtifact } from "./index.js";
import { compileMulti, compileProject } from "./index.js";
import { getDefaultEnvironment } from "./env.js";
import { RUNTIME_RECGROUP_ABI_VERSION } from "./emit/canonical-recgroup.js";
import { PROVIDER_COMPILER_ABI_VERSION, PROVIDER_LINKER_ABI_VERSION } from "./provider-manifest.js";

/** npm package name the harness prefix is presented to the linker under. */
export const HARNESS_PACKAGE_NAME = "test262-harness";
/** Declaration-only stub key handed to the consumer graph. */
export const HARNESS_STUB_KEY = "./__js2wasm_harness_stub.ts";

/**
 * `$DONE` / `$ERROR` are legal JS identifiers but `$` is not welcome in the
 * `__h_` alias we generate, because the alias also becomes a Wasm export field
 * and a TypeScript declaration name in the stub. `S_` is an arbitrary but
 * INJECTIVE escape: no harness name contains `S_` where another contains `$`
 * at the same position in practice, and a collision would be caught by the
 * getter-boundary assertion in {@link buildHarnessProvider} (two names mapping
 * to one alias means one of them gets no boundary).
 */
export function harnessExportAlias(name: string): string {
  return `__h_${name.replace(/\$/g, "S_")}`;
}

export interface HarnessProvider {
  /** The compiled provider, ready for `instantiateLinkedProviders`. */
  artifact: LinkedModuleArtifact;
  /** Deterministic Wasm import namespace the consumer imports from. */
  namespace: string;
  /** Harness top-level name → provider getter field that returns its value. */
  getters: Map<string, string>;
  /** Every top-level name the harness prefix declares, in declaration order. */
  names: string[];
  /** Wall-clock cost of producing it (0 on a memory-cache hit). */
  buildMs: number;
  /** True when the provider binary came from the content-addressed cache. */
  cacheHit: boolean;
}

export interface BuildHarnessProviderOptions {
  /** The assembled, strict-neutral Test262 harness prefix. */
  harnessPrefix: string;
  /** Directory for the synthetic project and the provider binary cache. */
  cacheDir: string;
  /** Compile options forwarded to the provider compile. */
  compileOptions?: CompileOptions;
}

const memoryCache = new Map<string, HarnessProvider>();

/** @internal Test seam for exercising cold-build behaviour. */
export function clearHarnessProviderMemoryCacheForTests(): void {
  memoryCache.clear();
}

function fingerprint(parts: readonly string[]): string {
  const hash = nodeCrypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function providerOptionFingerprint(options: CompileOptions | undefined): string {
  return JSON.stringify({
    target: options?.target ?? "gc",
    fast: options?.fast === true,
    nativeStrings: options?.nativeStrings === true,
    utf8Storage: options?.utf8Storage === true,
    semanticProviders: options?.semanticProviders ?? "auto",
    hostBridge: options?.hostBridge ?? "auto",
    platform: options?.platform ?? "web",
  });
}

/**
 * The content-addressed identity of the provider {@link buildHarnessProvider}
 * would produce for these inputs — the same key its memory cache and its
 * on-disk project directory are keyed by.
 *
 * The ABI versions are part of the key for the reason #3451's artifact model
 * lists: a provider binary is only interchangeable with a consumer compiled
 * under the same rec-group / compiler / linker contract. Serving a cached
 * provider across an ABI bump would produce a module pair that links but does
 * not share types.
 *
 * (#5353-style) Exported so a lane that CANNOT afford a cold build — the
 * test262 fork pool kills a job at 30 s — can prove the provider it is about
 * to ask for is the one a pre-warm step already put in the cache.
 */
export function harnessProviderCacheKey(options: { harnessPrefix: string; compileOptions?: CompileOptions }): string {
  return fingerprint([
    options.harnessPrefix,
    providerOptionFingerprint(options.compileOptions),
    `recgroup-v${RUNTIME_RECGROUP_ABI_VERSION}`,
    PROVIDER_COMPILER_ABI_VERSION,
    PROVIDER_LINKER_ABI_VERSION,
  ]);
}

/**
 * Top-level `var` / `function` / `class` names of a script — the harness ABI
 * surface.
 *
 * `let` / `const` are included too (the upstream harness uses both): every
 * top-level binding is part of the realm the body observes. Destructuring
 * patterns are walked so `var {a, b} = …` publishes both names.
 */
export function harnessTopLevelNames(source: string): string[] {
  const file = ts.createSourceFile("harness.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names = new Set<string>();
  const bind = (node: ts.BindingName): void => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
      return;
    }
    for (const element of node.elements) if (ts.isBindingElement(element)) bind(element.name);
  };
  for (const statement of file.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) bind(declaration.name);
    }
  }
  return [...names];
}

type ProjectFilesystem = NonNullable<ReturnType<typeof getDefaultEnvironment>["fs"]>;

function verifyHarnessProject(fs: ProjectFilesystem, root: string, files: ReadonlyMap<string, Buffer>): void {
  for (const relative of ["", "node_modules", `node_modules/${HARNESS_PACKAGE_NAME}`]) {
    if (!fs.lstatSync(path.join(root, relative)).isDirectory()) {
      throw new Error(`Invalid harness synthetic project directory: ${relative || "."}`);
    }
  }
  for (const [relative, expected] of files) {
    const file = path.join(root, relative);
    if (!fs.lstatSync(file).isFile() || !fs.readFileSync(file).equals(expected)) {
      throw new Error(`Invalid harness synthetic project file: ${relative}`);
    }
  }
}

/**
 * Materialise the harness prefix as a synthetic npm package, atomically.
 *
 * The staging + rename + verify dance is copied from `materializeTemporalProject`
 * for the same reason it exists there: four test262 workers can race on the
 * same include-set, and a half-written `index.js` observed by a peer would
 * produce a silently wrong provider rather than an error.
 */
function materializeHarnessProject(
  fs: ProjectFilesystem,
  cacheDir: string,
  key: string,
  source: string,
  names: readonly string[],
): string {
  const root = path.join(cacheDir, `harness-project-v1-${key}`);
  const entry = "__js2wasm_harness_entry.js";
  const packagePath = `node_modules/${HARNESS_PACKAGE_NAME}`;
  const aliases = names.map(harnessExportAlias);
  const files = new Map([
    [
      `${packagePath}/package.json`,
      Buffer.from(JSON.stringify({ name: HARNESS_PACKAGE_NAME, version: "0.0.0-linked", main: "index.js" })),
    ],
    [
      `${packagePath}/index.js`,
      Buffer.from(`${source}\n${names.map((n) => `export const ${harnessExportAlias(n)} = ${n};`).join("\n")}\n`),
    ],
    [
      entry,
      // The entry imports ALL aliases so the linker publishes every boundary;
      // an alias nobody imports is tree-shaken out of the provider's exports
      // and the consumer could then not bind it.
      Buffer.from(
        `import { ${aliases.join(", ")} } from "${HARNESS_PACKAGE_NAME}";\n` +
          `export function __js2wasm_harness_probe() { return [${aliases
            .map((a) => `typeof ${a}`)
            .join(", ")}].length; }\n`,
      ),
    ],
  ]);
  fs.mkdirSync(cacheDir, { recursive: true });
  let present = true;
  try {
    fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    present = false;
  }
  if (present) {
    verifyHarnessProject(fs, root, files);
    return path.join(root, entry);
  }

  const stage = fs.mkdtempSync(path.join(cacheDir, `.harness-project-v1-${key}.staging-`));
  let owned = true;
  let failed = false;
  let failure: unknown;
  try {
    fs.mkdirSync(path.join(stage, packagePath), { recursive: true });
    for (const [relative, bytes] of files) fs.writeFileSync(path.join(stage, relative), bytes);
    verifyHarnessProject(fs, stage, files);
    try {
      fs.renameSync(stage, root);
      owned = false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      try {
        verifyHarnessProject(fs, root, files);
      } catch (verificationError) {
        throw new AggregateError([error, verificationError], "Harness synthetic project publication collision", {
          cause: error,
        });
      }
    }
    verifyHarnessProject(fs, root, files);
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (owned) {
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch (cleanupError) {
      if (!failed) throw cleanupError;
      throw new AggregateError([failure, cleanupError], "Harness synthetic project publication and cleanup failed", {
        cause: failure,
      });
    }
  }
  if (failed) throw failure;
  return path.join(root, entry);
}

/** Compile the harness prefix once into a linked provider artifact. */
export async function buildHarnessProvider(options: BuildHarnessProviderOptions): Promise<HarnessProvider> {
  const key = harnessProviderCacheKey(options);
  const cached = memoryCache.get(key);
  if (cached) return { ...cached, buildMs: 0, cacheHit: true };

  const fs = getDefaultEnvironment().fs;
  if (!fs) throw new Error("buildHarnessProvider requires a filesystem environment");

  const started = Date.now();
  const names = harnessTopLevelNames(options.harnessPrefix);
  const entryPath = materializeHarnessProject(fs, options.cacheDir, key, options.harnessPrefix, names);

  const result = await compileProject(entryPath, {
    ...options.compileOptions,
    allowJs: true,
    emitWat: false,
    skipSemanticDiagnostics: true,
    packageCacheDir: path.join(options.cacheDir, "providers"),
  });
  if (!result.success) {
    const errors = (result.errors ?? [])
      .filter((error) => error.severity !== "warning")
      .slice(0, 5)
      .map((error) => error.message)
      .join("; ");
    throw new Error(`Harness provider compilation failed: ${errors || "unknown error"}`);
  }
  // A `bundled` plan means the linker declined a separate provider and inlined
  // the harness into the root — the exact outcome this module exists to avoid,
  // so it is an error, never a silent per-body degrade back to honest cost.
  if (result.linkPlan?.mode !== "separate") {
    throw new Error(
      `Harness provider was not linked separately (plan=${result.linkPlan?.mode ?? "none"}` +
        `${result.linkPlan?.fallbackReason ? `, reason=${result.linkPlan.fallbackReason}` : ""})`,
    );
  }
  const artifact = (result.linkedModules ?? []).find((entry) => entry.packageName === HARNESS_PACKAGE_NAME);
  if (!artifact) throw new Error("Harness provider artifact missing from the link plan");

  const getters = new Map<string, string>();
  const nonGetter: string[] = [];
  for (const name of names) {
    const boundary = artifact.exportBoundaries?.[harnessExportAlias(name)];
    if (boundary?.kind === "getter") getters.set(name, boundary.field);
    else nonGetter.push(`${name}:${boundary?.kind ?? "none"}`);
  }
  // Every top-level name MUST cross as a getter. A non-getter boundary is a
  // direct function import, which hands the consumer a callable but not the
  // VALUE — `Test262Error` imported that way could be called but never used as
  // a constructor or compared for identity. Failing loudly here is what keeps
  // a silently-degraded provider out of a parity measurement.
  if (nonGetter.length > 0) {
    throw new Error(`Harness provider published non-getter boundaries: ${nonGetter.slice(0, 8).join(", ")}`);
  }

  const provider: HarnessProvider = {
    artifact,
    namespace: artifact.namespace,
    getters,
    names,
    buildMs: Date.now() - started,
    cacheHit: artifact.cacheHit === true,
  };
  memoryCache.set(key, provider);
  return provider;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The harness names whose identifier token appears in `body`.
 *
 * Same scan as `buildBindingShim` (#3461): identifier tokens only, `[\w$]`
 * neighbours rejected so `$DONE` and substrings (`assertFoo`) are handled. A
 * false POSITIVE is harmless (one unused import and getter call); a wrongly
 * OMITTED binding is a ReferenceError at run time, so matching liberally is
 * the safe bias.
 */
export function referencedHarnessNames(provider: HarnessProvider, body: string): string[] {
  return provider.names.filter(
    (name) => provider.getters.has(name) && new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(body),
  );
}

export interface HarnessBindingPrelude {
  /** Declaration-only stub source for {@link HARNESS_STUB_KEY}. */
  stubSource: string;
  /** Text prepended to the body. */
  prelude: string;
  /** Getter field → Wasm import site. */
  bindings: Map<string, { module: string; field: string }>;
  /** Harness names bound by this prelude. */
  names: string[];
  /** Lines `prelude` adds ahead of the body — subtract to map a row's error. */
  preludeLines: number;
}

/**
 * Build the consumer prelude that makes free harness names resolve to the
 * provider's exports.
 *
 * `var`, not `const`: the harness prefix's own bindings are `var`/`function`
 * at script top level, and a body is allowed to redeclare one (`var assert`
 * in a body that shadows it). `const` would turn that legal redeclaration into
 * a compile error and silently change the row's verdict.
 *
 * The strict directive comes FIRST, ahead of the import — a `"use strict"`
 * that is not the first statement is not a directive prologue at all.
 */
export function harnessBindingPrelude(provider: HarnessProvider, body: string, strict: boolean): HarnessBindingPrelude {
  const names = referencedHarnessNames(provider, body);
  const getters = names.map((name) => provider.getters.get(name) as string);
  const stubSource = `${getters.map((getter) => `export declare function ${getter}(): any;`).join("\n")}\n`;
  const prelude =
    (strict ? '"use strict";\n' : "") +
    (getters.length > 0
      ? `import { ${getters.join(", ")} } from "${HARNESS_STUB_KEY.replace(/\.ts$/, "")}";\n` +
        `${names.map((name, index) => `var ${name} = ${getters[index]}();`).join(" ")}\n`
      : "");
  const bindings = new Map(getters.map((getter) => [getter, { module: provider.namespace, field: getter }]));
  return {
    stubSource,
    prelude,
    bindings,
    names,
    preludeLines: prelude.length === 0 ? 0 : prelude.split("\n").length - 1,
  };
}

export interface CompileHarnessLinkedBodyOptions extends CompileOptions {
  fileName?: string;
  strict?: boolean;
}

/**
 * Compile a test body against a pre-built harness provider.
 *
 * `inferModuleStrictArguments: false` mirrors the worker's original-harness
 * lane: the prelude's `import` must not make the SLOPPY variant strict, which
 * it otherwise would (an ES module is always strict). That single option is
 * what lets one mechanism serve both variants.
 */
export async function compileHarnessLinkedBody(
  provider: HarnessProvider,
  body: string,
  options?: CompileHarnessLinkedBodyOptions,
): Promise<CompileResult & { harnessPrelude: HarnessBindingPrelude }> {
  const entryKey = options?.fileName ?? "test.js";
  const prelude = harnessBindingPrelude(provider, body, options?.strict === true);
  const files: Record<string, string> = {
    [HARNESS_STUB_KEY]: prelude.stubSource,
    [entryKey]: `${prelude.prelude}${body}`,
  };
  const result = await compileMulti(files, entryKey, {
    ...options,
    allowJs: options?.allowJs ?? true,
    // (#3451) WITHOUT this the linked lane silently RUNS source the honest lane
    // rejects. `compileMulti` suppresses syntactic diagnostics under `allowJs`
    // by design — npm packages produce false positives — and `strictJsSyntax`
    // (#3506) is the opt-in for a graph whose complete literal JavaScript the
    // caller owns, which is exactly a test262 body plus a generated stub.
    // Measured before the flag: `var a = ;;;` compiled and ran, and
    // `for-of/dstr/array-elem-init-in.js` ran where the honest lane reported
    // `',' expected` — so every `negative: SyntaxError` row would have flipped
    // from pass to fail, silently, in a lane whose whole purpose is parity.
    strictJsSyntax: options?.strictJsSyntax ?? true,
    canonicalRuntimeTypes: true,
    // (#6477) Do NOT run the body in the wasm `start` section. Top-level test262
    // code runs during `WebAssembly.instantiate`, i.e. BEFORE
    // `wireCompiledInstance` can register this consumer in the #5225 decoder
    // registry — so every cross-module read the provider makes on a struct this
    // module minted resolves with the PROVIDER's exports and answers with a
    // `ref.test`-miss default (`undefined` / `null` / `0`). Deferring to an
    // exported `__module_init` (#2796) lets `instantiateTest262Module` register
    // the consumer first and only then run the body. Consumer-only: the
    // provider build (`compileProject`) is untouched, as is the honest lane.
    deferTopLevelInit: true,
    // (#5226) Match the provider's imported `env.__exn` tag so a harness throw
    // keeps its identity in the body's `catch` and vice versa.
    sharedExceptionTag: true,
    inferModuleStrictArguments: options?.inferModuleStrictArguments ?? false,
    link: [...new Set([...(options?.link ?? []), provider.namespace])],
    linkedPackageBindings: prelude.bindings,
  });
  // Publish the provider so instantiation wires it exactly the way a
  // compileProject-linked graph does. Assigned before `importObject` is ever
  // read — that getter memoizes provider instances on first access.
  (result as { linkedModules?: LinkedModuleArtifact[] }).linkedModules = [provider.artifact];
  return Object.assign(result, { harnessPrelude: prelude });
}
