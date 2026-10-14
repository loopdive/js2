// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedReferenceErrorResourceReceipt,
} from "../src/ir/program-consumer.js";
import { completedErrorPresentation } from "../src/compiler/ir-program-error-presentation.js";

for (const backend of ["linear", "wasmgc"] as const) {
  for (const target of ["standalone", "wasi"] as const) {
    it(`${backend}/${target}: presentation accepts issued Error closure and permanently refuses a changed constructor`, () => {
      const ast = analyzeMultiSource(
        {
          "./entry.ts":
            "export function run():number { let result:number=0; try { result=value; } catch(error) { result=7; } return result; } const value:number=4;",
        },
        "./entry.ts",
      );
      const options = {
        backend,
        target,
        moduleName: "error-presentation-controls",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      };
      const prepared = prepareWholeIrProgram({
        sourceFiles: ast.sourceFiles,
        entrySource: ast.entryFile,
        checker: ast.checker,
        policy: { backend, target },
        runtimePolicies: [{ backend, target }],
        deferTopLevelInit: true,
        linearVectorProjection: "native-f64",
      });
      expect(prepared.kind, JSON.stringify(prepared)).toBe("prepared");
      if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
      const accepted = acceptPreparedIrProgram(prepared.program, options);
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
      const emitted = emitAcceptedIrProgram(accepted);
      const receipt = emittedReferenceErrorResourceReceipt(emitted);
      expect(receipt).toBeDefined();
      if (!receipt) throw new Error("missing genuine Error receipt");
      const closure = completedErrorPresentation(prepared.program, emitted, options);
      expect(closure?.bindingId).toBe(receipt.bindingId);
      expect(closure?.supportKeys).toEqual(receipt.functions.map((row) => row.supportKey));
      expect(closure?.ownedRecords.has(emitted.module.functions[receipt.constructor.index]!)).toBe(true);
      expect(() => completedErrorPresentation(prepared.program, { ...emitted }, options)).toThrow();
      const errorConstructor = emitted.module.functions[receipt.constructor.index]!;
      const oldName = errorConstructor.name;
      errorConstructor.name = "__forged_ReferenceError";
      expect(() => completedErrorPresentation(prepared.program, emitted, options)).toThrow();
      errorConstructor.name = oldName;
      expect(() => completedErrorPresentation(prepared.program, emitted, options)).toThrow(
        "completion requested in failed",
      );
    });
  }
}
