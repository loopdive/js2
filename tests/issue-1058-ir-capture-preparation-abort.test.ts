// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { ProgramAbiTypeRegistry } from "../src/codegen/program-abi-type-planning.js";
import type { IrBindingId } from "../src/ir/identity.js";
import { irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["gc", "standalone"] as const)(
  "does not publish a source capture binding from aborted preparation (%s)",
  async (target) => {
    const survivingAtAbort: IrBindingId[][] = [];
    const capturedSubtypeBindings = new Set<IrBindingId>();
    const survivingTypesAtAbort: IrBindingId[][] = [];
    const prepareLayouts = ProgramAbiTypeRegistry.prototype.prepareClosureSupportLayouts;
    vi.spyOn(ProgramAbiTypeRegistry.prototype, "prepareClosureSupportLayouts").mockImplementation(function (
      this: ProgramAbiTypeRegistry,
      ...args
    ) {
      const layouts = prepareLayouts.apply(this, args);
      args[0].forEach((request, index) => {
        if (request.role === "allocate" && request.captureFieldTypes.length > 0) {
          capturedSubtypeBindings.add(layouts[index]!.capturedSubtypeRef.binding.bindingId);
        }
      });
      return layouts;
    });
    const beginScope = ProgramAbiSession.prototype.beginPreparedComponentScope;
    vi.spyOn(ProgramAbiSession.prototype, "beginPreparedComponentScope").mockImplementation(function (
      this: ProgramAbiSession,
      ...args
    ) {
      const scope = beginScope.apply(this, args);
      const captures = this.inventory.allUnits
        .filter(
          (unit) =>
            unit.kind === "arrow-function" && unit.terminalOwnerId !== null && args[1].includes(unit.terminalOwnerId),
        )
        .map((unit) => irUnitCallableBindingId(unit.id));
      const abort = scope.abort.bind(scope);
      vi.spyOn(scope, "abort").mockImplementation(() => {
        abort();
        if (captures.length > 0) {
          survivingAtAbort.push(captures.filter((id) => this.hasPlan(id)));
          survivingTypesAtAbort.push([...capturedSubtypeBindings].filter((id) => this.hasPlan(id)));
        }
      });
      return scope;
    });
    vi.stubEnv("JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE", "1");
    const result = await compile(
      `export function run(): number {
        let value: number | undefined;
        const read = (): number => value === undefined ? 1 : 2;
        const before = read();
        value = 42;
        return before * 10 + read();
      }`,
      { target, experimentalIR: true, trackIrOutcomes: true },
    );
    // Floor the observed abort count: a missing preparation path is not proof
    // of rollback. Check at abort, before fallback can legitimately replan.
    expect(survivingAtAbort.length).toBeGreaterThan(0);
    expect(survivingAtAbort.flat()).toEqual([]);
    expect(capturedSubtypeBindings.size).toBeGreaterThan(0);
    expect(survivingTypesAtAbort.flat()).toEqual([]);
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const module = new WebAssembly.Module(result.binary);
    if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = new WebAssembly.Instance(module, imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.run as () => number)()).toBe(12);
  },
);
