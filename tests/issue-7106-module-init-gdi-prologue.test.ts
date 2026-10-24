// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #7106 — an IR-claimed `<module-init>` runs the direct emitter's
 * GlobalDeclarationInstantiation prologue before its first statement.
 *
 * The IR patch used to replace the direct body wholesale, prologue included:
 * a claimed standalone script never published its top-level functions on the
 * global object, a module `var` read before its declaration saw `null` instead
 * of `undefined`, and a reassigned function's live binding stayed unseeded
 * (which is why the claim used to be refused outright whenever one existed).
 * Every case below fails on the pre-fix compiler.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile, type CompileResult } from "../src/index.js";

type Lane = "standalone" | "wasi" | "host";

async function compileScript(source: string, lane: Lane): Promise<CompileResult> {
  const result = await compile(source, {
    ...(lane === "host" ? {} : { target: lane }),
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    scriptGoal: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: lane !== "wasi",
    hostBridge: "always",
    trackIrOutcomes: true,
    emitWat: true,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

async function compileModule(source: string, lane: Lane): Promise<CompileResult> {
  const result = await compile(source, {
    ...(lane === "host" ? {} : { target: lane }),
    fileName: "issue-7106-gdi.ts",
    allowJs: true,
    skipSemanticDiagnostics: true,
    hostBridge: "always",
    trackIrOutcomes: true,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  return result;
}

function expectIrOwnsModuleInit(result: CompileResult): void {
  const row = (result.irOutcomes ?? []).find((outcome) => outcome.unitKind === "module-init");
  expect(row, JSON.stringify(result.irOutcomes ?? [])).toMatchObject({ kind: "emitted", irBodyEmitted: true });
}

async function instantiate(result: CompileResult): Promise<Record<string, unknown>> {
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return instance.exports as Record<string, unknown>;
}

/** What node answers for the same module: `probe()` of the transpiled source. */
function nodeProbe(source: string): unknown {
  const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports: Record<string, () => unknown> = {};
  new Function("exports", js)(exports);
  return exports.probe!();
}

/**
 * Names of the functions `__module_init` calls, looking through a
 * `__module_init_prologue` helper the inliner may or may not have folded in.
 */
function moduleInitCallees(wat: string): Set<string> {
  const lines = wat.split("\n");
  const names: string[] = [];
  const bodies = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const imported = /^\s*\(import "[^"]*" "[^"]*" \(func \$(\S+)/.exec(line);
    if (imported) {
      names.push(imported[1]!);
      continue;
    }
    const defined = /^\s*\(func \$(\S+)/.exec(line);
    if (defined) {
      names.push(defined[1]!);
      bodies.set(defined[1]!, (current = []));
      continue;
    }
    if (/^\s*\((export|elem|data|start|global|table|memory|type|tag|rec)\b/.test(line)) current = undefined;
    current?.push(line);
  }
  const callees = (fn: string): string[] =>
    (bodies.get(fn) ?? []).flatMap((line) => {
      const call = /\bcall (\d+)\b/.exec(line);
      return call ? [names[Number(call[1])] ?? `#${call[1]}`] : [];
    });
  const seen = new Set<string>();
  for (const callee of callees("__module_init")) {
    seen.add(callee);
    if (callee.startsWith("__module_init_prologue")) for (const inner of callees(callee)) seen.add(inner);
  }
  return seen;
}

describe("#7106 — IR-claimed <module-init> keeps the GDI prologue", () => {
  // Two IR routes reach the module-init patch: the post-direct overlay (the
  // direct body is emitted first and then replaced) and the prepared route
  // (the direct body is never compiled). Both must publish `f`.
  const SCRIPTS = [
    ["post-direct overlay", 'function f() { return 1; } let k = 2; if (k !== 2) { throw "#1"; }'],
    ["prepared component", "let n = 0; n = n + 1; function f() { return n; }"],
  ] as const;

  for (const [route, source] of SCRIPTS) {
    for (const lane of ["standalone", "wasi"] as const) {
      it(`${lane} / ${route}: publishes the script's top-level function on the global object`, async () => {
        const result = await compileScript(source, lane);
        expectIrOwnsModuleInit(result);
        expect(WebAssembly.validate(result.binary)).toBe(true);
        const callees = moduleInitCallees(result.wat ?? "");
        // §9.1.1.4.18: the define call on the native global object, ahead of
        // every IR statement — exactly the direct body's prologue.
        expect([...callees]).toContain("__defineProperty_value");
        expect([...callees].some((name) => name.startsWith("__native_globalThis"))).toBe(true);
      });
    }

    it(`standalone / ${route}: the claimed initializer still runs like node`, async () => {
      const result = await compileScript(source, "standalone");
      const exports = await instantiate(result);
      // node evaluates the same script without throwing.
      expect(() => (exports.__module_init as () => void)()).not.toThrow();
    });
  }

  it("mints no prologue helper when the script needs no instantiation work", async () => {
    for (const lane of ["standalone", "host"] as const) {
      const result = await compileScript('let k = 2; if (k !== 2) { throw "#1"; }', lane);
      expectIrOwnsModuleInit(result);
      expect(result.wat ?? "").not.toContain("__module_init_prologue");
    }
  });

  for (const lane of ["standalone", "host"] as const) {
    it(`${lane}: a module \`var\` read before its declaration is undefined (#4489 seed)`, async () => {
      const source =
        'var early = w === undefined; var w = "1"; w++;\nexport function probe(): number { return early ? 1 : 0; }';
      const result = await compileModule(source, lane);
      expectIrOwnsModuleInit(result);
      const probe = (await instantiate(result)).probe as () => number;
      expect(probe()).toBe(nodeProbe(source));
      expect(probe()).toBe(1);
    });

    it(`${lane}: seeds a reassigned function's live binding (#2931) instead of refusing the claim`, async () => {
      const source = [
        "function g(): number { return 1; }",
        "function swap(): void { g = function () { return 2; }; }",
        "let first = 3;",
        "first = first + 1;",
        "export function probe(): number { const before = g(); swap(); return first * 100 + before * 10 + g(); }",
      ].join("\n");
      const result = await compileModule(source, lane);
      expectIrOwnsModuleInit(result);
      expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
      // One call each: `probe` swaps `g`, so a second call reads the new one.
      const got = ((await instantiate(result)).probe as () => number)();
      expect(got).toBe(nodeProbe(source));
      expect(got).toBe(412);
    });
  }
});
