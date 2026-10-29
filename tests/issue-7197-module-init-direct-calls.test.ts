// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7197 — `<module-init>`'s direct calls to same-source functions get exact
// AST-site plans on the general route. The lowering-plan projection walked
// each owner's declaration only; `<module-init>` has none, so every direct
// call it (or a planned member closure inside it) made was claimed and then
// withdrawn ("direct call to `f` has no exact AST-site plan").

import { WASI } from "node:wasi";
import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

type Lane = "standalone" | "wasi" | "gc";

const OPTIONS = {
  target: "standalone",
  allowJs: true,
  fileName: "test.js",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function initRow(result: CompileResult) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** `<module-init>` runs on `lane`, then `out()` reports what it observed (or "threw"). */
async function observe(result: CompileResult, lane: Lane): Promise<number | "threw"> {
  let exports: WebAssembly.Exports;
  if (lane === "gc") {
    const runtime = buildImports(result.imports ?? [], undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      runtime.env,
      runtime.string_constants,
      runtime.string_constants16,
    );
    runtime.setInstance?.(instance);
    exports = instance.exports;
  } else {
    const wasi = lane === "wasi" ? new WASI({ version: "preview1", args: [], env: {} }) : undefined;
    const instance = await WebAssembly.instantiate(
      await WebAssembly.compile(result.binary),
      (wasi?.getImportObject() ?? {}) as WebAssembly.Imports,
    );
    exports = instance.exports;
  }
  try {
    // WASI runs the initializer from its `_start` export (#3523 R4).
    ((exports.__module_init ?? exports._start) as () => void)();
  } catch (error) {
    // An uncaught throw is a Wasm exception on standalone, a host error on gc,
    // and a `proc_exit` on WASI; a trap is never a throw.
    if (
      !(error instanceof WebAssembly.RuntimeError) &&
      (lane !== "standalone" || error instanceof WebAssembly.Exception)
    )
      return "threw";
    throw error;
  }
  return (exports.out as () => number)();
}

function node(source: string): number | "threw" {
  try {
    return new Function(`${source.replace(/\bexport /g, "")}\nreturn out();`)() as number;
  } catch {
    return "threw";
  }
}

const SINK = `/** @returns {number} */ function sink() { return 0; }\n`;

describe("#7197 — direct calls in <module-init>", () => {
  it.each([
    ["a top-level call", `function f() { return 1; }\nf();\nexport function out() { return 7; }`],
    [
      "a call whose callee throws",
      `/** @returns {void} */ function f() { throw "x"; }\nf();\nexport function out() { return 7; }`,
    ],
    [
      "a member closure calling its receiver beside a call statement",
      `/** @returns {number} */ function subject() { return 0; }
subject.f = function (m, k) { if (k === 9) return; subject(); throw m; };
subject.f(1, 9);
export function out() { var n = 0; try { subject.f(2, 0); } catch (e) { if (e === 2) n = 1; } return n; }`,
    ],
    [
      "calls to two functions in order",
      `${SINK}function a() { return 1; }\nfunction b() { return 2; }\na();\nb();\nexport function out() { return 3; }`,
    ],
  ])(
    "claims %s on every lane and agrees with legacy and node",
    async (_name, source) => {
      const expected = node(source);
      for (const lane of ["standalone", "wasi", "gc"] as const) {
        const ir = await compile(source, { ...OPTIONS, target: lane });
        expect(initRow(ir).irBodyEmitted, lane).toBe(true);
        const legacy = await compile(source, { ...OPTIONS, target: lane, experimentalIR: false });
        expect(await observe(ir, lane), lane).toBe(expected);
        expect(await observe(legacy, lane), lane).toBe(expected);
      }
    },
    90_000,
  );
});
