/**
 * #3536 (#2860) — standalone: object-literal argument to a declared function
 * arrived null (struct/externref call-boundary mismatch).
 *
 * Two arms, one boundary:
 *  1. Silent-null: a literal in call-ARGUMENT position to a declared function
 *     whose implicit-`any` param was call-site-narrowed to the literal's own
 *     shape struct built a dynamic `$Object` (its TS-contextual type is
 *     `any`), and the call-boundary guarded cast (externref → shape struct)
 *     yielded `ref.null` — the callee's param read null on first property
 *     access. This is the `built-ins/RegExp/property-escapes` cluster's
 *     `buildString({...})` shape (311 baseline rows).
 *  2. Invalid wasm: the IR overlay re-typed such a function's param to
 *     externref and patched the signature AFTER legacy callers had emitted
 *     coercions against the collect-time struct type — V8 rejected the
 *     module ("call[0] expected type externref, found …").
 *
 * Fixes under test:
 *  - literals.ts: an argument literal whose own struct resolution lands
 *    exactly on the expected param typeIdx constructs that closed struct
 *    (matching the var-init position, which already passed).
 *  - ir/integration.ts: the typeIdx parity guard now covers top-level
 *    FunctionDeclarations — on divergence the IR withdraws its claim
 *    (soft `abi-signature-parity` fallback) and the legacy body/ABI stays.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<{ ok: boolean; error?: string }> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "test.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  if (!result.success || result.errors.some((e) => e.severity === "error")) {
    return {
      ok: false,
      error: `compile: ${result.errors
        .filter((e) => e.severity === "error")
        .map((e) => e.message)
        .join("; ")}`,
    };
  }
  expect(result.imports).toHaveLength(0);
  const importObj = buildImports(result.imports, undefined, result.stringPool) as Record<string, unknown>;
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiate(result.binary, importObj as WebAssembly.Imports));
  } catch (err) {
    return { ok: false, error: `instantiate: ${String(err)}` };
  }
  const init = (instance.exports as Record<string, unknown>).__module_init;
  try {
    if (typeof init === "function") (init as () => void)();
  } catch (err) {
    return { ok: false, error: `init threw: ${String(err)}` };
  }
  return { ok: true };
}

describe("#3536 declared-function object-literal argument boundary (standalone)", () => {
  it("regExpUtils buildString shape: the literal argument reaches the param intact", async () => {
    const r = await runStandalone(`
function buildString(args) {
  const lone = args.loneCodePoints;
  if (lone === undefined || lone === null) throw new Error("args.loneCodePoints null");
  return lone.length;
}
var r = buildString({ loneCodePoints: [1, 2, 3], ranges: [[1, 2]] });
if (r !== 3) throw new Error("bad " + r);
`);
    expect(r.error ?? "").toBe("");
    expect(r.ok).toBe(true);
  });

  it("direct property return (the IR-claimed shape): valid wasm, correct value", async () => {
    const r = await runStandalone(`
function f(a) { return a.x; }
var r = f({ x: 1 });
if (r !== 1) throw new Error("bad " + r);
`);
    expect(r.error ?? "").toBe("");
    expect(r.ok).toBe(true);
  });

  it("array-valued property via param read", async () => {
    const r = await runStandalone(`
function f(a) { return a.x; }
var r = f({ x: [1, 2, 3] });
if (r.length !== 3) throw new Error("bad");
`);
    expect(r.error ?? "").toBe("");
    expect(r.ok).toBe(true);
  });

  it("nested-array property (the ranges shape)", async () => {
    const r = await runStandalone(`
function f(a) { return a.y; }
var r = f({ x: [1, 2], y: [[1, 2], [3, 4]] });
if (r.length !== 2) throw new Error("bad");
`);
    expect(r.error ?? "").toBe("");
    expect(r.ok).toBe(true);
  });

  it("var-assigned literal control keeps passing (the previously-working shape)", async () => {
    const r = await runStandalone(`
function f(args) {
  const lone = args.loneCodePoints;
  if (lone == null) throw new Error("null lone");
  return lone.length;
}
var obj = { loneCodePoints: [1, 2, 3], ranges: [[1, 2]] };
var r = f(obj);
if (r !== 3) throw new Error("bad " + r);
`);
    expect(r.error ?? "").toBe("");
    expect(r.ok).toBe(true);
  });
});
