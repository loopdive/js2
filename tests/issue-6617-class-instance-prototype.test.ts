// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6617 (#5383 S30) — `Object.getPrototypeOf` of a compiled class INSTANCE
// reached through a value the checker cannot narrow, in one module and across
// the standalone link.
//
// WHY THIS REDUCTION EXISTS. test262's 45
// `built-ins/Temporal/**/subclassing-ignored.js` files assert
//
//     assert.sameValue(Object.getPrototypeOf(result), construct.prototype);
//
// where `result` was minted by a linked provider class. Under
// `--target standalone` the left-hand side was `null`: the generic native
// `__getPrototypeOf` walks `$Object.$proto`, and a compiled class instance is a
// closed `$ClassName` struct with no such field — so every arm missed, in one
// module as much as across the link. The JS-host lane has answered this since
// #5347 (`__class_instance_proto`), which explicitly declines this lane.
//
// THE MECHANISM. `__std_class_instance_proto` is that dispatcher for the native
// lane: a `ref.test` + `__tag` + `ref.eq` cascade over the module's own
// classes, most-derived first, declining the class-OBJECT singleton and
// materialising the prototype through `__class_proto_build_<C>`; prepended as
// an arm of `__getPrototypeOf`. Across the link the OWNER has to answer,
// because the class link is a `__tag` fact over a struct the consumer has no
// type for — hence the `__js2wasm_link_get_prototype_of` boundary terminal,
// consumed by the same miss arm the host lane's import already used.
//
// EVERY EXPECTATION BELOW WAS MEASURED ON BOTH TREES by file-copy revert of the
// four touched files to `HEAD~1` (`.tmp/s30/witness-{d,e}-{base,branch}.txt`).
// The base answer is recorded inline on each `it`; the five control cases
// answer identically on both trees and say so.
//
// Host-free: `hostBridge: "off"` plus an EMPTY import object, so a leaked host
// import fails the test instead of being papered over. The linked probe answers
// through a string-readback channel, one char code at a time — a standalone
// module's string is a WasmGC array the host cannot decode.
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

/**
 * Compile `prelude` + `expression` standalone, instantiate with an EMPTY import
 * object, and read back the string the module built.
 *
 * ONE MODULE PER CASE is deliberate, not tidiness: module CONTENT changes
 * answers on this lane (#6616 R3, and re-measured here — the same dynamic
 * `.prototype` read answers `undefined` alone and an object when an unrelated
 * member read shares the module).
 */
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
  const root = mkdtempSync(join(tmpdir(), "issue-6617-"));
  const packageRoot = join(root, "node_modules", "ns6617");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6617", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6617";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6617")!;
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

/**
 * `dynv(k)` is the narrowing barrier: the checker types it as a union, so no
 * static getPrototypeOf fold can claim the argument and the call reaches the
 * native helper — which is the whole point of the reduction.
 */
const CLASSES = `
  function mark(v) { if (v === undefined) return "undef"; if (v === null) return "null"; return "val"; }
  class C { constructor(y) { this.y = y === undefined ? 0 : y; } ident() { return "c"; } }
  class D extends C { d() { return "d"; } }
  class E { constructor(w) { this.w = w === undefined ? 0 : w; } }
  const NS = { C: C, D: D, E: E };
  function dynv(k) { return k === 1 ? new C(1) : (k === 2 ? new D(2) : (k === 3 ? C : new E(5))); }`;

const PROVIDER = `
  export class PD {
    constructor(y) { this.y = y === undefined ? 0 : y; }
    static from(x) { return new PD(1); }
    ident() { return "pd"; }
  }
  export const NS = Object.freeze({ __proto__: null, PD: PD });`;

describe("#6617 — the prototype of a compiled class instance, standalone", () => {
  it("answers a prototype at all for an instance the checker cannot narrow", async () => {
    // TEETH. Base tree: "null" — `ref.test $Object` fails for a `$ClassName`
    // struct and every other arm declined.
    await expect(runStandaloneString(CLASSES, `mark(Object.getPrototypeOf(dynv(1)))`)).resolves.toBe("val");
  });

  it("answers the SAME object `C.prototype` does (ref.eq identity, not a copy)", async () => {
    // TEETH. Base tree: "diff". Identity is the assertion test262 makes, so a
    // structurally equal answer would not do: both routes must reach the one
    // module global.
    await expect(
      runStandaloneString(CLASSES, `Object.getPrototypeOf(dynv(1)) === C.prototype ? "same" : "diff"`),
    ).resolves.toBe("same");
  });

  it("answers the MOST DERIVED class for a subclass instance", async () => {
    // TEETH. Base tree: "diff". `ref.test $C` succeeds for a `$D` instance, so
    // arm order (most-derived first) is load-bearing.
    await expect(
      runStandaloneString(CLASSES, `Object.getPrototypeOf(dynv(2)) === D.prototype ? "same" : "diff"`),
    ).resolves.toBe("same");
  });

  it("does not answer the BASE class's prototype for a subclass instance", async () => {
    // CONTROL — "ok" on both trees (the base answered null, which is not
    // `C.prototype` either). Pins the arm order against a future regression.
    await expect(
      runStandaloneString(CLASSES, `Object.getPrototypeOf(dynv(2)) === C.prototype ? "base" : "ok"`),
    ).resolves.toBe("ok");
  });

  it("tells two structurally identical classes apart by `__tag`", async () => {
    // TEETH. Base tree: "diff". WasmGC canonicalises struct types structurally
    // (#5195 F1), so `E` and `C` can be literally the same type; without the
    // tag guard the first arm would claim both.
    await expect(
      runStandaloneString(CLASSES, `Object.getPrototypeOf(dynv(5)) === E.prototype ? "same" : "diff"`),
    ).resolves.toBe("same");
  });

  it("still does not answer `C.prototype` for a class OBJECT — `getPrototypeOf(C)` is not `C.prototype`", async () => {
    // CONTROL, updated by #6625 (2026-09-17). Before #6625 this dispatcher
    // DECLINED a class-object identity match outright (by design — see the
    // next test) and the query fell through to `null`. #6625 gave
    // `Object.getPrototypeOf(<base class>)` its own, separate, CORRECT arm
    // (`%Function.prototype%`, §15.7.14 step 4) elsewhere in the pipeline
    // (`tryEmitDynamicCallableGetPrototypeOf`'s new `__is_class_object` OR
    // arm), so THIS assertion's answer is no longer `null` — it is
    // `Function.prototype`, i.e. "val", not "C.prototype". What this test
    // still pins, unchanged: the class object reuses its instances' struct
    // type AND tag (#3976), so `C.prototype` is never the answer — THIS
    // dispatcher (`STANDALONE_CLASS_INSTANCE_PROTO`) still declines a
    // class-object identity match, exactly as before; a DIFFERENT arm now
    // answers first.
    await expect(runStandaloneString(CLASSES, `mark(Object.getPrototypeOf(dynv(3)))`)).resolves.toBe("val");
    await expect(
      runStandaloneString(CLASSES, `Object.getPrototypeOf(dynv(3)) === C.prototype ? "wrong" : "ok"`),
    ).resolves.toBe("ok");
  });

  it("leaves the statically folded query byte-for-byte alone", async () => {
    // CONTROL — "same" on both trees; the expression-level fold claims this one
    // before the native helper is reached (byte A/B: `gpo_static` standalone
    // 3c98b33d on both).
    await expect(
      runStandaloneString(CLASSES, `Object.getPrototypeOf(new C(1)) === C.prototype ? "same" : "diff"`),
    ).resolves.toBe("same");
  });

  it("terminates the prototype chain walk instead of looping on itself", async () => {
    // TEETH, and the hazard #5347 documents: answering `C.prototype` for
    // `C.prototype` makes `getPrototypeOf(p) === p` and hangs every
    // `while (getPrototypeOf(p) !== null)` walk. Base tree: "steps0" (the walk
    // ended immediately because step 1 was already null).
    await expect(
      runStandaloneString(
        CLASSES,
        `(function(){ let p = Object.getPrototypeOf(dynv(1)); let n = 0; while (p !== null && p !== undefined && n < 10) { p = Object.getPrototypeOf(p); n++; } return "steps" + n; })()`,
      ),
    ).resolves.toBe("steps2");
  });

  it("answers across the LINK for an instance the provider minted", async () => {
    // TEETH. Base tree: "null". Every value that crosses this seam is
    // checker-opaque by construction, so the link is where the defect is total.
    await expect(
      runLinkedString(
        PROVIDER,
        `(function(){ const p = Object.getPrototypeOf(new NS.PD(1)); return p === null ? "null" : (p === undefined ? "undef" : "val"); })()`,
      ),
    ).resolves.toBe("val");
  });

  it("answers the same object `NS.PD.prototype` does, ACROSS the link", async () => {
    // TEETH. Base tree: "diff". This is test262's assertion, reduced: the
    // prototype singleton is one provider global and both routes must land on
    // it, so `ref.eq` holds through the boundary terminal.
    await expect(
      runLinkedString(PROVIDER, `Object.getPrototypeOf(new NS.PD(1)) === NS.PD.prototype ? "same" : "diff"`),
    ).resolves.toBe("same");
  });

  it("answers for an instance a provider FACTORY returned, not just `new`", async () => {
    // TEETH. Base tree: "diff". `construct[method](...)` is how the failing
    // test262 rows obtain their instance, not `new`.
    await expect(
      runLinkedString(PROVIDER, `Object.getPrototypeOf(NS.PD.from(1)) === NS.PD.prototype ? "same" : "diff"`),
    ).resolves.toBe("same");
  });

  it("the #6617 link-boundary prototype terminal still declines a provider class OBJECT (a DIFFERENT terminal now answers it)", async () => {
    // CONTROL, updated by #6625 (2026-09-17). Before #6625,
    // `Object.getPrototypeOf(<provider-owned class object>)` answered `null`
    // end to end: this terminal (`__js2wasm_link_get_prototype_of`, wrapping
    // ONLY the class-INSTANCE dispatcher) declined, and nothing else in the
    // pipeline had an arm for a class-object VALUE crossing the link. #6625
    // added exactly that arm — `__is_class_object`, a SEPARATE boundary
    // terminal (`__js2wasm_link_is_class_object`, a boolean, not a value) —
    // so the query no longer reaches `null`; it answers `%Function.prototype%`
    // (neither `null` nor `NS.PD.prototype`, hence "other"). What this test
    // still pins, unchanged: THIS SPECIFIC terminal — the one wrapping the
    // class-instance dispatcher — still cannot publish a foreign
    // `%Object.prototype%` or the provider's own `%Function.prototype%`; the
    // answer that resolves this query now comes from #6625's own terminal,
    // not from this one being relaxed.
    await expect(
      runLinkedString(
        PROVIDER,
        `(function(){ const p = Object.getPrototypeOf(NS.PD); return p === null ? "null" : (p === NS.PD.prototype ? "OWN-PROTO" : "other"); })()`,
      ),
    ).resolves.toBe("other");
  });

  it("leaves the `constructor` back-link across the link untouched", async () => {
    // CONTROL — "same" on both trees. It already crossed correctly (through
    // `__js2wasm_link_member_get`), and this change must not disturb it.
    await expect(runLinkedString(PROVIDER, `(new NS.PD(1)).constructor === NS.PD ? "same" : "diff"`)).resolves.toBe(
      "same",
    );
  });
});
