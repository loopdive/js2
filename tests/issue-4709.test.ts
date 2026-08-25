import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(process.cwd(), "test262", "test");

describe("#4709 — for-of restores the outer lexical head binding", () => {
  it("passes the exact post-loop scope row", async () => {
    const result = await runTest262File(
      join(TEST262, "language/statements/for-of/scope-body-lex-close.js"),
      "issue-4709",
      30_000,
    );
    expect(result.status, JSON.stringify(result)).toBe("pass");
  });

  it("keeps the body closure on the iteration binding and restores the outer binding", async () => {
    const source = `
      export function test(): number {
        let x = 0;
        let probe = () => 0;
        for (let x of [1]) probe = () => x;
        return probe() * 10 + x;
      }
    `;
    const result = await compile(source, { fileName: "issue-4709-control.ts", target: "standalone" });
    expect(result.success, result.success ? "" : JSON.stringify(result.errors)).toBe(true);
    if (!result.success) return;
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(10);
  });

  it("retains the passing per-iteration and var controls", async () => {
    for (const file of [
      "language/statements/for-of/scope-body-lex-boundary.js",
      "language/statements/for-of/scope-body-var-none.js",
    ]) {
      const result = await runTest262File(join(TEST262, file), "issue-4709-control", 30_000);
      expect(result.status, `${file}: ${JSON.stringify(result)}`).toBe("pass");
    }
  });
});
