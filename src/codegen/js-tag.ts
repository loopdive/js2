// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * @deprecated #3113 — the `JsTag` shared-vocabulary leaf moved BELOW the codegen
 * layer to `src/ir/js-tag.ts` (it is consumed by IR core files, so it must not
 * live in `src/codegen/`). This re-export is a one-cycle compatibility shim so
 * any in-flight branch still importing `codegen/js-tag` keeps compiling while it
 * rebases; the #2855/#2856 IR-migration branches actively edit the IR importers.
 * New code MUST import from `../ir/js-tag.js` (or, in codegen, keep using the
 * `value-tags.ts` re-export). Remove this shim once the in-flight branches land.
 */
export { JsTag, jsTagUnboxKind } from "../ir/js-tag.js";
