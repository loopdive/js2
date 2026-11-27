// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7497 — a reference slot narrowed to `bigint` (`typeof t === "bigint"`) was read by unboxing it to i64, and a
// consumer that wanted a reference (`String(t)`, an `any` parameter, an `unknown` local) boxed that i64 again: every
// bit past 64 was gone, so `String(2n ** 64n)` answered "0". A reference consumer now takes the carrier as it is.
// Every probe returns 1 for node's answer.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const W = "2n ** 64n";
const HELPERS = `function other(t) { return t; }
function Eq(a, b) { return a === b; }
export function ctl() { return other("x") === "x" && !Eq(1, 2) ? 1 : 0; }`;

// [name, JavaScript program]: host-free standalone, as in tests/issue-6656-bigint-wide-carrier.test.ts.
const JS_ROWS: readonly (readonly [string, string])[] = [
  [
    "String() of a narrowed local",
    `function f(t) { let n = t; if (typeof n === "bigint") return String(n); return "o"; }
     export function main() { return f("x") === "o" && f(${W}) === "18446744073709551616" ? 1 : 0; }`,
  ],
  [
    "String() of a narrowed parameter, negative",
    `function f(t) { if (typeof t === "bigint") return String(t); return "o"; }
     export function main() { return f("x") === "o" && f(-(${W})) === "-18446744073709551616" ? 1 : 0; }`,
  ],
  [
    "a narrowed parameter passed to an untyped parameter",
    `function f(t) { if (typeof t === "bigint") return Eq(t, ${W}); return false; }
     export function main() { return f("x") === false && f(${W}) ? 1 : 0; }`,
  ],
  [
    "a narrowed parameter returned",
    `function f(t) { if (typeof t === "bigint") return t; return 0; }
     export function main() { return f("x") === 0 && Eq(f(${W}), ${W}) ? 1 : 0; }`,
  ],
  [
    "a narrowed parameter in i64 arithmetic (unchanged)",
    `function f(t) { if (typeof t === "bigint") return String(t * 2n); return "o"; }
     export function main() { return f("x") === "o" && f(21n) === "42" ? 1 : 0; }`,
  ],
];

// [name, TypeScript program], run on gc and standalone.
const TS_ROWS: readonly (readonly [string, string])[] = [
  [
    "String() of an `any` parameter narrowed to bigint",
    `function f(t: any): string { if (typeof t === "bigint") return String(t); return "o"; }
     export function main(): number { return f("x") === "o" && f(${W}) === "18446744073709551616" ? 1 : 0; }`,
  ],
  [
    "an `unknown` parameter narrowed to bigint, stored back into `unknown`",
    `function f(t: unknown): boolean { if (typeof t === "bigint") { const k: unknown = t; return k === ${W}; } return false; }
     export function main(): number { return f("x") === false && f(${W}) ? 1 : 0; }`,
  ],
  [
    "a `bigint | null` narrowed by `!== null` (unchanged)",
    `function g(): bigint | null { return ${W}; }
     export function main(): number { const b = g(); const s: any = b; if (b !== null) { const k: any = b; return k === s ? 1 : 0; } return 0; }`,
  ],
];

async function runJs(body: string): Promise<{ main: number; ctl: number }> {
  const result = await compileMulti({ "/main.js": `${HELPERS}\n${body}` }, "/main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "off",
  } as never);
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const exports = instance.exports as Record<string, () => number> & { __module_init?: () => void };
  exports.__module_init?.();
  return { main: exports.main!(), ctl: exports.ctl!() };
}

async function runTs(source: string, target: "gc" | "standalone"): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

describe("#7497 — a narrowed BigInt keeps its carrier for a reference consumer (standalone, host-free JS)", () => {
  it.each(JS_ROWS)("%s", async (_, body) => {
    expect(await runJs(body)).toEqual({ main: 1, ctl: 1 });
  });
});

describe.each(["gc", "standalone"] as const)(
  "#7497 — a narrowed BigInt keeps its carrier (%s, TypeScript)",
  (target) => {
    it.each(TS_ROWS)("%s", async (_, source) => {
      expect(await runTs(source, target)).toBe(1);
    });
  },
);
