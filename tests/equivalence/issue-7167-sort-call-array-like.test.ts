// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7167 — `Array.prototype.sort.call(arrayLike)` on the no-host lanes. A typed
// object literal (`const o = { length: 3, 0: "c", 2: "a" }`) lowers to a closed
// struct whose index-named properties are physical fields. The generic sort
// body wrote the sorted items back under a boxed-number key, which the
// closed-struct write arms of `__extern_set` do not match, so the items landed
// in the expando bag and typed field reads (`o[0]`) kept the unsorted order.
// Declared index slots are now also written by key string. Each row is diffed
// against native JS.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

// Standalone returns a native string struct, so every row returns a numeric
// digest of its string and all lanes compare numbers.
const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

type Lane = "gc" | "standalone" | "wasi";
const OPTIONS: Record<Lane, object> = { gc: {}, standalone: { target: "standalone" }, wasi: { target: "wasi" } };
const NO_HOST: Lane[] = ["gc", "standalone"];
const ALL: Lane[] = ["gc", "standalone", "wasi"];

async function expectSame(body: string, lanes: Lane[]): Promise<void> {
  const src = `${ENC}export function test(): number { return enc(String((() => { ${body} })())); }`;
  const expected = evaluateAsJs(src).test!();
  for (const lane of lanes) {
    const result = await compile(src, { fileName: "probe.ts", ...OPTIONS[lane] });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

const SORT = "Array.prototype.sort.call";

// [name, body, lanes]. The wasi lane misreads plain array-like objects
// (`({ length: 2 } as any).length` is undefined there, independent of sort),
// so it runs the rows whose receiver it already handles.
const ROWS: [string, string, Lane[]][] = [
  // The closed-struct receiver (the issue).
  [
    "typed literal, no comparator",
    `const o = { length: 3, 0: "c", 1: "b", 2: "a" }; ${SORT}(o); return o[0] + o[1] + o[2];`,
    NO_HOST,
  ],
  [
    "typed literal, comparator",
    `const o = { length: 3, 0: 3, 1: 1, 2: 2 }; ${SORT}(o, (a: any, b: any) => a - b); return "" + o[0] + o[1] + o[2];`,
    NO_HOST,
  ],
  [
    "typed numbers sort as strings",
    `const o = { length: 3, 0: 10, 1: 9, 2: 1 }; ${SORT}(o); return "" + o[0] + o[1] + o[2];`,
    NO_HOST,
  ],
  [
    "typed literal with a named property",
    `const o = { length: 3, 0: "c", 1: "b", 2: "a", x: 1 }; ${SORT}(o); return o[0] + o[1] + o[2] + o.x;`,
    NO_HOST,
  ],
  [
    "two struct shapes",
    `const a = { length: 2, 0: "b", 1: "a" }; const b = { length: 3, 0: 3, 1: 2, 2: 1, k: 0 }; ${SORT}(a); ${SORT}(b); return a[0] + a[1] + b[0] + b[1] + b[2];`,
    NO_HOST,
  ],
  [
    "typed parameter",
    `function s(o: { length: number; 0: string; 1: string }) { ${SORT}(o); return o[0] + o[1]; } return s({ length: 2, 0: "z", 1: "y" });`,
    NO_HOST,
  ],
  [
    "typed and dynamic reads agree",
    `const o = { length: 3, 0: "c", 1: "a", 2: "b" }; ${SORT}(o); const p: any = o; return o[0] + o[1] + o[2] + p[0] + p[1] + p[2];`,
    NO_HOST,
  ],
  [
    "typed holes",
    `const o = { length: 4, 0: 5, 2: 1, 3: 3 }; ${SORT}(o, (a: any, b: any) => a - b); const p: any = o; return "" + p[0] + p[1] + p[2] + (3 in p) + p[3];`,
    NO_HOST,
  ],
  [
    "typed return is the receiver",
    `const o = { length: 2, 0: "b", 1: "a" }; const r: any = ${SORT}(o); return String(r === o) + r[0];`,
    NO_HOST,
  ],
  ["typed length 0", `const o = { length: 0, 0: "b" }; ${SORT}(o); return o[0];`, NO_HOST],
  ["typed length 1", `const o = { length: 1, 0: "b", 1: "a" }; ${SORT}(o); return o[0] + o[1];`, NO_HOST],
  [
    "typed, comparator throws: no write-back",
    `const o = { length: 2, 0: "b", 1: "a" }; try { ${SORT}(o, () => { throw 1; }); } catch (e) {} return o[0] + o[1];`,
    NO_HOST,
  ],
  [
    "sort held in a variable",
    `const sort = Array.prototype.sort; const o = { length: 2, 0: "b", 1: "a" }; sort.call(o); return o[0] + o[1];`,
    NO_HOST,
  ],
  [
    "sort.apply",
    `const o = { length: 2, 0: "b", 1: "a" }; Array.prototype.sort.apply(o, []); return o[0] + o[1];`,
    NO_HOST,
  ],
  // Dynamic (`any`) receivers — already correct, kept as a guard.
  [
    "any literal, the issue program",
    `const o: any = { length: 3, 0: "c", 1: undefined, 2: "a" }; ${SORT}(o); return String(o[0]) + o[1] + o[2];`,
    NO_HOST,
  ],
  [
    "any holes",
    `const o: any = { length: 3, 0: "b", 2: "a" }; ${SORT}(o); return String(o[0]) + o[1] + (2 in o) + o[2];`,
    NO_HOST,
  ],
  [
    "any sparse length",
    `const o: any = { length: 5, 4: "a", 1: "b" }; ${SORT}(o); return "" + o[0] + o[1] + (2 in o) + (4 in o);`,
    NO_HOST,
  ],
  [
    "length as a string",
    `const o: any = { length: "2", 0: "b", 1: "a", 2: "0" }; ${SORT}(o); return String(o[0]) + o[1] + o[2];`,
    NO_HOST,
  ],
  [
    "fractional length",
    `const o: any = { length: 2.7, 0: "b", 1: "a", 2: "0" }; ${SORT}(o); return String(o[0]) + o[1] + o[2];`,
    NO_HOST,
  ],
  [
    "any length 0 returns the receiver",
    `const o: any = { length: 0, 0: "b" }; return String(${SORT}(o) === o) + o[0];`,
    NO_HOST,
  ],
  ["any length 1", `const o: any = { length: 1, 0: "b", 1: "a" }; ${SORT}(o); return String(o[0]) + o[1];`, NO_HOST],
  [
    "any, comparator throws: no write-back",
    `const o: any = { length: 3, 0: "c", 1: "b", 2: "a" }; try { ${SORT}(o, () => { throw new Error("x"); }); } catch (e) { return "T" + o[0] + o[1] + o[2]; } return "no";`,
    NO_HOST,
  ],
  [
    "arguments, no comparator",
    `function f(...x: any[]) { return (function (this: any) { const a = arguments; ${SORT}(a); return a[0] + a[1] + a[2]; }).apply(null, x as any); } return f("c", "a", "b");`,
    NO_HOST,
  ],
  [
    "arguments, comparator",
    `function g() { const a = arguments; ${SORT}(a, (x: any, y: any) => y - x); return "" + a[0] + a[1] + a[2]; } return (g as any)(1, 3, 2);`,
    NO_HOST,
  ],
  [
    "class instance",
    `class C { 0 = 3; 1 = 1; 2 = 2; length = 3; } const o = new C(); ${SORT}(o, (a: any, b: any) => a - b); return "" + o[0] + o[1] + o[2];`,
    NO_HOST,
  ],
  [
    "Proxy receiver",
    `const t: any = { length: 3, 0: "c", 1: "a", 2: "b" }; ${SORT}(new Proxy(t, {})); return "" + t[0] + t[1] + t[2];`,
    NO_HOST,
  ],
  [
    "frozen receiver throws TypeError",
    `const o = Object.freeze({ length: 2, 0: "b", 1: "a" }); try { ${SORT}(o); return "no"; } catch (e) { return "E" + (e instanceof TypeError) + o[0]; }`,
    NO_HOST,
  ],
  // Real arrays through the generic call, every lane.
  ["array receiver", `const a = ["c", "a", "b"]; ${SORT}(a); return a.join();`, ALL],
  [
    "array receiver, comparator",
    `const a = [3, 1, 2]; ${SORT}(a, (x: number, y: number) => y - x); return a.join();`,
    ALL,
  ],
];

describe("#7167 Array.prototype.sort.call on array-likes", () => {
  for (const [name, body, lanes] of ROWS) {
    it(name, () => expectSame(body, lanes));
  }
});
