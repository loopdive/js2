// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Test-only graph transport, NOT a prepared-program codec or authority token.
import { IR_CLASS_SHAPE_CELL } from "../../src/ir/core/types.ts";
import { copyIrPreparationData } from "../../src/ir/analysis/alloc-registry.ts";

export function encodeTypedPacket(value) {
  const data = copyIrPreparationData(value); // descriptor admission before any normalization
  const ids = new Map(),
    nodes = [];
  const encode = (value) => {
    if (value === undefined) return ["undefined"];
    if (typeof value === "bigint") return ["bigint", String(value)];
    if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
    if (value === null || typeof value !== "object") return ["primitive", value];
    if (ids.has(value)) return ["ref", ids.get(value)];
    const id = nodes.length;
    ids.set(value, id);
    nodes.push(null);
    const prototype = Object.getPrototypeOf(value);
    const node = {
      kind:
        prototype === Map.prototype
          ? "map"
          : prototype === Set.prototype
            ? "set"
            : Array.isArray(value)
              ? "array"
              : prototype === null
                ? "null-object"
                : "object",
      extensible: Object.isExtensible(value),
    };
    nodes[id] = node;
    if (node.kind === "map") node.entries = [...value].map(([key, item]) => [encode(key), encode(item)]);
    else if (node.kind === "set") node.entries = [...value].map(encode);
    else
      node.properties = Reflect.ownKeys(value).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return [
          key === IR_CLASS_SHAPE_CELL ? ["class-shape-brand"] : ["string", key],
          encode(descriptor.value),
          descriptor.enumerable,
          descriptor.writable,
          descriptor.configurable,
        ];
      });
    return ["ref", id];
  };
  const root = encode(data);
  return JSON.stringify({ schema: "typed-program-test-graph-v1", root, nodes });
}

export function decodeTypedPacket(text) {
  const data = JSON.parse(text);
  if (data.schema !== "typed-program-test-graph-v1") throw new Error("unknown test graph schema");
  const objects = data.nodes.map((node) => {
    switch (node.kind) {
      case "map":
        return new Map();
      case "set":
        return new Set();
      case "array":
        return [];
      case "object":
        return {};
      case "null-object":
        return Object.create(null);
      default:
        throw new Error("unknown test graph node");
    }
  });
  const decode = ([kind, value]) => {
    switch (kind) {
      case "undefined":
        return undefined;
      case "primitive":
        return value;
      case "number":
        return value === "-0" ? -0 : Number(value);
      case "bigint":
        return BigInt(value);
      case "ref":
        if (!Number.isInteger(value) || !Object.hasOwn(objects, value)) throw new Error("foreign graph reference");
        return objects[value];
      default:
        throw new Error("unknown test graph value");
    }
  };
  for (const [index, node] of data.nodes.entries()) {
    const object = objects[index];
    if (node.kind === "map") for (const [key, value] of node.entries) object.set(decode(key), decode(value));
    else if (node.kind === "set") for (const value of node.entries) object.add(decode(value));
    else {
      // Array length is applied last, so a frozen length cannot suppress indexed data.
      const properties =
        node.kind === "array"
          ? [...node.properties].sort((a, b) => Number(a[0][1] === "length") - Number(b[0][1] === "length"))
          : node.properties;
      for (const [key, value, enumerable, writable, configurable] of properties) {
        const name = key[0] === "class-shape-brand" ? IR_CLASS_SHAPE_CELL : key[1];
        Object.defineProperty(object, name, { value: decode(value), enumerable, writable, configurable });
      }
    }
    if (!node.extensible) Object.preventExtensions(object);
  }
  return decode(data.root);
}
