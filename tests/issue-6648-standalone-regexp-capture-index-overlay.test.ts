// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary as BufferSource);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const imports = result.importObject ?? {};
  const instance = new WebAssembly.Instance(module, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as unknown as { run: () => number }).run();
}

type Control = { name: string; source: string; expected: number; expectedFailure?: true };

// Keep each source independent: the descriptor/prototype companion state is
// module-local, and a failed control must not suppress the later precedence
// witnesses. The receiver/key encoding is 100 * receiver + 10 * key + value.
const CONTROLS: readonly Control[] = [
  {
    name: "preserves an own null descriptor before the raw unmatched slot",
    source: `
      export function run(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        Object.defineProperty(source as any, "1", { value: null, configurable: true });
        let receiverCalls = 0;
        let keyCalls = 0;
        let key = "1";
        const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
        const valueCode = value === null ? 1 : value === undefined ? 2 : 3;
        return receiverCalls * 100 + keyCalls * 10 + valueCode;
      }
    `,
    expected: 111,
  },
  {
    name: "runs an own numeric accessor before the raw unmatched slot",
    source: `
      export function run(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        let getterCalls = 0;
        Object.defineProperty(source as any, "1", {
          get: function (): string {
            getterCalls += 1;
            return "getter";
          },
          configurable: true,
        });
        let receiverCalls = 0;
        let keyCalls = 0;
        let key = "1";
        const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
        const valueCode = value === "getter" ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
        return receiverCalls * 1000 + keyCalls * 100 + getterCalls * 10 + valueCode;
      }
    `,
    expected: 1111,
  },
  {
    name: "keeps a deleted capture slot from exposing its raw backing value",
    source: `
      export function run(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        delete (source as any)[1];
        let receiverCalls = 0;
        let keyCalls = 0;
        let key = "1";
        const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
        const valueCode = value === undefined ? 1 : value === null ? 2 : 3;
        return receiverCalls * 100 + keyCalls * 10 + valueCode;
      }
    `,
    expected: 111,
  },
  {
    name: "preserves an inherited null after deleting the capture slot",
    source: `
      Object.defineProperty(Array.prototype, "1", { value: null, configurable: true });

      export function run(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        delete (source as any)[1];
        let receiverCalls = 0;
        let keyCalls = 0;
        let key = "1";
        const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
        const valueCode = value === null ? 1 : value === undefined ? 2 : 3;
        return receiverCalls * 100 + keyCalls * 10 + valueCode;
      }
    `,
    expected: 111,
    // Matched clean and candidate behavior still returns undefined here. Keep
    // the raw A/B receipts in #6648; this pin prevents that pre-existing
    // prototype-overlay defect from being counted as a semantic pass.
    expectedFailure: true,
  },
  {
    name: "keeps an inherited canonical index above the signed capture parser domain",
    source: `
      Object.defineProperty(Array.prototype, "2147483648", { value: "high", configurable: true });

      export function run(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        let receiverCalls = 0;
        let keyCalls = 0;
        let key = "2147483648";
        const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
        const valueCode = value === "high" ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
        return receiverCalls * 100 + keyCalls * 10 + valueCode;
      }
    `,
    expected: 111,
  },
  {
    name: "keeps an own noncanonical named expando outside the capture index lane",
    source: `
      export function run(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        Object.defineProperty(source as any, "01", { value: "own", configurable: true });
        let receiverCalls = 0;
        let keyCalls = 0;
        let key = "01";
        const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
        const valueCode = value === "own" ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
        return receiverCalls * 100 + keyCalls * 10 + valueCode;
      }
    `,
    expected: 111,
  },
  {
    name: "keeps an inherited noncanonical named property outside the capture index lane",
    source: `
      Object.defineProperty(Array.prototype, "01", { value: "proto", configurable: true });

      export function run(): number {
        const source = /^(a)?(b)(c)$/.exec("bc");
        if (source === null) return 0;
        let receiverCalls = 0;
        let keyCalls = 0;
        let key = "01";
        const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
        const valueCode = value === "proto" ? 1 : value === undefined ? 2 : value === null ? 3 : 4;
        return receiverCalls * 100 + keyCalls * 10 + valueCode;
      }
    `,
    expected: 111,
  },
];

describe("#6648 standalone RegExp capture indexed-read overlay precedence", () => {
  for (const control of CONTROLS) {
    const run = async () => {
      expect(await runStandalone(control.source)).toBe(control.expected);
    };
    control.expectedFailure ? it.fails(control.name, run) : it(control.name, run);
  }
});

describe("#6648 standalone RegExp capture matched-slot deletion", () => {
  it("does not expose a matched raw capture after its own slot is deleted", async () => {
    const result = await runStandalone(`
      export function run(): number {
        const source = /^(a)?(b)(c)$/.exec("abc");
        if (source === null) return 0;
        delete (source as any)[1];
        let receiverCalls = 0;
        let keyCalls = 0;
        let key = "1";
        const value = (receiverCalls += 1, source)[(keyCalls += 1, key)];
        const valueCode = value === undefined ? 1 : value === "a" ? 2 : value === null ? 3 : 4;
        return receiverCalls * 100 + keyCalls * 10 + valueCode;
      }
    `);
    expect(result).toBe(111);
  });
});
