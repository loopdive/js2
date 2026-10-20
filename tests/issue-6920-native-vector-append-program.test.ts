// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import * as growth from "../src/ir/program/native-vector-growth-source.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { completedNumericAppendPresentation } from "../src/compiler/native-numeric-append-presentation.js";
import { emitBinary } from "../src/emit/binary.js";
import { verifyNativeAllocationEvidence } from "../src/ir/analysis/allocation-evidence/structured-vector-profile.js";
import { nativeModuleGlobalEvidence } from "../src/ir/program/native-module-vector-context.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const source = `
const globalVector = [2,5];
function add(a:number[], n:number):number { return a.push(n); }
export function local():number { const a=[2,5]; return a.push(11)+a.length+a[2]; }
export function empty():number { const a:number[]=[]; return a.push(11)+a.length+a[0]; }
export function aliases():number { const a=[2,5];const b=a;let i=0;while(i<44){b.push(i+.5);i++;}return a.length*100+a[45]+b[2]; }
export function callee():number { const a=[2,5];return add(a,11)+a.push(13)+a.length+a[3]; }
export function nested():number { const a=[2,5];return a.push(add(a,7))+a.length+a[3]; }
export function global():number { return globalVector.push(11)+globalVector.length+globalVector[2]; }
export function outside():number { const a=[2,5];a.push(11);return a[3]; }
`;
let prepared: PreparedIrProgram;
beforeAll(() => {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  prepared = result.program;
});
afterEach(() => vi.restoreAllMocks());
for (const policy of policies)
  for (const replay of [false, true])
    it(`runs genuine prepared numeric append across aliases/calls/globals/nested append for ${policy.backend}/${policy.target}, codec=${replay}`, () => {
      const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(prepared)) : prepared;
      const forbidden = vi.spyOn(growth, "refuseUnbackedNativeNumericGrowth").mockImplementation(() => {
        throw Error("source replay forbidden");
      });
      assertPreparedIrProgram(program);
      const evidence = verifyNativeAllocationEvidence(
        program.ir,
        program.allocations,
        nativeModuleGlobalEvidence(program),
      );
      expect(evidence.kind).toBe("verified");
      if (evidence.kind !== "verified") throw Error(JSON.stringify(evidence));
      expect(evidence.profile).toBe("structured-numeric-vector-append-v1");
      expect(evidence.census.allocations).toBe(7);
      expect(evidence.census.vectorWrites).toBeGreaterThan(0);
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "append-program",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      const emitted = emitAcceptedIrProgram(accepted),
        binary = Uint8Array.from(emitBinary(emitted.module));
      const append = completedNumericAppendPresentation(program, emitted, accepted.options);
      expect(append?.bindingId).toBeDefined();
      expect(append?.supportKeys).toHaveLength(1);
      expect(() => completedNumericAppendPresentation(program, { ...emitted }, accepted.options)).toThrow();
      expect(WebAssembly.validate(binary)).toBe(true);
      const wasm = new WebAssembly.Module(binary);
      expect(WebAssembly.Module.imports(wasm)).toEqual([]);
      const e = new WebAssembly.Instance(wasm, {}).exports;
      if (e._start) Reflect.apply(e._start as Function, undefined, []);
      const run = (name: string) => Reflect.apply(e[name] as Function, undefined, []);
      for (const [name, expected] of [
        ["local", 17],
        ["empty", 13],
        ["aliases", 4644],
        ["callee", 24],
        ["nested", 11],
        ["global", 17],
      ] as const)
        expect(run(name), name).toBe(expected);
      expect(run("outside")).toBeNaN();
      expect(forbidden).not.toHaveBeenCalled();
    });
