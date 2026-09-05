/**
 * #4776 — standalone `Symbol.prototype.valueOf` borrowed-call cohort.
 *
 * The two positive rows exercise a value-erased native-prototype closure with
 * a primitive Symbol and an Object(Symbol) receiver. The adjacent negative
 * rows keep the incompatible-receiver TypeError path honest.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const COHORT = [
  "built-ins/Symbol/prototype/valueOf/this-val-symbol.js",
  "built-ins/Symbol/prototype/valueOf/this-val-obj-symbol.js",
] as const;

const CONTROLS = [
  "built-ins/Symbol/prototype/valueOf/this-val-non-obj.js",
  "built-ins/Symbol/prototype/valueOf/this-val-obj-non-symbol.js",
] as const;

async function run(file: string, target?: "standalone") {
  return runTest262File(join("test262/test", file), "built-ins/Symbol/prototype/valueOf", 120_000, target);
}

describe("#4776 — Symbol.prototype.valueOf borrowed calls", () => {
  it.each(COHORT)("passes the exact host row %s", async (file) => {
    const result = await run(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(COHORT)("passes the exact standalone row %s", async (file) => {
    const result = await run(file, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(CONTROLS)("keeps the incompatible-receiver control %s passing in host", async (file) => {
    const result = await run(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(CONTROLS)("keeps the incompatible-receiver control %s passing standalone", async (file) => {
    const result = await run(file, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
