// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVAL_EXPORT_NAME,
  MEMORY_PAGES,
  OUTPUT_OFFSET,
  SOURCE_CAPACITY,
  SOURCE_OFFSET,
  buildRuntimeEvalBroker,
} from "./broker.mjs";
import { compileEvalExpression } from "./compiler.mjs";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function checkedRange(memory, pointer, length, label) {
  if (!Number.isInteger(pointer) || !Number.isInteger(length) || pointer < 0 || length < 0) {
    throw new RangeError(`${label}: invalid memory range`);
  }
  if (pointer + length > memory.buffer.byteLength) {
    throw new RangeError(`${label}: memory range is out of bounds`);
  }
}

function readBytes(memory, pointer, length, label) {
  checkedRange(memory, pointer, length, label);
  return new Uint8Array(memory.buffer, pointer, length).slice();
}

function readString(memory, pointer, length, label) {
  return textDecoder.decode(readBytes(memory, pointer, length, label));
}

/** Build the JavaScript provider for the broker's host-neutral import ABI. */
export async function createJavaScriptSideModuleHost() {
  const memory = new WebAssembly.Memory({ initial: MEMORY_PAGES });
  let compileCount = 0;
  let lastSideModuleBytes = null;

  const imports = {
    WebAssembly: {
      memory,
      Module(pointer, length) {
        const bytes = readBytes(memory, pointer, length, "WebAssembly.Module");
        return new WebAssembly.Module(bytes);
      },
      Instance(module) {
        if (!(module instanceof WebAssembly.Module)) {
          throw new TypeError("WebAssembly.Instance expects a WebAssembly.Module");
        }
        return new WebAssembly.Instance(module, {});
      },
    },
    "WebAssembly.Instance": {
      callExportF64(instance, namePointer, nameLength) {
        if (!(instance instanceof WebAssembly.Instance)) {
          throw new TypeError("callExportF64 expects a WebAssembly.Instance");
        }
        const name = readString(memory, namePointer, nameLength, "callExportF64 export name");
        const fn = instance.exports[name];
        if (typeof fn !== "function") throw new TypeError(`side module export ${name} is not callable`);
        const result = fn();
        if (typeof result !== "number") throw new TypeError(`side module export ${name} is not numeric`);
        return result;
      },
    },
    "js2wasm:compiler": {
      compileEval(sourcePointer, sourceLength, outputPointer, outputCapacity) {
        const source = readString(memory, sourcePointer, sourceLength, "compileEval source");
        const binary = compileEvalExpression(source);
        checkedRange(memory, outputPointer, outputCapacity, "compileEval output");
        if (binary.length > outputCapacity) {
          throw new RangeError(`compiled side module is ${binary.length} B; capacity is ${outputCapacity} B`);
        }
        new Uint8Array(memory.buffer, outputPointer, binary.length).set(binary);
        compileCount += 1;
        lastSideModuleBytes = binary.slice();
        return binary.length;
      },
    },
  };

  const brokerBytes = buildRuntimeEvalBroker();
  const { instance } = await WebAssembly.instantiate(brokerBytes, imports);
  const evalF64 = instance.exports.evalF64;
  if (typeof evalF64 !== "function") throw new Error("broker does not export evalF64");

  return {
    async evaluate(source) {
      const encoded = textEncoder.encode(source);
      if (encoded.length > SOURCE_CAPACITY) {
        throw new RangeError(`eval source exceeds ${SOURCE_CAPACITY} byte proof-of-concept limit`);
      }
      new Uint8Array(memory.buffer, SOURCE_OFFSET, encoded.length).set(encoded);
      return evalF64(SOURCE_OFFSET, encoded.length);
    },
    memory,
    telemetry() {
      return {
        compileCount,
        lastSideModuleBytes: lastSideModuleBytes?.slice() ?? null,
      };
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = process.argv.slice(2).join(" ") || "6 * 7";
  const host = await createJavaScriptSideModuleHost();
  const result = await host.evaluate(source);
  const { compileCount, lastSideModuleBytes } = host.telemetry();
  console.log(
    JSON.stringify({
      host: "javascript",
      source,
      result,
      compileCount,
      sideModuleBytes: lastSideModuleBytes?.length ?? 0,
      export: EVAL_EXPORT_NAME,
      outputOffset: OUTPUT_OFFSET,
    }),
  );
}
