// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3520 W1-G cluster C row 15 — an implicit derived constructor is lowered from
// a factory-synthesised `ConstructorDeclaration` whose parameters have no
// `parent`. `effectiveIrParamTypeNode` (`src/ir/select.ts`) used to fall
// straight through to `ts.getJSDocType`, which walks `param.parent` and threw
// `Cannot read properties of undefined (reading 'kind')` — an
// `unexpected-internal-throw` invariant (a hard compile error, not a demote).
//
// The trigger is a conjunction, which is why it hid: the class must be derived,
// have NO explicit constructor, have at least one OWN instance field
// initializer, and its parent constructor must take at least one parameter.
// Drop the own field and `IrUnitInventoryBuilder` registers the implicit
// constructor as a SUPPORT unit rather than a terminal (`src/ir/identity.ts`,
// the `!hasExecutableConstructor && firstInstanceInitializer` gate), so the
// synthesiser is never reached at all.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

type Lane = { readonly name: string; readonly options: Record<string, unknown> };

// Both production lowering lanes: the JS-host WasmGC lane and standalone.
// The regime is selected by `target`, NOT by a `standalone: true` boolean —
// that name is declared `never` (#86) precisely because it was silently ignored
// and produced vacuous "standalone" lanes that were really a second gc lane.
const LANES: readonly Lane[] = [
  { name: "gc", options: {} },
  { name: "standalone", options: { target: "standalone" } },
];

interface UnitRow {
  readonly displayName: string;
  readonly kind: string;
  readonly code?: string;
  readonly terminal: string;
}

/** Compile through the production `generateModule` seam and read the IR ledger. */
function compileUnits(source: string, file: string, lane: Lane): { hardErrors: string[]; units: UnitRow[] } {
  const ast = analyzeSource(source, file);
  const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true, ...lane.options });
  const hardErrors = result.errors.filter((error) => error.severity !== "warning").map((error) => error.message);
  const units = (result.irOutcomes ?? []).map((outcome) => ({
    displayName: outcome.displayName,
    kind: outcome.kind,
    code: (outcome as { code?: string }).code,
    // The terminal kind is the second-to-last colon-separated field of the unit id.
    terminal:
      String(outcome.unitId ?? "")
        .split(":")
        .slice(-2, -1)[0] ?? "",
  }));
  return { hardErrors, units };
}

function unit(units: UnitRow[], displayName: string): UnitRow | undefined {
  return units.find((row) => row.displayName === displayName);
}

/** Run `main()` from the compiled module on the JS-host lane. */
async function runtimeMain(source: string): Promise<unknown> {
  const compiled = await compile(source, { experimentalIR: true });
  expect(compiled.success, compiled.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(compiled.imports, ENV_STUB, compiled.stringPool);
  const { instance } = await WebAssembly.instantiate(compiled.binary, {
    env: imports.env,
    "wasm:js-string": imports["wasm:js-string"],
    string_constants: imports.string_constants,
    string_constants16: imports.string_constants16,
  });
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports.main as () => unknown)();
}

// Row a — the minimal trigger.
const MINIMAL = `
class Base {
  value: number;
  constructor(value: number) { this.value = value; }
}
class Child extends Base {
  extra: number = 2;
  sum(): number { return this.value + this.extra; }
}
export function main(): number { return new Child(7).sum(); }
`;

// Row b — the fixture from tests/issue-3520-type-class-abi.test.ts (string field,
// `super.read()`), which this defect was originally observed through.
const TYPE_CLASS_ABI = `
class Base {
  value: number;
  constructor(value: number) { this.value = value; }
  read(): number { return this.value; }
}
class Child extends Base {
  label: string = "child";
  read(): number { return super.read() + this.label.length; }
}
export function main(): number { return new Child(7).read(); }
`;

// Row c — two parent constructor params of different types. Both synthetic
// params must take their type from `paramTypeOverrides`, including the `string`.
const TWO_PARAMS = `
class Base {
  n: number;
  s: string;
  constructor(n: number, s: string) { this.n = n; this.s = s; }
}
class Child extends Base {
  extra: number = 3;
  sum(): number { return this.n + this.s.length + this.extra; }
}
export function main(): number { return new Child(7, "ab").sum(); }
`;

// Row d — parent constructor with ZERO params. The implicit ctor is still a
// terminal (the own field promotes it), but `parameters` is empty, so the
// synthetic-param path is never entered. Pins that the fix is not needed here.
const ZERO_PARAMS = `
class Base {
  value: number;
  constructor() { this.value = 5; }
}
class Child extends Base {
  extra: number = 2;
  sum(): number { return this.value + this.extra; }
}
export function main(): number { return new Child().sum(); }
`;

// Row e — explicit derived constructor with an own field. Its parameters are
// real AST nodes with parents; unchanged by the fix.
const EXPLICIT_CTOR = `
class Base {
  value: number;
  constructor(value: number) { this.value = value; }
}
class Child extends Base {
  extra: number;
  constructor(v: number) { super(v); this.extra = 2; }
  sum(): number { return this.value + this.extra; }
}
export function main(): number { return new Child(7).sum(); }
`;

// Row f — a JavaScript source whose function carries a real `@param {number}`
// JSDoc annotation. The guard must be narrower than "skip JSDoc": for a real
// (parented) node `ts.getJSDocType` must still be consulted, otherwise the
// JavaScript typing path in `effectiveIrParamTypeNode` silently stops working.
const JSDOC_JS = `
/**
 * @param {number} v
 * @returns {number}
 */
export function scale(v) {
  return v * 3;
}
export function main() { return scale(4); }
`;

// The derived class with NO own field: the implicit constructor is registered as
// a SUPPORT unit, never a terminal, so no \`Child_new\` row exists at all.
const NO_OWN_FIELD = `
class Base {
  value: number;
  constructor(value: number) { this.value = value; }
}
class Child extends Base {
  read(): number { return this.value; }
}
export function main(): number { return new Child(7).read(); }
`;

describe("#3520 implicit derived constructor over a synthetic parameter", () => {
  describe.each(LANES)("lane $name", (lane) => {
    it("row a — lowers the minimal trigger without a hard error", () => {
      const { hardErrors, units } = compileUnits(MINIMAL, "minimal.ts", lane);
      expect(hardErrors, hardErrors.join("\n")).toEqual([]);

      const child = unit(units, "Child_new");
      expect(child, `no Child_new row: ${units.map((row) => row.displayName).join(", ")}`).toBeDefined();
      expect(child!.terminal).toBe("class-implicit-constructor");
      expect(child!.kind).toBe("emitted");

      // The sibling method was sealed by the throwing constructor before the fix.
      expect(unit(units, "Child_sum")?.kind).toBe("emitted");
      expect(unit(units, "Base_new")?.kind).toBe("emitted");
    });

    it("row b — lowers the type-class-abi fixture without a hard error", () => {
      const { hardErrors, units } = compileUnits(TYPE_CLASS_ABI, "type-class-abi.ts", lane);
      expect(hardErrors, hardErrors.join("\n")).toEqual([]);

      const child = unit(units, "Child_new");
      expect(child, `no Child_new row: ${units.map((row) => row.displayName).join(", ")}`).toBeDefined();
      expect(child!.terminal).toBe("class-implicit-constructor");
      expect(child!.kind).toBe("emitted");
      expect(unit(units, "Child_read")?.kind).toBe("emitted");
      expect(unit(units, "Base_read")?.kind).toBe("emitted");
    });

    it("row c — types both synthetic params of a two-param parent from the override", () => {
      const { hardErrors, units } = compileUnits(TWO_PARAMS, "two-params.ts", lane);
      expect(hardErrors, hardErrors.join("\n")).toEqual([]);

      const child = unit(units, "Child_new");
      expect(child, `no Child_new row: ${units.map((row) => row.displayName).join(", ")}`).toBeDefined();
      expect(child!.terminal).toBe("class-implicit-constructor");
      expect(child!.kind).toBe("emitted");
      expect(unit(units, "Child_sum")?.kind).toBe("emitted");
    });

    it("row d — a zero-param parent ctor still lowers (no synthetic param at all)", () => {
      const { hardErrors, units } = compileUnits(ZERO_PARAMS, "zero-params.ts", lane);
      expect(hardErrors, hardErrors.join("\n")).toEqual([]);

      const child = unit(units, "Child_new");
      expect(child).toBeDefined();
      expect(child!.terminal).toBe("class-implicit-constructor");
      expect(child!.kind).toBe("emitted");
    });

    it("row e — an explicit derived ctor is unchanged", () => {
      const { hardErrors, units } = compileUnits(EXPLICIT_CTOR, "explicit-ctor.ts", lane);
      expect(hardErrors, hardErrors.join("\n")).toEqual([]);

      const child = unit(units, "Child_new");
      expect(child).toBeDefined();
      // An explicit ctor is a `class-constructor`, NOT `class-implicit-constructor`.
      expect(child!.terminal).toBe("class-constructor");
      expect(child!.kind).toBe("emitted");
    });

    it("row f — a real parented node still consults its `@param` JSDoc", () => {
      const { hardErrors, units } = compileUnits(JSDOC_JS, "jsdoc.js", lane);
      expect(hardErrors, hardErrors.join("\n")).toEqual([]);

      // The JSDoc-typed function must still be an emitted IR terminal. Were the
      // guard widened to "synthetic-or-not, skip JSDoc", `v` would resolve as
      // untyped and this row would stop being emitted.
      expect(unit(units, "scale")?.kind).toBe("emitted");
      expect(unit(units, "main")?.kind).toBe("emitted");
    });

    it("registers the no-own-field implicit ctor as a support unit, not a terminal", () => {
      const { hardErrors, units } = compileUnits(NO_OWN_FIELD, "no-own-field.ts", lane);
      expect(hardErrors, hardErrors.join("\n")).toEqual([]);

      // No `Child_new` ledger row at all: the unit exists in the inventory as a
      // SUPPORT unit (identity.ts's `!hasExecutableConstructor &&
      // firstInstanceInitializer` gate promotes to terminal only with an own
      // field initializer), and only terminals are lowered. This is why the
      // defect needed an own field to reproduce.
      expect(unit(units, "Child_new")).toBeUndefined();
      expect(unit(units, "Child_read")?.kind).toBe("emitted");
    });
  });

  it("row a — runtime result matches the JavaScript semantics", async () => {
    expect(await runtimeMain(MINIMAL)).toBe(9);
  });

  it("row b — runtime result matches the JavaScript semantics", async () => {
    expect(await runtimeMain(TYPE_CLASS_ABI)).toBe(12);
  });

  it("row c — runtime result matches the JavaScript semantics", async () => {
    expect(await runtimeMain(TWO_PARAMS)).toBe(12);
  });

  it("row d — runtime result matches the JavaScript semantics", async () => {
    expect(await runtimeMain(ZERO_PARAMS)).toBe(7);
  });

  it("row e — runtime result matches the JavaScript semantics", async () => {
    expect(await runtimeMain(EXPLICIT_CTOR)).toBe(9);
  });
});
