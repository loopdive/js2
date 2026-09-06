// #5363 — a THROWN error's identity across the linked-provider seam, in the
// shape test262 actually asserts it.
//
// WHAT THIS FILE IS. #5363 was filed on the hypothesis that the composition of
// #5226 (a provider throw reaches the consumer's compiled `catch` by identity,
// via the shared host-owned `env.__exn` tag) and #5247 (an uncaught compiled
// throw reaches the HOST as the real `Error`, via the export-boundary wrapper)
// was broken — that `assert.throws(RangeError, fn)` failed because the value
// the harness caught was not a `RangeError`. MEASURED ON THIS BRANCH'S BASE,
// IT IS NOT: every route below already answers correctly, including through the
// real linked `@js-temporal/polyfill` provider. The 22 rows that motivated the
// issue were mis-attributed; see the issue file for the re-attribution.
//
// So these rows do not flip a defect — they LOCK a composition that nothing
// else tests. #5226 pins `instanceof` in a compiled `catch`; #5247 pins the
// host-side shape of an uncaught throw. Neither pins the predicate test262
// actually runs, which is NOT `instanceof`:
//
//   } else if (thrown.constructor !== expectedErrorConstructor) {   // assert.js
//
// `.constructor` reaches the error through a different door than `instanceof`
// (a proxy `get` trap rather than OrdinaryHasInstance's [[Prototype]] walk), so
// it can regress independently — and it is the one that decides a conformance
// row. Both lanes must agree: a difference between them would mean the seam,
// not the export boundary.
//
// Deliberately NOT here: the real Temporal provider. It is a ~45 s cold build,
// and the property is not Temporal-specific — the reduction below is the same
// shape with a throwaway package. The Temporal measurement lives in the issue
// file.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * A provider whose export surface is FUNCTIONS — the route the linker compiles
 * to a direct wasm→wasm call with no host frame in between, which is the route
 * #5226 had to fix and the one #5247 deliberately leaves unwrapped.
 */
const PROVIDER = `
export function boom(k) {
  if (k === 1) throw new RangeError("range-x");
  if (k === 2) throw new TypeError("type-x");
  if (k === 3) throw "bare-string";
  return 0;
}
export function deep(k) { return inner(k); }
function inner(k) { if (k === 1) throw new RangeError("deep-x"); return 0; }
`;

/**
 * `assertThrows` is a faithful transcription of test262 harness/assert.js's
 * `assert.throws` decision procedure — the `typeof` guard and the
 * `.constructor` identity compare, in that order — evaluated in COMPILED code.
 * That is where it runs for a Temporal row: the runner assembles the literal
 * upstream harness and compiles it together with the test body.
 */
const PROBES = `
function assertThrows(expected, fn) {
  try {
    fn();
  } catch (thrown) {
    if (typeof thrown !== "object" || thrown === null) return "not-object:" + typeof thrown;
    if (thrown.constructor !== expected) {
      return "ctor-mismatch:" + String(thrown.constructor && thrown.constructor.name);
    }
    return "PASS";
  }
  return "no-throw";
}
export function throwsRange() { return assertThrows(RangeError, function () { boom(1); }); }
export function throwsType() { return assertThrows(TypeError, function () { boom(2); }); }
export function throwsDeep() { return assertThrows(RangeError, function () { deep(1); }); }
// A WRONG expectation must still be reported as wrong — otherwise the rows
// above could pass by the predicate never discriminating anything.
export function throwsWrongCtor() { return assertThrows(TypeError, function () { boom(1); }); }
// A non-object throw crosses by identity, so the harness's first guard fires.
export function throwsBareString() { return assertThrows(RangeError, function () { boom(3); }); }
// Uncaught, for the host half of the composition.
export function uncaught() { boom(1); return 0; }
`;

const IMPORT = `import { boom, deep } from "err5363";`;

/** Every compiled probe's expected answer. Identical on both lanes — the point. */
const EXPECTED: Record<string, unknown> = {
  throwsRange: "PASS",
  throwsType: "PASS",
  throwsDeep: "PASS",
  throwsWrongCtor: "ctor-mismatch:RangeError",
  throwsBareString: "not-object:string",
};

/**
 * The same predicate, run in the HOST against what escapes an uncaught export.
 * This is the composition #5363 named: host → consumer export → provider throw
 * → nothing catches it in wasm.
 */
function hostAssertThrows(fn: unknown): string {
  try {
    (fn as () => unknown)();
    return "no-throw";
  } catch (thrown) {
    if (typeof thrown !== "object" || thrown === null) return `not-object:${typeof thrown}`;
    const ctor = (thrown as { constructor?: unknown }).constructor;
    if (ctor !== RangeError) return `ctor-mismatch:${String((ctor as { name?: unknown })?.name)}`;
    // `instanceof` is a second, independent door onto the same identity; both
    // have to answer or a conformance row still fails.
    return thrown instanceof RangeError ? "PASS" : "ctor-ok-but-not-instanceof";
  }
}

async function linked() {
  const root = mkdtempSync(join(tmpdir(), "issue-5363-"));
  const packageRoot = join(root, "node_modules", "err5363");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "err5363", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), PROVIDER);
  const entry = join(root, "main.js");
  writeFileSync(entry, `${IMPORT}\n${PROBES}`);

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
  return instance.exports as unknown as Record<string, unknown>;
}

async function control() {
  const entry = "/main.js";
  const result = await compileMulti(
    { "/provider.js": PROVIDER, [entry]: `${IMPORT.replace("err5363", "./provider")}\n${PROBES}` },
    entry,
    { allowJs: true, skipSemanticDiagnostics: true },
  );
  expect(result.success).toBe(true);
  // No package edge, so nothing is linked — this is the control.
  expect(result.linkedModules ?? []).toHaveLength(0);
  const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
  const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
  imports.__setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, unknown>;
}

function readAll(exports: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(EXPECTED)) {
    try {
      observed[name] = (exports[name] as (() => unknown) | undefined)?.();
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

describe("#5363 — a provider-originated throw satisfies test262's assert.throws", () => {
  it("the compiled harness predicate answers on the LINKED lane", { timeout: 300_000 }, async () => {
    expect(readAll(await linked())).toEqual(EXPECTED);
  });

  it("the single-module control answers identically", { timeout: 300_000 }, async () => {
    expect(readAll(await control())).toEqual(EXPECTED);
  });

  it("the same predicate answers in the HOST for an uncaught provider throw", { timeout: 300_000 }, async () => {
    // The composition #5363 named: #5226 delivers the payload by identity,
    // #5247's export wrapper unwraps it at the boundary. Both lanes, because a
    // difference between them would say "provider seam" rather than
    // "export boundary".
    expect(hostAssertThrows((await linked()).uncaught)).toBe("PASS");
    expect(hostAssertThrows((await control()).uncaught)).toBe("PASS");
  });
});
