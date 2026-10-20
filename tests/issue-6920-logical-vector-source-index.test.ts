// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";

const cases = [
  ["zero", "0", 7],
  ["negativeZero", "-0", 7],
  ["one", "1", 11],
  ["half", "0.5", NaN],
  ["negativeHalf", "-0.5", NaN],
  ["notNumber", "0/0", NaN],
  ["positiveInfinity", "1/0", NaN],
  ["negativeInfinity", "-1/0", NaN],
  ["negativeOne", "-1", NaN],
  ["length", "2", NaN],
  ["large", "4294967296", NaN],
] as const;
let live: PreparedIrProgram;
let encoded: string;
beforeAll(() => {
  const source = cases
    .map(
      ([name, index]) => `export function ${name}(a:number,b:number):number { const xs=[a,b]; return xs[${index}]; }`,
    )
    .join("\n");
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "linear", target: "standalone" },
    runtimePolicies: [
      { backend: "linear", target: "standalone" },
      { backend: "linear", target: "wasi" },
    ],
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  live = result.program;
  encoded = encodePreparedIrProgram(live);
});

for (const target of ["standalone", "wasi"] as const)
  for (const replay of [false, true])
    it(`preserves numeric index identity before narrowing for ${target}, replay=${replay}`, async () => {
      const program = replay ? decodePreparedIrProgram(encoded) : live;
      const ir = program.ir,
        abi = program.abi;
      const result = acceptPreparedIrProgram(program, {
        backend: "linear",
        target,
        moduleName: "logical-index",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      if (result.kind !== "accepted") throw new Error(JSON.stringify(result));
      const bytes = Uint8Array.from(emitBinary(emitAcceptedIrProgram(result).module));
      expect(WebAssembly.validate(bytes)).toBe(true);
      const module = await WebAssembly.compile(bytes);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      const observations: Record<string, number | "NaN"> = {};
      for (const [name, , expected] of cases) {
        const actual = Reflect.apply(instance.exports[name] as Function, undefined, [7, 11]);
        observations[name] = Number.isNaN(actual) ? "NaN" : actual;
        if (Number.isNaN(expected)) expect(actual, name).toBeNaN();
        else expect(actual, name).toBe(expected);
      }
      console.info(
        "logical-source-index",
        JSON.stringify({
          target,
          replay,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          observations,
        }),
      );
      expect(program.ir).toBe(ir);
      expect(program.abi).toBe(abi);
      expect(encodePreparedIrProgram(program)).toBe(encoded);
    });

for (const target of ["standalone", "wasi"] as const)
  it(`keeps dynamic numeric indices outside the current finite preparation profile for ${target}`, () => {
    const ast = analyzeMultiSource(
      {
        "./entry.ts":
          "export function run(a:number,b:number,index:number):number { const xs=[a,b]; return xs[index]; }",
      },
      "./entry.ts",
    );
    const result = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { backend: "linear", target },
      runtimePolicies: [{ backend: "linear", target }],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.code).toBe("array-representation-unsupported");
  });
