// #1868 — the linear-memory backend must never report `success: true` while
// emitting a structurally invalid binary.
//
// Root cause: `generateLinearModule` / `generateLinearMultiModule` accumulate
// unsupported-construct diagnostics into `ctx.errors`, but `compiler.ts` never
// read them. An unhandled string method such as `String.prototype.repeat`
// pushed an error and returned WITHOUT leaving a value on the Wasm stack, so
// the following `local.set` / `local.tee` / `call` underflowed the stack. The
// compiler then handed back `{ success: true, binary }` where the binary fails
// `WebAssembly.compile` ("not enough arguments on the stack for local.set").
// That invalid wasm crashed the benchmark harness (Refresh Benchmarks CI).
//
// Fix: surface `ctx.errors` via `mod.codegenErrors` and fail the compile
// (`success: false`) instead of emitting the invalid binary.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// Constructs the linear backend does NOT lower. Each previously produced an
// invalid binary with `success: true`.
//
// (#7014) `String.prototype.repeat` used to be the main entry here. The linear
// backend has lowered it natively since 5d028548eb ("feat(linear): add native
// String.repeat support", 2026-08-09), so those three rows moved to
// FORMERLY_UNSUPPORTED_LINEAR below, which asserts the stronger property the
// fallback test at the end of this file anticipated: a valid binary that
// computes the JS answer.
const UNSUPPORTED_LINEAR = [
  [
    "String.prototype.replace",
    `export function run(): number { const t = "the quick brown fox"; return t.replace("fox", "cat").length; }`,
  ],
] as const;

// (#7014) Rows that were unsupported when #1868 landed and are lowered now —
// each must compile, validate and return what JS returns.
const FORMERLY_UNSUPPORTED_LINEAR = [
  ['"x".repeat(n) bound to a const', `export function run(): number { const c = "x".repeat(8); return c.length; }`, 8],
  ['"x".repeat(n) inline', `export function run(): number { return "ab".repeat(4).length; }`, 8],
  ["indexOf after repeat", `export function run(): number { const h = "ab".repeat(10); return h.indexOf("a"); }`, 0],
] as const;

describe("#1868 — linear backend never emits invalid wasm with success:true", () => {
  for (const [label, src, expected] of FORMERLY_UNSUPPORTED_LINEAR) {
    it(`lowers ${label} to valid wasm with the JS result`, async () => {
      const result = await compile(src, { target: "linear" });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary);
      expect((instance.exports as Record<string, Function>).run()).toBe(expected);
    });
  }

  for (const [label, src] of UNSUPPORTED_LINEAR) {
    it(`reports success:false for ${label}`, async () => {
      const result = await compile(src, { target: "linear" });
      // The compile must fail rather than emit a structurally invalid binary.
      expect(result.success, `expected compile to fail for unsupported construct, got success=true`).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => /Codegen error:/.test(e.message))).toBe(true);
    });
  }

  it("does NOT emit a success:true binary that fails WebAssembly.compile", async () => {
    for (const [, src] of UNSUPPORTED_LINEAR) {
      const result = await compile(src, { target: "linear" });
      if (result.success) {
        // If a future change DOES lower the construct, the emitted binary
        // must at minimum be structurally valid.
        await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
      }
    }
  });

  // Supported linear constructs must keep compiling to VALID, runnable wasm —
  // the error-propagation change must not over-trigger.
  it("still compiles supported string ops to valid, runnable wasm", async () => {
    const result = await compile(`export function run(): number { const h = "abcdef"; return h.indexOf("c"); }`, {
      target: "linear",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports as Record<string, Function>).run()).toBe(2);
  });

  it("string/split compiles to valid wasm (the benchmark that crashed CI)", async () => {
    // split itself lowers fine; the CI crash was a runtime OOB in the bump
    // allocator over many iterations, not invalid codegen. The binary must
    // still be structurally valid + a single call must run.
    const result = await compile(
      `export function run(): number { const csv = "a,b,c,d"; const parts = csv.split(","); return parts.length; }`,
      { target: "linear" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports as Record<string, Function>).run()).toBe(4);
  });
});
