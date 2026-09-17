// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6474 — a linked test262 body must be compiled with the SCRIPT goal.
//
// Two independent switches made it a module, and both had to flip:
//
//   1. the binding prelude's `import { __h_assert } from "./__js2wasm_harness_stub"`,
//      which is the parser's `externalModuleIndicator`; and
//   2. `generateMultiModule`'s unconditional `ctx.sourceIsModule = true`, which
//      ignores the entry file entirely — so removing the import alone changes
//      nothing about the goal-dependent codegen.
//
// Under the module goal a top-level `var` is module-scoped instead of a
// property of the global object, top-level `this` is `undefined`, and an
// undeclared assignment does not create a global. test262 scripts observe all
// three, so the shadow lane disagreed with the honest lane on rows that have
// nothing to do with modules (`language/statements/with/12.10-0-1.js`,
// `built-ins/Array/prototype/map/15.4.4.19-5-21.js`, the two
// `indirect-eval-contains-arguments` rows).
//
// The fix is opt-in on both halves: the ambient-global stub is chosen only for
// a non-`flags: [module]` row, and `entryScriptGoal` is set only by
// `compileHarnessLinkedBody`. The last test pins that opt-in-ness — with a real
// module entry the flag is byte-inert, which is what makes every other
// `compileMulti` / `compileProject` caller unchanged.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";
import {
  buildHarnessProvider,
  harnessBindingPrelude,
  compileHarnessLinkedBody,
} from "../src/test262-harness-provider.js";
import type { HarnessProvider } from "../src/test262-harness-provider.js";
import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6474-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  // The runner passes this per row: `false` for a script, `true` for a
  // `flags: [module]` row. It is the module-goal signal the prelude reads.
  inferModuleStrictArguments: false,
} as const;

const providers = new Map<string, HarnessProvider>();
async function providerFor(harnessPrefix: string): Promise<HarnessProvider> {
  let provider = providers.get(harnessPrefix);
  if (!provider) {
    provider = await buildHarnessProvider({ harnessPrefix, cacheDir: CACHE, compileOptions: OPTIONS });
    providers.set(harnessPrefix, provider);
  }
  return provider;
}

async function runLinked(source: string): Promise<string> {
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await providerFor(assembly.harnessPrefix);
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  if (!result.success) return `compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`;
  const importObject = buildImports(result.imports as never, { console }, result.stringPool as never);
  try {
    await instantiateTest262Module(result.binary, importObject, {
      linkedModules: result.linkedModules ?? [],
      linkedRuntime,
      // (#6477 follow-up) In-process callers own the deferred `__module_init`
      // call; the sharded worker makes it itself (#3123).
      runDeferredInit: true,
    });
    return "pass";
  } catch (error) {
    return `fail: ${String((error as { message?: string })?.message ?? error)}`;
  }
}

const HEADER = `/*---\ndescription: linked script goal\n---*/\n`;

// test262/test/language/statements/with/12.10-0-1.js, verbatim body. `f` is
// created BEFORE `foo` exists and reads it through the global object; under the
// module goal `foo` is module-scoped and `f()` answers null.
const WITH_BODY = `var o = {};
var f = function () { return foo; };
with (o) { var foo = "12.10-0-1"; }
assert.sameValue(f(), "12.10-0-1", "f()");`;

describe("#6474 — the linked lane compiles a script body with the script goal", () => {
  beforeAll(async () => {
    await providerFor(assembleLinkedHarness(HEADER, parseMeta(HEADER)).harnessPrefix);
  }, 600_000);

  it("a top-level var is script-global: a closure made before the declaration sees it", async () => {
    expect(await runLinked(HEADER + WITH_BODY)).toBe("pass");
  }, 600_000);

  it("a sloppy top-level `var arguments` is an ordinary global binding", async () => {
    expect(await runLinked(`${HEADER}var arguments = 1;\nassert.sameValue(arguments, 1, "arguments");`)).toBe("pass");
  }, 600_000);

  it("top-level `this` is the global object, not undefined", async () => {
    expect(
      await runLinked(`${HEADER}var global = this;\nassert.sameValue(typeof global, "object", "typeof this");`),
    ).toBe("pass");
  }, 600_000);

  // The prelude is the FIRST switch. For a script row it must emit no import
  // at all and an ambient-global (unexported) stub; for a module row it must
  // keep both, or a genuine module test would be compiled as a script.
  it("the prelude drops the import for a script row and keeps it for a module row", async () => {
    const provider = await providerFor(assembleLinkedHarness(HEADER, parseMeta(HEADER)).harnessPrefix);
    const body = "assert.sameValue(1, 1);";

    const script = harnessBindingPrelude(provider, body, false, false);
    expect(script.prelude).not.toContain("import ");
    expect(script.prelude).toContain("var assert = ");
    expect(script.stubSource).toContain("declare function ");
    expect(script.stubSource).not.toContain("export ");
    // Error-line mapping: one line fewer than the module form.
    const asModule = harnessBindingPrelude(provider, body, false, true);
    expect(asModule.prelude).toContain("import ");
    expect(asModule.stubSource).toContain("export declare function ");
    expect(script.preludeLines).toBe(asModule.preludeLines - 1);
    // Both forms bind the SAME provider imports — only the source goal moves.
    expect([...script.bindings]).toEqual([...asModule.bindings]);
  }, 600_000);

  // A `flags: [module]` row must still be a module: the prelude keeps its
  // import, so the entry's own `externalModuleIndicator` is set and
  // `entryScriptGoal` resolves to the module goal anyway.
  it("a module-goal row still compiles, with the import form", async () => {
    const source = `/*---\nflags: [module]\n---*/\nexport var x = 1;\nassert.sameValue(x, 1);`;
    const assembly = assembleLinkedHarness(source, parseMeta(source));
    const provider = await providerFor(assembly.harnessPrefix);
    const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
      ...OPTIONS,
      inferModuleStrictArguments: true,
      strict: assembly.primary.strict,
    });
    expect(result.success).toBe(true);
    expect(result.harnessPrelude.prelude).toContain("import ");
  }, 600_000);

  // The residual the script goal un-masked (see the issue's P3 note). The
  // runtime-eval global mirror defines a script's top-level `var` binding with
  // writable/enumerable deliberately UNSPECIFIED, so a program's own attribute
  // change survives a refresh — but on the FIRST definition "unspecified" means
  // `false`, and the next refresh then carried a new value into a non-writable
  // property and threw `Cannot redefine property`. Bit 6 (0x40) applies
  // §9.1.1.4.16's `{writable: true, enumerable: true}` on creation only.
  it("__defineProperty_value bit 6 creates a global var binding writable+enumerable, once", () => {
    const define = buildImports([
      {
        module: "env",
        kind: "func",
        name: "__defineProperty_value",
        paramCount: 4,
        intent: { type: "builtin", name: "__defineProperty_value" },
      },
    ] as never).env.__defineProperty_value as (o: object, p: string, v: unknown, f: number) => unknown;
    const SCRIPT_VAR_CREATE = 0x80 | 0x40 | 0x23;

    const target: Record<string, unknown> = {};
    define(target, "myObj", 1, SCRIPT_VAR_CREATE);
    const first = Object.getOwnPropertyDescriptor(target, "myObj");
    expect(first).toMatchObject({ value: 1, writable: true, enumerable: true, configurable: false });
    // The refresh that used to throw.
    expect(() => define(target, "myObj", 2, SCRIPT_VAR_CREATE)).not.toThrow();
    expect(target.myObj).toBe(2);

    // Creation defaults apply ONLY on creation: an attribute the program
    // narrowed afterwards must survive the next refresh.
    Object.defineProperty(target, "kept", { value: 1, writable: true, enumerable: false, configurable: true });
    define(target, "kept", 3, SCRIPT_VAR_CREATE);
    expect(Object.getOwnPropertyDescriptor(target, "kept")).toMatchObject({ value: 3, enumerable: false });
  });

  // Control. `entryScriptGoal` may only ever be a no-op for callers that do not
  // set it, and for a genuine module entry it must be byte-inert even when set
  // — the goal comes from the entry file, not from the flag.
  it("entryScriptGoal is byte-inert on a module entry (and off by default)", async () => {
    const files = {
      "/helper.ts": `export function twice(n: number): number { return n * 2; }\n`,
      "/main.ts": `import { twice } from "./helper.js";\nexport function run(n: number): number { return twice(n) + 1; }\n`,
    };
    const base = await compileMulti(files, "/main.ts", {});
    const withFlag = await compileMulti(files, "/main.ts", { entryScriptGoal: true });
    expect(base.success).toBe(true);
    expect(withFlag.success).toBe(true);
    expect(Buffer.from(withFlag.binary).equals(Buffer.from(base.binary))).toBe(true);
  }, 600_000);
});
