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
  // (round 7) An all-number any[] that a typed `number[]` escape may receive.
  "fresh numeric literal": {
    setup: "",
    ysType: "any[]",
    leaf: "[1]",
    nonNullLeaf: "[1]",
    under: "number[]",
    after: "",
    pushed: "2",
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

// Review round 7: a member that escapes (call argument, method argument,
// arrow parameter, object field, array element, return, shorthand property,
// closure capture) must keep every alias and the escape target on one vec.
// Crossed with every partner kind, with and without a second `any[]` alias.
const ESCAPES: Record<string, (p: Partner) => string> = {
  none: () => "",
  "typed call argument": (p) => `function add(a: ${p.under}) { a.push(${p.pushed}); } add(xs); `,
  "any[] call argument": (p) => `function addAny(a: any[]) { a.push(${p.pushed}); } addAny(xs); `,
  "method argument": (p) => `const h = { add(a: ${p.under}) { a.push(${p.pushed}); } }; h.add(xs); `,
  "arrow parameter": (p) => `const addF = (a: ${p.under}) => { a.push(${p.pushed}); }; addF(xs); `,
  "object field": (p) => `const o: { a: ${p.under} } = { a: xs }; o.a.push(${p.pushed}); `,
  "array element": (p) => `const outer: ${p.under}[] = [xs]; outer[0].push(${p.pushed}); `,
  return: (p) => `const get = (): ${p.under} => xs; get().push(${p.pushed}); `,
  shorthand: (p) => `const o: { xs: ${p.under} } = { xs }; o.xs.push(${p.pushed}); `,
  "closure capture": (p) => `const pushIt = () => { xs.push(${p.pushed}); }; pushIt(); `,
};

function escapeProgram(partner: Partner, emitEscape: (p: Partner) => string, alias: boolean): string {
  const core =
    `const xs: any[] = ${partner.nonNullLeaf}; ` +
    (alias ? `const zs: any[] = xs; zs.push(${partner.pushed}); ` : "") +
    emitEscape(partner) +
    `xs.push(${partner.pushed}); let r = xs.join() + "|" + xs.length` +
    (alias ? ` + "|" + zs.join(); ` : "; ");
  if (partner.asParam) {
    return (
      PRELUDE +
      partner.setup +
      `function run(o: any): string { ${core}return r; } let r = run(n); ${partner.after}return r;`
    );
  }
  return PRELUDE + partner.setup + core + `${partner.after}return r;`;
}

// Escape rows wrong on main too (each fails there as well; `it.fails` so a
// fix shows up). Passing an any[] whose vec is typed (or held by a bare
// `any`) to an `any[]` parameter, storing an `any`-valued vec in a typed
// object field, returning a typed call result through a typed getter, and
// shorthand properties `{ xs }`.
const TYPED_SOURCE = [
  "number[]",
  "string[]",
  "any local",
  "unknown local",
  "any property",
  "any optional chain",
  "any parameter",
  "call returning number[]",
];
const KNOWN_ESCAPE_GAPS: Record<string, readonly string[]> = {
  "any[] call argument": TYPED_SOURCE,
  "object field": ["any local", "unknown local", "any parameter"],
  return: ["call returning number[]"],
  shorthand: ["any[]", "any[] | undefined", "any local", "unknown local", "any parameter", "call returning any[]"],
};
function knownEscapeGap(escapeName: string, partnerName: string, alias: boolean): boolean {
  if (escapeName === "shorthand" && partnerName === "fresh literal") return alias;
  return KNOWN_ESCAPE_GAPS[escapeName]?.includes(partnerName) ?? false;
}

describe("#7154 any[] share sweep: escapes keep every alias on one vec", () => {
  for (const [escapeName, emitEscape] of Object.entries(ESCAPES)) {
    for (const [partnerName, partner] of Object.entries(PARTNERS)) {
      for (const alias of [false, true]) {
        const test = knownEscapeGap(escapeName, partnerName, alias) ? it.fails : it;
        test(`${escapeName} escape, ${partnerName} partner${alias ? ", aliased" : ""}`, () =>
          expectSameOnAllLanes(escapeProgram(partner, emitEscape, alias), partner.top ?? ""));
      }
    }
  }
});
