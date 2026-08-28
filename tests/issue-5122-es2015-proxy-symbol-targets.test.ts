// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const EXACT_FILES = [
  "built-ins/Proxy/create-target-not-object-throw-symbol.js",
  "built-ins/Proxy/create-handler-not-object-throw-symbol.js",
] as const;

const REPO_ROOT = join(import.meta.dirname ?? ".", "..");
const TEST262_ROOT = join(REPO_ROOT, "test262");
const EXACT_TEST_TIMEOUT_MS = 180_000;
const CONTROL_TEST_TIMEOUT_MS = 180_000;
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const test262It = TEST262_AVAILABLE ? it : it.skip;

/**
 * Compiler controls for #5122.  The invalid static calls deliberately rely on
 * `skipSemanticDiagnostics`: the TypeScript lib types reject a Symbol where
 * the JavaScript Proxy constructor accepts the value and throws at runtime.
 * Every return code identifies a distinct conformance seam so a lane failure
 * points at the first broken control rather than hiding behind one assertion.
 */
const CONTROL_SOURCE = `
let order = 0;
let trapReads = 0;

function expectTypeError(target: any, handler: any): number {
  try {
    new Proxy(target, handler);
    return 0;
  } catch (error) {
    return error instanceof TypeError ? 1 : 2;
  }
}

function expectValid(target: any, handler: any): number {
  try {
    const proxy = new Proxy(target, handler);
    return proxy === null ? 0 : 1;
  } catch (_error) {
    return 0;
  }
}

function mark(value: number): any {
  order = order * 10 + value;
  return {};
}

function invalidTarget(): any {
  order = order * 10 + 1;
  return Symbol();
}

function invalidHandler(): any {
  order = order * 10 + 2;
  return {};
}

function extraSideEffect(): any {
  order = order * 10 + 3;
  return {};
}

function laterAbrupt(): any {
  order = order * 10 + 4;
  throw new Error("later extra argument");
}

function dynamicProxyArgs(): any[] {
  order = order * 10 + 2;
  return [mark(3), mark(4)];
}

function expectSpreadValid(args: any[]): number {
  try {
    const proxy = new Proxy(...args);
    return proxy === null ? 0 : 1;
  } catch (_error) {
    return 0;
  }
}

function expectSpreadTypeError(args: any[]): number {
  try {
    new Proxy(...args);
    return 0;
  } catch (error) {
    return error instanceof TypeError ? 1 : 2;
  }
}

function abruptSpreadIterable(): any {
  return {
    [Symbol.iterator](): any {
      return {
        next(): any {
          order = order * 10 + 6;
          throw new Error("iterator step");
        },
      };
    },
  };
}

function proxyCalleeBeforeSymbolCaller(target: any, handler: any): number {
  return expectTypeError(target, handler);
}

function proxyCalleeBeforeSpreadCaller(args: any[]): number {
  return expectSpreadValid(args);
}

function symbolCaller(): any {
  return Symbol();
}

export function test(): number {
  // Static Symbol target and handler carriers.
  if (expectTypeError(Symbol(), {}) !== 1) return 1;
  if (expectTypeError({}, Symbol()) !== 1) return 2;

  // Dynamic any carriers, with the Proxy callee compiled before its caller.
  if (proxyCalleeBeforeSymbolCaller(symbolCaller(), {}) !== 1) return 3;
  if (proxyCalleeBeforeSymbolCaller({}, symbolCaller()) !== 1) return 4;

  // Static and dynamic spread sources expand before Proxy validation. The
  // dynamic helper also exercises the callee-before-caller index-shift seam.
  if (expectSpreadValid([{}, {}]) !== 1) return 5;
  if (expectSpreadValid([{}, {}, {}, {}]) !== 1) return 6;
  if (expectSpreadTypeError([]) !== 1) return 34;
  try {
    const nestedSpread = new Proxy(...[...[{}, {}]]);
    if (nestedSpread === null) return 35;
  } catch (_error) {
    return 36;
  }
  if (proxyCalleeBeforeSpreadCaller([{}, {}]) !== 1) return 7;
  if (expectSpreadTypeError([Symbol(), {}]) !== 1) return 8;
  if (expectSpreadTypeError([{}, Symbol()]) !== 1) return 9;

  // ArgumentListEvaluation: retain target/handler, then evaluate every extra
  // exactly once and in order before the constructor validates either value.
  order = 0;
  try {
    const proxy = new Proxy(mark(1), mark(2), mark(3), mark(4));
    if (proxy === null || order !== 1234) return 10;
  } catch (_error) {
    return 11;
  }

  // Mixed ordinary and spread arguments preserve source evaluation order, and
  // every expanded extra is evaluated before construction validates the pair.
  order = 0;
  try {
    const proxy = new Proxy(mark(1), ...[mark(2), mark(3)], mark(4));
    if (proxy === null || order !== 1234) return 12;
  } catch (_error) {
    return 13;
  }

  order = 0;
  try {
    const proxy = new Proxy(mark(1), ...dynamicProxyArgs(), mark(5));
    if (proxy === null || order !== 12345) return 14;
  } catch (_error) {
    return 15;
  }

  // A later abrupt extra argument wins over target/handler validation.
  order = 0;
  try {
    new Proxy(invalidTarget(), invalidHandler(), extraSideEffect(), laterAbrupt());
    return 16;
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || order !== 1234) return 17;
  }

  // The iterator itself is driven before Proxy validation; an abrupt later
  // step wins even when the syntactic target is valid.
  order = 0;
  try {
    new Proxy({}, ...abruptSpreadIterable());
    return 18;
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || order !== 6) return 19;
  }

  // Target validation precedes all handler trap reads.
  trapReads = 0;
  const handlerWithGetter: any = {
    get get() {
      trapReads = trapReads + 1;
      return undefined;
    },
  };
  if (expectTypeError(Symbol(), handlerWithGetter) !== 1) return 20;
  if (trapReads !== 0) return 21;

  trapReads = 0;
  if (expectSpreadTypeError([Symbol(), handlerWithGetter]) !== 1) return 22;
  if (trapReads !== 0) return 23;

  // Expanded object/array/function/nested-Proxy carriers remain valid.
  if (expectSpreadValid([{}, {}]) !== 1) return 24;
  if (expectSpreadValid([[], {}]) !== 1) return 25;
  if (expectSpreadValid([function spreadCallable() {}, {}]) !== 1) return 26;
  const spreadNested = new Proxy({}, {});
  if (expectSpreadValid([spreadNested, {}]) !== 1) return 27;

  // Valid object-like siblings: ordinary object, array, callable, and nested
  // Proxy carriers remain accepted by the shared native constructor.
  if (expectValid({}, {}) !== 1) return 28;
  if (expectValid([], {}) !== 1) return 29;
  if (expectValid(function callable() {}, {}) !== 1) return 30;
  const nested = new Proxy({}, {});
  if (expectValid(nested, {}) !== 1) return 31;

  // Keep the original reported blocker as a direct static regression, not
  // only through the dynamic helper above.
  try {
    const directSpread = new Proxy(...[{}, {}]);
    if (directSpread === null) return 32;
  } catch (_error) {
    return 33;
  }

  return 0;
}
`;

async function runControl(lane: Lane): Promise<number> {
  const options = lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : ({} as const);
  const result = await compile(CONTROL_SOURCE, {
    fileName: `issue-5122-${lane}.ts`,
    skipSemanticDiagnostics: true,
    ...options,
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("\n")).toBe(true);
  if (!result.success) return -1;
  if (lane === "standalone") expect(result.imports).toEqual([]);

  const imports = lane === "host" ? buildImports(result.imports, undefined, result.stringPool) : {};
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return Number((instance.exports as { test: () => number }).test());
}

describe("#5122 Proxy Symbol target/handler validation", () => {
  test262It.each(EXACT_FILES)(
    "passes the exact host Test262 row %s",
    async (file) => {
      const result = await runTest262File(join(TEST262_ROOT, "test", file), "issue-5122", 120_000);
      expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    EXACT_TEST_TIMEOUT_MS,
  );

  test262It.each(EXACT_FILES)(
    "passes the exact standalone Test262 row %s",
    async (file) => {
      const result = await runTest262File(join(TEST262_ROOT, "test", file), "issue-5122", 120_000, "standalone");
      expect(result.status, `${file}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    EXACT_TEST_TIMEOUT_MS,
  );

  it(
    "passes the static/dynamic, ordering, validation, and sibling controls in host mode",
    async () => {
      await expect(runControl("host")).resolves.toBe(0);
    },
    CONTROL_TEST_TIMEOUT_MS,
  );

  it(
    "passes the static/dynamic, ordering, validation, and sibling controls host-free",
    async () => {
      await expect(runControl("standalone")).resolves.toBe(0);
    },
    CONTROL_TEST_TIMEOUT_MS,
  );
});
