// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  imports.setExports?.(exports);
  return exports;
}

function outcome(result: CompileResult, unitKind: string, displayName: string): IrObservedOutcome {
  const observed = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === unitKind && candidate.displayName === displayName,
  );
  expect(observed, `terminal outcome count for ${unitKind} ${displayName}`).toHaveLength(1);
  return observed[0]!;
}

/**
 * #4494 — the selector enforces claim ⇔ lowering parity per unit, but claim ⇔
 * PREPARABILITY is a per-COMPONENT property. `derivePreparedComponentDependencies`
 * records a `class.new` as an exact unit-bound dependency on the constructed
 * class's constructor body, so a prepared component holding the constructing
 * owner but not that constructor can never seal. The ownership fixpoint in
 * `selectR2PreparedOwnerComponents` must therefore see construction edges, or a
 * newly-claimable constructing owner claims and then degrades after the fact.
 */
describe("#4494 claim ⇔ preparability parity over construction edges", () => {
  it.each(["gc", "standalone"] as const)(
    "withdraws a constructing owner whose constructor family is not preparable in the %s lane",
    async (target) => {
      // `A`'s constructor dispatches virtually on the receiver, so
      // `constructorHasIrSafeReceiverSemantics` rejects it and the prepared
      // class-member population excludes the whole A/B hierarchy. `run`
      // constructs `B`, so `run` cannot be part of any sealable component.
      const source = `
        let observed: number = 0;
        class A {
          constructor() { this.tag(); }
          tag(): void { observed = 1; }
        }
        class B extends A {
          constructor() { super(); }
          tag(): void { observed = 2; }
        }
        export function run(): number { new B(); return observed; }
      `;
      const result = await compile(source, {
        fileName: `issue-4494-unpreparable-constructor-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect((await instantiate(result)).run!()).toBe(2);

      // The acceptance gate: the widened claim must demote cleanly, not degrade
      // a prepared owner after claiming it.
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(outcome(result, "class-member", "A_new")).toMatchObject({
        kind: "unsupported",
        stage: "select",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
      // Withdrawal is per-unit: the class members that ARE preparable keep
      // emitting, and `run` stays available to the post-direct overlay.
      for (const name of ["A_tag", "B_new", "B_tag"] as const) {
        expect(outcome(result, "class-member", name)).toMatchObject({ kind: "emitted", irBodyEmitted: true });
      }
      expect(outcome(result, "function", "run")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    },
  );

  it.each(["gc", "standalone"] as const)(
    "keeps co-preparing a constructing owner whose constructor family IS preparable in the %s lane",
    async (target) => {
      // The minimal co-preparation shape: nothing here blocks the constructor,
      // so the construction edge must NOT withdraw anyone. This pins that the
      // new edge only ever narrows the population where sealing would fail.
      const source = `
        class Box {
          value: number;
          constructor(value: number) { this.value = value; }
          get(): number { return this.value; }
        }
        export function run(): number { return new Box(41).get() + 1; }
      `;
      const result = await compile(source, {
        fileName: `issue-4494-preparable-constructor-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect((await instantiate(result)).run!()).toBe(42);
      expect(result.irPostClaimErrors ?? []).toEqual([]);

      const constructing = outcome(result, "function", "run");
      const constructorOwner = outcome(result, "class-member", "Box_new");
      expect(constructing).toMatchObject({ kind: "emitted", irBodyEmitted: true });
      expect(constructorOwner).toMatchObject({ kind: "emitted", irBodyEmitted: true });
      // Co-preparation, not merely co-emission: one sealed component owns both.
      expect(constructing.preparedComponentId).toMatch(/^prepared-component:/);
      expect(constructing.preparedComponentId).toBe(constructorOwner.preparedComponentId);
    },
  );

  it.each(["gc", "standalone"] as const)(
    "does not withdraw a constructing owner over an implicit constructor in the %s lane",
    async (target) => {
      // An implicit constructor's `_init` is an AST-free support body that
      // sealing resolves without candidacy, so it must contribute no
      // construction edge — otherwise the fixpoint would withdraw owners that
      // prepare fine today.
      const source = `
        class Empty {
          tag(): number { return 7; }
        }
        export function run(): number { return new Empty().tag(); }
      `;
      const result = await compile(source, {
        fileName: `issue-4494-implicit-constructor-${target}.ts`,
        experimentalIR: true,
        trackIrOutcomes: true,
        target,
      });

      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(WebAssembly.validate(result.binary)).toBe(true);
      expect((await instantiate(result)).run!()).toBe(7);
      expect(result.irPostClaimErrors ?? []).toEqual([]);
      expect(outcome(result, "function", "run")).toMatchObject({ kind: "emitted", irBodyEmitted: true });
    },
  );
});
