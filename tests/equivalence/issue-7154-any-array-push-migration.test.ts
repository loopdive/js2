// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7154 — an `any[]` binding initialised with a non-empty literal and later
// filled by `push` took its vec element kind from the pushes alone, so
// `const a: any[] = [1]; a.push([2])` built a vec-of-vec slot and the seeded
// `1` came back as a hole (",2" instead of "1,2"); a pushed string made the
// seeded number a null string (trap in join). The same inference ignored
// `unshift` / `fill` / `splice` stores and bindings that share one vec
// (`cur = b`), whose differing slot types converted by copying. Each row is
// diffed against native JS on the gc (native-first), standalone and wasi lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

// Standalone returns a native string struct, so every row returns a numeric
// digest of the string and all lanes compare numbers.
const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

async function expectSameOnAllLanes(body: string): Promise<void> {
  const src = `${ENC}function value(): string { ${body} }\nexport function test(): number { return enc(value()); }`;
  const expected = evaluateAsJs(src).test!();
  for (const target of [undefined, "standalone", "wasi"] as const) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

const CHAIN = "for (let i = 0; i < 100; i++) { const b: any[] = [i]; cur.push(b); cur = b; }";

describe("#7154 any[] literal keeps its seeded elements when later stores change the element kind", () => {
  const rows: [string, string][] = [
    ["issue: push an array", `const a: any[] = [1]; a.push([2]); return a.join();`],
    ["issue: depth-100 chain via a root alias", `let cur: any[] = [1]; const root = cur; ${CHAIN} return root.join();`],
    [
      "depth-100 chain, cur initialised from root",
      `const root: any[] = [1]; let cur: any[] = root; ${CHAIN} return root.join();`,
    ],
    ["push a string", `const a: any[] = [1, 2]; a.push("x"); return a.join("-");`],
    ["push an object", `const a: any[] = [1]; a.push({ k: 3 }); return a.join() + "|" + a[1].k;`],
    ["push null", `const a: any[] = [1, 2]; a.push(null); return a.join() + "|" + a.length;`],
    [
      "multiple mixed pushes",
      `const a: any[] = [1.5]; a.push("s"); a.push([2, 3]); a.push(true); a.push(4); return a.join(";");`,
    ],
    [
      "index read, length, typeof after migration",
      `const a: any[] = [7, 8]; a.push("z"); return String(a[0] + a[1]) + a[2] + a.length + typeof a[0];`,
    ],
    [
      "for-of after migration",
      `const a: any[] = [1, 2]; a.push("s"); a.push([3]); let r = ""; for (const x of a) r += typeof x + ":" + x + ","; return r;`,
    ],
    ["index store of an array", `const a: any[] = [1]; a[1] = [2]; return a.join();`],
    ["index store past length", `const a: any[] = [1]; a[3] = "z"; return a.join() + "|" + a.length;`],
    ["holes before migration", `const a: any[] = [1, , 3]; a.push([2]); return a.join() + "|" + a.length;`],
    ["unshift after a numeric push", `const a: any[] = []; a.push(1); a.unshift("x"); return a.join();`],
    ["splice insert after numeric pushes", `const a: any[] = [1]; a.push(2); a.splice(1, 0, "m"); return a.join();`],
    ["fill after numeric pushes", `const a: any[] = []; a.push(1); a.push(2); a.fill("q"); return a.join();`],
    ["unknown[] literal + push(array)", `const a: unknown[] = [1]; a.push([2]); return a.join();`],
    [
      "typed number[] stays numeric",
      `const a: number[] = [1, 2]; a.push(3); a[3] = 4.5; return a.join() + "|" + a.length;`,
    ],
    ["any[] with only numeric stores", `const a: any[] = [1, 2]; a.push(3); a.unshift(0); return a.join();`],
    // Review round 2: sharing a vec between bindings keeps ONE layout. A typed
    // `T[]` and its alias pin the same typed vec (unboxed, no copy); only an
    // `any` / `unknown` element binding takes the dynamic carrier.
    [
      "number[] alias binding",
      `const xs: number[] = []; xs.push(1); const ys = xs; ys.push(2); return xs.length + ":" + xs.join() + ":" + ys.join();`,
    ],
    ["string[] alias binding", `const xs: string[] = []; xs.push("a"); const ys = xs; ys.push("b"); return xs.join();`],
    [
      "annotated number[] alias binding",
      `const xs: number[] = []; xs.push(1); const ys: number[] = xs; ys.push(2); return xs.join();`,
    ],
    [
      "number[] alias via object field",
      `const o: { f: number[] } = { f: [] }; const xs: number[] = []; xs.push(1); o.f = xs; o.f.push(2); return xs.join() + "|" + o.f.join();`,
    ],
    [
      "number[] alias via class field",
      `class Q { items: number[] = []; } const q = new Q(); const xs: number[] = []; xs.push(1); q.items = xs; q.items.push(2); return xs.join();`,
    ],
    [
      "struct P[] alias binding",
      `type P = { x: number }; const xs: P[] = []; xs.push({ x: 1 }); const ys = xs; ys.push({ x: 2 }); return String(xs.length) + ys[1].x;`,
    ],
    [
      "swap buffers",
      `let a: number[] = [], b: number[] = []; for (let i = 0; i < 5; i++) a.push(i); ` +
        `for (let r = 0; r < 3; r++) { b.length = 0; for (let i = 0; i < a.length; i++) b.push(a[i] + 1); const t = a; a = b; b = t; } ` +
        `return a.join() + "|" + b.join();`,
    ],
    [
      "cur = next then sort",
      `let cur: number[] = [3, 1, 2]; for (let r = 0; r < 3; r++) { const next: number[] = []; for (const x of cur) next.push(x * 2 - r); cur = next; } ` +
        `cur.sort((p, q) => p - q); return cur.join();`,
    ],
    [
      "any[] b = a reassignment",
      `let a: any[] = [1]; let b: any[] = []; b.push("x"); b = a; b.push([2]); return a.join() + "|" + b.join();`,
    ],
    [
      "any[] alias via object field",
      `const o: { f: any[] } = { f: [] }; const xs: any[] = [1]; xs.push("s"); o.f = xs; o.f.push([2]); return xs.join() + "|" + o.f.join();`,
    ],
    // Review round 3: an `any[]` that shares its vec with a typed `T[]` keeps
    // the typed layout both sides agree on (as before #7154).
    [
      "any[] aliased by a number[] binding",
      `const xs: any[] = []; xs.push(1); const ys: number[] = xs; ys.push(2); return xs.join() + "|" + ys.join();`,
    ],
    [
      "any[] assigned to a let number[]",
      `const xs: any[] = []; xs.push(1); let ys: number[] = [0]; ys = xs; ys.push(2); return xs.join() + "|" + ys.join();`,
    ],
    [
      "any[] stored in a number[] object field",
      `const o: { f: number[] } = { f: [] }; const xs: any[] = []; xs.push(1); o.f = xs; o.f.push(2); return xs.join() + "|" + o.f.join();`,
    ],
    [
      "any[] stored in a number[] class field",
      `class Q { items: number[] = []; } const q = new Q(); const xs: any[] = []; xs.push(1); q.items = xs; q.items.push(2); return xs.join() + "|" + q.items.join();`,
    ],
    [
      "literal any[] aliased by a number[] binding",
      `const xs: any[] = [1]; xs.push(2); const ys: number[] = xs; ys.push(3); return xs.join() + "|" + ys.join();`,
    ],
    [
      "any[] aliased by a string[] binding",
      `const xs: any[] = []; xs.push("a"); const ys: string[] = xs; ys.push("b"); return xs.join() + "|" + ys.join();`,
    ],
    [
      "string[] aliased by an any[] binding",
      `const xs: string[] = []; xs.push("a"); const ys: any[] = xs; ys.push("b"); return xs.join() + "|" + ys.join();`,
    ],
  ];
  for (const [name, body] of rows) {
    it(name, () => expectSameOnAllLanes(body));
  }
});
