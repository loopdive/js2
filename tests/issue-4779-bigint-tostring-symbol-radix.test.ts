/**
 * #4779 — standalone BigInt.prototype.toString radix conversion.
 *
 * The exact residual exercises the static Symbol → ToNumber abrupt path;
 * the numeric radix row keeps the native formatter's ordinary path covered.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const COHORT = "built-ins/BigInt/prototype/toString/radix-tointegerorinfinity-throws-symbol.js";
const CONTROL = "built-ins/BigInt/prototype/toString/radix-2-to-36.js";

async function run(file: string, target?: "standalone") {
  return runTest262File(resolve("test262/test", file), "built-ins/BigInt/prototype/toString", 120_000, target);
}

describe("#4779 — BigInt.prototype.toString Symbol radix", () => {
  it("passes the exact host residual", async () => {
    const result = await run(COHORT);
    expect(result.status, `${COHORT}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it("passes the exact standalone residual", async () => {
    const result = await run(COHORT, "standalone");
    expect(result.status, `${COHORT}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it("keeps ordinary numeric radix formatting passing in host", async () => {
    const result = await run(CONTROL);
    expect(result.status, `${CONTROL}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it("keeps ordinary numeric radix formatting passing standalone", async () => {
    const result = await run(CONTROL, "standalone");
    expect(result.status, `${CONTROL}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
