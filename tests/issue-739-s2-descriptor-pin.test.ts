// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #739 S2 — HOST-lane descriptor-object representation pinning.
//
// §6.2.5.5 ToPropertyDescriptor reads every descriptor field via a full [[Get]],
// so an ACCESSOR field on the descriptor object must invoke its getter. #739 S1
// pinned runtime-store-define RECEIVERS to `$Object`, but its pre-pass
// (`collectEmptyObjectWidening`) only reaches vars initialized with an EMPTY `{}`
// literal. A NON-EMPTY literal that later receives a runtime-store-routed define
// stayed a widened closed struct, so the accessor landed in the `_wasmPropDescs`
// sidecar while the struct-field reader read the struct — and the getter never
// fired. Same two-store defect as #739, but on the DESCRIPTOR object rather than
// the receiver.
//
// MEASURED A/B on the fix's merge base vs the fix (16-case matrix, varied axes):
// merge base 6/16 -> with fix 13/16, all four struct-path guards passing in BOTH
// arms. The cases below are the ones that FLIP; each is red on the merge base.
//
// ⚠️ METHOD (this area is where the propertyHelper/verifyProperty vacuity class
// lives, #3468/#3592/#3434): every assertion here checks an OBSERVABLE getter
// invocation via a mutated flag, never merely "no throw". A suite built on the
// absence of a symptom would pass on unmodified main and cover nothing — that
// exact failure mode was hit three separate times while investigating this issue.
// The `{}`-initializer cases are deliberately kept as CONTROLS: they pass on the
// merge base too, so they must NOT be read as evidence the fix works.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) throw new Error("compile error: " + result.errors.map((e) => e.message).join("; "));
  if (!WebAssembly.validate(result.binary)) throw new Error("invalid wasm");
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: WebAssembly.Exports) => void }).setExports?.(instance.exports);
  return (instance.exports as { run: () => unknown }).run();
}

// Builds a probe whose result is 'yes' ONLY if the descriptor field's getter ran.
function accessorFieldProbe(declarator: string, field: string, key = "p"): string {
  return `export function run(): string {
    let accessed = 'no';
    ${declarator}
    Object.defineProperty(d, '${field}', {
      get: function (): any { accessed = 'yes'; return true; }
    });
    const o: any = {};
    Object.defineProperty(o, '${key}', d);
    return accessed;
  }`;
}

describe("#739 S2 — descriptor-object pinning (host)", () => {
  // --- The core A/B. RED on the merge base: the non-empty initializer is the
  // only axis that differs from the passing control below. ---
  it("non-empty literal descriptor: accessor field getter fires", async () => {
    expect(await runHost(accessorFieldProbe("const d: any = { value: 1 };", "configurable"))).toBe("yes");
  });

  it("non-empty literal with several data fields: accessor getter fires", async () => {
    expect(await runHost(accessorFieldProbe("const d: any = { value: 1, writable: true };", "configurable"))).toBe(
      "yes",
    );
  });

  // --- Axis: WHICH descriptor field carries the accessor. All four are red on
  // the merge base, so this is not one case restated four times. ---
  for (const field of ["configurable", "enumerable", "writable", "value"]) {
    it(`accessor on descriptor field '${field}' fires its getter`, async () => {
      expect(await runHost(accessorFieldProbe("const d: any = { value: 1 };", field))).toBe("yes");
    });
  }

  // --- Axis: receiver key kind. A numeric key takes a different define route. ---
  it("numeric receiver key still consults the descriptor accessor", async () => {
    expect(await runHost(accessorFieldProbe("const d: any = { value: 1 };", "configurable", "0"))).toBe("yes");
  });

  // --- CONTROLS that pass on the merge base too. Present to pin the axis, NOT
  // as evidence of the fix. If one of these ever fails, the pin has gone too wide.
  it("CONTROL empty-{} descriptor already worked (must stay working)", async () => {
    expect(await runHost(accessorFieldProbe("const d: any = {}; d.value = 1;", "configurable"))).toBe("yes");
  });

  it("CONTROL Object.create descriptor already worked (must stay working)", async () => {
    expect(await runHost(accessorFieldProbe("const d: any = Object.create(null); d.value = 1;", "configurable"))).toBe(
      "yes",
    );
  });

  // --- GUARDS: the struct fast path must survive. These pass in BOTH arms; they
  // exist to catch the pin widening beyond descriptor objects (the #1897/#2837
  // closed-struct-consumer regression class). ---
  it("GUARD plain data descriptor keeps working", async () => {
    const src = `export function run(): number {
      const o: any = {};
      Object.defineProperty(o, 'p', { value: 42, writable: true, enumerable: true, configurable: true });
      return o.p;
    }`;
    expect(await runHost(src)).toBe(42);
  });

  it("GUARD non-empty literal used as an ordinary object is untouched", async () => {
    const src = `export function run(): number {
      const d: any = { value: 1, other: 2 };
      d.extra = 3;
      return d.value + d.other + d.extra;
    }`;
    expect(await runHost(src)).toBe(6);
  });

  it("GUARD arithmetic on literal fields keeps the struct contract (#1897)", async () => {
    const src = `export function run(): number {
      const p: any = { x: 10, y: 4 };
      return p.x - p.y;
    }`;
    expect(await runHost(src)).toBe(6);
  });

  it("GUARD acorn-shaped literal consumed only by defineProperties", async () => {
    const src = `export function run(): string {
      const accessors: any = { inFunction: { configurable: true } };
      const target: any = {};
      Object.defineProperties(target, accessors);
      return typeof target;
    }`;
    expect(await runHost(src)).toBe("object");
  });
});

// Documented residuals — NOT fixed by this slice, asserted so the boundary is
// explicit and a future widening is noticed rather than assumed.
describe("#739 S2 — known residuals (documented, not fixed here)", () => {
  it("descriptor returned from a function is still missed (name-based pre-pass)", async () => {
    const src = accessorFieldProbe("function mk(): any { return { value: 1 }; } const d: any = mk();", "configurable");
    expect(await runHost(src)).toBe("no");
  });

  it("defineProperties map MEMBER descriptor is still missed", async () => {
    const src = `export function run(): string {
      let accessed = 'no';
      const d: any = { value: 1 };
      Object.defineProperty(d, 'configurable', {
        get: function (): boolean { accessed = 'yes'; return true; }
      });
      const o: any = {};
      Object.defineProperties(o, { p: d });
      return accessed;
    }`;
    expect(await runHost(src)).toBe("no");
  });
});
