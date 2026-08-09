import { afterEach, describe, expect, it } from "vitest";
import type { ImportDescriptor } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const manifest: ImportDescriptor[] = [
  {
    module: "env",
    name: "__get_undefined",
    kind: "func",
    intent: { type: "builtin", name: "__get_undefined" },
    paramCount: 0,
  },
  {
    module: "env",
    name: "__box_number",
    kind: "func",
    intent: { type: "box", targetType: "number" },
    paramCount: 1,
  },
  {
    module: "env",
    name: "__box_boolean",
    kind: "func",
    intent: { type: "box", targetType: "boolean" },
    paramCount: 1,
  },
  {
    module: "env",
    name: "__typeof_number",
    kind: "func",
    intent: { type: "typeof_check", targetType: "number" },
    paramCount: 1,
  },
  {
    module: "env",
    name: "__is_truthy",
    kind: "func",
    intent: { type: "truthy_check" },
    paramCount: 1,
  },
];

const previousSwitch = process.env.JS2WASM_FAST_LEAF_HOST_IMPORTS;

afterEach(() => {
  if (previousSwitch === undefined) {
    Reflect.deleteProperty(process.env, "JS2WASM_FAST_LEAF_HOST_IMPORTS");
  } else {
    process.env.JS2WASM_FAST_LEAF_HOST_IMPORTS = previousSwitch;
  }
});

function exercise(flag: "0" | "1") {
  process.env.JS2WASM_FAST_LEAF_HOST_IMPORTS = flag;
  const imports = buildImports(manifest);
  expect(imports.env.__get_undefined.length).toBe(0);
  expect(imports.env.__box_number.length).toBe(1);
  expect(imports.env.__box_boolean.length).toBe(1);
  expect(imports.env.__typeof_number.length).toBe(1);
  expect(imports.env.__is_truthy.length).toBe(1);

  imports.startImportCounting?.();
  const values = {
    undefined: imports.env.__get_undefined(),
    number: imports.env.__box_number(42.5),
    booleanFalse: imports.env.__box_boolean(0),
    booleanTrue: imports.env.__box_boolean(2),
    typeofNumber: imports.env.__typeof_number(42),
    typeofString: imports.env.__typeof_number("42"),
    falsy: imports.env.__is_truthy(0),
    truthy: imports.env.__is_truthy("x"),
  };
  return { values, counts: imports.takeImportCounts?.() };
}

describe("#3780 non-throwing leaf host imports", () => {
  it("keeps values, fixed arities, and import diagnostics on the fast wrappers", () => {
    expect(exercise("1")).toEqual({
      values: {
        undefined: undefined,
        number: 42.5,
        booleanFalse: false,
        booleanTrue: true,
        typeofNumber: 1,
        typeofString: 0,
        falsy: 0,
        truthy: 1,
      },
      counts: {
        __get_undefined: 1,
        __box_number: 1,
        __box_boolean: 2,
        __typeof_number: 2,
        __is_truthy: 2,
      },
    });
  });

  it("matches the generic guarded-wrapper kill switch", () => {
    expect(exercise("1")).toEqual(exercise("0"));
  });
});
