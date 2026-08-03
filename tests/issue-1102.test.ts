// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #1102 — Wasm-native eval: AOT compilation strategy (Option B), const-binding
// widening slice.
//
// The issue's acceptance criteria were largely delivered by the tier-ladder
// work (#1163/#2923 constant-string eval splice, #2924 `new Function` const
// compile-away, #2960 refuse-loudly diagnostics — see
// docs/architecture/runtime-eval-interpreter.md §12). This slice widens the
// Tier-0 CONSTANT FRONTIER: `resolveConstantString` now sees through
//   - `const`-declared string bindings (`const s = "1 + 2"; eval(s)`),
//   - template literals with all-constant substitutions,
//   - TS assertion wrappers (`as` / `satisfies` / `<T>` / `!`),
// for DIRECT eval and the `Function` constructor only. Indirect eval never
// uses the caller-scope splice, including for literal input, because its realm-
// global environment is observably distinct from the caller's lexical scope.
//
// Soundness: a fold must never erase a TDZ ReferenceError. Guards:
//   1. textual precedence (kills backward refs + cycles),
//   2. same execution container, with a module-top-level relaxation gated on
//      an inert top-level prefix (no call/new/getter-read before the const —
//      exports are not callable until the start function completes),
//   3. declaration block is an ancestor of the use (kills switch sibling-
//      clause fall-ins, which share one lexical scope but skip execution).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import {
  RUNTIME_EVAL_IMPORT_MODULE,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  buildRuntimeEvalRefusalProviderSource,
  instantiateRuntimeEvalNamespace,
} from "../scripts/runtime-eval-provider.mjs";

let refusalModulePromise: Promise<WebAssembly.Module> | undefined;

function refusalModule(): Promise<WebAssembly.Module> {
  refusalModulePromise ??= compile(buildRuntimeEvalRefusalProviderSource(), {
    ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
    fileName: "issue-1102-refusal-provider.ts",
  }).then((result) => {
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    return new WebAssembly.Module(result.binary);
  });
  return refusalModulePromise;
}

async function runStandalone(src: string, inferModuleStrictArguments = true): Promise<unknown> {
  const r = await compile(src, { target: "standalone", inferModuleStrictArguments });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const module = new WebAssembly.Module(r.binary);
  const needsRuntimeEval = WebAssembly.Module.imports(module).some(
    (entry) => entry.module === RUNTIME_EVAL_IMPORT_MODULE,
  );
  const imports = needsRuntimeEval
    ? { [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(await refusalModule()) }
    : {};
  const instance = await WebAssembly.instantiate(module, imports);
  return (instance.exports as { test(): unknown }).test();
}

async function runHost(src: string): Promise<unknown> {
  const result = await compile(src, {
    fileName: "issue-1102-host-eval.ts",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(
    WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).some((entry) => entry.name === "__extern_eval"),
  ).toBe(false);
  const imports = result.importObject as WebAssembly.Imports & { __setExports?: (exports: unknown) => void };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#1102 — acceptance criteria (standalone, Tier-0 AOT)", () => {
  it('AC1: eval("1 + 2") === 3', async () => {
    expect(await runStandalone(`export function test(): number { return eval("1 + 2"); }`)).toBe(3);
  });

  it('AC2: eval("var x = 42") introduces x into the caller scope', async () => {
    expect(await runStandalone(`export function test(): number { eval("var x = 42"); return x; }`)).toBe(42);
  });

  it("AC3: dynamic eval → linked runtime-provider boundary", async () => {
    const r = await compile(
      `export function test(s: string): number { try { return eval(s); } catch { return -1; } }`,
      {
        target: "standalone",
      },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(r.binary))).toEqual([
      { module: RUNTIME_EVAL_IMPORT_MODULE, name: "__runtime_apply_interpreted", kind: "function" },
      { module: RUNTIME_EVAL_IMPORT_MODULE, name: "__runtime_direct_eval", kind: "function" },
    ]);
    expect((r.errors ?? []).some((e) => (e as { severity?: string }).severity === "warning")).toBe(false);
  });

  it('AC4: new Function("a","b","return a + b") compiles with constant args', async () => {
    expect(
      await runStandalone(
        `export function test(): number { const f = new Function("a", "b", "return a + b"); return f(1, 2); }`,
      ),
    ).toBe(3);
  });
});

describe("#1102 — const-binding constant-frontier widening (direct eval)", () => {
  it("const local string binding folds: const s = '1 + 2'; eval(s) === 3", async () => {
    expect(await runStandalone(`export function test(): number { const s = "1 + 2"; return eval(s); }`)).toBe(3);
  });

  it("const chain folds: const a = '1 + '; const b = a + '2'; eval(b) === 3", async () => {
    expect(
      await runStandalone(`export function test(): number { const a = "1 + "; const b = a + "2"; return eval(b); }`),
    ).toBe(3);
  });

  it("template substitution folds: eval(`1 + ${TWO}`) === 3", async () => {
    expect(await runStandalone('export function test(): number { const TWO = "2"; return eval(`1 + ${TWO}`); }')).toBe(
      3,
    );
  });

  it("module-top-level const folds into a function body (inert prefix)", async () => {
    expect(await runStandalone(`const S = "40 + 2";\nexport function test(): number { return eval(S); }`)).toBe(42);
  });

  it("TS assertion wrappers unwrap: eval(s as string)", async () => {
    expect(await runStandalone(`export function test(): number { const s = "1 + 2"; return eval(s as string); }`)).toBe(
      3,
    );
  });

  it("same-clause switch fall-in folds (decl and use in one clause, in order)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const x = 1; switch (x) { case 1: { const s = "1 + 2"; return eval(s); } } return -2; }`,
      ),
    ).toBe(3);
  });

  it("nested const eval folds recursively: eval('eval(\"40 + 2\")')", async () => {
    expect(await runStandalone(`export function test(): number { const s = 'eval("40 + 2")'; return eval(s); }`)).toBe(
      42,
    );
  });
});

describe("#1102 — new Function const-binding widening", () => {
  it("const body binding folds: new Function('a','b', body)(20, 22) === 42", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const body = "return a + b"; const f = new Function("a", "b", body); return f(20, 22); }`,
      ),
    ).toBe(42);
  });

  it("no host import leaks for the folded const-binding form (standalone)", async () => {
    const r = await compile(
      `export function test(): number { const body = "return 7"; return new Function(body)(); }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
    expect(imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  });
});

describe("#1102 — soundness guards (folds that MUST NOT happen)", () => {
  it("routes a literal Annex B cancellation through the runtime provider", async () => {
    const r = await compile(
      `export function test(): number {
        let f: any = 3;
        eval("{ function f() { return 2; } }");
        return typeof f === "number" ? f : -1;
      }`,
      { target: "standalone", inferModuleStrictArguments: false },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(r.binary))).toEqual([
      { module: RUNTIME_EVAL_IMPORT_MODULE, name: "__runtime_apply_interpreted", kind: "function" },
      { module: RUNTIME_EVAL_IMPORT_MODULE, name: "__runtime_direct_eval", kind: "function" },
    ]);
  });

  it("literal sloppy eval rejects a var crossing an intervening block lexical", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
        try {
          { let x = 1; { eval("var x;"); } }
          return 0;
        } catch (error) {
          return error instanceof SyntaxError ? 1 : 2;
        }
      }`,
        false,
      ),
    ).toBe(1);
  });

  it("literal eval in an ordinary default parameter rejects its arguments binding", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
        function f(p: any = eval("var arguments")): void {}
        try { f(); return 0; }
        catch (error) { return error instanceof SyntaxError ? 1 : 2; }
      }`,
        false,
      ),
    ).toBe(1);
  });

  it("literal eval in an arrow default parameter rejects an explicit arguments parameter", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
        const f = (p: any = eval("var arguments = 1"), arguments?: any): void => {};
        try { f(); return 0; }
        catch (error) { return error instanceof SyntaxError ? 1 : 2; }
      }`,
        false,
      ),
    ).toBe(1);
  });

  it("arrow default-parameter eval may create arguments when no binding exists", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
        const f = (p: any = eval("var arguments = 7")): number => arguments as number;
        return f();
      }`,
        false,
      ),
    ).toBe(7);
  });

  it("parameter-default closure keeps the eval-created arguments binding", async () => {
    expect(
      await runStandalone(
        `const f = (p = eval("var arguments = 'param'"), q = () => arguments) => {
        function arguments() { return "body"; }
        return (typeof arguments === "function" ? 10 : 0) + (q() === "param" ? 1 : 0);
      };
      export function test(): number { return f(); }`,
        false,
      ),
    ).toBe(11);
  });

  it("reads an object-literal method after direct eval reifies the receiver binding", async () => {
    expect(
      await runStandalone(
        `function invoke(fn: () => void): number {
        try { fn(); }
        catch { return 1; }
        return 0;
      }
      export function test(): number {
        const object = { method(value = eval("var arguments")): void {} };
        return invoke(object.method);
      }`,
        false,
      ),
    ).toBe(1);
  });

  it("keeps a generator function expression host-free when arguments is only a body binding", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
        const generator = function* (value = eval("var arguments")): Generator<void> {
          let arguments;
        };
        try { generator(); }
        catch (error) { return error instanceof SyntaxError ? 1 : 2; }
        return 0;
      }`,
        false,
      ),
    ).toBe(1);
  });

  it("keeps an async generator method host-free when arguments is only a body binding", async () => {
    expect(
      await runStandalone(
        `export function test(): number {
        const object = { async *method(value = eval("var arguments")): AsyncGenerator<void> {
          var arguments;
        } };
        try { object.method(); }
        catch (error) { return error instanceof SyntaxError ? 1 : 2; }
        return 0;
      }`,
        false,
      ),
    ).toBe(1);
  });

  it("let binding does not fold (reassignable) → dynamic path throws catchably", async () => {
    expect(
      await runStandalone(
        `export function test(): number { let s = "1 + 2"; try { return eval(s); } catch { return -1; } }`,
      ),
    ).toBe(-1);
  });

  it("backward reference (TDZ) does not fold", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { const r = eval(S); const S = "1"; return r; } catch { return -1; } }`,
      ),
    ).toBe(-1);
  });

  it("indirect eval does not widen through const bindings (global-scope semantics stay dynamic)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const s = "1 + 2"; try { return (0, eval)(s); } catch { return -1; } }`,
      ),
    ).toBe(-1);
  });

  it("indirect eval with a literal does not use the caller-scope splice", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const local = 1; try { return (0, eval)("local + 2"); } catch { return -1; } }`,
      ),
    ).toBe(-1);
  });

  it("switch sibling-clause skip (shared scope, skipped init — TDZ) does not fold", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const x = 2; switch (x) { case 1: const s = "1 + 2"; case 2: try { return eval(s); } catch { return -1; } } return -2; }`,
      ),
    ).toBe(-1);
  });

  it("top-level call before the const (genuine early-call TDZ hazard) does not fold", async () => {
    expect(
      await runStandalone(
        `function early(): number { try { return eval(S); } catch { return -1; } }\nconst r = early();\nconst S = "1 + 2";\nexport function test(): number { return r; }`,
      ),
    ).toBe(-1);
  });
});

describe("#1102 — host mode: widened direct eval sees the caller scope", () => {
  it("const-bound eval('var x = 9'), host mode — splice puts x in caller scope", async () => {
    const r = await compile(`export function test(): number { const s = "var x = 9"; eval(s); return x; }`, {
      fileName: "t.ts",
      skipSemanticDiagnostics: true,
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    // The fold must remove the __extern_eval host dependency entirely — the
    // splice IS the direct-eval scope capture the host shim lacks (#2925).
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
    expect(imports.some((i) => i.name.includes("__extern_eval"))).toBe(false);
    const io = r.importObject as WebAssembly.Imports & { __setExports?: (e: unknown) => void };
    const { instance } = await WebAssembly.instantiate(r.binary, io);
    io.__setExports?.(instance.exports);
    expect((instance.exports as { test(): number }).test()).toBe(9);
  });

  it("keeps an explicitly strict literal eval on the caller-scope splice", async () => {
    expect(
      await runHost(`
        export function test(): number {
          "use strict";
          var y = 2;
          var z = 3;
          var result = 0;
          eval("var x = y + z; result = x;");
          return result;
        }
      `),
    ).toBe(5);
  });

  it("creates a current-function var when eval shadows an outer capture", async () => {
    expect(
      await runHost(`
        export function test(): number {
          var outer = 0;
          var observed = 0;
          function inner(): void {
            eval("var outer = 1");
            observed = outer;
          }
          inner();
          return observed * 10 + outer;
        }
      `),
    ).toBe(10);
  });
});
