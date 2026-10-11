// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5198 — the standalone CS1a open `$Object` carrier has no nominal
// `typeIdxToStructName` entry. It is still an ECMAScript Object: Number() must
// perform ToPrimitive(number), preserve the original receiver and abrupt
// completion, and then apply ToNumber. Keep this separate from the RegExp
// protocol fixture because the raw `lastIndex` / custom-exec rows merely expose
// this general carrier defect; they are not a replacement for its coercion
// proof.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const FUSED_TONUMBER = "JS2WASM_FUSED_TONUMBER";
const SMI_FASTPATH = "JS2WASM_SMI_FASTPATH";

type NumericExports = Record<string, () => number>;

interface ToNumberFlags {
  readonly fused: string | undefined;
  readonly smi: string | undefined;
}

async function withToNumberFlags<T>(flags: ToNumberFlags, body: () => Promise<T>): Promise<T> {
  const previousFused = process.env[FUSED_TONUMBER];
  const previousSmi = process.env[SMI_FASTPATH];
  if (flags.fused === undefined) delete process.env[FUSED_TONUMBER];
  else process.env[FUSED_TONUMBER] = flags.fused;
  if (flags.smi === undefined) delete process.env[SMI_FASTPATH];
  else process.env[SMI_FASTPATH] = flags.smi;
  try {
    return await body();
  } finally {
    if (previousFused === undefined) delete process.env[FUSED_TONUMBER];
    else process.env[FUSED_TONUMBER] = previousFused;
    if (previousSmi === undefined) delete process.env[SMI_FASTPATH];
    else process.env[SMI_FASTPATH] = previousSmi;
  }
}

/** Compile a host-free source and retain the import assertion at the binary boundary. */
async function runStandalone(source: string, flags: ToNumberFlags): Promise<NumericExports> {
  return withToNumberFlags(flags, async () => {
    const result = await compile(source, {
      fileName: "issue-5198-toprimitive-object-carrier.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
    if (!result.success) throw new Error("standalone compile failed");
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module), "raw $Object ToNumber must stay host-free").toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    return instance.exports as NumericExports;
  });
}

// This is intentionally the original one-function receipt shape. Splitting
// direct, saved-method, and Number() into separate exports changes the carrier
// inference and can accidentally route `marker` through externref instead of
// the raw `$Object` whose conversion is under test.
const ORIGINAL_RECEIPT_SOURCE = `
  export function directNumberTrace(): number {
    let trace = 0;
    const marker: any = {
      valueOf: function (): number { trace = trace * 10 + 1; return 7; },
      toString: function (): string { trace = trace * 10 + 2; return "8"; },
    };
    const directProperty: any = marker.valueOf();
    const directPropertyTrace = trace;
    trace = 0;
    const savedValueOf: any = marker.valueOf;
    const savedMethod: any = savedValueOf();
    const savedMethodTrace = trace;
    trace = 0;
    try {
      const coerced: any = Number(marker);
      return (directProperty === 7 && directPropertyTrace === 1 ? 1 : 0) |
        (savedMethod === 7 && savedMethodTrace === 1 ? 2 : 0) |
        (coerced === 7 && trace === 1 ? 4 : 0);
    } catch (_) {
      return (directProperty === 7 && directPropertyTrace === 1 ? 1 : 0) |
        (savedMethod === 7 && savedMethodTrace === 1 ? 2 : 0);
    }
  }
`;

// Keep every raw carrier binding uniquely named. The object-literal analysis
// intentionally records some escape facts by declaration name, so reusing a
// name next to a computed Symbol-keyed literal would turn this into a generic
// externref test rather than the CS1a raw-$Object receipt.
const SEMANTIC_MATRIX_SOURCE = `
  export function primitiveResults(): number {
    let trace = 0;
    const rawNumber: any = {
      receiverTag: 17,
      valueOf: function (): any { trace = (this as any).receiverTag === 17 ? 1 : 90; return 7; },
      toString: function (): any { trace = trace * 10 + 2; return "8"; },
    };
    const rawString: any = {
      valueOf: function (): any { trace = trace * 10 + 3; return "8"; },
      toString: function (): any { trace = trace * 10 + 4; return "9"; },
    };
    const rawBoolean: any = {
      valueOf: function (): any { trace = trace * 10 + 5; return true; },
      toString: function (): any { trace = trace * 10 + 6; return "0"; },
    };
    const rawNull: any = {
      valueOf: function (): any { trace = trace * 10 + 7; return null; },
      toString: function (): any { trace = trace * 10 + 8; return "9"; },
    };
    const rawUndefined: any = {
      valueOf: function (): any { trace = trace * 10 + 9; return undefined; },
      toString: function (): any { trace = trace * 10 + 10; return "9"; },
    };

    const number = Number(rawNumber);
    const string = Number(rawString);
    const boolean = Number(rawBoolean);
    const nil = Number(rawNull);
    const undef = Number(rawUndefined);
    return number === 7 && string === 8 && boolean === 1 && nil === 0 && undef !== undef && trace === 13579 ? 1 : 0;
  }

  export function ordinaryFallback(): number {
    let trace = 0;
    const rawFallback: any = {
      valueOf: function (): any { trace = trace * 10 + 1; return { notPrimitive: 1 }; },
      toString: function (): any { trace = trace * 10 + 2; return "8"; },
    };
    return Number(rawFallback) === 8 && trace === 12 ? 1 : 0;
  }

  export function thrownIdentity(): number {
    let trace = 0;
    const thrown: any = { sentinel: 1 };
    const rawThrow: any = {
      valueOf: function (): any { trace = trace * 10 + 1; throw thrown; },
      toString: function (): any { trace = trace * 10 + 2; return "8"; },
    };
    try {
      Number(rawThrow);
      return 0;
    } catch (error: any) {
      return error === thrown && trace === 1 ? 1 : 0;
    }
  }

  export function ordinaryObjectResultThrows(): number {
    let trace = 0;
    const rawObjects: any = {
      valueOf: function (): any { trace = trace * 10 + 1; return {}; },
      toString: function (): any { trace = trace * 10 + 2; return {}; },
    };
    try {
      Number(rawObjects);
      return 0;
    } catch (error: any) {
      return error instanceof TypeError && trace === 12 ? 1 : 0;
    }
  }

  export function rawValueOfSymbolThrows(): number {
    let trace = 0;
    const rawSymbol: any = {
      valueOf: function (): any { trace = trace * 10 + 1; return Symbol("raw"); },
      toString: function (): any { trace = trace * 10 + 2; return "8"; },
    };
    try {
      Number(rawSymbol);
      return 0;
    } catch (error: any) {
      return error instanceof TypeError && trace === 1 ? 1 : 0;
    }
  }

  export function exoticPrecedence(): number {
    let trace = 0;
    const exoticTarget: any = {
      tag: 1,
      [Symbol.toPrimitive]: function (hint: any): any {
        trace = hint === "number" && (this as any).tag === 1 ? 1 : 90;
        return 5;
      },
      valueOf: function (): any { trace = trace * 10 + 2; return 7; },
      toString: function (): any { trace = trace * 10 + 3; return "8"; },
    };
    return Number(exoticTarget) === 5 && trace === 1 ? 1 : 0;
  }

  export function exoticSymbolThrows(): number {
    let trace = 0;
    const exoticSymbol: any = {
      tag: 1,
      [Symbol.toPrimitive]: function (hint: any): any {
        trace = hint === "number" ? 1 : 90;
        return Symbol("exotic");
      },
    };
    try {
      Number(exoticSymbol);
      return 0;
    } catch (error: any) {
      return error instanceof TypeError && trace === 1 ? 1 : 0;
    }
  }

  export function rawThenNominal(): number {
    let trace = 0;
    const rawFirst: any = {
      valueOf: function (): any { trace = trace * 10 + 1; return 7; },
    };
    class NominalAfterRaw {
      valueOf(): number { return 9; }
    }
    const nominalSecond = new NominalAfterRaw();
    const first = Number(rawFirst);
    const second = Number(nominalSecond as any);
    return first === 7 && second === 9 && trace === 1 ? 1 : 0;
  }
`;

const UNRELATED_NUMERIC_CONTROL = `
  export function test(): number {
    const value: any = 2;
    return Number(value) + 1;
  }
`;

async function runUnrelatedControl(target: "host" | "wasi"): Promise<number> {
  const result = await compile(UNRELATED_NUMERIC_CONTROL, {
    fileName: `issue-5198-toprimitive-${target}-control.ts`,
    skipSemanticDiagnostics: true,
    ...(target === "wasi" ? { target: "wasi" as const } : {}),
  });
  expect(result.success, (result.errors ?? []).map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) throw new Error(`${target} control compile failed`);
  const module = await WebAssembly.compile(result.binary);
  const imports = (result.importObject ?? {}) as WebAssembly.Imports & {
    setExports?: (exports: WebAssembly.Exports) => void;
    __setExports?: (exports: WebAssembly.Exports) => void;
  };
  const instance = await WebAssembly.instantiate(module, imports);
  imports.setExports?.(instance.exports);
  imports.__setExports?.(instance.exports);
  return (instance.exports as NumericExports).test();
}

describe("#5198 — standalone raw $Object ToNumber", () => {
  for (const [label, flags] of [
    ["default fused ToNumber", { fused: undefined, smi: undefined }],
    // The generic SMI-on/FUSED-off scratch-local validation defect is recorded
    // in #5198's deferred independent validation-defect subsection.
    // Keep the raw-$Object's unfused semantics covered without masking normal
    // default-fused coverage or broadening this regression's production scope.
    ["unfused ToNumber", { fused: "0", smi: "0" }],
  ] as const) {
    it(`repairs the exact one-function receipt (${label})`, { timeout: 120_000 }, async () => {
      expect((await runStandalone(ORIGINAL_RECEIPT_SOURCE, flags)).directNumberTrace()).toBe(7);
    });

    it(`preserves raw-object ToPrimitive / ToNumber semantics (${label})`, { timeout: 120_000 }, async () => {
      const exports = await runStandalone(SEMANTIC_MATRIX_SOURCE, flags);
      expect(exports.primitiveResults()).toBe(1);
      expect(exports.ordinaryFallback()).toBe(1);
      expect(exports.thrownIdentity()).toBe(1);
      expect(exports.ordinaryObjectResultThrows()).toBe(1);
      expect(exports.rawValueOfSymbolThrows()).toBe(1);
      expect(exports.exoticPrecedence()).toBe(1);
      expect(exports.exoticSymbolThrows()).toBe(1);
      expect(exports.rawThenNominal()).toBe(1);
    });
  }

  it.each(["host", "wasi"] as const)("leaves the unrelated %s numeric lane instantiable", async (target) => {
    expect(await runUnrelatedControl(target)).toBe(3);
  });
});
