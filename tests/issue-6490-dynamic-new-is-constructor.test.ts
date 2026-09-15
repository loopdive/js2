// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6490 (#5383 S25) — §13.3.5.1 EvaluateNew step 5, `IsConstructor(constructor)`,
// for the DYNAMIC `new <runtime value>(…)` driver under `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. The dispatched bucket was six rows of the S25
// four-family sample (480 standalone Temporal rows) reporting
//
//     Test262Error: Calling as constructor
//       Expected a TypeError to be thrown but no exception was thrown at all
//
// — test262's `built-ins/Temporal/**\/not-a-constructor.js` shape, 123 files
// corpus-wide. `new Temporal.PlainDate.from()` did not throw; it QUIETLY
// PRODUCED AN OBJECT.
//
// THE MECHANISM. `__native_construct_<N>` (`native-construct.ts`, #3981)
// implements §10.2.2 OrdinaryCallEvaluateBody and nothing else. Every arm above
// its tail — proxy carrier, `$Proxy`, class-object identity, link boundary,
// runtime-eval marker — answers for a callee that HAS [[Construct]]; the tail
// itself is unconditional (`Object.create(callee.prototype)`, run the body,
// return the object). Nothing answered for a callee that is CALLABLE but has NO
// [[Construct]]. So an arrow, a static or prototype METHOD, an object-literal
// method, a built-in function, or a foreign function whose
// `__boundary_object_callable_kind` publishes bit 1 without bit 2 fell straight
// into the tail and constructed successfully.
//
// WHY BOTH ARMS HAVE TEETH — and this is the asymmetry with #6489, whose
// single-module probes were controls only. This defect is a property of the
// DRIVER, not of callee ownership, so it reproduces in ONE module with no link
// at all (`.tmp/s25/p1.mjs`) and equally across the link (`.tmp/s25/p2.mts`,
// `new NS.PD.compare()` → `"no-throw object"` on base). Both witness `it`s below
// therefore have teeth, and the linked one additionally covers the foreign-
// function path where the callable/constructible distinction arrives as a
// `callableKind` BITMASK rather than as a closure the module owns.
//
// THE CONTROLS ARE THE POINT OF THIS FILE. A guard that fires wrongly turns
// working code into a hard throw, which is a far worse regression than the
// defect. So every callee that MUST still construct is pinned: class, subclass,
// plain declaration, function expression, IIFE result, bound plain function,
// built-in constructors (`Set`/`Map`/`Error`/`Date`/`RegExp`),
// `Reflect.construct`, and `Array#map`, which constructs through a derived
// constructor internally.
//
// Every expectation below was measured on BOTH trees on this branch by
// file-copy revert of `src/codegen/native-construct.ts` and
// `src/codegen/expressions/new-super.ts` (`.tmp/s25base/` vs `.tmp/s25/*.new.ts`);
// the base-tree answers are recorded inline.
//
// Host-free: `hostBridge: "off"` plus an EMPTY import object, so a leaked host
// import fails the test instead of being papered over. The linked probes answer
// NUMBERS — a standalone module's string is a WasmGC array the host cannot
// decode, so every comparison happens INSIDE the module.
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
 * Compile `expression` standalone, instantiate with an EMPTY import object, and
 * read the string it produced back one char code at a time.
 */
async function runStandaloneString(expression: string): Promise<string> {
  const source = `let __s = "";
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

/**
 * The single-module prelude.
 *
 * SPELLING MATTERS, and getting it wrong reads as a clean pass. The callee must
 * arrive as a FUNCTION PARAMETER (`nw0(F) { return new F(); }`) — that is the
 * spelling `tryCompileNativeConstructFromValue` admits, and therefore the only
 * one that reaches the driver this issue changes. The obvious alternative, a
 * registry read (`const C = reg["%K%"]; new C()`), does NOT: in a single module
 * that site falls to `emitDynamicNewFallback`'s tag dispatch, which has a
 * candidate only for a module-local CLASS, so a plain function or a built-in
 * answers `null` there on BOTH trees (#6489's residual, measured again here).
 * A test written that way would assert `null` and never exercise the guard.
 */
const PRELUDE = `
  class K { constructor(a) { this.a = a === undefined ? 1 : a; } static stat() { return 1; } ident() { return 2; } }
  class Sub extends K { constructor() { super(7); } }
  function plain() { this.a = 3; }
  const fexpr = function () { this.a = 4; };
  const iife = (function () { return function NullObject() { this.a = 5; }; })();
  const arrow = (x) => x + 1;
  const lit = { meth() { return 6; } };
  const nw0 = function (F) { return new F(); };
  const nw1 = function (F, a) { return new F(a); };
  const probe = function (F) {
    try {
      const o = nw0(F);
      if (o === null) return "null";
      return typeof o === "object" ? "obj" : "prim";
    } catch (e) {
      return e && e.name ? e.name : "throw";
    }
  };`;

/** One `/`-joined group of single-module probes, each callee an expression. */
function group(callees: string[]): string {
  return `(() => { ${PRELUDE}
    return [${callees.join(", ")}].map(function (F) { return probe(F); }).join("/"); })()`;
}

async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6490-"));
  const packageRoot = join(root, "node_modules", "ns6490");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6490", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6490";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6490")!;
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

/**
 * The provider half. `PD` mirrors `Temporal.PlainDate`: a real constructor
 * carrying STATIC methods (`Temporal.PlainDate.from`, `…compare` — the corpus's
 * two non-constructors) and a PROTOTYPE method.
 */
const PROVIDER = `
  export class PD {
    constructor(y) { this.y = y === undefined ? 0 : y; }
    static compare(a, b) { return 0; }
    static from(x) { return new PD(1); }
    ident() { return "pd"; }
  }
  export const NS = Object.freeze({
    __proto__: null,
    PD: PD,
    arrow: (x) => x + 1,
  });`;

// 1 = TypeError (the spec answer). 0 = constructed an object (the defect).
// -2 = null. -3 = some other throw. Numbers, because a standalone string
// cannot cross the host boundary.
const CONSUMER = `
  function code(f) {
    try {
      const o = f();
      if (o === null) return -2;
      return 0;
    } catch (e) { return e && e.name === "TypeError" ? 1 : -3; }
  }
  // TEETH. Base tree: 0 for all three — \`new\` on a foreign non-constructor
  // produced an object.
  export function newStaticMethod() { return code(function () { return new NS.PD.compare(); }); }
  export function newStaticFrom() { return code(function () { return new NS.PD.from(); }); }
  export function newProtoMethod() { return code(function () { return new NS.PD.prototype.ident(); }); }
  // TEETH. A foreign ARROW: callable with \`callableKind\` bit 1 and not bit 2.
  export function newForeignArrow() { return code(function () { return new NS.arrow(); }); }
  // CONTROL — the same member-access spelling on a callee that IS a
  // constructor must still construct.
  export function newForeignClass() {
    try { const o = new NS.PD(5); return o === null ? -2 : o.y; } catch (e) { return -1; }
  }
  // The ORDER clause: §13.3.5.1 evaluates the argument list (step 4) BEFORE the
  // IsConstructor test (step 5). Returns the base-11 fingerprint of the
  // evaluation order, so a permutation cannot read as a pass: 1,2,3 -> 146.
  export function evaluatesArgumentsBeforeThrowing() {
    let seen = 0;
    const t = function (v) { seen = seen * 11 + v; return v; };
    try { new NS.PD.compare(t(1), t(2), t(3)); } catch (e) { /* expected on branch */ }
    return seen;
  }
`;

describe("#6490 — §13.3.5.1 step 5 IsConstructor for dynamic `new`, standalone", () => {
  it("throws TypeError for a callable that has no [[Construct]] (single module)", async () => {
    // TEETH. Base tree: "obj/obj/obj/obj/obj" — every one of these constructed
    // successfully, which is the whole defect. `%max%` is the built-in arm,
    // `%stat%`/`%proto%`/`%lit%` are the three method spellings, `%arrow%` the
    // arrow.
    await expect(
      runStandaloneString(group(["arrow", "K.stat", "K.prototype.ident", "lit.meth", "Math.max"])),
    ).resolves.toBe("TypeError/TypeError/TypeError/TypeError/TypeError");
  });

  it("CONTROL: a bound ARROW is still not a constructor, a bound plain function still is", async () => {
    // §10.4.1.2 gives a bound function a [[Construct]] iff its target has one.
    // Base tree: "obj/obj" — the bound arrow wrongly constructed.
    await expect(runStandaloneString(group(["arrow.bind(null)", "plain.bind(null)"]))).resolves.toBe("TypeError/obj");
  });

  it("CONTROL: every constructible callee still constructs", async () => {
    // The regression this guard could plausibly cause. All ten measured
    // identical on base and branch — the guard must be invisible here.
    await expect(
      runStandaloneString(group(["K", "Sub", "plain", "fexpr", "iife", "Set", "Map", "Error", "Date", "RegExp"])),
    ).resolves.toBe("obj/obj/obj/obj/obj/obj/obj/obj/obj/obj");
  });

  it("CONTROL: the constructed values are the right values, not merely objects", async () => {
    // "is an object" would be satisfied by a wrong object, so the field the
    // constructor body wrote is read back. The last cell is a PINNED RESIDUAL,
    // not a claim: a built-in `Set` constructed through the dynamic driver
    // answers `undefined` for `.size` on BOTH trees — its internal slot is not
    // wired up on this path. Recorded so that fixing it fails here loudly
    // instead of leaving a stale expectation. Base tree: identical.
    await expect(
      runStandaloneString(`(() => { ${PRELUDE}
        const a = nw1(K, 9);
        const b = nw0(Sub);
        const c = nw0(plain);
        const d = nw0(Set);
        return a.a + "/" + b.a + "/" + c.a + "/" + typeof d + "/" + d.size; })()`),
    ).resolves.toBe("9/7/3/object/undefined");
  });

  it("CONTROL: Reflect.construct and the species paths are unchanged", async () => {
    // `Reflect.construct` reads the SAME predicate the guard calls, and the
    // species path constructs through a derived constructor internally — the
    // two places a wrongly-firing guard would surface far from any `new`.
    // Base tree: identical.
    await expect(
      runStandaloneString(`(() => { ${PRELUDE}
        const r = Reflect.construct(plain, []);
        const m = [1, 2, 3].map((x) => x * 2).join(",");
        let threw = "no";
        try { Reflect.construct(function () {}, [], arrow); } catch (e) { threw = (e && e.name) || "throw"; }
        return r.a + "/" + m + "/" + threw; })()`),
    ).resolves.toBe("3/2,4,6/TypeError");
  });

  it("throws TypeError across the link, and evaluates the arguments first", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(PROVIDER, CONSUMER);
    // ORDER, asserted FIRST on purpose: an expectation placed after a failing
    // one is never measured on the base tree, and an inline "base tree: …"
    // written from inference rather than a run is exactly the defect the
    // project's measurement discipline is about. Base tree: 146 — it
    // constructed, so it evaluated its arguments too; this pins the ordering
    // ACROSS the fix rather than witnessing it. The guard sits at the DRIVER's
    // entry, so the argument expressions have already run when it fires; a
    // guard hoisted to the call site ahead of argument evaluation answers 0.
    expect(ex.evaluatesArgumentsBeforeThrowing()).toBe(146);
    // CONTROL — measured 5 on both trees.
    expect(ex.newForeignClass()).toBe(5);
    // TEETH. Base tree: 0/0/0/0 — four foreign non-constructors, four objects.
    expect(ex.newStaticMethod()).toBe(1);
    expect(ex.newStaticFrom()).toBe(1);
    expect(ex.newProtoMethod()).toBe(1);
    expect(ex.newForeignArrow()).toBe(1);
  });
});
