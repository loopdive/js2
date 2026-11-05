// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 census arm 4 — the real test262 harness's `assert` and `compareArray`
// ship IR bodies. Their member calls on the unannotated top-level `assert`
// (`assert._toString(mustBeTrue)`, `assert._isSameValue(b[i], a[i])`) lower
// through the boxed receiver plan (Get, then Call with `this` = `assert`), and
// `assert`'s lattice-boolean `mustBeTrue` reaches the call boxed as a Boolean.
// The honest original-harness assembly runs a body whose observable log is
// computed by node first, so every message and comparison is checked against
// the reference engine on the host-free and the host lane.
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

const BODY = `/*---
description: assert / compareArray member calls on the unannotated harness assert
---*/
var log = "";
try { assert(false); } catch (e) { log += (e instanceof Test262Error) + ":" + e.message + "|"; }
try { assert(false, "custom"); } catch (e) { log += e.message + "|"; }
try { assert(1 === 1); log += "ok|"; } catch (e) { log += "bad|"; }
log += compareArray([1, 2, NaN], [1, 2, NaN]) + "|" + compareArray([0], [-0]) + "|" + compareArray([1], [1, 2]) + "|";
try { assert.sameValue(1, 2); } catch (e) { log += e.message + "|"; }
if (log !== EXPECTED) throw new Test262Error("mismatch: " + log);
`;

function assemble(source: string): string {
  return assembleOriginalHarness(source, parseMeta(source) as never).primary.source;
}

/** The log node produces for BODY under the same harness assembly. */
function nodeLog(): string {
  const context = vm.createContext({ console });
  vm.runInContext(assemble(BODY.replace("if (log !== EXPECTED)", "globalThis.__log = log; if (false)")), context);
  return (context as { __log: string }).__log;
}

async function compileHarness(source: string, target: "standalone" | undefined) {
  return compile(assemble(source), {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(target ? { target } : {}),
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    hostBridge: "always",
    trackIrOutcomes: true,
  } as Parameters<typeof compile>[1]);
}

async function runHarness(result: Awaited<ReturnType<typeof compile>>, target: "standalone" | undefined) {
  const imports = (target === "standalone" ? {} : result.importObject) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (result.importObject as { setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.setInstance?.(instance);
  const exports = instance.exports as Record<string, (() => void) | undefined>;
  exports.__module_init?.();
  exports.test?.();
}

describe("#7106 census arm 4 — harness assert / compareArray member calls", () => {
  const expected = nodeLog();

  it("node reference log", () => {
    expect(expected).toBe(
      "true:Expected true but got false|custom|ok|true|false|false|Expected SameValue(«1», «2») to be true|",
    );
  });

  for (const target of ["standalone", undefined] as const) {
    const lane = target ?? "host";

    it(`assert and compareArray ship IR bodies and match node (${lane})`, async () => {
      const result = await compileHarness(BODY.replace("EXPECTED", JSON.stringify(expected)), target);
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      for (const unit of ["assert", "compareArray"]) {
        const row = (result.irOutcomes ?? []).find((outcome) => outcome.displayName === unit);
        expect(row?.irBodyEmitted, `${unit} on ${lane}: ${JSON.stringify(row)}`).toBe(true);
      }
      await expect(runHarness(result, target)).resolves.toBeUndefined();
    });

    it(`a wrong expectation still throws, so the run is observed (${lane})`, async () => {
      const result = await compileHarness(BODY.replace("EXPECTED", JSON.stringify(`${expected}X`)), target);
      expect(result.success).toBe(true);
      await expect(runHarness(result, target)).rejects.toBeDefined();
    });
  }
});
