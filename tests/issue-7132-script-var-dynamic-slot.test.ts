// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7132 (#7106 integrated census, step 3) — a script `var` whose assignments
// disagree (`var got = 0; … got = n;` with a dynamic `n`, or `x = "s"`) was
// `vardecl-module-storage-unrepresentable`: the resolver refused every
// heterogeneously assigned binding before it consulted
// `scriptVarSlotIsDynamicHome`. Legacy has already widened that slot to
// externref, which off fast mode is exactly the IR's dynamic carrier, so the
// binding now resolves as `dynamic` on the slot legacy chose — never a
// representation legacy did not pick. A script that may run eval in the shared
// realm still stands down (the slot predicate answers no), as #6835 does.
//
// Every script's checks throw; each must agree with node and with the legacy
// compile (`experimentalIR: false`) on standalone and gc.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "standalone" | "gc";

async function run(
  source: string,
  lane: Lane,
  legacy = false,
): Promise<{ result: CompileResult; verdict: "ok" | "threw" }> {
  const result = await compile(source, {
    fileName: "issue-7132.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    scriptGoal: true,
    deferTopLevelInit: true,
    trackIrOutcomes: true,
    ...(lane === "standalone" ? { target: "standalone" } : {}),
    ...(legacy ? { experimentalIR: false } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  try {
    const imports = lane === "standalone" ? {} : buildImports(result.imports, {}, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    (instance.exports.__module_init as () => void)();
    return { result, verdict: "ok" };
  } catch {
    return { result, verdict: "threw" };
  }
}

function node(source: string): "ok" | "threw" {
  try {
    new Function(source)();
    return "ok";
  } catch {
    return "threw";
  }
}

function moduleInitIsIr(result: CompileResult): boolean | undefined {
  return (result.irOutcomes ?? []).find((row) => row.displayName === "<module-init>")?.irBodyEmitted;
}

const CALLEE = `/** @returns {number} */ function subject() { return 0; }
subject.give = function (fn) { fn(5, "s"); };
`;

const CASES: Record<string, string> = {
  numberThenDynamic: `${CALLEE}var got = 0;
subject.give(function (n) { got = n; });
if (got !== 5) { throw "got"; }`,
  stringThenDynamic: `${CALLEE}var tag = "";
subject.give(function (n, s) { tag = s; });
if (tag !== "s") { throw "tag"; }`,
  numberThenString: `var x = 0;
x = "s";
if (x !== "s") { throw "x"; }`,
};

describe("#7132 — a heterogeneously assigned script var binds to legacy's externref slot", () => {
  for (const lane of ["standalone", "gc"] as const) {
    for (const [name, source] of Object.entries(CASES)) {
      it(`${name} (${lane}): <module-init> is IR and agrees with node and legacy`, async () => {
        expect(node(source)).toBe("ok");
        const ir = await run(source, lane);
        expect(moduleInitIsIr(ir.result)).toBe(true);
        expect(ir.verdict).toBe("ok");
        expect((await run(source, lane, true)).verdict).toBe("ok");
        const wrong = source.replace(/!== (5|"s")\)/, '!== "nope")');
        expect(wrong).not.toBe(source);
        expect(node(wrong)).toBe("threw");
        const failing = await run(wrong, lane);
        expect(moduleInitIsIr(failing.result)).toBe(true);
        expect(failing.verdict).toBe("threw");
        expect((await run(wrong, lane, true)).verdict).toBe("threw");
      }, 60_000);
    }

    it(`stands down for an eval-visible var in the shared-realm mode (${lane})`, async () => {
      for (const source of [
        `var got = 0;\ngot = "s";\nvar seen = eval("got");\nif (seen !== "s") { throw "eval"; }`,
        `var got = 0;\neval("got = 'w'");\nif (got !== "w") { throw "eval write"; }`,
      ]) {
        const ir = await run(source, lane);
        expect(moduleInitIsIr(ir.result)).not.toBe(true);
        expect(ir.verdict).toBe(node(source));
      }
    }, 60_000);
  }

  it("a callee withdrawn on ABI parity leaves no untyped lifted-closure slot behind", async () => {
    // `f` claims (its `got` write is now representable), then withdraws on a
    // parameter-ABI parity mismatch; <module-init> cascades to legacy. Before
    // the orphan fix the planned member closure's fresh slot kept its
    // placeholder type and Program-ABI planning failed the whole compile.
    const source = `${CALLEE}var got = 0;
function f(n) { got = n; }
f("q");
if (got !== "q") { throw "f"; }`;
    expect(node(source)).toBe("ok");
    const { verdict } = await run(source, "standalone");
    expect(verdict).toBe("ok");
  }, 60_000);
});
