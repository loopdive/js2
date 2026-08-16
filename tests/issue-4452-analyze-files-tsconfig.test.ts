// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4452 — `analyzeFiles` derives its `ts.CompilerOptions` from the nearest
// tsconfig.json instead of hardcoding one set. Three behaviours are pinned
// here:
//
//   (a) tsconfig found  → its options are the base (rootDir/moduleResolution
//       come from the project), so an entry in a subdirectory may import a
//       sibling module ABOVE its own directory without the TS6059
//       "not under 'rootDir'" complaint the hardcoded `rootDir:
//       dirname(entry)` produced.
//   (b) no tsconfig     → legacy hardcoded options, unchanged (this is the
//       load-bearing playground / arbitrary-input path).
//   (c) `tsconfig: false` → legacy options even when a config IS reachable.
//
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileFiles } from "../src/index.js";
import { analyzeFiles } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      // Emit-only options: present on purpose — `analyzeFiles` must drop them
      // (it never calls program.emit()) rather than let them touch disk.
      declaration: true,
      sourceMap: true,
      outDir: "./dist",
      rootDir: "./src",
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
);

/**
 * proj/
 *   tsconfig.json         (rootDir ./src)
 *   src/util.ts
 *   src/app/main.ts       imports ../util.js — ABOVE its own directory
 */
function makeProject(withTsconfig: boolean): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), "js2wasm-4452-"));
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  writeFileSync(join(dir, "src", "util.ts"), "export function double(n: number): number {\n  return n * 2;\n}\n");
  writeFileSync(
    join(dir, "src", "app", "main.ts"),
    'import { double } from "../util.js";\nexport function run(): number {\n  return double(21);\n}\n',
  );
  if (withTsconfig) writeFileSync(join(dir, "tsconfig.json"), TSCONFIG);
  return { dir, entry: join(dir, "src", "app", "main.ts") };
}

const rootDirComplaints = (errors: readonly { message: string }[]) =>
  errors.filter((e) => /rootDir/.test(e.message)).map((e) => e.message);

/**
 * Build the fixture, run `fn` with the process cwd inside it, then delete it.
 *
 * The chdir is load-bearing twice over: the legacy option set has no
 * `configFilePath`, so TypeScript's automatic `@types` inclusion scans upward
 * from the CWD — run from the repo, a fixture silently inherits the repo's
 * ambient types (not hermetic), and those types are also what makes a legacy
 * program expensive enough that three of them exceed the 512 MB per-fork
 * budget in `vitest.config.ts`.
 */
async function withProject<T>(
  withTsconfig: boolean,
  fn: (p: { dir: string; entry: string }) => T | Promise<T>,
): Promise<T> {
  const project = makeProject(withTsconfig);
  const prevCwd = process.cwd();
  process.chdir(project.dir);
  try {
    return await fn(project);
  } finally {
    process.chdir(prevCwd);
    rmSync(project.dir, { recursive: true, force: true });
  }
}

describe("#4452 analyzeFiles honors the project's tsconfig", () => {
  // Drop each `ts.Program` before the next case builds one (forks already run
  // with `--expose-gc`).
  afterEach(() => {
    (globalThis as { gc?: () => void }).gc?.();
  });

  it("(a) uses the project's rootDir, so a cross-directory import is clean", async () => {
    await withProject(true, async ({ entry }) => {
      const result = await compileFiles(entry, {});
      expect(rootDirComplaints(result.errors)).toEqual([]);
      expect(result.success).toBe(true);
    });
  });

  it("(b) without a tsconfig, the legacy hardcoded options still apply", async () => {
    await withProject(false, async ({ entry }) => {
      const result = await compileFiles(entry, {});
      // Legacy `rootDir: dirname(entry)` rejects the sibling above it.
      expect(rootDirComplaints(result.errors).length).toBeGreaterThan(0);
    });
  });

  it("(c) `tsconfig: false` forces the legacy options even with a config present", async () => {
    await withProject(true, async ({ entry }) => {
      const result = await compileFiles(entry, { tsconfig: false });
      expect(rootDirComplaints(result.errors).length).toBeGreaterThan(0);
    });
  });

  it("derives moduleResolution/rootDir from the config and forces the pipeline overrides", async () => {
    await withProject(true, ({ dir, entry }) => {
      const opts = analyzeFiles(entry, {
        skipSemanticDiagnostics: true,
      }).program.getCompilerOptions();
      expect(opts.moduleResolution).toBe(ts.ModuleResolutionKind.Bundler);
      expect(opts.rootDir).toBe(join(dir, "src"));
      // Pipeline-required override, kept regardless of what the config says.
      expect(opts.noEmit).toBe(true);
      // Emit-only options are dropped — the program is type-only.
      expect(opts.outDir).toBeUndefined();
      expect(opts.declaration).toBeUndefined();
      expect(opts.sourceMap).toBeUndefined();
    });
  });

  it("`tsconfig: false` pins the legacy Node10 + dirname(entry) options", async () => {
    await withProject(true, ({ entry }) => {
      const opts = analyzeFiles(entry, {
        skipSemanticDiagnostics: true,
        tsconfig: false,
      }).program.getCompilerOptions();
      expect(opts.moduleResolution).toBe(ts.ModuleResolutionKind.Node10);
      expect(opts.rootDir).toBe(dirname(entry));
      expect(opts.noImplicitAny).toBe(false);
      expect(opts.noEmit).toBe(true);
    });
  });

  it("an explicit tsconfig path is honored", async () => {
    await withProject(true, ({ dir, entry }) => {
      const opts = analyzeFiles(entry, {
        skipSemanticDiagnostics: true,
        tsconfig: join(dir, "tsconfig.json"),
      }).program.getCompilerOptions();
      expect(opts.moduleResolution).toBe(ts.ModuleResolutionKind.Bundler);
      expect(opts.rootDir).toBe(join(dir, "src"));
    });
  });

  it("an explicit tsconfig path that does not exist is a hard error", async () => {
    await withProject(false, ({ dir, entry }) => {
      expect(() => analyzeFiles(entry, { tsconfig: join(dir, "nope.json") })).toThrow(/nope\.json/);
    });
  });
});
