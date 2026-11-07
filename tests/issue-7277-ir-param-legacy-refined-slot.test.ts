// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7277 — an implicit-any parameter whose legacy slot was refined from real
// call sites to a kind the IR names (`f64`, or the non-null native string)
// projects that kind instead of being refused: the ABI is the same by
// construction. A never-called function keeps legacy's default slot and stays
// refused, as before (the #1580 benchmark's exported `run(n)`).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./equivalence/helpers.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { originalHarnessCompileOptions, parseMeta, runTest262File } from "./test262-runner.js";

/** Calls both decimalToHexString.js helpers with numbers only: legacy refines `n` to f64. */
const DECIMAL_TO_HEX = join(__dirname, "..", "test262", "test", "harness", "decimalToHexString.js");

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "gc", options: {} },
];

const SOURCE = `
function label(msg) { return "[" + msg + "]" + msg.length; }
function scale(n) { if (n > 10) return n / 4; return n * 3 + 1; }
function inner() { return label("ab") + label("") + "|" + scale(2) + "|" + scale(40) + "|" + scale(-0.5); }
export function test() { var s = inner(); var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h + s.length * 1000003; }
`;

const NEVER_CALLED = `
export function run(n) { let s = ""; for (let i = 0; i < n; i++) { s += "a"; } return s.length; }
`;

async function compileJs(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7277.js", trackIrOutcomes: true, ...options });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

describe("#7277 adopt legacy's call-site-refined parameter slot", () => {
  it("IR-emits the decimalToHexString.js helpers and passes their harness test [standalone]", async () => {
    const source = readFileSync(DECIMAL_TO_HEX, "utf8");
    const meta = parseMeta(source);
    const result = await compile(assembleOriginalHarness(source, meta).primary.source, {
      ...originalHarnessCompileOptions(meta, "standalone"),
      fileName: DECIMAL_TO_HEX,
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    for (const unit of ["decimalToHexString", "decimalToPercentHexString"]) {
      expect(result.irOutcomes?.find((o) => o.displayName === unit)?.kind, unit).toBe("emitted");
    }
    expect(await runTest262File(DECIMAL_TO_HEX, "harness", undefined, "standalone")).toMatchObject({ status: "pass" });
  });

  for (const lane of LANES) {
    it(`keeps call-site-refined string / f64 callees equal to JS [${lane.name}]`, async () => {
      const result = await compileJs(SOURCE, lane.options);
      const instance =
        lane.options.target === "standalone"
          ? (await WebAssembly.instantiate(result.binary, {})).instance
          : await instantiateWithRuntime(result);
      const exports = instance.exports as Record<string, () => unknown>;
      exports.__module_init?.();
      expect(exports.test!()).toBe(evaluateAsJs(SOURCE).test!());
    });

    it(`keeps a never-called function's default slot refused [${lane.name}]`, async () => {
      const result = await compileJs(NEVER_CALLED, lane.options);
      const outcome = result.irOutcomes?.find((o) => o.displayName === "run");
      expect(outcome?.kind).toBe("unsupported");
      expect(outcome?.kind === "unsupported" ? outcome.detail : "").toContain("param-type-not-resolvable");
    });
  }
});
