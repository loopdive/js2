// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4616 (cookie Expires family / jest getType 'date') — the compiler-owned
// WasmGC `$Date` carrier fell through the generic ToPrimitive protocols:
// `+d` on an any-typed Date answered NaN (so `+d1 === +d2` never held — the
// parse-set-cookie Expires corpus and jest's diff `expires` toEqual all
// failed), and `.constructor` answered Object (jest-get-type classifies
// 'date' via `value.constructor === Date`). Both funnels (`_toPrimitive`,
// `_hostToPrimitive`) now recognize the carrier via the `__\0js2_is_date` /
// `__\0js2_date_value` exports, and the dynamic `constructor` read answers
// the host Date.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(source: string) {
  const result = await compile(source, {
    testRuntime: true,
    fileName: "issue-4616-date.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const importObject = (result as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary!, importObject);
  (importObject as { __setInstance?: (i: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return wrapExports(instance, {
    signatures: (result as { exportSignatures?: unknown }).exportSignatures,
  }) as Record<string, (...args: unknown[]) => unknown>;
}

describe("#4616 Date carrier ToPrimitive/constructor", () => {
  it("unary plus on an any-typed Date yields the timestamp", async () => {
    const exp = await run(`
      export function t(): string {
        const a: any = new Date("Wed, 21 Oct 2015 07:28:00 GMT");
        const b: any = new Date("Wed, 21 Oct 2015 07:28:00 GMT");
        const c: any = new Date(1000);
        return String(+a) + "|" + String(+a === +b) + "|" + String(+c);
      }`);
    expect(exp.t!()).toBe("1445412480000|true|1000");
  });

  it("value.constructor === Date holds for the carrier", async () => {
    const exp = await run(`
      export function t(): string {
        const value: any = new Date(5);
        return String((value as any).constructor === Date);
      }`);
    expect(exp.t!()).toBe("true");
  });
});
