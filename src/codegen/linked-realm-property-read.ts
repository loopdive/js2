// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { CodegenContext } from "./context/types.js";
import { ensureLateImport } from "./shared.js";
import { publishScriptGetter } from "./shared-script-completion.js";
import { fillArrayIteratorPropertyRead } from "./array-iterator-property-read.js";

/** Explicit ownership, not a structural type match, selects the foreign realm. */
export function reserveLinkedRealmPropertyRead(ctx: CodegenContext): void {
  const linked = ctx.standaloneGlobalThisImport;
  if (!linked?.owns || !linked.get) return;
  if (linked.arrayPrototype) {
    ensureLateImport(ctx, linked.arrayPrototype, [], [{ kind: "externref" }], linked.module);
    ensureLateImport(ctx, "__extern_is_array", [{ kind: "externref" }], [{ kind: "i32" }]);
  }
  ensureLateImport(ctx, linked.owns, [{ kind: "externref" }], [{ kind: "i32" }], linked.module);
  ensureLateImport(
    ctx,
    linked.get,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    linked.module,
  );
}

/** Install after every getter fill so graph-local bags and caches cannot win. */
export function fillLinkedRealmPropertyRead(ctx: CodegenContext): void {
  fillArrayIteratorPropertyRead(ctx);
  publishScriptGetter(ctx);
  const linked = ctx.standaloneGlobalThisImport;
  if (!linked?.owns || !linked.get) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  if (!fn) return;
  const owns = ctx.funcMap.get(linked.owns);
  const get = ctx.funcMap.get(linked.get);
  if (owns === undefined || get === undefined) throw new Error("Linked realm property imports were not reserved.");
  const active = ctx.mod.globals.findIndex((global) => global.name === "__reflect_get_receiver_active");
  const receiver = ctx.mod.globals.findIndex((global) => global.name === "__reflect_get_receiver_value");
  if (active < 0 || receiver < 0) throw new Error("Linked realm getter requires Reflect.get receiver state.");
  fn.body.unshift(
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: owns },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "global.get", index: ctx.numImportGlobals + active },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            { op: "i32.const", value: 0 },
            { op: "global.set", index: ctx.numImportGlobals + active },
            { op: "global.get", index: ctx.numImportGlobals + receiver },
          ],
          else: [{ op: "local.get", index: 0 }],
        },
        { op: "call", funcIdx: get },
        { op: "return" },
      ],
    },
  );
}
