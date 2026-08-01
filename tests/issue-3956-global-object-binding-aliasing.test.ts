// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3956 — a top-level write that creates a property on the realm's global object
 * must (a) actually execute and (b) be resolvable by a bare identifier.
 *
 * `collectDeclarations` (`src/codegen/declarations.ts`) gates which top-level
 * `ExpressionStatement`s reach `__module_init` behind an allow-list whose
 * terminal arm only matched a root identifier of `globalThis` or a module
 * global. Two ways of creating a global-object property fell off the end and
 * emitted NO CODE AT ALL:
 *
 *   this.p1 = 1;   // §9.4.2 — top-level `this` IS the global object; the root
 *                  // unwraps to a ThisKeyword, which is not an Identifier
 *   p1 = 1;        // §6.2.5.6 PutValue on an unresolvable reference (sloppy)
 *
 * A third gap sat on the read side: a name created only via `this.p1 = 1` was
 * in no pre-scan set, so a bare `p1` read fell through to codegen's
 * auto-allocated-local fallback and silently read `0`.
 *
 * The same assignments INSIDE a function body always worked — only the
 * top-level collection dropped them. Cross-lane (host and standalone alike),
 * which is why every case here runs in both.
 *
 * This is the eighth/ninth instance of the #3623 silent-drop mechanism; the
 * durable fix is #3623's fail-loud terminal arm, this is a point fix under it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Compile a SCRIPT (no exports — the test262 original-harness shape), run
 * `__module_init`, and report whether it completed. The probes below signal
 * failure by throwing, so `false` means the assertion inside the script failed.
 */
async function initCompletes(source: string, target?: "standalone"): Promise<boolean> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "global-binding.js",
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

describe("#3956 — top-level global-object writes are not silently dropped", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";

    // ── The write must execute ────────────────────────────────────────────

    it(`[${lane}] a sloppy implicit-global assign is readable as a bare identifier`, async () => {
      expect(await initCompletes(`p1 = 1;\nif (p1 !== 1) { throw new Error("p1 === " + p1); }`, target)).toBe(true);
    });

    it(`[${lane}] a sloppy implicit-global assign is readable through the global object`, async () => {
      expect(
        await initCompletes(`p1 = 1;\nif (this.p1 !== 1) { throw new Error("this.p1 === " + this.p1); }`, target),
      ).toBe(true);
    });

    it(`[${lane}] this.p = v round-trips through this.p`, async () => {
      expect(
        await initCompletes(`this.p1 = 1;\nif (this.p1 !== 1) { throw new Error("this.p1 === " + this.p1); }`, target),
      ).toBe(true);
    });

    it(`[${lane}] this.p = v is readable as a bare identifier`, async () => {
      expect(await initCompletes(`this.p1 = 1;\nif (p1 !== 1) { throw new Error("p1 === " + p1); }`, target)).toBe(
        true,
      );
    });

    it(`[${lane}] this["p"] = v (element access) is readable as a bare identifier`, async () => {
      expect(await initCompletes(`this["p1"] = 1;\nif (p1 !== 1) { throw new Error("p1 === " + p1); }`, target)).toBe(
        true,
      );
    });

    it(`[${lane}] globalThis.p = v is readable as a bare identifier`, async () => {
      expect(
        await initCompletes(`globalThis.p1 = 1;\nif (p1 !== 1) { throw new Error("p1 === " + p1); }`, target),
      ).toBe(true);
    });

    // ── The two carriers are ONE object, not two ──────────────────────────

    it(`[${lane}] the bare-assign carrier and the globalThis carrier are the same object`, async () => {
      expect(
        await initCompletes(
          `p1 = 1;\nthis.p2 = 2;\nif (this.p1 !== 1) { throw new Error("this.p1"); }\nif (p2 !== 2) { throw new Error("p2"); }`,
          target,
        ),
      ).toBe(true);
    });

    // ── Absence must still throw — the fix must not make reads permissive ──

    it(`[${lane}] a bare read of a never-created name still throws ReferenceError`, async () => {
      // `q1` is created; `q2` never is. The read of `q2` must NOT silently
      // resolve (the pre-#3956 auto-local fallback read 0) and must not be
      // admitted by the new pre-scan either.
      expect(
        await initCompletes(`this.q1 = 1;\nif (q2 !== undefined) { throw new Error("unreachable"); }`, target),
      ).toBe(false);
    });

    // ── Narrowness of the read-side pre-scan ──────────────────────────────

    it(`[${lane}] a deeper chain (this.o.k) does not register k as a global binding`, async () => {
      // `this.o.k = 1` writes into `o`, NOT into the global object, so a bare
      // `k` must not resolve to it.
      expect(
        await initCompletes(
          `this.o = {};\nthis.o.k = 1;\nif (k !== undefined) { throw new Error("unreachable"); }`,
          target,
        ),
      ).toBe(false);
    });

    it(`[${lane}] a this.p write inside a function does not register p as a global binding`, async () => {
      // Only TOP-LEVEL `this` is the global object; inside a function `this` is
      // the call receiver, so `p3` must stay unresolvable.
      expect(
        await initCompletes(
          `function f() { this.p3 = 1; }\nf.call({});\nif (p3 !== undefined) { throw new Error("unreachable"); }`,
          target,
        ),
      ).toBe(false);
    });

    // ── A real binding always wins over the global-object property ────────

    it(`[${lane}] a declared var of the same name wins over the global-object property`, async () => {
      expect(
        await initCompletes(
          `var p1 = 5;\nthis.p1 = 1;\nif (p1 !== 5 && p1 !== 1) { throw new Error("p1 === " + p1); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a function-local binding shadows the global-object property`, async () => {
      expect(
        await initCompletes(
          `this.p1 = 1;\nfunction f() { var p1 = 9; return p1; }\nif (f() !== 9) { throw new Error("shadow"); }\nif (p1 !== 1) { throw new Error("outer p1 === " + p1); }`,
          target,
        ),
      ).toBe(true);
    });
  }
});
