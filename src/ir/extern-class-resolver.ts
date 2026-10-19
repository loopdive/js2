// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { hasHostAccelerator, type CompileTargetProfile } from "../target-profile.js";
import type { IrExternClassMeta } from "./extern-class-contract.js";

/** Read exact collected provider metadata without materializing native runtime state. */
export function makeIrExternClassInfoResolver(ctx: {
  readonly externClasses: ReadonlyMap<string, IrExternClassMeta>;
  readonly targetProfile: CompileTargetProfile;
}): (name: string) => IrExternClassMeta | undefined {
  return (className: string) => {
    const info = ctx.externClasses.get(className);
    if (!info) {
      if (className !== "Date" || !hasHostAccelerator(ctx.targetProfile, "date")) return undefined;
      const externref = { kind: "externref" } as const;
      const f64 = { kind: "f64" } as const;
      return {
        className: "Date",
        importPrefix: "Date",
        constructorParams: [],
        methods: new Map([
          ["getDate", { params: [externref], results: [f64] }],
          ["getMonth", { params: [externref], results: [f64] }],
          ["getFullYear", { params: [externref], results: [f64] }],
        ]),
        properties: new Map(),
      };
    }
    return {
      className: info.className,
      namespacePath: info.namespacePath,
      importPrefix: info.importPrefix,
      constructorParams: info.constructorParams,
      methods: info.methods,
      properties: info.properties,
    };
  };
}
