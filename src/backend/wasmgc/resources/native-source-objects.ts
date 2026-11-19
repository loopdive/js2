// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O1) The ordinary-object family's rows of the realm's source-call functions (`native-realm-source-calls.ts`).
 * A source program reaches an ordinary object only through the `js.object.*` contracts (`ordinary-object-callables.ts`);
 * each contract it calls binds one function, whose signature is the contract's and whose algorithm is the realm's own:
 *   - `define-data` is the descriptor pack's public define, bound as it is, and (#7354 O4) `create-type-error` the
 *     invocation substrate's TypeError constructor;
 *   - `create-default` and `get` are adapters (`source-object-bodies.ts`) over the storage pack and the builtin-object
 *     kernel.
 */
import type { OrdinaryObjectRuntimeFeature } from "../../../ir/runtime/contracts/manifest.js";
import {
  buildSourceObjectCreateDefinition,
  buildSourceObjectGetDefinition,
} from "../../../runtime/wasmgc/values/source-object-bodies.js";
import type { RealmSourceCallAdapter, RealmSourceCallRow } from "./native-realm-source-calls.js";

const EXTERNREF = { kind: "externref" } as const;
const adapted = (feature: OrdinaryObjectRuntimeFeature, adapter: RealmSourceCallAdapter): RealmSourceCallRow => ({
  resource: "source-objects:" + feature,
  adapter,
});

export const ORDINARY_OBJECT_SOURCE_CALL_ROWS: Readonly<
  Partial<Record<OrdinaryObjectRuntimeFeature, RealmSourceCallRow>>
> = {
  "js.object.define-data": { resource: "descriptors:define-data" },
  "js.object.create-type-error": { resource: "invocation-substrate:errors:new-TypeError" },
  "js.object.create-default": adapted("js.object.create-default", {
    signature: { params: [], results: [EXTERNREF] },
    body: ({ layouts, storage, kernel }) =>
      buildSourceObjectCreateDefinition({
        objectTypeIdx: layouts.object.typeIndex,
        objectPrototype: kernel.functions.objectPrototype.handle,
        createWithPrototype: storage.createWithPrototype.handle,
      }),
  }),
  "js.object.get": adapted("js.object.get", {
    signature: { params: [EXTERNREF, EXTERNREF, EXTERNREF], results: [EXTERNREF] },
    body: ({ kernel }) => buildSourceObjectGetDefinition({ get: kernel.functions.get.handle }),
  }),
};
