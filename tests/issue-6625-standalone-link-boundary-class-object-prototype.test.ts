// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6625 / #5383 S38 — `Object.getPrototypeOf(<provider-owned CLASS OBJECT>)`
// answered `null` instead of `%Function.prototype%` across the standalone
// wasm<->wasm link boundary — the residual #6609/S22 explicitly left open for
// a class VALUE (as opposed to a function value, which S22 already fixed).
//
// ROOT CAUSE. `Object.getPrototypeOf` on an `any`-typed argument that reaches
// no static arm falls to `tryEmitDynamicCallableGetPrototypeOf`
// (`object-get-prototype-of.ts`, #6609), gated on `__is_callable` — which
// DELIBERATELY excludes class objects (a class has [[Construct]] but no
// [[Call]]; see that function's own docstring). So a class value fell all the
// way to the generic `__getPrototypeOf`, whose `$proto` walk only knows
// `$Object` receivers — a compiled class-object struct is not one, and across
// a link the consumer's own class-instance dispatcher
// (`STANDALONE_CLASS_INSTANCE_PROTO`) explicitly DECLINES a class-object
// identity match (it answers only for INSTANCES) — so the walk answered
// `null` throughout.
//
// Reduced 2026-09-17, single module first (no link): `Object.getPrototypeOf`
// on a class identifier — both direct and through an `any`-typed
// indirection — already answered `false` against `Function.prototype` on
// base; the `any`-indirection case is the one this fix reduces (the direct
// static-identifier case is a documented, unreduced residual — see the issue
// file). The synthetic LINKED pair below reproduces the corpus shape exactly:
// `NS.PD` (a provider-owned class object) answers `false` against
// `Function.prototype` on base and `true` on the fix.
//
// THE FIX. A new predicate, `__is_class_object` (an IDENTITY ladder — ref.eq
// against every class-object singleton, `typeof-natives-finalize.ts`'s
// `classObjectIdentityArms`, reused verbatim — never a `ref.test`, because a
// class object and its own instances share one struct type AND `__tag`,
// #3976), ORed into `tryEmitDynamicCallableGetPrototypeOf`'s existing runtime
// dispatch alongside `__is_callable`. Across a linked provider the predicate
// asks the owner for a BOOLEAN only (`standalone-link-boundary.ts`'s new
// `__js2wasm_link_is_class_object` terminal) — the VALUE this arm answers is
// always `Function.prototype` compiled on the CALLER's own side (S22's rule),
// so its identity matches the caller's own later read of it. BOTH the local
// and the boundary identity ladder are restricted to BASE classes (no
// `extends`): a derived class's [[Prototype]] is its PARENT, not
// `Function.prototype`, and answering the wrong constant for one would be a
// NEW incorrect answer, not merely an unreduced one (verified: on base,
// `Object.getPrototypeOf(<subclass>) === Function.prototype` is `false`,
// which a naive class-object-only predicate flips to a WRONG `true`; the
// parent-map filter keeps it `false`, matching base, and the parent-aware
// correct answer is a documented residual).
//
// MEASURED on BOTH trees by file-copy revert of the five changed files
// (2026-09-17): base answers `false` for the class-object-through-the-link
// probe; the fix answers `true`. Every control (function value, instance,
// subclass, plain object, `isExtensible`) is UNCHANGED on both trees.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * Link `provider` as an npm package `ns6625`, compile a consumer that
 * evaluates `consumerExpression`, and read the stringified result back
 * host-free — mirrors `tests/issue-6624-standalone-link-boundary-isextensible.test.ts`'s
 * `runLinkedString`.
 */
async function runLinkedString(provider: string, consumerExpression: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "issue-6625-"));
  const packageRoot = join(root, "node_modules", "ns6625");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6625", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6625";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6625")!;
  const field = (artifact as { exportBoundaries: { NS: { field: string } } }).exportBoundaries.NS.field;
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
      link: [(artifact as { namespace: string }).namespace],
      linkedPackageBindings: new Map([[field, { module: (artifact as { namespace: string }).namespace, field }]]),
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

/**
 * A base class (`PD`), a subclass (`Sub extends PD`), and an instance method
 * (`compare`), exported through a frozen namespace — the exact shape test262's
 * `built-ins/Temporal` (any class) `builtin.js` rows read through `Temporal`'s
 * class members.
 */
const PROVIDER = `
  export class PD {
    static compare(a, b) { return 0; }
    m() { return 1; }
  }
  export class Sub extends PD {}
  export const NS = Object.freeze({ __proto__: null, PD: PD, Sub: Sub });`;

describe("#6625 — `Object.getPrototypeOf(<class object>)` across the standalone wasm<->wasm link boundary", () => {
  it("a linked provider CLASS OBJECT answers `Function.prototype` (base tree: `false`)", async () => {
    const out = await runLinkedString(PROVIDER, "Object.getPrototypeOf(NS.PD) === Function.prototype");
    expect(out).toBe("true");
  });

  it("a linked provider FUNCTION VALUE is UNCHANGED (control — #6609/S22's own fix, must stay working)", async () => {
    const out = await runLinkedString(PROVIDER, "Object.getPrototypeOf(NS.PD.compare) === Function.prototype");
    expect(out).toBe("true");
  });

  it(
    "a linked provider INSTANCE is UNCHANGED (control — #6617/S30's own fix, must stay working, " +
      "and must NOT start answering Function.prototype)",
    async () => {
      const isInstanceProto = await runLinkedString(PROVIDER, "Object.getPrototypeOf(new NS.PD()) === NS.PD.prototype");
      expect(isInstanceProto).toBe("true");
      const isFnProto = await runLinkedString(PROVIDER, "Object.getPrototypeOf(new NS.PD()) === Function.prototype");
      expect(isFnProto).toBe("false");
    },
  );

  it(
    "a linked provider SUBCLASS is UNCHANGED (control — documented residual: `extends` is not reduced " +
      "here, and this fix must not introduce a NEW wrong `Function.prototype` answer for it)",
    async () => {
      const out = await runLinkedString(PROVIDER, "Object.getPrototypeOf(NS.Sub) === Function.prototype");
      expect(out).toBe("false");
    },
  );

  it("`Object.isExtensible` on the same class object is UNCHANGED (control — #6624/S37)", async () => {
    const out = await runLinkedString(PROVIDER, "Object.isExtensible(NS.PD)");
    expect(out).toBe("true");
  });

  it("a LOCAL (non-linked) plain object's getPrototypeOf is UNCHANGED (control)", async () => {
    const out = await runLinkedString(PROVIDER, "Object.getPrototypeOf({}) === Object.prototype");
    expect(out).toBe("true");
  });

  it(
    "a LOCAL (non-linked) class object read through an `any`-typed indirection is UNCHANGED vs the " +
      "fix's own behavior for the SAME shape (control for the mechanism, not a base/branch diff — " +
      "single-module class objects already reach this arm; see the issue file for what stays a residual)",
    async () => {
      const out = await runLinkedString(
        PROVIDER,
        `(function(){ class Local { m() { return 1; } } ` +
          `function identity(x) { return x; } var D = identity(Local); ` +
          `return Object.getPrototypeOf(D) === Function.prototype; })()`,
      );
      expect(out).toBe("true");
    },
  );
});
