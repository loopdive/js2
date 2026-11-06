// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — dead statements after a break/continue in a nested statement list.
// `br.label` must end its IR buffer, so the AST lowerer stops at the first
// break/continue of a list. That guard covered a block and a switch clause, but
// not a try/catch/finally body, and it read the statement KIND, so a
// break/continue inside a plain block lowered inline kept the outer list going.
// Each shape was IR-claimed and then failed verification, which is a compile
// error. test262 S12.14_A9_T5 / S12.14_A10_T5 (`catch { continue; throw … }`
// with `finally`) hit it once #6972 put their `<module-init>` on the IR path;
// the same shapes failed on main inside ordinary function bodies.
import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

type Lane = "standalone" | undefined;
type Result = Awaited<ReturnType<typeof compile>>;

function irRow(result: Result, unit: string) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === unit);
}

async function instantiate(result: Result, lane: Lane): Promise<Record<string, (() => unknown) | undefined>> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = (lane === "standalone" ? {} : result.importObject) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (result.importObject as { setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.setInstance?.(instance);
  return instance.exports as Record<string, (() => unknown) | undefined>;
}

// The two test262 bodies, verbatim up to the final check, which compares the
// counters against node's instead (a numeric check keeps <module-init> on IR).
const LOOP_BODY = `var c=0, i=0;
var fin=0;
HEAD
  i+=1;
  try{
    if(c===0){
      throw "ex1";
      throw new Test262Error('#1.1: throw "ex1" lead to throwing exception');
    }
    c+=2;
    if(c===1){
      throw "ex2";
      throw new Test262Error('#1.2: throw "ex2" lead to throwing exception');
    }
  }
  catch(er1){
    c-=1;
    continue;
    throw new Test262Error('#1.3: "try catch{continue} finally" must work correctly');
  }
  finally{
    fin+=1;
  }
TAIL
`;

const HARNESS_SHAPES = {
  "S12.14_A9_T5 (do-while)": LOOP_BODY.replace("HEAD", "do{").replace("TAIL", "}\nwhile(i<10);"),
  "S12.14_A10_T5 (while)": LOOP_BODY.replace("HEAD", "while(i<10){").replace("TAIL", "}"),
};

function assemble(body: string): string {
  const source = `/*---\ndescription: try/catch/finally with continue and dead code\n---*/\n${body}`;
  return assembleOriginalHarness(source, parseMeta(source) as never).primary.source;
}

function nodeCounters(body: string): number[] {
  const context = vm.createContext({});
  vm.runInContext(`${assemble(body)}\nglobalThis.__counters = [c, i, fin];`, context);
  return [...(context as { __counters: number[] }).__counters];
}

async function runChecked(body: string, [c, i, fin]: number[]) {
  const checked = `${body}if (c !== ${c} || i !== ${i} || fin !== ${fin}) throw new Test262Error("counters differ");\n`;
  const result = await compile(assemble(checked), {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    hostBridge: "always",
    trackIrOutcomes: true,
  } as Parameters<typeof compile>[1]);
  expect(irRow(result, "<module-init>")?.irBodyEmitted, JSON.stringify(irRow(result, "<module-init>"))).toBe(true);
  const exports = await instantiate(result, "standalone");
  exports.__module_init?.();
  exports.test?.();
}

describe("#7106 — <module-init> with continue and dead code in a try/catch/finally loop", () => {
  for (const [name, body] of Object.entries(HARNESS_SHAPES)) {
    const expected = nodeCounters(body);

    it(`${name}: node reference counters`, () => {
      expect(expected).toEqual([0, 10, 10]);
    });

    it(`${name}: the IR module-init compiles and matches node`, async () => {
      await expect(runChecked(body, expected)).resolves.toBeUndefined();
    }, 60_000);

    it(`${name}: a wrong expectation still throws, so the run is observed`, async () => {
      await expect(runChecked(body, [expected[0]!, expected[1]!, expected[2]! + 1])).rejects.toBeDefined();
    }, 60_000);
  }
});

// Function bodies: each loop reaches a break/continue that is followed by dead
// code in a buffer the guard did not cover.
const FUNCTION_SHAPES: Record<string, string> = {
  "continue in try, dead code, finally": `while (i < 10) { i += 1; try { continue; i += 100; } finally { f += 1; } }`,
  "continue in catch, dead code, finally": `while (i < 10) { i += 1; try { if (i % 2 === 0) throw "x"; f += 10; } catch (e) { f += 1; continue; i += 100; } finally { f += 1000; } }`,
  "continue in finally, dead code": `while (i < 10) { i += 1; try { f += 1; } finally { continue; i += 100; } }`,
  "break in try, dead code, catch": `while (i < 10) { i += 1; try { f += 1; break; f += 100; } catch (e) { i += 1; } }`,
  "continue in a nested block, dead code": `while (i < 10) { i += 1; { f += 1; continue; } i += 100; }`,
  "break in a block inside a switch clause": `while (i < 10) { i += 1; switch (i) { case 1: { f += 1; break; } f += 100; default: f += 2; } }`,
  "labeled continue through two finally bodies": `outer: while (i < 10) { i += 1; try { try { f += 1; continue outer; f += 100; } finally { f += 10; } } finally { f += 1000; } }`,
};

function functionSource(loop: string): string {
  return `export function run(): number {\n  let i = 0, f = 0;\n  ${loop}\n  return f * 100 + i;\n}\n`;
}

function nodeRun(loop: string): number {
  return new Function(`"use strict";\nlet i = 0, f = 0;\n${loop}\nreturn f * 100 + i;`)() as number;
}

describe("#7106 — function bodies with dead code after break/continue", () => {
  for (const lane of ["standalone", undefined] as const) {
    for (const [name, loop] of Object.entries(FUNCTION_SHAPES)) {
      it(`${name} (${lane ?? "host"})`, async () => {
        const result = await compile(functionSource(loop), {
          trackIrOutcomes: true,
          ...(lane ? { target: lane } : {}),
        });
        expect(irRow(result, "run")?.irBodyEmitted, JSON.stringify(irRow(result, "run"))).toBe(true);
        const exports = await instantiate(result, lane);
        expect(exports.run!()).toBe(nodeRun(loop));
      }, 30_000);
    }
  }
});
