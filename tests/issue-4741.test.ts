// #4741 — a null native-string description slot is semantic `undefined`.
// The exact upstream getter row exercises the original Test262 harness, while
// the direct smoke keeps the null and non-null values on the public boundary.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const DESCRIPTION_GETTER = "built-ins/Symbol/prototype/description/get.js";

describe("#4741 — standalone Symbol.prototype.description", () => {
  it("passes the exact ES2015 getter row in standalone mode", async () => {
    const result = await runTest262File(
      join("test262/test", DESCRIPTION_GETTER),
      "built-ins/Symbol/prototype/description",
      30_000,
      "standalone",
    );
    expect(result.status, `${result.file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it("keeps the exact getter row passing in the host lane", async () => {
    const result = await runTest262File(
      join("test262/test", DESCRIPTION_GETTER),
      "built-ins/Symbol/prototype/description",
      30_000,
    );
    expect(result.status, `${result.file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it("maps absent descriptions to undefined without changing strings", async () => {
    const result = await compile(
      `export function test(): number {
        const absent = Symbol().description;
        const explicitUndefined = Symbol(undefined).description;
        const empty = Symbol("").description;
        const present = Symbol("x").description;
        return absent === undefined && explicitUndefined === undefined && empty === "" && present === "x" ? 1 : 0;
      }`,
      { fileName: "issue-4741.ts", target: "standalone" },
    );
    expect(result.success, result.success ? "" : result.errors?.map((e) => e.message).join("; ")).toBe(true);
    const imports = WebAssembly.Module.imports(await WebAssembly.compile(result.binary));
    expect(imports, "standalone Symbol descriptions stay host-free").toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(1);
  });
});
