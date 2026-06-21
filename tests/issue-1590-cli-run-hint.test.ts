import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Issue #1590 task 3: after a successful compile the CLI should print a
// one-line hint telling the user how to run the output, adapting to the chosen
// target, and suppressible with --quiet.

function compileAndCapture(extraArgs: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "issue-1590-cli-"));
  const inFile = path.join(dir, "input.ts");
  writeFileSync(inFile, `export function test(): number { return 42; }`);
  return execSync(
    `npx -y tsx ${JSON.stringify(path.resolve("src/cli.ts"))} ${JSON.stringify(inFile)} --no-dts ${extraArgs}`,
    { cwd: process.cwd(), stdio: "pipe" },
  ).toString();
}

describe("issue #1590 — CLI post-compile run hint", () => {
  it("standalone target hints the wasmtime command", () => {
    const out = compileAndCapture("--standalone");
    expect(out).toMatch(/To run: wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y/);
    expect(out).toMatch(/input\.wasm/);
  });

  it("wasi target hints the wasmtime command", () => {
    const out = compileAndCapture("--target wasi");
    expect(out).toMatch(/To run: wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y/);
  });

  it("does not recommend all-proposals=y (stack-switching exits at load, #2511)", () => {
    const out = compileAndCapture("--standalone");
    expect(out).not.toMatch(/all-proposals=y/);
  });

  it("default (gc) target hints the JS-host run path", () => {
    const out = compileAndCapture("");
    expect(out).toMatch(/JS-host build/);
    expect(out).toMatch(/input\.imports\.js/);
    expect(out).toMatch(/recompile with --standalone/);
  });

  it("--quiet suppresses the hint", () => {
    const out = compileAndCapture("--standalone --quiet");
    expect(out).not.toMatch(/To run:/);
  });
});
