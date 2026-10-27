// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7154 review round 5 — every alias of one array observes every push, for
// each expression wrapper an `any[]` initializer / assignment can put around
// its partner (parens, `as`, `<T>`, `!`, `satisfies`, `,`, nested `=`, `?:`,
// `||`, `??`, `&&`, `as <the partner's runtime type>`) and each partner kind
// (typed `number[]` / `string[]`, `any[]`, `any[] | undefined`, a fresh
// literal; round 6: `any` / `unknown` values holding a typed vec as a local,
// a parameter, a property and an optional chain, and call results typed
// `number[]` / `any[]`). Every row also aliases the result once more
// (`const zs: any[] = xs`) and reads every alias. Rows are generated so a
// missing shape shows up as a failing row. Each row is diffed against native
// JS on the gc (native-first), standalone and wasi lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const ENC = `function enc(s: string): number { let h = s.length; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000003; return h; }\n`;

async function expectSameOnAllLanes(body: string, top: string): Promise<void> {
  const src = `${ENC}${top}\nfunction value(): string { ${body} }\nexport function test(): number { return enc(value()); }`;
  const expected = evaluateAsJs(src).test!();
  for (const target of [undefined, "standalone", "wasi"] as const) {
    const lane = target ?? "gc";
    const result = await compile(src, { fileName: "probe.ts", ...(target ? { target } : {}) });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect((instance.exports.test as () => unknown)(), lane).toBe(expected);
  }
}

interface Partner {
  /** Module-level declarations. */
  readonly top?: string;
  /** Declares the partner (absent for a fresh literal). */
  readonly setup: string;
  /** Declared type of the nested-assignment target `ys`. */
  readonly ysType: string;
  /** The partner expression wrapped below. */
  readonly leaf: string;
  /** The leaf where the wrapper itself does not strip `undefined`. */
  readonly nonNullLeaf: string;
  /** The partner's run-time array type, for the `as T` wrapper. */
  readonly under: string;
  /** Pushes through the source array after the share, and its read. */
  readonly after: string;
  readonly pushed: string;
  /** The share runs inside `function run(o: any)` called with the source. */
  readonly asParam?: boolean;
}

const NUM_SRC = "const n: number[] = []; n.push(1); ";
const NUM_AFTER = 'n.push(3); r += "|" + n.join(); ';
const viaAny = (setup: string, leaf: string, nonNullLeaf = leaf): Partner => ({
  setup: NUM_SRC + setup,
  ysType: "any[]",
  leaf,
  nonNullLeaf,
  under: "number[]",
  after: NUM_AFTER,
  pushed: "2",
});

const PARTNERS: Record<string, Partner> = {
  "number[]": {
    setup: NUM_SRC,
    ysType: "number[]",
    leaf: "n",
    nonNullLeaf: "n",
    under: "number[]",
    after: NUM_AFTER,
    pushed: "2",
  },
  "string[]": {
    setup: 'const n: string[] = []; n.push("a"); ',
    ysType: "string[]",
    leaf: "n",
    nonNullLeaf: "n",
    under: "string[]",
    after: 'n.push("c"); r += "|" + n.join(); ',
    pushed: '"b"',
  },
  "any[]": {
    setup: "const n: any[] = []; n.push(1); ",
    ysType: "any[]",
    leaf: "n",
    nonNullLeaf: "n",
    under: "any[]",
    after: 'n.push([3]); r += "|" + n.join(); ',
    pushed: '"s"',
  },
  "any[] | undefined": {
    setup: "function maybe(): any[] | undefined { const m: any[] = []; m.push(1); return m; } const n = maybe(); ",
    ysType: "any[]",
    leaf: "n",
    nonNullLeaf: "n!",
    under: "any[]",
    after: 'n!.push([3]); r += "|" + n!.join(); ',
    pushed: '"s"',
  },
  "fresh literal": {
    setup: "",
    ysType: "any[]",
    leaf: "[1]",
    nonNullLeaf: "[1]",
    under: "any[]",
    after: "",
    pushed: '"s"',
  },
  "any local": viaAny("const o: any = n; ", "o"),
  "unknown local": viaAny("const o: unknown = n; ", "(o as any[])"),
  "any property": viaAny("const box: any = { arr: n }; ", "box.arr"),
  "any optional chain": viaAny("const box: any = { arr: n }; ", "box?.arr"),
  "any parameter": { ...viaAny("", "o"), asParam: true },
  "call returning number[]": {
    top: "const N: number[] = [1]; function get(): number[] { return N; }",
    setup: "",
    ysType: "number[]",
    leaf: "get()",
    nonNullLeaf: "get()",
    under: "number[]",
    after: 'N.push(3); r += "|" + N.join(); ',
    pushed: "2",
  },
  "call returning any[]": {
    top: 'const A: any[] = [1, "a"]; function getA(): any[] { return A; }',
    setup: "",
    ysType: "any[]",
    leaf: "getA()",
    nonNullLeaf: "getA()",
    under: "any[]",
    after: 'A.push([3]); r += "|" + A.join(); ',
    pushed: '"s"',
  },
};

const WRAPPERS: Record<string, (p: Partner) => string> = {
  parens: (p) => `(${p.nonNullLeaf})`,
  as: (p) => `${p.nonNullLeaf} as any[]`,
  "<T>": (p) => `<any[]>${p.nonNullLeaf}`,
  "as runtime type": (p) => `${p.nonNullLeaf} as ${p.under}`,
  "!": (p) => `${p.leaf}!`,
  satisfies: (p) => `${p.nonNullLeaf} satisfies any[]`,
  comma: (p) => `(f(), ${p.nonNullLeaf})`,
  "nested =": (p) => `(ys = ${p.nonNullLeaf})`,
  "?:": (p) => `c ? ${p.nonNullLeaf} : []`,
  "||": (p) => `${p.leaf} || []`,
  "??": (p) => `${p.leaf} ?? []`,
  "&&": (p) => `${p.nonNullLeaf} && ${p.nonNullLeaf}`,
};

const PRELUDE =
  "function f(): number { return 0; } function cond(k: number): boolean { return k > 0; } const c = cond(1); ";

function program(partner: Partner, wrapper: (p: Partner) => string, form: "init" | "assign"): string {
  const share =
    form === "init"
      ? `const xs: any[] = ${wrapper(partner)}; `
      : `let xs: any[] = []; xs.push(${partner.pushed}); xs = ${wrapper(partner)}; `;
  const core =
    `let ys: ${partner.ysType} = []; ${share}xs.push(${partner.pushed}); const zs: any[] = xs; zs.push(${partner.pushed}); ` +
    `let r = xs.join() + "|" + xs.length + "|" + zs.join(); `;
  if (partner.asParam) {
    return (
      PRELUDE +
      partner.setup +
      `function run(o: any): string { ${core}r += "|" + ys.join(); return r; } let r = run(n); ${partner.after}return r;`
    );
  }
  return PRELUDE + partner.setup + core + `${partner.after}r += "|" + ys.join(); return r;`;
}

// Rows that are wrong on main too (not regressions; listed under "Left out"
// in #7154). `it.fails` keeps them visible: a fix flips them and fails here.
// - Assigning an `any` value that holds a typed vec to a pinned `any[]` slot
//   without a type assertion casts it to the slot's vec type: `illegal cast`.
// - `xs = (ys = o as any[])` with `o: unknown`: `ys` has no stores of its own,
//   so it keeps the default dynamic layout while `xs` is typed, and copies.
const ANY_VALUE_PARTNERS = new Set(["any local", "any property", "any optional chain", "any parameter"]);
const ASSERTING_WRAPPERS = new Set(["as", "<T>", "as runtime type"]);
function knownGap(wrapperName: string, partnerName: string, form: "init" | "assign"): boolean {
  if (form === "assign" && ANY_VALUE_PARTNERS.has(partnerName) && !ASSERTING_WRAPPERS.has(wrapperName)) return true;
  return wrapperName === "nested =" && partnerName === "unknown local";
}

describe("#7154 any[] share sweep: every alias observes every push", () => {
  for (const [wrapperName, wrapper] of Object.entries(WRAPPERS)) {
    for (const [partnerName, partner] of Object.entries(PARTNERS)) {
      for (const form of ["init", "assign"] as const) {
        const test = knownGap(wrapperName, partnerName, form) ? it.fails : it;
        test(`${form} via ${wrapperName} with a ${partnerName} partner`, () =>
          expectSameOnAllLanes(program(partner, wrapper, form), partner.top ?? ""));
      }
    }
  }
});
