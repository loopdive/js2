// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta, runTest262File } from "./test262-runner.js";

const originals = [
  "built-ins/Function/prototype/apply/S15.3.4.3_A5_T1.js",
  "built-ins/Function/prototype/apply/S15.3.4.3_A5_T2.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A5_T1.js",
  "built-ins/Function/prototype/call/S15.3.4.4_A5_T2.js",
];
describe("#6976 unchanged original primitive thisArg controls (honest standalone)", () => {
  for (const original of originals) {
    it(original, async () => {
      const path = resolve(import.meta.dirname, "../test262/test", original);
      const source = readFileSync(path, "utf8");
      const assembly = assembleOriginalHarness(source, parseMeta(source));
      if (process.env.TEST262_STRICT_RERUN === "always") {
        expect(assembly.strictRerun?.strict).toBe(true);
      } else {
        expect(assembly.strictRerun?.strict === true || assembly.strictRerunSkipped === "strict-neutral").toBe(true);
      }
      const result = await runTest262File(path, "built-ins/Function", 30000, "standalone");
      console.log("original-corpus-verdict", JSON.stringify(result));
      expect(result.file).toBe(`test/${original}`);
      expect(result.status, JSON.stringify(result)).toBe("pass");
      expect(result.wasm_sha).toMatch(/^[a-f0-9]{12}$/);
    });
  }
});
