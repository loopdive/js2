// #6992 — closure-capture write detection only recognised `x = …`, compound
// assignment and `++/--`. A write through a destructuring target, a
// `for (x of …)` / `for (x in …)` head or a `var` re-declaration left the
// capture by-value, so the closure read a stale snapshot. The shared
// `isLexicalBindingWrite` contract (src/shared/binding-writes.ts) now
// drives every scan, and the destructuring / for-of / for-in lowerings store
// through the capture's ref cell.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

async function expectSameOnBothLanes(src: string): Promise<void> {
  const expected = evaluateAsJs(src).test!();
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

const cases: [string, string][] = [
  ["var re-declaration", `var v = 1; const f = () => v; var v = 2; return f();`],
  ["array destructuring", `let a = 1; const f = () => a; [a] = [2]; return f();`],
  ["object destructuring (shorthand)", `let a = 1; const f = () => a; ({ a } = { a: 2 }); return f();`],
  ["destructuring swap", `let a = 1, b = 2; const f = () => a * 10 + b; [a, b] = [b, a]; return f();`],
  ["for-of head", `let a = 1; const f = () => a; for (a of [5]) {} return f();`],
  [
    "for-in head",
    `let k: any = 0; const f = () => k; for (k in { zz: 1 }) {} return String(f()).length * 10 + (f() === "zz" ? 1 : 0);`,
  ],
  [
    "object destructuring with rename and default",
    `let a = 1, c = 0; const f = () => a + c; ({ x: a, y: c = 7 } = { x: 3 } as any); return f();`,
  ],
  ["nested array destructuring", `let a = 1; const f = () => a; [[a]] = [[4]]; return f();`],
  ["array rest target", `let r: number[] = []; const f = () => r.length; [, ...r] = [1, 2, 3]; return f();`],
  [
    "parameter re-declared by var",
    `const g = (v: number): number => { const f = () => v; var v = 2; return f(); }; return g(1);`,
  ],
  ["destructuring write inside the closure", `let a = 1; const f = () => { [a] = [9]; }; f(); return a;`],
  ["object destructuring inside the closure", `let a = 1; const f = () => { ({ a } = { a: 6 }); }; f(); return a;`],
  ["for-of head inside the closure", `let a = 1; const f = () => { for (a of [7, 8]) {} }; f(); return a;`],
  [
    "for-in head inside the closure",
    `let k: any = 0; const f = () => { for (k in { ab: 1 }) {} }; f(); return String(k).length;`,
  ],
  [
    "for-of over a string",
    `let c = ""; const f = () => c.length + (c === "z" ? 10 : 0); for (c of "xyz") {} return f();`,
  ],
  ["for-of over array keys()", `let k = -1; const f = () => k; for (k of [5, 6, 7].keys()) {} return f();`],
  ["for-of destructuring head", `let a = 1; const f = () => a; for ([a] of [[3], [4]]) {} return f();`],
  [
    "for-of body reads the boxed head",
    `let a = 0; let s = 0; const f = () => a * 2; for (a of [1, 2, 3]) { s += a + f(); } return s * 100 + f();`,
  ],
  [
    "for-in body reads the boxed head",
    `let k: any = ""; let n = 0; const f = () => String(k).length; for (k in { a: 1, bb: 2 }) { n += f(); } return n * 10 + f();`,
  ],
  ["for-in over an array", `let k: any = ""; const f = () => Number(k); for (k in [9, 9, 9]) {} return f();`],
  [
    "var re-declared inside a loop",
    `var x = 0; const f = () => x; for (var i = 0; i < 3; i++) { var x = i * 10; } return f();`,
  ],
  [
    "parameter written by destructuring",
    `const g = (p: number): number => { const f = () => p; [p] = [p + 40]; return f(); }; return g(2);`,
  ],
  ["destructuring before the closure exists", `let a = 1; [a] = [5]; const f = () => a; return f();`],
  // Negative control: an uncaptured destructuring target keeps working unboxed.
  ["uncaptured destructuring target", `let x = 0; let y = 3; const f = () => y; [x] = [1]; return f() + x;`],
];

describe("#6992 closure captures see every outer write form", () => {
  for (const [name, body] of cases) {
    it(name, async () => {
      await expectSameOnBothLanes(`export function test(): number { ${body} }`);
    });
  }
});

// test262 ES5 language/arguments-object/10.6-6-3,4: an outer `var arguments`
// declarator is not a write of a nested function expression's OWN `arguments`
// (its declaration is unknown to the planner); counting it boxed that
// `arguments` and the read hit `illegal cast`. `var arguments` is a strict-mode
// SyntaxError, so the expected values are pinned rather than evaluated as JS.
const argumentsCases: [string, string, number][] = [
  [
    "outer var arguments, inner 0-param function expression",
    `var arguments: any = undefined; return (function () { return arguments.length; })();`,
    0,
  ],
  [
    "outer var arguments, inner 3-param function expression",
    `var arguments: any = undefined; return (function (a?: any, b?: any, c?: any) { return arguments.length; })();`,
    0,
  ],
  [
    "outer var arguments, inner function expression called with extra args",
    `var arguments: any = undefined; return (function (a?: any) { return arguments.length; })(1, 2);`,
    2,
  ],
  // Control: with the captured declaration KNOWN, a later `var` re-declaration
  // is still a write and the function expression's capture stays boxed.
  [
    "function expression sees a later var re-declaration",
    `var v: any = 1; const f = function () { return v; }; var v: any = 5; return f();`,
    5,
  ],
];

describe("#6992 an outer var declarator does not box a function expression's own arguments", () => {
  for (const [name, body, expected] of argumentsCases) {
    it(name, async () => {
      const src = `export function test(): number { ${body} }`;
      for (const target of [undefined, "standalone"] as const) {
        const lane = target ?? "gc";
        const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
        expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
        const instance = await instantiateWithRuntime(result);
        expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
      }
    });
  }
});
