// #4743 — standalone namespace carriers must expose ES2015 Symbol.toStringTag.
// The exact Test262 rows validate value and descriptor semantics; the direct
// smoke proves the new carrier seeds stay host-free.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const NAMESPACE_TAG_ROWS = ["built-ins/Math/Symbol.toStringTag.js", "built-ins/Reflect/Symbol.toStringTag.js"] as const;

describe("#4743 — standalone Math and Reflect Symbol.toStringTag", () => {
  for (const row of NAMESPACE_TAG_ROWS) {
    it(`passes the exact ${row} row in standalone mode`, async () => {
      const result = await runTest262File(
        join("test262/test", row),
        row.slice(0, row.lastIndexOf("/")),
        30_000,
        "standalone",
      );
      expect(result.status, `${result.file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    });

    it(`keeps the exact ${row} row passing in the host lane`, async () => {
      const result = await runTest262File(join("test262/test", row), row.slice(0, row.lastIndexOf("/")), 30_000);
      expect(result.status, `${result.file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    });
  }

  it("returns both namespace tags without standalone host imports", async () => {
    const result = await compile(
      `export function test(): number {
        return Math[Symbol.toStringTag] === "Math" && Reflect[Symbol.toStringTag] === "Reflect" ? 1 : 0;
      }`,
      { fileName: "issue-4743.ts", target: "standalone" },
    );
    expect(result.success, result.success ? "" : result.errors?.map((e) => e.message).join("; ")).toBe(true);
    const imports = WebAssembly.Module.imports(await WebAssembly.compile(result.binary));
    expect(imports, "namespace tag reads stay host-free").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });
});
