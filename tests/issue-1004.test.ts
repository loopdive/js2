// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// (#1004) Counted-append string-loop aggregation: `for (let i=0;i<N;i++) s = s + FRAG`
// lowers to `s += FRAG.repeat(N)`. These tests pin byte-identical semantics for
// the optimizable cases and confirm the guard declines unsafe shapes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime.js";

const BUILDER_SWITCH = "JS2WASM_IR_STRING_BUILDER";
const DIRECT_POISON = "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY";
const PREPARED_SEAL_FAILURE = "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE";

function watFunctionBody(wat: string, name: string): string {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  const matches = starts.flatMap((entry, position) =>
    entry.name === name ? [wat.slice(entry.index, starts[position + 1]?.index ?? wat.length)] : [],
  );
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!;
}

/** Resolve numeric calls against the same full WAT module; raw indices are not stable evidence. */
function watCallTargets(wat: string, body: string): string[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  if (new Set(names).size !== names.length) throw new Error("WAT callable names are not unique");
  return [...body.matchAll(/\b(?:return_)?call (\d+)/g)].map((match) => {
    const target = names[Number(match[1])];
    if (!target) throw new Error(`WAT call ${match[1]} has no exact callable target`);
    return target;
  });
}

async function runStr(src: string): Promise<string> {
  const exports = (await compileAndInstantiate(src)) as { test(): string };
  return exports.test();
}
async function runNum(src: string): Promise<number> {
  const exports = (await compileAndInstantiate(src)) as { test(): number };
  return exports.test();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("#1004 counted string-append aggregation", () => {
  it("aggregates the canonical benchmark loop (length)", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let str = "";
          for (let i = 0; i < 1000; i++) str = str + "abcde";
          return str.length;
        }`),
    ).toBe(5000);
  });

  it("routes the counted aggregate through Prepared IR without entering the direct body", async () => {
    vi.stubEnv(DIRECT_POISON, "test");
    const result = await compile(
      `
      export function test(): number {
        let str = "";
        for (let i = 0; i < 1000; i++) str = str + "abcde";
        return str.length;
      }
      `,
      {
        target: "standalone",
        trackIrOutcomes: true,
        emitWat: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irCompiledFuncs ?? []).toContain("test");
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "test")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "test")).toEqual([]);
    const testBody = watFunctionBody(result.wat, "test");
    expect(testBody).not.toContain("i32.lt_s");
    const targets = watCallTargets(result.wat, testBody);
    // The final optimizer inlines the validated f64 adapter into `test`; the
    // remaining physical call is its exact native i32 repeat kernel.
    expect(
      targets.filter((target) => target === "__str_repeat"),
      `test call targets: ${JSON.stringify(targets)}`,
    ).toHaveLength(1);
    expect(targets.filter((target) => /^__str_concat(?:_owned)?$/.test(target))).toHaveLength(1);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports.test as () => number)()).toBe(5000);
  });

  it("preserves non-ASCII code units through the Prepared native provider", async () => {
    vi.stubEnv(DIRECT_POISON, "test");
    const result = await compile(
      `
        export function test(): number {
          let value = "";
          for (let index = 0; index < 3; index++) value = value + "é";
          return value.length;
        }
      `,
      {
        target: "standalone",
        trackIrOutcomes: true,
        emitWat: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "test")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    const targets = watCallTargets(result.wat, watFunctionBody(result.wat, "test"));
    expect(
      targets.filter((target) => target === "__str_repeat"),
      `test call targets: ${JSON.stringify(targets)}`,
    ).toHaveLength(1);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports.test as () => number)()).toBe(3);
  });

  it("executes the same counted Prepared shape through the host repeat adapter", async () => {
    vi.stubEnv(DIRECT_POISON, "test");
    const result = await compile(
      `
        export function test(): number {
          let value = "";
          for (let index = 0; index < 3; index++) value = value + "abc";
          return value.length;
        }
      `,
      {
        trackIrOutcomes: true,
        emitWat: true,
      },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "test")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(result.imports).toContainEqual(
      expect.objectContaining({
        module: "env",
        name: "string_repeat",
        kind: "func",
        paramCount: 2,
        intent: { type: "string_method", method: "repeat" },
      }),
    );
    expect(
      watCallTargets(result.wat, watFunctionBody(result.wat, "test")).filter(
        (target) => target === "string_repeat_import",
      ),
    ).toHaveLength(1);
    const { buildCompiledImports } = await import("../src/index.js");
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(9);
  });

  it("restores the exact direct artifact when the string-builder rollback is disabled", async () => {
    vi.stubEnv(BUILDER_SWITCH, "0");
    vi.stubEnv(DIRECT_POISON, "test");
    const result = await compile(
      `
        export function test(): number {
          let str = "";
          for (let i = 0; i < 1000; i++) str = str + "abcde";
          return str.length;
        }
      `,
      { target: "standalone", trackIrOutcomes: true },
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "injected direct function-body poison: test",
    );
    expect(
      result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "test").map((row) => row.entryPoint),
    ).toContain("compileFunctionBody");
  });

  it("fails closed instead of retrying direct after a retained proof hits typed preparation failure", async () => {
    vi.stubEnv(PREPARED_SEAL_FAILURE, "1");
    vi.stubEnv(DIRECT_POISON, "test");
    const result = await compile(
      `
        export function test(): number {
          let value = "";
          for (let index = 0; index < 3; index++) value = value + "abc";
          return value.length;
        }
      `,
      { target: "standalone", trackIrOutcomes: true },
    );
    expect(result.success).toBe(false);
    const diagnostics = result.errors.map((error) => error.message).join("\n");
    expect(diagnostics).toContain("failed after its exact proof was retained and cannot retry direct");
    expect(diagnostics).not.toContain("injected direct function-body poison: test");
    expect(result.irPostClaimErrors?.filter((error) => error.func === "test")).toEqual([
      {
        kind: "build",
        func: "test",
        message: expect.stringContaining("dependency-complete component"),
      },
      {
        kind: "build",
        func: "test",
        message: expect.stringContaining("failed after its exact proof was retained and cannot retry direct"),
      },
    ]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "test")).toMatchObject({
      kind: "invariant",
      code: "selection-preparation-mismatch",
      legacyBodyEmitted: false,
      irBodyEmitted: false,
    });
    expect(result.irBodyRouteAudit?.legacyEntries.filter((row) => row.bodyName === "test")).toEqual([]);
  });

  it("produces the byte-identical string", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 4; i++) s = s + "ab";
          return s;
        }`),
    ).toBe("abababab");
  });

  it("honors a non-empty seed prefix", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "X";
          for (let i = 0; i < 3; i++) s = s + "yz";
          return s;
        }`),
    ).toBe("Xyzyzyz");
  });

  it("handles the compound-assignment form", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 5; i++) s += "q";
          return s;
        }`),
    ).toBe("qqqqq");
  });

  it("handles a braced single-statement body", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 3; i++) { s = s + "mn"; }
          return s;
        }`),
    ).toBe("mnmnmn");
  });

  it("handles a non-zero start (i<=B inclusive)", async () => {
    // i = 2..10 inclusive → 9 iterations
    expect(
      await runNum(`
        export function test(): number {
          let s = "";
          for (let i = 2; i <= 10; i++) s = s + "z";
          return s.length;
        }`),
    ).toBe(9);
  });

  it("a loop-invariant string identifier fragment", async () => {
    expect(
      await runStr(`
        export function test(): string {
          const frag = "hi";
          let s = "";
          for (let i = 0; i < 3; i++) s = s + frag;
          return s;
        }`),
    ).toBe("hihihi");
  });

  it("emits nothing for a zero-iteration loop (keeps seed)", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "seed";
          for (let i = 0; i < 0; i++) s = s + "x";
          return s;
        }`),
    ).toBe("seed");
  });

  it("emits nothing when start >= bound", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "seed";
          for (let i = 5; i < 3; i++) s = s + "x";
          return s;
        }`),
    ).toBe("seed");
  });

  it("still handles a single iteration (N=1) via the normal path", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "a";
          for (let i = 0; i < 1; i++) s = s + "b";
          return s;
        }`),
    ).toBe("ab");
  });

  // ── Guard must DECLINE unsafe / non-matching shapes (correctness) ──

  it("does NOT aggregate when the body references the counter (i-dependent)", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 3; i++) s = s + ("" + i);
          return s;
        }`),
    ).toBe("012");
  });

  it("does NOT aggregate a prepend loop (order matters)", async () => {
    expect(
      await runStr(`
        export function test(): string {
          let s = "";
          for (let i = 0; i < 3; i++) s = "a" + s + "b";
          return s;
        }`),
    ).toBe("aaabbb");
  });

  it("does NOT aggregate a multi-statement body", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let s = "";
          let c = 0;
          for (let i = 0; i < 4; i++) { s = s + "x"; c = c + 1; }
          return s.length + c;
        }`),
    ).toBe(8);
  });

  it("does NOT aggregate a doubling accumulator (s = s + s)", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let s = "ab";
          for (let i = 0; i < 3; i++) s = s + s;
          return s.length;
        }`),
    ).toBe(16);
  });

  it("does NOT aggregate a runtime (non-constant) bound", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let n = 5;
          n = n + 1;
          let s = "";
          for (let i = 0; i < n; i++) s = s + "z";
          return s.length;
        }`),
    ).toBe(6);
  });

  it("does NOT aggregate a non-unit step", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let s = "";
          for (let i = 0; i < 10; i += 2) s = s + "z";
          return s.length;
        }`),
    ).toBe(5);
  });

  it("nested aggregated loops compose correctly", async () => {
    expect(
      await runNum(`
        export function test(): number {
          let total = 0;
          for (let j = 0; j < 3; j++) {
            let s = "";
            for (let i = 0; i < 4; i++) s = s + "ab";
            total = total + s.length;
          }
          return total;
        }`),
    ).toBe(24);
  });
});
