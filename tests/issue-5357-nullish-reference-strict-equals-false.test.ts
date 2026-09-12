// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5357 — `x === false` answered TRUE when `x` was a nullish reference.
 *
 * The tail of the externref-equality block in `binary-ops-typed-dispatch.ts`
 * widened the Boolean to `f64`, put the reference through `__unbox_number`
 * (ToNumber: `null → 0`) and compared with `f64.eq` — `Number(null) ===
 * Number(false)`. The arm that implements §7.2.16 step 1 (`__host_eq` in the
 * host lane, the #1776 tag dispatch under native-first) excluded the pair
 * because a Boolean scalar is an `i32` with a Boolean static type. The same
 * collapse made `x === true` answer `true` for an `x` holding the number `1`,
 * and — one step over — `null == false` / `null == 0` answer `true`.
 *
 * Measured on `50c81e5487` with the host-lane probe (dogfood runner, untyped
 * `.js` two-file project): 41/60 rows; with the fix 58/60, the two residuals
 * being a deliberately failing control and a nested `function g(v = undefined)`
 * parameter, which #5221 owns and which the fix leaves exactly as it was.
 * Under `--target standalone` and `native-first` the collapse is never reached
 * (the tag dispatch returns for every externref pair); those lanes only had the
 * `const u = undefined` rows wrong, which is a different defect — `undefined`
 * lowers to an `i32` slot holding 0 — folded here by the #4208 scalar module.
 *
 * Parent-commit counts (`50c81e5487`): 16 failed / 50 passed of 66 — host lane
 * 10 of the 22 rows below, standalone and native-first 3 of 22 each (the three
 * `const u = undefined` rows). With the fix: 66 passed / 66. The `keeps …` rows
 * are the two-sided control:
 * they pass on the parent too and would catch a fix that simply folded every
 * Boolean comparison to `false` — `referenceHoldingTrueIsTrue` in particular
 * pins that the Boolean is boxed by BRAND (`__box_boolean`), because a number
 * box would make `anyBool(true) === true` compare `true` against `1`.
 *
 * Fixtures are untyped `.js` across two modules on purpose: the prettier idiom
 * (`onEnter?.(doc) === false` in `traverseDoc`) has an `any`-typed left
 * operand, which a static fold cannot decide.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compile, compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Values whose static type cannot decide `Type()`: nullish unions and `any`. */
const VALUES_MODULE = `
export function pick(flag) {
  return flag ? null : "x";
}
export function nothing() {}
export function anyOne(flag) {
  return flag ? 1 : "s";
}
export function anyBool(flag) {
  return flag ? true : "s";
}
export function anyStr(flag) {
  return flag ? "0" : 1;
}
export function anyNum(flag) {
  return flag ? 2 : "s";
}
export function anyObj(flag) {
  return flag ? { v: 0 } : "s";
}
/** prettier's traverseDoc gate: the callback arrives as an untyped parameter. */
export function guarded(onEnter) {
  if (onEnter?.(1) === false) return "stopped";
  return "visited";
}
export function paramEq(v) {
  return v === false;
}
`;

const IMPORT_LINE = `import { pick, nothing, anyOne, anyBool, anyStr, anyNum, anyObj, guarded, paramEq } from "./values.js";`;

/**
 * Every probe returns 1/0. `expected` is Node's answer; `parentHost` is what
 * the parent commit answered in the host lane (`null` = already correct).
 */
const ROWS: readonly { name: string; body: string; expected: number; parentHost: number | null }[] = [
  // ── the collapse: a Boolean scalar against a reference ──
  { name: "nullConstIsNotFalse", body: "const n = null; return n === false ? 1 : 0;", expected: 0, parentHost: 1 },
  { name: "nullishUnionCallIsNotFalse", body: "return pick(true) === false ? 1 : 0;", expected: 0, parentHost: 1 },
  { name: "nullishUnionCallIsNotEqualFalse", body: "return pick(true) !== false ? 1 : 0;", expected: 1, parentHost: 0 },
  { name: "referenceHoldingOneIsNotTrue", body: "return anyOne(true) === true ? 1 : 0;", expected: 0, parentHost: 1 },
  {
    name: "traverseVisitsWhenCallbackReturnsNothing",
    body: 'return guarded(() => {}) === "visited" ? 1 : 0;',
    expected: 1,
    parentHost: 0,
  },
  {
    name: "traverseStopsWhenCallbackReturnsFalse",
    body: 'return guarded(() => false) === "stopped" ? 1 : 0;',
    expected: 1,
    parentHost: null,
  },
  // ── `const u = undefined` is an i32 slot holding 0 (separate defect, folded by #4208's module) ──
  {
    name: "undefinedConstIsNotFalse",
    body: "const u = undefined; return u === false ? 1 : 0;",
    expected: 0,
    parentHost: 1,
  },
  { name: "undefinedConstIsNotZero", body: "const u = undefined; return u === 0 ? 1 : 0;", expected: 0, parentHost: 1 },
  {
    name: "undefinedConstLooseFalse",
    body: "const u = undefined; return u == false ? 1 : 0;",
    expected: 0,
    parentHost: 1,
  },
  // ── loose equality: a nullish reference equals only nullish ──
  { name: "nullConstLooseFalse", body: "const n = null; return n == false ? 1 : 0;", expected: 0, parentHost: 1 },
  { name: "nullConstLooseZero", body: "const n = null; return n == 0 ? 1 : 0;", expected: 0, parentHost: 1 },
  // ── keeps: rows that were already right and must stay right ──
  { name: "keepsParameterIsNotFalse", body: "return paramEq(undefined) ? 1 : 0;", expected: 0, parentHost: null },
  {
    name: "keepsReassignedLetIsNotFalse",
    body: 'let v = "s"; v = null; return v === false ? 1 : 0;',
    expected: 0,
    parentHost: null,
  },
  { name: "keepsVoidCallIsNotFalse", body: "return nothing() === false ? 1 : 0;", expected: 0, parentHost: null },
  {
    name: "keepsReferenceHoldingTrueIsTrue",
    body: "return anyBool(true) === true ? 1 : 0;",
    expected: 1,
    parentHost: null,
  },
  {
    name: "keepsReferenceHoldingTrueIsNotFalse",
    body: "return anyBool(true) === false ? 1 : 0;",
    expected: 0,
    parentHost: null,
  },
  { name: "keepsReferenceHoldingTwoIsTwo", body: "return anyNum(true) === 2 ? 1 : 0;", expected: 1, parentHost: null },
  { name: "keepsOneIsNotTrue", body: "return 1 === true ? 1 : 0;", expected: 0, parentHost: null },
  { name: "keepsZeroLooseFalse", body: "const z = 0; return z == false ? 1 : 0;", expected: 1, parentHost: null },
  { name: "keepsStringZeroLooseFalse", body: "return anyStr(true) == false ? 1 : 0;", expected: 1, parentHost: null },
  { name: "keepsObjectLooseZero", body: "return anyObj(true) == 0 ? 1 : 0;", expected: 0, parentHost: null },
  // ── anti-vacuity control ──
  { name: "control", body: "return 3 + 4;", expected: 7, parentHost: null },
];

const PROBES = ROWS.map((row) => `export function ${row.name}() { ${row.body} }`).join("\n");
const NAMES = ROWS.map((row) => row.name);

/**
 * axios's `utils.freezeMethods`, run at module init: `reduceDescriptors` keeps
 * every descriptor whose reducer result is `!== false`. On the parent the
 * reducer's `undefined` collapsed to `0 !== 0`, so every descriptor was dropped
 * and `Object.defineProperties(utils, {})` was a silent no-op. With a correct
 * `!==` the descriptors are applied — and the runtime's #2837 branch (a host
 * descriptor object carrying wasm-closure setters) called the raw
 * `Object.defineProperty` on the compiled `utils` object: "WebAssembly objects
 * are opaque", 12 of axios's 34 unit files dead at module init (200/231 →
 * 73/231). That branch now leaves a WasmGC target to the sidecar path.
 * Parent: module init throws in that branch — the collapse reads this
 * reducer's explicit `undefined` as `NaN !== 0` and keeps the `isFunction`
 * descriptor (axios's bare `return;` is a `ref.null`, `0 !== 0`, dropped) —
 * so both probes fail; codegen fix alone: the same throw; both: 1 / 1.
 */
const FREEZE_MODULE = `
const utils = {
  isFunction(v) {
    return typeof v === "function";
  },
};
function reducer(name) {
  if (name === "arguments" || name === "caller") return false;
  if (name === "marker") return { value: 7, writable: false, enumerable: false, configurable: true };
  return undefined;
}
function reduceDescriptors(obj, names) {
  const reduced = {};
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    let ret;
    if ((ret = reducer(name)) !== false) {
      reduced[name] = ret || {
        set: () => {
          throw new Error("Can not rewrite read-only method '" + name + "'");
        },
        enumerable: false,
        configurable: true,
      };
    }
  }
  Object.defineProperties(obj, reduced);
}
reduceDescriptors(utils, ["arguments", "isFunction", "marker"]);
export function frozenMarkerIsApplied() {
  return utils.marker === 7 ? 1 : 0;
}
export function frozenMethodStillCallable() {
  return utils.isFunction(reducer) ? 1 : 0;
}
`;
const FREEZE_NAMES = ["frozenMarkerIsApplied", "frozenMethodStillCallable"] as const;

function entryFor(module: string, names: readonly string[]): string {
  const wrappers = names.map((name) => `export function via_${name}(): number { return ${name}(); }`);
  return `import { ${[...names].sort().join(", ")} } from "./${module}";\n${wrappers.join("\n")}\n`;
}

const hostProjects = new Map<string, Promise<WebAssembly.Exports>>();
/** Host lane: `compileProject` over an untyped `.js` project. */
function hostLane(
  key: string,
  files: Readonly<Record<string, string>>,
  entryModule: string,
  names: readonly string[],
): Promise<WebAssembly.Exports> {
  let cached = hostProjects.get(key);
  if (cached !== undefined) return cached;
  cached = (async () => {
    const root = mkdtempSync(join(tmpdir(), `js2-5357-${key}-`));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
    writeFileSync(join(root, "entry.ts"), entryFor(entryModule, names));
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
  })();
  hostProjects.set(key, cached);
  return cached;
}

const MATRIX_PROJECT = { "values.js": VALUES_MODULE, "main.js": `${IMPORT_LINE}\n${PROBES}\n` };
const matrixLane = () => hostLane("matrix", MATRIX_PROJECT, "main.js", NAMES);
const freezeLane = () => hostLane("freeze", { "freeze.js": FREEZE_MODULE }, "freeze.js", FREEZE_NAMES);

const SINGLE_FILE = `${VALUES_MODULE.replaceAll("export function", "function")}\n${PROBES}\n`;

const nativeExports = new Map<string, Promise<WebAssembly.Exports>>();
/** Native lanes: the same probes in one untyped file, `standalone` or `native-first`. */
function nativeLane(lane: "standalone" | "native-first"): Promise<WebAssembly.Exports> {
  let cached = nativeExports.get(lane);
  if (cached === undefined) {
    cached = (async () => {
      const result = await compile(SINGLE_FILE, {
        fileName: `issue-5357-${lane}.js`,
        allowJs: true,
        skipSemanticDiagnostics: true,
        ...(lane === "standalone"
          ? { target: "standalone" as const, hostBridge: "always" as const }
          : { semanticProviders: "native-first" as const }),
      });
      expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
      if (lane === "standalone") {
        const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
        return instance.exports;
      }
      const imports = buildCompiledImports(result);
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.setInstance?.(instance);
      return instance.exports;
    })();
    nativeExports.set(lane, cached);
  }
  return cached;
}

describe("#5357 host lane — a Boolean scalar against a reference is compared by ===, not ToNumber", () => {
  for (const row of ROWS) {
    const note = row.parentHost === null ? "" : ` (parent commit: ${row.parentHost})`;
    it(`${row.name} → ${row.expected}${note}`, async () => {
      const exports = await matrixLane();
      expect((exports[`via_${row.name}`] as () => number)()).toBe(row.expected);
    });
  }
});

describe("#5357 host lane — descriptors a correct `!== false` keeps are applied to a compiled object (axios freezeMethods)", () => {
  it("frozenMarkerIsApplied → 1 (parent commit: module init threw)", async () => {
    const exports = await freezeLane();
    expect((exports.via_frozenMarkerIsApplied as () => number)()).toBe(1);
  });

  it("frozenMethodStillCallable → 1", async () => {
    const exports = await freezeLane();
    expect((exports.via_frozenMethodStillCallable as () => number)()).toBe(1);
  });
});

for (const lane of ["standalone", "native-first"] as const) {
  describe(`#5357 ${lane} lane — every row answers as Node does`, () => {
    for (const row of ROWS) {
      it(`${row.name} → ${row.expected}`, async () => {
        const exports = await nativeLane(lane);
        expect((exports[row.name] as () => number)()).toBe(row.expected);
      });
    }
  });
}
