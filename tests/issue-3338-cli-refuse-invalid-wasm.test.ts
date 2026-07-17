import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Issue #3338 — the CLI must not publish an invalid primary artifact with a
// success exit code. `CompileResult.success` means codegen completed, not that
// the binary validates: on wasm-opt failure the optimizer emits a warning and
// preserves the original (possibly invalid) bytes, and `--no-optimize` ships
// raw codegen with no validator at all. The CLI now validates the final binary
// before writing any output; on failure it exits nonzero and writes nothing.

const CLI = path.resolve("src/cli.ts");

// Reduced from test/language/expressions/in/private-field-rhs-non-object.js.
// On current main this compiles (`success: true`) but emits a binary whose
// `C_init` has a `local.tee` storing f64 into a reference local — invalid Wasm
// that `WebAssembly.validate` rejects. It is a stand-in for any malformed-Wasm
// producer; the CLI publication boundary must refuse it regardless of source.
const INVALID_SOURCE = `let caught: any = null;
class C {
  #field: any;
  constructor() {
    try {
      // @ts-ignore
      #field in {} << 0;
    } catch (error) {
      caught = error;
    }
  }
}
new C();
`;

const VALID_SOURCE = `export function add(a: number, b: number): number {
  return a + b;
}
`;

interface RunResult {
  status: number;
  stderr: string;
  dir: string;
  name: string;
}

function runCli(source: string, extraArgs: string[]): RunResult {
  const dir = mkdtempSync(path.join(tmpdir(), "issue-3338-"));
  const name = "input";
  const inFile = path.join(dir, `${name}.ts`);
  writeFileSync(inFile, source);
  try {
    execFileSync("npx", ["-y", "tsx", CLI, inFile, "--quiet", "-o", dir, ...extraArgs], {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf-8",
    });
    return { status: 0, stderr: "", dir, name };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    const stderr = e.stderr == null ? "" : typeof e.stderr === "string" ? e.stderr : e.stderr.toString("utf-8");
    return { status: e.status ?? 1, stderr, dir, name };
  }
}

// The set of artifacts the CLI would normally write next to the input.
function emittedArtifacts(dir: string, name: string): string[] {
  return [`${name}.wasm`, `${name}.wat`, `${name}.d.ts`, `${name}.imports.js`, `${name}.wit`].filter((f) =>
    existsSync(path.join(dir, f)),
  );
}

describe("issue #3338 — CLI refuses to publish invalid Wasm artifacts", () => {
  it("default (optimized) mode: exits nonzero and writes no artifacts for an invalid binary", () => {
    const r = runCli(INVALID_SOURCE, []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/failed validation/i);
    // The engine detail (e.g. "local.tee ... expected type anyref, found f64")
    // must accompany the diagnostic per the acceptance criteria.
    expect(r.stderr.length).toBeGreaterThan("failed validation".length);
    expect(emittedArtifacts(r.dir, r.name)).toEqual([]);
  }, 60_000);

  it("--no-optimize mode: exits nonzero and writes no artifacts for an invalid binary", () => {
    const r = runCli(INVALID_SOURCE, ["--no-optimize"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/failed validation/i);
    expect(emittedArtifacts(r.dir, r.name)).toEqual([]);
  }, 60_000);

  it("valid source (default mode): exits zero and writes its artifacts", () => {
    const r = runCli(VALID_SOURCE, ["--target", "standalone"]);
    expect(r.status).toBe(0);
    const artifacts = emittedArtifacts(r.dir, r.name);
    expect(artifacts).toContain("input.wasm");
    // The published .wasm must actually validate.
    const bytes = readFileSync(path.join(r.dir, "input.wasm"));
    expect(WebAssembly.validate(bytes)).toBe(true);
  }, 60_000);

  it("valid source (--no-optimize): exits zero and writes a valid .wasm", () => {
    const r = runCli(VALID_SOURCE, ["--target", "standalone", "--no-optimize"]);
    expect(r.status).toBe(0);
    expect(emittedArtifacts(r.dir, r.name)).toContain("input.wasm");
    const bytes = readFileSync(path.join(r.dir, "input.wasm"));
    expect(WebAssembly.validate(bytes)).toBe(true);
  }, 60_000);
});
