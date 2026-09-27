// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6618 / #5383 S31 — `recv.name(args)` where `name` resolves to a CLASS
// constructor (has [[Construct]], no [[Call]]) reached `__apply_closure`'s
// legacy `null` fallback instead of throwing TypeError.
//
// `class-call-without-new.ts` (#4483) already throws for a class called by a
// resolvable identifier (`C()`), and #6420's `wantIsCallableGuard` already
// throws for a class reached through a bare dynamic VALUE call (`const f =
// C; f()`). Neither covers a class reached through a PROPERTY-ACCESS method
// call across a linked standalone provider — `ns.C()` — which is exactly the
// shape `Temporal.PlainDate()` takes once `Temporal` is a linked provider's
// namespace object (measured against the real `@js-temporal/polyfill`
// provider, `built-ins/Temporal/PlainDate/constructor.js`: base — no throw,
// `Temporal.PlainDate(1970,1,2)` silently answers `null`; branch — throws
// TypeError with both `assert.throws` identity checks).
//
// Measured on BOTH trees by file-copy revert of
// `src/codegen/resolved-callee-guard.ts` (2026-09-16), with the linked-pair
// harness below (`runLinkedString`, copied from #6617's scaffold — a
// SINGLE-MODULE `NS.C()` does not reach `__extern_method_call` at all on
// this compiler, so it is not a reduction of this defect; a MULTI-MODULE
// link is the minimal repro):
//   base tree:   linked `NS.C()` → "no-throw" (falls to __apply_closure's null)
//   branch tree: linked `NS.C()` → throws TypeError, instanceof/constructor both true
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

const SINGLE = {
  ...STANDALONE,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/** Compile ONE standalone module, instantiate with an EMPTY import object, and read back a string. */
async function runStandaloneString(prelude: string, expression: string): Promise<string> {
  const source = `${prelude}
    let __s = "";
    export function prepare() { try { __s = "" + (${expression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
    export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compile(source, SINGLE);
  if (!result.success) throw new Error(`compile failed: ${result.errors?.[0]?.message}`);
  const module = await WebAssembly.compile(result.binary as Uint8Array);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

/** Build a provider package + a consumer that links it, and read one string back. */
async function runLinkedString(provider: string, consumerExpression: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "issue-6618-"));
  const packageRoot = join(root, "node_modules", "ns6618");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6618", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6618";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6618")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]:
        `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\nlet __s = "";\n` +
        `export function prepare() { try { __s = "" + (${consumerExpression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n` +
        `export function at(i) { return __s.charCodeAt(i); }\n`,
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
  const exports = instance.exports as unknown as { prepare: () => number; at: (i: number) => number };
  const length = exports.prepare();
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

const PROVIDER = `
  export class C { constructor(y) { this.y = y === undefined ? 0 : y; } m() { return "meth"; } }
  export function fn(x) { return x + 1; }
  export const NS = Object.freeze({ __proto__: null, C: C, fn: fn });`;

describe("#6618 — a class through a property-access method call, across the link", () => {
  it("NS.C() throws a real TypeError (base tree: silently answers null)", async () => {
    const result = await runLinkedString(
      PROVIDER,
      `(function(){ try { NS.C(); return "no-throw"; } catch (e) { return (e instanceof TypeError) + "/" + (e.constructor === TypeError) + "/" + e.message; } })()`,
    );
    expect(result).toBe("true/true/called value is not a function");
  });

  it("a bare dynamic VALUE call of the same linked class still throws (the #6420 arm, unchanged)", async () => {
    const result = await runLinkedString(
      PROVIDER,
      `(function(){ const f = NS.C; try { f(); return "no-throw"; } catch (e) { return (e instanceof TypeError) + "/" + (e.constructor === TypeError); } })()`,
    );
    expect(result).toBe("true/true");
  });

  it("new NS.C(...) still constructs across the link (the fix must not touch [[Construct]])", async () => {
    expect(await runLinkedString(PROVIDER, `new NS.C(5).y`)).toBe("5");
  });

  it("a plain function value through the same linked property-call shape still calls", async () => {
    expect(await runLinkedString(PROVIDER, `NS.fn(41)`)).toBe("42");
  });

  it("a class INSTANCE method, called through the same property-call shape, still calls", async () => {
    expect(await runLinkedString(PROVIDER, `new NS.C(1).m()`)).toBe("meth");
  });

  it("module-local: a class value called through a property access is UNCHANGED by this fix (known residual)", async () => {
    // CONTROL, single module (no link). Measured identical on both trees:
    // `NS.C()` inside ONE module does not reach `__extern_method_call` at all
    // on this compiler (a different, monomorphic property-call lowering
    // claims it first), so it is untouched by this change either way — the
    // scoped defect (#6618) is specifically the wasm→wasm LINK boundary's
    // generic method-call arm, exercised by the linked-pair cases above.
    // Not a target of this slice; recorded so a future fix has a base line.
    const source = `
      class C { constructor(y) { this.y = y; } }
      const NS = { C: C };`;
    const result = await runStandaloneString(
      source,
      `(function(){ try { NS.C(); return "no-throw"; } catch (e) { return (e instanceof TypeError) + "/" + (e.constructor === TypeError); } })()`,
    );
    expect(result).toBe("no-throw");
  });

  it("module-local: an object-literal method still calls (unaffected control)", async () => {
    const source = `const obj = { om() { return "objmeth"; } };`;
    expect(await runStandaloneString(source, `obj.om()`)).toBe("objmeth");
  });
});
