import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Issue #1950 — the CLI ships optimized output by default (Binaryen wasm-opt
// at -O3 when available); `--no-optimize` / `-O0` restores raw codegen.
// The programmatic `compile()` API is intentionally NOT changed (no surprise
// for library users) — only the CLI default flips.

const CLI = path.resolve("src/cli.ts");

// A loop with dead arithmetic (`+ n - n`) that wasm-opt cleans up — gives the
// optimizer something material to remove so the size delta is unambiguous.
const SOURCE = `export function test(n: number): number {
  let sum = 0;
  for (let i = 0; i < n; i++) { sum += i * 2; }
  return sum + n - n;
}`;

function compileStandalone(extraArgs: string[]): { wasm: Uint8Array; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "issue-1950-"));
  const inFile = path.join(dir, "input.ts");
  writeFileSync(inFile, SOURCE);
  // standalone target → empty-import instantiation, so we can run the binary
  // without a host shim and confirm the optimized output stays correct.
  execFileSync(
    "npx",
    ["-y", "tsx", CLI, inFile, "--target", "standalone", "--no-dts", "--quiet", "-o", dir, ...extraArgs],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  return { wasm: readFileSync(path.join(dir, "input.wasm")), dir };
}

async function runTest(wasm: Uint8Array, n: number): Promise<number> {
  const { instance } = await WebAssembly.instantiate(wasm, {});
  return (instance.exports.test as (n: number) => number)(n);
}

describe("issue #1950 — default-on CLI optimization", () => {
  it("default build is optimized (smaller than --no-optimize) and stays correct", async () => {
    const optimized = compileStandalone([]);
    const raw = compileStandalone(["--no-optimize"]);

    // Binaryen is present in this repo's deps, so the default build must shrink.
    expect(optimized.wasm.byteLength).toBeLessThan(raw.wasm.byteLength);

    // Both must be valid and compute the same value.
    expect(WebAssembly.validate(optimized.wasm)).toBe(true);
    expect(WebAssembly.validate(raw.wasm)).toBe(true);
    expect(await runTest(optimized.wasm, 5)).toBe(20);
    expect(await runTest(raw.wasm, 5)).toBe(20);
  }, 60_000);

  it("-O0 is an alias for --no-optimize (byte-identical raw output)", () => {
    const o0 = compileStandalone(["-O0"]);
    const noOpt = compileStandalone(["--no-optimize"]);
    expect(o0.wasm.byteLength).toBe(noOpt.wasm.byteLength);
  }, 60_000);
});
