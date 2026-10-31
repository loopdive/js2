// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7161 — TypeScript types `new Proxy(target, handler)` as the target's type, so
// call-site parameter inference (`inferParamTypeFromCallSites`) "agreed" an
// untyped parameter onto the target's struct (`$C`, `$Map`, `$Date`). The Proxy
// is a `$Proxy` carrier, and the guarded `ref.test`/`ref.cast` at the argument
// boundary turned it into `ref.null`: inside the callee `o === null` was true and
// `#v in o` threw. A call-site argument that may be a Proxy now withdraws a ref
// narrowing, so the parameter keeps its dynamic (externref) representation.
// Each row is diffed against native JS; the joined result is read back one char
// code at a time so the standalone lane needs no string marshalling.
//
// The wasi lane skips the `"x" in proxy` / `proxy.x` rows over a CLASS target:
// on wasi those answer `false` / `undefined` for a Proxy over a class instance
// even at top level with no call involved (a separate, pre-existing gap).
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const ALL = [
  { lane: "gc", options: {} },
  { lane: "standalone", options: { target: "standalone" } },
  { lane: "wasi", options: { target: "wasi" } },
] as const;
const NO_WASI = ALL.slice(0, 2);

const READ = `export function test(i) { const s = run(); return i < 0 ? s.length : s.charCodeAt(i); }`;

function decode(f: (i: number) => unknown): string {
  const n = Number(f(-1));
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(Number(f(i)));
  return out;
}

async function expectSameOnLanes(body: string, lanes: readonly (typeof ALL)[number][]): Promise<void> {
  const src = `${body}\n${READ}`;
  const expected = decode(evaluateAsJs(src).test as (i: number) => unknown);
  for (const { lane, options } of lanes) {
    const result = await compile(src, { fileName: "probe.js", ...options });
    expect(result.success, `${lane}: ${result.errors.map((e) => e.message).join("\n")}`).toBe(true);
    const instance = await instantiateWithRuntime(result);
    expect(decode(instance.exports.test as (i: number) => unknown), lane).toBe(expected);
  }
}

const BRAND = `class C { #v; x = 1; static has(o) { return #v in o; } }
function t(label, o) {
  let s = label + " " + String(o === null);
  try { s += " " + String(C.has(o)); } catch (e) { s += " threw"; }
  return s + ";";
}
`;

const CASES: Record<string, [string, readonly (typeof ALL)[number][]]> = {
  "the issue program: Proxy over a class instance": [
    `${BRAND}function run() { return t("proxyInst", new Proxy(new C(), {})); }`,
    ALL,
  ],
  "Proxy over a Map": [`${BRAND}function run() { return t("map", new Proxy(new Map(), {})); }`, ALL],
  "Proxy over a Date": [`${BRAND}function run() { return t("date", new Proxy(new Date(0), {})); }`, ALL],
  "Proxy.revocable(...).proxy": [
    `${BRAND}function run() { return t("rev", Proxy.revocable(new C(), {}).proxy); }`,
    ALL,
  ],
  "two call sites, a Proxy and a plain instance": [
    `${BRAND}function run() { return t("p", new Proxy(new C(), {})) + t("c", new C()); }`,
    ALL,
  ],
  "two call sites, both Proxies": [
    `${BRAND}function run() { return t("a", new Proxy(new C(), {})) + t("b", new Proxy(new C(), {})); }`,
    ALL,
  ],
  "a Proxy site and a number site, Proxy first": [
    `class C { x = 1; }
function t(o) { return typeof o + ":" + String(o === null) + ":" + (typeof o === "object" ? String(o.x) : "-") + ";"; }
function run() { return t(new Proxy(new C(), {})) + t(5); }`,
    NO_WASI,
  ],
  "a Proxy site and a number site, number first": [
    `class C { x = 1; }
function t(o) { return typeof o + ":" + String(o === null) + ";"; }
function run() { return t(5) + t(new Proxy(new C(), {})); }`,
    ALL,
  ],
  "a Proxy site and a boolean site, Proxy first": [
    `class C { x = 1; }
function t(o) { return typeof o + ":" + String(o === null) + ";"; }
function run() { return t(new Proxy(new C(), {})) + t(true); }`,
    ALL,
  ],
  "a Proxy site and a boolean site, boolean first": [
    `class C { x = 1; }
function t(o) { return typeof o + ":" + String(o === null) + ";"; }
function run() { return t(false) + t(new Proxy(new C(), {})); }`,
    ALL,
  ],
  "a Proxy site and a number site, typeof only": [
    `class C { x = 1; }
function t(o) { return typeof o + ":" + String(o === null) + ";"; }
function run() { return t(new Proxy(new C(), {})) + t(5); }`,
    ALL,
  ],
  "a Proxy passed through a variable": [
    `${BRAND}function run() { const p = new Proxy(new C(), {}); return t("var", p); }`,
    ALL,
  ],
  "a plain instance stays the narrowed struct": [`${BRAND}function run() { return t("c", new C()); }`, ALL],
  '"x" in proxy and proxy.x inside the callee': [
    `class C { x = 1; }
function t(o) { return String(o === null) + String("x" in o) + String("y" in o) + String(o.x); }
function run() { return t(new Proxy(new C(), {})); }`,
    NO_WASI,
  ],
  '"x" in proxy and proxy.x run the traps inside the callee': [
    `class C { x = 1; }
function t(o) { return String(o === null) + String("x" in o) + String(o.x); }
function run() { return t(new Proxy(new C(), { has() { return false; }, get() { return 7; } })); }`,
    ALL,
  ],
  "controls: Proxy over {}, [] and a function": [
    `function t(o) { return String(o === null) + typeof o + ";"; }
function run() { return t(new Proxy({}, {})) + t(new Proxy([], {})) + t(new Proxy(function () {}, {})); }`,
    ALL,
  ],
  'control: "x" in a Proxy over an object literal': [
    `function t(o) { return String("x" in o) + String(o.x); }
function run() { return t(new Proxy({ x: 1 }, {})); }`,
    ALL,
  ],
};

describe("#7161 a Proxy argument keeps its dynamic representation at a single call site", () => {
  for (const [name, [body, lanes]] of Object.entries(CASES)) {
    it(name, async () => {
      await expectSameOnLanes(body, lanes);
    });
  }
});
