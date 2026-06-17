import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { runTest262File } from "./test262-runner.js";

/**
 * #2183 — The test262 runner never injected `proxyTrapsHelper.js`'s
 * `allowProxyTraps` helper, so every `built-ins/Proxy/*` test that includes it
 * saw `allowProxyTraps` as undefined → `null` handler → construction TypeError
 * (after #2180), masking the actual assertion. Injecting the helper (gated on
 * the `includes`) flips these `*-prototype*` cases to pass once #2180's
 * host-mode trap dispatch is present on main.
 */

const TEST262 = "/workspace/test262";
const ROOT = `${TEST262}/test/built-ins/Proxy`;

const cases = [
  "has/call-in-prototype.js",
  "set/call-parameters-prototype.js",
  "set/call-parameters-prototype-dunder-proto.js",
];

const maybe = existsSync(TEST262) ? describe : describe.skip;

maybe("#2183 proxyTrapsHelper injection", () => {
  for (const rel of cases) {
    it(rel, async () => {
      const r = await runTest262File(`${ROOT}/${rel}`, "built-ins/Proxy");
      expect(r.status, `error: ${(r as any).error ?? ""}`).toBe("pass");
    });
  }
});
