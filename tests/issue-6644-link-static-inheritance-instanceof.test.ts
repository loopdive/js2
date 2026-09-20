// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6644 (#5383 S66) — three linked mechanisms that a class extending a LINKED
// provider class was missing under `--target standalone`, all measured against
// the two-module fixture with the four changed subsystems file-copy-reverted to
// `930ab332f4` (the S65 head), 2026-09-19:
//
// 1. **Static inheritance through the heritage** (§15.7.14 step 6). #6640/S64
//    made the INSTANCES provider-minted; the CLASS OBJECT got no [[Prototype]]
//    edge, so `Sub.from` resolved nowhere. Base → fix: `typeof Sub.from`
//    `undefined` → `function`, `Sub.from(3).get()` / `Sub.tag()` /
//    `Sub["tag"]()` `!called value is not a function` (or `null`) → `3` /
//    `base` / `base`.
// 2. **An IDENTIFIER heritage** — `class S extends construct {}` where
//    `construct` is a function PARAMETER (#6640's residual 2). Base → fix:
//    `mk(NS.Base).get()` `!called value is not a function` → `4`. The heritage
//    VALUE is in scope at exactly one program point, so it is captured into a
//    module global at ClassDefinitionEvaluation and read from there by the
//    synthesized constructor and by the static arms, which are different wasm
//    functions.
// 3. **Cross-link `instanceof`**. It answered `false` even for a DIRECTLY
//    constructed provider instance — #6640 pinned exactly that as a control,
//    and this file FLIPS those two controls to `true`. Every ingredient of
//    §7.3.20 already crossed the seam; the own-property GATE
//    (`hasOwnProperty(T, "prototype")`) is what missed for a provider-minted
//    class object.
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
 * The `Temporal.PlainDate` shape reduced to its load-bearing parts: a static
 * factory that reads `this`, a static that does not, a constructor with state,
 * an instance method, and a static brand check. Exported through a frozen
 * namespace so the consumer's heritage clause is a PROPERTY ACCESS — the exact
 * node kind test262 writes as `Temporal.PlainDate`.
 */
const PROVIDER = `
  export class Base {
    constructor(a) { this.a = a; }
    get() { return this.a; }
    label() { return "base"; }
    static from(x) { return new this(x); }
    static tag() { return "base"; }
    static make() { return new Base(41); }
    static brandOf(v) { return (v instanceof Base) ? "base" : "foreign"; }
  }
  export const NS = Object.freeze({ __proto__: null, Base: Base });`;

const PRELUDE = `
  class Sub extends NS.Base { }
  class SubOwn extends NS.Base { own() { return 99; } static tag() { return "own"; } }
  class LocalBase { constructor(x) { this.x = x; } static ltag() { return "L"; } two() { return this.x * 2; } }
  class LocalDerived extends LocalBase { }
  function mk(construct) { class S2 extends construct {} return new S2(4); }
  function mkStatic(construct, method) { class S3 extends construct {} return S3[method](6); }
`;

/**
 * Compile `provider` as an npm package, link a consumer that stringifies each
 * expression in turn, and read the answers back host-free — the
 * `runLinkedStrings` shape from `tests/issue-6640-…`, batched so one compile
 * answers the whole table.
 */
async function runLinkedStrings(provider: string, prelude: string, expressions: string[]): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "issue-6644-"));
  const packageRoot = join(root, "node_modules", "ns6644");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6644", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6644";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6644")!;
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

/** TEETH — every one of these answered wrong on the base tree. */
const TEETH: ReadonlyArray<readonly [string, string]> = [
  // (1) static inheritance through a property-access heritage. Base:
  // `undefined`, `!called value is not a function`, same, `null`.
  ["typeof Sub.from", "function"],
  ["Sub.from(3).get()", "3"],
  ["Sub.tag()", "base"],
  ["Sub['tag']()", "base"],
  // (2) an IDENTIFIER heritage naming a function parameter. Base:
  // `!called value is not a function` / `undefined`.
  ["mk(NS.Base).get()", "4"],
  ["mk(NS.Base).a", "4"],
  ["mkStatic(NS.Base, 'from').get()", "6"],
  // (3) cross-link `instanceof`. Base: `false` for ALL THREE, including the
  // direct provider instance — these two lines were CONTROLS in
  // `tests/issue-6640-link-extends-provider-class.test.ts` pinning the gap.
  ["(new NS.Base(1)) instanceof NS.Base", "true"],
  ["NS.Base.make() instanceof NS.Base", "true"],
  ["(new Sub(2)) instanceof NS.Base", "true"],
];

/** CONTROLS — must not move. */
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  // Direct construction / static calls across the link, unchanged.
  ["new NS.Base(3).get()", "3"],
  ["NS.Base.make().get()", "41"],
  ["NS.Base.tag()", "base"],
  ["NS.Base.brandOf(new Sub(5))", "base"],
  ["Object.getPrototypeOf(new NS.Base(3)) === NS.Base.prototype", "true"],
  // #6640's own teeth, still green.
  ["new Sub(5).get()", "5"],
  ["new Sub(5).a", "5"],
  ["new SubOwn(5).own()", "99"],
  // An OWN static still SHADOWS the inherited one — the forwarding arm runs
  // last, after every own-surface arm has declined.
  //
  // The COMPUTED spelling of the same read (`SubOwn["tag"]()`) is deliberately
  // NOT probed here: it is an uncatchable `illegal cast` trap, and a
  // PRE-EXISTING one unrelated to the link — a purely local
  // `class LocalOwn { static tag() {} }` answers `SubOwn.tag()` fine and traps
  // identically on `LocalOwn["tag"]()` (measured, `.tmp/s66/probes/p10.mts`).
  // `tryEmitLinkedStaticComputedRead` refuses any class with an own static for
  // exactly that reason, so this slice neither causes nor widens it.
  ["SubOwn.tag()", "own"],
  // A derived class owns its own `prototype` / `name`; neither is forwarded.
  ["typeof Sub.prototype", "object"],
  ["Sub.name", "Sub"],
  // Ordinary LOCAL `extends` and its static inheritance, untouched.
  ["LocalDerived.ltag()", "L"],
  ["new LocalDerived(4).two()", "8"],
  ["(new LocalDerived(1)) instanceof LocalBase", "true"],
  ["(new LocalBase(1)) instanceof LocalBase", "true"],
  // `typeof` of the subclass is still a function value.
  ["typeof Sub", "function"],
  // PRE-EXISTING, pinned deliberately: a class object has no modelled
  // [[Prototype]] on this lane AT ALL — the LOCAL case answers `false` too, so
  // the linked case answering `false` is that gap and not this slice's. Named
  // as a residual in the issue.
  ["Object.getPrototypeOf(Sub) === NS.Base", "false"],
  ["Object.getPrototypeOf(LocalDerived) === LocalBase", "false"],
];

describe("#6644 — standalone static inheritance and `instanceof` across a provider link", () => {
  it("inherits the provider's statics, accepts an identifier heritage, and answers instanceof", async () => {
    const cases = [...TEETH, ...CONTROLS];
    const answers = await runLinkedStrings(
      PROVIDER,
      PRELUDE,
      cases.map(([expr]) => expr),
    );
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};
    cases.forEach(([expr, want], index) => {
      actual[expr] = answers[index]!;
      expected[expr] = want;
    });
    expect(actual).toEqual(expected);
  });
});
