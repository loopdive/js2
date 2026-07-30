// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2952 slice 5 — runtime-dynamic for-in adoption.
//
// The IR owns only the non-fast externref carrier in this slice. Enumeration
// reuses #2964's key snapshot and per-visit liveness helpers; fast `$AnyValue`
// and typed receivers remain on the direct path.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { planIrCompilation } from "../src/ir/select.js";
import { buildImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const HAS_PROP = `
  export function hasProp(obj: any): boolean {
    for (var _ in obj) {
      return true;
    }
    return false;
  }
`;

function selectionFor(source: string, dynamicReceiver: boolean): Set<string> {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true);
  return planIrCompilation(sf, {
    experimentalIR: true,
    isDynamicForInReceiver: () => dynamicReceiver,
  }).funcs;
}

async function compileFunction(
  source: string,
  options: { target?: "standalone"; fast?: boolean } = {},
): Promise<{
  fn: (value: unknown) => unknown;
  emitted: ReadonlySet<string>;
}> {
  const result = await compile(source, {
    fileName: "test.ts",
    experimentalIR: true,
    trackIrOutcomes: true,
    ...options,
  });
  if (!result.success) {
    throw new Error(result.errors.map((error) => error.message).join("\n"));
  }
  const imports = buildImports(result.imports as never, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as never);
  if (typeof (imports as { setExports?: (exports: unknown) => void }).setExports === "function") {
    (imports as { setExports: (exports: unknown) => void }).setExports(instance.exports);
  }
  const emitted = new Set(
    (result.irOutcomes ?? []).filter((outcome) => outcome.kind === "emitted").map((outcome) => outcome.displayName),
  );
  return {
    fn: (instance.exports as { hasProp: (value: unknown) => unknown }).hasProp,
    emitted,
  };
}

describe("#2952 slice 5 — dynamic for-in selection", () => {
  it("claims only when the caller certifies the non-fast dynamic receiver", () => {
    expect(selectionFor(HAS_PROP, true).has("hasProp")).toBe(true);
    expect(selectionFor(HAS_PROP, false).has("hasProp")).toBe(false);
  });

  it("rejects typed receivers and wider head forms", () => {
    const typed = HAS_PROP.replace("obj: any", "obj: Record<string, number>");
    expect(selectionFor(typed, false).has("hasProp")).toBe(false);
    expect(selectionFor(HAS_PROP.replace("var _", "let _"), true).has("hasProp")).toBe(false);
    expect(selectionFor(HAS_PROP.replace("var _", "_"), true).has("hasProp")).toBe(false);
    expect(selectionFor(HAS_PROP.replace("return true", "return _"), true).has("hasProp")).toBe(false);
  });
});

describe("#2952 slice 5 — dynamic for-in runtime", () => {
  it("emits hasProp through IR and distinguishes empty, own, and inherited keys", async () => {
    const { fn, emitted } = await compileFunction(HAS_PROP);
    expect(emitted.has("hasProp")).toBe(true);
    expect(fn({})).toBe(0);
    expect(fn({ own: 1 })).toBe(1);
    expect(fn(Object.create({ inherited: 1 }))).toBe(1);
  });

  it("keeps the fast dynamic carrier on the direct path", async () => {
    const { emitted } = await compileFunction(HAS_PROP, { fast: true });
    expect(emitted.has("hasProp")).toBe(false);
  });

  it("registers and instantiates the standalone #2964 helper path", async () => {
    const { emitted } = await compileFunction(HAS_PROP, { target: "standalone" });
    expect(emitted.has("hasProp")).toBe(true);
  });
});
