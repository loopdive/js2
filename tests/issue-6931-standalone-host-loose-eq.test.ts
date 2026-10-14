// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6931 — loose `==` on a HOST value passed into an `any` parameter.
 *
 * A standalone module has no host imports, so it cannot inspect a raw JS value
 * (string, object, `undefined`, `true`, a heap number): all of them reach Wasm
 * as the same opaque non-`eq` reference. §7.2.15 needs ToPrimitive /
 * StringToNumber on exactly those values, so on standalone `__any_eq` refuses
 * them with a deliberate in-module TypeError instead of trapping `illegal cast`
 * (IR path: `__extern_loose_eq` -> `__any_eq` -> `__str_to_number`) or silently
 * answering `0`. Values the module can read — i31-range integers, null, its own
 * boxes — still compare exactly as Node does. On gc every input matches Node.
 *
 * Scope: only the shared `__any_eq` runtime is guarded. The legacy direct
 * AST->Wasm externref cascade (`compileTypedBinaryDispatch`) is frozen
 * (2026-10-11) and is deliberately NOT fixed: it still answers wrong for host
 * values. The legacy block below only guards that it does not trap.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const MESSAGE = "TypeError: Cannot compare a host JavaScript value with == in a standalone module";

// IR path: every function here is IR-emitted on both targets (asserted below).
const IR_SRC = `export function eqUsed(o: any): number { return o == 1 ? 1 : 0; }
export function eqStr(o: any): number { return o == "1" ? 1 : 0; }
export function neUsed(o: any): number { return o != 1 ? 1 : 0; }
`;
// Legacy path: on standalone the selector sends eqUsed / exported to the
// legacy lowering (the externref cascade in compileTypedBinaryDispatch), which
// does not go through `__any_eq` and is NOT fixed by #6931.
const LEGACY_SRC = `function eqUsed(o: any): number { return o == 1 ? 1 : 0; }
export function viaStr(): number { return eqUsed("1"); }
export function viaBool(): number { return eqUsed(true); }
export function viaObj(): number { return eqUsed({ valueOf() { return 1; } }); }
export function viaUndef(): number { return eqUsed(undefined); }
export function exported(o: any): number { return eqUsed(o); }
`;
const NATIVE_INPUTS: [string, () => unknown][] = [
  ["1", () => 1],
  ["5", () => 5],
  ["null", () => null],
];
const HOST_INPUTS: [string, () => unknown][] = [
  ["1.5", () => 1.5],
  ['"1"', () => "1"],
  ['"x"', () => "x"],
  ["{}", () => ({})],
  ["{valueOf:()=>1}", () => ({ valueOf: () => 1 })],
  ["undefined", () => undefined],
  ["true", () => true],
];

function nodeOracle(src: string): Record<string, (...a: unknown[]) => unknown> {
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (...a: unknown[]) => unknown> = {};
  new Function("exports", js)(exports);
  return exports;
}

async function build(src: string, target: "gc" | "standalone") {
  const r = await compile(src, {
    fileName: "issue-6931.ts",
    trackIrOutcomes: true,
    ...(target === "standalone" ? { target } : {}),
  });
  expect(r.success, r.success ? undefined : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imp = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, imp.env, imp.string_constants);
  (imp as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
  const kinds = new Map((r.irOutcomes ?? []).map((u) => [u.displayName, `${u.kind}${u.irBodyEmitted ? "+body" : ""}`]));
  return { r, ex: instance.exports as Record<string, any>, kinds };
}

/** The deliberate refusal: a Wasm exception carrying the native TypeError, rendered in-module. */
function expectHostRefusal(ex: Record<string, any>, call: () => unknown): void {
  let caught: unknown;
  try {
    call();
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected a deliberate throw").toBeDefined();
  expect(caught).not.toBeInstanceOf(WebAssembly.RuntimeError);
  expect(caught).toBeInstanceOf(WebAssembly.Exception);
  const payload = (caught as WebAssembly.Exception).getArg(ex.__exn_tag, 0);
  const len = ex.__exn_render_prepare(payload) as number;
  let rendered = "";
  for (let i = 0; i < len; i++) rendered += String.fromCharCode(ex.__exn_render_char(i));
  expect(rendered).toBe(MESSAGE);
}

describe("#6931 standalone loose == on a host value in an `any` parameter", () => {
  for (const target of ["gc", "standalone"] as const) {
    it(`IR path stays IR-emitted on ${target}`, async () => {
      const { kinds } = await build(IR_SRC, target);
      for (const fn of ["eqUsed", "eqStr", "neUsed"]) expect(kinds.get(fn)).toBe("emitted+body");
    });
  }

  it("gc: IR and legacy sources match Node for every input", async () => {
    for (const [src, fns] of [
      [IR_SRC, ["eqUsed", "eqStr", "neUsed"]],
      [LEGACY_SRC, ["exported"]],
    ] as const) {
      const node = nodeOracle(src);
      const { ex } = await build(src, "gc");
      for (const fn of fns)
        for (const [label, mk] of [...NATIVE_INPUTS, ...HOST_INPUTS]) {
          expect(ex[fn](mk()), `${fn}(${label})`).toBe(node[fn]!(mk()));
        }
    }
  });

  it("standalone IR path: native inputs match Node, host inputs throw the deliberate TypeError", async () => {
    const node = nodeOracle(IR_SRC);
    const { r, ex } = await build(IR_SRC, "standalone");
    expect(r.imports).toHaveLength(0);
    for (const fn of ["eqUsed", "eqStr", "neUsed"]) {
      for (const [label, mk] of NATIVE_INPUTS) expect(ex[fn](mk()), `${fn}(${label})`).toBe(node[fn]!(mk()));
      for (const [, mk] of HOST_INPUTS) expectHostRefusal(ex, () => ex[fn](mk()));
    }
  });

  it("standalone legacy path (PRE-EXISTING, not fixed by #6931): native values match Node, host values do not trap", async () => {
    const node = nodeOracle(LEGACY_SRC);
    const { r, ex, kinds } = await build(LEGACY_SRC, "standalone");
    expect(r.imports).toHaveLength(0);
    expect(kinds.get("eqUsed")).toBe("unsupported");
    expect(kinds.get("exported")).toBe("unsupported");
    // Source-created values never reach a host-value path: match Node.
    for (const fn of ["viaStr", "viaBool", "viaObj", "viaUndef"]) expect(ex[fn](), fn).toBe(node[fn]!());
    for (const [label, mk] of NATIVE_INPUTS) expect(ex.exported(mk()), `exported(${label})`).toBe(node.exported!(mk()));
    // Host values: the frozen legacy cascade still answers (sometimes wrongly,
    // e.g. exported("1") -> 0 where Node says 1). Guard only against a trap.
    for (const [label, mk] of HOST_INPUTS) expect(typeof ex.exported(mk()), `exported(${label})`).toBe("number");
  });
});
