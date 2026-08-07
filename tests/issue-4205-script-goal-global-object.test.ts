// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4205 — the script-goal global object: the pre-scan and the lowering must
 * agree about WHICH receivers are the realm global object.
 *
 * #3956 made a top-level `this.p = v` / `globalThis.p = v` readable as a bare
 * identifier by registering the property name in a compile-time set. That scan
 * looked at DIRECT `SourceFile` ExpressionStatements only, while the
 * `ThisKeyword` lowering it mirrors (#3365 / #4190 `thisBelongsToTopLevelCode`)
 * treats *all* top-level code as global-object `this`. Wherever the two
 * disagreed, the write really happened — readable through `globalThis.<n>` —
 * but no name was registered, so the bare read fell through to codegen's
 * auto-allocated-local fallback and silently answered `0`.
 *
 * Three independent shapes, all of them read-side except the last:
 *
 *   if (c) { this.r = 2; }   r      // scan stopped at direct statements
 *   var g = this; g.q = 7;   q      // alias of the global object
 *   this.n = 1; this.n++;    n      // NOT read-side: `resolveStructName` maps
 *                                   // `typeof globalThis` onto the large static
 *                                   // global-interface struct, which has no
 *                                   // runtime-created field `n`, so inc/dec
 *                                   // took the missing-field arm — an
 *                                   // `f64.const NaN` that DROPPED the write.
 *
 * The narrowness cases at the bottom are the other half of the invariant: a
 * receiver that is NOT the global object must still register nothing, or a
 * currently-silent wrong answer becomes a spurious `ReferenceError`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Compile a SCRIPT (no exports — a top-level `export` would make TypeScript
 * call the source a MODULE, where top-level `this` is legitimately `undefined`
 * and every probe here collapses to a vacuous pass), run `__module_init`, and
 * report whether it completed. Probes signal failure by throwing.
 */
async function initCompletes(source: string, target?: "standalone"): Promise<boolean> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "script-goal-global.js",
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

describe("#4205 — the pre-scan tracks the lowering's notion of global-object `this`", () => {
  for (const target of [undefined, "standalone"] as const) {
    const lane = target ?? "host";

    // ── PRECONDITION: green on BOTH arms, proving the probe reaches the
    //    substrate at all. Without it a uniformly-broken harness reads as
    //    "every case fixed" once the cases below go green.
    it(`[${lane}] PRECONDITION — a DIRECT top-level this.p = v is readable as a bare identifier`, async () => {
      expect(await initCompletes(`this.p1 = 1;\nif (p1 !== 1) { throw new Error("p1 === " + p1); }`, target)).toBe(
        true,
      );
    });

    // ── The write always landed: read it back through the object ──────────

    it(`[${lane}] a nested top-level this.r = v does reach the global object`, async () => {
      expect(
        await initCompletes(
          `if (true) { this.r = 2; }\nif (globalThis.r !== 2) { throw new Error("globalThis.r === " + globalThis.r); }`,
          target,
        ),
      ).toBe(true);
    });

    // ── …but the bare read did not resolve. These are the fix. ────────────

    it(`[${lane}] this.r = v inside a top-level if is readable as a bare identifier`, async () => {
      expect(
        await initCompletes(`if (true) { this.r = 2; }\nif (r !== 2) { throw new Error("r === " + r); }`, target),
      ).toBe(true);
    });

    it(`[${lane}] this.r = v inside a top-level for is readable as a bare identifier`, async () => {
      expect(
        await initCompletes(
          `for (var i = 0; i < 1; i++) { this.r = 2; }\nif (r !== 2) { throw new Error("r === " + r); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] this.r = v inside a top-level try is readable as a bare identifier`, async () => {
      expect(
        await initCompletes(
          `try { this.r = 2; } catch (e) {}\nif (r !== 2) { throw new Error("r === " + r); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] a write through a top-level alias of this is readable as a bare identifier`, async () => {
      expect(
        await initCompletes(`var g = this;\ng.q = 7;\nif (q !== 7) { throw new Error("q === " + q); }`, target),
      ).toBe(true);
    });

    it(`[${lane}] a write through a top-level alias of globalThis is readable as a bare identifier`, async () => {
      expect(
        await initCompletes(`var g = globalThis;\ng.q = 7;\nif (q !== 7) { throw new Error("q === " + q); }`, target),
      ).toBe(true);
    });

    // ── inc/dec on the global object must not be NaN-dropped ──────────────

    it(`[${lane}] this.n++ updates the global-object property`, async () => {
      expect(
        await initCompletes(`this.n = 1;\nthis.n++;\nif (n !== 2) { throw new Error("n === " + n); }`, target),
      ).toBe(true);
    });

    it(`[${lane}] globalThis.n++ updates the global-object property`, async () => {
      expect(
        await initCompletes(
          `globalThis.n = 1;\nglobalThis.n++;\nif (globalThis.n !== 2) { throw new Error("n === " + globalThis.n); }`,
          target,
        ),
      ).toBe(true);
    });

    it(`[${lane}] --this.n returns the decremented value`, async () => {
      expect(
        await initCompletes(`this.n = 2;\nvar v = --this.n;\nif (v !== 1) { throw new Error("v === " + v); }`, target),
      ).toBe(true);
    });

    // ── Narrowness: the scan must not widen past the lowering ─────────────

    it(`[${lane}] an alias reassigned elsewhere does NOT register its property writes`, async () => {
      // `g` is re-pointed at a plain object, so `g.q = 7` is not provably a
      // global-object write and `q` must stay unresolvable.
      expect(
        await initCompletes(
          `var g = this;\ng = {};\ng.q = 7;\nif (q !== undefined) { throw new Error("unreachable"); }`,
          target,
        ),
      ).toBe(false);
    });

    it(`[${lane}] a this.p write inside a nested function still registers nothing`, async () => {
      // Only top-level `this` is the global object; the walk stops at every
      // function boundary, so `p3` stays unresolvable and the read throws.
      expect(
        await initCompletes(
          `function f() { this.p3 = 1; }\nif (p3 !== undefined) { throw new Error("unreachable"); }`,
          target,
        ),
      ).toBe(false);
    });

    it(`[${lane}] a deeper nested chain (this.o.k) still registers nothing`, async () => {
      expect(
        await initCompletes(
          `this.o = {};\nif (true) { this.o.k = 1; }\nif (k !== undefined) { throw new Error("unreachable"); }`,
          target,
        ),
      ).toBe(false);
    });

    it(`[${lane}] an ordinary object's ++ is untouched`, async () => {
      expect(
        await initCompletes(`var o = { n: 1 };\no.n++;\nif (o.n !== 2) { throw new Error("o.n === " + o.n); }`, target),
      ).toBe(true);
    });

    it(`[${lane}] a constructor's this.x = v does not leak onto the global object`, async () => {
      expect(
        await initCompletes(
          `function C() { this.x = 1; }\nvar c = new C();\nif (c.x !== 1) { throw new Error("c.x === " + c.x); }\n` +
            `if (typeof globalThis.x !== "undefined") { throw new Error("leaked x"); }`,
          target,
        ),
      ).toBe(true);
    });
  }
});
