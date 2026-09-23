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
  export function dynamicMetadata(): number {
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    let metadataKey = "index";
    let inputKey = "input";
    return source[metadataKey] === 0 && source[inputKey] === "bc" ? 1 : 0;
  }

  export function dynamicNonzeroMetadata(): number {
    const source = /(a)?(b)(c)/.exec("zbc");
    if (source === null) return 0;
    let metadataKey = "index";
    let inputKey = "input";
    return source[metadataKey] === 1 && source[inputKey] === "zbc" ? 1 : 0;
  }

  export function directMetadata(): number {
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    return source.index === 0 && source.input === "bc" ? 1 : 0;
  }

  export function staticBracketMetadata(): number {
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    return source["index"] === 0 && source["input"] === "bc" ? 1 : 0;
  }

  export function staticNumericStringElement(): number {
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    return source["1"] === undefined ? 1 : 0;
  }

  export function dynamicNumericStringElement(): number {
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    let captureKey = "1";
    return source[captureKey] === undefined ? 1 : 0;
  }

  export function dynamicMissingNamedKey(): number {
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    let missingKey = "missing";
    return source[missingKey] === undefined ? 1 : 0;
  }

  export function dynamicLength(): number {
    const source = /^(a)?(b)(c)$/.exec("bc");
    if (source === null) return 0;
    let lengthKey = "length";
    return source[lengthKey] === 4 ? 1 : 0;
  }

  export function dynamicGlobalMatchDoesNotGainMetadata(): number {
    const source = /a/g[Symbol.match]("baab");
    if (source === null) return 0;
    let metadataKey = "index";
    return source[metadataKey] === undefined ? 1 : 0;
  }

  export function dynamicReceiverAndKeyEvaluateOnce(): number {
    let receiverEvaluations = 0;
    let keyEvaluations = 0;
    return (receiverEvaluations += 1, /^(a)?(b)(c)$/.exec("bc"))[
      (keyEvaluations += 1, "input")
    ] === "bc" && receiverEvaluations === 1 && keyEvaluations === 1 ? 1 : 0;
  }
`;

for (const target of ["standalone", "gc"] as const) {
  describe(`#6649 ${target} dynamic capture metadata reads`, () => {
    let ex: Record<string, () => number>;

    beforeAll(async () => {
      ex = await exportsFor(target, SOURCE);
    });

    it("reads the frozen capture index and input witness through dynamic string keys", () => {
      expect(ex.dynamicMetadata()).toBe(1);
    });

    it("reads nonzero capture metadata through dynamic string keys", () => {
      expect(ex.dynamicNonzeroMetadata()).toBe(1);
    });

    it("preserves direct capture metadata reads", () => {
      expect(ex.directMetadata()).toBe(1);
    });

    it("reads capture metadata through literal bracket keys", () => {
      expect(ex.staticBracketMetadata()).toBe(1);
    });

    it("preserves a literal numeric-string capture element read", () => {
      expect(ex.staticNumericStringElement()).toBe(1);
    });

    it("preserves dynamic numeric-string capture element reads", () => {
      expect(ex.dynamicNumericStringElement()).toBe(1);
    });

    it("returns undefined for a missing dynamic capture property", () => {
      expect(ex.dynamicMissingNamedKey()).toBe(1);
    });

    it("preserves a dynamic capture length read", () => {
      expect(ex.dynamicLength()).toBe(1);
    });

    const dynamicGlobalMatchMetadata = () => {
      expect(ex.dynamicGlobalMatchDoesNotGainMetadata()).toBe(1);
    };
    target === "standalone"
      ? it.fails("RESIDUAL: global match dynamic metadata stays absent", dynamicGlobalMatchMetadata)
      : it("does not give a global match result capture metadata", dynamicGlobalMatchMetadata);

    it("evaluates a dynamic capture receiver and key once", () => {
      expect(ex.dynamicReceiverAndKeyEvaluateOnce()).toBe(1);
    });
  });
}
