// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

// Five repaired pass -> compile_error rows from PR5748's merge-group
// 4bfa9a9eb15d894c1d25ef2a2e3759c9f92038d0. Execute the untouched sources
// with their original harness and strict reruns, never the synthetic wrapper.
// The sixth (dynamic-import/yield-star) remains blocked; see issue 5398.
const cases = [
  "built-ins/Array/prototype/indexOf/calls-only-has-on-prototype-after-length-zeroed.js",
  "built-ins/Array/prototype/lastIndexOf/calls-only-has-on-prototype-after-length-zeroed.js",
  "built-ins/TypedArrayConstructors/internals/Set/BigInt/key-is-valid-index-prototype-chain-set.js",
  "built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-prototype-chain-set.js",
  "language/statements/for-in/order-enumerable-shadowed.js",
];

describe("#5393: preserve the five repaired host guard controls", () => {
  it.each(cases)(
    "executes %s with the original harness",
    async (path) => {
      const file = resolve("test262/test", path);
      const sourceHash = createHash("sha256").update(readFileSync(file)).digest("hex");
      const result = await runTest262File(file, "guard-regression", 15_000);
      console.info(JSON.stringify({ sourceHash, ...result }));
      expect(result.status, JSON.stringify(result)).toBe("pass");
    },
    120_000,
  );
});

describe("#5393: retain the immutable audit's host refusals", () => {
  const manifest = JSON.parse(
    readFileSync(resolve("plan/audit/javascript-soundness-2026-09-08/manifest.json"), "utf8"),
  ) as {
    cases: { id: string; source?: string; sourcePath?: string }[];
  };
  for (const optimize of [0, 2] as const) {
    it.each([
      ["general/lookup-presence/inherited-array-element", "JS2WASM_UNSUPPORTED_ARRAY_PROTOTYPE"],
      ["general/iterator-generator/for-in-own-inherited", "JS2WASM_UNSOUND_ENUMERATION"],
      ["corpus/generators/05-yield-star.js", "JS2WASM_UNSUPPORTED_GENERATOR_DELEGATION_RESULT"],
      ["general/iterator-generator/yield-star-return", "JS2WASM_UNSUPPORTED_GENERATOR_DELEGATION_RESULT"],
    ])(`still refuses %s (host optimize=${optimize})`, async (id, diagnostic) => {
      const specimen = manifest.cases.find((entry) => entry.id === id);
      expect(specimen, id).toBeDefined();
      const source = specimen!.source ?? readFileSync(resolve(specimen!.sourcePath!), "utf8");
      const result = await compile(source, { allowJs: true, fileName: "audit-control.js", optimize });
      expect(result.success).toBe(false);
      expect(result.binary.length).toBe(0);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ severity: "error", message: expect.stringContaining(diagnostic) }),
      );
    });
  }
});
