// #5226 — an error thrown inside a linked provider must keep its identity in
// the consumer's `catch`.
//
// Reported as a Temporal symptom (test262 asserts error TYPES, so every
// negative-case row through the #4628 provider would fail even when the
// polyfill throws correctly), but nothing about it is Temporal-specific. The
// reduction below uses a throwaway npm package with no Temporal in sight.
//
// ROOT CAUSE (measured on base, 2026-08-31). Wasm matches a `catch` clause by
// TAG IDENTITY, and `ensureExnTag` gave every module its OWN module-local
// `__exn` tag. So a provider's `throw` could never match its consumer's
// `catch $exn`: it fell through to the consumer's `catch_all`, whose recovery
// path calls the `__get_caught_exception` host import — which only ever answers
// a value when a JS frame observed the throw. A wasm→wasm call has no JS frame
// in between, so the binding was `undefined`. Not "an object that lost its
// prototype": the whole value was gone, message included.
//
//   route                                base                 after
//   -------------------------------------------------------------------------
//   direct import, `throw new RangeError`  e === undefined  →  RangeError, msg
//   direct import, `throw new TypeError`   e === undefined  →  TypeError, msg
//   direct import, `throw new Error`       e === undefined  →  Error, msg
//   direct import, `throw {name,message}`  e === undefined  →  the same object
//   provider-MIRROR method call            already correct     unchanged
//
// The fix imports one host-owned `WebAssembly.Tag` (`env.__exn`) into every
// module of a linked graph, so the externref payload — a host-native `Error` —
// is delivered by identity. Nothing is re-minted and nothing is lost, which is
// why the non-Error throw survives too.
//
// The single-module control answers the post-fix values on base already; that
// is what makes this linking-specific rather than a general throw/catch gap.
//
// FIXED SINCE, BY #5247: an exception escaping an exported function to the
// HOST used to surface as a bare `WebAssembly.Exception` — identically in the
// single-module control, which is what identified it as a separate
// export-boundary gap rather than a provider-seam one. #5247 re-points each
// host-facing export at a wrapper that unwraps the `__exn` payload, so the
// `hostBoundary` row below now reads a real RangeError on both lanes. The
// two-lane agreement is kept: it is the property that says export boundary.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * A provider whose whole export surface is FUNCTIONS — the route the linker
 * compiles to a direct wasm→wasm call with no host frame, which is exactly the
 * route that lost the value.
 */
const FN_PROVIDER = `
export function boom(k) {
  if (k === 1) throw new RangeError("range-x");
  if (k === 2) throw new TypeError("type-x");
  if (k === 3) throw new Error("plain-x");
  if (k === 4) throw { name: "Weird", message: "w" };
  return 0;
}
`;

/**
 * A provider exporting a namespace OBJECT. Its methods are reached through a
 * host mirror (#5222), so the throw already crossed a JS frame and worked on
 * base — kept here so a regression on the route that was fine is loud.
 */
const NS_PROVIDER = `
export const NS = {
  boomM(k) { if (k === 1) throw new RangeError("range-m"); return 0; },
};
`;

const DESC = `function d(e) {
  return (e instanceof RangeError ? "RE" : "no-RE") + "|" + (e instanceof Error ? "E" : "no-E") +
    "|" + (typeof e) + "|n=" + String(e && e.name) + "|m=" + String(e && e.message);
}`;

const FN_PROBES = `${DESC}
export function fnRange() { try { boom(1); } catch (e) { return d(e); } return "no-throw"; }
export function fnType() { try { boom(2); } catch (e) { return (e instanceof TypeError ? "TE" : "no-TE") + "|m=" + String(e && e.message); } return "no-throw"; }
export function fnPlain() { try { boom(3); } catch (e) { return (e instanceof Error ? "E" : "no-E") + "|m=" + String(e && e.message); } return "no-throw"; }
export function fnNonError() { try { boom(4); } catch (e) { return (typeof e) + "|n=" + String(e && e.name) + "|m=" + String(e && e.message); } return "no-throw"; }
export function fnFinally() { let seen = "none"; try { try { boom(1); } finally { seen = "finally"; } } catch (e) { return seen + "|" + d(e); } return "no-throw"; }
export function fnRethrow() { try { try { boom(1); } catch (e) { throw e; } } catch (e2) { return d(e2); } return "no-throw"; }
export function fnNoThrow() { return boom(0); }
export function hostBoundary() { boom(1); return 0; }
`;

const NS_PROBES = `${DESC}
export function mirrorRange() { try { NS.boomM(1); } catch (e) { return d(e); } return "no-throw"; }
export function mirrorNoThrow() { return NS.boomM(0); }
`;

/** Every probe's expected answer. Identical for both lanes — that is the point. */
const FN_EXPECTED: Record<string, unknown> = {
  fnRange: "RE|E|object|n=RangeError|m=range-x",
  fnType: "TE|m=type-x",
  fnPlain: "E|m=plain-x",
  // A non-Error throw crosses unchanged too: the fix delivers the payload by
  // identity rather than re-minting an Error from name+message.
  fnNonError: "object|n=Weird|m=w",
  fnFinally: "finally|RE|E|object|n=RangeError|m=range-x",
  fnRethrow: "RE|E|object|n=RangeError|m=range-x",
  fnNoThrow: 0,
};

const NS_EXPECTED: Record<string, unknown> = {
  mirrorRange: "RE|E|object|n=RangeError|m=range-m",
  mirrorNoThrow: 0,
};

function readAll(exports: Record<string, unknown>, expected: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(expected)) {
    try {
      observed[name] = (exports[name] as (() => unknown) | undefined)?.();
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

/**
 * What an uncaught provider throw looks like once it reaches the host.
 *
 * (#5247) Reads the full identity, not just the wrapper's brand: before that
 * fix every field but the brand was unreadable.
 */
function hostBoundaryShape(exports: Record<string, unknown>): string {
  try {
    (exports.hostBoundary as () => unknown)?.();
    return "no-throw";
  } catch (error) {
    const e = error as { name?: unknown; message?: unknown };
    return (
      `${error instanceof RangeError ? "RE" : "no-RE"}|${error instanceof Error ? "E" : "no-E"}|` +
      `${Object.prototype.toString.call(error)}|n=${String(e?.name)}|m=${String(e?.message)}`
    );
  }
}

async function linked(provider: string, importLine: string, probes: string) {
  const root = mkdtempSync(join(tmpdir(), "issue-5226-"));
  const packageRoot = join(root, "node_modules", "err5226");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "err5226", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "main.js");
  writeFileSync(entry, `${importLine}\n${probes}`);

  const result = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
  });
  expect(result.success).toBe(true);
  // Load-bearing: a `bundled` plan would inline the package and silently test
  // the single-module lane twice.
  expect(result.linkPlan?.mode).toBe("separate");
  const { instance } = await instantiateLinkedProject(result);
  return instance.exports as unknown as Record<string, unknown>;
}

async function control(provider: string, importLine: string, probes: string) {
  const entry = "/main.js";
  const result = await compileMulti(
    { "/provider.js": provider, [entry]: `${importLine.replace("err5226", "./provider")}\n${probes}` },
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

const FN_IMPORT = `import { boom } from "err5226";`;
const NS_IMPORT = `import { NS } from "err5226";`;

describe("#5226 — a provider throw keeps its identity in the consumer", () => {
  it("a directly imported provider function's throw arrives intact", { timeout: 300_000 }, async () => {
    const exports = await linked(FN_PROVIDER, FN_IMPORT, FN_PROBES);
    // Base: every row read "no-RE|no-E|undefined|n=undefined|m=undefined" —
    // the catch binding was `undefined`, not a stripped object.
    expect(readAll(exports, FN_EXPECTED)).toEqual(FN_EXPECTED);
  });

  it("the single-module control answers identically", { timeout: 300_000 }, async () => {
    const exports = await control(FN_PROVIDER, FN_IMPORT, FN_PROBES);
    expect(readAll(exports, FN_EXPECTED)).toEqual(FN_EXPECTED);
  });

  it("a provider-mirror method call keeps working", { timeout: 300_000 }, async () => {
    const [linkedExports, controlExports] = [
      await linked(NS_PROVIDER, NS_IMPORT, NS_PROBES),
      await control(NS_PROVIDER, NS_IMPORT, NS_PROBES),
    ];
    expect(readAll(linkedExports, NS_EXPECTED)).toEqual(NS_EXPECTED);
    expect(readAll(controlExports, NS_EXPECTED)).toEqual(NS_EXPECTED);
  });

  // (#5247) FLIPPED. This row used to pin the reported-not-fixed bound —
  // `no-E|[object WebAssembly.Exception]` on BOTH lanes, before and after the
  // #5226 shared-tag fix, which is exactly what said "export boundary, not
  // provider seam". #5247 unwraps the payload at the export boundary, so the
  // host now catches the RangeError itself. The two lanes still have to agree:
  // that agreement is what keeps the property an export-boundary one.
  it("an uncaught throw reaches the host with its identity intact, both lanes", { timeout: 300_000 }, async () => {
    const shape = "RE|E|[object Error]|n=RangeError|m=range-x";
    expect(hostBoundaryShape(await linked(FN_PROVIDER, FN_IMPORT, FN_PROBES))).toBe(shape);
    expect(hostBoundaryShape(await control(FN_PROVIDER, FN_IMPORT, FN_PROBES))).toBe(shape);
  });
});
