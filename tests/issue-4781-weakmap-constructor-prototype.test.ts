/**
 * #4781 — the ES2015 WeakMap constructor is a built-in function, so
 * `Object.getPrototypeOf(WeakMap)` must be the intrinsic Function.prototype.
 * Keep the nearby constructor and instance-operation rows as controls for the
 * narrow getPrototypeOf lowering.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TARGET = "built-ins/WeakMap/prototype-of-weakmap.js";
const CONTROLS = [
  "built-ins/WeakMap/prototype/prototype-attributes.js",
  "built-ins/WeakMap/no-iterable.js",
  "built-ins/WeakMap/length.js",
  "built-ins/WeakMap/is-a-constructor.js",
  "built-ins/WeakMap/prototype/set/set.js",
  "built-ins/WeakMap/prototype/has/has.js",
] as const;

async function run(file: string, target?: "standalone") {
  return runTest262File(join("test262/test", file), "built-ins/WeakMap", 120_000, target);
}

describe("#4781 — WeakMap constructor prototype identity", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";

    it(`${lane}: the exact constructor prototype row passes`, async () => {
      const result = await run(TARGET, target);
      expect(result.status, `${TARGET}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    });

    it.each(CONTROLS)(`${lane}: nearby WeakMap control %s passes`, async (file) => {
      const result = await run(file, target);
      expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    });
  }
});
