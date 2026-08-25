// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3954 phase 1 — THE PRODUCER AXIS: the one place a source language's value
 * model is bound to the IR.
 *
 * `docs/architecture/codegen-axes.md` names two orthogonal axes — backend
 * lowering (WasmGC vs linear) and front-end (direct AST→Wasm vs IR). This file
 * is the third: which SOURCE LANGUAGE produced the IR, and therefore which
 * {@link TagDomain} its `dynamic` values are interpreted against.
 *
 * There is exactly ONE producer today (`from-ast.ts`, TypeScript/JavaScript),
 * so `tagDomainForProducer` has one arm. That is the point: the axis is named
 * and has a single, greppable binding site, instead of ECMAScript being
 * ambient everywhere. A second producer adds an arm here and a
 * `*-tag-domain.ts` leaf — not a tree-wide rewrite.
 *
 * DESIGN NOTE — no mutable global. An earlier sketch had a
 * `setActiveTagDomain()` module-level slot. That is a compile-order-dependent
 * global in a compiler that runs many compilations per process (the playground,
 * the test262 pool, incremental compiles), and a domain left set by a previous
 * compilation would silently reinterpret the next one's tags. A pure lookup
 * keyed by producer id has the same expressive power with none of that: a
 * consumer that needs a non-default domain takes it as a parameter, which is
 * also what makes phase 3's synthetic non-JS domain testable.
 *
 * Layering: this file may import concrete domains; `tag-domain.ts` (the
 * interface leaf) may not, and stays import-free.
 */

import { JS_TAG_DOMAIN } from "./js-tag-domain.js";
import type { TagDomain } from "./tag-domain.js";

/**
 * The source languages that can produce IR. One member today; this union is
 * what a second front-end extends.
 */
export type IrProducerId = "javascript";

/** The producer every in-tree entry point uses (`src/ir/from-ast.ts`). */
export const IR_DEFAULT_PRODUCER: IrProducerId = "javascript";

/** The tag domain a given producer's `dynamic` values are interpreted against. */
export function tagDomainForProducer(producer: IrProducerId): TagDomain {
  switch (producer) {
    case "javascript":
      return JS_TAG_DOMAIN;
  }
}

/**
 * The tag domain of the default producer.
 *
 * IR core consumers (the verifier, the builder, the lowering pass) call this
 * rather than importing `JS_TAG_DOMAIN`: they get a `TagDomain`, so the
 * ECMAScript-specific facts stay behind the interface even while JavaScript is
 * the only implementation.
 */
export function defaultTagDomain(): TagDomain {
  return tagDomainForProducer(IR_DEFAULT_PRODUCER);
}
