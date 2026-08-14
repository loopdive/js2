// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3630 runtime-eval side-module broker.
 *
 * The broker deliberately models the narrow part of the JavaScript
 * WebAssembly API that eval needs. `externref` carries the host's real Module
 * and Instance objects, so JavaScript and native embedders implement the same
 * core-Wasm import contract without a shared integer handle table.
 */
import binaryen from "binaryen";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_OFFSET = 0;
export const SOURCE_CAPACITY = 32 * 1024;
export const EXPORT_NAME_OFFSET = 32 * 1024;
export const OUTPUT_OFFSET = 64 * 1024;
export const MEMORY_PAGES = 64;
export const OUTPUT_CAPACITY = MEMORY_PAGES * 64 * 1024 - OUTPUT_OFFSET;
export const EVAL_EXPORT_NAME = "__eval_result";

export const RUNTIME_EVAL_BROKER_WAT = `(module
  ;; One memory is shared by the broker and its host providers. The compiled
  ;; side module is standalone and therefore does not import this memory.
  (import "WebAssembly" "memory" (memory ${MEMORY_PAGES}))

  ;; Compiler capability: source bytes in, standalone Wasm bytes out.
  (import "js2wasm:compiler" "compileEval"
    (func $compileEval (param i32 i32 i32 i32) (result i32)))

  ;; Narrow WebAssembly object API. Module and Instance are opaque externrefs
  ;; whose concrete representation belongs entirely to the embedding host.
  (import "WebAssembly" "Module"
    (func $Module (param i32 i32) (result externref)))
  (import "WebAssembly" "Instance"
    (func $Instance (param externref) (result externref)))
  (import "WebAssembly.Instance" "callExportF64"
    (func $callExportF64 (param externref i32 i32) (result f64)))

  (export "memory" (memory 0))
  (data (i32.const ${EXPORT_NAME_OFFSET}) "${EVAL_EXPORT_NAME}")

  (func (export "evalF64") (param $sourcePtr i32) (param $sourceLen i32) (result f64)
    (local $wasmLen i32)
    (local $module externref)
    (local $instance externref)

    (local.set $wasmLen
      (call $compileEval
        (local.get $sourcePtr)
        (local.get $sourceLen)
        (i32.const ${OUTPUT_OFFSET})
        (i32.const ${OUTPUT_CAPACITY})))
    (if (i32.le_s (local.get $wasmLen) (i32.const 0)) (then unreachable))

    (local.set $module
      (call $Module (i32.const ${OUTPUT_OFFSET}) (local.get $wasmLen)))
    (local.set $instance (call $Instance (local.get $module)))
    (call $callExportF64
      (local.get $instance)
      (i32.const ${EXPORT_NAME_OFFSET})
      (i32.const ${EVAL_EXPORT_NAME.length}))))`;

export function buildRuntimeEvalBroker() {
  const module = binaryen.parseText(RUNTIME_EVAL_BROKER_WAT);
  module.setFeatures(binaryen.Features.All);
  if (!module.validate()) {
    module.dispose();
    throw new Error("runtime-eval side-module broker: Binaryen validation failed");
  }
  const binary = module.emitBinary();
  module.dispose();
  return binary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const outputPath = process.argv[2] ? resolve(process.argv[2]) : resolve(here, "broker.wasm");
  const binary = buildRuntimeEvalBroker();
  writeFileSync(outputPath, binary);
  console.log(`wrote ${outputPath} (${binary.length} B)`);
}
