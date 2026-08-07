// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4207 — a method installed on a builtin PROTOTYPE must be reachable through a
// PRIMITIVE receiver in `--target standalone`.
//
// #4207 was filed as "the transfer form skips the [[Class]] brand check and the
// primitive-receiver coercion". It is not. The brand check and the
// `ToString(this)` both exist and both work — the closure they live in was
// simply never invoked, because a primitive receiver resolved nothing from its
// wrapper prototype. The proof is the first case below: a PLAIN user function
// fails identically, with no builtin method anywhere in sight.
//
// ── Why every case must be RED on base ────────────────────────────────────
// The failure mode this file guards is a silent `undefined`, so a fixture that
// asserts the wrong thing passes on unfixed main and asserts nothing. Each case
// therefore states a value that is NOT `undefined`/`null`, and the
// `PRECONDITION` case is separately named: it is green on BOTH arms and proves
// the probe reached the substrate at all.
//
// ── Harness: no `export`, throw-to-fail (inherited from #4190/#4202/#4203) ─
// A top-level `export` makes TypeScript call the source a MODULE, and module
// code is strict throughout — which changes `this` binding for exactly the
// receivers under test. So the body carries no export, signals failure by
// throwing, and completing `__module_init` IS the pass;
// `inferModuleStrictArguments: false` pins the Script goal the way
// `runTest262File` does.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile + run `body` as a sloppy standalone SCRIPT. Thrown text, or null. */
async function runStandalone(body: string): Promise<string | null> {
  const result = await compile(body, {
    allowJs: true,
    fileName: "issue-4207.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone" as const,
    deferTopLevelInit: true,
    hostBridge: "always",
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  expect(WebAssembly.validate(result.binary), "module must be valid Wasm").toBe(true);
  // A standalone module must not need a JS host to answer a prototype-chain
  // question — the whole point of the lane.
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((i) => i.module)).not.toContain("env");
  const { instance } = await WebAssembly.instantiate(result.binary, {} as never);
  try {
    (instance.exports as Record<string, () => void>).__module_init?.();
    return null;
  } catch (error) {
    return String((error as { message?: unknown })?.message ?? error);
  }
}

const check = (expr: string, want: string) =>
  `var __r = ${expr}; if (String(__r) !== ${JSON.stringify(want)}) { throw new Error("got " + String(__r)); }`;

describe("#4207 primitive receiver resolves an inherited builtin-prototype method", () => {
  it("PRECONDITION: a plain-object receiver already resolves it (green on BOTH arms)", async () => {
    expect(
      await runStandalone(`Object.prototype.zz = function () { return 42; };\n${check("({}).zz()", "42")}`),
    ).toBeNull();
  });

  it("a PLAIN user function on Number.prototype, invoked through a number", async () => {
    expect(
      await runStandalone(`Number.prototype.zz = function () { return 42; };\nvar n = 5;\n${check("n.zz()", "42")}`),
    ).toBeNull();
  });

  it("Object.prototype, invoked through a number and through a boolean", async () => {
    expect(
      await runStandalone(
        `Object.prototype.zz = function () { return 42; };\nvar n = 1.0;\nvar b = false;\n` +
          `${check("n.zz()", "42")}\n${check("b.zz()", "42")}`,
      ),
    ).toBeNull();
  });

  it("a transferred String.prototype method runs ToString(this) on a number receiver", async () => {
    // S15.5.4.16_A1_T7 in miniature: the coercion was never skipped, the method
    // was never called.
    expect(
      await runStandalone(
        `Number.prototype.toLowerCase = String.prototype.toLowerCase;\n${check("NaN.toLowerCase()", "nan")}`,
      ),
    ).toBeNull();
  });

  it("a transferred RegExp.prototype method runs its brand check on a number receiver", async () => {
    // S15.10.6.2_A2_T9 in miniature: reaching the closure IS the brand check.
    const thrown = await runStandalone(
      `Object.prototype.exec = RegExp.prototype.exec;\n` +
        `var __instance = 1.0;\n` +
        `var __ok = false;\n` +
        `try { __instance.exec("m"); } catch (e) { __ok = e instanceof TypeError; }\n` +
        `if (!__ok) { throw new Error("no TypeError"); }`,
    );
    expect(thrown).toBeNull();
  });

  it("a NON-identifier receiver reaches the same route", async () => {
    // `(Number.NEGATIVE_INFINITY).m()` — the #4096 stored-member arm declines
    // this shape because it would have to read the receiver twice.
    expect(
      await runStandalone(
        `Number.prototype.toLowerCase = String.prototype.toLowerCase;\n` +
          `${check("(Number.NEGATIVE_INFINITY).toLowerCase()", "-infinity")}`,
      ),
    ).toBeNull();
  });

  it("the receiver is threaded as `this` (sloppy mode boxes it)", async () => {
    expect(
      await runStandalone(
        `Number.prototype.zz = function () { return typeof this; };\nvar n = 5;\n${check("n.zz()", "object")}`,
      ),
    ).toBeNull();
  });
});
