// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2861 — standalone native-proto glue for Promise / Iterator / NativeError
 * subclasses.
 *
 * In `--target standalone`, reading a `<Builtin>.prototype` (or
 * `<Builtin>.prototype.<member>`) as a first-class VALUE refused with
 * "built-in static property value read is not supported in --target standalone"
 * for builtins lacking native-proto glue. This wires the glue for Promise,
 * Iterator, and the six NativeError subclasses (TypeError/RangeError/
 * ReferenceError/SyntaxError/EvalError/URIError) so those value reads resolve to
 * a host-free `$NativeProto` object instead of compile-erroring.
 *
 * The change is `ctx.standalone`-gated (host mode never reaches
 * `tryEnsureNativeProtoBrand`), additive, and adds zero host imports. Promise is
 * wired for the STATIC `.prototype` value read only — the #1907 null-deref was
 * an INSTANCE-state read, which this glue never touches.
 */

async function standaloneCompiles(src: string): Promise<{ ok: boolean; err: string; hostImports: string[] }> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  const hostImports = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => l.startsWith("env::__"));
  return { ok: r.success, err: r.success ? "" : r.errors.map((e) => e.message).join(" | "), hostImports };
}

async function standaloneRun(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2861 — standalone proto-glue value reads compile host-free", () => {
  const cases: Array<[string, string]> = [
    ["Promise.prototype.then", `const f: any = Promise.prototype.then; return typeof f === "function" ? 1 : 0;`],
    ["Promise.prototype.finally", `const f: any = Promise.prototype.finally; return typeof f === "function" ? 1 : 0;`],
    ["TypeError.prototype", `const p: any = TypeError.prototype; return p ? 1 : 0;`],
    [
      "RangeError.prototype.toString",
      `const f: any = RangeError.prototype.toString; return typeof f === "function" ? 1 : 0;`,
    ],
    ["ReferenceError.prototype", `const p: any = ReferenceError.prototype; return p ? 1 : 0;`],
    ["SyntaxError.prototype", `const p: any = SyntaxError.prototype; return p ? 1 : 0;`],
    ["EvalError.prototype", `const p: any = EvalError.prototype; return p ? 1 : 0;`],
    ["URIError.prototype", `const p: any = URIError.prototype; return p ? 1 : 0;`],
  ];
  for (const [label, body] of cases) {
    it(`${label} compiles standalone with no host import`, async () => {
      const src = `export function test(): number { ${body} }`;
      const { ok, err, hostImports } = await standaloneCompiles(src);
      expect(ok, err).toBe(true);
      expect(hostImports).toEqual([]);
    });
  }
});

describe("#2861 — proto-member value read resolves to a callable closure value", () => {
  // A `<NativeError>.prototype.<method>` value read resolves to a native
  // method-closure whose `typeof` folds to "function" (the test262
  // `is-function` rows). The broader per-builtin runtime conversion (Promise /
  // Iterator helper rows, NativeError descriptor rows) is validated by the
  // test262 merge_group; this is a fast in-repo regression guard for the flip.
  it('typeof RangeError.prototype.toString === "function" standalone', async () => {
    expect(
      await standaloneRun(
        `export function test(): number { return (typeof RangeError.prototype.toString === "function") ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});
