// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7147 — native-first `[1, [2]].join(",")` stringified the nested array
// element as "[object Object]" instead of through Array.prototype.toString (a
// recursive join with ",", "" for an array already being joined — the cycle
// guard). Each row is diffed against native JS on the gc (native-first),
// standalone and wasi lanes. #7153 — wasi printed "[object Object]" for every
// nested element: its `__to_primitive` vec arm never reserved the driver.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

// Standalone returns a native string struct, so every row returns a numeric
// digest of the string and both lanes compare numbers.
const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

// Rows the wasi lane cannot run here: `flat()` is a wasi compile error (#2717),
// and a module that can throw imports WASI, which this harness does not provide.
const NOT_ON_WASI = new Set([
  "flat().join",
  "throwing element leaves no stale cycle frame",
  `exception from JSON.parse("{") inside a nested join`,
  `exception from decodeURIComponent("%") inside a nested join`,
]);

async function expectSameOnAllLanes(name: string, body: string): Promise<void> {
  const src = `${ENC}function value(): string { ${body} }\nexport function test(): number { return enc(value()); }`;
  const expected = evaluateAsJs(src).test!();
  const targets = NOT_ON_WASI.has(name)
    ? ([undefined, "standalone"] as const)
    : ([undefined, "standalone", "wasi"] as const);
  for (const target of targets) {
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
    [
      "cyclic array",
      `const a: any[] = []; a.push(1); a.push(2); a.push(a); return a.join() + "|" + String(a) + "|" + [a, a].join(";");`,
    ],
    // (#7154) The same cycle built on a literal-initialised `any[]`.
    [
      "cyclic array on a literal",
      `const a: any[] = [1, 2]; a.push(a); return a.join() + "|" + String(a) + "|" + [a, a].join(";");`,
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
    // Review probe4: the element `toString` fails through a builtin's own
    // exception, the caller catches it, and later joins must not see a stale frame.
    ...[`JSON.parse("{")`, `decodeURIComponent("%")`].map((thrower): [string, string] => [
      `exception from ${thrower} inside a nested join`,
      `let n = 0; const t = { toString(): string { if (n++ === 0) return ${thrower}; return "t"; } }; ` +
        `const a: any[] = []; a.push(t); const c: any[] = []; c.push(9); c.push([8]); let s = ""; ` +
        `try { s = [a, c].join("+"); } catch (e) { s = "T"; } return s + "|" + [a, c].join("+") + "|" + c.join() + "|" + a.join();`,
    ]),
    [
      "dynamic (any) receiver self-cycle",
      `function f(x: any): string { return x.join(); } const a: any[] = []; a.push(1); a.push(a); return f(a) + "|" + f([a, 2]);`,
    ],
    [
      "generator-body join (seeded Array.prototype.join) self-cycle",
      `function* g(a: any[]): Generator<string> { yield a.join(); } const a: any[] = []; a.push(1); a.push(2); a.push(a); return g(a).next().value;`,
    ],
    ["mixed nested", `return [1, "a", [true, null, undefined, [2]]].join();`],
    ["custom separator over nested arrays", `return [1, [2, [3, 4]], 5].join(" - ");`],
    [
      "nested arrays holding objects / null / undefined",
      `return [[{}, null], [undefined, [{}]], {}].join("/") + "|" + String([null, [undefined]]);`,
    ],
    [
      "cycle one level down, template and custom separator",
      'const a: any[] = []; a.push(1); a.push([2, a]); return `${a}` + "|" + a.join(" ; ");',
    ],
    ["string sub-arrays", `return [["a", "b"], ["c"]].join(";");`],
    ["JSON.stringify unaffected", `return JSON.stringify([1, [2, ["x"]]]);`],
  ];
  for (const [name, body] of rows) it(name, () => expectSameOnAllLanes(name, body));
});
