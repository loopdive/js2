// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6622 (#5383 S35) — a compiled class INSTANCE reported `typeof "function"`
// and failed `instanceof`/`isPrototypeOf`, for two INDEPENDENT reasons.
//
// ## Mechanism A — `__reflect_is_constructor`'s bare `ref.test $__ta_ctor`
//
// `reflect-construct-native.ts` (`fillReflectIsConstructor` and its sibling
// `fillNativeReflectTargetClassifier`) each had ONE site that pushed
// `ctx.taCtorTypeIdx` into a candidate list and tested it with a BARE
// `ref.test` — unlike every OTHER `$__ta_ctor` site in this backend, which
// already routes through `taCtorIdentityTestInstrs` (#5383 S2f R11) precisely
// because `$__ta_ctor` (`{kind: i32, brand: i32}`) is the exact same WasmGC
// shape as a field-less compiled class root (`{__tag: i32, __shape_brand:
// i32}`, `class-bodies.ts` #2158/#2009) — the SAME collision #5194 r3 F1 (typeof)
// and #6601/#6620 (own-property reads) already fixed at their own sites.
//
// A bare match here made `__reflect_is_constructor` — the predicate
// `IsConstructor` reads — answer `true` for every INSTANCE of a colliding
// class. Two observable consequences, measured against the REAL standalone
// `@js-temporal/polyfill` provider before this fix: `new (new
// Temporal.Duration(1))()` succeeded where §13.3.5.1 says it must throw, and —
// because the SAME wrongly-set bit feeds `standalone-link-boundary.ts`'s
// `__js2wasm_link_callable_kind` terminal — `typeof <provider instance>`
// answered `"function"` across the wasm↔wasm link instead of `"object"`, the
// standing #5383 residual blocking all 45 `built-ins/Temporal/**
// /subclassing-ignored.js` test262 files (S34's "next blocker", named but not
// chased).
//
// ## Mechanism B — `__isPrototypeOf` never seeds from a class instance's link
//
// `object-runtime-prototype.ts`'s `__isPrototypeOf` walks `candidate.$proto`,
// which only exists on an `$Object`. A compiled class instance is a closed
// `$ClassName` struct with NO `$proto` field, so `C.prototype.isPrototypeOf(new
// C())` through a dynamic (`any`-typed) receiver answered `false` even though
// `Object.getPrototypeOf(new C()) === C.prototype` (#6617/S30) is `true`. The
// fix reuses `__getPrototypeOf` (which already composes the module-local class
// dispatcher AND the link-boundary hop) to seed the walk's first link, mirroring
// the existing `__fnctor_proto_start` seed precedent one function up
// (`fnctorIsPrototypeOfSeed`) rather than adding a third prototype mechanism —
// plan/issues/6617-standalone-linked-class-instance-prototype.md's own R2
// conclusion.
//
// Every fix-witness `it` below is measured FAILING on the file-copy-reverted
// base tree (recorded inline) and PASSING on branch; every control passes on
// both trees unchanged.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };
const SINGLE = { ...STANDALONE, fileName: "/p.ts", allowJs: true, skipSemanticDiagnostics: true };

/**
 * Compile `program` standalone (single module, no link) and read the string
 * `__run()` returned, host-free. `program` is a full program body ending in a
 * top-level `function __run() { ... }` declaration — NOT a bare expression,
 * so class/function DECLARATIONS are legal at the top level.
 */
async function runStandaloneString(program: string): Promise<string> {
  const source = `${program}
    let __s = "";
    export function prepare() { try { __s = "" + (__run()); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
    export function at(i: number) { return __s.charCodeAt(i); }`;
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

type Artifact = { namespace: string; exportBoundaries: Record<string, { field: string }> };

/** A field-less class whose compiled root collides with `$__ta_ctor`, PLUS the
 *  provider's own dynamic-TypedArray-construct pattern — required so
 *  `$__ta_ctor` and `PD`'s struct type land at the SAME type slot WITHIN the
 *  provider's own compile (mirrors #6620's `PROVIDER`). */
const PROVIDER = `
export class PD {
  ident() { return "pd"; }
}
function mkTA(k) { return new k(4); }
var __internalTA = mkTA(Uint8Array);
export const NS = Object.freeze({ __proto__: null, PD: PD });`;

async function buildProvider(): Promise<Artifact> {
  const root = mkdtempSync(join(tmpdir(), "issue-6622-"));
  const packageRoot = join(root, "node_modules", "ns6622");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6622", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), PROVIDER);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6622";\nexport function __probe() { return typeof NS; }\n`);
  const built = (await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never)) as unknown as { success: boolean; errors?: { message: string }[]; linkedModules?: Artifact[] };
  expect(built.success, (built.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find(
    (item) => (item as unknown as { packageName?: string }).packageName === "ns6622",
  );
  expect(artifact).toBeDefined();
  return artifact as Artifact;
}

async function runLinked(artifact: Artifact, body: string): Promise<string> {
  const field = artifact.exportBoundaries.NS!.field;
  const entry = "/__main.js";
  const source = `import { ${field} } from "/__ns_stub";
const NS = ${field}();
let __s = "";
export function prepare() { try { __s = "" + (() => { ${body} })(); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
export function at(i) { return __s.charCodeAt(i); }`;
  const result = (await compileMulti(
    { "/__ns_stub.ts": `export declare function ${field}(): any;\n`, [entry]: source },
    entry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  )) as unknown as { success: boolean; errors?: { message: string }[]; linkedModules?: Artifact[] };
  result.linkedModules = [artifact];
  expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result as never, {});
  const exports = instance.exports as unknown as { prepare(): number; at(i: number): number };
  const len = exports.prepare();
  let out = "";
  for (let i = 0; i < Math.min(len, 400); i++) out += String.fromCharCode(exports.at(i));
  return out;
}

describe("#6622 — mechanism A: __reflect_is_constructor's bare $__ta_ctor ref.test", () => {
  it(
    "typeof <linked provider class instance> answers 'object', not 'function' " +
      "(fix-witness — measured 'function' on the file-copy-reverted base)",
    { timeout: 600_000 },
    async () => {
      const artifact = await buildProvider();
      const out = await runLinked(
        artifact,
        `function idAny(x){return x;} const inst = new NS.PD(); return typeof idAny(inst);`,
      );
      expect(out).toBe("object");
    },
  );

  it("a genuine class construction through the link is unaffected (control)", { timeout: 600_000 }, async () => {
    const artifact = await buildProvider();
    const out = await runLinked(artifact, `return new NS.PD().ident();`);
    expect(out).toBe("pd");
  });

  it(
    "Reflect.construct(fn, [], <field-less class instance>) throws TypeError " +
      "(IsConstructor(newTarget) must be false — fix-witness, module-local, base answered 'no-throw')",
    async () => {
      const source = `
        class C {}
        const T = Int8Array; // registers $__ta_ctor in THIS module
        void T.of(1, 2, 3).length; // .of() is what actually registers $__ta_ctor here
        function idAny(x) { return x; } // force the DYNAMIC IsConstructor(newTarget) path
        function __run() {
          try {
            const nt = idAny(new C());
            Reflect.construct(Object, [], nt);
            return "no-throw";
          } catch (e) {
            return e && e.name ? e.name : String(e);
          }
        }`;
      expect(await runStandaloneString(source)).toBe("TypeError");
    },
  );

  it("a genuine TypedArray constructor is still a valid Reflect.construct newTarget (control)", async () => {
    const source = `
      class C {}
      function idAny(x) { return x; }
      function __run() {
        const nt = idAny(Int8Array);
        const r = Reflect.construct(Object, [], nt);
        return typeof r;
      }`;
    expect(await runStandaloneString(source)).toBe("object");
  });

  it("a class WITH a declared field (not field-less) never collides with $__ta_ctor (control)", async () => {
    const source = `
      class D { constructor(y) { this.y = y; } }
      const T = Int8Array;
      void T.of(1, 2, 3).length; // .of() is what actually registers $__ta_ctor here
      function idAny(x) { return x; }
      function __run() {
        try {
          const nt = idAny(new D(1));
          Reflect.construct(Object, [], nt);
          return "no-throw";
        } catch (e) {
          return e && e.name ? e.name : String(e);
        }
      }`;
    expect(await runStandaloneString(source)).toBe("TypeError");
  });
});

describe("#6622 — mechanism B: __isPrototypeOf never seeds from a class instance's [[Prototype]]", () => {
  // (#6622) `X.prototype.isPrototypeOf(v)` where `X` is a MODULE-LOCAL class
  // resolves through a separate, pre-existing, unrelated static-dispatch path
  // that neither reaches `__isPrototypeOf` NOR this fix on EITHER tree
  // (measured: `C.prototype.isPrototypeOf(new C())` answers `"no"` identically
  // before and after this change, even through an `any` indirection) — a real
  // residual, but not this mechanism's; see plan/issues/6622-*.md. The genuine
  // reduction needs the RECEIVER to be `any`-typed for an unrelated reason,
  // which is exactly what crossing a wasm↔wasm link gives every namespace
  // member for free — the same shape `Object.getPrototypeOf`'s own #6617/S30
  // fix-witness used.
  it(
    "NS.PD.prototype.isPrototypeOf(new NS.PD()) answers true across the link " +
      "(fix-witness — measured false on the file-copy-reverted base)",
    { timeout: 600_000 },
    async () => {
      const artifact = await buildProvider();
      const out = await runLinked(artifact, `return NS.PD.prototype.isPrototypeOf(new NS.PD()) ? "yes" : "no";`);
      expect(out).toBe("yes");
    },
  );

  it("the reverse direction stays false across the link (control)", { timeout: 600_000 }, async () => {
    const artifact = await buildProvider();
    const out = await runLinked(artifact, `return (new NS.PD()).isPrototypeOf(NS.PD.prototype) ? "yes" : "no";`);
    expect(out).toBe("no");
  });

  it("an ordinary $Object prototype pair (no class involved) is unaffected (control)", async () => {
    const source = `
      function idAny(x) { return x; }
      function __run() {
        const a = {};
        const b = Object.create(a);
        return idAny(a).isPrototypeOf(idAny(b)) ? "yes" : "no";
      }`;
    expect(await runStandaloneString(source)).toBe("yes");
  });
});
