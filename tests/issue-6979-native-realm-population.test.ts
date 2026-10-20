// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { populationFixture, fillPopulationDependencies } from "./helpers/native-realm-population.js";
import {
  reserveNativeRealmPopulation,
  fillNativeRealmPopulation,
  requireCompletedNativeRealmPopulation,
} from "../src/backend/wasmgc/resources/native-realm-population.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";
import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { NATIVE_REALM_CATALOG } from "../src/runtime/contracts/native-realm-catalog.js";
import { planNativeStringLiteral } from "../src/runtime/wasmgc/values/string-literal-bodies.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
describe("real public catalog population initializer owner, not full realm completion", () => {
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])("fills the original initializer with all catalog slots displaced=%s decoded=%s", async (displaced, decoded) => {
    const started = performance.now();
    const f = populationFixture(displaced, decoded);
    console.info("population owner phase", { displaced, decoded, phase: "reserve", ms: performance.now() - started });
    await setImmediate();
    expect(f.population.initialize).toBe(f.declarations.initialize);
    expect(f.declarations.entries).toHaveLength(44);
    expect(NATIVE_REALM_CATALOG.intrinsics).toHaveLength(45);
    expect(() => requireCompletedNativeRealmPopulation(f.tx, f.population)).toThrow(/missing canonical/);
    fillPopulationDependencies(f);
    await setImmediate();
    console.info("population owner phase", {
      displaced,
      decoded,
      phase: "dependencies",
      ms: performance.now() - started,
    });
    fillNativeRealmPopulation(f.tx, f.population);
    await setImmediate();
    console.info("population owner phase", {
      displaced,
      decoded,
      phase: "initialize",
      ms: performance.now() - started,
    });
    expect(requireCompletedNativeRealmPopulation(f.tx, f.population)).toBe(f.population);
    await setImmediate();
    expect(f.population.completionScope).toBe("realm-population-initializer-only");
    expect(f.declarations.globals.wholeRealmReady.object.mutable).toBe(false);
    expect(f.declarations.globals.wholeRealmReady.object.init).toEqual([{ op: "i32.const", value: 0 }]);
    expect(f.module.declaredFuncRefs).toEqual(f.declarations.entries.map((entry) => entry.lifted.handle));
    expect(() => requireCompletedNativeObjectRealm(f.tx, f.declarations)).toThrow(/remain incomplete/);
    expect(() => fillNativeRealmPopulation(f.tx, f.population)).toThrow(/duplicate/);
    expect(() => f.tx.seal()).toThrow(/missing function fill/);
    console.info("population owner phase", { displaced, decoded, phase: "verified", ms: performance.now() - started });
  });
  it("refuses copied owners, foreign transactions, duplicate claims and wrong original closure ownership", () => {
    const f = populationFixture(),
      foreign = populationFixture(true);
    expect(() => requireCompletedNativeRealmPopulation(f.tx, { ...f.population })).toThrow(/foreign or copied/);
    expect(() => requireCompletedNativeRealmPopulation(foreign.tx, f.population)).toThrow(/foreign or copied/);
    expect(() => reserveNativeRealmPopulation(f.tx, f.populationDependencies)).toThrow(/already has/);
    expect(() =>
      reserveNativeRealmPopulation(f.tx, {
        ...f.populationDependencies,
        descriptors: f.pack,
        descriptorDependencies: f.dependencies,
      }),
    ).toThrow(/different actual closure owner/);
    expect(() =>
      reserveNativeRealmPopulation(f.tx, {
        ...f.populationDependencies,
        realm: { ...f.declarations },
      }),
    ).toThrow(/foreign|copied/);
  });
  it("does not fill before genuine dependencies or after reservation closes", () => {
    const f = populationFixture();
    expect(() => fillNativeRealmPopulation(f.tx, f.population)).toThrow(/invalid phase/);
    f.tx.freezeReservations();
    expect(() => fillNativeRealmPopulation(f.tx, f.population)).toThrow(/missing canonical/);
    expect(() => reserveNativeRealmPopulation(f.tx, f.populationDependencies)).toThrow(/reservation phase/);
  });
  it("rejects descriptors completed with a different actual exception tag", () => {
    const f = populationFixture();
    fillPopulationDependencies(f, f.exception);
    expect(() => fillNativeRealmPopulation(f.tx, f.population)).toThrow(/different expected exception owner/);
    expect(f.module.declaredFuncRefs).toEqual([]);
  });
  it("reauthenticates the captured original dependency identities", async () => {
    const f = populationFixture();
    fillPopulationDependencies(f);
    await setImmediate();
    const original = f.populationDependencies.descriptors;
    f.populationDependencies.descriptors = { ...original };
    expect(() => fillNativeRealmPopulation(f.tx, f.population)).toThrow(/substituted dependency identity/);
    f.populationDependencies.descriptors = original;
    fillNativeRealmPopulation(f.tx, f.population);
    expect(requireCompletedNativeRealmPopulation(f.tx, f.population)).toBe(f.population);
  });
  it("rejects a receipt-valid replacement of the actual initializer", () => {
    const f = populationFixture();
    fillPopulationDependencies(f);
    const fill = f.tx.fillFunction.bind(f.tx);
    vi.spyOn(f.tx, "fillFunction").mockImplementation((token, body) =>
      fill(token, token === f.population.initialize ? { locals: [], body: [] } : body),
    );
    fillNativeRealmPopulation(f.tx, f.population);
    expect(() => requireCompletedNativeRealmPopulation(f.tx, f.population)).toThrow(/noncanonical function definition/);
  });
  it.each(["state", "literal", "singleton"])("rejects receipt-valid %s substitution before population", (kind) => {
    const f = populationFixture();
    const name = requireNativeStringLiteral(f.tx, f.strings, "name");
    if (name.kind !== "global") throw Error("native short literal required");
    const target =
      kind === "state"
        ? f.declarations.globals.state
        : kind === "literal"
          ? name.global
          : f.declarations.objectPrototype.singleton;
    const fill = f.tx.fillGlobal.bind(f.tx);
    vi.spyOn(f.tx, "fillGlobal").mockImplementation((token, init) =>
      fill(
        token,
        token === target
          ? kind === "state"
            ? [{ op: "i32.const", value: 2 }]
            : kind === "literal"
              ? (() => {
                  const plan = planNativeStringLiteral(f.strings.layout, false, "wrong name");
                  if (plan.kind !== "global") throw Error("short literal required");
                  return plan.init;
                })()
              : [{ op: "ref.null", typeIdx: f.realmLayouts.types.ordinary.typeIndex }]
          : init,
      ),
    );
    fillPopulationDependencies(f);
    expect(() => fillNativeRealmPopulation(f.tx, f.population)).toThrow(/noncanonical global initializer/);
    expect(f.module.declaredFuncRefs).toEqual([]);
  });
  it("interrupted initializer fill cannot be retried or certified", () => {
    const f = populationFixture();
    fillPopulationDependencies(f);
    const fill = f.tx.fillFunction.bind(f.tx);
    vi.spyOn(f.tx, "fillFunction").mockImplementation((token, definition) => {
      if (token === f.population.initialize) throw Error("injected interruption");
      fill(token, definition);
    });
    expect(() => fillNativeRealmPopulation(f.tx, f.population)).toThrow(/injected interruption/);
    vi.restoreAllMocks();
    expect(() => fillNativeRealmPopulation(f.tx, f.population)).toThrow(/interrupted fill/);
    expect(() => requireCompletedNativeRealmPopulation(f.tx, f.population)).toThrow(/missing canonical/);
  });
});
