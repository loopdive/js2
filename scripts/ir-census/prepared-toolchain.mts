// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The Prepared whole-program path as CI's test262 worker drives it: the entry,
 * the harness assembly and the compile options of one checkout. Shared by the
 * Prepared census (`prepared-census.mts`) and the Prepared byte-identity corpus
 * (`scripts/byte-diff-corpus.mts --corpus prepared`).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type Entry = typeof import("../../src/test262/test262-prepared-entry.ts");
type Runtime = typeof import("../../src/test262/test262-prepared-runtime.ts");
export type Runner = typeof import("../../tests/test262-runner.ts");
type Harness = typeof import("../../tests/test262-original-harness.ts");
export type Meta = ReturnType<Runner["parseMeta"]>;

export interface Toolchain {
  readonly tree: string;
  readonly entry: Entry;
  readonly runtime: Runtime;
  readonly runner: Runner;
  readonly harness: Harness;
}

const REQUEST = { kind: "prepared-program-required", version: 1 } as const;
/** The options scripts/test262-worker.mjs passes for an original-harness row under `TEST262_COMPILER_PATH=ir`. */
export const options = (meta: Meta) =>
  ({
    wholeProgram: REQUEST,
    allowJs: true,
    fileName: "test.js",
    sourceMap: false,
    emitWat: false,
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    scriptGoal: !meta.flags?.includes("module") && !meta.flags?.includes("raw"),
    deferTopLevelInit: true,
    hostBridge: "always",
    trackIrOutcomes: true,
  }) as const;

/** Loads the toolchain of the checkout at `tree`. */
export async function loadToolchain(tree: string): Promise<Toolchain> {
  const load = (path: string) => import(pathToFileURL(join(tree, path)).href);
  const [entry, runtime, runner, harness] = await Promise.all([
    load("src/test262/test262-prepared-entry.ts"),
    load("src/test262/test262-prepared-runtime.ts"),
    load("tests/test262-runner.ts"),
    load("tests/test262-original-harness.ts"),
  ]);
  return { tree, entry, runtime, runner, harness };
}

export interface Assembly {
  readonly source: string;
  readonly starts: readonly [number, string][];
  readonly bodyLine: number;
  readonly unmodelled?: boolean;
}

/**
 * The harness parts in assembly order. The body is passed because the harness
 * may elide parts the body does not use (#7376's runtime shim on demand); an
 * older harness ignores the third argument.
 */
export function harnessParts(harness: Harness, meta: Meta, body: string) {
  return harness.harnessSourceParts(meta, meta.flags?.includes("async") === true, body);
}

/** The literal runner assembly (`assembleOriginalHarness(...).primary`), the program CI measures. */
export function realAssembly(tools: Toolchain, source: string, meta: Meta): Assembly {
  const variant = tools.harness.assembleOriginalHarness(source, meta).primary;
  const starts: [number, string][] = [];
  let line = variant.strict ? 2 : 1;
  if (variant.bodyLineOffset > 0) {
    for (const part of harnessParts(tools.harness, meta, source)) {
      starts.push([line, part.name]);
      line += part.source.split("\n").length - 1;
    }
  }
  return { source: variant.source, starts, bodyLine: variant.bodyLineOffset + 1 };
}
