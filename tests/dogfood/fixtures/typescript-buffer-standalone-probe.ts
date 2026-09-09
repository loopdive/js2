// Run setupTypescriptRuntime() before compiling this diagnostic fixture.
import { Buffer } from "../.npm-compat/typescript-runtime/buffer/package/index.js";
import { fromByteArray } from "../.npm-compat/typescript-runtime/base64-js/package/index.js";

export function runDirectBase64Oracle(): number {
  return fromByteArray([104, 195, 169]) === "aMOp" ? 1 : 0;
}

export function runBufferUtf8Oracle(): number {
  return Buffer.from("hé", "utf8").toString() === "hé" ? 1 : 0;
}

export function runBufferMethodIdentity(): number {
  return Buffer.from("hé", "utf8").toString === Buffer.prototype.toString ? 1 : 0;
}

export function runBufferMethodTypes(): number {
  const b = Buffer.from("hé", "utf8");
  return (
    (typeof Buffer.prototype.toString === "function" ? 1 : 0) +
    (typeof b.toString === "function" ? 2 : 0) +
    (typeof Buffer.prototype.write === "function" ? 4 : 0)
  );
}

export function runBufferDirectToString(): number {
  return Buffer.prototype.toString.call(Buffer.from("hé", "utf8"), "base64") === "aMOp" ? 1 : 0;
}

export function runBufferDirectStringShape(): number {
  const result = Buffer.prototype.toString.call(Buffer.from("hé", "utf8"), "base64");
  if (typeof result !== "string") return -1;
  return result.length + result.charCodeAt(0) * 1000 + result.charCodeAt(1) * 1000000;
}

export function runBufferBase64ErrorShape(): number {
  try {
    Buffer.from("hé", "utf8").toString("base64");
    return 0;
  } catch (error) {
    const message = error.message;
    if (typeof message !== "string") return -1;
    return message.length + message.charCodeAt(0) * 1000 + message.charCodeAt(1) * 1000000;
  }
}

export function runBufferOracle(): number {
  const bytes = Buffer.from("hé", "utf8");
  if (bytes.length !== 3 || bytes[0] !== 104 || bytes[1] !== 195 || bytes[2] !== 169) return 0;
  return bytes.toString("base64") === "aMOp" ? 1 : 0;
}

export function runByteLength(): number {
  return Buffer.from("hé", "utf8").length;
}
export function runComputedLength(): number {
  return Buffer.byteLength("hé", "utf8");
}
export function runAllocatedLength(): number {
  return Buffer.alloc(3).length;
}
export function runArrayByte(): number {
  return Buffer.from([104, 195, 169])[0];
}
export function runTypedArraySupport(): number {
  return Buffer.TYPED_ARRAY_SUPPORT ? 1 : 0;
}
export function runByte0(): number {
  return Buffer.from("hé", "utf8")[0];
}
export function runByte1(): number {
  return Buffer.from("hé", "utf8")[1];
}
export function runByte2(): number {
  return Buffer.from("hé", "utf8")[2];
}
export function runBase64Oracle(): number {
  return Buffer.from("hé", "utf8").toString("base64") === "aMOp" ? 1 : 0;
}
