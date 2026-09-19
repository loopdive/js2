// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6640 (#5383 S64) — `class S extends <linked-provider class>` had NO real
// inheritance under `--target standalone`: `super(...)` never reached the
// provider's constructor, no inherited method/getter dispatch, and the value
// was unrecognisable to the provider's own brand checks. The subclass compiled
// as an independent ROOT struct wearing a heritage clause it had no compiled
// relationship to — `class-bodies.ts::collectClassDeclaration`'s
// property-access heritage arm only marked `classDynamicUnresolvedHeritageSet`
// (#6623) and the comment there said so: "has NO standalone/wasi handling at
// all".
//
// THE FIX (`standalone-dynamic-parent-class.ts`): in a standalone LINK
// CONSUMER such a class becomes EXTERNREF-BACKED with a RUNTIME parent — the
// representation `class Sub extends Error` already used on this lane. `this` IS
// the object the provider's constructor minted: the `super(...)` call (explicit,
// or the synthesized derived constructor) evaluates the heritage EXPRESSION and
// hands it to the existing dynamic `__native_construct_<N>` driver, whose
// already-correct boundary arm routes a provider-owned class value to the
// provider's `__js2wasm_link_construct` terminal (#5383 S2f R12 / S2g).
// Inherited reads and method calls then work for free — the receiver is a value
// the PROVIDER minted, so the consumer's ladder misses and the established link
// `memberGet` / `methodCall` terminals answer, exactly as for a direct
// `new NS.Base()` instance.
//
// MEASURED by file-copy revert of the four changed files to `4337265784`
// (2026-09-19). Base tree, this exact fixture: `new SubNs(5).a` → `undefined`,
// `new SubNs(5).get()` / `.label()` / `new SubCtor().get()` → `!called value is
// not a function`, `NS.Base.brandOf(new SubNs(5))` → `foreign`. Fix tree: `5`,
// `5`, `base`, `7`, `base`. Against the REAL `@js-temporal/polyfill` provider
// the two `compare/use-internal-slots.js` rows (PlainDate, PlainDateTime) go
// `fail` → `pass`.
//
// Host-free: `hostBridge: "off"` and an EMPTY import object, the #6605/#6625
// convention — every value crosses purely in Wasm, with no host decode step
// that could mask a boundary bug.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * A provider class with constructor state, an instance method that reads it, a
 * second instance method, a static factory and a static BRAND CHECK — the
 * `Temporal.PlainDate` / `Temporal.PlainDate.compare` shape reduced to its
 * load-bearing parts. Exported through a frozen namespace object so the
 * consumer's heritage clause is a PROPERTY ACCESS (`NS.Base`), which is the
 * exact node kind test262 writes as `Temporal.PlainDate`.
 */
const PROVIDER = `
  export class Base {
    constructor(a) { this.a = a; }
    get() { return this.a; }
    label() { return "base"; }
    static make() { return new Base(41); }
    static brandOf(v) { return (v instanceof Base) ? "base" : "foreign"; }
  }
  export const NS = Object.freeze({ __proto__: null, Base: Base });`;

const PRELUDE = `
  class SubNs extends NS.Base { }
  class SubCtor extends NS.Base { constructor() { super(7); } }
  class SubOwn extends NS.Base { own() { return 99; } }
  class LocalBase { constructor(x) { this.x = x; } two() { return this.x * 2; } }
  class LocalDerived extends LocalBase { two() { return super.two() + 1; } }
`;

/**
 * Compile `provider` as an npm package, link a consumer that stringifies each
 * expression in turn, and read the answers back host-free — the
 * `runLinkedString` shape from `tests/issue-6625-…` / `tests/issue-6624-…`,
 * batched so one compile answers the whole table.
 */
async function runLinkedStrings(provider: string, prelude: string, expressions: string[]): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "issue-6640-"));
  const packageRoot = join(root, "node_modules", "ns6640");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6640", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6640";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6640")!;
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
  // `super(...)` reached the provider's constructor, so its own state is set.
  ["new SubNs(5).a", "5"],
  // …and the provider's instance methods are reachable from the subclass.
  ["new SubNs(5).get()", "5"],
  ["new SubNs(5).label()", "base"],
  // An EXPLICIT `super(7)` inside a declared constructor threads the same way.
  ["new SubCtor().get()", "7"],
  // The provider recognises the value as one of its own — the property this
  // whole slice exists for (`Temporal.PlainDate.compare` brand-checks exactly
  // like this before falling back to property-bag coercion).
  ["NS.Base.brandOf(new SubNs(5))", "base"],
  ["NS.Base.brandOf(new SubOwn(5))", "base"],
];

/** CONTROLS — must not move. */
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  // Direct construction / static calls across the link, unchanged.
  ["new NS.Base(3).a", "3"],
  ["new NS.Base(3).get()", "3"],
  ["new NS.Base(3).label()", "base"],
  ["NS.Base.make().get()", "41"],
  ["NS.Base.brandOf(new NS.Base(3))", "base"],
  ["Object.getPrototypeOf(new NS.Base(3)) === NS.Base.prototype", "true"],
  // A subclass's OWN declared method still dispatches locally.
  ["new SubOwn(5).own()", "99"],
  // Ordinary LOCAL `extends`, including `super.method()`, untouched.
  ["new LocalDerived(4).two()", "9"],
  // `typeof` of the subclass is still a function value.
  ["typeof SubNs", "function"],
  // PRE-EXISTING, pinned deliberately: `instanceof` against a provider-owned
  // class object answers `false` across the link even for a DIRECTLY
  // constructed provider instance (measured on the base tree). The subclass
  // answering `false` is therefore this gap, not a new one — it is the #6640
  // residual, and pinning the DIRECT case here is what keeps that claim honest.
  ["(new NS.Base(3)) instanceof NS.Base", "false"],
  ["(new SubNs(5)) instanceof NS.Base", "false"],
];

describe("#6640 — standalone `class S extends <linked-provider class>`", () => {
  it("threads super() through the provider's constructor and inherits its behaviour", async () => {
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
