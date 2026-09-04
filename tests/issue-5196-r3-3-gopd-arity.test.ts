// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5196 R3-3 (E-2) — `Object.getOwnPropertyDescriptor(o)` with ONE argument
 * compiles in standalone.
 *
 * §20.1.2.8 does not require a second argument: step 2 is
 * `ToPropertyKey(undefined)`, i.e. the key `"undefined"`. The call site's gate
 * demanded two, so the call fell through to `__get_builtin` and became the
 * "#1472 Phase B dynamic-shape" hard COMPILE error — the whole module failed to
 * compile, so the row could not even run. It now routes to the dynamic native
 * with the undefined sentinel as the key, which puts the receiver's own front
 * guards (a revoked `$Proxy` throws its TypeError there) in the normal place.
 *
 * The row below is a `compile_error` on the r3 merge-base `4fa179f8` (verified
 * by the implementer, 2026-09-04) and passes here. It is the ONLY 1-argument
 * `getOwnPropertyDescriptor` call in the whole test262 corpus (measured by
 * grep over `built-ins/` + `language/`), which is also the blast radius.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");
const TIMEOUT_MS = 180_000;
const RUNNER_TIMEOUT_MS = 120_000;
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const test262It = TEST262_AVAILABLE ? it : it.skip;

const CLAIMED_ROW = "built-ins/Proxy/getOwnPropertyDescriptor/null-handler.js";

const CONTROL_SOURCE = `
  export function test(): number {
    // One argument on an ordinary object: the key is ToPropertyKey(undefined),
    // i.e. "undefined" — absent here, so the answer is undefined, not a
    // compile error and not a throw.
    const plain: any = { a: 1 };
    if (Object.getOwnPropertyDescriptor(plain) !== undefined) return 1;

    // ...and present when the object really owns "undefined".
    const owning: any = { undefined: 7 };
    const desc: any = Object.getOwnPropertyDescriptor(owning);
    if (desc === undefined) return 2;
    if (desc.value !== 7) return 3;

    // The two-argument form is untouched.
    const two: any = Object.getOwnPropertyDescriptor(plain, "a");
    if (two === undefined) return 4;
    if (two.value !== 1) return 5;

    // A revoked proxy throws from the receiver's own front guard.
    const pair: any = Proxy.revocable({}, {});
    pair.revoke();
    try {
      Object.getOwnPropertyDescriptor(pair.proxy);
      return 6;
    } catch (error) {
      if (!(error instanceof TypeError)) return 7;
    }
    return 0;
  }
`;

describe("#5196 R3-3 E-2 standalone one-argument getOwnPropertyDescriptor", () => {
  it(
    'standalone: compiles, answers by key "undefined", and keeps the 2-arg form',
    { timeout: TIMEOUT_MS },
    async () => {
      const result = await compile(CONTROL_SOURCE, {
        allowJs: true,
        fileName: "issue-5196-r3-3-gopd-arity.ts",
        skipSemanticDiagnostics: true,
        target: "standalone" as const,
      });
      expect(
        result.success,
        `standalone control compile failed:\n${result.errors?.map((e) => `L${e.line}: ${e.message}`).join("\n") ?? ""}`,
      ).toBe(true);
      if (!result.success) return;

      const module = await WebAssembly.compile(result.binary);
      const imports = WebAssembly.Module.imports(module).map((entry) => `${entry.module}::${entry.name}`);
      expect(imports, "standalone gOPD-arity control must emit zero imports").toEqual([]);

      const { instance } = await WebAssembly.instantiate(result.binary, {});
      expect((instance.exports as { test: () => number }).test()).toBe(0);
    },
  );

  test262It(`standalone exact Test262 row: ${CLAIMED_ROW}`, { timeout: TIMEOUT_MS }, async () => {
    try {
      const result = await runTest262File(
        join(TEST262_ROOT, "test", CLAIMED_ROW),
        "issue-5196-r3-3",
        RUNNER_TIMEOUT_MS,
        "standalone",
      );
      expect(result.status, `${CLAIMED_ROW}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    } finally {
      restoreHostBuiltins();
    }
  });
});
