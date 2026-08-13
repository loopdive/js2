// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4276) `x instanceof Object` / `x instanceof Function` in the standalone
 * (`noJsHost`) lane.
 *
 * Before this change both answered a hard `false` whenever the LHS was dynamic:
 *   - `Object` was not modelled by `nativeBuiltinInstanceOfTypeIdxs` (#2916) at
 *     all, so the dispatch site fell through to `i32.const 0`;
 *   - `Function` used `closureRootTypeIdxsFor(ctx)`, a SNAPSHOT taken at
 *     expression-lowering time — an empty list is the #2916 "definite 0"
 *     contract, so the answer depended on where in the module the test sat.
 *
 * A statically-typed LHS is folded by `tryStaticInstanceOf` before the builtin
 * dispatch is consulted, so every positive case below forces a DYNAMIC (`any`)
 * LHS. Cases marked `RED ON BASE` returned 0 before the fix; the negatives were
 * already correct and are here because a naive "always true" predicate — the
 * obvious wrong fix — passes every positive and fails all of them.
 *
 * Every case asserts BOTH halves of the standalone contract: the ANSWER, and
 * that the binary carries NO host imports (a right answer that still leaks
 * `env::*` cannot instantiate, so the #2961 leak guard refuses the test).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

interface Outcome {
  result: number;
  imports: string[];
}

/** Compile a standalone SCRIPT, run `__module_init`, read `result`. */
async function run(body: string): Promise<Outcome> {
  const source = `var result = -1;\n${body}\nexport function test(): number { return result as number; }\n`;
  const compiled = await compile(source, {
    allowJs: true,
    fileName: "issue-4276.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
  });
  expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
  const imports = (compiled.imports ?? []).map((i: unknown) =>
    typeof i === "string" ? i : `${(i as { module: string }).module}::${(i as { name: string }).name}`,
  );
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  (instance.exports as Record<string, unknown> & { __module_init?: () => void }).__module_init?.();
  const result = (instance.exports as Record<string, () => number>).test();
  return { result, imports };
}

describe("#4276 — `instanceof Object` over a dynamic LHS (standalone)", () => {
  // RED ON BASE: every one of these answered 0.
  const objectPositives: Array<[string, string]> = [
    ["an object literal", `var o: any = {};`],
    ["an array", `var o: any = [1, 2];`],
    ["a function declaration read as a value", `function g() {}\nvar o: any = g;`],
    ["a `new Object()`", `var o: any = new Object();`],
    ["a Number wrapper", `var o: any = new Number(1);`],
    ["a String wrapper", `var o: any = new String("x");`],
    ["a Boolean wrapper", `var o: any = new Boolean(true);`],
    ["a Date", `var o: any = new Date();`],
    ["a RegExp", `var o: any = /a/;`],
    ["an Error", `var o: any = new Error("x");`],
    ["a user-fnctor instance", `function F() { this.x = 1; }\nvar o: any = new F();`],
  ];
  for (const [name, decl] of objectPositives) {
    it(`answers true for ${name}`, async () => {
      const o = await run(`${decl}\nresult = (o instanceof Object) ? 1 : 0;`);
      expect(o.result).toBe(1);
      expect(o.imports).toEqual([]);
    });
  }

  it("answers true after a `typeof` use of the same binding", async () => {
    // RED ON BASE, and the exact shape of `language/expressions/object/
    // S11.1.5_A1.1` CHECK#1+#2: the `typeof` read defeats the static fold, which
    // is why adding CHECK#1 flipped CHECK#2 from pass to fail on base.
    const o = await run(
      `var object = {};\nif (typeof object !== "object") { result = 0; }\n` +
        `else if (object instanceof Object !== true) { result = 0; }\nelse { result = 1; }`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("answers true for the result of `Object.create`", async () => {
    // RED ON BASE — `built-ins/Object/create/15.2.3.5-4-2`.
    const o = await run(`var newObj = Object.create({}, undefined);\nresult = (newObj instanceof Object) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("answers true for a property descriptor object", async () => {
    // RED ON BASE — `built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-247`.
    const o = await run(
      `var src = { a: 1 };\nvar desc = Object.getOwnPropertyDescriptor(src, "a");\nresult = (desc instanceof Object) ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("answers true for `this` inside an accessor invoked by Object.create", async () => {
    // RED ON BASE — the `built-ins/Object/create/15.2.3.5-4-4` shape. A probe
    // that sets `result = true` in the same getter ALREADY passed on base, so
    // the accessor is reached; `this instanceof Object` was the failing half.
    const o = await run(
      `var props = {};\nObject.defineProperty(props, "prop", {\n` +
        `  get: function () { result = (this instanceof Object) ? 1 : 0; return {}; },\n` +
        `  enumerable: true\n});\nObject.create({}, props);`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  // Negative cases. A predicate that just answers `true` passes every test
  // above and fails all of these.
  const objectNegatives: Array<[string, string]> = [
    ["null", `var o: any = null;`],
    ["an unboxed number", `var o: any = 1;`],
    ["an unboxed zero", `var o: any = 0;`],
    ["a primitive string", `var o: any = "s";`],
    ["a primitive boolean", `var o: any = false;`],
    ["undefined", `var o: any = undefined;`],
  ];
  for (const [name, decl] of objectNegatives) {
    it(`answers false for ${name}`, async () => {
      const o = await run(`${decl}\nresult = (o instanceof Object) ? 1 : 0;`);
      expect(o.result).toBe(0);
      expect(o.imports).toEqual([]);
    });
  }
});

describe("#4276 — `instanceof Function` (standalone)", () => {
  // NOT red on base — stated explicitly because it would be easy to imply
  // otherwise. In a module this small `closureRootTypeIdxsFor` happens to be
  // populated by the time the `instanceof` site lowers, so the empty-list
  // "definite 0" does not fire; it takes a larger module, which is why the
  // position-independence claim is carried by the corpus case
  // `S11.8.6_A6_T3` below (that one IS red on base). These are guards: the new
  // lowering must not weaken an answer the membership list already got right.
  it("answers true for a function declaration read dynamically", async () => {
    const o = await run(`function g() { return 0; }\nvar h: any = g;\nresult = (h instanceof Function) ? 1 : 0;`);
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  it("answers false for a hoisted binding still holding `undefined`", async () => {
    // Hoisting puts `h` at `undefined` when the test runs, so `false` is the
    // correct answer — and it must neither throw nor need a host import.
    const o = await run(`result = (h instanceof Function) ? 1 : 0;\nfunction g() { return 0; }\nvar h: any = g;`);
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("answers true for a function expression assigned later in the module", async () => {
    const o = await run(
      `var h: any = null;\nresult = -1;\nh = function () { return 1; };\nresult = (h instanceof Function) ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });

  const functionNegatives: Array<[string, string]> = [
    ["an object literal", `var o: any = {};`],
    ["an array", `var o: any = [1];`],
    ["null", `var o: any = null;`],
    ["an unboxed number", `var o: any = 1;`],
    ["a primitive string", `var o: any = "s";`],
  ];
  for (const [name, decl] of functionNegatives) {
    it(`answers false for ${name}`, async () => {
      const o = await run(`${decl}\nresult = (o instanceof Function) ? 1 : 0;`);
      expect(o.result).toBe(0);
      expect(o.imports).toEqual([]);
    });
  }
});

describe("#4276 — cross-constructor misses stay false (standalone)", () => {
  const crossMisses: Array<[string, string, string]> = [
    ["an object literal", "String", `var o: any = {};`],
    ["an object literal", "Number", `var o: any = {};`],
    ["an object literal", "Boolean", `var o: any = {};`],
    ["a Number wrapper", "String", `var o: any = new Number(1);`],
    ["a String wrapper", "Number", `var o: any = new String("x");`],
    ["a Date", "RegExp", `var o: any = new Date();`],
  ];
  for (const [what, ctor, decl] of crossMisses) {
    it(`${what} is not an instance of ${ctor}`, async () => {
      const o = await run(`${decl}\nresult = (o instanceof ${ctor}) ? 1 : 0;`);
      expect(o.result).toBe(0);
      expect(o.imports).toEqual([]);
    });
  }
});

describe("#4276 — primitive-wrapper instanceof uses the real internal brand (standalone)", () => {
  const positives: Array<[string, string]> = [
    ["Number", "new Number(1)"],
    ["String", 'new String("x")'],
    ["Boolean", "new Boolean(false)"],
  ];
  for (const [ctor, value] of positives) {
    it(`answers true for a real ${ctor} wrapper, including an any-carrier round trip`, async () => {
      const o = await run(`var value: any = ${value};\nresult = value instanceof ${ctor} ? 1 : 0;`);
      expect(o.result).toBe(1);
      expect(o.imports).toEqual([]);
    });
  }

  it("does not confuse a strict primitive this receiver with a Boolean wrapper", async () => {
    const o = await run(
      `result = (function () { "use strict"; return this instanceof Boolean; }).call(false) ? 1 : 0;`,
    );
    expect(o.result).toBe(0);
    expect(o.imports).toEqual([]);
  });

  it("rejects cross-wrapper brands and a user-spoofed internal-slot spelling", async () => {
    const o = await run(
      `var fake = {};\n` +
        `Object.defineProperty(fake, "[[PrimitiveValue]]", { value: 1 });\n` +
        `result = (!(new Number(1) instanceof String) &&\n` +
        `  !(new String("x") instanceof Boolean) &&\n` +
        `  !(new Boolean(false) instanceof Number) &&\n` +
        `  !(fake instanceof Number)) ? 1 : 0;`,
    );
    expect(o.result).toBe(1);
    expect(o.imports).toEqual([]);
  });
});

describe("#4276 — primitive-wrapper instanceof is emitted through IR", () => {
  for (const ctor of ["Number", "String", "Boolean"] as const) {
    it(`IR-emits an exact ambient ${ctor} predicate in fast standalone`, async () => {
      const compiled = await compile(`export function test(value: any): boolean { return value instanceof ${ctor}; }`, {
        fileName: `issue-4276-ir-${ctor}.ts`,
        target: "standalone",
        fast: true,
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      });
      expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
      expect(compiled.irPostClaimErrors ?? []).toEqual([]);
      expect(compiled.irCompiledFuncs).toContain("test");
      expect(compiled.irOutcomes).toEqual(
        expect.arrayContaining([expect.objectContaining({ displayName: "test", kind: "emitted", stage: "patch" })]),
      );
      expect(compiled.wat).toContain(`(func $__instanceof_wrapper_${ctor}`);
    });
  }

  it("does not claim a source-shadowed Number constructor as the ambient wrapper", async () => {
    const compiled = await compile(
      `function Number() {}\nexport function test(value: any): boolean { return value instanceof Number; }`,
      {
        fileName: "issue-4276-ir-shadow.ts",
        target: "standalone",
        fast: true,
        skipSemanticDiagnostics: true,
        trackIrOutcomes: true,
      },
    );
    expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
    expect(compiled.irCompiledFuncs ?? []).not.toContain("test");
  });
});

// The upstream files this change actually flipped, measured file-by-file
// through the same `runTest262File(…, "standalone")` seam the sweep used. All
// five are RED on base. `S11.8.6_A6_T3` is the one that carries the
// position-independence claim for `instanceof Function`: it is the identical
// operand shape to the (green-on-base) unit case above, failing only because the
// module is large enough for the closure-registration order to matter.
const TEST262_ROOT = new URL("../test262", import.meta.url).pathname;
const CORPUS_AVAILABLE = existsSync(join(TEST262_ROOT, "test", "language", "expressions", "instanceof"));
const FLIPPED = [
  ["language/expressions/instanceof/S11.8.6_A6_T3.js", "`MyFunct instanceof Function` / `instanceof Object`"],
  ["built-ins/Object/create/15.2.3.5-2-2.js", "`newObj instanceof Object` on an `Object.create` result"],
  ["built-ins/Object/create/15.2.3.5-4-2.js", "`newObj instanceof Object`, undefined Properties"],
  ["built-ins/Object/create/15.2.3.5-4-4.js", "`this instanceof Object` inside the Properties accessor"],
  ["built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-4-247.js", "`desc instanceof Object`"],
] as const;

const WRAPPER_FLIPPED = [
  "built-ins/Object/create/15.2.3.5-4-7.js",
  "built-ins/Object/create/15.2.3.5-4-8.js",
  "built-ins/Object/create/15.2.3.5-4-9.js",
  "built-ins/Object/defineProperties/15.2.3.7-2-4.js",
  "built-ins/Object/defineProperties/15.2.3.7-2-6.js",
  "built-ins/Object/defineProperties/15.2.3.7-2-8.js",
] as const;

describe.skipIf(!CORPUS_AVAILABLE)("#4276 — the upstream files this flipped (standalone)", () => {
  for (const [rel, what] of FLIPPED) {
    it(`${rel} — ${what}`, async () => {
      const r = await runTest262File(join(TEST262_ROOT, "test", rel), "issue-4276", 120_000, "standalone");
      expect(r.status, `error: ${r.error ?? r.reason ?? ""}`).toBe("pass");
    }, 180_000);
  }
});

describe.skipIf(!CORPUS_AVAILABLE)("#4276 — wrapper accessor files flipped by the internal brand", () => {
  for (const rel of WRAPPER_FLIPPED) {
    it(
      rel,
      async () => {
        const r = await runTest262File(join(TEST262_ROOT, "test", rel), "issue-4276-wrapper", 120_000, "standalone");
        expect(r.status, `error: ${r.error ?? r.reason ?? ""}`).toBe("pass");
      },
      180_000,
    );
  }
});

describe("#4276 — the JS-host lane is untouched", () => {
  // The new lowering is gated on `noJsHost`. The observable proof that the
  // gc/JS-host lane still takes its own path is that it keeps emitting the host
  // predicate for the same source — the same style of assertion
  // `es5-standalone-instanceof.test.ts` uses to prove a rule DECLINED.
  for (const ctor of ["Object", "Function"]) {
    it(`keeps the host \`__instanceof\` import for \`x instanceof ${ctor}\``, async () => {
      const compiled = await compile(
        `var o: any = {};\nexport function test(): number { return (o instanceof ${ctor}) ? 1 : 0; }\n`,
        { allowJs: true, fileName: "host-lane.ts", skipSemanticDiagnostics: true },
      );
      expect(compiled.success, compiled.errors.map((e) => e.message).join("; ")).toBe(true);
      const imports = (compiled.imports ?? []).map((i) => `${i.module}::${i.name}`);
      expect(imports, "the gc/JS-host lane must not take the standalone branch").toContain("env::__instanceof");
    });
  }
});
