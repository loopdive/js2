/**
 * #4785 — standalone WeakMap/WeakSet insertion-key TypeErrors.
 *
 * The exact two-row cohort exercises nullish, primitive, and registered-symbol
 * insertion keys. The controls retain valid object/symbol insertion and the
 * spec's absent-result behavior for primitive probes.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const COHORT = [
  "built-ins/WeakMap/prototype/set/throw-if-key-cannot-be-held-weakly.js",
  "built-ins/WeakSet/prototype/add/throw-when-value-cannot-be-held-weakly.js",
] as const;

const CONTROLS = [
  "built-ins/WeakMap/prototype/set/adds-object-element.js",
  "built-ins/WeakMap/prototype/set/adds-symbol-element.js",
  "built-ins/WeakMap/prototype/has/returns-false-when-key-cannot-be-held-weakly.js",
  "built-ins/WeakSet/prototype/add/adds-object-element.js",
  "built-ins/WeakSet/prototype/add/adds-symbol-element.js",
  "built-ins/WeakSet/prototype/has/returns-false-when-value-cannot-be-held-weakly.js",
] as const;

async function run(file: string, target?: "standalone") {
  return runTest262File(join("test262/test", file), file.split("/").slice(0, 2).join("/"), 120_000, target);
}

describe("#4785 — WeakMap/WeakSet primitive insertion keys", () => {
  it.each(COHORT)("passes the exact host row %s", async (file) => {
    const result = await run(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(COHORT)("passes the exact standalone row %s", async (file) => {
    const result = await run(file, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(CONTROLS)("keeps the host control %s passing", async (file) => {
    const result = await run(file);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(CONTROLS)("keeps the standalone control %s passing", async (file) => {
    const result = await run(file, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
