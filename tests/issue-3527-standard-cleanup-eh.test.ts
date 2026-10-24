// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { buildStandardRethrowingTry } from "../src/wasm/physical/exception-control.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitObject } from "../src/emit/object.js";
import { emitWat } from "../src/emit/wat.js";
import { stackBalance } from "../src/codegen/stack-balance.js";

for (const [name, emit] of [
  ["binary", emitBinary],
  ["object", emitObject],
] as const)
  for (const balance of [false, true])
    it(`preserves foreign exceptions through nested standard cleanup (${name}, balance=${balance})`, () => {
      const module = createEmptyModule(),
        tx = new PhysicalModuleReservations(module);
      const operation = tx.reserveFunctionImport("operation", "control", "operation", { params: [], results: [] });
      const count = tx.reserveGlobal("count", "count", { kind: "i32" }, true);
      const run = tx.reserveFunction("run", "run", { params: [], results: [] });
      tx.freezeReservations();
      tx.fillGlobal(count, [{ op: "i32.const", value: 0 }]);
      const cleanup = () => [
        { op: "global.get" as const, index: tx.physicalIndex(count) },
        { op: "i32.const" as const, value: 1 },
        { op: "i32.add" as const },
        { op: "global.set" as const, index: tx.physicalIndex(count) },
      ];
      tx.fillFunction(run, {
        locals: [],
        body: [
          buildStandardRethrowingTry(
            [buildStandardRethrowingTry([{ op: "call", funcIdx: operation.handle }], cleanup())],
            cleanup(),
          ),
        ],
      });
      tx.defineExport("export:run", "run", run);
      tx.defineExport("export:count", "count", count);
      tx.seal();
      if (balance) stackBalance(module);
      const wat = emitWat(module);
      expect(wat).toContain("(ref exn)");
      expect(wat).toContain("throw_ref");
      let shouldThrow = false,
        thrown: unknown;
      const api = new WebAssembly.Instance(new WebAssembly.Module(emit(module) as BufferSource), {
        control: {
          operation() {
            if (shouldThrow) throw thrown;
          },
        },
      }).exports as { run: () => void; count: WebAssembly.Global };
      api.run();
      expect(api.count.value).toBe(0);
      const foreign = new WebAssembly.Tag({ parameters: ["i32", "externref", "f64"] });
      const payload = { original: true };
      const exception = new WebAssembly.Exception(foreign, [7, payload, 3.25]);
      for (const value of [exception, payload, undefined]) {
        thrown = value;
        shouldThrow = true;
        api.count.value = 0;
        let caught = false;
        try {
          api.run();
        } catch (error) {
          caught = true;
          expect(Object.is(error, value)).toBe(true);
        }
        expect(caught).toBe(true);
        expect(api.count.value).toBe(2);
      }
      expect(exception.getArg(foreign, 0)).toBe(7);
      expect(exception.getArg(foreign, 1)).toBe(payload);
      expect(exception.getArg(foreign, 2)).toBe(3.25);
    });
