/**
 * #3549 (#2860) — length-scaled regex step budget.
 *
 * The flat 1M step cap killed legitimate LINEAR matches over long subjects:
 * `^\p{L}+$`(u) costs a measured ~5 steps/unit (the surrogate-alternation
 * program executes CLASS+SPLIT per unit), so the cap tripped at ~200k units —
 * and the `RegExp/property-escapes` conformance tests match complement
 * strings of ~1.1M units (304/311 failed exactly there; 290 pass after this
 * fix). budget = CAP + 50·min(len, 20M) preserves the runaway-backtracking
 * guard: catastrophic patterns are super-linear, so on any subject long
 * enough to raise the budget they still exceed it.
 */
import { describe, expect, it } from "vitest";
import {
  REGEX_STEP_CAP,
  REGEX_STEP_CAP_LEN_SATURATION,
  REGEX_STEP_CAP_PER_UNIT,
  regexStepBudget,
  search,
} from "../src/codegen/regex/vm.js";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { RE_FLAG_U } from "../src/codegen/regex/bytecode.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#3549 regexStepBudget (lockstep constants — peer-review pin)", () => {
  it("is the base cap for a zero-length subject", () => {
    expect(regexStepBudget(0)).toBe(REGEX_STEP_CAP);
  });

  it("scales linearly below saturation", () => {
    expect(regexStepBudget(1_000)).toBe(REGEX_STEP_CAP + 1_000 * REGEX_STEP_CAP_PER_UNIT);
  });

  it("saturates at the i32-safe length so the Wasm budget cannot overflow", () => {
    const atSat = regexStepBudget(REGEX_STEP_CAP_LEN_SATURATION);
    expect(regexStepBudget(REGEX_STEP_CAP_LEN_SATURATION * 10)).toBe(atSat);
    expect(atSat).toBeLessThan(2 ** 31 - 1);
  });
});

describe("#3549 JS mirror VM — long linear matches fit, runaway still trips", () => {
  it("^\\p{L}+$ matches a 400k-unit subject (formerly step-limit exceeded at ~200k)", () => {
    const compiled = compilePattern("^\\p{L}+$", RE_FLAG_U);
    const m = search(compiled.prog, compiled.classTable, compiled.nGroups, "a".repeat(400_000), 0, true, 0);
    expect(m).not.toBeNull();
  });

  it("catastrophic backtracking still throws the RangeError guard", () => {
    // (a+)+b over a long 'a' run with no 'b' — exponential backtracking. The
    // subject is small, so the budget stays near the base cap.
    const compiled = compilePattern("(a+)+b", 0);
    expect(() =>
      search(compiled.prog, compiled.classTable, compiled.nGroups, "a".repeat(64), 0, true, compiled.nScratch ?? 0),
    ).toThrow(/step limit exceeded/);
  });
});

describe("#3549 standalone Wasm VM — long-subject property-escape match", () => {
  it("matches ^\\p{L}+$ over a 256k-unit subject in-module (formerly RangeError)", async () => {
    const source = `
var chunk = "abcdefghijklmnop";
var s = chunk;
for (var i = 0; i < 14; i++) s += s;
var re = RegExp("^\\\\p{L}+$", "u");
if (s.length !== 262144) throw new Error("bad length " + s.length);
if (!re.test(s)) throw new Error("expected match");
`;
    const result = await compile(source, {
      allowJs: true,
      fileName: "test.js",
      skipSemanticDiagnostics: true,
      target: "standalone",
      deferTopLevelInit: true,
    });
    expect(result.success).toBe(true);
    expect(result.imports).toHaveLength(0);
    const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
    const { instance } = await WebAssembly.instantiate(result.binary, importObj as WebAssembly.Imports);
    const init = (instance.exports as Record<string, unknown>).__module_init;
    expect(typeof init).toBe("function");
    (init as () => void)(); // throws if the step budget still trips
  });
});
