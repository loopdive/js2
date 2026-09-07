// #5373 — a `class extends Array` override must win over the built-in it
// shadows, on every host coercion / dynamic-dispatch path.
//
// `class B extends Array` compiles EXTERNREF-BACKED: the instance that reaches
// the runtime is a REAL host JS Array whose prototype chain carries
// `Array.prototype.toString` / `join` / `valueOf` and NONE of B's overrides —
// those exist only as the module's `__class_call_B_<key>_<arity>` bridges,
// reachable through `_resolveClassMember`. Every host path that resolved a
// member off the receiver therefore found the built-in and silently bypassed
// the override. Three such paths are fixed here, all in `src/runtime.ts`:
//
//   `__extern_toString`     — `String(b)` / `` `${b}` ``
//   `__extern_join_str`     — a subclass instance as an ELEMENT of a join
//   `__extern_method_call`  — any-typed `b.toString()` / `b.join()`
//
// A FOURTH path has the identical defect and is deliberately NOT changed here:
// the member READ `const f = b.toString` (`__extern_get`, its `intent`-table
// twin, and `_safeGet`) also answers the built-in. That is the path jsbi takes
// (`JSBI.__toPrimitive` does `const e = i.toString; e.call(i)`), which is where
// `Temporal.Instant.from(…).epochNanoseconds` picks up
// `SyntaxError: Cannot convert 23396352,513294428,1 to a BigInt`. Fixing it in
// isolation REGRESSES 9 rows of `built-ins/Temporal/Instant/**` (measured
// 2026-09-06, base vs fix, per row): it makes `i.valueOf` resolve to jsbi's
// own `valueOf`, which throws by design, and node never reaches that method
// because `i.constructor === JSBI` short-circuits first — and THAT comparison
// is false here for any compiled class read through an any-typed receiver. So
// the read path is blocked on class-object identity, not on this ordering, and
// the `pAnyRead*` cells below are pinned at their unchanged values.
//
// The fix is an ORDERING one — class chain before the built-in — gated on "the
// receiver is a compiled class instance" (`_userClassTags`), never on "the
// receiver looks like an array". A plain array is a WasmGC vec and is never
// tagged, so the #3903 array fast path is untouched; the `c*` controls pin that.
//
// Base measurements for every cell are in the trailing comment of each table.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * The subclass is INTERNAL to the provider, as jsbi is internal to the Temporal
 * polyfill. `B` is deliberately not on the export surface: a class there makes
 * the planner fall back to `bundled` ("inferred/any package signatures require
 * side-effect-free engine validation"), which would run the single-module lane
 * twice instead of testing the linked one.
 *
 * The statically-typed probes live here too — across the seam every receiver is
 * `any`, so a directly-typed call can only be observed from inside.
 */
const PROVIDER_SOURCE = `
class B extends Array {
  constructor(n, s) { super(n); this.sign = s; }
  toString(radix) { return "B(" + this.length + ":" + radix + ")"; }
  join(sep) { return "J(" + this.length + ")"; }
  valueOf() { return 42; }
}
export function mk() { const b = new B(3, false); b[0] = 1; b[1] = 2; b[2] = 3; return b; }
export function pvDirect() { const b = new B(3, false); return b.toString(); }
export function pvDirectArg() { const b = new B(3, false); return b.toString(10); }
export function pvPlus() { const b = new B(3, false); return "" + b; }
`;

/**
 * `any`-typed helpers are what forces the host dynamic-dispatch path; a
 * directly-typed receiver takes the compiled call and was already correct.
 */
const CONSUMER_PROBES = `
function anyStr(x) { return String(x); }
function anyTemplate(x) { return \`\${x}\`; }
function anyMeth(x) { return x.toString(); }
function anyMethArg(x) { return x.toString(10); }
function anyPlus(x) { return "" + x; }
function anyJoin(x) { return x.join(","); }
function anyValueOf(x) { return x.valueOf(); }
// The READ shape — jsbi's \`__toPrimitive\` verbatim.
function anyReadCall(x) { const f = x.toString; if (!f) { return "ABSENT"; } return String(f.call(x)); }
function anyReadValueOf(x) { const f = x.valueOf; if (!f) { return "ABSENT"; } return String(f.call(x)); }

export function pDirect() { return pvDirect(); }
export function pDirectArg() { return pvDirectArg(); }
export function pPlus() { return pvPlus(); }
export function pString() { return String(mk()); }
export function pTemplate() { return \`\${mk()}\`; }
export function pAnyStr() { return anyStr(mk()); }
export function pAnyTemplate() { return anyTemplate(mk()); }
export function pAnyMeth() { return anyMeth(mk()); }
export function pAnyMethArg() { return anyMethArg(mk()); }
export function pAnyPlus() { return anyPlus(mk()); }
export function pAnyJoin() { return anyJoin(mk()); }
export function pAnyValueOf() { return anyValueOf(mk()); }
export function pAnyReadCall() { return anyReadCall(mk()); }
export function pAnyReadValueOf() { return anyReadValueOf(mk()); }
export function pElement() { return [mk(), 7].join("-"); }
export function pLength() { return mk().length; }
export function pIsArray() { return Array.isArray(mk()) ? 1 : 0; }

export function cDirect() { return [1, 2, 3].toString(); }
export function cAnyMeth() { return anyMeth([1, 2, 3]); }
export function cAnyJoin() { return anyJoin([1, 2, 3]); }
export function cElement() { return [[1, 2], 7].join("-"); }
export function cAnyReadCall() { return anyReadCall([1, 2, 3]); }
`;

const CONSUMER_IMPORT = `import { mk, pvDirect, pvDirectArg, pvPlus } from `;

/** Cells that behave the same in both lanes: unaffected, or already correct. */
const COMMON: Record<string, unknown> = {
  pDirect: "B(3:undefined)",
  pDirectArg: "B(3:10)",
  // `+` applies ToPrimitive with the DEFAULT hint, so the `valueOf` override
  // wins — already correct on base, pinned so the fix does not move it.
  pPlus: "42",
  pLength: 3,
  pIsArray: 1,
  // Plain-array controls — a plain array is a WasmGC vec, never tagged, and
  // must keep the built-in. Identical on base and after in both lanes.
  cDirect: "1,2,3",
  cAnyMeth: "1,2,3",
  cAnyJoin: "1,2,3",
  cElement: "1,2-7",
  // REPORTED, NOT FIXED, pinned at its MEASURED value rather than node's
  // ("1,2,3"), because "unchanged" is what this control is for: reading a
  // method off a PLAIN array through an any-typed parameter answers `undefined`
  // — a separate, pre-existing gap in the vec's host view, present identically
  // before and after.
  cAnyReadCall: "ABSENT",
  // REPORTED, NOT FIXED — the member-READ path. node: "B(3:undefined)". See the
  // header comment: fixing this one costs 9 measured Temporal/Instant rows until
  // `i.constructor === C` holds.
  pAnyReadCall: "1,2,3",
};

/** Single-module lane: node's answers. The trailing comment is the base value. */
const EXPECTED_SINGLE: Record<string, unknown> = {
  ...COMMON,
  pString: "B(3:undefined)", // base: "1,2,3"
  pTemplate: "B(3:undefined)", // base: "1,2,3"
  pAnyStr: "B(3:undefined)", // base: "1,2,3"
  pAnyPlus: "42", // already correct on base — `+` uses the DEFAULT hint, so `valueOf` wins
  pAnyTemplate: "B(3:undefined)", // base: "1,2,3"
  pAnyMeth: "B(3:undefined)", // base: "1,2,3"
  pAnyMethArg: "B(3:10)", // base: "1,2,3"  ← the polyfill's exact call
  pAnyJoin: "J(3)", // base: "1,2,3"
  pAnyValueOf: 42, // base: the array itself
  pElement: "B(3:undefined)-7", // base: "1,2,3-7"
  // Reading `valueOf` still yields the BUILT-IN (the unfixed read path), which
  // returns the receiver — so what moves here is the `String()` of that
  // receiver, through the fixed `__extern_toString`. base: "1,2,3";
  // node: "42", which needs the read path and therefore `i.constructor === C`.
  pAnyReadValueOf: "B(3:undefined)",
};

/**
 * Linked lane: the SAME source, compiled as a separate provider. Every cell the
 * single-module lane fixes still answers the built-in here, and this change does
 * NOT fix that — it is the cross-module class-member gap #5223 recorded for
 * getters: "the host boundary resolves compiled class members against the
 * CALLING module's exports", and a consumer that does not declare `B` has no
 * `__class_call_B_*` bridge for `_resolveClassMember` to find.
 *
 * Pinned at the measured values (identical before and after this change) rather
 * than omitted, so a future cross-module fix has a base reading and so this file
 * cannot silently start covering the seam.
 */
const EXPECTED_LINKED: Record<string, unknown> = {
  ...COMMON,
  pString: "1,2,3", // node: "B(3:undefined)"
  pTemplate: "1,2,3", // node: "B(3:undefined)"
  pAnyStr: "1,2,3", // node: "B(3:undefined)"
  pAnyPlus: "1,2,3", // node: "42" — even the already-working `+` path misses across the seam
  pAnyTemplate: "1,2,3", // node: "B(3:undefined)"
  pAnyMeth: "1,2,3", // node: "B(3:undefined)"
  pAnyMethArg: "1,2,3", // node: "B(3:10)"
  pAnyJoin: "1,2,3", // node: "J(3)"
  pAnyValueOf: [1, 2, 3], // node: 42
  pElement: "1,2,3-7", // node: "B(3:undefined)-7"
  pAnyReadValueOf: "1,2,3", // node: "42"
};

function readAll(exports: Record<string, unknown>, expected: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(expected)) {
    try {
      const value = (exports[name] as (() => unknown) | undefined)?.();
      // `pAnyValueOf` on the linked lane answers the receiver itself, which
      // crosses back as a live host mirror over the vec rather than a plain
      // array — `toEqual` then reports "no visual difference". Copy the
      // elements out so the assertion compares the values it prints.
      observed[name] = Array.isArray(value) ? Array.from(value) : value;
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

describe("#5373 — an Array-subclass override wins over the built-in it shadows", () => {
  it("the single-module lane answers node", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `${CONSUMER_IMPORT}"./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge, so nothing is linked — one module, one export set.
    expect(result.linkedModules ?? []).toHaveLength(0);

    const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>, EXPECTED_SINGLE)).toEqual(EXPECTED_SINGLE);
  });

  it("a separately linked provider keeps the #5223 cross-module gap", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5373-"));
    const packageRoot = join(root, "node_modules", "sub5373");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "sub5373", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `${CONSUMER_IMPORT}"sub5373";\n${CONSUMER_PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and silently run
    // the single-module lane twice.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>, EXPECTED_LINKED)).toEqual(EXPECTED_LINKED);
  });
});
