import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";

// #2603: `--emulate node` opts into Node API emulation — the checker is given an
// ambient `process` declaration so the Node globals js2wasm lowers type-check
// without @types/node, and the repeated TS2580 "Cannot find name 'process'"
// warning disappears. Without the flag, that warning instead suggests adding it.
// Type-level only; emitted wasm is unchanged (md5-verified during development).

function messageOf(d: { messageText: string | { messageText: string } }): string {
  return typeof d.messageText === "string" ? d.messageText : d.messageText.messageText;
}
const processNotFound = (diags: readonly { code: number; messageText: string | { messageText: string } }[]) =>
  diags.some((d) => (d.code === 2580 || d.code === 2304) && /'process'/.test(messageOf(d)));

describe("#2603 ambient `process` typing via --emulate node", () => {
  it("resolves `process` with emulateNode (no TS2580 'Cannot find name process')", () => {
    const src = [
      `process.stdout.write("hi");`,
      `process.stderr.write("e");`,
      `process.stdin.read(new Uint8Array(4));`,
      `const a = process.argv;`,
      `const e = process.env.HOME;`,
      `process.exit(0);`,
    ].join("\n");
    const ast = analyzeSource(src, "input.ts", { emulateNode: true });
    expect(processNotFound(ast.diagnostics)).toBe(false);
  });

  it("still flags `process` WITHOUT emulateNode (opt-in, not default)", () => {
    const ast = analyzeSource(`process.stdout.write("hi");`, "input.ts", { emulateNode: false });
    expect(processNotFound(ast.diagnostics)).toBe(true);
  });

  it("does NOT suppress genuinely-undefined names with emulateNode", () => {
    const src = `process.stdout.write("x");\nnonexistentThing.foo();`;
    const ast = analyzeSource(src, "input.ts", { emulateNode: true });
    expect(processNotFound(ast.diagnostics)).toBe(false);
    expect(ast.diagnostics.some((d) => /nonexistentThing/.test(messageOf(d)))).toBe(true);
  });

  it("falls back (no injection) when the user declares `process` — no duplicate-identifier error", () => {
    const src = `declare const process: { stdout: { write(s: string): void } };\nprocess.stdout.write("x");`;
    const ast = analyzeSource(src, "input.ts", { emulateNode: true });
    const dup = ast.diagnostics.some((d) => d.code === 2300 || d.code === 2403 || d.code === 2451);
    expect(dup).toBe(false);
  });

  it("without --emulate node, the `process` warning suggests the flag", async () => {
    const result = await compile(`process.stdout.write("hi");`, { target: "wasi" });
    const procWarn = result.errors.find((e) => e.code === 2580 && /process/.test(e.message));
    expect(procWarn).toBeDefined();
    expect(procWarn?.severity).toBe("warning");
    expect(procWarn?.message).toContain("--emulate node");
  });

  it("with --emulate node, no `process` warning is emitted", async () => {
    const result = await compile(`process.stdout.write("hi");`, { target: "wasi", emulateNode: true });
    expect(result.errors.some((e) => e.code === 2580 && /process/.test(e.message))).toBe(false);
  });
});
