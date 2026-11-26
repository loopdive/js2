// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7380 PR 1 — the Prepared path's self-checks (the ledger's layout audit and the thrown native-slot probes) run
// only with JS2WASM_VALIDATE_PREPARED=1. Production compiles skip them; vitest.config.ts turns them on. The switch
// changes compile time only: the same program gives the same bytes either way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyIrPreparationData } from "../src/ir/analysis/alloc-registry.js";
import { createEmptyModule } from "../src/ir/types.js";
import { preparedIrDataMismatch } from "../src/ir/program/data.js";
import { preparedValidationEnabled, setPreparedValidation } from "../src/shared/contracts/prepared-validation.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";

const FLAG = "JS2WASM_VALIDATE_PREPARED";
const atStart = preparedValidationEnabled();
afterEach(() => setPreparedValidation(atStart));

async function freshRead(value: string | undefined): Promise<boolean> {
  const saved = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    vi.resetModules();
    const fresh = await import("../src/shared/contracts/prepared-validation.js");
    return fresh.preparedValidationEnabled();
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
}

describe("#7380 — the switch", () => {
  it("is off for a production compile (variable unset) and on only for exactly `1`", async () => {
    expect(await freshRead(undefined)).toBe(false);
    expect(await freshRead("0")).toBe(false);
    expect(await freshRead("true")).toBe(false);
    expect(await freshRead("1")).toBe(true);
  });

  it("is set by vitest.config.ts, so tests run the checks unless the caller turned them off", () => {
    expect(process.env[FLAG]).toBeDefined();
    expect(atStart).toBe(process.env[FLAG] === "1");
  });
});

describe("#7380 — what the checks still refuse when on", () => {
  // The seeded alteration of tests/issue-3518-module-reservations.test.ts ("rejects changed NaN payload bits"):
  // a completed body changed behind the ledger's back.
  const alteredCompletedFunction = (): PhysicalModuleReservations => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const fn = tx.reserveFunction("unit:main", "main", { params: [], results: [] });
    tx.freezeReservations();
    const constant = { op: "f64.const" as const, value: 1 };
    tx.fillFunction(fn, { locals: [], body: [constant, { op: "drop" }] });
    constant.value = 2;
    return tx;
  };

  it("the layout audit refuses an altered completed function when on, and is skipped when off", () => {
    setPreparedValidation(true);
    expect(() => alteredCompletedFunction().seal()).toThrow("altered completed function");
    setPreparedValidation(false);
    expect(alteredCompletedFunction().seal().completedFunctions).toBe(1);
  });

  // The erased-prototype collection of tests/issue-3518-native-authentication-performance.test.ts.
  it("the slot probe finds a collection with an erased prototype when on, and is skipped when off", () => {
    const forged = (): object => Object.setPrototypeOf(new Map(), null) as object;
    setPreparedValidation(true);
    expect(preparedIrDataMismatch(forged(), forged())).toBe("$root (non-data object)");
    setPreparedValidation(false);
    expect(preparedIrDataMismatch(forged(), forged())).toBeUndefined();
    // A genuine collection is still told apart by the prototype check beside the probe.
    expect(preparedIrDataMismatch(new WeakMap(), new WeakMap())).toBe("$root (non-data object)");
  });

  // copyIrPreparationData's two probes, each seen through the slot it finds behind an erased prototype.
  it.each([
    ["Date", () => new Date(0), "unsupported Date instance"],
    ["collection", () => new WeakSet(), "unsupported collection prototype"],
  ] as const)("the preparation-data %s probe runs when on and is skipped when off", (_kind, make, refusal) => {
    const forged = (): object => ({ value: Object.setPrototypeOf(make(), null) as object });
    setPreparedValidation(true);
    expect(() => copyIrPreparationData(forged())).toThrow(refusal);
    setPreparedValidation(false);
    expect(Object.getPrototypeOf(copyIrPreparationData(forged()).value)).toBeNull();
    // A genuine one keeps the same refusal text either way.
    expect(() => copyIrPreparationData({ value: make() })).toThrow(refusal);
  });
});

describe("#7380 — the switch does not change the output", () => {
  const options = (fileName: string): Test262CompileOptions =>
    ({
      wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
      backend: "wasmgc",
      target: "standalone",
      fileName,
      allowJs: true,
      sourceMap: false,
      optimize: false,
      emitWat: false,
    }) as Test262CompileOptions;
  const programs: [string, string, string][] = [
    ["numeric", "test.js", "var x = 1; x = x + 1; if (x !== 2) throw 1;"],
    ["string", "test.js", 'function f() { var s = "ab"; if (s !== "ab" || s.length !== 2) throw 1; }\nf();'],
    [
      "dynamic",
      "test.ts",
      "function f(v: any, w: any) { var r: any = w; for (let i = 0; i < 2; i = i + 1) { var x; if (i === 0) x = v; else r = x; } return r; } if (f(5, 0) !== 5) throw 1;",
    ],
  ];

  it.each(programs)("%s: identical bytes with the checks on and off", async (_name, fileName, source) => {
    const bytes: Uint8Array[] = [];
    for (const on of [true, false]) {
      setPreparedValidation(on);
      expect(preparedValidationEnabled()).toBe(on);
      const result = await compile(source, options(fileName));
      expect(result.errors.map((error) => error.message)).toEqual([]);
      bytes.push(result.binary);
    }
    expect(WebAssembly.validate(bytes[0]!)).toBe(true);
    expect(bytes[1]).toEqual(bytes[0]);
  });
});
