#!/usr/bin/env node
/**
 * extract-abi.mjs — read QuickJS's value encodings OUT OF the built artifact
 * and emit them as JSON (#4236 ABI note 3).
 *
 * QuickJS's internal layouts are not a stable ABI: NaN boxing is chosen by
 * pointer width, the float64 addend derives from JS_TAG_FIRST, and tag numbers
 * move between versions. Hardcoding any of that in js2wasm codegen would be a
 * silent-miscompilation bug waiting for the next version bump. So the artifact
 * exports the constants of the build you actually linked, and this script
 * calls them.
 *
 * Usage: node extract-abi.mjs <libquickjs.wasm>   # JSON on stdout
 */
import { readFileSync } from "node:fs";
import { instantiateArtifact } from "./wasi-stub.mjs";

const path = process.argv[2];
if (!path) {
  console.error("usage: extract-abi.mjs <libquickjs.wasm>");
  process.exit(2);
}

const bytes = readFileSync(path);
const { instance } = await instantiateArtifact(bytes);
const ex = instance.exports;

const call = (n) => {
  const f = ex[n];
  if (typeof f !== "function") throw new Error(`artifact does not export ${n}`);
  const v = f();
  return typeof v === "bigint" ? Number(v) : v;
};

const tags = {};
for (const name of Object.keys(ex)) {
  if (name.startsWith("qjs_abi_tag_") && name !== "qjs_abi_tag_offset") {
    tags[name.slice("qjs_abi_tag_".length).toUpperCase()] = call(name);
  }
}

const abi = {
  abiVersion: call("qjs_abi_version"),
  quickjs: {
    major: call("qjs_abi_qjs_version_major"),
    minor: call("qjs_abi_qjs_version_minor"),
    patch: call("qjs_abi_qjs_version_patch"),
  },
  value: {
    nanBoxing: call("qjs_abi_nan_boxing") === 1,
    jsValueSize: call("qjs_abi_jsvalue_size"),
    handleSize: call("qjs_abi_handle_size"),
    // Byte offsets within the 8-byte handle cell; codegen may open-code
    // `i32.load offset=tagOffset` instead of calling qjs_tag.
    tagOffset: call("qjs_abi_tag_offset"),
    payloadOffset: call("qjs_abi_payload_offset"),
    // double bits === rawJSValue + (float64TagAddend << 32)
    float64TagAddend: call("qjs_abi_float64_tag_addend"),
  },
  tags,
  // Derived predicate, stated once so codegen doesn't re-derive it:
  // a NaN-boxed value is a float64 iff (unsigned)(tag - TAG_FIRST) >= (TAG_FLOAT64 - TAG_FIRST)
  isFloat64Predicate: {
    kind: "unsigned-ge",
    subtrahend: tags.FIRST,
    threshold: tags.FLOAT64 - tags.FIRST,
  },
  imports: WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map((i) => `${i.module}.${i.name}`),
};

console.log(JSON.stringify(abi, null, 2));
