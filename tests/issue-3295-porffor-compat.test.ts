// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  PORFFOR_EFFECT_ENTRIES,
  PORFFOR_IR_COMMIT,
  PORFFOR_KIND_NAMES,
  PORFFOR_TYPE_ENTRIES,
  assertPorfforCommit,
  assertPorfforIrCompatibility,
  assertPorfforRendererInput,
  porfforRendererOutputText,
  type PorfforRendererInput,
} from "../src/ir/backend/porffor/compat.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const localPorfforRoot = join(here, "../vendor/Porffor");
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? localPorfforRoot;
const hasOptionalCheckout = existsSync(join(porfforRoot, "compiler/ir.js"));
const porfforSubmoduleConfig = readFileSync(join(here, "../.gitmodules"), "utf8")
  .split(/(?=^\[submodule )/m)
  .find((section) => section.startsWith('[submodule "porffor"]'));

function enumObject(entries: readonly (readonly [string, number])[]): Record<string, number> {
  return Object.fromEntries(entries);
}

function compatibleIrModule(): Record<string, unknown> {
  const K = Object.fromEntries(PORFFOR_KIND_NAMES.map((name, value) => [name, value]));
  return {
    K,
    KNames: [...PORFFOR_KIND_NAMES],
    T: enumObject(PORFFOR_TYPE_ENTRIES),
    FX: enumObject(PORFFOR_EFFECT_ENTRIES),
    N_KIND: 0,
    N_TYPE: 1,
    N_FX: 2,
    N_A: 3,
    N_B: 4,
    N_C: 5,
    Const: (type: number, literal: unknown) => [K.Const, type, 0, literal, 0, 0],
    Alloc: (bytes: unknown, typeId: number) => [K.Alloc, 7, 4, bytes, typeId, 0],
  };
}

function rendererProbe(retType = 0): PorfforRendererInput {
  return {
    funcs: [
      {
        name: "js2_compat_probe",
        index: 0,
        params: [],
        retType,
        locals: {},
        body: [],
      },
    ],
    data: [],
    globals: [],
    entry: null,
    prefs: { gc: false },
    usedTypes: new Set<number>(),
  };
}

describe("#3295 Porffor compatibility fingerprint", () => {
  it("accepts the frozen K/T/FX enums and six-slot node layout", () => {
    expect(() => assertPorfforIrCompatibility(compatibleIrModule())).not.toThrow();
  });

  it("reports the first enum drift with the expected pin and migration action", () => {
    const candidate = compatibleIrModule();
    const K = { ...(candidate.K as Record<string, number>), Load: 25, Store: 24 };
    expect(() => assertPorfforIrCompatibility({ ...candidate, K })).toThrow(
      new RegExp(`K enum differs at ordinal 24: expected Load=24, received Store=24[\\s\\S]*${PORFFOR_IR_COMMIT}`),
    );
  });

  it("rejects the removed pre-alpha 4 Alloc metadata payload", () => {
    const candidate = compatibleIrModule();
    const K = candidate.K as Record<string, number>;
    expect(() =>
      assertPorfforIrCompatibility({
        ...candidate,
        Alloc: (bytes: unknown, typeId: number) => [K.Alloc, 7, 4, bytes, typeId, [0, false]],
      }),
    ).toThrow(/six-slot Alloc probe differs at slot 5: expected 0, received 0,false/);
  });

  it("rejects a different checkout before unstable modules are consumed", () => {
    expect(() => assertPorfforCommit("0000000000000000000000000000000000000000")).toThrow(
      /checked-out commit does not match[\s\S]*Initialize vendor\/Porffor/,
    );
  });
});

describe("#3295 Porffor renderer records", () => {
  it("accepts the frozen module and function record shape", () => {
    expect(() => assertPorfforRendererInput(rendererProbe())).not.toThrow();
  });

  it("fails before rendering when a required function field is absent", () => {
    const probe = rendererProbe();
    const func = probe.funcs[0]!;
    const { locals: _locals, ...withoutLocals } = func;
    expect(() => assertPorfforRendererInput({ ...probe, funcs: [withoutLocals] })).toThrow(
      /funcs\[0\] is missing required field locals/,
    );
  });

  it("rejects malformed nodes and unsupported renderer output shapes", () => {
    const probe = rendererProbe();
    const func = probe.funcs[0]!;
    expect(() =>
      assertPorfforRendererInput({
        ...probe,
        funcs: [{ ...func, body: [[0, 0, 0, 0, 0]] }],
      }),
    ).toThrow(/six-slot \[kind, type, effects, a, b, c\] node/);
    expect(() => porfforRendererOutputText({} as never)).toThrow(/renderer returned neither C text/);
  });
});

describe("#3295 optional Porffor loader", () => {
  it("keeps checkout optional while surfacing a mismatched Porffor gitlink", () => {
    expect(porfforSubmoduleConfig).toBeDefined();
    expect(porfforSubmoduleConfig).toMatch(/^\s*update = none$/m);
    expect(porfforSubmoduleConfig).toMatch(/^\s*ignore = dirty$/m);
    expect(porfforSubmoduleConfig).not.toMatch(/^\s*ignore = all$/m);
  });

  it("gives an actionable unavailable diagnostic without making Porffor mandatory", async () => {
    const missingRoot = join(here, "fixtures/porffor-intentionally-absent");
    await expect(loadOptionalPorffor({ root: missingRoot })).rejects.toThrow(
      new RegExp(`Optional Porffor backend is unavailable[\\s\\S]*${PORFFOR_IR_COMMIT}[\\s\\S]*Core JS2 builds`),
    );
  });

  const optionalIt = hasOptionalCheckout ? it : it.skip;
  optionalIt("loads the pinned checkout dynamically and renders the frozen input shape", async () => {
    const porffor = await loadOptionalPorffor({ root: porfforRoot });
    expect(porffor.commit).toBe(PORFFOR_IR_COMMIT);
    expect(porffor.ir.K.Load).toBe(24);
    expect(porffor.ir.T.ptr).toBe(7);
    expect(porffor.ir.FX.writeLocal).toBe(16);
    const bytes = porffor.ir.Const(porffor.ir.T.i32, 8);
    expect(porffor.ir.Alloc(bytes, 0)).toEqual([porffor.ir.K.Alloc, porffor.ir.T.ptr, porffor.ir.FX.call, bytes, 0, 0]);

    const output = porffor.render(rendererProbe(porffor.ir.T.none));
    const c = porfforRendererOutputText(output);
    expect(c).toContain("void p0_js2_compat_probe(void)");
  });
});
