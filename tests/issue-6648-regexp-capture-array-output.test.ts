// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

/**
 * #6648 — `RegExpExecArray` is a metadata-bearing capture receiver, but every
 * Array method that allocates a fresh result must return an ordinary Array.
 *
 * The source intentionally leaves the capture result unannotated: `: any`
 * would hide the native nullable-string carrier and could route property reads
 * through a different checker path.  The compiler suppresses semantic
 * diagnostics solely so the direct metadata-absence reads on ordinary arrays
 * reach their runtime property boundary, as Test262-style sources do.
 */
async function standaloneExports(source: string): Promise<Record<string, () => number>> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary as BufferSource);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return new WebAssembly.Instance(module, {}).exports as unknown as Record<string, () => number>;
}

describe("#6648 capture-result Array outputs", () => {
  let ordinaryOutputs: Record<string, () => number>;

  beforeAll(async () => {
    ordinaryOutputs = await standaloneExports(`
      function capture() {
        return /^(a)?(b)(c)$/.exec("bc");
      }

      export function filterOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const output = source.filter((value) => value !== undefined);
        return source.index === 0 && source.input === "bc" &&
          output.length === 3 && output[0] === "bc" && output[1] === "b" && output[2] === "c" &&
          output.index === undefined && output.input === undefined ? 1 : 0;
      }

      export function sliceOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const output = source.slice(1);
        return output.length === 3 && output[0] === undefined && output[1] === "b" && output[2] === "c" &&
          output.index === undefined && output.input === undefined ? 1 : 0;
      }

      export function concatOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const zero = source.concat();
        const paired = source.concat(source);
        return zero.length === 4 && zero[1] === undefined && zero.index === undefined && zero.input === undefined &&
          paired.length === 8 && paired[1] === undefined && paired[5] === undefined &&
          paired.index === undefined && paired.input === undefined ? 1 : 0;
      }

      export function spliceOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const deleted = source.splice(0, 2);
        return source.index === 0 && source.input === "bc" &&
          deleted.length === 2 && deleted[0] === "bc" && deleted[1] === undefined &&
          deleted.index === undefined && deleted.input === undefined ? 1 : 0;
      }
    `);
  });

  it("returns an ordinary Array from filter", () => {
    expect(ordinaryOutputs.filterOutput()).toBe(1);
  });

  it("returns an ordinary Array from slice", () => {
    expect(ordinaryOutputs.sliceOutput()).toBe(1);
  });

  it("returns ordinary Arrays from zero-argument and same-kind concat", () => {
    expect(ordinaryOutputs.concatOutput()).toBe(1);
  });

  it("keeps the mutated capture carrier while splice returns an ordinary deleted-elements Array", () => {
    expect(ordinaryOutputs.spliceOutput()).toBe(1);
  });

  // Triad-pinned residual: the concise callback's declared `string` result
  // still coerces the nullable capture slot with `ref.as_non_null` inside the
  // closure ABI. This is identical on #6004's ae0 parent, clean 2f6, and the
  // #6648 repair; map output allocation is not a fix for that return boundary.
  it.fails("RESIDUAL: an unannotated identity map traps on an unmatched capture", async () => {
    const ex = await standaloneExports(`
      function capture() {
        return /^(a)?(b)(c)$/.exec("bc");
      }

      export function identityMapOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const output = source.map((value) => value);
        return output.length === 4 && output[0] === "bc" && output[1] === undefined &&
          output[2] === "b" && output[3] === "c" &&
          output.index === undefined && output.input === undefined ? 1 : 0;
      }
    `);
    expect(ex.identityMapOutput()).toBe(1);
  });

  it("returns an ordinary Array from a defined-return map", async () => {
    const ex = await standaloneExports(`
      function capture() {
        return /^(a)?(b)(c)$/.exec("bc");
      }

      export function definedMapOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const output = source.map((value) => value === undefined ? "missing" : value);
        return output.length === 4 && output[0] === "bc" && output[1] === "missing" &&
          output[2] === "b" && output[3] === "c" &&
          output.index === undefined && output.input === undefined ? 1 : 0;
      }
    `);
    expect(ex.definedMapOutput()).toBe(1);
  });

  describe("admitted ES2023 copy producers", () => {
    let copyOutputs: Record<string, () => number>;

    beforeAll(async () => {
      copyOutputs = await standaloneExports(`
      function capture() {
        return /^(a)?(b)(c)$/.exec("bc");
      }

      export function toReversedOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const output = source.toReversed();
        return output.length === 4 && output[0] === "c" && output[1] === "b" &&
          output[2] === undefined && output[3] === "bc" &&
          output.index === undefined && output.input === undefined ? 1 : 0;
      }

      export function toSplicedOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const output = source.toSpliced(0, 1);
        return output.length === 3 && output[0] === undefined && output[1] === "b" && output[2] === "c" &&
          output.index === undefined && output.input === undefined ? 1 : 0;
      }

      export function withOutput(): number {
        const source = capture();
        if (source === null) return 0;
        const output = source.with(0, "first");
        return output.length === 4 && output[0] === "first" && output[1] === undefined &&
          output[2] === "b" && output[3] === "c" &&
          output.index === undefined && output.input === undefined ? 1 : 0;
      }
    `);
    });

    it("returns an ordinary Array from toReversed", () => {
      expect(copyOutputs.toReversedOutput()).toBe(1);
    });

    it("returns an ordinary Array from toSpliced", () => {
      expect(copyOutputs.toSplicedOutput()).toBe(1);
    });

    it("returns an ordinary Array from with", () => {
      expect(copyOutputs.withOutput()).toBe(1);
    });
  });
});

describe("#6648 capture-result numeric reads", () => {
  let ex: Record<string, () => number>;

  beforeAll(async () => {
    ex = await standaloneExports(`
      export function reads(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        return source[1] === undefined ? 1 : 0;
      }

      export function numericVariable(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        let numericSlot = 1;
        return source[numericSlot] === undefined ? 1 : 0;
      }

      export function oob(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        return source[99] === undefined ? 1 : 0;
      }

      // Negative and fractional static keys take the existing named-property
      // route, not the positional numeric reader. They are kept as explicit
      // misses here rather than claimed as arbitrary numeric-key semantics.
      export function staticNegativeAndFractional(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        return source[-1] === undefined && source[1.5] === undefined ? 1 : 0;
      }

      export function dynamicMetadata(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        let metadataKey = "index";
        let inputKey = "input";
        return source[metadataKey] === 0 && source[inputKey] === "bc" ? 1 : 0;
      }

      export function directMetadata(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        return source.index === 0 && source.input === "bc" ? 1 : 0;
      }

      export function immediateMemberStillThrows(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        try {
          source[1].length;
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }

      export function noMatchStillNull(): number {
        return /z/.exec("bc") === null ? 1 : 0;
      }
    `);
  });

  it("widens an unmatched positional slot", () => {
    expect(ex.reads()).toBe(1);
  });

  it("widens a number-typed positional variable", () => {
    expect(ex.numericVariable()).toBe(1);
  });

  it("widens an out-of-bounds positional read", () => {
    expect(ex.oob()).toBe(1);
  });

  it("keeps negative and fractional static keys on the existing named-key miss route", () => {
    expect(ex.staticNegativeAndFractional()).toBe(1);
  });

  // Triad-pinned residual: standalone dynamic string-key reads decline the
  // dynamic vec reader before capture metadata can be consulted. Direct
  // metadata reads below remain the #6648-preserved behavior.
  it.fails("RESIDUAL: dynamic capture metadata keys do not yet reach the metadata reader", () => {
    expect(ex.dynamicMetadata()).toBe(1);
  });

  it("preserves direct capture metadata", () => {
    expect(ex.directMetadata()).toBe(1);
  });

  // Triad-pinned residual: this lowerer exposes the raw nullable slot to an
  // immediate member access, which traps in Wasm instead of producing JS's
  // TypeError. The #6648 value read widening deliberately does not repair it.
  it.fails("RESIDUAL: immediate member access on an unmatched capture traps before TypeError", () => {
    expect(ex.immediateMemberStillThrows()).toBe(1);
  });

  it("keeps a no-match result null", () => {
    expect(ex.noMatchStillNull()).toBe(1);
  });
});
