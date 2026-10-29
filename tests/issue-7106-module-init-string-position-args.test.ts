// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 (#6972 merge-group census) — once the harness `<module-init>` claims
// on standalone, a test body's String method call reaches the IR string-method
// arm. Its position arguments (`charAt(pos)`, `slice(start, end)`, …) were
// lowered as an f64 hint and truncated with `i32.trunc_sat_f64_s`, which is
// only right for a value that is already a number: `charAt(undefined)` handed
// it the dynamic carrier (a verifier failure), `slice("e")` a string (invalid
// Wasm). ES5 `S15.5.4.4_A1_T7`, `S15.5.4.13_A1_T7` and `S15.5.4.15_A1_T7`,
// passes on main, failed to compile; `slice(1, void 0)` compiled and answered
// "" on gc and standalone alike. The selector now requires a numeric proof for
// every position argument, so these units stay legacy, which owns
// ToIntegerOrInfinity and the "an undefined end is the length" rule.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

async function compileHarnessBody(body: string) {
  const source = `/*---\ndescription: String position arguments\n---*/\n${body}`;
  return compile(assembleOriginalHarness(source, parseMeta(source) as never).primary.source, {
    fileName: "test.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    trackIrOutcomes: true,
    deferTopLevelInit: true,
  });
}

function moduleInit(result: Awaited<ReturnType<typeof compileHarnessBody>>) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.unitKind === "module-init");
}

async function runModuleInit(result: Awaited<ReturnType<typeof compileHarnessBody>>): Promise<void> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as () => void)();
}

describe("#7106 — String position arguments without a numeric proof stay legacy", () => {
  const shapes: Record<string, string> = {
    "charAt(undefined)": `assert.sameValue(String("lego").charAt(undefined), "l");`,
    'slice("e", undefined)': `assert.sameValue(String(void 0).slice("e", undefined), "undefined");`,
    'substring("e", undefined)': `assert.sameValue(String(void 0).substring("e", undefined), "undefined");`,
  };

  for (const [name, body] of Object.entries(shapes)) {
    it(`refuses <module-init> at selection and runs ${name} (standalone)`, async () => {
      const result = await compileHarnessBody(body);
      expect(moduleInit(result)).toMatchObject({
        kind: "unsupported",
        stage: "select",
        code: "string-method-unsupported",
      });
      await runModuleInit(result);
    }, 60_000);
  }

  // No backend plans these under native strings, so the selector's surface
  // omits them: refused at selection, never a claim that demotes post-build.
  for (const [name, body] of Object.entries({
    'endsWith("c")': `assert.sameValue("abc".endsWith("c"), true);`,
    'includes("b", 1)': `assert.sameValue("abc".includes("b", 1), true);`,
  })) {
    it(`refuses an unplanned String method ${name} at selection (standalone)`, async () => {
      const result = await compileHarnessBody(body);
      expect(moduleInit(result)).toMatchObject({ stage: "select", code: "string-method-unsupported" });
      await runModuleInit(result);
    }, 60_000);
  }

  it("keeps a numerically proven position on the IR (standalone)", async () => {
    const result = await compileHarnessBody(`assert.sameValue(String("lego").slice(1, 3), "eg");`);
    expect(moduleInit(result)?.irBodyEmitted).toBe(true);
    await runModuleInit(result);
  }, 60_000);

  for (const target of ["gc", "standalone"] as const) {
    const options = {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
      ...(target === "standalone" ? { target: "standalone" as const } : {}),
    };

    it(`leaves a function body with an undefined position to legacy (${target})`, async () => {
      const source = `export function run() { return String("lego").charAt(undefined) === "l" ? 1 : 0; }`;
      const ir = await compile(source, options);
      const legacy = await compile(source, { ...options, experimentalIR: false });
      expect(ir.success, ir.errors.map((error) => error.message).join("\n")).toBe(true);
      expect((ir.irOutcomes ?? []).find((outcome) => outcome.displayName === "run")?.irBodyEmitted).toBe(false);
      expect(Buffer.from(ir.binary).equals(Buffer.from(legacy.binary))).toBe(true);
    }, 60_000);

    // The IR lowered `void 0` to NaN and truncated it to 0, so `slice(1, void 0)`
    // answered "" and `substring(1, void 0)` "l", silently, instead of "ego".
    it(`answers an explicit void 0 end as the length (${target})`, async () => {
      const result = await compile(
        `export function run() {
          return String("lego").slice(1, void 0).length * 10 + String("lego").substring(1, void 0).length;
        }`,
        options,
      );
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
      (result.importObject as { __setInstance?: (i: WebAssembly.Instance) => void })?.__setInstance?.(instance);
      expect((instance.exports.run as () => number)()).toBe(33);
    }, 60_000);
  }
});
