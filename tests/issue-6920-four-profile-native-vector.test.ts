// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
const source =
  "export function run(a:number,b:number):number { const values=[a,b]; return values[0]+values[1]+values.length; }";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
let live: PreparedIrProgram;
let replay: PreparedIrProgram;
let encoded: string;
const observations: unknown[] = [];
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
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  live = result.program;
  encoded = encodePreparedIrProgram(live);
  replay = decodePreparedIrProgram(encoded);
  expect(live.runtime.map(({ backend, target }) => ({ backend, target }))).toEqual(policies);
  expect(encodePreparedIrProgram(replay)).toBe(encoded);
});

for (const backend of ["linear", "wasmgc"] as const)
  for (const target of ["standalone", "wasi"] as const)
    for (const decoded of [false, true]) {
      it(`same authentic all-four-policy program ${backend} ${target} decoded=${decoded}`, async () => {
        const program = decoded ? replay : live;
        const ir = program.ir;
        const abi = program.abi;
        const row: Record<string, unknown> = { backend, target, decoded };
        observations.push(row);
        try {
          const accepted = acceptPreparedIrProgram(program, {
            backend,
            target,
            moduleName: "gc-native-vector",
            sourceMap: false,
            utf8Storage: false,
            sharedExceptionTag: false,
          });
          row.acceptance = accepted.kind;
          if (accepted.kind !== "accepted") {
            row.refusal = accepted;
            throw new Error(JSON.stringify(accepted));
          }
          const emitted = emitAcceptedIrProgram(accepted);
          const bytes = Uint8Array.from(emitBinary(emitted.module));
          row.bytes = bytes.length;
          row.sha256 = createHash("sha256").update(bytes).digest("hex");
          row.valid = WebAssembly.validate(bytes);
          expect(row.valid).toBe(true);
          const module = await WebAssembly.compile(bytes);
          row.imports = WebAssembly.Module.imports(module);
          expect(row.imports).toEqual([]);
          const instance = await WebAssembly.instantiate(module, {});
          row.exports = Object.keys(instance.exports);
          if (typeof instance.exports._start === "function") instance.exports._start();
          const run = instance.exports.run;
          expect(typeof run).toBe("function");
          const values = [
            Reflect.apply(run as Function, undefined, [1.5, -2.25]),
            Reflect.apply(run as Function, undefined, [4, 9]),
          ];
          row.values = values;
          expect(values).toEqual([1.25, 15]);
          if (backend === "wasmgc")
            expect(row.sha256).toBe("9d0b81ec0f857912d0019f54d6ee6f1f5ce81aae9e7a34d5e4b433093aab3ca8");
        } catch (error) {
          row.error = { name: (error as Error).name, message: (error as Error).message, stack: (error as Error).stack };
          throw error;
        } finally {
          row.sameIr = program.ir === ir;
          row.sameAbi = program.abi === abi;
          row.sameEncoded = encodePreparedIrProgram(program) === encoded;
          expect(row.sameIr).toBe(true);
          expect(row.sameAbi).toBe(true);
          expect(row.sameEncoded).toBe(true);
          console.info("native-four-profile-row", JSON.stringify(row));
        }
      });
    }
