import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

describe("inline initializer capture cells", () => {
  it.each(
    ["", ": any"].flatMap((annotation) =>
      ["42", "function () { return 42; }"].map((payload) => ({ annotation, payload })),
    ),
  )("keeps initialized cells inside their source frame ($annotation, $payload)", async ({ annotation, payload }) => {
    const result = await compileMulti(
      {
        "/core.ts": `export function stage(): void {
        (function () {
          const state: any = {};
          let queued${annotation} = undefined;
          Object.defineProperty(state, "queued", { get() { return queued; } });
          state.set = (value) => {
            if (queued !== undefined) throw new Error("already assigned");
            queued = value;
          };
          (globalThis as any).state = state;
        })();
      }`,
        "/entry.ts": `import { stage } from "./core.ts";
        stage();
        export function test(): number {
          const state: any = (globalThis as any).state;
          if (state.queued !== undefined) return -1;
          const value: any = ${payload};
          state.set(value);
          if (state.queued !== value) return -2;
          if (typeof value === "function" && state.queued() !== 42) return -4;
          try { state.set(7); } catch (error) {
            return state.queued === value ? 1 : -3;
          }
          return 0;
        }`,
      },
      "/entry.ts",
      { target: "standalone", hostBridge: "always", skipSemanticDiagnostics: true },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const output = execFileSync(
      process.execPath,
      [
        "--experimental-wasm-exnref",
        "-e",
        "const b=require('node:fs').readFileSync(0); const e=new WebAssembly.Instance(new WebAssembly.Module(b),{}).exports; process.stdout.write(String(e.test()));",
      ],
      { input: result.binary, encoding: "utf8" },
    );
    expect(Number(output)).toBe(1);
  });
});
