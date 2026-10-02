// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6782 — the BUILT library must run under plain Node ESM and without a global
// `process`. Vitest cannot answer either question in-process: vite-node injects
// a `require` binding, and the test worker always has `process`. So each case
// spawns a bare `node --input-type=module` child against `dist/index.js`, from a
// working directory outside the repo.
//
// Needs `pnpm run build` first. When `dist/index.js` is absent the cases are
// SKIPPED, not failed: the per-PR vitest lanes do not build `dist/`, and a
// missing build is not evidence about the library.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const DIST_INDEX = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const HAS_DIST = existsSync(DIST_INDEX);
const DIST_URL = pathToFileURL(DIST_INDEX).href;
const MARKER = "__JS2_DIST_ESM_SMOKE__";

const workDir = mkdtempSync(join(tmpdir(), "js2-dist-esm-smoke-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function runModule(script: string): { status: number | null; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: workDir,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

function verdict(output: { stdout: string; stderr: string }): unknown {
  const line = output.stdout.split("\n").find((l) => l.startsWith(MARKER));
  if (!line) throw new Error(`no verdict line\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`);
  return JSON.parse(line.slice(MARKER.length));
}

describe("#6782 dist/index.js under plain Node ESM", () => {
  it.skipIf(!HAS_DIST)("compileFiles() works without a vite-node `require` shim", () => {
    const entry = join(workDir, "hello.ts");
    writeFileSync(entry, "export function f(): number { return 1; }\n");
    const out = runModule(`
      const { compileFiles } = await import(${JSON.stringify(DIST_URL)});
      let result;
      try {
        const r = await compileFiles(${JSON.stringify(entry)});
        result = { success: r.success, valid: WebAssembly.validate(r.binary), errors: r.errors.filter((e) => e.severity === "error").map((e) => e.message) };
      } catch (e) {
        result = { threw: String(e && e.stack || e) };
      }
      console.log(${JSON.stringify(MARKER)} + JSON.stringify(result));
    `);
    expect(verdict(out)).toEqual({ success: true, valid: true, errors: [] });
    expect(out.status).toBe(0);
  });

  it.skipIf(!HAS_DIST)("compile() works with globalThis.process deleted", () => {
    const out = runModule(`
      const { compile } = await import(${JSON.stringify(DIST_URL)});
      const log = console.log;
      const saved = globalThis.process;
      let result;
      delete globalThis.process;
      try {
        const r = await compile("export function f(){return 1}");
        result = { success: r.success, valid: WebAssembly.validate(r.binary), errors: r.errors.filter((e) => e.severity === "error").map((e) => e.message) };
      } catch (e) {
        result = { threw: String(e && e.stack || e) };
      } finally {
        globalThis.process = saved;
      }
      log(${JSON.stringify(MARKER)} + JSON.stringify(result));
    `);
    expect(verdict(out)).toEqual({ success: true, valid: true, errors: [] });
    expect(out.status).toBe(0);
  });
});
