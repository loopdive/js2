// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6620 / #5383 S33 — #6617 R1: a dynamic `.prototype` read on a PROVIDER-owned
// class value answered `undefined` instead of the class's prototype object,
// whenever the CONSUMER module also contained ANY dynamic `new <any>(...)`
// construct anywhere (unrelated to the class being read) — blocking all 45
// `built-ins/Temporal/**/subclassing-ignored.js` test262 files.
//
// ROOT CAUSE (reduced 2026-09-16). `__extern_get`'s `$__ta_ctor` receiver arm
// (`ta-dyn-mop.ts`) used a BARE `ref.test $__ta_ctor` to decide "this receiver
// is a TypedArray constructor value" — a purely STRUCTURAL WasmGC question.
// `$__ta_ctor` is `{kind: i32, brand: i32}` (`registry/types.ts`) — exactly
// the compiled shape of a field-less class's root (`{__tag: i32,
// __shape_brand: i32}`, `class-bodies.ts` #2158/#2009).
//
// A field-less PROVIDER class hits this ONLY when the PROVIDER module *also*
// contains its own dynamic-TypedArray-construct pattern (so `$__ta_ctor` gets
// minted, WITHIN THE PROVIDER'S OWN TYPE SPACE, at the exact struct-type slot
// the class's empty root reuses — measured: `PD_new`'s declared return type
// and the provider's own `$__ta_ctor` singleton globals land on the SAME type
// index once the provider carries a `new <ctorParam>(n)` construct of its
// own). `@js-temporal/polyfill` genuinely has such an internal dynamic-TA
// pattern (its JSBI/DataView internals), which is why `Temporal.Duration`
// etc. hit this in production, not just in a hand-built repro.
//
// The CONSUMER side needs its OWN `ctx.moduleUsesDynTaView` arming (ANY
// dynamic `new <any>(...)`, unrelated to the class being read) for the buggy
// `$__ta_ctor` receiver arm to even be INSTALLED into the consumer's own
// `__extern_get` — hence the "no-arming" control below stays correct even
// against the SAME provider.
//
// A SECOND bare `ref.test $__ta_ctor` (`ta-ctor-meta.ts`'s
// `__builtinfn_get_meta` arm, consulted even earlier in `__extern_get`) has
// the identical defect and is NOT fixed by this change — filed as
// R-other-bare-ref-test in #6620. It only intercepts when the colliding
// class's compiler-assigned `__tag` happens to fall inside
// `TA_CTOR_KINDS`' 0..10 range (it then returns a WRONG-BUT-NON-NULL answer,
// e.g. `Int8Array.prototype`, instead of this arm's `undefined` fallback) —
// the synthetic provider below declares 11 filler classes first so the
// tested class's tag is 11 (out of range), isolating the ONE arm this PR
// touches. `Temporal.Duration`'s own real tag is in the 30s (#5194 r3 review
// F1's doc comment: `{35, 0}`), so production traffic was never affected by
// that second site — this is purely a witness-isolation device.
//
// MEASURED on BOTH trees by file-copy revert of `src/codegen/ta-dyn-mop.ts`
// (2026-09-16), same synthetic pair:
//   base tree:   fix-witness answers `undef`   branch: `hasIdent=function ctorName=PD`
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * Link `provider` as an npm package `ns6620`, compile a consumer that
 * evaluates `consumerExpression`, and read the stringified result back
 * host-free (a standalone module's string is a WasmGC array the host can't
 * decode directly — mirrors `tests/issue-6617-class-instance-prototype.test.ts`'s
 * `runLinkedString`).
 */
async function runLinkedString(provider: string, consumerExpression: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "issue-6620-"));
  const packageRoot = join(root, "node_modules", "ns6620");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6620", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6620";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6620")!;
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
 * The provider: `PD`, a field-less class whose compiled root collides with
 * `$__ta_ctor`'s shape, PLUS the provider's own dynamic-TA-construct pattern
 * (`mkTA`) — required so `$__ta_ctor` and `PD`'s struct type land at the SAME
 * type slot within the provider's own compile (see file header). 11 filler
 * classes push `PD`'s `__tag` to 11, outside `TA_CTOR_KINDS`' 0..10 range, so
 * only the ONE arm this PR fixes (`ta-dyn-mop.ts`) is exercised — see the
 * R-other-bare-ref-test note in the file header.
 */
const PROVIDER = `
  class C0 {} class C1 {} class C2 {} class C3 {} class C4 {}
  class C5 {} class C6 {} class C7 {} class C8 {} class C9 {} class C10 {}
  export class PD {
    ident() { return "pd"; }
  }
  function mkTA(k) { return new k(4); }
  var __internalTA = mkTA(Uint8Array);
  var __keepAlive = [C0, C1, C2, C3, C4, C5, C6, C7, C8, C9, C10];
  export const NS = Object.freeze({ __proto__: null, PD: PD });`;

/** `ident(p)` distinguishes null / undefined / a real `PD.prototype` (has `.ident`) / a wrong TA-glue object. */
const IDENT = `function ident(p) {
  if (p === null) return "null";
  if (p === undefined) return "undef";
  return "hasIdent=" + (typeof p.ident) + " ctorName=" + (p.constructor && p.constructor.name);
}`;

describe("#6620 — `$__ta_ctor` bare ref.test collides with a field-less provider class's root shape", () => {
  it(
    "a dynamic `.prototype` read on the provider class answers the REAL prototype, not `undef`, " +
      "when an UNRELATED dynamic `new <any>(...)` elsewhere arms the consumer (base tree: `undef`)",
    async () => {
      // TEETH — mirrors #5383 S32/S33's r1f.js reduction: the dynamic `new`
      // and the `.prototype` read are on two DIFFERENT parameters in two
      // DIFFERENT functions, tied only by module-wide pre-scan arming.
      const out = await runLinkedString(
        PROVIDER,
        `(function(){ ${IDENT} class Local { constructor(y) { this.y = y; } } ` +
          `function dynNew(k) { return new k(1); } var __armed = dynNew(Local); ` +
          `return ident(NS.PD.prototype); })()`,
      );
      expect(out).toBe("hasIdent=function ctorName=PD");
    },
  );

  it("the SAME unrelated arming does not corrupt an ORDINARY named member read on the same receiver (control)", async () => {
    // `.name`, not `.prototype.ident` — this must NOT chain through the
    // broken `.prototype` read, or it would fail on base for the SAME
    // reason as the fix-witness and not be a control at all.
    const out = await runLinkedString(
      PROVIDER,
      `(function(){ class Local { constructor(y) { this.y = y; } } ` +
        `function dynNew(k) { return new k(1); } var __armed = dynNew(Local); ` +
        `return typeof NS.PD.name + ":" + NS.PD.name; })()`,
    );
    expect(out).toBe("string:PD");
  });

  it("a lone `.prototype` read with NO dynamic `new` anywhere stays correct (control, unchanged both trees)", async () => {
    const out = await runLinkedString(PROVIDER, `(function(){ ${IDENT} return ident(NS.PD.prototype); })()`);
    expect(out).toBe("hasIdent=function ctorName=PD");
  });

  it(
    "a GENUINE TypedArray constructor's `.prototype`/`.BYTES_PER_ELEMENT` still answer correctly " +
      "(control — the fix narrows the arm's receiver test, it must not disable it)",
    async () => {
      const out = await runLinkedString(
        PROVIDER,
        `(function(){ var ctors = [Uint8Array, Int32Array]; ` +
          `function dynBpe(c) { return c.BYTES_PER_ELEMENT; } ` +
          `function dynProto(c) { return typeof c.prototype; } ` +
          `return "bpe=" + dynBpe(ctors[1]) + " proto=" + dynProto(ctors[0]); })()`,
      );
      expect(out).toBe("bpe=4 proto=object");
    },
  );
});
