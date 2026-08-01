// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3985 — a `"use strict"` directive prologue inside a function body must make
 * an assignment to an unresolvable identifier throw `ReferenceError`
 * (§6.2.5.6 PutValue step 6.b), not silently create a binding.
 *
 * `isStrictContext` already answered correctly; what was missing was the STRICT
 * ARM of the identifier-assignment lowering in
 * `src/codegen/expressions/assignment.ts`. The sloppy arm was gated on
 * `!isStrictContext(...)`, and there was no matching strict arm — so strict code
 * fell through to a catch-all fallback that allocated a fresh Wasm local. That
 * is a SILENT WRONG ANSWER: valid Wasm, no diagnostic, wrong semantics.
 *
 * The fix is deliberately RUNTIME-CONDITIONAL rather than a static throw.
 * `isUnresolvableIdent` is a compiler-knowledge predicate, not the spec one: a
 * name absent from the TypeScript program can still be a property of the global
 * object at run time, in which case §9.1.1.4.1 `HasBinding` is true, the
 * Reference resolves, and the assignment must SUCCEED. So the lowering emits
 * `__extern_has` (§7.3.12 HasProperty — own *and* prototype chain) and throws
 * only on the absent branch. `__hasOwnProperty` would be wrong here: the global
 * object inherits `toString` from `Object.prototype`, so `toString = 1` in
 * strict code resolves and must not throw.
 *
 * Cross-lane by construction — the defect is in the shared front end, so every
 * case runs in both the host and standalone lanes.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Compile a SCRIPT (no exports — the test262 original-harness shape), run
 * `__module_init`, and report whether it completed. Probes signal failure by
 * throwing, so `false` means an assertion inside the script failed.
 */
async function initCompletes(source: string, target?: "standalone"): Promise<boolean> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "strict-unresolvable.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
    ...(target ? { target } : {}),
  });
  expect(result.success, result.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = buildImports(result.imports, { console }, result.stringPool) as Record<string, unknown> & {
    setExports?: (e: WebAssembly.Exports) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports);
  const init = (instance.exports as Record<string, unknown>).__module_init;
  expect(typeof init).toBe("function");
  try {
    (init as () => void)();
    return true;
  } catch {
    return false;
  }
}

/** `body` must throw a ReferenceError when run. */
function throwsReferenceError(body: string): string {
  return `
var threw = false;
var wasReferenceError = false;
try { ${body} } catch (e) { threw = true; wasReferenceError = e instanceof ReferenceError; }
if (!threw) { throw new Error("expected a throw, got none"); }
if (!wasReferenceError) { throw new Error("expected a ReferenceError"); }
`;
}

describe("#3985 — 'use strict' prologue in a function body governs unresolvable assignment", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";

    // ── The defect: the throw must actually happen ────────────────────────

    it(`[${lane}] a function-body prologue makes an unresolvable assign throw`, async () => {
      expect(
        await initCompletes(
          `function fun() { "use strict"; unresolvableA = null; }\n${throwsReferenceError("fun();")}`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a prologue without the trailing semicolon still counts`, async () => {
      expect(
        await initCompletes(
          `function fun() { "use strict"\n unresolvableB = null; }\n${throwsReferenceError("fun();")}`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a prologue on a function EXPRESSION counts`, async () => {
      expect(
        await initCompletes(
          `var fun = function () { "use strict"; unresolvableC = null; };\n${throwsReferenceError("fun();")}`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a prologue on an accessor counts`, async () => {
      expect(
        await initCompletes(
          `var obj = { set p(v) { "use strict"; unresolvableD = v; } };\n` + throwsReferenceError('obj.p = "x";'),
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a prologue is inherited by a NESTED function`, async () => {
      expect(
        await initCompletes(
          `function outer() { "use strict"; function inner() { unresolvableE = null; } inner(); }\n` +
            throwsReferenceError("outer();"),
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a class body is strict without any prologue`, async () => {
      expect(
        await initCompletes(
          `class K { m() { unresolvableF = null; } }\n${throwsReferenceError("new K().m();")}`,
          target,
        ),
      ).toBe(true);
    });

    // ── §13.15.2 evaluation order ────────────────────────────────────────

    it(`[${lane}] the RHS is evaluated BEFORE PutValue throws`, async () => {
      expect(
        await initCompletes(
          `var seen = 0;\nfunction side() { seen = 1; return 7; }\n` +
            `function fun() { "use strict"; unresolvableG = side(); }\n` +
            throwsReferenceError("fun();") +
            `if (seen !== 1) { throw new Error("RHS must run before the throw"); }`,
          target,
        ),
      ).toBe(true);
    });

    // ── The throw must be CONDITIONAL, not static ────────────────────────

    it(`[${lane}] a name present on the global object resolves and does NOT throw`, async () => {
      expect(
        await initCompletes(
          `var existing = 0;\nfunction fun() { "use strict"; existing = 42; }\nfun();\n` +
            `if (existing !== 42) { throw new Error("existing === " + existing); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a name inherited from Object.prototype resolves (HasProperty, not HasOwnProperty)`, async () => {
      expect(
        await initCompletes(
          `function fun() { "use strict"; toString = 1; return toString; }\n` +
            `if (fun() !== 1) { throw new Error("inherited name must resolve, not throw"); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a read after a successful strict write sees the value`, async () => {
      expect(
        await initCompletes(
          `var rw = 0;\nfunction fun() { "use strict"; rw = 5; return rw; }\n` +
            `if (fun() !== 5) { throw new Error("read-after-write must see 5"); }`,
          target,
        ),
      ).toBe(true);
    });

    // ── Controls: the sloppy path must be untouched ──────────────────────

    it(`[${lane}] a SLOPPY unresolvable assign still creates a global`, async () => {
      expect(
        await initCompletes(
          `function fun() { sloppyH = 3; }\nfun();\nif (sloppyH !== 3) { throw new Error("sloppyH === " + sloppyH); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a "use strict" AFTER a statement is not a prologue and stays sloppy`, async () => {
      expect(
        await initCompletes(
          `function fun() { sloppyI = 1; "use strict"; return sloppyI; }\n` +
            `if (fun() !== 1) { throw new Error("mid-body directive must not enable strict"); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a strict function writing an outer var is unaffected`, async () => {
      expect(
        await initCompletes(
          `var outerV = 0;\nfunction fun() { "use strict"; outerV = 9; }\nfun();\n` +
            `if (outerV !== 9) { throw new Error("outerV === " + outerV); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a strict function writing its own local is unaffected`, async () => {
      expect(
        await initCompletes(
          `function fun() { "use strict"; var loc = 0; loc = 4; return loc; }\n` +
            `if (fun() !== 4) { throw new Error("local write must not route to the global env"); }`,
          target,
        ),
      ).toBe(true);
    });
  }
});
