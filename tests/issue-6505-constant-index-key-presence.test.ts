// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6505 — a CONSTANT index key on an array receiver must reach the runtime
// presence native, not the named-key fold.
//
// The symptom was reported as "`arr.hasOwnProperty("1")` answers true only for
// index 0". Measured, the discriminator is not the index — it is the ORDER of
// the queries. `provesDenseLiteralOwnIndex` (object-ops.ts) is deliberately
// local: it refuses as soon as ANY identifier reference to the receiver sits
// between the declaration and the call. So in
//
//   var arr = [0, 1]; arr.hasOwnProperty("0"); arr.hasOwnProperty("1");
//
// only the FIRST query proves; the second sees the first as an intervening
// reference, the proof fails, and — because the arm below it was gated on
// `elemIsRef` — an f64-carrier vec fell through to the named-key fold, whose
// key set is `["length", "data"]`. That fold answers a constant `false`.
// Reversing the two calls moves the single `true` to index 1, which is what
// pins the cause to ordering rather than to the index value (`RES reversed`
// in the round-9 probe: `true,false` for `("2"), ("0")`).
//
// THESE CASES MUST RUN IN THE LINKED LANE for the same reason as the #6482 r3
// guard: a single-module compile lowers the whole expression in-wasm and never
// consults the host arm, so a plain `compile()` test asserts nothing here — and
// indeed the single-module answer was already correct while the linked one was
// not.
//
// Measured 2026-09-18, real runner, fresh harness cache per arm, both bundles
// rebuilt between arms: 947-row slice (`Object/prototype/hasOwnProperty/**`,
// `Array/prototype/**` rows mentioning `hasOwn`, the 735-file
// `Object/defineProperty/15.2.3.6-4-*` control, the 114-row #6482 bucket)
// linked 749 → 749; a further 86-row slice of every corpus file that calls
// `hasOwnProperty` with a literal index linked 53 → 53; the 193-row honest
// control 122 → 122. **0 gained and 0 lost everywhere** — the rows that would
// show this are masked by other failures, exactly as #6505 predicted. The fix
// is carried by these behaviour cases, not by a row count.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6505-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const providers = new Map<string, HarnessProvider>();
async function providerFor(harnessPrefix: string): Promise<HarnessProvider> {
  let provider = providers.get(harnessPrefix);
  if (!provider) {
    provider = await buildHarnessProvider({ harnessPrefix, cacheDir: CACHE, compileOptions: OPTIONS });
    providers.set(harnessPrefix, provider);
  }
  return provider;
}

async function runLinked(source: string): Promise<string> {
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await providerFor(assembly.harnessPrefix);
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  if (!result.success) return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  const importObject = buildImports(result.imports as never, { console }, result.stringPool as never);
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      runDeferredInit: true,
      linkedRuntime,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error)}`;
  }
}

const HEADER = `/*---\nincludes: [propertyHelper.js]\n---*/\n`;

describe("#6505 — a constant index key is answered by the runtime, not the named-key fold", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(`${HEADER}\n`, parseMeta(`${HEADER}\n`)).harnessPrefix);
  }, 600_000);

  // The reported table, lengths 1..5. Every in-bounds index of a DENSE f64-vec
  // literal is own, however many queries precede it. Lengths 2..5 all fail with
  // the codegen reverted (`"true,false"`, `"true,false,false"`, …).
  for (const length of [1, 2, 3, 4, 5]) {
    it(`answers true for every index of a dense length-${length} array`, async () => {
      const elements = Array.from({ length }, (_, i) => String(i)).join(", ");
      const queries = Array.from({ length }, (_, i) => `String(arr.hasOwnProperty("${i}"))`).join(' + "," + ');
      const expected = Array.from({ length }, () => "true").join(",");
      expect(
        await runLinked(
          `${HEADER}var arr = [${elements}];\n` + `assert.sameValue(${queries}, "${expected}", "dense own indices");`,
        ),
      ).toBe("pass");
    }, 300_000);
  }

  // The ordering witness: ask index 2 FIRST. With the codegen reverted the
  // single `true` follows the query order rather than the index, which is the
  // fact that rules out "only index 0 works" as the description.
  it("does not depend on which index is asked first", async () => {
    expect(
      await runLinked(
        `${HEADER}var arr = [0, 1, 2];\n` +
          `assert.sameValue(String(arr.hasOwnProperty("2")) + "," + String(arr.hasOwnProperty("0")), "true,true", "order");`,
      ),
    ).toBe("pass");
  }, 300_000);

  // The other direction, and the #6482 round-4 rule this must not undo: a HOLE
  // is still not an own property, and the elements around it still are. The
  // fold could have been "fixed" by answering `true` for any in-bounds index;
  // that would pass the cases above and break this one.
  it("still answers false for a hole, and true for the elements around it", async () => {
    expect(
      await runLinked(
        `${HEADER}var arr = [0, , 2];\n` +
          `assert.sameValue(\n` +
          `  String(arr.hasOwnProperty("0")) + "," + String(arr.hasOwnProperty("1")) + "," + String(arr.hasOwnProperty("2")),\n` +
          `  "true,false,true", "sparse own indices");`,
      ),
    ).toBe("pass");
  }, 300_000);

  // An out-of-bounds constant index stays absent.
  it("answers false for an out-of-bounds constant index", async () => {
    expect(
      await runLinked(
        `${HEADER}var arr = [0, 1];\n` +
          `assert.sameValue(String(arr.hasOwnProperty("0")) + "," + String(arr.hasOwnProperty("7")), "true,false", "oob");`,
      ),
    ).toBe("pass");
  }, 300_000);

  // The computed-key form was already correct and must stay so — it is the
  // control that showed the defect was specific to the constant-key lowering.
  it("leaves the computed-key form unchanged", async () => {
    expect(
      await runLinked(
        `${HEADER}var arr = [0, 1, 2];\nvar seen = "";\n` +
          `for (var i = 0; i < 3; i++) { seen += String(arr.hasOwnProperty(String(i))) + ","; }\n` +
          `assert.sameValue(seen, "true,true,true,", "computed keys");`,
      ),
    ).toBe("pass");
  }, 300_000);
});
