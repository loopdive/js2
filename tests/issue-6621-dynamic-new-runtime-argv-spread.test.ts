// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6621 / #5383 S34 — R-construct: `new construct(...constructArgs)` on a
// linked class VALUE reached through a PARAMETER answered null (or a bogus
// field-less `Object.create(proto)` placeholder) whenever `constructArgs`
// (or any spread source feeding the construct) has a RUNTIME-only length —
// a parameter, not a literal or a statically-resolvable local. That is
// exactly test262's `checkSubclassConstructorNotObject` shape
// (`temporalHelpers.js`): `new construct(...constructArgs)` where both
// `construct` and `constructArgs` are parameters, forwarded through TWO
// layers of `...args` rest/spread. All 45
// `built-ins/Temporal/**/subclassing-ignored.js` files hit this on their
// FIRST assertion, pinned as S30's `p2` probe and #6620's "R-construct"
// residual.
//
// ROOT CAUSE (reduced 2026-09-16, `--target standalone`). Two arms both had
// to decline for this to reach the null/bogus terminal:
//
//  1. `tryCompileNativeConstructFromValue` (`new-super.ts`) admits a spread
//     call site, but only after `flattenCallArgs`/`resolveStaticSpreadArgs`
//     fail to resolve a FIXED arity — for a genuinely runtime-length spread
//     (the parameter shape above) both always fail, and the function
//     unconditionally declined (`args.some(isSpreadElement) => return
//     undefined`), for EVERY admission reason including the already-working
//     member-access dynamic-ctor arm (`dynamicMemberCtorValue`).
//  2. The only other standalone dynamic-`new` fallback,
//     `emitDynamicNewFallback`, ALSO declines whenever the callee is not a
//     LOCAL class (`ctx.classObjectGlobals` — module-local structs only,
//     never a linked-provider class), and even when the callee resolves as
//     an identifier it never runs at all for a MEMBER-ACCESS callee in
//     standalone (`dynMemberCallee` requires `!noJsHost(ctx)`).
//
// So a construct through a foreign/linked class value, fed a runtime-length
// spread, had NO lowering at all — the pre-existing `__new_${ctorName}`
// unknown-ctor import fallback (registered for genuine host builtins like
// `Test262Error`) has no entry for the class's name, so the site fell to a
// bare `ref.null.extern`.
//
// THE FIX (`native-construct.ts` + `expressions/new-super.ts`). A new,
// arity-GENERIC driver (`__native_construct_argv`, one per module, not
// per-arity) reuses the SAME `(callee, argsVec, argc) -> externref` shape
// the existing `__class_construct_dispatch` / `__js2wasm_link_construct`
// terminals already accept (built by the fixed-arity drivers' own
// `buildArgsVec()`) — those two terminals were ALREADY arity-generic; only
// the CALL SITE lacked a way to build a runtime-length argv and reach them.
// `buildRuntimeConstructArgvVec` (`new-super.ts`) builds that argv at the
// call site: a positional arg pushes directly, a `SpreadElement`'s source is
// copied element-by-element via the generic `__extern_length`/
// `__extern_get_idx` reader pair (the same protocol `Object.groupBy`'s
// native helper uses for an arbitrary array-like source), so an untyped JS
// array PARAMETER (test262's `constructArgs`) works, not only a
// compile-time-typed vec.
//
// Standalone/WASI only (`noJsHost(ctx)`); the JS-host lane is unaffected —
// it already constructs a genuinely-dynamic spread through
// `__construct_closure`, which accepts an ordinary JS array built from any
// spread.
//
// MEASURED (2026-09-16), a synthetic linked pair (`export class PD { … }`),
// by file-copy revert of `native-construct.ts` + `expressions/new-super.ts`:
//   base:   fixWitness "null/-/-"   restSpread "null/-/-"
//   branch: fixWitness "object/7/PD7"   restSpread "object/8/PD8"
// All three controls (no spread, member-direct, literal-array spread)
// answer identically on both trees — this fix only reaches a genuinely
// runtime-length spread into a dynamic ctor value.
//
// Corpus-wide (four-family 120-row sample, real polyfill linked, see #6621
// "S34 findings" in #5383): base 427, branch 430 (+3), 0 pass→fail. The
// 45-file `subclassing-ignored.js` family's headline does NOT move —
// verified directly (debug throw injected into a copy of the real harness,
// `.tmp/s34/assembled.js`): `new construct(...constructArgs)` now returns a
// REAL, field-populated instance with the CORRECT prototype link
// (`Object.getPrototypeOf(instance) === construct.prototype` flips
// false→true, `.years` flips `undefined`→a real value) — this fix is
// genuinely reached and correct — but the family's next assertion
// (`Object.getPrototypeOf(instance[method](...methodArgs))`) still answers
// null through a SEPARATE, PRE-EXISTING mechanism (a dynamically-constructed
// class value's `typeof` misreports "function" and `instanceof` answers
// `false` even for the ALREADY-WORKING no-spread/member-direct construct
// paths on the UNFIXED base tree) — matching S20 §4's already-documented
// "per-name ladder, no runtime class test" residual, not a new defect this
// slice introduces or is scoped to fix.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * Link `provider` as an npm package `ns6621`, compile a consumer that
 * evaluates `consumerExpression`, and read the stringified result back
 * host-free — mirrors `tests/issue-6620-ta-ctor-brand-prototype-collision.test.ts`'s
 * `runLinkedString`.
 */
async function runLinkedString(provider: string, consumerExpression: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "issue-6621-"));
  const packageRoot = join(root, "node_modules", "ns6621");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6621", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6621";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6621")!;
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

/** A field-bearing linked class, small on purpose — the defect is about the
 * construct MECHANISM, not any Temporal-specific shape. */
const PROVIDER = `
export class PD {
  constructor(y) { this.y = y; }
  tagIt() { return "PD" + this.y; }
}
export const NS = Object.freeze({ __proto__: null, PD: PD });`;

const TAG = `function tag(v) { return v === null ? "null" : v === undefined ? "undef" : typeof v; }`;

/** `tag(inst)/inst.y/inst.tagIt()` — "-" for the two latter when `inst` is
 * null/undefined or lacks the field/method (the pre-fix bogus placeholder). */
const REPORT = (name: string): string =>
  `tag(${name}) + "/" + (${name} && ${name}.y !== undefined ? ${name}.y : "-") + "/" + (${name} && ${name}.tagIt ? ${name}.tagIt() : "-")`;

describe("#6621 — runtime-length spread into a linked/foreign dynamic construct answered null", () => {
  it(
    "fix-witness: `new construct(...constructArgs)` through TWO parameters (the exact test262 " +
      "`checkSubclassConstructorNotObject` shape) constructs a real, field-populated instance " +
      "(base: `null/-/-`)",
    async () => {
      const out = await runLinkedString(
        PROVIDER,
        `(function(){ ${TAG} function dynNew(C, args) { return new C(...args); } ` +
          `var inst = dynNew(NS.PD, [7]); return ${REPORT("inst")}; })()`,
      );
      expect(out).toBe("object/7/PD7");
    },
  );

  it(
    "fix-witness twin: a rest-param spread (`function dynNew(C, ...a) { return new C(...a); }`) " +
      "(base: `null/-/-`)",
    async () => {
      const out = await runLinkedString(
        PROVIDER,
        `(function(){ ${TAG} function dynNew(C, ...a) { return new C(...a); } ` +
          `var inst = dynNew(NS.PD, 8); return ${REPORT("inst")}; })()`,
      );
      expect(out).toBe("object/8/PD8");
    },
  );

  it("control: the SAME callee with a fixed (non-spread) argument (unaffected, unchanged both trees)", async () => {
    const out = await runLinkedString(
      PROVIDER,
      `(function(){ ${TAG} function dynNew(C, y) { return new C(y); } ` +
        `var inst = dynNew(NS.PD, 9); return ${REPORT("inst")}; })()`,
    );
    expect(out).toBe("object/9/PD9");
  });

  it("control: the direct member-access spelling with no spread (unaffected, unchanged both trees)", async () => {
    const out = await runLinkedString(
      PROVIDER,
      `(function(){ ${TAG} var inst = new NS.PD(10); return ${REPORT("inst")}; })()`,
    );
    expect(out).toBe("object/10/PD10");
  });

  it(
    "control: a STATICALLY-flattenable literal-array spread (`new NS.PD(...[11])`) — already " +
      "handled by `flattenCallArgs`, must stay on its existing path (unchanged both trees)",
    async () => {
      const out = await runLinkedString(
        PROVIDER,
        `(function(){ ${TAG} var inst = new NS.PD(...[11]); return ${REPORT("inst")}; })()`,
      );
      expect(out).toBe("object/11/PD11");
    },
  );
});
