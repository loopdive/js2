// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7147 — native-first `[1, [2]].join(",")` stringified the nested array
// element as "[object Object]" instead of through Array.prototype.toString (a
// recursive join with ",", "" for an array already being joined — the cycle
// guard). Each row is diffed against native JS on the gc (native-first) and
// standalone lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

// Standalone returns a native string struct, so every row returns a numeric
// digest of the string and both lanes compare numbers.
const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

async function expectSameOnBothLanes(body: string): Promise<void> {
  const src = `${ENC}function value(): string { ${body} }\nexport function test(): number { return enc(value()); }`;
  const expected = evaluateAsJs(src).test!();
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

describe("#7147 native join stringifies nested arrays via Array.prototype.toString", () => {
  const rows: [string, string][] = [
    ["nested join", `return [1, [2, [3]]].join(",");`],
    ["String(array)", `return String([1, [2]]);`],
    ["template literal", "return `${[1, [2]]}`;"],
    ['+ ""', `return [1, [2]] + "";`],
    ["[].toString() and [[]].join()", `return [].toString() + "|" + [[]].join() + "|";`],
    ["flat().join", `return [1, [2, [3, [4]]]].flat().join(",");`],
    // Arrays are filled by `push`: a literal-initialised `any[]` that later
    // receives an array drops its earlier elements, a separate gap.
    [
      "cyclic array",
      `const a: any[] = []; a.push(1); a.push(2); a.push(a); return a.join() + "|" + String(a) + "|" + [a, a].join(";");`,
    ],
    [
      "mutual cycle",
      "const a: any[] = []; const b: any[] = []; a.push(1); b.push(a); b.push(2); a.push(b); " +
        'return a.join("-") + "|" + String(b) + "|" + `${a}`;',
    ],
    [
      "throwing element leaves no stale cycle frame",
      `let n = 0; const o = { toString() { if (n++ === 0) throw 1; return "o"; } }; const a: any[] = []; a.push(o); ` +
        `let s = ""; try { s = [a].join(); } catch (e) { s = "T"; } return s + "|" + [a].join() + "|" + String(a);`,
    ],
    ["mixed nested", `return [1, "a", [true, null, undefined, [2]]].join();`],
    ["string sub-arrays", `return [["a", "b"], ["c"]].join(";");`],
    ["JSON.stringify unaffected", `return JSON.stringify([1, [2, ["x"]]]);`],
  ];
  for (const [name, body] of rows) it(name, () => expectSameOnBothLanes(body));
});
