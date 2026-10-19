// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const sources = {
  arrow:
    'export function run(n:number):number{const outer=()=>{"use strict";function inner():number{return this===undefined?42:-1;}return inner();};return outer()+n;}',
  accessor:
    'export function run(n:number):number{const object={get value():number{"use strict";function inner():number{return this===undefined?42:-1;}return inner();}};return object.value+n;}',
};

for (const target of ["standalone", "wasi"] as const)
  describe(`shared source strictness (${target})`, () => {
    for (const [name, source] of Object.entries(sources))
      it(`inherits the ${name} directive without a JS semantic provider`, async () => {
        // The export is the script harness's entry, not authority to turn every
        // nested function strict. The actual lexical directive still applies.
        const result = await compile(source, {
          target,
          inferModuleStrictArguments: false,
          skipSemanticDiagnostics: true,
          experimentalIR: true,
          trackIrOutcomes: true,
        });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const module = new WebAssembly.Module(result.binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = new WebAssembly.Instance(module, {}),
          run = instance.exports.run as (n: number) => number;
        for (const n of [-42, 0, 7]) expect(run(n)).toBe(42 + n);
        expect(run(NaN)).toBeNaN();
        // Actual source-body ownership belongs in the audit; do not pin a
        // currently direct body as the required forever implementation.
      });
  });
