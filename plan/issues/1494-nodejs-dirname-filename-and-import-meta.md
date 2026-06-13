---
id: 1494
title: "nodejs: __dirname / __filename / import.meta.url for compiled modules"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: host-imports
goal: nodejs-support
sprint: 52
related: [1491, 1044]
---
# #1494 — `__dirname` / `__filename` / `import.meta.url` for compiled modules

## Problem

Compiled TypeScript has no way to obtain the path of the running script.
`__dirname` and `__filename` (CJS) and `import.meta.url` (ESM) all fall
through to `declare const` stubs and resolve to `undefined` at run time. The
compiler doesn't recognise any of them as a special form.

This breaks the **most common file-relative pattern** in Node:

```ts
const config = readFileSync(path.join(__dirname, "config.json"), "utf-8");
```

Without `__dirname` users must hard-code absolute paths or pass them through
`process.argv`, neither of which is portable.

`import.meta.url` is also tied to `import` semantics — currently `import.
meta` is not parsed at all (the compiler emits "unsupported expression"). It
should at least surface `import.meta.url` as a string.

## Use case

```ts
import { readFileSync } from "node:fs";

function loadDefaultConfig(): string {
  // resolve a file next to the compiled wasm/js loader
  return readFileSync(`${__dirname}/default.config.json`, "utf-8");
}
console.log(loadDefaultConfig());
```

Or with ESM:

```ts
function loadDefaultConfig(): string {
  const dir = new URL(".", import.meta.url).pathname;
  return readFileSync(`${dir}default.config.json`, "utf-8");
}
```

This is **required** for any library that ships data files alongside its JS
(templates, locales, native binaries, etc.).

## Implementation plan

1. **Recognise `__dirname` / `__filename` / `import.meta.url`** in the AST
   walker. They are not special-cased today; treat them as host-imported
   globals.

2. **`src/index.ts`**: add three `ImportIntent` variants (or reuse
   `declared_global`):
   - `{ type: "node_dirname" }`
   - `{ type: "node_filename" }`
   - `{ type: "node_import_meta_url" }`

3. **`src/runtime.ts`** `resolveImport` (≈line 1700 switch): bind each to
   the host's value at instantiation time:

   ```ts
   case "node_dirname":
     return () => deps?.__dirname
       ?? (typeof __dirname !== "undefined" ? __dirname : undefined);
   case "node_filename":
     return () => deps?.__filename
       ?? (typeof __filename !== "undefined" ? __filename : undefined);
   case "node_import_meta_url":
     return () => deps?.importMetaUrl ?? undefined;
   ```

   The `deps` override lets the generated `run.mjs` pass these in
   explicitly, since the compiled Wasm doesn't know where its caller lives:

   ```js
   // generated run.mjs
   const imports = createImports({
     __dirname: path.dirname(fileURLToPath(import.meta.url)),
     __filename: fileURLToPath(import.meta.url),
     importMetaUrl: import.meta.url,
   });
   ```

4. **`src/codegen/expressions/identifiers.ts` / member-access**: when the
   identifier is `__dirname` or `__filename`, or when the expression is
   `import.meta.url` (PropertyAccess on MetaProperty), emit a call to the
   corresponding host import. Result type is externref (string).

5. **`src/codegen/index.ts`** generated importsHelper: emit a `createImports`
   parameter that accepts `{ __dirname?, __filename?, importMetaUrl? }`,
   defaulting to `process.cwd()` if unset (mirrors `node --eval` behaviour).

6. **TypeScript shim**: add `declare const __dirname: string; declare const
   __filename: string;` to the bundled `lib.d.ts` so source compiles
   cleanly. `import.meta` requires `module=esnext` in tsconfig and is
   already typed by `lib.es2020.full.d.ts`.

## Acceptance criteria

```ts
console.log(typeof __dirname);   // "string"
console.log(typeof __filename);  // "string"
console.log(__filename.endsWith(".wasm") || __filename.endsWith(".mjs")); // true
```

Plus a directory-relative read after #1491 lands:

```ts
import { readFileSync } from "node:fs";
const here = readFileSync(`${__dirname}/fixture.txt`, "utf-8");
console.log(here.length);
```

Equivalence test: assert `__dirname` matches `path.dirname(process.argv[1])`
when run through the generated `run.mjs`.

## Files to modify

- `src/index.ts` — three new `ImportIntent` variants.
- `src/runtime.ts` (≈line 1700) — `resolveImport` cases bound to `deps`.
- `src/codegen/expressions/identifiers.ts` — recognise `__dirname` /
  `__filename`.
- `src/codegen/expressions/index.ts` or member-access — recognise
  `import.meta.url` MetaProperty.
- `src/codegen/index.ts` (importsHelper emission) — extend `createImports`
  signature with `__dirname?/__filename?/importMetaUrl?`.
- `tests/equivalence.test.ts` — new "module-relative paths" block.
