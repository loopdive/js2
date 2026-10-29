// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7193 — `prepared-dynamic-helper-abi` on standalone. A planned member
// closure inside a prepared `<module-init>` component that applies
// `String(<carrier>)`, a loose `==` / `!=` on the carrier, or `in` on a
// carrier receiver is claimed on standalone (and on the native-first gc lane,
// which projects as standalone): `prepared-dynamic-support.ts` names the exact
// physical helper each host-carrier `makeDynamicLowering` arm calls
// (`__extern_toString`, `__extern_loose_eq`, `__typeof_object` /
// `__typeof_function`), so the component prepares with no withdrawal.
// Every shape agrees with node and with the legacy compiler.

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

// A thrown value is encoded as a number so one `run()` result pins every input.
const ENCODE = `(typeof e === "number" ? e : typeof e === "string" ? e.length * 1000 + e.charCodeAt(e.length - 1) : e instanceof TypeError ? -5 : e === undefined ? -3 : -2)`;

function program(body: string, inputs: readonly string[]): string {
  return `/** @returns {number} */ function subject() { return 0; }
subject.f = function (m, k) { if (k === 9) return; ${body} };
export function run() { var n = 0; ${inputs
    .map((args) => `try { subject.f(${args}); n = n * 31 + 7; } catch (e) { n = (n * 31 + ${ENCODE}) % 1000000007; }`)
    .join(" ")} return n; }`;
}

function node(source: string): number {
  return new Function(`"use strict";\n${source.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

async function run(result: CompileResult): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as () => void)();
  return (instance.exports.run as () => number)();
}

function initRow(result: CompileResult) {
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
  expect(rows).toHaveLength(1);
  expect((result.irPostClaimErrors ?? []).filter((error) => error.func !== "run")).toEqual([]);
  return rows[0]!;
}

const OBJECTS = [
  `{ toString: function () { return "T"; } }, 0`,
  `{ valueOf: function () { return 5; }, toString: function () { return "s"; } }, 0`,
  `{ valueOf: function () { return 2; } }, 0`,
  `{}, 0`,
];
const PRIMITIVES = [`1, 0`, `2, 0`, `"2", 0`, `"ab", 0`, `true, 0`, `null, 0`, `undefined, 0`, `0, 0`];
const ARRAYS = [`[1, 2], 0`, `[2], 0`, `[], 0`];

const CLAIMED: readonly [name: string, body: string, inputs: readonly string[]][] = [
  ["`String(<parameter>)`", `throw "x" + String(m);`, [...PRIMITIVES, ...OBJECTS, ...ARRAYS, `Symbol(), 0`]],
  ["`String(<joined carrier>)`", `var r = m ? m : 1; throw String(r);`, [...PRIMITIVES, ...OBJECTS, ...ARRAYS]],
  [
    "`in` on objects and arrays",
    `if ("a" in m) throw "i"; if (0 in m) throw "z"; throw "no";`,
    [`{ a: 1 }, 0`, `{ b: 1 }, 0`, `[5], 0`, `[], 0`],
  ],
];

// Standalone's `__extern_loose_eq` skips legacy's ToPrimitive step, so these
// stay refused at select there (`prepared-carrier-loose-equality`).
const MIXED = [...PRIMITIVES, ...OBJECTS, ...ARRAYS];
const LOOSE: readonly [name: string, body: string, inputs: readonly string[]][] = [
  ["a loose `==` on the parameter", `if (m == 2) throw "e"; throw "o";`, MIXED],
  ["a loose `!=` on the joined carrier", `var r = m ? m : 1; if (r != "2") throw "e"; throw "same";`, MIXED],
  [
    "a loose `==` between two carriers",
    `if (m == k) throw "e"; throw "ne";`,
    [`1, "1"`, `null, undefined`, `"a", "b"`],
  ],
];

describe("#7193 — standalone prepared dynamic helper ABI", () => {
  it.each(CLAIMED)(
    "claims %s with no post-claim withdrawal, matching node and legacy",
    async (_name, body, inputs) => {
      const source = program(body, inputs);
      const expected = node(source);
      const ir = await compile(source, OPTIONS);
      expect(initRow(ir)).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
      expect(await run(ir)).toBe(expected);
      const legacy = await compile(source, { ...OPTIONS, experimentalIR: false });
      expect(await run(legacy)).toBe(expected);
    },
    90_000,
  );

  it("throws the TypeError of `in` on a primitive receiver, as node does", async () => {
    // Legacy answers `false` here instead of throwing, so only IR is compared.
    const source = program(`if ("a" in m) throw "i"; throw "no";`, [`null, 0`, `1, 0`, `"s", 0`, `undefined, 0`]);
    const result = await compile(source, OPTIONS);
    expect(initRow(result).irBodyEmitted).toBe(true);
    expect(await run(result)).toBe(node(source));
  }, 60_000);

  it("answers the descriptive string for `String(Symbol())`", async () => {
    // §22.1.1.1 step 2a: `String(sym)` is SymbolDescriptiveString, not a TypeError.
    const source = program(`throw String(m);`, [`Symbol("q"), 0`, `Symbol(), 0`]);
    // "Symbol(q)" encodes as 9041, "Symbol()" as 8041.
    expect(node(source)).toBe(9041 * 31 + 8041);
    const result = await compile(source, OPTIONS);
    expect(initRow(result).irBodyEmitted).toBe(true);
    expect(await run(result)).toBe(node(source));
  }, 60_000);

  it.each(LOOSE)(
    "keeps %s refused at select on standalone",
    async (_name, body, inputs) => {
      const source = program(body, inputs);
      const result = await compile(source, OPTIONS);
      expect(initRow(result)).toMatchObject({
        irBodyEmitted: false,
        stage: "select",
        code: "operand-coercion-unsupported",
      });
      expect(await run(result)).toBe(node(source));
    },
    60_000,
  );

  it("claims `String(<carrier>)` on the native-first gc lane too", async () => {
    for (const [, body, inputs] of CLAIMED.slice(0, 2)) {
      const result = await compile(program(body, inputs), { ...OPTIONS, target: "gc" });
      expect(initRow(result)).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
    }
  }, 90_000);
});
