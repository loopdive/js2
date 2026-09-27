// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { compile } from "../src/index.js";

// Count and raw output are separate observations, not a combined assertion.
// Existing String13/raw5/valueOf31 fixtures remain unchanged.
const cases: { name: string; body: string; expected: number | string }[] = [
  {
    name: "comma left increment count only",
    body: "let count=0;const result=String((count++,18446744073709551617n));return count;",
    expected: 1,
  },
  {
    name: "comma wide positive raw result only",
    body: "let count=0;return String((count++,18446744073709551617n));",
    expected: "18446744073709551617",
  },
  {
    name: "comma wide negative raw result only",
    body: "let count=0;return String((count++,-18446744073709551617n));",
    expected: "-18446744073709551617",
  },
  {
    name: "nested comma evaluation trace only",
    body: "let trace=0;const result=String((trace=trace*10+1,(trace=trace*10+2,18446744073709551617n)));return trace;",
    expected: 12,
  },
  {
    name: "nested comma wide raw result only",
    body: "let trace=0;return String((trace=trace*10+1,(trace=trace*10+2,18446744073709551617n)));",
    expected: "18446744073709551617",
  },
  {
    name: "comma left throw prevents right evaluation",
    body: "let left=0;let right=0;const reason={};function fail(){left++;throw reason;}try{String((fail(),(right++,18446744073709551617n)));return -1;}catch(e){if(e!==reason)return -2;if(right!==0)return -3;return left;}",
    expected: 1,
  },
  {
    name: "comma number raw result control",
    body: "let count=0;return String((count++,1.5));",
    expected: "1.5",
  },
  {
    name: "comma void right retains both effects",
    body: "let trace=0;function left(){trace=trace*10+1;}function right(){trace=trace*10+2;}(left(),right());return trace;",
    expected: 12,
  },
];

for (const { name, body, expected } of cases) {
  it(name, async () => {
    const output = `function output(){${body}}`;
    const isText = typeof expected === "string";
    const source =
      output +
      (isText
        ? "\nexport function length(){return output().length;}\nexport function unit(index:number){return output().charCodeAt(index);}"
        : "\nexport function test(){return output();}");
    const sha256 = createHash("sha256").update(source).digest("hex");
    const native = runInNewContext(output + ";output()", {}, { timeout: 5000 });
    const receipt: Record<string, unknown> = { name, source, sha256, expected, native };
    try {
      const result = await compile(source, {
        fileName: "5883-bigint-string-comma.ts",
        skipSemanticDiagnostics: true,
        target: "standalone",
        nativeStrings: true,
      });
      receipt.success = result.success;
      receipt.errors = result.errors;
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const module = new WebAssembly.Module(result.binary);
      receipt.imports = WebAssembly.Module.imports(module);
      expect(receipt.imports).toEqual([]);
      const instance = new WebAssembly.Instance(module, {});
      if (isText) {
        const length = (instance.exports.length as () => number)();
        receipt.length = length;
        expect(Number.isInteger(length) && length >= 0 && length <= 128).toBe(true);
        const units: number[] = [];
        for (let i = 0; i < length; i++) {
          const unit = (instance.exports.unit as (index: number) => number)(i);
          units.push(unit);
          expect(Number.isInteger(unit) && unit >= 0 && unit <= 65535).toBe(true);
        }
        receipt.units = units;
        receipt.actual = String.fromCharCode(...units);
      } else {
        receipt.actual = (instance.exports.test as () => number)();
      }
      expect(native).toBe(expected);
      expect(receipt.actual).toBe(expected);
    } catch (error) {
      receipt.failure = String(error);
      throw error;
    } finally {
      console.log(JSON.stringify(receipt));
    }
  });
}
