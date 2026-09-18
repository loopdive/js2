// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6624 / #5383 S37 — `Object.isExtensible(<provider-owned value>)` answered
// `false` for a value crossing the standalone wasm<->wasm link boundary,
// including the common `Temporal.PlainDate`-shaped case: a linked provider's
// CLASS OBJECT (the constructor value itself, not an instance).
//
// ROOT CAUSE. `Object.isExtensible` on an `any`-typed argument compiles to
// the general (non-`_obj`) `__object_isExtensible` native
// (`object-integrity-carrier.ts`), which decides object-ness from the
// CARRIER: `registerIntegrityBagResolver`'s `__integrity_bag` recognises only
// four carrier kinds — vec / closure / error / #4194 instance-expando — via
// `ref.test` chains built from the CONSUMER's own registered WasmGC types
// (`collectClosureBaseWrapperTypeIdxs` etc). A value the PROVIDER minted
// (its class-object struct, or an instance of one of its classes) is a
// CLOSED struct in the provider's own type space and, absent a coincidental
// structural match with something the consumer ALSO declares, is in none of
// the consumer's four ladders — so the carrier-bag lookup misses and the
// native falls to its non-object terminal (`0` / `false`), which is wrong
// for a genuinely extensible provider value.
//
// Reduced 2026-09-17 in three steps, per the S37 brief's required order:
//  1. single module, no link (`class C {}`, `Object.isExtensible(C)`) — does
//     NOT reproduce; the oracle statically proves `C` callable and
//     `provenJsObject` routes to the `_obj` variant (terminal `true`).
//  2. single module, no link, `any`-typed indirection (`const D: any =
//     identity(C)`) — still does NOT reproduce; the CONSUMER'S OWN class is
//     in its OWN `collectClosureBaseWrapperTypeIdxs` list, so the carrier
//     bag recognises it regardless of static typing.
//  3. synthetic linked pair (below) — reproduces cleanly: `NS.PD` (a
//     provider-owned class object) and `new NS.PD()` (a provider-owned
//     instance) both answer `false` on base.
//  4. real `@js-temporal/polyfill`, `--target standalone`, linked, fresh
//     cache — `built-ins/Temporal/*/builtin.js`'s first assertion
//     (`Object.isExtensible(Temporal.PlainDate)`, `true` expected) fails on
//     base with exactly this symptom, corpus-wide across all 9 Temporal
//     top-level namespaces/classes present in that 129-file family (measured
//     via `.tmp/s37/builtinrun.mts`, not part of this vitest suite per the
//     "never compile the real polyfill inside vitest" rule).
//
// THE FIX. A new wasm<->wasm link-boundary terminal,
// `__js2wasm_link_is_extensible` (`standalone-link-boundary.ts`, same shape
// as #6617's `getPrototypeOf` terminal): the PROVIDER exports a thin forward
// to its OWN `__object_isExtensible` (already correct FOR THE PROVIDER,
// since the value in question is native to the provider's own carrier
// ladders); the CONSUMER's `__object_isExtensible` consults this terminal,
// via the new `peerFallbackIdx` parameter threaded through
// `buildIntegrityPredicate`, in place of the bare `terminalResult` constant
// on a carrier-bag miss. Deliberately `isExtensible`-only: `isFrozen`/
// `isSealed` have no reported defect and grow no new terminal.
//
// MEASURED on BOTH trees by file-copy revert of the four changed files
// (2026-09-17): base answers `false` for both the class-object and the
// instance probe; branch answers `true` for both. A linked FUNCTION value
// (`NS.PD.compare`) and every local (non-linked) probe are UNCHANGED on both
// trees — genuine controls, not derived assertions of the same bug.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * Link `provider` as an npm package `ns6624`, compile a consumer that
 * evaluates `consumerExpression`, and read the stringified result back
 * host-free — mirrors `tests/issue-6620-ta-ctor-brand-prototype-collision.test.ts`'s
 * `runLinkedString`.
 */
async function runLinkedString(provider: string, consumerExpression: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "issue-6624-"));
  const packageRoot = join(root, "node_modules", "ns6624");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6624", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6624";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6624")!;
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

/** A class object (`PD`) and an instance method (`compare`), exported through a frozen namespace. */
const PROVIDER = `
  export class PD {
    static compare(a, b) { return 0; }
    m() { return 1; }
  }
  export const NS = Object.freeze({ __proto__: null, PD: PD });`;

describe("#6624 — `Object.isExtensible` across the standalone wasm<->wasm link boundary", () => {
  it("a linked provider CLASS OBJECT answers `true`, not `false` (base tree: `false`)", async () => {
    const out = await runLinkedString(PROVIDER, "Object.isExtensible(NS.PD)");
    expect(out).toBe("true");
  });

  it("a linked provider INSTANCE answers `true`, not `false` (base tree: `false`; same terminal, same fix)", async () => {
    const out = await runLinkedString(PROVIDER, "Object.isExtensible(new NS.PD())");
    expect(out).toBe("true");
  });

  it(
    "a linked provider FUNCTION VALUE is UNCHANGED (control — a separate, pre-existing gap this " +
      "issue does not touch)",
    async () => {
      const out = await runLinkedString(PROVIDER, "Object.isExtensible(NS.PD.compare)");
      expect(out).toBe("false");
    },
  );

  it("a LOCAL (non-linked) plain object literal is UNCHANGED (control)", async () => {
    const out = await runLinkedString(PROVIDER, "Object.isExtensible({})");
    expect(out).toBe("true");
  });

  it(
    "a LOCAL (non-linked) class object read through an `any`-typed indirection is UNCHANGED " +
      "(control — the consumer's OWN class is in its OWN carrier ladder regardless of static typing)",
    async () => {
      const out = await runLinkedString(
        PROVIDER,
        `(function(){ class Local { m() { return 1; } } ` +
          `function identity(x) { return x; } var D = identity(Local); ` +
          `return Object.isExtensible(D); })()`,
      );
      expect(out).toBe("true");
    },
  );
});
