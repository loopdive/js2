// #7012 — the Temporal string/field helpers of the #661 lowering live in the
// module on every native-string build (native-first, standalone, WASI).
//
// Before: `Temporal.PlainDate.prototype.toString`, `.monthCode`,
// `PlainDate/PlainTime/Duration.from(string)`, `add`/`subtract` and
// `Duration#sign` called ten `env::__temporal_*` host functions — an
// uninstantiable standalone binary, a native-first compile error ("unknown,
// owner #4401") and, on WASI, a silent "" / 0 result. Each case below is
// evaluated twice: by Node against the PINNED @js-temporal/polyfill (the
// expected value) and by the compiled module, which must agree.

import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";
import { readUmdSource, setupTemporalPolyfill } from "./dogfood/setup-temporal-polyfill.mjs";

type Case = { expr: string; throws?: "RangeError" | "TypeError" };

/** One case per behaviour the ten helpers own (formatting, parsing, carry, sign). */
const CASES: Case[] = [
  // __temporal_plain_date_to_string
  {
    expr: `new Temporal.PlainDate(2000, 5, 2).toString({ calendarName: undefined })`,
  },
  { expr: `new Temporal.PlainDate(-1, 1, 9).toString()` },
  { expr: `new Temporal.PlainDate(12345, 12, 31).toJSON()` },
  // __temporal_plain_date_month_code
  { expr: `new Temporal.PlainDate(2024, 3, 7).monthCode` },
  // __temporal_plain_time_to_string
  { expr: `new Temporal.PlainTime(12, 34, 56, 123, 987, 500).toString()` },
  { expr: `new Temporal.PlainTime(7, 5).toString()` },
  // __temporal_duration_to_string (balance-subseconds.js and friends)
  {
    expr: `new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, 999, 999999, 999999999).toJSON()`,
  },
  {
    expr: `new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, -999, -999999, -999999999).toJSON()`,
  },
  { expr: `new Temporal.Duration().toString()` },
  { expr: `new Temporal.Duration(1, 2, 3, 4, 5, 6, 7, 8, 9, 10).toString()` },
  { expr: `new Temporal.Duration(1).toString()` },
  { expr: `new Temporal.Duration(0, 0, 0, 0, 0, 0, 0, 1).toString()` },
  // __temporal_duration_sign
  { expr: `new Temporal.Duration(0, 0, 0, -1).sign` },
  { expr: `new Temporal.Duration(0, 0, 0, 0, 3).sign` },
  // __temporal_plain_date_from_string_field
  { expr: `Temporal.PlainDate.from("2020-02-29").day` },
  { expr: `Temporal.PlainDate.from("20200229T12:00[u-ca=iso8601]").month` },
  { expr: `Temporal.PlainDate.from("+002020-02-29").year` },
  {
    expr: `Temporal.PlainDate.from("2020-03-04T10:00+01:00[Europe/Berlin][u-ca=ISO8601]").day`,
  },
  { expr: `Temporal.PlainDate.from("2021-02-29")`, throws: "RangeError" },
  {
    expr: `Temporal.PlainDate.from("2020-01-01T00:00Z")`,
    throws: "RangeError",
  },
  {
    expr: `Temporal.PlainDate.from("2020-01-01[u-ca=gregory][!u-ca=iso8601]")`,
    throws: "RangeError",
  },
  {
    expr: `Temporal.PlainDate.from("2020-01-01[!foo=bar]")`,
    throws: "RangeError",
  },
  {
    expr: `Temporal.PlainDate.from("2020-01-01[u-ca=klingon]")`,
    throws: "RangeError",
  },
  { expr: `Temporal.PlainDate.from("-000000-01-01")`, throws: "RangeError" },
  { expr: `Temporal.PlainDate.from(19761118)`, throws: "TypeError" },
  // __temporal_plain_time_from_string_field
  { expr: `Temporal.PlainTime.from("T10:20:30.123456789").nanosecond` },
  { expr: `Temporal.PlainTime.from("2020-01-01T23:59:60").second` },
  { expr: `Temporal.PlainTime.from("T1020").minute` },
  { expr: `Temporal.PlainTime.from("12-14")`, throws: "RangeError" },
  {
    expr: `Temporal.PlainTime.from("2020-01-01T10:00Z")`,
    throws: "RangeError",
  },
  // __temporal_duration_from_string_field
  { expr: `Temporal.Duration.from("PT1.03125H").minutes` },
  { expr: `Temporal.Duration.from("PT1.03125H").milliseconds` },
  { expr: `Temporal.Duration.from("-PT3,025M").seconds` },
  { expr: `Temporal.Duration.from("-PT3,025M").years` },
  { expr: `Temporal.Duration.from("PT46H66M71.50040904S").nanoseconds` },
  {
    expr: `Temporal.Duration.from("P11Y22M33W44DT55H66M77.987654321S").microseconds`,
  },
  { expr: `Temporal.Duration.from("PT1.5H30M")`, throws: "RangeError" },
  { expr: `Temporal.Duration.from("P")`, throws: "RangeError" },
  {
    expr: `Temporal.Duration.from("PT9007199254740992S")`,
    throws: "RangeError",
  },
  // __temporal_plain_date_add_field
  {
    expr: `Temporal.PlainDate.from("2020-01-31").add({ months: 1 }).toString()`,
  },
  {
    expr: `new Temporal.PlainDate(2020, 3, 31).subtract({ months: 1, days: 1 }).toString()`,
  },
  { expr: `new Temporal.PlainDate(1999, 12, 25).add({ weeks: 2 }).toString()` },
  // __temporal_plain_time_add_field
  {
    expr: `new Temporal.PlainTime(23, 59, 59, 999, 999, 999).add({ nanoseconds: 2 }).toString()`,
  },
  { expr: `new Temporal.PlainTime(0, 0).subtract({ hours: 25 }).toString()` },
];

const TEMPORAL_IMPORT = /__temporal_/;

/**
 * The pinned polyfill's `Temporal`, evaluated by Node. The UMD bundle is run
 * with an explicit CommonJS `module` so its factory takes the `exports` arm in
 * any loader (vitest's module runner does not hand it one through `require`).
 */
function polyfillTemporal(): unknown {
  const commonjs = { exports: {} as { Temporal?: unknown } };
  new Function("module", "exports", readUmdSource(setupTemporalPolyfill()))(commonjs, commonjs.exports);
  return commonjs.exports.Temporal;
}

/** Node's verdict for one case: the value, or the thrown error's constructor name. */
function expected(Temporal: unknown, c: Case): { value?: unknown; threw?: string } {
  try {
    return { value: new Function("Temporal", `return (${c.expr});`)(Temporal) };
  } catch (error) {
    return { threw: (error as Error).constructor.name };
  }
}

/**
 * A program whose `check()` returns 0 when every case matches the expected
 * verdict, otherwise `index + 1` (value mismatch / missing throw) or
 * `1000 + index` (wrong error type).
 */
function checkProgram(verdicts: { value?: unknown; threw?: string }[]): string {
  const lines = ["declare const Temporal: any;", "export function check(): number {"];
  CASES.forEach((c, k) => {
    const verdict = verdicts[k]!;
    if (verdict.threw !== undefined) {
      lines.push(
        `  try { ${c.expr}; return ${k + 1}; } catch (e) { if (!(e instanceof ${verdict.threw})) return ${1000 + k}; }`,
      );
    } else if (typeof verdict.value === "string") {
      lines.push(`  { const r: string = ${c.expr}; if (r !== ${JSON.stringify(verdict.value)}) return ${k + 1}; }`);
    } else if (typeof verdict.value === "number") {
      const v = verdict.value;
      const zeroSign = v === 0 ? ` || 1 / r !== ${Object.is(v, -0) ? "-Infinity" : "Infinity"}` : "";
      lines.push(`  { const r: number = ${c.expr}; if (r !== ${v}${zeroSign}) return ${k + 1}; }`);
    } else {
      throw new Error(`unsupported expected value for ${c.expr}: ${String(verdict.value)}`);
    }
  });
  lines.push("  return 0;", "}");
  return lines.join("\n");
}

async function runCheck(source: string, options: CompileOptions): Promise<{ result: number; imports: string[] }> {
  const compiled = await compile(source, {
    fileName: "issue-7012.ts",
    ...options,
  });
  if (!compiled.success) throw new Error(`compile failed: ${compiled.errors.map((e) => e.message).join("; ")}`);
  expect(WebAssembly.validate(compiled.binary)).toBe(true);
  const module = new WebAssembly.Module(compiled.binary);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  let instance: WebAssembly.Instance;
  if (options.target === "wasi") {
    const wasi = buildWasiPolyfill();
    instance = await WebAssembly.instantiate(module, {
      wasi_snapshot_preview1: wasi,
    });
    if (instance.exports.memory) wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
  } else {
    instance = await instantiateWithRuntime(compiled);
  }
  return { result: (instance.exports.check as () => number)(), imports };
}

describe("#7012 Temporal string/field helpers are in-module on native-string builds", () => {
  const Temporal = polyfillTemporal();
  const verdicts = CASES.map((c) => expected(Temporal, c));
  const source = checkProgram(verdicts);

  it("the polyfill verdicts are the ones the cases were written for", () => {
    CASES.forEach((c, k) => expect(verdicts[k]!.threw, c.expr).toBe(c.throws));
  });

  for (const [label, options] of [
    // #6708: the default gc build IS the native-first regime.
    ["default gc", {}],
    ["native-first", { semanticProviders: "native-first" }],
    ["standalone", { target: "standalone" }],
    ["wasi", { target: "wasi" }],
  ] as const) {
    it(`${label}: zero __temporal_* imports and every case JS-equal to the pinned polyfill`, async () => {
      const { result, imports } = await runCheck(source, options as CompileOptions);
      expect(imports.filter((name) => TEMPORAL_IMPORT.test(name))).toEqual([]);
      const failed = result === 0 ? "none" : CASES[result >= 1000 ? result - 1000 : result - 1]!.expr;
      expect(failed).toBe("none");
    });
  }

  it("a compiled Temporal binding (the linked provider's prelude shape) takes no #661 helper at all", async () => {
    const compiled = await compile(
      `const Temporal: any = { PlainDate: { from(s: string) { return s; } } };\nexport function f(): number { return Temporal.PlainDate.from("2020-01-01").length; }`,
      { fileName: "issue-7012-bound.ts", target: "standalone" },
    );
    expect(compiled.success).toBe(true);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(compiled.binary)).map((i) => i.name);
    expect(imports.filter((name) => TEMPORAL_IMPORT.test(name))).toEqual([]);
  });
});
