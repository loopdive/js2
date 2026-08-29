// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4644 — compiler-emitted calls that push fewer operands than the callee's
 * declared arity.
 *
 * The whole point of this family is that **`compile()` is not the gate**: every
 * case below reports ZERO diagnostics and `success: true`, and only
 * `WebAssembly.compile()` rejects the bytes. So each test asserts BOTH — a
 * clean compile *and* a binary the engine accepts. Asserting only the first
 * would pass on the buggy compiler.
 *
 * Found while compiling `@js-temporal/polyfill@0.5.1` in slices (#4628): 5 of
 * 14 slices emitted a module the validator refused. Reducing them turned up
 * FOUR independent producers, not one — the `__call_*` naming on four of the
 * five samples suggested a single thunk-synthesis bug, and the fifth
 * (`IslamicBaseHelper_estimateIsoDate`, an ordinary user method) is what said
 * otherwise.
 *
 * Compile options mirror `tests/dogfood/temporal-polyfill-harness.mjs`, which
 * mirrors `tests/test262-runner.ts`: `allowJs` is load-bearing — without it
 * this would measure TypeScript diagnostics on published JS instead of
 * compiler gaps.
 */
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const CORPUS_OPTIONS = {
  fileName: "issue-4644.js",
  allowJs: true,
  sourceMap: true,
  skipSemanticDiagnostics: true,
} as const;

async function compileAndValidate(source: string): Promise<Uint8Array> {
  const result = await compile(source, CORPUS_OPTIONS);
  const errors = (result.errors ?? []).filter((e) => e.severity !== "warning");
  expect(errors.map((e) => `L${e.line}: ${e.message}`)).toEqual([]);
  expect(result.binary?.length ?? 0).toBeGreaterThan(0);
  // The gate. `compile()` above is green on the buggy compiler too.
  await expect(WebAssembly.compile(result.binary!)).resolves.toBeInstanceOf(WebAssembly.Module);
  return result.binary!;
}

async function runLogged(source: string): Promise<string[]> {
  const result = await compile(source, CORPUS_OPTIONS);
  const logged: string[] = [];
  const imports = buildImports(result.imports, undefined, result.stringPool) as Record<string, any>;
  const env = imports.env as Record<string, any>;
  // Wrap EVERY console_log_* variant: which one a call site picks depends on
  // the static type it inferred, and pinning the list to three names silently
  // recorded nothing when the value arrived boxed.
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

describe("#4644 call thunks push one operand fewer than the callee's arity", () => {
  /**
   * Producer 1 — tag-based virtual dispatch (`emitVirtualMethodDispatchByTag`).
   *
   * The shared argument temps were sized from `candidates[0]`'s Wasm signature
   * and then pushed unchanged into every arm. Overrides need not share an
   * arity, so the arm whose callee declares one more parameter came up short.
   *
   * Declaration ORDER is load-bearing in this repro: the candidate list follows
   * `classParentMap` insertion order, so the NARROW override must be declared
   * first for the shortfall (rather than a surplus, which surfaces as a
   * fallthru type error) to be the observed failure.
   */
  it("pads each virtual-dispatch arm to ITS OWN callee arity, not the first candidate's", async () => {
    await compileAndValidate(`
      class HelperBase {}
      class NarrowHelper extends HelperBase {
        adjust(e, t, n = "constrain") { return { year: e + 2 }; }
      }
      class WideHelper extends HelperBase {
        adjust(e, t, n = "constrain", r = false) { return { year: e + 1 }; }
      }
      class CallerHelper extends HelperBase {
        run(e) { const { year: y } = this.adjust(e); return y; }
      }
      console.log(new WideHelper().adjust(1, 2).year, new NarrowHelper().adjust(3, 4).year);
    `);
  });

  /**
   * Producer 2 — the ToPrimitive dispatchers (`__call_toString` /
   * `__call_valueOf`) and the direct `${Class}_toString` / `${Class}_valueOf`
   * calls in `type-coercion.ts`.
   *
   * ToPrimitive passes zero arguments, but the method may still DECLARE
   * parameters. Three of the five polyfill samples were this one.
   */
  it("pads a declared-but-unpassed parameter on a ToPrimitive toString", async () => {
    await compileAndValidate(`
      class P {
        toString(e) { return e === undefined ? "undef" : "got"; }
      }
      console.log(String(new P()));
      console.log("" + new P());
      console.log(new P().toString());
    `);
  });

  it("passes `undefined` — not zero/null — for the padded ToPrimitive argument", async () => {
    // §7.1.1.1 calls `toString` with an EMPTY argument list, so the declared
    // parameter is `undefined`. A `ref.null.extern` pad would read as `null`
    // here and a numeric pad as `0`; both are observably wrong.
    const logged = await runLogged(`
      class P {
        toString(e) { return e === undefined ? "undef" : "got"; }
      }
      console.log(String(new P()));
      console.log("" + new P());
      console.log(new P().toString());
    `);
    expect(logged).toEqual(["undef", "undef", "undef"]);
  });

  it("pads a declared-but-unpassed parameter on a ToPrimitive valueOf", async () => {
    await compileAndValidate(`
      class N {
        valueOf(hint) { return hint === undefined ? 41 : 7; }
      }
      console.log(new N() + 1);
    `);
  });

  it("imports the host `undefined` when the padded valueOf is the module's ONLY use of it", async () => {
    // `new N() + 1` is the whole program: nothing else pulls `__get_undefined`
    // in, so the pad silently degraded to `ref.null.extern` and the method saw
    // JS `null`. 8, not 42, was the answer before this was fixed.
    const logged = await runLogged(`
      class N {
        valueOf(hint) { return hint === undefined ? 41 : 7; }
      }
      console.log(new N() + 1);
    `);
    expect(logged).toEqual(["42"]);
  });

  /**
   * Producer 3 — the host vararg class bridge `__class_call_<m>_vararg`.
   *
   * `funcRestParams.restIndex` is a SOURCE parameter index (no receiver slot)
   * while the bridge read it as a Wasm parameter index (receiver at slot 0).
   * The two agree only when the rest param is first, so `m(...rest)` was fine
   * and `m(e, ...rest)` dropped its one fixed argument.
   */
  it("forwards the fixed arguments of a rest-parameter method through the host vararg bridge", async () => {
    await compileAndValidate(`
      class DateTimeFormatImpl {
        constructor(id) { this.id = id; }
        formatToParts(e, ...t) { return this.id + e + t.length; }
      }
      function dispatch(n, r) { return n.formatToParts(...r); }
      console.log(dispatch(new DateTimeFormatImpl(7), [1, 2, 3]));
    `);
  });

  /**
   * Producer 4 — the same virtual-dispatch cascade reading `__tag`.
   *
   * The emitter documented "field 0 is `__tag` in every class struct this path
   * can see" as a fact and never checked it. An OBJECT-LITERAL struct's field 0
   * is its first property, so the cascade compared an `externref` with
   * `i32.eq`. This one was invisible on `main` behind an earlier failing
   * function in the same module — the validator stops at the first one.
   */
  it("does not read a tag out of an object-literal struct whose field 0 is not i32", async () => {
    await compileAndValidate(`
      class HelperBase {}
      const ii = {
        maximumMonthLength(e) { return this.minimumMonthLength(e); },
      };
      class ChineseBaseHelper extends HelperBase {
        constructor() { super(...arguments); this.calendarType = "lunisolar"; }
        minimumMonthLength() { return 29; }
      }
      class ChineseHelper extends ChineseBaseHelper {
        constructor() { super(...arguments); this.id = "chinese"; }
      }
      console.log(new ChineseHelper().minimumMonthLength());
    `);
  });

  it("still dispatches the object-literal receiver's call correctly after bailing to the static path", async () => {
    const logged = await runLogged(`
      class HelperBase {}
      const ii = {
        maximumMonthLength(e) { return this.minimumMonthLength(e); },
      };
      class ChineseBaseHelper extends HelperBase {
        constructor() { super(...arguments); this.calendarType = "lunisolar"; }
        minimumMonthLength() { return 29; }
      }
      class ChineseHelper extends ChineseBaseHelper {
        constructor() { super(...arguments); this.id = "chinese"; }
      }
      console.log(new ChineseHelper().minimumMonthLength());
    `);
    expect(logged).toEqual(["29"]);
  });
});
