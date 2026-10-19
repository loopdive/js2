// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ImportDescriptor } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { classifyHostImport } from "../src/host-import-policy.js";
import { ts } from "../src/ts-api.js";

const descriptor = (name: string): ImportDescriptor => ({
  module: "env",
  name,
  kind: "func",
  intent: { type: "builtin", name },
});
const liveRegistrations = [
  "__register_fnctor_instance",
  "__register_arguments",
  "__register_typed_array",
  "__register_prototype",
  "__register_class_object",
  "__register_class_static_method",
  "__register_class_ctor",
  "__register_class_parent",
  "__register_class_parent_ref",
  "__register_init_export",
  "__register_init_class_export",
];

describe("#6979 explicit runtime lifecycle and provider retirement", () => {
  it("keeps every implemented lifecycle name classified and bound", () => {
    const imports = buildImports(liveRegistrations.map(descriptor), undefined, [], { ambientCompatibility: false });
    for (const name of liveRegistrations) {
      expect(classifyHostImport(descriptor(name)).classification, name).toBe("instance-lifecycle");
      expect(typeof imports.env[name], name).toBe("function");
    }
  });

  it("keeps explicitly declared embedder functions independent of builtin registration spelling", () => {
    const name = "__register_unknown";
    const token = {};
    const entry: ImportDescriptor = { module: "env", name, kind: "func", intent: { type: "declared_function", name } };
    expect(classifyHostImport(entry).classification).toBe("platform-capability");
    const imports = buildImports([entry], { [name]: (value: unknown) => value }, [], { ambientCompatibility: false });
    expect(imports.env[name]!(token)).toBe(token);
  });

  for (const ambientCompatibility of [undefined, true, false]) {
    it(`rejects unknown lifecycle spellings before dependencies — compatibility ${ambientCompatibility}`, () => {
      let reads = 0;
      const deps = new Proxy(
        {},
        {
          get() {
            reads++;
            throw new Error("must not resolve dependencies");
          },
        },
      );
      for (const name of [
        "__register_unknown",
        "__register_",
        "__register_class_ctor_extra",
        "__register_promise_subclass_ctor",
      ]) {
        expect(classifyHostImport(descriptor(name)).classification, name).toBe("unknown");
        const earlier: ImportDescriptor = {
          module: "env",
          name: "capability",
          kind: "func",
          intent: { type: "declared_function", name: "capability" },
        };
        expect(() => buildImports([earlier, descriptor(name)], deps, [], { ambientCompatibility })).toThrow(
          new RegExp("cannot bind env::" + name + ":"),
        );
      }
      expect(reads).toBe(0);
    });
  }

  it("keeps deleted semantic provider import names rejected", () => {
    const names = [
      "__extern_method_call",
      ...[0, 1, 2, 3, 4].map((n) => `__extern_method_call_${n}`),
      "__call_function",
      ...[0, 1, 2, 3, 4].map((n) => `__call_function_${n}`),
      "__array_from_iter",
      "__array_from_iter_n",
      "__array_from_iter_strict",
      "__array_from_iter_n_strict",
      "__call_dynamic_class_parent_0",
      "__call_dynamic_class_parent_3",
      "__call_dyn_0",
      "__call_dyn_3",
    ];
    for (const name of names) {
      expect(classifyHostImport(descriptor(name)).classification, name).toBe("unknown");
      expect(() => buildImports([descriptor(name)], undefined, [], { ambientCompatibility: false })).toThrow(
        /cannot bind/,
      );
    }
  });

  it("deletes orphaned Promise closures and preserves live adapter implementations", () => {
    const file = ts.createSourceFile(
      "runtime.ts",
      readFileSync(new URL("../src/runtime.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const names = new Set<string>();
    const registrations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isPropertySignature(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      )
        names.add(node.name.text);
      if (
        ts.isIfStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        ts.isIdentifier(node.expression.left) &&
        node.expression.left.text === "name" &&
        ts.isStringLiteral(node.expression.right) &&
        node.expression.right.text.startsWith("__register_")
      )
        registrations.push(node.expression.right.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    for (const name of [
      "_vecToArray",
      "_wrapThenable",
      "_wrapPromiseReaction",
      "_toIterable",
      "_resolveCtor",
      "promiseSubclassBodies",
      "promiseSubclassCtors",
    ])
      expect(names.has(name), name).toBe(false);
    for (const name of [
      "_wrapForHost",
      "_unwrapForHost",
      "_nativeDynamicFromHost",
      "_hostToPrimitive",
      "_nativePromiseToHost",
      "_materializeIterable",
    ])
      expect(names.has(name), name).toBe(true);
    expect(registrations.sort()).toEqual([...liveRegistrations].sort());
  });

  it("preserves the live generator-gap yield-star adapter receiver, values and throws", () => {
    const imports = buildImports([descriptor("__gen_yield_star_step")], undefined, [], { ambientCompatibility: false });
    const step = imports.env.__gen_yield_star_step!;
    const token = {};
    const seen: unknown[] = [];
    const iterator = {
      next(this: unknown, value: unknown) {
        seen.push(this, value);
        return { done: false, value: token };
      },
      return(this: unknown, value: unknown) {
        seen.push(this, value);
        return { done: true, value: token };
      },
      throw(this: unknown, value: unknown) {
        seen.push(this, value);
        throw token;
      },
    };
    expect(step(iterator, 0, token)).toEqual([0, token]);
    expect(step(iterator, 1, token)).toEqual([2, token]);
    let thrown: unknown;
    try {
      step(iterator, 2, token);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(token);
    expect(seen).toEqual([iterator, token, iterator, token, iterator, token]);
    expect(() =>
      step(
        {
          next() {
            return 1;
          },
        },
        0,
        undefined,
      ),
    ).toThrow(TypeError);
    expect(() => step({ next: 42 }, 0, undefined)).toThrow(TypeError);
  });
});
