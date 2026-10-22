// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

const CHECK = "function check(o:any,K:any):number{return o instanceof K?1:0;}";
const CASES = {
  "same-layout classes keep distinct constructor identities":
    "class C{value=3;m(){return this.value;}}class D{value=5;m(){return this.value;}}" +
    CHECK +
    "export function run(){return check(new C(),C)+10*check(new D(),C)+100*check(new D(),D);}",
  "memberless classes also have real prototypes":
    "class C{}class D{}" +
    CHECK +
    "export function run(){return check(new C(),C)+10*check(new D(),C)+100*check(new D(),D);}",
  "derived instances reach the parent prototype":
    "class C{m(){return 3;}}class D extends C{}" +
    CHECK +
    "export function run(){return check(new D(),C)+10*check(new D(),D)+100*check(new C(),D);}",
  "primitive left operands remain false":
    "class C{m(){return 3;}}" +
    CHECK +
    'export function run(){return check(null,C)+check(undefined,C)+check(3,C)+check(true,C)+check("x",C);}',
};

function nodeResult(source: string): number {
  return new Function(source.replace(/export /g, "").replace(/:any|:number/g, "") + ";return run();")();
}

async function run(result: Awaited<ReturnType<typeof compile>>): Promise<number> {
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const exports = instance.exports as { __module_init?: () => void; run: () => number };
  exports.__module_init?.();
  return exports.run();
}

describe("native dynamic instanceof prototype demand", () => {
  for (const target of ["standalone", "wasi"] as const) {
    for (const experimentalIR of [false, true]) {
      for (const [name, source] of Object.entries(CASES)) {
        it(`${target} IR=${experimentalIR}: ${name}`, async () => {
          const result = await compile(source, { target, experimentalIR, trackIrOutcomes: true });
          expect(await run(result)).toBe(nodeResult(source));
          if (experimentalIR) {
            // The protocol follow-up now selects this checker; class-value callers
            // can still require the compatibility path, tested separately.
            const check = result.irOutcomes?.filter((outcome) => outcome.displayName === "check");
            expect(check).toHaveLength(1);
            expect(check![0].irBodyEmitted).toBe(true);
          }
        });
      }
    }
    it(`${target}: compileMulti records and fills the same prototype demand`, async () => {
      const classes = "export class C{value=3;m(){return this.value;}}export class D{value=5;m(){return this.value;}}";
      const main =
        'import {C,D} from "./classes";' +
        CHECK +
        "export function run(){return check(new C(),C)+10*check(new D(),C)+100*check(new D(),D);}";
      const result = await compileMulti({ "classes.ts": classes, "main.ts": main }, "main.ts", {
        target,
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expect(await run(result)).toBe(101);
    });
  }
});
