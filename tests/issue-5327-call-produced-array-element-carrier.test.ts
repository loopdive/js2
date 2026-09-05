// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5327 — an unannotated array literal whose element zero came from a
 * CALL kept that call's exact closed WasmGC struct as the vec's element type,
 * and every later element was guard-cast into it.
 *
 * #4289 already proved this for the OBJECT-LITERAL spelling
 * (`[{a: …}, {d: …}]`). Its guard bailed out on the first line whenever element
 * zero was not literally an object literal — which is the spelling real code
 * uses: `[group(doc), ifBreak(doc)]`.
 *
 * When the later element's struct shares no field layout with element zero's,
 * the coercion can only emit `ref.test` → `ref.null` → `ref.as_non_null`, which
 * TRAPS with "dereferencing a null pointer" while the module is still
 * initialising. Measured on prettier@3.8.1: the whole of
 * `tests/unit/doc-builders.js` died at module init, 0/46.
 *
 * A struct that genuinely INHABITS element zero's carrier through the declared
 * supertype chain is left alone — `[new Shape(), new Circle()]` keeps its
 * closed `$Shape` vec, which is what #2021's subclass-ordering fix relies on.
 *
 * DELIBERATELY NOT COVERED: the superset-of-field-names shape
 * (`[group(doc), align(n, doc)]`). It never trapped, and it is still lossy
 * AFTER this fix — the array literal now stores the full struct, but the
 * binding's own slot type is keyed to TypeScript's best-common-supertype
 * inference (`{type, contents}[]`) and the store into it re-projects `n` away.
 * The last case below pins that limitation so a future binding-slot fix has a
 * failing anchor rather than a silent behaviour change.
 *
 * The fixture is untyped `.js` behind a two-file project on purpose. Annotating
 * the values `: any` routes the literal through a different arm and the test
 * then passes identically with and without the fix.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * Element zero is `group(...)` — a call, not an object literal — so #4289's
 * guard never looked at element one. `ifBreak` returns a struct with two keys
 * `group`'s struct has no slot for, so the guard-cast can only produce null.
 */
const TRAP_MODULE = `
function group(contents) {
  return { type: "group", contents: contents };
}
function ifBreak(breakContents, flatContents) {
  return { type: "if-break", breakContents: breakContents, flatContents: flatContents };
}

var docs = [group("g"), ifBreak("bb", "fff")];

export function count() {
  return docs.length;
}
export function headContentsLength() {
  return String(docs[0].contents).length;
}
export function tailFlatLength() {
  return String(docs[1].flatContents).length;
}
export function tailBreakLength() {
  return String(docs[1].breakContents).length;
}
`;

/**
 * The quiet twin. `align`'s struct is a strict superset of `group`'s by NAME,
 * so the coercion succeeds by re-projecting `type` and `contents` — and `n`,
 * the one field that only `align` has, is dropped without a word.
 */
const NARROWING_MODULE = `
function group(contents) {
  return { type: "group", contents: contents };
}
function align(width, contents) {
  return { type: "align", n: width, contents: contents };
}
function readKey(doc, key) {
  return doc[key];
}

var docs = [group("g"), align(41, "aa")];

export function tailKeyCount() {
  return Object.keys(docs[1]).length;
}
export function tailWidth() {
  return readKey(docs[1], "n");
}
export function tailContentsLength() {
  return String(docs[1].contents).length;
}
export function headContentsLength() {
  return String(docs[0].contents).length;
}
`;

/**
 * Guards. A homogeneous call-produced array and a subclass element must keep
 * their closed carrier and their behaviour — they pass on the parent commit
 * too, and fail if the widening is applied too eagerly.
 */
const GUARD_MODULE = `
function group(contents) {
  return { type: "group", contents: contents };
}

class Shape {
  constructor(kind) {
    this.kind = kind;
  }
}
class Circle extends Shape {
  constructor(kind, radius) {
    super(kind);
    this.radius = radius;
  }
}

var homogeneous = [group("g"), group("hh")];
var shapes = [new Shape(3), new Circle(4, 9)];

export function homogeneousTailLength() {
  return String(homogeneous[1].contents).length;
}
export function homogeneousHeadLength() {
  return String(homogeneous[0].contents).length;
}
export function shapeKindSum() {
  return shapes[0].kind + shapes[1].kind;
}
`;

function entryFor(names: readonly string[]): string {
  const imports = `import { ${[...names].sort().join(", ")} } from "./mod.js";`;
  const wrappers = names.map((name) => `export function via_${name}(): number { return ${name}(); }`);
  return `${imports}\n${wrappers.join("\n")}\n`;
}

async function instantiate(moduleSource: string, names: readonly string[]): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-5327-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), entryFor(names));
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const call = (exports: WebAssembly.Exports, name: string): number => (exports[`via_${name}`] as () => number)();

describe("#5327 a call-produced element zero does not key the whole array literal", () => {
  it("builds an array whose later element has disjoint fields without trapping", async () => {
    // Parent commit: `__module_init` traps with "dereferencing a null pointer".
    const exports = await instantiate(TRAP_MODULE, [
      "count",
      "headContentsLength",
      "tailFlatLength",
      "tailBreakLength",
    ]);
    expect(call(exports, "count")).toBe(2);
  });

  it("preserves both elements' own fields after widening the carrier", async () => {
    const exports = await instantiate(TRAP_MODULE, [
      "count",
      "headContentsLength",
      "tailFlatLength",
      "tailBreakLength",
    ]);
    expect(call(exports, "headContentsLength")).toBe(1);
    expect(call(exports, "tailBreakLength")).toBe(2);
    expect(call(exports, "tailFlatLength")).toBe(3);
  });

  it("keeps the shared fields of a wider later element intact", async () => {
    const exports = await instantiate(NARROWING_MODULE, [
      "tailKeyCount",
      "tailWidth",
      "tailContentsLength",
      "headContentsLength",
    ]);
    expect(call(exports, "headContentsLength")).toBe(1);
    expect(call(exports, "tailContentsLength")).toBe(2);
  });

  it("still loses a superset-only field through the binding slot (known limitation)", async () => {
    // Both arms answer this identically — the loss is the binding's slot type,
    // not the literal's element carrier. Read `n` through an untyped
    // `doc[key]`: TypeScript infers `docs` as `{type, contents}[]`, so a STATIC
    // `docs[1].n` is unobservable either way. Flip these to 3 / 41 when the
    // binding-slot narrowing is fixed.
    const exports = await instantiate(NARROWING_MODULE, [
      "tailKeyCount",
      "tailWidth",
      "tailContentsLength",
      "headContentsLength",
    ]);
    expect(call(exports, "tailKeyCount")).toBe(2);
    expect(call(exports, "tailWidth")).toBeNaN();
  });

  it("leaves a homogeneous call-produced array and a subclass element alone", async () => {
    const exports = await instantiate(GUARD_MODULE, ["homogeneousHeadLength", "homogeneousTailLength", "shapeKindSum"]);
    expect(call(exports, "homogeneousHeadLength")).toBe(1);
    expect(call(exports, "homogeneousTailLength")).toBe(2);
    expect(call(exports, "shapeKindSum")).toBe(7);
  });
});
