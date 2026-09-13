// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5406 S6 — `Object.prototype.toString` over a value that crossed a standalone
// `link:` boundary, and the error-identity half of the same issue.
//
// WHY THIS REDUCTION EXISTS. #5406 was filed from a run with the compiled
// `@js-temporal/polyfill` linked, where 352 of 360 rows reported
// `Object.prototype.toString is not yet implemented in --target standalone`.
// The provider is a 3.3 MB compile, so it is not the regression test; this is.
// Both halves reduce to a two-module link project with a hand-written provider,
// host-free (`hostBridge: "off"`, instantiated with an EMPTY import object).
//
// PART A (fixed here). The consumer's §20.1.3.6 classifier is a chain of WasmGC
// type tests, and a type test only sees the types THIS module declared. The
// vec/string families are in the canonical rec group; `$Object` and every
// nominal class struct are not. So, measured on the base tree:
//
//   Object.prototype.toString.call(<the provider's [1,2]>)   → "[object Array]"
//   Object.prototype.toString.call(<the provider's {a:1}>)   → THREW
//   Object.prototype.toString.call(<the consumer's {a:1}>)   → "[object Object]"
//
// i.e. the refusal is a property of the LINK BOUNDARY, not of
// `Object.prototype`, and the reported message misdescribes it. The fix is the
// same miss-path shape as `__js2wasm_link_member_get` (#5383 S2d): the provider
// publishes `__js2wasm_link_to_string_tag` and the consumer asks it only after
// its own chain has missed.
//
// PART B (already correct — asserted so it cannot silently regress). #5406's
// problem statement reported that a provider-thrown error is not an instance of
// the consumer's error constructor. Re-measured here: it IS. #5383 S2m made the
// graph share ONE exception tag, and with that the thrown error crosses with
// `instanceof`, `constructor` identity, `.name` and `.message` all correct. The
// original reading came from probing `Temporal.PlainDate.from("not-a-date")`,
// which on this compiler throws a **TypeError** ("Unsupported dynamic regular
// expression pattern" — a RegExp gap inside the provider, #5408) rather than
// the RangeError the probe expected. `instanceof RangeError === false` was
// therefore the RIGHT answer to the wrong question.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * Compile `provider` as a linked npm package and `consumer` as the standalone
 * entry that links it, then instantiate the pair with an EMPTY import object.
 * `NS` is the provider's frozen export record, bound in the consumer's scope.
 */
async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-5406-"));
  const packageRoot = join(root, "node_modules", "ns5406");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns5406", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns5406";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((entry) => entry.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((entry) => entry.packageName === "ns5406")!;
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
  expect(result.success, result.errors.map((entry) => entry.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

// Every probe answers a NUMBER: a standalone module's string is a WasmGC array
// the host cannot decode, so a string-returning export reads as `undefined` and
// would assert nothing. The comparison against the expected tag therefore
// happens INSIDE the module.
const PROVIDER = `
  class Box { constructor(v) { this.v = v; } }
  export const NS = Object.freeze({
    __proto__: null,
    ok() { return 7; },
    mk() { return new Box(5); },
    mkPlain() { return { a: 1 }; },
    mkArr() { return [1, 2]; },
    mkErr() { return new RangeError("x"); },
    mkDate() { return new Date(0); },
    mkMap() { return new Map(); },
    mkWrapper() { return new Number(5); },
    boom() { throw new RangeError("x"); },
    boomType() { throw new TypeError("t"); },
    boomPlain() { throw new Error("e"); },
  });`;

describe("#5406 a value that crossed a standalone link boundary", () => {
  it(
    "answers Object.prototype.toString, and keeps the loud refusal for exotics it cannot tag",
    { timeout: 600_000 },
    async () => {
      const ex = await linkedPair(
        PROVIDER,
        `
        function opaque(v) { return v; }
        // 0 = threw · 1 = the expected tag · 2 = some other string
        function eq(v, want) { let s; try { s = Object.prototype.toString.call(v); } catch (e) { return 0; }
          return s === want ? 1 : 2; }
        export function ok() { return NS.ok(); }
        export function provClass() { return eq(NS.mk(), "[object Object]"); }
        export function provPlain() { return eq(NS.mkPlain(), "[object Object]"); }
        export function provError() { return eq(NS.mkErr(), "[object Error]"); }
        export function provArray() { return eq(NS.mkArr(), "[object Array]"); }
        export function provWrapper() { return eq(NS.mkWrapper(), "[object Number]"); }
        export function ownClass() { return eq(opaque({ a: 1, b: 2 }), "[object Object]"); }
        export function ownArray() { return eq(opaque([1, 2]), "[object Array]"); }
        export function ownNull() { return eq(opaque(null), "[object Null]"); }
        export function ownUndefined() { return eq(opaque(undefined), "[object Undefined]"); }
        // A carrier whose §20.1.3.6 tag is NOT the step-13 default must keep
        // today's loud refusal rather than be defaulted to [object Object].
        export function provDateStillRefuses() { let s; try { s = Object.prototype.toString.call(NS.mkDate()); }
          catch (e) { return 0; } return s === "[object Object]" ? 9 : 2; }
        export function provMapStillRefuses() { let s; try { s = Object.prototype.toString.call(NS.mkMap()); }
          catch (e) { return 0; } return s === "[object Object]" ? 9 : 2; }
      `,
      );
      // Base tree: provClass / provPlain / provError all 0 (threw) — the
      // `Object.prototype.toString is not yet implemented` refusal.
      expect({
        ok: ex.ok(),
        provClass: ex.provClass(),
        provPlain: ex.provPlain(),
        provError: ex.provError(),
        provArray: ex.provArray(),
        provWrapper: ex.provWrapper(),
        ownClass: ex.ownClass(),
        ownArray: ex.ownArray(),
        ownNull: ex.ownNull(),
        ownUndefined: ex.ownUndefined(),
        provDateStillRefuses: ex.provDateStillRefuses(),
        provMapStillRefuses: ex.provMapStillRefuses(),
      }).toEqual({
        ok: 7,
        provClass: 1,
        provPlain: 1,
        provError: 1,
        provArray: 1,
        provWrapper: 1,
        ownClass: 1,
        ownArray: 1,
        ownNull: 1,
        ownUndefined: 1,
        // 0 = still refuses. A `9` here would mean a loud refusal had been
        // converted into a silent mis-tag, which is the failure this arm's
        // decline list exists to prevent.
        provDateStillRefuses: 0,
        provMapStillRefuses: 0,
      });
    },
  );

  it(
    "carries a provider-thrown error's CLASS, constructor identity, name and message",
    { timeout: 600_000 },
    async () => {
      const ex = await linkedPair(
        PROVIDER,
        `
      export function ok() { return NS.ok(); }
      export function isRangeError() { try { NS.boom(); return 0; }
        catch (e) { return (e instanceof RangeError) ? 1 : (e instanceof Error) ? 2 : 3; } }
      export function ctorIdentity() { try { NS.boom(); return 0; }
        catch (e) { return e.constructor === RangeError ? 1 : e.constructor === undefined ? 2 : 3; } }
      export function errName() { try { NS.boom(); return 0; }
        catch (e) { const n = e.name; return n === undefined ? 2 : n === "RangeError" ? 1 : 3; } }
      export function errMessage() { try { NS.boom(); return 0; }
        catch (e) { const m = e.message; return m === undefined ? 2 : m === "x" ? 1 : 3; } }
      export function isTypeError() { try { NS.boomType(); return 0; }
        catch (e) { return (e instanceof TypeError) ? 1 : (e instanceof Error) ? 2 : 3; } }
      export function plainIsNotRange() { try { NS.boomPlain(); return 0; }
        catch (e) { return (e instanceof RangeError) ? 9 : (e instanceof Error) ? 1 : 3; } }
      export function stringOfError() { try { NS.boom(); return 0; }
        catch (e) { try { return typeof String(e) === "string" ? 1 : 2; } catch (x) { return 3; } }  }
    `,
      );
      expect({
        ok: ex.ok(),
        isRangeError: ex.isRangeError(),
        ctorIdentity: ex.ctorIdentity(),
        errName: ex.errName(),
        errMessage: ex.errMessage(),
        isTypeError: ex.isTypeError(),
        plainIsNotRange: ex.plainIsNotRange(),
        stringOfError: ex.stringOfError(),
      }).toEqual({
        ok: 7,
        isRangeError: 1,
        ctorIdentity: 1,
        errName: 1,
        errMessage: 1,
        isTypeError: 1,
        plainIsNotRange: 1,
        stringOfError: 1,
      });
    },
  );

  // NOT fixed here, and deliberately not conflated with the crossing above.
  // `e.constructor.name` reads `undefined` in a SINGLE standalone module with no
  // link at all, and the bare-value spelling reads the TypeScript INTERFACE name:
  // measured `.tmp/s6-ctorname{,2,3}-base.out` — `RangeError.name` (the #2501
  // static fold) answers "RangeError", `const C = RangeError; C.name` answers
  // **"RangeErrorConstructor"**, and any dynamic read through an `any` answers
  // `undefined`. Upstream `assert.throws` compares
  // `thrown.constructor !== expectedErrorConstructor` — identity, which holds —
  // and only formats `.name` into the FAILURE message, so this costs no test262
  // row today.
  it.todo("`e.constructor.name` answers the spec name in a single standalone module (#5406 residual)");
});
