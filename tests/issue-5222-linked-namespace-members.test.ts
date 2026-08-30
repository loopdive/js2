// #5222 — object MEMBERS must survive the #2527 linked-provider boundary.
//
// Reported as a Temporal symptom (`typeof Temporal.Now.instant` is "function"
// single-module but "undefined" through the #4628 provider), but nothing about
// it is Temporal-specific. The reduction below uses a throwaway npm package
// with no Temporal in sight and reproduces it exactly, which is why the fix
// lives in the general runtime seam and not in `temporal-provider.ts`.
//
// THE RULE (measured on base, 2026-08-30):
//
//   A compiled value handed to a consumer across the linked-provider seam
//   arrives as a host mirror bound to the PROVIDER's exports
//   (`wrapLinkedProviderValue` → `_wrapForHost`). Every property read on it
//   then goes through the CONSUMER's `__extern_get`, whose #4611 exit-boundary
//   un-marshal (`normalizeSandboxValue` → `_unwrapForHost`) strips the mirror
//   back to the raw WasmGC struct so private-field `ref.cast` dispatch keeps
//   working. Inside the consumer that struct has no decoder — its `__sget_*` /
//   `__struct_field_names` / `__call_fn_*` helpers are exports of the PROVIDER
//   module — so it presents as an opaque object with zero members.
//
//   Consequences, both reproduced here:
//     * depth 1 survives (the value never passes through `__extern_get`), but
//       a FUNCTION-valued member read at depth 1 answers `typeof "object"`
//       instead of "function" — it was un-marshalled to its raw closure struct;
//     * depth ≥ 2 is erased outright: `Object.getOwnPropertyNames` is empty and
//       every member reads `undefined`. `Temporal.Now` is exactly this shape.
//
// Base measurements for the assertions below (`origin/main` + the #5211 stack
// + PR #5318, before the fix):
//   typeofF            "object"    → "function"
//   innerKeys          ""          → "i,j"
//   typeofInnerI       "undefined" → "function"
//   readInnerJ         undefined   → 8
//   callInnerI         threw "i is not a function" → 7
// The single-module control answers the post-fix values on base already — that
// is what made this linking-specific rather than a general object-literal gap.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * One provider-side module, used verbatim by BOTH lanes so the only difference
 * between them is whether the linker compiled it separately.
 *
 * `NS` exercises depth 1 (a namespace object of functions, the plain
 * `object-of-functions` export shape), `OUTER.Inner` exercises depth 2 — the
 * `Temporal.Now` shape.
 */
const PROVIDER_SOURCE = `
export const NS = {
  f() { return 1; },
  g: function () { return 2; },
  h: () => 3,
  k: 4,
};
const Inner = { i() { return 7; }, j: 8 };
export const OUTER = { Inner: Inner, top() { return 9; } };
`;

const CONSUMER_PROBES = `
export function typeofF() { return typeof NS.f; }
export function typeofH() { return typeof NS.h; }
export function readK() { return NS.k; }
export function nsKeys() { return Object.getOwnPropertyNames(NS).sort().join(","); }
export function callF() { return NS.f(); }
export function outerKeys() { return Object.getOwnPropertyNames(OUTER).sort().join(","); }
export function innerKeys() { return Object.getOwnPropertyNames(OUTER.Inner).sort().join(","); }
export function typeofInnerI() { return typeof OUTER.Inner.i; }
export function readInnerJ() { return OUTER.Inner.j; }
export function callInnerI() { return OUTER.Inner.i(); }
export function typeofTop() { return typeof OUTER.top; }
`;

/** Every probe's expected answer. Identical for both lanes — that is the point. */
const EXPECTED: Record<string, unknown> = {
  typeofF: "function",
  typeofH: "function",
  readK: 4,
  nsKeys: "f,g,h,k",
  callF: 1,
  outerKeys: "Inner,top",
  innerKeys: "i,j",
  typeofInnerI: "function",
  readInnerJ: 8,
  callInnerI: 7,
  typeofTop: "function",
};

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

describe("#5222 — members survive the linked-provider value crossing", () => {
  it("a separately linked package keeps its nested namespace members", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5222-"));
    const packageRoot = join(root, "node_modules", "ns5222");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "ns5222", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { NS, OUTER } from "ns5222";\n${CONSUMER_PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and silently
    // test the single-module lane twice.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("the single-module control answers identically", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { NS, OUTER } from "./provider";\n${CONSUMER_PROBES}`,
      },
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
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });
});
