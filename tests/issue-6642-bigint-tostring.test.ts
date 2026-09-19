// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6642 (#5383 S62) — the FIFTH link: under `--target standalone`,
// `<any>.toString(radix)` was not callable for a NUMBER receiver and
// `<any>.toString(…)` was not callable at all for a BIGINT one, while
// `String(<bigint>)` answered a null ref that trapped in the caller.
//
// WHY THIS REDUCTION EXISTS. `@js-temporal/polyfill` converts its JSBI carrier
// to a real BigInt with `globalThis.BigInt(t.toString(10))`. Seeding
// `globalThis.BigInt` (`STANDALONE_GLOBAL_CONSTRUCTOR_NAMES`) plus its
// `[[Call]]` arm (`CALLABLE_WRAPPER_CTORS`) is what first EXECUTES that line —
// on a receiver whose `toString` reached `__extern_method_call`'s terminal miss
// and became `TypeError: called value is not a function`. S60 and S61 measured
// the seeding alone turning a wrong VALUE into a thrown TypeError and held it
// back for exactly this reason, so all four pieces land together and the last
// case below (`polyfillShape`) is the polyfill's line, verbatim.
//
// WHICH ASSERTIONS HAVE TEETH — measured by file-copy revert of the five changed
// source files to `bb435fa167` (probe `.tmp/s62/probe/q1.mjs` / `q2.mjs`, both
// labels on this tree):
//
//   numeric radix rows            -1 (threw)      → 1
//   numeric radix RangeError      2 (TypeError)   → 1 (RangeError, §21.1.3.6)
//   every bigint `toString` row   -1 (threw)      → 1
//   bigint radix RangeError       2 (TypeError)   → 1 (RangeError, §21.2.3.3)
//   `String(<bigint>)` rows       0 ("[object Object]" — `__any_to_string`'s
//                                 residual arm; 15 chars, measured) → 1
//   `globalThis.BigInt` present   0               → 1
//   `globalThis.BigInt("12")`     -1 (threw)      → 1
//   the two-module polyfill shape -1 (threw)      → 1
//
// CONTROLS that must not move — all measured identical on base and branch: a
// 0-argument `x.toString()` on a number (it already worked through another
// arm), a statically-typed receiver of either kind, and `String()` of a number,
// string, boolean, object, array, null and undefined. A prepended arm's one
// real hazard is displacing a receiver that already answers, so the ToString
// controls are asserted rather than assumed.
//
// Host-free: `hostBridge: "off"` and an EMPTY import object. Every probe answers
// a NUMBER — a standalone module's string is a WasmGC array the host cannot
// decode, so every comparison happens INSIDE the module.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function singleModule(source: string): Promise<Record<string, () => unknown>> {
  const entry = "/__main.js";
  const result = await compileMulti({ [entry]: source }, entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...STANDALONE,
  } as never);
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const imports = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (i: unknown) => void }).__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, () => unknown>;
}

const RADIX = `
  function ask(x, r) { return x.toString(r); }
  function ask0(x) { return x.toString(); }

  // 1 = the spec answer, 0 = any other value, -1 = threw.
  export function numRadix16()  { try { return ask(255, 16) === "ff" ? 1 : 0; } catch (e) { return -1; } }
  export function numRadix2()   { try { return ask(255, 2) === "11111111" ? 1 : 0; } catch (e) { return -1; } }
  export function numRadix10()  { try { return ask(123456789, 10) === "123456789" ? 1 : 0; } catch (e) { return -1; } }
  // §21.1.3.6 step 2 — an \`undefined\` radix means 10 and SKIPS the range check.
  export function numUndefined(){ try { return ask(255, undefined) === "255" ? 1 : 0; } catch (e) { return -1; } }
  // §21.1.3.6 step 4 — the KIND matters: the base threw a TypeError here, so
  // "it throws" alone would have passed on the base.
  export function numRadix1()   { try { ask(255, 1); return 0; } catch (e) { return e instanceof RangeError ? 1 : (e instanceof TypeError ? 2 : 3); } }
  export function numRadix40()  { try { ask(255, 40); return 0; } catch (e) { return e instanceof RangeError ? 1 : (e instanceof TypeError ? 2 : 3); } }

  export function bigRadix16()  { try { return ask(255n, 16) === "ff" ? 1 : 0; } catch (e) { return -1; } }
  // 18 significant decimal digits — past an f64's ~15.95, so a
  // \`__str_to_number\` round trip would answer ...792 and this row is what
  // pins the answer to the exact i64 formatter.
  export function bigRadix10()  { try { return ask(217175010123456789n, 10) === "217175010123456789" ? 1 : 0; } catch (e) { return -1; } }
  export function bigNoArg()    { try { return ask0(217175010123456789n) === "217175010123456789" ? 1 : 0; } catch (e) { return -1; } }
  export function bigNegative() { try { return ask0(-12n) === "-12" ? 1 : 0; } catch (e) { return -1; } }
  export function bigZero()     { try { return ask0(0n) === "0" ? 1 : 0; } catch (e) { return -1; } }
  export function bigUndefined(){ try { return ask(255n, undefined) === "255" ? 1 : 0; } catch (e) { return -1; } }
  // §21.2.3.3 step 3 — RangeError, not the base's TypeError.
  export function bigRadix1()   { try { ask(255n, 1); return 0; } catch (e) { return e instanceof RangeError ? 1 : (e instanceof TypeError ? 2 : 3); } }
  export function bigRadix40()  { try { ask(255n, 40); return 0; } catch (e) { return e instanceof RangeError ? 1 : (e instanceof TypeError ? 2 : 3); } }

  // CONTROLS — identical on base and branch.
  export function numNoArg()      { try { return ask0(255) === "255" ? 1 : 0; } catch (e) { return -1; } }
  export function staticNumRadix(){ try { return (255).toString(16) === "ff" ? 1 : 0; } catch (e) { return -1; } }
  export function staticBigRadix(){ try { return (255n).toString(16) === "ff" ? 1 : 0; } catch (e) { return -1; } }
`;

const TOSTRING = `
  function str(x) { return String(x); }
  function tmpl(x) { return \`\${x}\`; }
  function cat(x) { return "" + x; }

  export function strSmallBig() { try { return str(12n) === "12" ? 1 : 0; } catch (e) { return -1; } }
  export function strLargeBig() { try { return str(217175010123456789n) === "217175010123456789" ? 1 : 0; } catch (e) { return -1; } }
  export function strNegBig()   { try { return str(-5n) === "-5" ? 1 : 0; } catch (e) { return -1; } }

  // CONTROLS — every other ToString receiver, identical on base and branch.
  // The template and \`+\` spellings ALREADY answered correctly on the base
  // (\`__to_primitive\` has its own bigint arm); they are here because the one
  // real hazard of a prepended arm is displacing a route that already works.
  export function tmplBig()  { try { return tmpl(12n) === "12" ? 1 : 0; } catch (e) { return -1; } }
  export function catBig()   { try { return cat(12n) === "12" ? 1 : 0; } catch (e) { return -1; } }
  export function strNum()   { try { return str(5) === "5" ? 1 : 0; } catch (e) { return -1; } }
  export function strStr()   { try { return str("q") === "q" ? 1 : 0; } catch (e) { return -1; } }
  export function strObj()   { try { return str({}) === "[object Object]" ? 1 : 0; } catch (e) { return -1; } }
  export function strArr()   { try { return str([1,2]) === "1,2" ? 1 : 0; } catch (e) { return -1; } }
  export function strNull()  { try { return str(null) === "null" ? 1 : 0; } catch (e) { return -1; } }
  export function strUndef() { try { return str(undefined) === "undefined" ? 1 : 0; } catch (e) { return -1; } }
  export function strBool()  { try { return str(true) === "true" ? 1 : 0; } catch (e) { return -1; } }
`;

const REALM = `
  export function bigIntPresent() { try { return globalThis.BigInt !== undefined ? 1 : 0; } catch (e) { return -1; } }
  export function bigIntTypeof()  { try { return typeof globalThis.BigInt === "function" ? 1 : 0; } catch (e) { return -1; } }
  export function bigIntCallStr() { try { var s = "12"; return globalThis.BigInt(s) === 12n ? 1 : 0; } catch (e) { return -1; } }
  export function bigIntCallNum() { try { var n = 12; return globalThis.BigInt(n) === 12n ? 1 : 0; } catch (e) { return -1; } }
  // The polyfill's converter, verbatim: \`globalThis.BigInt(t.toString(10))\`
  // where \`t\` reaches the call through an \`any\` binding.
  export function polyfillShape()  {
    try { var t = 217175010123456789n; return globalThis.BigInt(t.toString(10)) === 217175010123456789n ? 1 : 0; }
    catch (e) { return -1; }
  }
`;

const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    // The polyfill's converter INSIDE a separately compiled provider — which is
    // where the fifteen Temporal rows' failing call actually happens.
    convert(t) { try { return globalThis.BigInt(t.toString(10)); } catch (e) { return -1; } },
    tag: 7,
  });`;

async function linkedPair(consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6642-"));
  const packageRoot = join(root, "node_modules", "ns6642");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6642", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), PROVIDER);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6642";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6642")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumer}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

const CONSUMER = `
  export function providerConverts() {
    try { return NS.convert(217175010123456789n) === 217175010123456789n ? 1 : 0; } catch (e) { return -1; }
  }
  export function providerTypeof() {
    try { return typeof NS.convert(12n) === "bigint" ? 1 : 0; } catch (e) { return -1; }
  }
  // CONTROL: a non-callable provider member keeps its existing answer.
  export function providerTag() {
    try { return NS.tag === 7 ? 1 : 0; } catch (e) { return -1; }
  }
`;

describe("#6642 dynamic-receiver toString for number and bigint (standalone)", () => {
  it("answers §21.1.3.6 / §21.2.3.3 through an `any` receiver, both arities", async () => {
    const ex = await singleModule(RADIX);
    // TEETH — every one of these answered -1 (threw) on the base tree.
    expect(ex.numRadix16()).toBe(1);
    expect(ex.numRadix2()).toBe(1);
    expect(ex.numRadix10()).toBe(1);
    expect(ex.numUndefined()).toBe(1);
    expect(ex.bigRadix16()).toBe(1);
    expect(ex.bigRadix10()).toBe(1);
    expect(ex.bigNoArg()).toBe(1);
    expect(ex.bigNegative()).toBe(1);
    expect(ex.bigZero()).toBe(1);
    expect(ex.bigUndefined()).toBe(1);
    // TEETH, sharper: the base threw a TypeError (2) for all four.
    expect(ex.numRadix1()).toBe(1);
    expect(ex.numRadix40()).toBe(1);
    expect(ex.bigRadix1()).toBe(1);
    expect(ex.bigRadix40()).toBe(1);
    // CONTROLS — identical on base and branch.
    expect(ex.numNoArg()).toBe(1);
    expect(ex.staticNumRadix()).toBe(1);
    expect(ex.staticBigRadix()).toBe(1);
  });

  it("stringifies a bigint through every ToString route, and moves no other receiver", async () => {
    const ex = await singleModule(TOSTRING);
    // TEETH — `__any_to_string` had no `$BigInt` arm, so a bigint fell to its
    // residual `"[object Object]"` (15 chars, measured) on the base tree.
    expect(ex.strSmallBig()).toBe(1);
    expect(ex.strLargeBig()).toBe(1);
    expect(ex.strNegBig()).toBe(1);
    // CONTROLS.
    expect(ex.tmplBig()).toBe(1);
    expect(ex.catBig()).toBe(1);
    expect(ex.strNum()).toBe(1);
    expect(ex.strStr()).toBe(1);
    expect(ex.strObj()).toBe(1);
    expect(ex.strArr()).toBe(1);
    expect(ex.strNull()).toBe(1);
    expect(ex.strUndef()).toBe(1);
    expect(ex.strBool()).toBe(1);
  });

  it("seeds a callable realm `BigInt` (links 3 + 4)", async () => {
    const ex = await singleModule(REALM);
    // TEETH — `globalThis.BigInt` was absent (0) on the base; the calls threw.
    expect(ex.bigIntPresent()).toBe(1);
    expect(ex.bigIntCallStr()).toBe(1);
    expect(ex.bigIntCallNum()).toBe(1);
    expect(ex.polyfillShape()).toBe(1);
    // CONTROL — the BARE identifier already classified as a function on base.
    expect(ex.bigIntTypeof()).toBe(1);
  });

  it("runs the polyfill's converter inside a separately linked provider", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(CONSUMER);
    // TEETH — -1 on the base tree; this is the fifteen-row Temporal bucket's shape.
    expect(ex.providerConverts()).toBe(1);
    expect(ex.providerTypeof()).toBe(1);
    // CONTROL — identical on base and branch.
    expect(ex.providerTag()).toBe(1);
  });
});
