// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7465 — an array HOF callback's `arguments` extras (the slots past its formals) are boxed through `__box_number`.
// When the callback was declared after its call site, nothing had registered that helper yet, so the index and a
// numeric element were pushed as null and read back as "null". Each row is diffed against native JS on the gc,
// standalone and wasi lanes; the callback is declared after `test` unless the row says otherwise.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;

async function expectSameOnAllLanes(source: string): Promise<void> {
  const expected = evaluateAsJs(source).test!();
  for (const { lane, options } of LANES) {
    const result = await compile(source, { fileName: "probe.ts", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

const test = (call: string) => `export function test(): number { ${call} }\n`;
const STRINGS = `const a: string[] = ["p", "q"];`;
const NUMBERS = `const a: number[] = [7, 8];`;

const ROWS: [string, string][] = [
  [
    "index, String(arguments[1]).length",
    test(`${STRINGS} return a.map(show)[1];`) +
      `function show(x: string): number { return String(arguments[1]).length; }`,
  ],
  [
    "index, arguments[1] === 1",
    test(`${STRINGS} return a.map(show)[1];`) +
      `function show(x: string): number { return arguments[1] === 1 ? 1 : 0; }`,
  ],
  [
    "number element, zero formals, String(arguments[0]).length",
    test(`${NUMBERS} return a.map(show)[0];`) + `function show(): number { return String(arguments[0]).length; }`,
  ],
  [
    "number element, zero formals, arguments[0] === 8",
    test(`${NUMBERS} return a.map(show)[1];`) + `function show(): number { return arguments[0] === 8 ? 1 : 0; }`,
  ],
  [
    "forEach: index sum through arguments[1]",
    test(`${STRINGS} total = 0; a.forEach(add); return total;`) +
      `let total = 0;\nfunction add(x: string): void { total += (arguments[1] as number) + 1; }`,
  ],
  [
    "filter: number element and index, zero formals",
    test(`${NUMBERS} return a.filter(keep).length;`) +
      `function keep(): boolean { return arguments[0] === 8 && arguments[1] === 1; }`,
  ],
  [
    "control: callback declared before the call site",
    `function show(x: string): number { return String(arguments[1]).length; }\n` +
      test(`${STRINGS} return a.map(show)[1];`),
  ],
];

describe("#7465 array HOF callback `arguments` extras box their numbers", () => {
  it.each(ROWS)(
    "%s",
    async (_name, source) => {
      await expectSameOnAllLanes(source);
    },
    60_000,
  );
});
