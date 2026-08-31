// #5225 — a value minted in the CONSUMER must be readable inside a linked
// provider (the inbound twin of #5222).
//
// Reported as a Temporal symptom (`Temporal.PlainDate.from({year, month, day})`
// throws `RangeError: year is required` through the #4628 compile-once linked
// provider, while `.from("2020-03-04")` and `.from(<host object>)` work), but
// nothing about it is Temporal-specific. The reduction below uses a throwaway
// npm package with no Temporal in sight.
//
// #5222 fixed the EXIT boundary (provider -> consumer): a provider value keeps
// the mirror bound to the PROVIDER's exports so the consumer can still decode
// it. This file covers the ARGUMENT boundary (consumer -> provider): a WasmGC
// struct minted by the consumer reaches the provider's `__extern_get` /
// `__struct_field_names`, whose decoders are exports of the CONSUMER module, so
// the provider sees an opaque object with zero members.
//
// Base measurements are recorded in the issue file; the single-module control
// below answers the post-fix values on base already, which is what makes this
// linking-specific rather than an object-literal gap.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * Provider side: every export takes a value the CONSUMER minted and reads
 * through it. Used verbatim by both lanes so the only difference is whether the
 * linker compiled it separately.
 */
const PROVIDER_SOURCE = `
export function readX(o) { return o.x; }
export function typeofX(o) { return typeof o.x; }
export function sumXY(o) { return o.x + o.y; }
export function keysOf(o) { return Object.getOwnPropertyNames(o).sort().join(","); }
export function readNested(o) { return o.inner.z; }
export function callM(o) { return o.m(); }
export function hasX(o) { return "x" in o ? 1 : 0; }
`;

const CONSUMER_PROBES = `
export function pReadX() { return readX({ x: 7, y: 2 }); }
export function pTypeofX() { return typeofX({ x: 7, y: 2 }); }
export function pSumXY() { return sumXY({ x: 7, y: 2 }); }
export function pKeysOf() { return keysOf({ x: 7, y: 2 }); }
export function pReadNested() { return readNested({ inner: { z: 5 } }); }
export function pCallM() { return callM({ m() { return 11; } }); }
export function pHasX() { return hasX({ x: 7, y: 2 }); }
`;

/** Every probe's expected answer. Identical for both lanes — that is the point. */
const EXPECTED: Record<string, unknown> = {
  pReadX: 7,
  pTypeofX: "number",
  pSumXY: 9,
  pKeysOf: "x,y",
  pReadNested: 5,
  pCallM: 11,
  pHasX: 1,
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

describe("#5225 — consumer-minted values are readable inside a linked provider", () => {
  it("a separately linked package reads the consumer's object literal", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5225-"));
    const packageRoot = join(root, "node_modules", "obj5225");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "obj5225", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(
      entry,
      `import { readX, typeofX, sumXY, keysOf, readNested, callM, hasX } from "obj5225";\n${CONSUMER_PROBES}`,
    );

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
        [entry]: `import { readX, typeofX, sumXY, keysOf, readNested, callM, hasX } from "./provider";\n${CONSUMER_PROBES}`,
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
