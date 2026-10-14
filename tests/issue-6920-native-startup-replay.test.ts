// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";

for (const sourceTarget of ["standalone", "wasi"] as const) {
  for (const deferTopLevelInit of [false, true]) {
    it(`one semantic ${sourceTarget} program and codec execute four native projections, defer=${deferTopLevelInit}`, async () => {
      const source = analyzeMultiSource(
        {
          "./entry.ts": "export var visits:number=1; visits=visits+2; export function run():number{return visits;}",
        },
        "./entry.ts",
      );
      const runtimePolicies = (["linear", "wasmgc"] as const).flatMap((backend) =>
        (["standalone", "wasi"] as const).map((target) => ({ backend, target })),
      );
      const prepared = prepareWholeIrProgram({
        sourceFiles: source.sourceFiles,
        entrySource: source.entryFile,
        checker: source.checker,
        policy: { target: sourceTarget, backend: "linear" },
        runtimePolicies,
        deferTopLevelInit,
      });
      expect(prepared.kind).toBe("prepared");
      if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
      expect(prepared.program.startup.every((plan) => plan.invocation.deferTopLevelInit === deferTopLevelInit)).toBe(
        true,
      );
      for (const original of [prepared.program, decodePreparedIrProgram(encodePreparedIrProgram(prepared.program))]) {
        for (const { backend, target } of runtimePolicies) {
          const accepted = acceptPreparedIrProgram(original, {
            backend,
            target,
            sharedExceptionTag: false,
            utf8Storage: false,
            sourceMap: false,
            moduleName: "native-startup-replay",
          });
          expect(accepted.kind, `${backend}/${target}: ${JSON.stringify(accepted)}`).toBe("accepted");
          if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
          expect(accepted.program).toBe(original);
          const emitted = emitAcceptedIrProgram(accepted);
          const binary = new Uint8Array(emitBinary(emitted.module));
          expect(WebAssembly.validate(binary)).toBe(true);
          const { instance } = await WebAssembly.instantiate(binary, {});
          if (target === "wasi") {
            expect(instance.exports._start, `${backend}/${target} must publish actual _start`).toBeTypeOf("function");
            expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(0);
            Reflect.apply(instance.exports._start as Function, undefined, []);
          } else if (deferTopLevelInit) {
            expect(instance.exports.__module_init).toBeTypeOf("function");
            expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(0);
            Reflect.apply(instance.exports.__module_init as Function, undefined, []);
          }
          expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(3);
        }
      }
    });
  }
}
