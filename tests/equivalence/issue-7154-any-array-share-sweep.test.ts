// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7154 review round 5 — every alias of one array observes every push, for
// each expression wrapper an `any[]` initializer / assignment can put around
// its partner (parens, `as`, `<T>`, `!`, `satisfies`, `,`, nested `=`, `?:`,
// `||`, `??`, `&&`) and each partner kind (typed `number[]`, typed
// `string[]`, `any[]`, `any[] | undefined`, a fresh literal). Rows are
// generated so a missing shape shows up as a failing row. Each row is diffed
// against native JS on the gc (native-first), standalone and wasi lanes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

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

interface Partner {
  /** Declares `n` (absent for a fresh literal). */
  readonly setup: string;
  readonly type: string;
  /** The partner expression wrapped below. */
  readonly leaf: string;
  /** The leaf where the wrapper itself does not strip `undefined`. */
  readonly nonNullLeaf: string;
  /** Pushes through `n` after the share, and the read of `n`. */
  readonly after: string;
  readonly pushed: string;
}

const PARTNERS: Record<string, Partner> = {
  "number[]": {
    setup: "const n: number[] = []; n.push(1); ",
    type: "number[]",
    leaf: "n",
    nonNullLeaf: "n",
    after: 'n.push(3); r += "|" + n.join(); ',
    pushed: "2",
  },
  "string[]": {
    setup: 'const n: string[] = []; n.push("a"); ',
    type: "string[]",
    leaf: "n",
    nonNullLeaf: "n",
    after: 'n.push("c"); r += "|" + n.join(); ',
    pushed: '"b"',
  },
  "any[]": {
    setup: "const n: any[] = []; n.push(1); ",
    type: "any[]",
    leaf: "n",
    nonNullLeaf: "n",
    after: 'n.push([3]); r += "|" + n.join(); ',
    pushed: '"s"',
  },
  "any[] | undefined": {
    setup: "function maybe(): any[] | undefined { const m: any[] = []; m.push(1); return m; } const n = maybe(); ",
    type: "any[] | undefined",
    leaf: "n",
    nonNullLeaf: "n!",
    after: 'n!.push([3]); r += "|" + n!.join(); ',
    pushed: '"s"',
  },
  "fresh literal": { setup: "", type: "any[]", leaf: "[1]", nonNullLeaf: "[1]", after: "", pushed: '"s"' },
};

const WRAPPERS: Record<string, (p: Partner) => string> = {
  parens: (p) => `(${p.nonNullLeaf})`,
  as: (p) => `${p.nonNullLeaf} as any[]`,
  "<T>": (p) => `<any[]>${p.nonNullLeaf}`,
  "!": (p) => `${p.leaf}!`,
  satisfies: (p) => `${p.nonNullLeaf} satisfies any[]`,
  comma: (p) => `(f(), ${p.nonNullLeaf})`,
  "nested =": (p) => `(ys = ${p.leaf === "n" && p.type.includes("undefined") ? "n!" : p.leaf})`,
  "?:": (p) => `c ? ${p.nonNullLeaf} : []`,
  "||": (p) => `${p.leaf} || []`,
  "??": (p) => `${p.leaf} ?? []`,
  "&&": (p) => `${p.nonNullLeaf} && ${p.nonNullLeaf}`,
};

const PRELUDE =
  "function f(): number { return 0; } function cond(k: number): boolean { return k > 0; } const c = cond(1); ";

function program(partner: Partner, wrapper: (p: Partner) => string, form: "init" | "assign"): string {
  const ysType = partner.type.includes("undefined") ? "any[]" : partner.type;
  const ys = `let ys: ${ysType} = []; `;
  const share =
    form === "init"
      ? `const xs: any[] = ${wrapper(partner)}; `
      : `let xs: any[] = []; xs.push(${partner.pushed}); xs = ${wrapper(partner)}; `;
  return (
    PRELUDE +
    partner.setup +
    ys +
    share +
    `xs.push(${partner.pushed}); let r = xs.join() + "|" + xs.length; ${partner.after}r += "|" + ys.join(); return r;`
  );
}

describe("#7154 any[] share sweep: every alias observes every push", () => {
  for (const [wrapperName, wrapper] of Object.entries(WRAPPERS)) {
    for (const [partnerName, partner] of Object.entries(PARTNERS)) {
      for (const form of ["init", "assign"] as const) {
        it(`${form} via ${wrapperName} with a ${partnerName} partner`, () =>
          expectSameOnAllLanes(program(partner, wrapper, form)));
      }
    }
  }
});
