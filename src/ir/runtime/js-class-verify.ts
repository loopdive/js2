// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrValueId } from "../core/nodes.js";
import { irTypeEquals, type IrType } from "../core/types.js";

type JsInstruction = Extract<IrInstr, { readonly kind: `js.class.${string}` }>;

/** Inspect own DATA descriptors before reading any supplied semantic value. */
export function copyIrJsClassData<T>(value: T): T {
  const ancestors = new Set<object>();
  const visit = (input: unknown): unknown => {
    if (typeof input === "function" || typeof input === "symbol" || input === undefined)
      throw new TypeError("native JS class contract requires closed DATA");
    if (input === null || typeof input !== "object") return input;
    if (ancestors.has(input)) throw new TypeError("native JS class contract has a cycle");
    const array = Array.isArray(input);
    const proto = Object.getPrototypeOf(input);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      throw new TypeError("native JS class contract requires plain DATA");
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Reflect.ownKeys(descriptors)) {
      const d = descriptors[key as keyof typeof descriptors];
      if (typeof key !== "string" || !d || !("value" in d))
        throw new TypeError("native JS class contract has accessor or symbol DATA");
    }
    let result: unknown;
    if (array) {
      const size = descriptors.length!.value;
      if (!Number.isSafeInteger(size) || size < 0 || Reflect.ownKeys(descriptors).length !== size + 1)
        throw new TypeError("native JS class contract requires dense arrays");
      const values: unknown[] = [];
      for (let i = 0; i < size; i++) {
        const d = descriptors[String(i)];
        if (!d) throw new TypeError("native JS class contract requires dense arrays");
        values.push(visit(d.value));
      }
      result = Object.freeze(values);
    } else {
      const record = Object.create(null) as Record<string, unknown>;
      for (const [key, d] of Object.entries(descriptors)) record[key] = visit(d.value);
      result = Object.freeze(record);
    }
    ancestors.delete(input);
    return result;
  };
  return visit(value) as T;
}

function keys(value: object, required: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value);
  if (
    required.some((key) => !actual.includes(key)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new TypeError("native JS class contract fields differ");
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("native JS class contract requires a record");
}
function array(value: unknown): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError("native JS class contract requires an array");
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length) throw new TypeError("native JS class contract requires an identity");
}
function integer(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError("native JS class contract requires a nonnegative integer");
}
function span(value: unknown): void {
  record(value);
  keys(value, ["start", "end"]);
  integer(value.start);
  integer(value.end);
  if ((value.end as number) < (value.start as number)) throw new TypeError("native JS class source span reversed");
}
function supportType(value: unknown): void {
  record(value);
  keys(value, ["kind", "name", "binding"]);
  if (value.kind !== "type") throw new TypeError("native JS class type reference kind");
  text(value.name);
  record(value.binding);
  keys(value.binding, ["kind", "bindingId"]);
  if (value.binding.kind !== "support") throw new TypeError("native JS class requires a support type reference");
  text(value.binding.bindingId);
  if (!value.binding.bindingId.startsWith("ir-binding:v1:type:"))
    throw new TypeError("native JS class type identity domain");
}
function global(value: unknown, supportOnly = false): void {
  record(value);
  keys(value, ["kind", "name", "binding"]);
  if (value.kind !== "global") throw new TypeError("native JS class global reference kind");
  text(value.name);
  record(value.binding);
  keys(value.binding, ["kind", "bindingId"]);
  if (
    supportOnly ? value.binding.kind !== "support" : value.binding.kind !== "support" && value.binding.kind !== "source"
  )
    throw new TypeError("native JS class storage requires an original source or support global");
  text(value.binding.bindingId);
  if (!value.binding.bindingId.startsWith("ir-binding:v1:global:"))
    throw new TypeError("native JS class global identity domain");
}
function logicalType(value: unknown): void {
  record(value);
  text(value.kind);
  if (value.kind === "support-ref") {
    keys(value, ["kind", "ref", "nullable"]);
    supportType(value.ref);
    if (typeof value.nullable !== "boolean") throw new TypeError("native JS class support nullability");
  } else if (value.kind === "dynamic") {
    keys(value, ["kind"], ["tag"]);
  } else if (value.kind === "val") {
    keys(value, ["kind", "val"], ["signed", "typeRef"]);
    record(value.val);
    text(value.val.kind);
    if (!["i32", "f64"].includes(value.val.kind)) throw new TypeError("native JS class scalar value contract");
  } else throw new TypeError("native JS class unsupported logical value contract");
}
function capture(value: unknown): void {
  record(value);
  keys(value, ["bindingId", "mode", "type", "valueGlobal", "tdzGlobal"]);
  text(value.bindingId);
  logicalType(value.type);
  if (!["value", "live-cell", "live-global"].includes(value.mode as string))
    throw new TypeError("native JS class capture mode");
  if (value.mode === "live-global") {
    global(value.valueGlobal);
    if (value.tdzGlobal !== null) global(value.tdzGlobal);
  } else if (value.valueGlobal !== null || value.tdzGlobal !== null)
    throw new TypeError("native JS class external capture storage");
}
function binding(value: unknown): void {
  if (value === null) return;
  record(value);
  keys(value, ["id", "name", "mutable", "storage", "valueType", "valueGlobal", "tdzGlobal"]);
  text(value.id);
  text(value.name);
  logicalType(value.valueType);
  if (typeof value.mutable !== "boolean") throw new TypeError("native JS class binding mutability");
  if (value.storage === "module") {
    global(value.valueGlobal, true);
    global(value.tdzGlobal, true);
  } else if (value.storage !== "cell" || value.valueGlobal !== null || value.tdzGlobal !== null)
    throw new TypeError("native JS class binding storage");
}
function body(value: unknown): void {
  record(value);
  keys(value, [
    "unitId",
    "target",
    "sourceBodyKind",
    "lexicalOwnerId",
    "terminalOwnerId",
    "ordinal",
    "span",
    "frame",
    "params",
    "result",
  ]);
  text(value.unitId);
  text(value.lexicalOwnerId);
  text(value.terminalOwnerId);
  integer(value.ordinal);
  span(value.span);
  record(value.target);
  keys(value.target, ["kind", "name", "binding"]);
  record(value.target.binding);
  keys(value.target.binding, ["kind", "unitId"]);
  if (
    value.target.kind !== "func" ||
    value.target.binding.kind !== "unit" ||
    value.target.binding.unitId !== value.unitId
  )
    throw new TypeError("native JS class body callable identity");
  text(value.target.name);
  if (!["constructor", "method", "field-initializer", "static-initializer"].includes(value.sourceBodyKind as string))
    throw new TypeError("native JS class original body kind");
  record(value.frame);
  keys(value.frame, ["type", "thisType", "environmentType", "homeObjectType", "newTargetType", "captures"]);
  supportType(value.frame.type);
  for (const key of ["thisType", "environmentType", "homeObjectType", "newTargetType"]) logicalType(value.frame[key]);
  array(value.frame.captures);
  value.frame.captures.forEach(capture);
  array(value.params);
  value.params.forEach(logicalType);
  if (value.result !== null) logicalType(value.result);
  if (value.sourceBodyKind === "field-initializer" && value.params.length !== 0)
    throw new TypeError("native JS class initializer has user parameters");
}

/** Runtime-local closed DATA validation; full original inventory/ABI joins belong to the program owner. */
export function verifyIrJsClassDefinitionData(value: unknown): readonly string[] {
  try {
    const data = copyIrJsClassData(value);
    record(data);
    keys(data, [
      "schema",
      "sourceClassId",
      "sourceId",
      "span",
      "evaluationOwnerUnitId",
      "form",
      "name",
      "outerBinding",
      "innerBinding",
      "constructorKind",
      "constructor",
      "implicitConstructor",
      "members",
      "instanceElements",
      "captures",
      "roles",
      "realm",
    ]);
    if (data.schema !== "native-js-class-definition-v1" || data.constructorKind !== "base")
      throw new TypeError("native JS class definition schema/kind");
    for (const key of ["sourceClassId", "sourceId", "evaluationOwnerUnitId"]) text(data[key]);
    span(data.span);
    if (data.form !== "declaration" && data.form !== "expression")
      throw new TypeError("native JS class definition form");
    if (typeof data.name !== "string" || typeof data.implicitConstructor !== "boolean")
      throw new TypeError("native JS class definition name/constructor intent");
    binding(data.outerBinding);
    binding(data.innerBinding);
    if (data.innerBinding && (data.innerBinding as Record<string, unknown>).mutable !== false)
      throw new TypeError("native JS class inner name must be immutable");
    body(data.constructor);
    array(data.members);
    array(data.instanceElements);
    array(data.captures);
    data.captures.forEach(capture);
    const ordinals = new Set<number>();
    let previousMember = -1;
    for (const member of data.members) {
      record(member);
      keys(member, ["sourceOrdinal", "name", "static", "span", "body", "attributes"]);
      integer(member.sourceOrdinal);
      text(member.name);
      span(member.span);
      body(member.body);
      if (member.sourceOrdinal <= previousMember) throw new TypeError("native JS class method order differs");
      previousMember = member.sourceOrdinal;
      if (typeof member.static !== "boolean") throw new TypeError("native JS class method static intent");
      record(member.attributes);
      keys(member.attributes, ["writable", "enumerable", "configurable"]);
      if (
        member.attributes.writable !== true ||
        member.attributes.enumerable !== false ||
        member.attributes.configurable !== true
      )
        throw new TypeError("native JS class method descriptor");
      if (ordinals.has(member.sourceOrdinal)) throw new TypeError("native JS class duplicate source member");
      ordinals.add(member.sourceOrdinal);
    }
    let previous = -1;
    for (const field of data.instanceElements) {
      record(field);
      keys(field, ["sourceOrdinal", "name", "span", "valueType", "defaultIntent", "initializer", "attributes"]);
      integer(field.sourceOrdinal);
      text(field.name);
      span(field.span);
      logicalType(field.valueType);
      if (
        (field.valueType as Record<string, unknown>).kind !== "dynamic" ||
        Object.hasOwn(field.valueType as object, "tag")
      )
        throw new TypeError("native JS class field requires an unrefined logical Undefined-capable value");
      if (field.sourceOrdinal <= previous || ordinals.has(field.sourceOrdinal))
        throw new TypeError("native JS class initializer order/census");
      previous = field.sourceOrdinal;
      ordinals.add(field.sourceOrdinal);
      if (field.defaultIntent === "initializer") body(field.initializer);
      else if (field.defaultIntent !== "undefined" || field.initializer !== null)
        throw new TypeError("native JS class field default intent");
      record(field.attributes);
      keys(field.attributes, ["writable", "enumerable", "configurable"]);
      if (
        field.attributes.writable !== true ||
        field.attributes.enumerable !== true ||
        field.attributes.configurable !== true
      )
        throw new TypeError("native JS class own field descriptor");
    }
    record(data.roles);
    keys(data.roles, ["object", "constructor", "prototype", "environment", "binding-cell", "frame", "method"]);
    Object.values(data.roles).forEach(supportType);
    record(data.realm);
    keys(data.realm, ["objectPrototype", "functionPrototype", "referenceError", "typeError"]);
    Object.values(data.realm).forEach(text);
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : "native JS class malformed DATA"];
  }
}

export function verifyIrJsClassInstruction(
  input: JsInstruction,
  typeOf: ReadonlyMap<IrValueId, IrType>,
): readonly string[] {
  let instr: JsInstruction;
  try {
    instr = copyIrJsClassData(input);
  } catch (error) {
    return [error instanceof Error ? error.message : "native JS class malformed instruction DATA"];
  }
  const problems: string[] = [];
  const identity = (id: unknown, domain: "support" | "global"): void => {
    if (typeof id !== "string" || !id.startsWith(`ir-binding:v1:${domain}:`))
      problems.push("native JS class instruction has a noncanonical symbolic identity");
  };
  if ("definition" in instr) identity(instr.definition, "support");
  if (instr.kind === "js.class.binding.new") identity(instr.binding, "support");
  if ("storage" in instr) {
    identity(instr.storage.bindingId, "support");
    if (instr.storage.kind !== "module" && instr.storage.kind !== "cell")
      problems.push("native JS class instruction has unknown binding storage");
  }
  const roleOf = (type: IrType | null | undefined): string | undefined => {
    if (type?.kind !== "support-ref") return undefined;
    const part = type.ref.binding.bindingId.split(":")[4];
    try {
      return part === undefined ? undefined : decodeURIComponent(part);
    } catch {
      return undefined;
    }
  };
  const managed = (value: IrValueId, label: string, expectedRole?: string): void => {
    if (typeOf.get(value)?.kind !== "support-ref")
      problems.push(`${instr.kind} ${label} requires a managed support reference`);
    else if (expectedRole && roleOf(typeOf.get(value)) !== `native-js-class-role:${expectedRole}`)
      problems.push(`${instr.kind} ${label} has a foreign managed role`);
  };
  const value = (v: IrValueId): void => {
    if (!typeOf.has(v)) problems.push(`${instr.kind} has an unknown operand`);
  };
  if (["js.class.define", "js.class.binding.new", "js.class.construct", "js.class.frame.new"].includes(instr.kind)) {
    if (instr.alloc === undefined || !Number.isSafeInteger(instr.alloc) || instr.alloc < 0)
      problems.push(`${instr.kind} lacks a genuine allocation site`);
    if (instr.result === null || instr.resultType?.kind !== "support-ref" || instr.resultType.nullable)
      problems.push(`${instr.kind} requires a non-null managed result`);
    const expectedRole =
      instr.kind === "js.class.define"
        ? "constructor"
        : instr.kind === "js.class.binding.new"
          ? "binding-cell"
          : instr.kind === "js.class.construct"
            ? "object"
            : "frame";
    if (roleOf(instr.resultType) !== `native-js-class-role:${expectedRole}`)
      problems.push(`${instr.kind} has a foreign managed result role`);
  }
  switch (instr.kind) {
    case "js.class.define":
      instr.captures.forEach(value);
      break;
    case "js.class.binding.new":
      break;
    case "js.class.binding.read":
    case "js.class.binding.init":
    case "js.class.binding.write":
      if (instr.storage.kind === "cell") managed(instr.storage.cell, "cell", "binding-cell");
      if (instr.kind !== "js.class.binding.read") value(instr.value);
      break;
    case "js.class.construct":
      managed(instr.constructor, "constructor");
      managed(instr.newTarget, "newTarget");
      instr.args.forEach(value);
      if (instr.args.some((arg) => typeOf.get(arg)?.kind !== "dynamic"))
        problems.push("native JS class construct requires actual tagged argument values");
      break;
    case "js.class.property.get":
    case "js.class.property.define":
    case "js.class.property.set":
      managed(instr.receiver, "receiver");
      if (instr.key.kind === "computed") value(instr.key.value);
      if (instr.kind !== "js.class.property.get") value(instr.value);
      break;
    case "js.class.frame.new":
      for (const v of [instr.environment, instr.thisValue, instr.homeObject, instr.newTarget]) managed(v, "frame root");
      break;
    case "js.class.frame.get":
      managed(instr.frame, "frame", "frame");
      break;
    case "js.class.invoke":
      try {
        record(instr.signature);
        keys(instr.signature, ["params", "result"]);
        array(instr.signature.params);
        instr.signature.params.forEach(logicalType);
        logicalType(instr.signature.result);
        array(instr.args);
      } catch {
        problems.push("native JS class invoke requires closed actual transport DATA");
        break;
      }
      if (typeOf.get(instr.callable)?.kind !== "dynamic")
        problems.push("native JS class invoke requires the actual tagged callable value");
      managed(instr.receiver, "receiver");
      instr.args.forEach(value);
      if (
        instr.args.length !== instr.signature.params.length ||
        instr.args.some((arg, index) => {
          const actual = typeOf.get(arg),
            expected = instr.signature.params[index];
          return !actual || actual.kind !== "dynamic" || !expected || !irTypeEquals(actual, expected);
        })
      )
        problems.push("native JS class invoke actual argument transport differs");
      if (
        instr.result === null ||
        instr.resultType?.kind !== "dynamic" ||
        instr.resultType.tag !== undefined ||
        instr.signature.result?.kind !== "dynamic" ||
        instr.signature.result.tag !== undefined
      )
        problems.push("native JS class invoke requires its unrefined actual completion");
      break;
    case "js.class.constructor.complete":
      if (instr.constructorKind !== "base") problems.push("native JS class constructor completion kind is unprepared");
      managed(instr.self, "self");
      if (instr.completion.kind === "return") value(instr.completion.value);
      break;
    case "js.class.identity":
      managed(instr.left, "left");
      managed(instr.right, "right");
      break;
    case "js.class.instanceof":
      value(instr.value);
      managed(instr.constructor, "constructor");
      break;
    default: {
      const never: never = instr;
      void never;
      problems.push("unknown native JS class instruction");
    }
  }
  if (instr.kind === "js.class.identity" || instr.kind === "js.class.instanceof") {
    if (
      instr.result === null ||
      instr.resultType?.kind !== "val" ||
      instr.resultType.val.kind !== "i32" ||
      instr.resultType.val.boolean !== true
    )
      problems.push(`${instr.kind} requires a Boolean result`);
  }
  return problems;
}
