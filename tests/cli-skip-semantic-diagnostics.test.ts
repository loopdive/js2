import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// `--skip-semantic-diagnostics` exposes an option the programmatic API has
// always had (`CompileOptions.skipSemanticDiagnostics`) and every dogfood
// harness that compiles a real npm package sets. Without a CLI route to it,
// `js2wasm <plain-js-package>` aborted at the diagnostic gate on type errors
// that never reach codegen.
//
// The fixture is reduced from acorn 8.16.0 dist/acorn.mjs:3620 — `var elt =
// (void 0)` narrows to `undefined`, so the later `elt = null` is a semantic
// error. That single pattern (5 occurrences) is what stopped the real package
// from compiling; codegen handles it fine.

const CLI = path.resolve("src/cli.ts");
const TSX = path.resolve("node_modules/.bin/tsx");

const ACORN_SHAPED_JS = `export function f(flag) {
  var elt = (void 0);
  if (flag) { elt = null; }
  return elt === null ? 1 : 0;
}
`;

function runCli(extraArgs: string[]): {
  status: number;
  stderr: string;
  dir: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "cli-skip-semantic-"));
  writeFileSync(path.join(dir, "noise.mjs"), ACORN_SHAPED_JS);
  try {
    execFileSync(TSX, [CLI, path.join(dir, "noise.mjs"), "--quiet", "-o", dir, ...extraArgs], {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf-8",
    });
    return { status: 0, stderr: "", dir };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? 1, stderr: e.stderr ?? "", dir };
  }
}

describe("CLI --skip-semantic-diagnostics", () => {
  it("without the flag, a semantic error aborts the compile and writes nothing", () => {
    const { status, stderr, dir } = runCli([]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("Type 'null' is not assignable to type 'undefined'");
    expect(existsSync(path.join(dir, "noise.wasm"))).toBe(false);
  }, 120_000);

  it("with the flag, the same source compiles and emits its artifacts", () => {
    const { status, stderr, dir } = runCli(["--skip-semantic-diagnostics"]);
    expect(status).toBe(0);
    expect(stderr).not.toContain("is not assignable to type");
    expect(existsSync(path.join(dir, "noise.wasm"))).toBe(true);
    expect(existsSync(path.join(dir, "noise.imports.js"))).toBe(true);
  }, 120_000);

  it("still fails on a SYNTAX error — only semantic checking is skipped", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cli-skip-semantic-syntax-"));
    writeFileSync(path.join(dir, "broken.mjs"), "export function f( {\n");
    let status = 0;
    try {
      execFileSync(TSX, [CLI, path.join(dir, "broken.mjs"), "--quiet", "-o", dir, "--skip-semantic-diagnostics"], {
        cwd: process.cwd(),
        stdio: "pipe",
        encoding: "utf-8",
      });
    } catch (err) {
      status = (err as { status?: number }).status ?? 1;
    }
    expect(status).not.toBe(0);
    expect(existsSync(path.join(dir, "broken.wasm"))).toBe(false);
  }, 120_000);
});
