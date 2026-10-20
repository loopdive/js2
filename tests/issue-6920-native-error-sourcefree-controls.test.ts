// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";

for (const rethrow of [false, true]) {
  it(`one source-free program preserves actual TDZ/catch/finally across four native projections, rethrow=${rethrow}`, async () => {
    const text = rethrow
      ? "export var visits:number=0; export function run():number { let result:number=0; try { result=value; } catch(error) { throw error; } finally { visits=visits+1; } return result; } const value:number=4;"
      : "export function run():number { let result:number=0; try { result=value; } catch(error) { result=7; } return result; } const value:number=4;";
    const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    const runtimePolicies = (["linear", "wasmgc"] as const).flatMap((backend) =>
      (["standalone", "wasi"] as const).map((target) => ({ backend, target })),
    );
    const prepared = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { backend: "linear", target: "standalone" },
      runtimePolicies,
      deferTopLevelInit: true,
      linearVectorProjection: "native-f64",
    });
    expect(prepared.kind, JSON.stringify(prepared)).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
    for (const program of [prepared.program, decodePreparedIrProgram(encodePreparedIrProgram(prepared.program))]) {
      for (const { backend, target } of runtimePolicies) {
        const accepted = acceptPreparedIrProgram(program, {
          backend,
          target,
          moduleName: "native-error-sourcefree",
          sourceMap: false,
          utf8Storage: false,
          sharedExceptionTag: false,
        });
        expect(accepted.kind, `${backend}/${target}: ${JSON.stringify(accepted)}`).toBe("accepted");
        if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
        expect(accepted.program).toBe(program);
        const emitted = emitAcceptedIrProgram(accepted);
        const binary = new Uint8Array(emitBinary(emitted.module));
        expect(WebAssembly.validate(binary), `${backend}/${target}`).toBe(true);
        expect(WebAssembly.Module.imports(new WebAssembly.Module(binary))).toEqual([]);
        const { instance } = await WebAssembly.instantiate(binary, {});
        if (rethrow) {
          let error: unknown;
          try {
            Reflect.apply(instance.exports.run as Function, undefined, []);
          } catch (thrown) {
            error = thrown;
          }
          expect(error).toBeInstanceOf(WebAssembly.Exception);
          expect((instance.exports.visits as WebAssembly.Global).value).toBe(1);
        } else expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(7);
        Reflect.apply(
          (target === "wasi" ? instance.exports._start : instance.exports.__module_init) as Function,
          undefined,
          [],
        );
        if (rethrow) expect((instance.exports.visits as WebAssembly.Global).value).toBe(0);
        expect(Reflect.apply(instance.exports.run as Function, undefined, [])).toBe(4);
        if (rethrow) expect((instance.exports.visits as WebAssembly.Global).value).toBe(1);
      }
    }
  });
}
