// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ts } from "../src/ts-api.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayProgram, replayOptions } from "./helpers/ir-whole-program-replay.js";
import { inspectPreparedErrorCopy } from "./helpers/prepared-error-inspector.js";

const source =
  "let answer:number=0;try{answer=read();}catch(e){answer=17;}let value:number=3;function read():number{return value;}export function run():number{return answer*10+read();}";
function prepare(text = source) {
  return requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": text })));
}
function oracle(text: string): number {
  const javascript = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: { run?: () => number } = {};
  runInNewContext(javascript, { exports }, { timeout: 1000 });
  return exports.run!();
}
for (const decoded of [false, true])
  for (const utf8Storage of [false, true])
    it(`executes a genuine TDZ throw/catch and later read, decoded=${decoded}, utf8=${utf8Storage}`, async () => {
      expect(oracle(source)).toBe(173);
      const original = prepare(),
        encoded = encodePreparedIrProgram(original),
        program = decoded ? decodePreparedIrProgram(encoded) : original;
      expect(encodePreparedIrProgram(program)).toBe(encoded);
      const result = await replayProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
      if (result.kind !== "ran") throw Error(result.failure.detail);
      expect((result.run.exports.run as Function)()).toBe(173);
      expect(result.run.emitted.module.imports).toEqual([]);
      expect(program.inventory.terminalUnits).toHaveLength(3);
      if (!utf8Storage) {
        const copy = await inspectPreparedErrorCopy(result.run.emitted.module);
        expect((copy.run as Function)()).toBe(173);
        expect((copy.errorTag as Function)()).toBe(-16);
        expect((copy.messageAbsent as Function)()).toBe(1);
        const units = Array.from({ length: (copy.nameLength as Function)() }, (_, index) =>
          (copy.nameUnit as Function)(index),
        );
        expect(String.fromCharCode(...units)).toBe("ReferenceError");
        const caught = (copy.capturedError as Function)(),
          fresh = (copy.makeError as Function)(null);
        expect(Object.is(caught, fresh)).toBe(false);
      }
    });
it("preserves two separate abrupt evaluations before initialization", async () => {
  const text =
    "let trace:number=0;try{read();}catch(e){trace=trace*10+1;}try{read();}catch(e){trace=trace*10+2;}let value:number=3;function read():number{return value;}export function run():number{return trace*10+read();}";
  expect(oracle(text)).toBe(123);
  const result = await replayProgram(prepare(text), replayOptions("wasmgc", "standalone"));
  if (result.kind !== "ran") throw Error(result.failure.detail);
  expect((result.run.exports.run as Function)()).toBe(123);
});
it("propagates uncaught startup TDZ as a language exception", async () => {
  const text =
    "let early:number=read();let value:number=3;function read():number{return value;}export function run():number{return early;}";
  await expect(replayProgram(prepare(text), replayOptions("wasmgc", "standalone"))).rejects.toBeInstanceOf(
    WebAssembly.Exception,
  );
});
it("replays source TDZ in a guarded fresh process without the frontend", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp/native-tdz-replay-"));
  const encoded = join(directory, "program.json"),
    expected = join(directory, "oracle.json");
  writeFileSync(encoded, encodePreparedIrProgram(prepare()));
  writeFileSync(
    expected,
    JSON.stringify({
      targets: [{ backend: "wasmgc", target: "standalone" }],
      calls: [{ export: "run", args: [], expected: 173 }],
    }),
  );
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/ir-whole-program-replay.mjs", encoded, expected],
    { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
  );
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }),
  );
  if (child.error) throw child.error;
  expect(child.status, child.stderr + child.stdout).toBe(0);
  const report = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  expect(report.ok).toBe(true);
  expect(report.frontendModules).toEqual([]);
  expect(report.typescriptModules).toEqual([]);
  expect(report.loadedModuleCount).toBeGreaterThan(0);
  expect(report.reencodedIdentical).toBe(true);
  expect(report.targets["wasmgc:standalone"].emittedUnits).toBe(3);
});
