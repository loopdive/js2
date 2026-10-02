// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc, definedFuncAt } from "./func-space.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { canonicalUndefinedExternInstrs } from "./any-helpers.js";

/** Preserve a closed ordinary object in prototype position, without copying fields. */
export function fillClosedObjectPrototypeEdges(ctx: CodegenContext): void {
  if (!ctx.standalone || !ctx.usesDynamicProto || !ctx.objectRuntimeTypes) return;
  if (ctx.funcMap.has("__closed_proto_find")) return;
  const required = [
    "__getPrototypeOf",
    "__object_setPrototypeOf",
    "__object_setPrototypeOf_status",
    "__is_instance_expando_carrier",
    "__closure_bag_lookup",
    "__extern_get",
    "__extern_has",
    "__hasOwnProperty",
    "__reflect_get_receiver",
    "__object_terminal_allows_implicit_proto",
    "__object_proto_singleton",
  ];
  if (required.some((name) => !ctx.funcMap.has(name))) return;
  const idx = (name: string) => ctx.funcMap.get(name)!;
  const fn = (name: string) => definedFuncAt(ctx, idx(name))!;
  const object = ctx.objectRuntimeTypes.objectTypeIdx;
  const ext: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const EQ = -19;
  const entry = ctx.mod.types.length;
  const ref: ValType = { kind: "ref_null", typeIdx: entry };
  ctx.mod.types.push({
    kind: "struct",
    name: "$ClosedProtoEdge",
    fields: [
      { name: "next", type: ref, mutable: false },
      { name: "owner", type: { kind: "eqref" }, mutable: false },
      { name: "prototype", type: ext, mutable: true },
    ],
  });
  const head = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "$closed_proto_edges",
    type: ref,
    mutable: true,
    init: [{ op: "ref.null", typeIdx: entry }],
  });
  const l = (index: number): Instr => ({ op: "local.get", index });
  const c = (name: string): Instr => ({ op: "call", funcIdx: idx(name) });
  const n = (value: number): Instr => ({ op: "i32.const", value });
  const ret = (): Instr => ({ op: "return" });
  const branch = (condition: Instr[], then: Instr[]): Instr[] => [
    ...condition,
    { op: "if", blockType: { kind: "empty" }, then },
  ];
  const add = (name: string, params: ValType[], results: ValType[], locals: ValType[], body: Instr[]): void => {
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx: addFuncType(ctx, params, results),
      locals: locals.map((type, index) => ({ name: `scratch${index}`, type })),
      body,
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
  };
  add(
    "__closed_proto_find",
    [ext],
    [ref],
    [ref],
    [
      ...branch(
        [l(0), { op: "any.convert_extern" }, { op: "ref.test", typeIdx: EQ }, { op: "i32.eqz" }],
        [{ op: "ref.null", typeIdx: entry }, ret()],
      ),
      { op: "global.get", index: head },
      { op: "local.set", index: 1 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              l(1),
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              ...branch(
                [
                  l(1),
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: entry, fieldIdx: 1 },
                  l(0),
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx: EQ },
                  { op: "ref.eq" },
                ],
                [l(1), ret()],
              ),
              l(1),
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: entry, fieldIdx: 0 },
              { op: "local.set", index: 1 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "ref.null", typeIdx: entry },
    ],
  );
  add(
    "__closed_proto_has",
    [ext],
    [i32],
    [],
    [l(0), c("__closed_proto_find"), { op: "ref.is_null" }, { op: "i32.eqz" }],
  );
  add(
    "__closed_proto_read",
    [ext],
    [ext],
    [],
    [l(0), c("__closed_proto_find"), { op: "ref.as_non_null" }, { op: "struct.get", typeIdx: entry, fieldIdx: 2 }],
  );
  add(
    "__closed_proto_store",
    [ext, ext],
    [],
    [ref],
    [
      l(0),
      c("__closed_proto_find"),
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: head },
          l(0),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ },
          l(1),
          { op: "struct.new", typeIdx: entry },
          { op: "global.set", index: head },
        ],
        else: [l(2), { op: "ref.as_non_null" }, l(1), { op: "struct.set", typeIdx: entry, fieldIdx: 2 }],
      },
    ],
  );
  add(
    "__closed_proto_route",
    [ext, ext],
    [i32],
    [],
    [
      l(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: object },
      l(0),
      c("__is_instance_expando_carrier"),
      { op: "i32.or" },
      l(1),
      c("__is_instance_expando_carrier"),
      l(0),
      c("__closed_proto_has"),
      { op: "i32.or" },
      l(0),
      c("__is_instance_expando_carrier"),
      { op: "i32.or" },
      { op: "i32.and" },
    ],
  );
  add(
    "__closed_proto_equal",
    [ext, ext],
    [i32],
    [],
    [
      ...branch([l(0), { op: "ref.is_null" }], [l(1), { op: "ref.is_null" }, ret()]),
      l(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ },
      l(1),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: EQ },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [
          l(0),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ },
          l(1),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: EQ },
          { op: "ref.eq" },
        ],
        else: [n(0)],
      },
    ],
  );
  // Frame 2: existing bag or object; frame 3: generic prototype cursor.
  add(
    "__closed_proto_status",
    [ext, ext],
    [i32],
    [ext, ext],
    [
      ...branch([l(0), c("__getPrototypeOf"), l(1), c("__closed_proto_equal")], [n(1), ret()]),
      l(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: object },
      { op: "if", blockType: { kind: "val", type: ext }, then: [l(0)], else: [l(0), c("__closure_bag_lookup")] },
      { op: "local.tee", index: 2 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: object },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...branch(
            [
              l(2),
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: object },
              { op: "struct.get", typeIdx: object, fieldIdx: 4 },
              n(1),
              { op: "i32.and" },
            ],
            [n(0), ret()],
          ),
        ],
      },
      l(1),
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              l(3),
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              ...branch([l(3), l(0), c("__closed_proto_equal")], [n(0), ret()]),
              l(3),
              c("__getPrototypeOf"),
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      n(1),
    ],
  );
  fn("__getPrototypeOf").body.unshift(
    ...branch([l(0), c("__closed_proto_has")], [l(0), c("__closed_proto_read"), ret()]),
  );
  fn("__object_setPrototypeOf_status").body.unshift(
    ...branch([l(0), l(1), c("__closed_proto_route")], [l(0), l(1), c("__closed_proto_status"), ret()]),
  );
  fn("__object_setPrototypeOf").body.unshift(
    ...branch(
      [l(0), l(1), c("__closed_proto_route")],
      [
        ...branch(
          [l(0), l(1), c("__closed_proto_status")],
          [
            // Typed class reads use their intrinsic slot, not the side table.
            ...(ctx.funcMap.has("__struct_proto_set")
              ? [l(0), l(1), c("__struct_proto_set"), { op: "drop" } as Instr]
              : []),
            l(0),
            l(1),
            c("__closed_proto_store"),
          ],
        ),
        l(0),
        ret(),
      ],
    ),
  );
  fillEdgeReads(ctx, fn, idx, object);
  fillEdgeTerminal(ctx, add, fn, idx, object);
}

function fillEdgeTerminal(
  ctx: CodegenContext,
  add: (name: string, params: ValType[], results: ValType[], locals: ValType[], body: Instr[]) => void,
  fn: (name: string) => WasmFunction,
  idx: (name: string) => number,
  object: number,
): void {
  const name = "__closed_proto_terminal";
  add(name, [{ kind: "externref" }], [{ kind: "i32" }], [{ kind: "externref" }], []);
  const l = (index: number): Instr => ({ op: "local.get", index });
  const c = (target: string): Instr => ({ op: "call", funcIdx: idx(target) });
  const constant = (value: number): Instr => ({ op: "i32.const", value });
  const ret: Instr = { op: "return" };
  fn(name).body = [
    l(0),
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [constant(0), { ...ret }] },
    l(0),
    c("__object_proto_singleton"),
    c("__closed_proto_equal"),
    { op: "if", blockType: { kind: "empty" }, then: [constant(1), { ...ret }] },
    l(0),
    c("__closed_proto_has"),
    { op: "if", blockType: { kind: "empty" }, then: [l(0), c("__closed_proto_read"), c(name), { ...ret }] },
    l(0),
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: object },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        l(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: object },
        c("__object_terminal_allows_implicit_proto"),
        { ...ret },
      ],
    },
    l(0),
    c("__getPrototypeOf"),
    c(name),
  ];
  const terminal = fn("__object_terminal_allows_implicit_proto");
  const splice = (body: Instr[]): boolean => {
    for (let index = 0; index < body.length; index++) {
      const instruction = body[index]!;
      if (instruction.op === "struct.get" && instruction.typeIdx === object && instruction.fieldIdx === 0) {
        body.splice(index - 2, 0, l(1), { op: "extern.convert_any" }, c("__closed_proto_has"), {
          op: "if",
          blockType: { kind: "empty" },
          then: [l(1), { op: "extern.convert_any" }, c(name), { ...ret }],
        });
        return true;
      }
      if ((instruction.op === "block" || instruction.op === "loop") && splice(instruction.body)) return true;
      if (instruction.op === "if" && (splice(instruction.then) || (instruction.else && splice(instruction.else))))
        return true;
    }
    return false;
  };
  if (!splice(terminal.body)) throw new Error("closed prototype edges could not locate the terminal walk");
}

function fillEdgeReads(
  ctx: CodegenContext,
  fn: (name: string) => WasmFunction,
  idx: (name: string) => number,
  object: number,
): void {
  const global = (name: string) => ctx.numImportGlobals + ctx.mod.globals.findIndex((g) => g.name === name);
  const active = global("__reflect_get_receiver_active");
  const receiver = global("__reflect_get_receiver_value");
  const getter = fn("__extern_get");
  const scratch = 2 + getter.locals.length;
  getter.locals.push({ name: "closedProtoReceiver", type: { kind: "externref" } });
  const protoScratch = scratch + 1;
  getter.locals.push({ name: "closedProtoValue", type: { kind: "externref" } });
  const emitRead = (owner: Instr[], thisValue: Instr[]): Instr[] => [
    ...thisValue,
    { op: "local.set", index: scratch },
    { op: "i32.const", value: 0 },
    { op: "global.set", index: active },
    ...owner,
    { op: "call", funcIdx: idx("__closed_proto_read") },
    { op: "local.tee", index: protoScratch },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [...canonicalUndefinedExternInstrs(ctx), { op: "return" }] },
    { op: "local.get", index: protoScratch },
    { op: "local.get", index: 1 },
    { op: "local.get", index: scratch },
    { op: "call", funcIdx: idx("__reflect_get_receiver") },
    { op: "return" },
  ];
  getter.body.unshift(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: idx("__closed_proto_has") },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: idx("__hasOwnProperty") },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: emitRead(
            [{ op: "local.get", index: 0 }],
            [
              { op: "global.get", index: active },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } },
                then: [{ op: "global.get", index: receiver }],
                else: [{ op: "local.get", index: 0 }],
              },
            ],
          ),
        },
      ],
    },
  );
  const has = fn("__extern_has");
  const hasScratch = 2 + has.locals.length;
  has.locals.push({ name: "closedProtoValue", type: { kind: "externref" } });
  const emitHas = (owner: Instr[]): Instr[] => [
    ...owner,
    { op: "call", funcIdx: idx("__closed_proto_read") },
    { op: "local.tee", index: hasScratch },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: hasScratch },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: idx("__extern_has") },
    { op: "return" },
  ];
  has.body.unshift(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: idx("__closed_proto_has") },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: idx("__hasOwnProperty") },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
        ...emitHas([{ op: "local.get", index: 0 }]),
      ],
    },
  );
  // A descendant without its own override can reach one later in its walk.
  const explicitLocal = getter.locals.findIndex((local) => local.name === "explicitReceiver");
  if (explicitLocal < 0) throw new Error("closed prototype edges require the explicit receiver local");
  const explicit = 2 + explicitLocal;
  const insert = (body: Instr[], read: boolean): boolean => {
    for (let i = 0; i < body.length; i++) {
      const instruction = body[i]!;
      if (
        instruction.op === "struct.get" &&
        instruction.typeIdx === object &&
        instruction.fieldIdx === 0 &&
        body[i + 1]?.op === "local.set" &&
        (body[i + 1] as { index?: number }).index === 2
      ) {
        if (i < 2 || body[i - 2]?.op !== "local.get" || body[i - 1]?.op !== "ref.as_non_null") {
          throw new Error("closed prototype edges encountered an unknown cursor load");
        }
        const owner: Instr[] = [{ op: "local.get", index: 2 }, { op: "extern.convert_any" }];
        const action: Instr[] = read ? emitRead(owner, [{ op: "local.get", index: explicit }]) : emitHas(owner);
        // Insert before the two instructions that put the old cursor on stack.
        body.splice(
          i - 2,
          0,
          ...owner,
          { op: "call", funcIdx: idx("__closed_proto_has") },
          { op: "if", blockType: { kind: "empty" }, then: action },
        );
        return true;
      }
      if (instruction.op === "block" || instruction.op === "loop") {
        if (insert(instruction.body, read)) return true;
      } else if (instruction.op === "if") {
        if (insert(instruction.then, read) || (instruction.else && insert(instruction.else, read))) return true;
      }
    }
    return false;
  };
  if (!insert(getter.body, true) || !insert(has.body, false)) {
    throw new Error("closed prototype edges could not locate the property walks");
  }
}
