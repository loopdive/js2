import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// #2520 — under --target wasi essentially any program trips ~60 per-import
// "Host import "env.X" … not on the dual-mode allowlist" warnings (anything
// referencing Uint8Array/Date/Map/… pulls in the whole ambient global surface).
// Those imports are dropped and dead-code-eliminated — they never reach the
// .wasm — so by default the CLI collapses them into a one-line summary;
// --verbose restores the full per-import listing. (Warnings go to stderr, so we
// merge it via 2>&1.)
function compileAndCapture(extraArgs: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "issue-2520-cli-"));
  const inFile = path.join(dir, "input.ts");
  // Bare-value identity uses of several builtin constructors genuinely need the
  // host constructor object (global_<Ctor>), which is dropped under --target wasi
  // → multiple allowlist warnings to exercise the collapse / --verbose behaviour.
  writeFileSync(
    inFile,
    `export function f(x: any): boolean { return x === Uint8Array || x === Int8Array || x === Float64Array; }`,
  );
  return execSync(
    `npx -y tsx ${JSON.stringify(path.resolve("src/cli.ts"))} ${JSON.stringify(inFile)} --no-dts --target wasi ${extraArgs} 2>&1`,
    { cwd: process.cwd(), stdio: "pipe" },
  ).toString();
}

describe("#2520 — host-import allowlist warning verbosity", () => {
  it("collapses the per-import allowlist warnings into a one-line summary by default", () => {
    const out = compileAndCapture("");
    // No individual per-import lines…
    expect(out).not.toMatch(/Host import "env\./);
    // …just a single summary line with a count.
    expect(out).toMatch(/\d+ host import\(s\) not on the dual-mode allowlist were dropped/);
    expect(out).toMatch(/Re-run with --verbose to list them/);
  });

  it("lists every dropped host import individually with --verbose", () => {
    const out = compileAndCapture("--verbose");
    // Full per-import listing is restored…
    expect(out).toMatch(/Host import "env\./);
    expect((out.match(/Host import "env\./g) ?? []).length).toBeGreaterThan(1);
    // …and the collapsed summary line is NOT printed.
    expect(out).not.toMatch(/were dropped \(no-op under WASI/);
  });
});
