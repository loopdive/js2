// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6463 — the Test262 strict rerun is elided for strict-neutral bodies. The
// rerun is a second full compile of the harness assembly, so every construct
// whose semantics differ between sloppy and strict mode MUST keep it, and the
// upstream flag gating must be untouched.
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleLinkedHarness,
  assembleNativeHarness,
  assembleOriginalHarness,
  findStrictSensitiveConstruct,
} from "./test262-original-harness.js";

const NEUTRAL = `var a = [1, 2, 3];\nfunction sum(xs) { var t = 0; for (var i = 0; i < xs.length; i++) t += xs[i]; return t; }\nassert.sameValue(sum(a), 6);\n`;

describe("#6463 strict-rerun elision", () => {
  const savedEnv = process.env.TEST262_STRICT_RERUN;
  afterEach(() => {
    // Assigning `undefined` would store the string "undefined"; "" is not "always".
    process.env.TEST262_STRICT_RERUN = savedEnv ?? "";
  });

  it("skips the rerun for a strict-neutral body, in all three assemblers", () => {
    for (const assemble of [assembleOriginalHarness, assembleNativeHarness, assembleLinkedHarness]) {
      const a = assemble(NEUTRAL, { flags: [], includes: [] });
      expect(a.strictRerun).toBeUndefined();
      expect(a.strictRerunSkipped).toBe("strict-neutral");
      expect(a.primary.strict).toBe(false);
    }
  });

  it("keeps the rerun for every strict-sensitive construct", () => {
    const cases: Array<[string, string]> = [
      ["function f() { return this; }", "this"],
      ["with (Math) { var x = PI; }", "with"],
      ["var o = {}; delete o.p;", "delete"],
      ["function f() { return arguments.length; }", "identifier:arguments"],
      ["var r = eval('1');", "identifier:eval"],
      ["var implements = 1;", "identifier:implements"],
      ["function f() { return f.caller; }", "property:caller"],
      ["var n = 010;", "legacy-octal-number"],
      ["var n = 08;", "legacy-octal-number"],
      ['var s = "\\1";', "octal-escape"],
      ["if (true) { function g() {} }", "block-function-declaration"],
      ["undeclaredGlobal = 1;", "undeclared-assignment:undeclaredGlobal"],
      ["undeclaredCounter++;", "undeclared-update:undeclaredCounter"],
      ["var x = ;", "parse-diagnostics"],
    ];
    for (const [body, reason] of cases) {
      expect(findStrictSensitiveConstruct(body, ""), body).toMatch(new RegExp(`^(${reason}|parse-diagnostics)$`));
      const a = assembleOriginalHarness(body, { flags: [], includes: [] });
      expect(a.strictRerun, body).toBeDefined();
      expect(a.strictRerun?.strict).toBe(true);
      expect(a.strictRerunSkipped).toBeUndefined();
    }
  });

  it("does not count harness-declared or body-declared names as undeclared", () => {
    expect(findStrictSensitiveConstruct("assert = 1;", "var assert;")).toBeNull();
    expect(findStrictSensitiveConstruct("var y; y = 2; y++;", "")).toBeNull();
    expect(findStrictSensitiveConstruct("try {} catch (e) { e = 1; }", "")).toBeNull();
    expect(findStrictSensitiveConstruct("function f(p) { p = 1; }", "")).toBeNull();
  });

  it("keeps the rerun for negative tests", () => {
    const a = assembleOriginalHarness(NEUTRAL, {
      flags: [],
      includes: [],
      negative: { phase: "runtime", type: "Test262Error" },
    });
    expect(a.strictRerun).toBeDefined();
  });

  it("TEST262_STRICT_RERUN=always restores the unconditional rerun", () => {
    process.env.TEST262_STRICT_RERUN = "always";
    const a = assembleOriginalHarness(NEUTRAL, { flags: [], includes: [] });
    expect(a.strictRerun).toBeDefined();
    expect(a.strictRerunSkipped).toBeUndefined();
  });

  it("leaves the upstream flag gating untouched", () => {
    for (const flag of ["onlyStrict", "noStrict", "raw", "module"]) {
      const a = assembleOriginalHarness("function f() { return this; }", { flags: [flag], includes: [] });
      expect(a.strictRerun, flag).toBeUndefined();
      expect(a.strictRerunSkipped, flag).toBeUndefined();
    }
    expect(assembleOriginalHarness(NEUTRAL, { flags: ["onlyStrict"], includes: [] }).primary.strict).toBe(true);
  });
});
