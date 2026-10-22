// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 propertyHelper move-only arm — propertyHelper.js reads descriptors
// through a STORED static alias, `var __getOwnPropertyDescriptor =
// Object.getOwnPropertyDescriptor;`, and the seven verify* helpers all start
// with `__getOwnPropertyDescriptor(obj, name).<attribute>`. Before this arm the
// dynamic move-only scan refused that call (`move-only[dyn|concrete]`), so
// every one of them stayed legacy. The call now lowers on the host-free lanes
// to the object runtime's native `__getOwnPropertyDescriptor` over two
// carriers, with a dynamic result — exactly legacy's
// `tryCompileStoredObjectBuiltinCall` lowering. Every result is compared with
// node.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { compile, type CompileResult } from "../src/index.js";

const ALIAS = "var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;";

// The helpers have propertyHelper's shape: they throw on a failed check. JSDoc
// pins the externref ABI legacy and the IR must agree on (propertyHelper's
// helpers are called with arbitrary objects, keys and messages).
const HELPERS = `
  /** @param {*} value @param {*} message */
  function assertTrue(value, message) { if (!value) { throw message; } }
  /** @param {object} obj @param {string|number|symbol} name */
  function expectWritable(obj, name) {
    if (!__getOwnPropertyDescriptor(obj, name).writable) { throw "expected writable"; }
  }
  /** @param {object} obj @param {string|number|symbol} name */
  function expectNotWritable(obj, name) {
    if (__getOwnPropertyDescriptor(obj, name).writable) { throw "expected not writable"; }
  }
  /** @param {object} obj @param {string|number|symbol} name */
  function expectEnumerable(obj, name) {
    var desc = __getOwnPropertyDescriptor(obj, name);
    if (!desc.enumerable) { throw "expected enumerable"; }
  }
  /** @param {object} obj @param {string|number|symbol} name */
  function expectConfigurable(obj, name) {
    assertTrue(__getOwnPropertyDescriptor(obj, name).configurable, "expected configurable");
  }
`;

const PROBE = `
  export function probe(): number {
    var o = { a: 1 };
    Object.defineProperty(o, "b", { value: 2, writable: false, enumerable: false, configurable: false });
    var n = 0;
    try { expectWritable(o, "a"); n += 1; } catch (e) {}
    try { expectWritable(o, "b"); } catch (e) { n += 2; }
    try { expectNotWritable(o, "b"); n += 4; } catch (e) {}
    try { expectEnumerable(o, "a"); n += 8; } catch (e) {}
    try { expectEnumerable(o, "b"); } catch (e) { n += 16; }
    try { expectConfigurable(o, "a"); n += 32; } catch (e) {}
    try { expectConfigurable(o, "b"); } catch (e) { n += 64; }
    try { expectWritable([5], 0); expectNotWritable(Array.prototype.map, "length"); n += 128; } catch (e) {}
    try { expectWritable(o, "missing"); } catch (e) { if (e instanceof TypeError) n += 256; }
    return n;
  }
`;

const HELPER_NAMES = ["expectWritable", "expectNotWritable", "expectEnumerable", "expectConfigurable"];

async function compileProbe(
  source: string,
  target?: "standalone" | "wasi",
  semanticProviders?: "host-assisted",
): Promise<CompileResult> {
  const result = await compile(source, {
    ...(target ? { target } : {}),
    ...(semanticProviders ? { semanticProviders } : {}),
    experimentalIR: true,
    skipSemanticDiagnostics: true,
    allowJs: true,
    fileName: "issue-7106-gopd.ts",
    trackIrOutcomes: true,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

function irBodies(result: CompileResult): string[] {
  return (result.irOutcomes ?? []).filter((o) => o.kind === "emitted" && o.irBodyEmitted).map((o) => o.displayName);
}

function outcomeOf(result: CompileResult, name: string) {
  return (result.irOutcomes ?? []).find((outcome) => outcome.displayName === name);
}

function nodeProbe(source: string): unknown {
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => unknown> = {};
  new Function("exports", js)(exports);
  return exports.probe!();
}

async function wasmProbe(result: CompileResult): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports.probe as () => number)();
}

describe("#7106 propertyHelper — the stored Object.getOwnPropertyDescriptor alias", () => {
  const source = `${ALIAS}${HELPERS}${PROBE}`;

  it("standalone: every descriptor check ships an IR body and answers like node", async () => {
    const result = await compileProbe(source, "standalone");
    expect(irBodies(result)).toEqual(expect.arrayContaining(HELPER_NAMES));
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    const got = await wasmProbe(result);
    expect(got).toBe(nodeProbe(source));
    expect(got).toBe(511);
  });

  it("wasi: the same checks ship IR bodies and validate", async () => {
    const result = await compileProbe(source, "wasi");
    expect(irBodies(result)).toEqual(expect.arrayContaining(HELPER_NAMES));
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
  });

  it("gc under the default native-first regime ships the same IR bodies and answers like node", async () => {
    const result = await compileProbe(source);
    expect(irBodies(result)).toEqual(expect.arrayContaining(HELPER_NAMES));
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(await wasmProbe(result)).toBe(nodeProbe(source));
  });

  it("refuses before claim on the host-assisted gc lane, which has no native provider", async () => {
    const result = await compileProbe(source, undefined, "host-assisted");
    for (const name of HELPER_NAMES) expect(outcomeOf(result, name)).toMatchObject({ irBodyEmitted: false });
    expect((result.irPostClaimErrors ?? []).filter((error) => HELPER_NAMES.includes(error.func))).toEqual([]);
    // No node comparison here: on this lane the helpers are all legacy, and
    // legacy answers 86 where node answers 511 — identical on the base, a
    // pre-existing direct-path gap outside this arm.
  });

  it("does not certify a reassigned alias", async () => {
    // Only the IR refusal is asserted: legacy itself still treats this alias
    // as the builtin (it answers 511 where node answers 86), a pre-existing
    // direct-path gap outside this arm.
    const reassigned = `${ALIAS}
      __getOwnPropertyDescriptor = function (o, k) { return { writable: false }; };
      ${HELPERS}${PROBE}`;
    const result = await compileProbe(reassigned, "standalone");
    for (const name of HELPER_NAMES) {
      expect(outcomeOf(result, name)).toMatchObject({ irBodyEmitted: false, stage: "select" });
    }
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });
});
