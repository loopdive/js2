// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

type Target = "gc" | "standalone";

async function exportsFor(target: Target, source: string): Promise<Record<string, () => number>> {
  const result = await compile(source, { target, skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary as BufferSource);
  if (target === "standalone") expect(WebAssembly.Module.imports(module)).toEqual([]);
  const imports = result.importObject ?? {};
  const instance = new WebAssembly.Instance(module, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return instance.exports as unknown as Record<string, () => number>;
}

const SOURCE = `
  export function staticLiteralIndexOne(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    return source["1"] === "a" ? 1 : 0;
  }

  export function dynamicIndexZero(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "0";
    const value = source[key];
    return value === "abc" ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
  }

  export function dynamicIndexOne(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "1";
    const value = source[key];
    return value === "a" ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
  }

  export function dynamicIndexTwo(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "2";
    const value = source[key];
    return value === "b" ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
  }

  export function dynamicUnmatchedCapture(): number {
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    let key = "1";
    const value = source[key];
    return value === undefined ? 1 : value === null ? 2 : 3;
  }

  export function dynamicOutOfBounds(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "4";
    const value = source[key];
    return value === undefined ? 1 : value === null ? 2 : 3;
  }

  export function dynamicLeadingZero(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "01";
    const value = source[key];
    return value === undefined ? 1 : value === null ? 2 : value === "a" ? 3 : 4;
  }

  export function dynamicFractional(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "1.5";
    const value = source[key];
    return value === undefined ? 1 : value === null ? 2 : value === "a" ? 3 : 4;
  }

  export function dynamicNegativeOne(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "-1";
    const value = source[key];
    return value === undefined ? 1 : value === null ? 2 : 3;
  }

  export function dynamicNegativeZero(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "-0";
    const value = source[key];
    return value === undefined ? 1 : value === null ? 2 : value === "abc" ? 3 : 4;
  }

  export function dynamicIndexMetadata(): number {
    const source = /(a)(b)(c)/.exec("zabc");
    if (source === null) return 0;
    let key = "index";
    const value = source[key];
    return value === 1 ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
  }

  export function dynamicInputMetadata(): number {
    const source = /(a)(b)(c)/.exec("zabc");
    if (source === null) return 0;
    let key = "input";
    const value = source[key];
    return value === "zabc" ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
  }

  export function dynamicLengthMetadata(): number {
    const source = /^(a)(b)(c)$/.exec("abc");
    if (source === null) return 0;
    let key = "length";
    const value = source[key];
    return value === 4 ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
  }

  export function dynamicReceiverAndKeyEvaluateOnce(): number {
    let receiverCalls = 0;
    let keyCalls = 0;
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    let key = "1";
    const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
    const valueCode = value === undefined ? 1 : value === null ? 2 : 3;
    return receiverCalls * 100 + keyCalls * 10 + valueCode;
  }
`;

for (const target of ["gc", "standalone"] as const) {
  describe(`#6648 ${target} dynamic capture numeric-string probes`, () => {
    let ex: Record<string, () => number>;

    beforeAll(async () => {
      ex = await exportsFor(target, SOURCE);
    });

    it("keeps the literal canonical index control on the physical element path", () => {
      expect(ex.staticLiteralIndexOne()).toBe(1);
    });

    it("reads dynamic canonical capture index 0", () => {
      expect(ex.dynamicIndexZero()).toBe(1);
    });

    it("reads dynamic canonical capture index 1", () => {
      expect(ex.dynamicIndexOne()).toBe(1);
    });

    it("reads dynamic canonical capture index 2", () => {
      expect(ex.dynamicIndexTwo()).toBe(1);
    });

    it("distinguishes undefined from null for an unmatched dynamic capture", () => {
      expect(ex.dynamicUnmatchedCapture()).toBe(1);
    });

    it("returns undefined for a dynamic out-of-bounds capture index", () => {
      expect(ex.dynamicOutOfBounds()).toBe(1);
    });

    it("does not treat a leading-zero key as a capture index", () => {
      expect(ex.dynamicLeadingZero()).toBe(1);
    });

    it("does not truncate a fractional string key to a capture index", () => {
      expect(ex.dynamicFractional()).toBe(1);
    });

    it("does not treat a negative string key as a capture index", () => {
      expect(ex.dynamicNegativeOne()).toBe(1);
    });

    it("does not treat negative zero as capture index zero", () => {
      expect(ex.dynamicNegativeZero()).toBe(1);
    });

    it("preserves nonzero dynamic capture index metadata", () => {
      expect(ex.dynamicIndexMetadata()).toBe(1);
    });

    it("preserves dynamic capture input metadata", () => {
      expect(ex.dynamicInputMetadata()).toBe(1);
    });

    it("preserves dynamic capture length metadata", () => {
      expect(ex.dynamicLengthMetadata()).toBe(1);
    });

    it("evaluates the dynamic capture receiver and key exactly once", () => {
      expect(ex.dynamicReceiverAndKeyEvaluateOnce()).toBe(111);
    });
  });
}
