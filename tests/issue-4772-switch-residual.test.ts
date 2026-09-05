// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4772 — close the ES2015 switch residual slice.  The semantic controls below
// exercise the selector/boundary behavior that a switch declaration fix must
// not disturb: source-ordered selector evaluation, StrictEquality, default
// placement, fall-through/break, abrupt completion, and a neighboring ordinary
// switch.  The first control is the switch-owned strict CaseBlock declaration
// residual: Annex B's web-compat outer binding is not active in strict code.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-4772-switch-residual.ts",
    skipSemanticDiagnostics: true,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), `${lane} module failed validation`).toBe(true);

  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => number }).test();
  }

  const imports = result.importObject!;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { __setInstance?: (value: WebAssembly.Instance) => void }).__setInstance?.(instance);
  return (instance.exports as { test: () => number }).test();
}

const STRICT_CASEBLOCK_FUNCTION = `
  export function test(): number {
    "use strict";
    let mask = 0;
    try { f; } catch (error) {
      if (error instanceof ReferenceError) mask |= 1;
    }
    switch (1) {
      case 1:
        function f() { return 7; }
        break;
    }
    try { f; } catch (error) {
      if (error instanceof ReferenceError) mask |= 2;
    }
    return mask;
  }
`;

const SELECTOR_ORDER_AND_COUNT = `
  export function test(): number {
    let trace = 0;
    const value = 2;
    switch (value) {
      case (trace = trace * 10 + 1, 0):
        trace = trace * 10 + 9;
        break;
      case (trace = trace * 10 + 2, 2):
        trace = trace * 10 + 4;
        break;
      case (trace = trace * 10 + 3, 3):
        trace = trace * 10 + 8;
        break;
    }
    return trace;
  }
`;

const STRICT_EQUALITY = `
  export function test(): number {
    const value: any = 1;
    let hit = 0;
    switch (value) {
      case "1":
        hit = 10;
        break;
      case 1:
        hit = 20;
        break;
      default:
        hit = 30;
    }
    return hit;
  }
`;

const DEFAULT_FALLTHROUGH_AND_BREAK = `
  export function test(): number {
    let selected = 0;
    switch (2) {
      case 1:
        selected = 1;
        break;
      default:
        selected += 10;
      case 2:
        selected += 20;
        break;
    }

    let unmatched = 0;
    switch (9) {
      case 1:
        unmatched = 1;
        break;
      default:
        unmatched += 10;
      case 2:
        unmatched += 100;
        break;
    }
    return selected + unmatched;
  }
`;

const ABRUPT_COMPLETION = `
  export function test(): number {
    let caught = 0;
    try {
      switch (1) {
        case 1:
          throw new Error("switch abrupt");
        default:
          caught = 1;
      }
    } catch (error) {
      if (error instanceof Error) caught = 2;
    }
    return caught;
  }
`;

const ADJACENT_PASS_CONTROL = `
  export function test(): number {
    switch (3) {
      case 1:
        return 0;
      default:
        return 1;
    }
  }
`;

describe("#4772 ES2015 switch residual controls", () => {
  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: strict CaseBlock function does not leak outside the switch`, async () => {
      await expect(run(STRICT_CASEBLOCK_FUNCTION, lane)).resolves.toBe(3);
    });

    it(`${lane}: case selectors evaluate once in source order`, async () => {
      await expect(run(SELECTOR_ORDER_AND_COUNT, lane)).resolves.toBe(124);
    });

    it(`${lane}: switch dispatch uses StrictEquality`, async () => {
      await expect(run(STRICT_EQUALITY, lane)).resolves.toBe(20);
    });

    it(`${lane}: default placement, fall-through, and break remain ordered`, async () => {
      await expect(run(DEFAULT_FALLTHROUGH_AND_BREAK, lane)).resolves.toBe(130);
    });

    it(`${lane}: abrupt clause completion propagates through the switch`, async () => {
      await expect(run(ABRUPT_COMPLETION, lane)).resolves.toBe(2);
    });

    it(`${lane}: adjacent ordinary switch control still passes`, async () => {
      await expect(run(ADJACENT_PASS_CONTROL, lane)).resolves.toBe(1);
    });
  }
});
