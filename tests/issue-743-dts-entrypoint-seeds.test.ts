// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #743 — `.d.ts` entrypoint seeding.
//
// An exported entrypoint of a JS package has no internal call sites, so both
// inference lanes start it at `unknown`/externref and every chain rooted in
// its parameters bottoms out dynamic. When the package SHIPS declarations
// (acorn's `dist/acorn.d.ts`), the declared parameter types are exactly the
// missing seeds. These tests pin the four contract points:
//
//  1. SEED + COMPOSE — a declared `number` param seeds the IR fixpoint and
//     flows through the #4131 `new F(…)` call-graph edges to a downstream
//     fnctor field slot (and the legacy lane's one-hop forwarding keeps the
//     slot decision in ABI lockstep — no parity demotion).
//  2. CONFLICT — internal call-site evidence disagrees with the `.d.ts` claim
//     → the lattice WIDENS; the claim never beats evidence.
//  3. FLAG OFF — byte-identical output, declarations present or not.
//  4. TRUST BOUNDARY — a genuinely violating external call cannot read
//     garbage: f64 params sit behind the JS API's ToNumber coercion; native
//     string ref params throw TypeError at the boundary (pinned convention).

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { collectDtsEntrypointSeeds } from "../src/checker/dts-entrypoint-seeds.js";
import { fnctorFieldProvenanceRecords, resetFnctorFieldProvenance } from "../src/codegen/fnctor-field-provenance.js";
import { compile } from "../src/index.js";
import { buildIrUnitInventory, type IrUnitId } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext, type IrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildIrUnitTypeMap } from "../src/ir/propagate.js";
import { ts } from "../src/ts-api.js";

const ENV_KEYS = [
  "JS2WASM_DTS_ENTRYPOINT_SEEDS",
  "JS2WASM_FNCTOR_CTOR_PARAM_TYPES",
  "JS2WASM_FNCTOR_FIELD_PROVENANCE",
  // (#743 defaults flip, 2026-08-08) The field-SLOT consumer is the family's
  // one deliberately-excluded sub-lever and is opt-in — see
  // src/derivation-flags.ts. The slot pin below asks for it explicitly.
  "JS2WASM_FNCTOR_CTOR_PARAM_SLOTS",
];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const [key, value] of saved) {
    // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetFnctorFieldProvenance();
});

// ---------------------------------------------------------------------------
// Map-level fixture (mirrors tests/issue-743-ctor-sites-in-fixpoint.test.ts):
// buildIrUnitTypeMap is called directly with the seed map — the env flag gates
// PLUMBING (whether a map exists at all), not this function.
// ---------------------------------------------------------------------------

function fixture(source: string): {
  checker: ts.TypeChecker;
  file: ts.SourceFile;
  context: IrPlanningIdentityContext;
} {
  const files = new Map([
    ["/repo/a.ts", source],
    ["/repo/lib.d.ts", "declare var undefined: undefined;"],
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noImplicitAny: false,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (fileName) => files.has(fileName),
    readFile: (fileName) => files.get(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      return text === undefined
        ? undefined
        : ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(["/repo/a.ts"], options, host);
  const checker = program.getTypeChecker();
  const file = program.getSourceFile("/repo/a.ts")!;
  const inventory = buildIrUnitInventory([file], { checker, entrySource: file });
  return { checker, file, context: buildIrPlanningIdentityContext(inventory) };
}

function unitId(context: IrPlanningIdentityContext, file: ts.SourceFile, name: string): IrUnitId {
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  )!;
  return context.unitIdByDeclaration.get(declaration)!;
}

function seedsFor(dtsText: string, entryFile: ts.SourceFile) {
  const dts = ts.createSourceFile("/repo/pkg.d.ts", dtsText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return collectDtsEntrypointSeeds(dts, entryFile);
}

const hash = (binary: Uint8Array) => createHash("sha256").update(binary).digest("hex");

// Entry whose exported entrypoint forwards its param through an untyped
// helper into a fnctor ctor — the acorn shape, minus the property-call break.
const COMPOSE_ENTRY = `
function Thing(x) { this.val = x; }
function mk(v) { return new Thing(v); }
function enter(n) { return mk(n).val; }
export { enter };
`;
const COMPOSE_DTS = "export function enter(n: number): number\n";

describe("#743 — .d.ts entrypoint seeds in the IR fixpoint (map level)", () => {
  it("seeds an exported implicit-any param from the declaration and composes with the ctor-edge fixpoint", () => {
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "1"; // read by buildCallGraph's new-edge arm
    const { checker, file, context } = fixture(COMPOSE_ENTRY);
    const seeds = seedsFor(COMPOSE_DTS, file);
    expect(seeds?.get("enter")).toEqual(["f64"]);

    const unseeded = buildIrUnitTypeMap([file], checker, context);
    expect(unseeded.get(unitId(context, file, "enter"))?.params).toEqual([{ kind: "unknown" }]);

    const map = buildIrUnitTypeMap([file], checker, context, seeds);
    // The entrypoint takes the declared seed…
    expect(map.get(unitId(context, file, "enter"))?.params).toEqual([{ kind: "f64" }]);
    // …and the fixpoint carries it TWO hops (identifier call + #4131 new-edge)
    // into the fnctor's ctor param — the propagation the census starves for.
    expect(map.get(unitId(context, file, "mk"))?.params).toEqual([{ kind: "f64" }]);
    expect(map.get(unitId(context, file, "Thing"))?.params).toEqual([{ kind: "f64" }]);
  });

  it("widens when an internal call site disagrees with the .d.ts — evidence beats the claim", () => {
    const { checker, file, context } = fixture(`
      function enter(n) { return n; }
      function other() { return enter("s"); }
      export { enter, other };
    `);
    const seeds = seedsFor("export function enter(n: number): number\n", file);
    const map = buildIrUnitTypeMap([file], checker, context, seeds);
    const param = map.get(unitId(context, file, "enter"))?.params[0];
    // The internal string call site must widen the seeded f64 claim; the exact
    // widened shape (union/dynamic) is the lattice's business — the assertion
    // is only that the .d.ts claim did NOT win.
    expect(param).not.toEqual({ kind: "f64" });
  });

  it("does not seed positions the declaration cannot vouch for", () => {
    const { file } = fixture(COMPOSE_ENTRY);
    const seeds = seedsFor(
      [
        "export interface Options { x: number }",
        "export function enter(n: Options): number", // interface → unseedable
      ].join("\n"),
      file,
    );
    // The lone param is unseedable → the whole entry drops out.
    expect(seeds).toBeUndefined();
  });

  it("only seeds functions the entry module actually exports", () => {
    const { file } = fixture(`
      function hidden(n) { return n; }
      export function shown(n) { return hidden(n); }
    `);
    const seeds = seedsFor(
      ["export function hidden(n: number): number", "export function shown(n: number): number"].join("\n"),
      file,
    );
    expect(seeds?.has("shown")).toBe(true);
    expect(seeds?.has("hidden")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End-to-end (compile()): flag gating, byte identity, field-slot narrowing,
// ABI parity, and the trust-boundary guard.
// ---------------------------------------------------------------------------

const E2E_ENTRY = `
function Thing(x) { this.val = x; }
function enter(n) { return new Thing(n).val; }
function greet(s) { return s.length; }
export { enter, greet };
`;
const E2E_DTS = ["export function enter(n: number): number", "export function greet(s: string): number"].join("\n");

async function compileE2E(withDts: boolean) {
  const result = await compile(E2E_ENTRY, {
    fileName: "pkg.mjs",
    target: "standalone",
    ...(withDts ? { entryDeclarations: E2E_DTS } : {}),
  });
  expect(result.success).toBe(true);
  expect(result.binary).toBeDefined();
  return result;
}

describe("#743 — .d.ts entrypoint seeds end-to-end", () => {
  // (#743 defaults flip, 2026-08-08) OFF is now a SPELLING, not the absence of
  // one. This test used to establish its baseline by DELETING the variable;
  // after the flip that arm compiles with seeding ON, so a supplied-`.d.ts`
  // compile would be compared against an already-seeded baseline and the
  // byte-identity assertion would pass for the wrong reason.
  it("flag off (explicit 0/off): byte-identical whether declarations are supplied or not", async () => {
    process.env.JS2WASM_DTS_ENTRYPOINT_SEEDS = "0";
    const bare = await compileE2E(false);
    const withDts = await compileE2E(true);
    process.env.JS2WASM_DTS_ENTRYPOINT_SEEDS = "off";
    const wordOff = await compileE2E(true);
    expect(hash(withDts.binary!)).toBe(hash(bare.binary!));
    expect(hash(wordOff.binary!)).toBe(hash(bare.binary!));
  });

  it("flag on: seeds narrow the downstream fnctor field slot with NO parity demotion", async () => {
    process.env.JS2WASM_DTS_ENTRYPOINT_SEEDS = "1";
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "1";
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_SLOTS = "1";
    process.env.JS2WASM_FNCTOR_FIELD_PROVENANCE = "1";
    resetFnctorFieldProvenance();
    const seeded = await compileE2E(true);
    // The declared `n: number` reaches `this.val = x` through `new Thing(n)`:
    // the field slot is a machine f64, not a boxed externref. Both lanes made
    // the same call (seed + one-hop forwarding vs fixpoint), so no function
    // demoted through the typeIdx parity fallback.
    const record = fnctorFieldProvenanceRecords().find((r) => r.owner === "Thing" && r.field === "val");
    expect(record?.slot).toBe("f64");
    const parity = (seeded.errors ?? []).filter((e) => String(e.message).includes("parity mismatch"));
    expect(parity).toEqual([]);
  });

  it("flag on without declarations: byte-identical to baseline (no declarations → no behavior change)", async () => {
    // Baseline must be explicit-OFF: post-flip, unset would BE the flag-on arm
    // and this test would compare a compile against itself.
    process.env.JS2WASM_DTS_ENTRYPOINT_SEEDS = "0";
    const bare = await compileE2E(false);
    process.env.JS2WASM_DTS_ENTRYPOINT_SEEDS = "1";
    const flagOnNoDts = await compileE2E(false);
    expect(hash(flagOnNoDts.binary!)).toBe(hash(bare.binary!));
  });

  it("trust boundary: a violating external call coerces (f64) or throws (native string) — never reads garbage", async () => {
    process.env.JS2WASM_DTS_ENTRYPOINT_SEEDS = "1";
    process.env.JS2WASM_FNCTOR_CTOR_PARAM_TYPES = "1";
    const seeded = await compileE2E(true);
    const { instance } = await WebAssembly.instantiate(seeded.binary!, {});
    const exports = instance.exports as Record<string, CallableFunction>;
    // Honest callers work.
    expect(exports.enter(5)).toBe(5);
    // f64 claim violated → the JS API's ToNumber boundary coercion (the same
    // convention as a TS-annotated `n: number` export): "7" crosses as 7. An
    // unconvertible object crosses as NaN — the callee can NEVER observe the
    // raw reference (the result here is the module's own boxed-NaN carrier, an
    // opaque wasm struct, so identity is the honest observable: what comes
    // back is not, and cannot be, the passed-in object).
    expect(exports.enter("7")).toBe(7);
    const violating = { poison: true };
    // (Compared via Object.is: the returned box is an opaque WasmGC object
    // that vitest's matcher printer cannot introspect.)
    const returned: unknown = exports.enter(violating);
    expect(Object.is(returned, violating)).toBe(false);
    // string claim violated → the typed-ref export boundary REJECTS the call
    // outright (TypeError) — the body never runs, nothing is reinterpreted.
    expect(() => exports.greet(123)).toThrow(TypeError);
  });

  it("conflicting internal evidence keeps runtime semantics: claim never overrides a string call site", async () => {
    process.env.JS2WASM_DTS_ENTRYPOINT_SEEDS = "1";
    const result = await compile(
      `
      function ident(v) { return v; }
      function fromInside() { return ident("evidence").length; }
      export { ident, fromInside };
      `,
      {
        fileName: "pkg.mjs",
        target: "standalone",
        entryDeclarations: "export function ident(v: number): number\n",
      },
    );
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary!, {});
    const exports = instance.exports as Record<string, CallableFunction>;
    // The internal call site's string evidence governs — the f64 claim did not
    // force a numeric ABI that would mangle the internal caller's string.
    expect(exports.fromInside()).toBe(8);
  });
});
