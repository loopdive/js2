/**
 * `debugger;` is a no-op statement, not an unsupported one.
 *
 * Per ECMA-262 §13.16, evaluating a DebuggerStatement may trigger a breakpoint
 * if an implementation-defined debugging facility is available, and otherwise
 * "has no observable effect". Wasm exposes no such facility, so eliding it is
 * spec-correct. The linear backend already did this
 * (`src/codegen-linear/index.ts`); the WasmGC backend fell through to
 * `Unsupported statement: LastStatement` (SyntaxKind.LastStatement === 260 ===
 * DebuggerStatement) and failed the whole compile.
 *
 * This was the first hard codegen blocker when compiling the `typescript` npm
 * package (#1058 / #1579): `node_modules/typescript/lib/_tsc.js` contains
 * exactly one `debugger;`, at line 1279, and that single statement aborted a
 * 6.2 MB bundle.
 */
import { describe, expect, it } from "vitest";
import { compileAndRunResultObject as compileAndRun } from "./helpers/compile.js";
import { compile } from "../src/index.js";

describe("debugger statement", () => {
  it("is elided inside a function without disturbing surrounding statements", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        let x = 1;
        debugger;
        x = x + 1;
        return x;
      }
    `);
    expect(r.success, r.error).toBe(true);
    expect(r.result).toBe(2);
  });

  it("does not break control flow inside a loop body", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        let s = 0;
        for (let i = 0; i < 4; i++) {
          debugger;
          s = s + i;
        }
        return s;
      }
    `);
    expect(r.success, r.error).toBe(true);
    expect(r.result).toBe(6);
  });

  it("is elided in a conditional branch without collapsing the branch", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        let n = 0;
        if (n === 0) {
          debugger;
          n = 10;
        } else {
          n = 20;
        }
        return n;
      }
    `);
    expect(r.success, r.error).toBe(true);
    expect(r.result).toBe(10);
  });

  it("compiles at top level", async () => {
    const result = await compile(
      `
      debugger;
      export function run(): number { return 7; }
    `,
      { fileName: "top.ts" },
    );
    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("compiles in a JS source file (the tsc-bundle shape)", async () => {
    const result = await compile(
      `
      export function run() {
        debugger;
        return 42;
      }
    `,
      { allowJs: true, fileName: "bundle.js" },
    );
    expect(result.success, result.errors[0]?.message).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });
});
