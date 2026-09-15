// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6491 (#5383 S26) — a heterogeneous ARRAY LITERAL traps at CONSTRUCTION under
// `--target standalone`.
//
// WHY THIS REDUCTION EXISTS. `compileArrayLiteral` keys the vec to element
// zero's carrier and guard-casts every later element into it. When element zero
// is an identifier bound to an OBJECT, its carrier is a closed `$__anon_N`
// struct — and a sibling that is not a struct at all (a native string, a
// number, a boolean, a nested vec) can only be guard-cast to `ref.null`, which
// the non-nullable element slot then hits with `ref.as_non_null`:
//
//     const obj = { year: -271821, month: 4, day: 18 };
//     [obj, "str"].length     // RuntimeError: dereferencing a null pointer
//
// `.length` is enough. The value is never read; the trap is in the literal's
// own `array.new_fixed`, so every later use of the array is unreachable.
//
// #4289/#5327's `hasIncompatibleElementCarrier` names this case and declines it
// ("a string / number / vec element is another widening's business"). There was
// no other widening. `hasNonStructElementForStructCarrier` is it.
//
// THE SPELLING TRAP, and why each case below is written the way it is: the
// INLINE spelling `[{ year: 1 }, "str"]` already widened on the base tree,
// because the first-object arm of the #4289 proof rejects any non-object
// sibling outright. A witness written that way asserts nothing. Element zero
// must arrive as an IDENTIFIER bound to an object literal — the spelling
// test262's wrong-type tables actually use
// (`[tooEarly, "-271821-04-18"]` in `Temporal/PlainDate/from/limits.js`).
//
// Every expectation below was measured on BOTH trees by file-copy revert of
// `src/codegen/struct-carrier-inhabits.ts` and `src/codegen/literals.ts`
// (`.tmp/s26base/`); the base-tree answer is recorded inline on each one.
//
// Host-free: `hostBridge: "off"` plus an EMPTY import object, so a leaked host
// import fails the test instead of being papered over.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

const SINGLE = {
  ...STANDALONE,
  fileName: "/p.ts",
  allowJs: true,
  skipSemanticDiagnostics: true,
};

/**
 * Compile `expression` standalone, instantiate with an EMPTY import object, and
 * read the string it produced back one char code at a time. A wasm TRAP escapes
 * as a thrown `RuntimeError`, which is exactly what the base tree does here —
 * so the cases catch it and answer `"!trap"` rather than failing the harness.
 */
async function runStandaloneString(expression: string): Promise<string> {
  const source = `let __s = "";
    export function prepare() { try { __s = "" + (${expression}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }
    export function at(i) { return __s.charCodeAt(i); }`;
  const result = await compile(source, SINGLE);
  if (!result.success) return `!compile ${result.errors?.[0]?.message ?? ""}`;
  let instance: WebAssembly.Instance;
  try {
    const module = await WebAssembly.compile(result.binary as Uint8Array);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    instance = await WebAssembly.instantiate(module, {});
  } catch (error) {
    // An INVALID module is a distinct, worse failure mode than a trap and must
    // not be reported as one (two of the residuals in #6491 are invalid
    // modules, and they would otherwise read as "trap" here).
    return `!invalid ${String((error as Error)?.message ?? error).slice(0, 80)}`;
  }
  const exports = instance.exports as { prepare: () => number; at: (i: number) => number };
  let length: number;
  try {
    length = exports.prepare();
  } catch (error) {
    return `!trap ${String((error as Error)?.message ?? error).slice(0, 60)}`;
  }
  let out = "";
  for (let index = 0; index < length; index++) out += String.fromCharCode(exports.at(index));
  return out;
}

const OBJ = `const obj = { year: -271821, month: 4, day: 18 };`;

describe("#6491 heterogeneous array literal, standalone — single module", () => {
  it("constructs a literal whose siblings are not structs at all (base tree: every one traps)", async () => {
    // Base tree, measured: "!trap dereferencing a null pointer" for all four.
    expect(await runStandaloneString(`(() => { ${OBJ} return [obj, "str"].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { ${OBJ} return [obj, 1].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { ${OBJ} return [obj, true].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { ${OBJ} return [obj, [1, 2]].length; })()`)).toBe("2");
  });

  it("reads every element back with its own type — the widening is not a trap traded for a wrong value", async () => {
    // TEETH, and the reason this `it` is separate: a widening that merely stops
    // the trap could still answer `undefined` per element. Base tree: both
    // "!trap dereferencing a null pointer".
    expect(
      await runStandaloneString(
        `(() => { ${OBJ} let s = ""; for (const v of [obj, "str"]) s += typeof v; return s; })()`,
      ),
    ).toBe("objectstring");
    expect(await runStandaloneString(`(() => { ${OBJ} return [obj, "str"].map((v) => typeof v).join("|"); })()`)).toBe(
      "object|string",
    );
  });

  it("leaves every literal that already worked exactly as it was", async () => {
    // CONTROLS. All of these answered "2" on the base tree too — a widening
    // that fires wrongly costs the closed-struct vec its representation, which
    // is a performance and a `#2021` correctness hazard, not a free win.
    expect(await runStandaloneString(`(() => { ${OBJ} return ["str", obj].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { ${OBJ} return [obj, undefined].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { ${OBJ} return [obj, null].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { return [{ a: 1 }, "s"].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { ${OBJ} return [obj, obj].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { return ["a", "b"].length; })()`)).toBe("2");
    expect(await runStandaloneString(`(() => { return [1, 2].length; })()`)).toBe("2");
    // The declared-supertype case #2021 relies on: a subclass-first literal must
    // KEEP its closed vec and still read both elements back.
    expect(
      await runStandaloneString(
        `(() => { class Shape { constructor() { this.n = 1; } } class Circle extends Shape { constructor() { super(); this.n = 2; } }
          const a = [new Circle(), new Shape()]; return a[0].n + "," + a[1].n; })()`,
      ),
    ).toBe("2,1");
  });
});

async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-6491-"));
  const packageRoot = join(root, "node_modules", "ns6491");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6491", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6491";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns6491")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const consumerEntry = "/__main.js";
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]: `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumer}`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

const PROVIDER = `
  export const NS = Object.freeze({
    __proto__: null,
    mk: (y) => ({ y: y }),
    tag: "prov",
  });`;

// Numbers, because a standalone module's string is a WasmGC array the host
// cannot decode — every comparison happens INSIDE the module. -1 = the literal
// trapped (the base-tree answer), and the trap escapes the export.
const CONSUMER = `
  const local = { year: 1, month: 2, day: 3 };
  // TEETH. The literal is CONSUMER-local, but it is compiled in a module that
  // also links a provider — the widening must survive the linked build, where
  // the rec group and the type indices are not the single-module ones.
  // Base tree: traps (RuntimeError escapes this export).
  export function mixedLocal() { return [local, "str"].length; }
  export function mixedLocalTypes() {
    let n = 0;
    for (const v of [local, "str"]) n += typeof v === "string" ? 10 : 1;
    return n;
  }
  // CONTROL, and labelled as one deliberately: a PROVIDER-built object crosses
  // the link as \`externref\`, which this predicate skips by construction, so the
  // dynamic widenings already owned it. Base tree: 2 — this must not move.
  export function mixedForeign() { return [NS.mk(1), "str"].length; }
  export function foreignTypes() {
    let n = 0;
    for (const v of [NS.mk(1), "str"]) n += typeof v === "string" ? 10 : 1;
    return n;
  }`;

describe("#6491 heterogeneous array literal, standalone — linked pair", () => {
  it("widens a consumer-local mixed literal in a LINKED build, and leaves the foreign-element control alone", async () => {
    const exports = await linkedPair(PROVIDER, CONSUMER);
    // The CONTROL runs FIRST, deliberately: an expectation placed after a
    // failing one is never reached on the base tree, so its "base tree: …" note
    // would be inference rather than a measurement (the #6490 discipline
    // point). Measured on base: 2 and 11 — this pair does not move.
    expect(exports.mixedForeign!()).toBe(2);
    expect(exports.foreignTypes!()).toBe(11);
    // TEETH. Measured on base: both threw RuntimeError "dereferencing a null
    // pointer" from `mixedLocal`.
    expect(exports.mixedLocal!()).toBe(2);
    expect(exports.mixedLocalTypes!()).toBe(11);
  });
});
