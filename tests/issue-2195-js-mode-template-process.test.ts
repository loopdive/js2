// #2195 — external bug report loopdive/js2wasm#389 (native-messaging host,
// 2026-06-18). Compiling a *.js* file (untyped params → checker sees `any`)
// under --target wasi hit two problems:
//   1. A numeric template-literal substitution on an `any`-typed value aborted
//      with a fatal "Template literal numeric substitution requires
//      number_toString" — the checker-based primitiveNeeded pre-pass missed it
//      while codegen still lowered the value as numeric.
//   2. `process` raised TS2580 at *error* severity even though it is supported
//      natively under WASI (node-fs-api.ts).
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

const JS_SRC = `
function logFrameBodyRead(declaredLen) {
  process.stderr.write(\`[host] received \${4 + declaredLen} chars, declared body length \${declaredLen}\\n\`);
}
function main() {
  logFrameBodyRead(7);
}
`;

describe("js-mode template numeric substitution + process under WASI", () => {
  it("compiles a .js file with an untyped numeric template span (no number_toString abort)", async () => {
    const result = await compile(JS_SRC, { fileName: "host.js", target: "wasi" });
    expect(result.success).toBe(true);
    expect(result.binary.length).toBeGreaterThan(0);
    const fatal = (result.errors ?? []).filter((e) => e.severity === "error");
    expect(fatal).toEqual([]);
  });

  it("downgrades `process` TS2580 to a warning, not an error", async () => {
    const result = await compile(JS_SRC, { fileName: "host.js", target: "wasi" });
    const procDiags = (result.errors ?? []).filter((e) => e.code === 2580);
    expect(procDiags.length).toBeGreaterThan(0);
    expect(procDiags.every((e) => e.severity === "warning")).toBe(true);
  });
});
