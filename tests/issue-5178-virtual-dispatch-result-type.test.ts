// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5178 — the tag-dispatch cascade typed every arm from the FIRST candidate's
 * Wasm result type while each arm calls its own override's body.
 *
 * Same family as #4644 (which fixed the same cascade's *arity* divergence one
 * signature field over) and, like it, **`compile()` is not the gate**: every
 * case below reports zero diagnostics and `success: true`, and only
 * `WebAssembly.compile()` rejects the bytes. Each test therefore asserts BOTH.
 * Asserting only the first passes on the buggy compiler.
 *
 * Found on the full `@js-temporal/polyfill@0.5.1` + jsbi linked bundle (#4628):
 * `HelperBase.estimateIsoDate` has seven implementations across the calendar
 * hierarchy returning FIVE distinct object-literal structs, so the cascade in
 * `HelperBase_calendarToIsoDate` declared `(ref null 109)` and the Persian arm
 * pushed `(ref null 142)`:
 *
 *     Compiling function #277:"HelperBase_calendarToIsoDate" failed:
 *     type error in fallthru[0] (expected (ref null 109), got (ref null 142))
 *
 * The bodies below are padded with a straight-line arithmetic block on purpose:
 * a small override is inlined before the cascade's block types matter, and the
 * un-padded reduction is green on the buggy compiler.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const CORPUS_OPTIONS = {
  fileName: "issue-5178.js",
  allowJs: true,
  sourceMap: true,
  skipSemanticDiagnostics: true,
} as const;

/** Straight-line filler that keeps an override above the inlining threshold. */
function padded(variable: string): string {
  return Array.from(
    { length: 14 },
    (_, k) => `    ${variable} = ${variable} + Math.floor(Math.sin(${variable} + ${k}) * 0) + 1;`,
  ).join("\n");
}

async function compileAndValidate(source: string) {
  const result = await compile(source, CORPUS_OPTIONS);
  const errors = (result.errors ?? []).filter((e) => e.severity !== "warning");
  expect(errors.map((e) => `L${e.line}: ${e.message}`)).toEqual([]);
  expect(result.binary?.length ?? 0).toBeGreaterThan(0);
  // The gate. `compile()` above is green on the buggy compiler too.
  await expect(WebAssembly.compile(result.binary!)).resolves.toBeInstanceOf(WebAssembly.Module);
  return result;
}

async function runLogged(source: string): Promise<string[]> {
  const result = await compile(source, CORPUS_OPTIONS);
  const logged: string[] = [];
  const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, any>;
  const env = imports.env as Record<string, any>;
  for (const key of Object.keys(env)) {
    if (!key.startsWith("console_log")) continue;
    const original = env[key];
    if (typeof original !== "function") continue;
    env[key] = (...args: unknown[]) => {
      logged.push(String(args[0]));
      return original(...args);
    };
  }
  const { instance } = await WebAssembly.instantiate(result.binary!, imports as unknown as WebAssembly.Imports);
  (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
  return logged;
}

/** Four `estimate` overrides returning four DIFFERENT object-literal shapes. */
function divergentHierarchy(consumer: string): string {
  return `
class HelperBase {
  tag = 0;
  estimate(seed) {
${padded("seed")}
    return { year: seed, month: 1, day: 1 };
  }
${consumer}
}
class GregorianHelper extends HelperBase {
  estimate(seed) {
${padded("seed")}
    return { year: seed + 1, month: 2, day: 2, era: 1 };
  }
}
class PersianHelper extends HelperBase {
  estimate(seed) {
${padded("seed")}
    return { year: seed + 2, monthCode: 3 };
  }
}
class ChineseHelper extends HelperBase {
  estimate(seed) {
${padded("seed")}
    return { year: seed + 3, m: 1, d: 2, extra: 4 };
  }
}
const b = new HelperBase();
const g = new GregorianHelper();
const p = new PersianHelper();
const c = new ChineseHelper();
console.log(b.describe(0) + g.describe(1) + p.describe(2) + c.describe(3));
`;
}

describe("#5178 tag dispatch types every arm from the first candidate's result", () => {
  /**
   * The polyfill's shape: the dispatch result is consumed inside the caller, so
   * the divergent arm lands in the cascade's `if` block and V8 reports
   * `type error in fallthru[0] (expected (ref null N), got (ref null M))`.
   */
  it("accepts overrides whose object-literal results have different shapes", async () => {
    await compileAndValidate(
      divergentHierarchy(`  describe(seed) {
    const u = this.estimate(seed);
    return u.year;
  }`),
    );
  });

  /**
   * The same divergence in RETURN position. Tail-call optimization turns each
   * arm's `call` into `return_call`, which requires the callee's result type to
   * equal the *caller's* — so the identical root cause surfaces under a
   * different V8 message (`return_call: tail call type error`). Worth pinning
   * separately: a fix that only re-typed the cascade's block would leave this
   * one broken.
   */
  it("accepts divergent overrides in return position (tail-call form)", async () => {
    await compileAndValidate(
      divergentHierarchy(`  describe(seed) {
    const u = this.estimate(seed);
    return u;
  }`),
    );
  });

  /**
   * A base whose override returns nothing at all: one arm would be Wasm-void
   * and the other pushes a value, which no single block type can describe.
   *
   * Honest scope: this one is a GUARD, not a reduction — it is green on the
   * buggy compiler too (this shape does not reach the cascade today, both
   * bodies resolving to `externref`). It pins the new mixed-void bail-out so a
   * later change that DOES route this shape through the cascade cannot start
   * emitting the invalid module silently.
   */
  it("keeps arms that disagree on void-ness out of an invalid module", async () => {
    await compileAndValidate(`
class VBase {
  tag = 0;
  pick(seed) {
${padded("seed")}
    return { year: seed };
  }
  use(seed) {
    return this.pick(seed);
  }
}
class VSilent extends VBase {
  pick(seed) {
${padded("seed")}
    return;
  }
}
const a = new VBase();
const s = new VSilent();
console.log(typeof a.use(1) + "/" + typeof s.use(2));
`);
  });

  /**
   * Guard rail for the fix itself: when every override DOES agree on its result
   * type, nothing is widened and the cascade must still dispatch to the right
   * body. A "fix" that flattened the cascade would pass the validation tests
   * above and silently answer with the base implementation here.
   */
  it("still dispatches polymorphically when all overrides agree on a result type", async () => {
    const source = `
class HomBase {
  tag = 0;
  estimate(seed) {
${padded("seed")}
    return { year: seed, month: 1, day: 1 };
  }
  describe(seed) {
    const u = this.estimate(seed);
    return u.year;
  }
}
class HomA extends HomBase {
  estimate(seed) {
${padded("seed")}
    return { year: seed + 1, month: 2, day: 2 };
  }
}
class HomB extends HomBase {
  estimate(seed) {
${padded("seed")}
    return { year: seed + 2, month: 3, day: 3 };
  }
}
class HomC extends HomBase {
  estimate(seed) {
${padded("seed")}
    return { year: seed + 3, month: 4, day: 4 };
  }
}
const b = new HomBase();
const x = new HomA();
const y = new HomB();
const z = new HomC();
console.log(b.describe(0) + x.describe(1) + y.describe(2) + z.describe(3));
`;
    await compileAndValidate(source);
    // (0+14) + (1+14+1) + (2+14+2) + (3+14+3) = 68 — each subclass's own body.
    expect(await runLogged(source)).toEqual(["68"]);
  });
});
