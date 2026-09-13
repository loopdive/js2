// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3461 — FAST native-harness oracle (host lane). The harness prefix runs
 * NATIVELY in the per-test sandbox and only `bindingShim + body` is compiled to
 * wasm. This suite pins the deterministic assembly logic:
 *
 *  - `buildBindingShim` binds ONLY the harness symbols the body references
 *    (fixes the spike's member-call gap: `assert.sameValue` needs `assert` bound
 *    because a member-get on an undeclared global does NOT consult the sandbox
 *    bridge — only a bare reference does);
 *  - `assembleNativeHarness` splits prefix / bindingShim / body with an exact
 *    `bodyLineOffset` and a strict-neutral prefix;
 *  - AC#2: the honest `assembleOriginalHarness` is byte-unchanged by the refactor.
 *
 * The end-to-end compile+native-exec path is validated separately (it needs the
 * experimental-wasm node flags not present in the vitest fork); this suite is the
 * pure-logic regression net.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleNativeHarness, assembleOriginalHarness, buildBindingShim } from "./test262-original-harness.js";

function lineCount(s: string): number {
  return s.length === 0 ? 0 : s.split("\n").length - 1;
}

describe("#3461 buildBindingShim binds only referenced harness symbols", () => {
  it("binds a member-accessed harness function (the finding-#3 gap)", () => {
    const shim = buildBindingShim("assert.sameValue(1, 1);");
    expect(shim).toContain("var assert = globalThis.assert;");
  });

  it("binds referenced built-ins (deliberate host-delegation) but not unreferenced ones", () => {
    const shim = buildBindingShim("verifyProperty(Array.prototype, 'slice', {});");
    expect(shim).toContain("var verifyProperty = globalThis.verifyProperty;");
    expect(shim).toContain("var Array = globalThis.Array;");
    expect(shim).not.toContain("var Object =");
    expect(shim).not.toContain("var WeakMap =");
  });

  it("binds $-prefixed harness callbacks ($DONE / $ERROR)", () => {
    const shim = buildBindingShim("$DONE(); $ERROR('boom');");
    expect(shim).toContain("var $DONE = globalThis.$DONE;");
    expect(shim).toContain("var $ERROR = globalThis.$ERROR;");
  });

  it("does not bind on a partial identifier match (assertFoo != assert)", () => {
    const shim = buildBindingShim("assertFoo(1); myassert(2);");
    expect(shim).not.toContain("var assert =");
  });

  it("emits nothing when the body references no harness symbol", () => {
    expect(buildBindingShim("let x = 1 + 2; f(x);")).toBe("");
  });

  it("emits one line per bound symbol (bodyLineOffset accounting)", () => {
    const shim = buildBindingShim("assert.sameValue(compareArray([1], [1]), true);");
    // assert + compareArray + Array-not-referenced-here-as-token → 2 binds
    expect(lineCount(shim)).toBe(shim.split("\n").filter((l) => l.startsWith("var ")).length);
  });
});

// (#6463) These invariants describe the variant SPLIT, not the strict-neutral
// rerun elision; pin the unconditional rerun so the fixture bodies keep one.
const savedStrictRerun = process.env.TEST262_STRICT_RERUN;
beforeAll(() => {
  process.env.TEST262_STRICT_RERUN = "always";
});
afterAll(() => {
  // Assigning `undefined` would store the string "undefined"; "" is not "always".
  process.env.TEST262_STRICT_RERUN = savedStrictRerun ?? "";
});

describe("#3461 assembleNativeHarness split invariants", () => {
  const meta = { includes: [] as string[] };

  it("keeps the harness prefix strict-neutral (no directive; run once natively)", () => {
    const asm = assembleNativeHarness("assert.sameValue(1, 1);", meta);
    expect(asm.primary.harnessPrefix.startsWith('"use strict"')).toBe(false);
    // The prefix must still contain the harness (assert.js defines `assert`).
    expect(asm.primary.harnessPrefix).toContain("assert");
  });

  it("leaves the test body byte-untouched", () => {
    const body = "assert.sameValue(1, 1, 'msg');\n// trailing\n";
    expect(assembleNativeHarness(body, meta).primary.body).toBe(body);
  });

  it("sets bodyLineOffset = lineCount(bindingShim) so body error lines map exactly", () => {
    const asm = assembleNativeHarness("assert.sameValue(1, 1);", meta);
    expect(asm.primary.bodyLineOffset).toBe(lineCount(asm.primary.bindingShim));
  });

  it("puts the strict directive first in the strict-rerun bindingShim", () => {
    const asm = assembleNativeHarness("assert.sameValue(1, 1);", meta);
    expect(asm.strictRerun).toBeDefined();
    expect(asm.strictRerun!.bindingShim.startsWith('"use strict";\n')).toBe(true);
    expect(asm.strictRerun!.strict).toBe(true);
    // The prefix (native exec) is shared and never carries the directive.
    expect(asm.strictRerun!.harnessPrefix.startsWith('"use strict"')).toBe(false);
  });

  it("mirrors assembleOriginalHarness's variant gating (raw/module/onlyStrict/noStrict)", () => {
    expect(assembleNativeHarness("x;", { includes: [], flags: ["raw"] }).strictRerun).toBeUndefined();
    expect(assembleNativeHarness("x;", { includes: [], flags: ["module"] }).strictRerun).toBeUndefined();
    expect(assembleNativeHarness("x;", { includes: [], flags: ["onlyStrict"] }).strictRerun).toBeUndefined();
    expect(assembleNativeHarness("x;", { includes: [], flags: ["noStrict"] }).strictRerun).toBeUndefined();
    expect(assembleNativeHarness("x;", { includes: [], flags: [] }).strictRerun).toBeDefined();
  });

  it("raw variant has no prefix and no bindings", () => {
    const asm = assembleNativeHarness("throw 0;", { includes: [], flags: ["raw"] });
    expect(asm.primary.harnessPrefix).toBe("");
    expect(asm.primary.bindingShim).toBe("");
    expect(asm.primary.bodyLineOffset).toBe(0);
    expect(asm.primary.body).toBe("throw 0;");
  });
});

describe("#3461 AC#2 — honest assembleOriginalHarness is byte-unchanged by the refactor", () => {
  const ROOT = join(import.meta.dirname ?? ".", "..");
  const HARNESS = join(ROOT, "test262", "harness");
  const RUNTIME = join(ROOT, "scripts", "test262-fyi-runtime.js");
  const cache = new Map<string, string>();
  const cached = (p: string) => {
    let s = cache.get(p);
    if (s === undefined) {
      s = readFileSync(p, "utf8");
      cache.set(p, s);
    }
    return s;
  };
  const hs = (n: string) => cached(join(HARNESS, n));

  // Verbatim pre-refactor dedupe + assembleVariant (the reference behaviour).
  function dedupe(prefix: string): string {
    const declRe = /^((?:async[ \t]+)?function[ \t]+)([A-Za-z_$][\w$]*)([ \t]*\()/gm;
    const total = new Map<string, number>();
    prefix.replace(declRe, (full, _kw, name) => {
      total.set(name, (total.get(name) ?? 0) + 1);
      return full;
    });
    const dup = new Set([...total].filter(([, c]) => c > 1).map(([n]) => n));
    if (dup.size === 0) return prefix;
    const seen = new Map<string, number>();
    return prefix.replace(declRe, (full, kw, name, paren) => {
      if (!dup.has(name)) return full;
      const idx = seen.get(name) ?? 0;
      seen.set(name, idx + 1);
      if (idx === total.get(name)! - 1) return full;
      return `${kw}${name}$dup${idx}${paren}`;
    });
  }
  function oldVariant(source: string, meta: any, strict: boolean, raw: boolean, async: boolean) {
    if (raw) return { source, bodyLineOffset: 0, strict };
    let prefix = strict ? '"use strict";\n' : "";
    if (async) prefix += hs("doneprintHandle.js");
    for (const include of meta.includes ?? []) prefix += hs(include);
    prefix += cached(RUNTIME);
    prefix += hs("assert.js");
    prefix += hs("sta.js");
    prefix = dedupe(prefix);
    return { source: prefix + source, bodyLineOffset: lineCount(prefix), strict };
  }
  function oldAssemble(source: string, meta: any) {
    const flags = new Set(meta.flags ?? []);
    const raw = flags.has("raw");
    const async = flags.has("async");
    const onlyStrict = flags.has("onlyStrict");
    const strictRerun = !raw && !flags.has("module") && !onlyStrict && !flags.has("noStrict");
    return {
      primary: oldVariant(source, meta, onlyStrict, raw, async),
      ...(strictRerun ? { strictRerun: oldVariant(source, meta, true, raw, async) } : {}),
      async,
      raw,
    };
  }

  const cases = [
    { body: "assert.sameValue(1,1);\n", meta: { includes: [], flags: [] } },
    { body: "testTypedArray();\n", meta: { includes: ["testTypedArray.js", "compareArray.js"], flags: [] } },
    { body: "asyncTest(async () => {});\n", meta: { includes: ["asyncHelpers.js"], flags: ["async"] } },
    { body: "raw();\n", meta: { includes: [], flags: ["raw"] } },
    { body: "only();\n", meta: { includes: [], flags: ["onlyStrict"] } },
    { body: "mod();\n", meta: { includes: [], flags: ["module"] } },
  ];

  for (const c of cases) {
    it(`byte-identical for includes=${JSON.stringify(c.meta.includes)} flags=${JSON.stringify(c.meta.flags)}`, () => {
      expect(assembleOriginalHarness(c.body, c.meta)).toEqual(oldAssemble(c.body, c.meta));
    });
  }
});
