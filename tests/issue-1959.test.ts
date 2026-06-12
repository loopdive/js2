// #1959 — native RegExp VM: nullable-bodied quantifiers (`(?:a?)*`, `(a*)+`)
// must apply the §22.2.2.3.1 RepeatMatcher empty-iteration progress guard. Before
// the fix a zero-width iteration looped pushing backtrack frames until the
// 1,000,000-step cap, which `runAt` reports as "no match" — a silent wrong
// answer plus a multi-second perf cliff at every scan position.
//
// We drive the standalone (pure-WasmGC) backend via `String.prototype.search`,
// which returns the first match index or -1 with no JS host import, and compare
// against native `String.prototype.search`. The TS reference VM is exercised
// directly in tests/regex-bytecode.test.ts.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function standaloneSearch(pattern: string, flags: string, input: string): Promise<number> {
  const inLit = JSON.stringify(input);
  const src = `export function run(): number { return ${inLit}.search(/${pattern}/${flags}); }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  // No JS host RegExp import — this is the pure-WasmGC matcher.
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name));
  expect(hostRegex, "no RegExp host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { run(): number }).run();
}

describe("#1959 nullable quantifier bodies terminate (RepeatMatcher progress guard)", () => {
  // [pattern, flags, input] — each must equal native search AND return fast
  // (the bug exhausted the 1M-step cap; a passing assertion already proves the
  // loop terminates, but we keep the corpus broad to cover the lowering shapes).
  const cases: Array<[string, string, string]> = [
    // The headline repro: empty match at 0, was a slow silent "no match".
    ["(?:a?)*", "", "b"],
    // Star of a nullable group that still matches content.
    ["(a?)*", "", "aaa"],
    // Anchored tail forces a real failure — must be fast, not cap-bound.
    ["(a?)*x", "", "bbb"],
    // Nested nullable stars.
    ["(?:a*)*", "", "aaa"],
    ["(?:a*)*", "", "b"],
    // Plus with a nullable body: first rep mandatory (may be empty), loop guarded.
    ["(a*)+", "", "aaa"],
    ["(?:a?)+", "", "b"],
    // Empty alternation under a star.
    ["(?:|a)*", "", "aa"],
    // Quantifier with a leading prefix and trailing required atom.
    ["x(a?)*y", "", "xy"],
    // Mixed: nullable star then a literal.
    ["(?:a|b)*c", "", "ababc"],
    ["(?:a|b)*c", "", "xyz"],
    // Plain non-nullable controls — unchanged behaviour.
    ["a*", "", "aaa"],
    ["a+", "", "aaa"],
    ["a+", "", "b"],
  ];

  for (const [pattern, flags, input] of cases) {
    it(`/${pattern}/${flags}.search(${JSON.stringify(input)}) matches native`, async () => {
      const expected = input.search(new RegExp(pattern, flags));
      const start = Date.now();
      const got = await standaloneSearch(pattern, flags, input);
      const elapsed = Date.now() - start;
      expect(got).toBe(expected);
      // Termination proof: a cap-bound loop took ~300ms-3s per scan position;
      // the whole compile+run+search here is well under a second when guarded.
      // (Generous bound — compile dominates; the match itself is microseconds.)
      expect(elapsed).toBeLessThan(15000);
    });
  }
});
