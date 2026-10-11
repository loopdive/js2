// #6478 — the CLI enables Node's on-disk compile cache before importing the
// compiler bundle. It must be a pure speed-up: opt-out-able, harmless on Node
// versions without the API, and byte-neutral for the emitted artifact.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enableCliCompileCache } from "../src/cli-compile-cache.js";

const CLI = resolve(process.cwd(), "dist/cli.js");
const SOURCE = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

function runCli(env: Record<string, string | undefined>): Uint8Array {
  const dir = mkdtempSync(join(tmpdir(), "js2wasm-6478-"));
  const input = join(dir, "sample.ts");
  writeFileSync(input, SOURCE);
  execFileSync(process.execPath, [CLI, input, "-O0", "-o", dir, "-q"], {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    timeout: 120_000,
  });
  const out = readFileSync(join(dir, "sample.wasm"));
  rmSync(dir, { recursive: true, force: true });
  return new Uint8Array(out);
}

describe("#6478 enableCliCompileCache", () => {
  it("is a no-op when the Node API is absent (Node 20 path)", () => {
    expect(enableCliCompileCache({}, {})).toBe("unavailable");
    expect(enableCliCompileCache({ enableCompileCache: undefined }, {})).toBe("unavailable");
  });

  it("honours the JS2WASM_NO_COMPILE_CACHE opt-out without calling the API", () => {
    let called = 0;
    const outcome = enableCliCompileCache(
      {
        enableCompileCache: () => {
          called++;
        },
      },
      { JS2WASM_NO_COMPILE_CACHE: "1" },
    );
    expect(outcome).toBe("opted-out");
    expect(called).toBe(0);
  });

  it("enables the cache when available, and swallows a failing call", () => {
    expect(enableCliCompileCache({ enableCompileCache: () => ({ enabled: true }) }, {})).toBe("enabled");
    expect(
      enableCliCompileCache(
        {
          enableCompileCache: () => {
            throw new Error("read-only tmpdir");
          },
        },
        {},
      ),
    ).toBe("failed");
  });
});

// The built CLI is only present after `pnpm run build`; skip rather than fail
// in a source-only checkout.
describe.skipIf(!existsSync(CLI))("#6478 CLI compile cache end-to-end", () => {
  it("writes a compile cache by default, respects the opt-out, and stays byte-identical", () => {
    // Drive the default (no NODE_COMPILE_CACHE) path through TMPDIR: our call
    // uses Node's default cache location, `os.tmpdir()/node-compile-cache`.
    // Setting NODE_COMPILE_CACHE would prove nothing — Node honours that
    // variable on its own, with or without our call.
    const cacheDir = mkdtempSync(join(tmpdir(), "js2wasm-6478-cache-"));
    const offDir = mkdtempSync(join(tmpdir(), "js2wasm-6478-off-"));
    try {
      const cached = runCli({ TMPDIR: cacheDir, NODE_COMPILE_CACHE: undefined });
      const off = runCli({ TMPDIR: offDir, NODE_COMPILE_CACHE: undefined, JS2WASM_NO_COMPILE_CACHE: "1" });

      const hasCache = (d: string) => readdirSync(d).includes("node-compile-cache");
      expect(hasCache(cacheDir)).toBe(true);
      expect(hasCache(offDir)).toBe(false);
      expect(Array.from(off)).toEqual(Array.from(cached));
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(offDir, { recursive: true, force: true });
    }
  }, 300_000);
});
