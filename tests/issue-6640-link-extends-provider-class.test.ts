// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6640 (#5383 S64) — `class S extends <linked-provider class>` had NO real
// inheritance under `--target standalone`: `super(...)` never reached the
// provider's constructor, no inherited method/getter dispatch, no
// `instanceof`, no cross-module prototype link. The subclass compiled as an
// independent ROOT struct wearing a heritage clause it had no compiled
// relationship to (`class-bodies.ts::collectClassDeclaration`'s two
// "dynamic/unresolved heritage" arms only marked
// `ctx.classDynamicUnresolvedHeritageSet`).
//
// THE FIX: under `--target standalone`/`wasi`, in a module that is a LINK
// CONSUMER, such a class becomes EXTERNREF-BACKED with a RUNTIME parent — the
// same representation the JS-host lane's extern-class-parent path uses. `this`
// IS the object the parent constructor minted: `super(...)` (explicit, or the
// synthesized derived constructor) evaluates the heritage EXPRESSION and hands
// it to the existing dynamic `__native_construct_<N>` driver, whose
// already-correct boundary arm routes a provider-owned class value to the
// provider's `__js2wasm_link_construct` terminal. Inherited reads and method
// calls then work for free: the receiver is a value the PROVIDER minted, so the
// consumer's own ladder misses and the established link `memberGet` /
// `methodCall` terminals answer — the same path a direct `new NS.Base()`
// instance already took.
//
// Host-free: `hostBridge: "off"` and an EMPTY import object, matching the
// #6605/#6641 convention — every value crosses purely in Wasm.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

const PROVIDER = `
  export class Base {
    constructor(a) { this.a = a; }
    get() { return this.a; }
    label() { return "base"; }
    static make() { return new Base(41); }
    static brandOf(v) { return (v instanceof Base) ? "base" : "foreign"; }
  }
  export const NS = { Base: Base };
`;

async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6640-"));
  const packageRoot = join(root, "node_modules", "pkg6640");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "pkg6640", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(
    entry,
    `import { Base, NS } from "pkg6640";\nexport function __probeA() { return typeof Base; }\nexport function __probeB() { return typeof NS; }\n`,
  );
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "pkg6640")!;
  const baseField = artifact.exportBoundaries!.Base!.field;
  const nsField = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${baseField}(): any;\nexport declare function ${nsField}(): any;\n`,
      [consumerEntry]:
        `import { ${baseField}, ${nsField} } from "/__ns_stub";\n` +
        `const Base = ${baseField}();\nconst NS = ${nsField}();\n${consumer}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([
        [baseField, { module: artifact.namespace, field: baseField }],
        [nsField, { module: artifact.namespace, field: nsField }],
      ]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

const CONSUMER = `
  class Sub extends Base { }
  class SubNs extends NS.Base { }
  class SubCtor extends Base {
    constructor() { super(7); }
  }

  // TEETH — every one of these answered wrong on the base tree.
  export function superThreadsField() { return new Sub(5).a; }
  export function superThreadsMethod() { return new Sub(5).get(); }
  export function inheritedMethod() { return new Sub(5).label(); }
  export function explicitSuper() { return new SubCtor().get(); }
  export function propertyAccessHeritage() { return new SubNs(9).get(); }
  export function providerBrandCheck() { return Base.brandOf(new Sub(5)); }

  // CONTROLS — must not move.
  export function localExtends() {
    class LB { constructor(x) { this.x = x; } two() { return this.x * 2; } }
    class LD extends LB { two() { return super.two() + 1; } }
    return new LD(4).two();
  }
  export function directProviderNew() { return new Base(3).get(); }
  export function providerStatic() { return Base.make().get(); }
`;

describe("#6640 — standalone `class S extends <linked-provider class>`", () => {
  it("threads super() through the provider constructor and inherits its methods", async () => {
    const exports = await linkedPair(PROVIDER, CONSUMER);
    const report: Record<string, unknown> = {};
    for (const name of [
      "superThreadsField",
      "superThreadsMethod",
      "inheritedMethod",
      "explicitSuper",
      "propertyAccessHeritage",
      "providerBrandCheck",
      "localExtends",
      "directProviderNew",
      "providerStatic",
    ]) {
      try {
        report[name] = exports[name]!();
      } catch (e) {
        report[name] = `THREW: ${(e as Error).message}`;
      }
    }
    expect(report).toEqual({
      superThreadsField: 5,
      superThreadsMethod: 5,
      inheritedMethod: "base",
      explicitSuper: 7,
      propertyAccessHeritage: 9,
      providerBrandCheck: "base",
      localExtends: 9,
      directProviderNew: 3,
      providerStatic: 41,
    });
  });
});
