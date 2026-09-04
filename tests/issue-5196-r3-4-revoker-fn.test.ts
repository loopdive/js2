// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5196 R3-4 — the `Proxy.revocable(…).revoke` carrier is a first-class
 * built-in FUNCTION in standalone.
 *
 * §28.2.2.1.1 makes the revocation function an anonymous built-in function with
 * `length` 0 and `name` `""` (both `{writable:false, enumerable:false,
 * configurable:true}`), and it is NOT a constructor. Before this step the
 * carrier was a one-field struct known only to `__apply_closure`, so
 * `typeof revoke` answered "object" through any indirection, every reflective
 * read missed (`gOPD(revoke,"length") === undefined`,
 * `revoke.hasOwnProperty("name") === false`, `getOwnPropertyNames(revoke)`
 * empty), and `new revoke()` evaluated to **null with no diagnostic**.
 *
 * All four rows below FAIL on the r3 merge-base `4fa179f8` (verified by the
 * implementer, 2026-09-03) and pass here.
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

const CLAIMED_ROWS = [
  "built-ins/Proxy/revocable/revocation-function-length.js",
  "built-ins/Proxy/revocable/revocation-function-name.js",
  "built-ins/Proxy/revocable/revocation-function-property-order.js",
  "built-ins/Proxy/revocable/revocation-function-not-a-constructor.js",
] as const;

/** Reads that all go through the revoker carrier's own function metadata. */
const CONTROL_SOURCE = `
  export function test(): number {
    const pair: any = Proxy.revocable({}, {});
    const revoke: any = pair.revoke;

    // typeof must survive indirection through a parameter, not just the
    // compile-time spelling.
    const viaParam = (function (f: any): string {
      return typeof f;
    })(revoke);
    if (viaParam !== "function") return 1;
    if (typeof revoke !== "function") return 2;

    if (revoke.length !== 0) return 3;
    if (revoke.name !== "") return 4;
    if (!Object.prototype.hasOwnProperty.call(revoke, "length")) return 5;
    if (!Object.prototype.hasOwnProperty.call(revoke, "name")) return 6;
    if (Object.prototype.hasOwnProperty.call(revoke, "prototype")) return 7;

    const names: any = Object.getOwnPropertyNames(revoke);
    if (names.indexOf("length") !== 0) return 8;
    if (names.indexOf("name") !== 1) return 9;

    const desc: any = Object.getOwnPropertyDescriptor(revoke, "length");
    if (desc === undefined) return 10;
    if (desc.configurable !== true) return 11;

    // Configurable means the delete must actually take effect.
    delete revoke.length;
    if (Object.prototype.hasOwnProperty.call(revoke, "length")) return 12;

    // The carrier still revokes after all of that reflection.
    pair.revoke();
    return 0;
  }
`;

describe("#5196 R3-4 standalone Proxy revocation function metadata", () => {
  it(
    "standalone: revoker is a function with own length/name and no [[Construct]]",
    { timeout: TIMEOUT_MS },
    async () => {
      const result = await compile(CONTROL_SOURCE, {
        allowJs: true,
        fileName: "issue-5196-r3-4-revoker-fn.ts",
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
      expect(imports, "standalone revoker-metadata control must emit zero imports").toEqual([]);

      const { instance } = await WebAssembly.instantiate(result.binary, {});
      expect((instance.exports as { test: () => number }).test()).toBe(0);
    },
  );

  for (const relativePath of CLAIMED_ROWS) {
    const filePath = join(TEST262_ROOT, "test", relativePath);
    test262It(`standalone exact Test262 row: ${relativePath}`, { timeout: TIMEOUT_MS }, async () => {
      try {
        const result = await runTest262File(filePath, "issue-5196-r3-4", RUNNER_TIMEOUT_MS, "standalone");
        expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
      } finally {
        restoreHostBuiltins();
      }
    });
  }
});
