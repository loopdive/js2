// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6644 (#5383 S67) — the three residuals S66 left behind, all measured against
// the two-module fixture with the four changed files file-copy-reverted to
// `ab6e22f345` (the S66 head), 2026-09-19:
//
// 1. **The computed static read resolved the class by NAME, not identity.**
//    `classExprNameMap.get(text) ?? text` is name-keyed, and #4618/#4646 give
//    every same-named class but the first a per-site synthetic identity. Since
//    a captured IDENTIFIER heritage stores its parent in a per-class module
//    global, keying on the name read the TWIN's global: two same-named classes
//    in two object-literal methods with DIFFERENT parents, and the second
//    answered the first one's parent. Base → fix: `oB.go(NS.Other,'tag')`
//    `base` (the wrong parent, after the owner has run) / `null` (before it
//    has) → `other` both times.
// 2. **A runtime SPREAD into the resolved provider static passed the array
//    itself.** The read hands back an externref callee whose CALL is lowered
//    fixed-arity, so a spread contributes exactly one value. Base → fix:
//    `viaSub(NS.Base,'two',['p','q'])` `two:p,q,undefined:2` →
//    `two:p,q:2` (the array arrived as the FIRST formal, which is why `x`
//    stringifies as `p,q` and `y` is `undefined`).
// 3. **`super(...<runtime spread>)` left `this` unbuilt.** The fixed-arity
//    construct driver cannot serve a runtime-length argument list, so the arm
//    declined and only evaluated the arguments for effect. Base → fix:
//    `mkCaptured(NS.Base,[5])` `1/NULL` → `1/5` (the constructor had always
//    run; only the instance was missing).
//
// Host-free (`hostBridge: "off"`, empty import object), the #6605/#6625/#6640
// convention: every value crosses purely in Wasm, with no host decode step that
// could mask a boundary bug.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * Two provider classes with DIFFERENT statics of the same name, so a subclass
 * that resolves to the wrong parent is caught by the value it answers rather
 * than by a crash. `one`/`two` echo their own `arguments.length`, which is the
 * only way to see a spread that was passed as one array.
 */
const PROVIDER = `
  export class Base {
    constructor(a) { this.a = a; }
    get() { return this.a; }
    static tag() { return "base"; }
    static one(x) { return "one:" + x + ":" + arguments.length; }
    static two(x, y) { return "two:" + x + "," + y + ":" + arguments.length; }
  }
  export class Other {
    constructor(a) { this.a = a; }
    static tag() { return "other"; }
  }
  export const NS = Object.freeze({ __proto__: null, Base: Base, Other: Other });`;

const PRELUDE = `
  // (1) TWO classes with the SAME name, in two object-literal methods — the
  // shape test262's temporalHelpers.js writes (several helpers each declare
  // their own \`class MySubclass extends construct\`).
  const oA = { go(construct, m) { class Shared extends construct {} return String(Shared[m]()); } };
  const oB = { go(construct, m) { class Shared extends construct {} return String(Shared[m]()); } };
  // (2) a runtime spread into the inherited static, computed and named.
  function viaSub(construct, m, a) { class SubSpread extends construct {} return String(SubSpread[m](...a)); }
  function viaSubNamed(construct, a) { class SubNamed extends construct {} return String(SubNamed.one(...a)); }
  // (3) super with a runtime spread — captured array and rest parameter.
  function mkCaptured(construct, cargs) {
    var called = 0;
    class R2 extends construct { constructor() { ++called; super(...cargs); } }
    var inst = new R2();
    return called + "/" + (inst === null ? "NULL" : String(inst.get()));
  }
  // Controls.
  class LocalBase { constructor(x) { this.x = x; } static ltag() { return "L"; } two() { return this.x * 2; } }
  class LocalDerived extends LocalBase { }
  function mkFixedSuper(construct) { class R3 extends construct { constructor(x) { super(x); } } return String(new R3(7).get()); }
  function mkImplicitSuper(construct) { class R4 extends construct {} return String(new R4(8).get()); }
  function viaSubNoSpread(construct, m) { class SubPlain extends construct {} return String(SubPlain[m]("p")); }
  const A1 = ["p"];
  const A2 = ["p", "q"];
`;

/**
 * Compile `provider` as an npm package, link a consumer that stringifies each
 * expression in turn, and read the answers back host-free — the
 * `runLinkedStrings` shape from `tests/issue-6644-link-static-inheritance-…`.
 */
async function runLinkedStrings(provider: string, prelude: string, expressions: string[]): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "issue-6644-s67-"));
  const packageRoot = join(root, "node_modules", "ns6644b");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6644b", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6644b";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6644b")!;
  const field = (artifact as { exportBoundaries: { NS: { field: string } } }).exportBoundaries.NS.field;
  const consumerEntry = "/__main.js";
  const probes = expressions
    .map(
      (expr, i) =>
        `export function prepare${i}() { try { __s = "" + (${expr}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n`,
    )
    .join("");
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]:
        `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\nlet __s = "";\n${prelude}\n${probes}` +
        `export function at(i) { return __s.charCodeAt(i); }\n`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [(artifact as { namespace: string }).namespace],
      linkedPackageBindings: new Map([[field, { module: (artifact as { namespace: string }).namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as Record<string, (i?: number) => number>;
  const out: string[] = [];
  for (let index = 0; index < expressions.length; index++) {
    const length = exports[`prepare${index}`]!();
    let answer = "";
    for (let at = 0; at < length; at++) answer += String.fromCharCode(exports.at!(at));
    out.push(answer);
  }
  return out;
}

/**
 * TEETH — every one of these answered wrong on the S66 head. Order is
 * load-bearing for the first three: the second-declared `Shared` is called
 * BEFORE the owner, which is what separates "declines" from "answers the
 * twin's parent".
 */
const TEETH: ReadonlyArray<readonly [string, string]> = [
  // (1) class identity, not class name. Base: `null`, `base`, `base`.
  ["oB.go(NS.Other, 'tag')", "other"],
  ["oA.go(NS.Base, 'tag')", "base"],
  ["oB.go(NS.Other, 'tag')", "other"],
  // (2) a runtime spread reaches the provider static as arguments, not as one
  // array. Base: `two:p,q,undefined:2` and `!called value is not a function`.
  ["viaSub(NS.Base, 'two', A2)", "two:p,q:2"],
  ["viaSubNamed(NS.Base, A1)", "one:p:1"],
  // (3) `super(...<runtime spread>)` builds `this`. Base: `1/NULL`.
  ["mkCaptured(NS.Base, [5])", "1/5"],
];

/** CONTROLS — must not move. */
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  // A DIRECT provider static with a spread was already correct.
  ["NS.Base.one(...A1)", "one:p:1"],
  ["NS.Base.two(...A2)", "two:p,q:2"],
  // A computed inherited static WITHOUT a spread keeps its existing lowering —
  // the new call arm is gated on a spread being present.
  ["viaSubNoSpread(NS.Base, 'one')", "one:p:1"],
  // Fixed-arity and implicit `super` through the link, unchanged.
  ["mkFixedSuper(NS.Base)", "7"],
  ["mkImplicitSuper(NS.Base)", "8"],
  // Direct construction and statics across the link, unchanged.
  ["new NS.Base(3).get()", "3"],
  ["NS.Base.tag()", "base"],
  ["NS.Other.tag()", "other"],
  ["(new NS.Base(1)) instanceof NS.Base", "true"],
  // Ordinary LOCAL `extends`, its static inheritance and a local spread call,
  // untouched.
  ["LocalDerived.ltag()", "L"],
  ["new LocalDerived(4).two()", "8"],
  ["(new LocalDerived(1)) instanceof LocalBase", "true"],
];

describe("#6644 S67 — computed static identity, spread arguments, and spread `super` across a provider link", () => {
  it("resolves the right class, expands a runtime spread, and builds `this`", async () => {
    const cases = [...TEETH, ...CONTROLS];
    const answers = await runLinkedStrings(
      PROVIDER,
      PRELUDE,
      cases.map(([expr]) => expr),
    );
    // The first three cases share an expression text; index them positionally.
    const actual = cases.map(([expr], index) => `${index}:${expr} => ${answers[index]!}`);
    const expected = cases.map(([expr, want], index) => `${index}:${expr} => ${want}`);
    expect(actual).toEqual(expected);
  });
});
