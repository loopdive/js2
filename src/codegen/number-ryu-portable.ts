// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Backend-neutral scalar template for the canonical Ryū formatter.
 *
 * Linear memory translates only the immutable-table and scratch-buffer seams;
 * the arithmetic remains owned by number-ryu.ts.
 */
import { createEmptyModule, type Instr, type LocalDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt } from "./func-space.js";
import { emitRyuToBuf } from "./number-ryu.js";

export interface PortableRyuTemplate {
  readonly functions: ReadonlyMap<
    "__ryu_mul_shift" | "__num_ryu_digits" | "__num_ryu_to_buf",
    { readonly handle: number; readonly locals: readonly LocalDef[]; readonly body: readonly Instr[] }
  >;
  readonly tables: readonly (readonly bigint[])[];
}

export function buildPortableRyuTemplate(): PortableRyuTemplate {
  const mod = createEmptyModule();
  mod.types.push({
    kind: "array",
    name: "__portable_ryu_buf",
    element: { kind: "i32" },
    mutable: true,
  });
  const funcMap = new Map<string, number>();
  const ctx = {
    mod,
    funcMap,
    funcTypeCache: new Map(),
    arrayTypeMap: new Map(),
    numImportFuncs: 0,
    numImportGlobals: 0,
  } as unknown as CodegenContext;
  emitRyuToBuf(ctx, 0);

  const names = ["__ryu_mul_shift", "__num_ryu_digits", "__num_ryu_to_buf"] as const;
  const functions = new Map<
    (typeof names)[number],
    { handle: number; locals: readonly LocalDef[]; body: readonly Instr[] }
  >();
  for (const name of names) {
    const handle = funcMap.get(name);
    const func = handle === undefined ? undefined : definedFuncAt(ctx, handle);
    if (handle === undefined || !func) throw new Error(`portable Ryū template is missing ${name}`);
    functions.set(name, { handle, locals: func.locals, body: func.body });
  }
  const tables = mod.globals.map((global) =>
    global.init.flatMap((instr) => (instr.op === "i64.const" ? [instr.value] : [])),
  );
  if (tables.length !== 2 || tables.some((table) => table.length === 0)) {
    throw new Error("portable Ryū template has an invalid power-of-five table population");
  }
  return { functions, tables };
}
