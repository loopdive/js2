// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6487 (#5383 S22) — `Object.getPrototypeOf(<value that is callable only at
// RUNTIME>)` answered `null` under `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. The compile-time arm in `object-get-prototype-of.ts`
// answers `%Function.prototype%` whenever the CHECKER can prove the argument
// callable (`signatureOf`, a function expression, an arrow). A value reached
// through an `any` binding carries no signature, so it fell to the generic
// `__getPrototypeOf`, whose `$proto` walk only decodes `$Object` receivers — a
// closure carrier is not one, and the walk answered `null`.
//
// Across a linked standalone provider EVERY namespace member is such a value by
// construction, which is what test262's seven Temporal `builtin.js` rows saw:
// `assert.sameValue(Object.getPrototypeOf(Temporal.PlainDate.compare),
// Function.prototype, "prototype")` with actual «null». The other three
// assertions of those same rows (`isExtensible`, `Object.prototype.toString`,
// `hasOwnProperty("prototype")`) already passed — only the [[Prototype]] read
// was wrong.
//
// WHICH ARM HAS TEETH. `dynamicFunctionValue`, `dynamicClassMethodValue`,
// `registryFunctionValue` and the linked `providerMethod` all answered 0 (the
// `=== Function.prototype` comparison was false, because the answer was null) on
// the base tree, measured by file-copy revert of the two changed files
// (`.tmp/s22base/`, `.tmp/s22/c2.mjs` rows 09–14 and `.tmp/s22/link.mjs` row 0).
//
// CONTROLS that must not move — all measured identical on base and branch:
// an ordinary object, an array, a statically-typed class instance, and (the one
// this arm deliberately declines) a provider-owned INSTANCE, whose
// [[Prototype]] is a separate unfixed residual. `__is_callable` is masked to
// bit 0, so an instance never reaches the new answer.
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

const SINGLE = `
  function topFn(a) { return a; }
  class C { constructor() { this.x = 1; } m() { return 1; } }
  const registry = {};
  registry["%f%"] = topFn;
  registry["%m%"] = C.prototype.m;
  function lookup(k) { return registry[k]; }

  // 1 = the spec answer, 0 = anything else (on base: null).
  export function dynamicFunctionValue() {
    function ask(o) { return Object.getPrototypeOf(o) === Function.prototype ? 1 : 0; }
    return ask(topFn);
  }
  export function dynamicClassMethodValue() {
    function ask(o) { return Object.getPrototypeOf(o) === Function.prototype ? 1 : 0; }
    return ask(C.prototype.m);
  }
  export function registryFunctionValue() {
    return Object.getPrototypeOf(lookup("%m%")) === Function.prototype ? 1 : 0;
  }
  // The old answer, asserted directly so a future regression to it is named.
  export function dynamicFunctionIsNoLongerNull() {
    function ask(o) { return Object.getPrototypeOf(o) === null ? 1 : 0; }
    return ask(topFn);
  }

  // CONTROLS — a non-callable dynamic receiver keeps the generic walk.
  export function dynamicPlainObject() {
    function ask(o) { return Object.getPrototypeOf(o) === Object.prototype ? 1 : 0; }
    return ask({ a: 1 });
  }
  // A DOCUMENTED RESIDUAL, not a regression: an array reached through an
  // any-typed parameter already answered null before this slice
  // (.tmp/s22/c3-base.out rows 01/02), and still does. Same for a string, a
  // number, a Map and a class instance — only the CALLABLE case is in scope
  // here. Asserted at its measured value so the day it changes is a real event.
  export function dynamicArray() {
    function ask(o) { return Object.getPrototypeOf(o) === Array.prototype ? 1 : 0; }
    return ask([1, 2]);
  }
  export function dynamicArrayIsStillNull() {
    function ask(o) { return Object.getPrototypeOf(o) === null ? 1 : 0; }
    return ask([1, 2]);
  }
  export function staticClassInstance() {
    return Object.getPrototypeOf(new C()) === C.prototype ? 1 : 0;
  }
  export function staticFunctionExpression() {
    const g = function (a) { return a; };
    return Object.getPrototypeOf(g) === Function.prototype ? 1 : 0;
  }
`;

const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    compare(a, b) { return a - b; },
    make() { return { tag: 7 }; },
    bag: { n: 1 },
  });`;

async function linkedPair(consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6487-"));
  const packageRoot = join(root, "node_modules", "ns6487");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6487", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), PROVIDER);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6487";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6487")!;
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
  // The exact test262 \`builtin.js\` assertion, across the link. -1 = threw.
  export function providerMethod() {
    try { return Object.getPrototypeOf(NS.compare) === Function.prototype ? 1 : 0; } catch (e) { return -1; }
  }
  // CONTROL: a provider-owned non-callable member keeps its existing answer.
  export function providerBagIsNotAFunction() {
    try { return Object.getPrototypeOf(NS.bag) === Function.prototype ? 1 : 0; } catch (e) { return -1; }
  }
  // CONTROL: the other three assertions of the same builtin.js row already
  // passed on base and must keep passing.
  export function providerMethodHasNoOwnPrototype() {
    try { return NS.compare.hasOwnProperty("prototype") ? 1 : 0; } catch (e) { return -1; }
  }
`;

describe("#6487 Object.getPrototypeOf of a value that is callable only at runtime (standalone)", () => {
  it("answers %Function.prototype% module-locally, and keeps every non-callable receiver", async () => {
    const ex = await singleModule(SINGLE);
    // TEETH — all three answered 0 on the base tree.
    expect(ex.dynamicFunctionValue()).toBe(1);
    expect(ex.dynamicClassMethodValue()).toBe(1);
    expect(ex.registryFunctionValue()).toBe(1);
    // The base answer, named: it was `null`, and it must not come back.
    expect(ex.dynamicFunctionIsNoLongerNull()).toBe(0);
    // CONTROLS — identical on base and branch (`.tmp/s22/c3-{base,new}.out`,
    // ten probes, every row the same).
    expect(ex.dynamicPlainObject()).toBe(1);
    // The residual named above: still null, on both trees.
    expect(ex.dynamicArray()).toBe(0);
    expect(ex.dynamicArrayIsStillNull()).toBe(1);
    expect(ex.staticClassInstance()).toBe(1);
    expect(ex.staticFunctionExpression()).toBe(1);
  });

  it("answers %Function.prototype% for a method reached across a standalone link", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(CONSUMER);
    // TEETH — 0 on the base tree; this is the seven-row Temporal bucket.
    expect(ex.providerMethod()).toBe(1);
    // CONTROLS — identical on base and branch.
    expect(ex.providerBagIsNotAFunction()).toBe(0);
    expect(ex.providerMethodHasNoOwnPrototype()).toBe(0);
  });
});
