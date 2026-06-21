// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2091 — regex step-cap exhaustion must throw a catchable RangeError, not
 * silently report a no-match.
 *
 * Before this fix, a regex exceeding the 1M-VM-step cap returned `null` (TS
 * reference VM) / `0` (Wasm `__regex_run`) — a silent wrong answer
 * indistinguishable from a genuine no-match. Catastrophic-backtracking patterns
 * (`(a+)+b` against a long all-`a` non-matching subject) burn the cap and hit
 * this. Now both the reference VM (`regex/vm.ts`) and the native Wasm matcher
 * (`native-regex.ts` `__regex_run`) throw a catchable `RangeError`.
 *
 * Part 1 unit-tests the TS reference VM directly (the spec the Wasm mirrors).
 * Part 2 compiles `--target standalone` (which uses the native VM, not the JS
 * host RegExp) and asserts the thrown value is caught and is a `RangeError`,
 * with non-catastrophic regexes unaffected.
 */
import { describe, expect, it } from "vitest";
import { compilePattern } from "../src/codegen/regex/compile.js";
import { parseFlags } from "../src/codegen/regex/bytecode.js";
import { search, REGEX_STEP_CAP } from "../src/codegen/regex/vm.js";
import { compile } from "../src/index.js";

describe("#2091 reference VM throws on step-cap exhaustion", () => {
  it("catastrophic backtracking throws RangeError (not a silent null no-match)", () => {
    // `(a+)+b` over an all-`a` subject with no trailing `b` is the classic
    // exponential-backtracking ReDoS — it blows past REGEX_STEP_CAP.
    const c = compilePattern("(a+)+b", parseFlags(""));
    const subject = "a".repeat(40);
    expect(() => search(c.prog, c.classTable, c.nGroups, subject, 0, false)).toThrow(RangeError);
  });

  it("a normal match does NOT throw and returns the match span", () => {
    const c = compilePattern("a(b+)c", parseFlags(""));
    const m = search(c.prog, c.classTable, c.nGroups, "abbbc", 0, false);
    expect(m).not.toBeNull();
    expect([m![0], m![1]]).toEqual([0, 5]);
  });

  it("a normal no-match returns null (NOT a throw — cap untouched)", () => {
    const c = compilePattern("xyz", parseFlags(""));
    expect(search(c.prog, c.classTable, c.nGroups, "abcabc", 0, false)).toBeNull();
  });

  it("the cap constant is the single source of truth (exported, 1M)", () => {
    expect(REGEX_STEP_CAP).toBe(1_000_000);
  });
});

describe("#2091 native (standalone) __regex_run throws on step-cap exhaustion", () => {
  // Compile + run an i32-returning probe under --target standalone (native VM,
  // zero host imports). 0 = no-throw, 1 = caught (non-RangeError), 2 = caught
  // RangeError.
  async function runStandalone(src: string): Promise<number> {
    const r = await compile(src, { fileName: "test.ts", target: "standalone" });
    expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
    const mod = await WebAssembly.compile(r.binary);
    // Native standalone — no JS-host RegExp import.
    expect(WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name))).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as { run(): number }).run();
  }

  it("catastrophic backtracking throws a catchable RangeError", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const re = /(a+)+b/;
           try { re.test("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"); return 0; }
           catch (e) { return (e instanceof RangeError) ? 2 : 1; }
         }`,
      ),
    ).toBe(2);
  });

  it("a non-catastrophic regex still matches (no spurious throw)", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const re = /(a+)+b/;
           try { return re.test("aaab") ? 10 : 11; }
           catch (e) { return 1; }
         }`,
      ),
    ).toBe(10);
  });

  it("a non-catastrophic no-match returns false (no spurious throw)", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const re = /xyz/;
           try { return re.test("abcabc") ? 10 : 11; }
           catch (e) { return 1; }
         }`,
      ),
    ).toBe(11);
  });
});
