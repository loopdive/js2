# R6 family 3 — per-shape lane measurement (origin/main 33ea8606aa, 2026-09-02T13:43:10.134Z)

Lanes: `gc-host` = `{}`, `gc-strict-no-host` = `{"strictNoHostImports":true}`, `standalone` = `{"target":"standalone"}`, `wasi` = `{"target":"wasi"}`. All compiles: `trackIrOutcomes: true, emitWat: false`.

## Success / IR-claim / bytes

| shape | gc-host | gc-strict-no-host | standalone | wasi |
|---|---|---|---|---|
| 01-direct-call | ok IR 2/2 183B | ok IR 2/2 22017B | ok IR 2/2 22632B | ok IR 2/2 22659B |
| 02-indirect-call-var | ok LEGACY 2/3 9974B | ok LEGACY 2/3 42469B | ok LEGACY 2/3 60149B | ok LEGACY 2/3 60016B |
| 03-closure-mutable-local | ok LEGACY 0/1 3282B | ok LEGACY 0/1 33003B | ok LEGACY 0/1 51773B | ok LEGACY 0/1 51725B |
| 04-closure-param | ok IR 1/1 2990B | ok IR 1/1 33007B | ok IR 1/1 33030B | ok IR 1/1 33057B |
| 05-returned-closure | ok LEGACY 0/2 5942B | ok LEGACY 0/2 36555B | ok LEGACY 0/2 54660B | ok LEGACY 0/2 54634B |
| 06-bind | ok LEGACY 0/2 3890B | ok LEGACY 0/2 99725B | ok LEGACY 0/2 132257B | ok LEGACY 0/2 107031B |
| 07-call-apply | ok LEGACY 0/2 812B | ok LEGACY 0/2 22433B | ok LEGACY 0/2 22798B | ok LEGACY 0/2 22825B |
| 08-array-map-arrow | ok LEGACY 0/1 4333B | ok LEGACY 0/1 35716B | ok LEGACY 0/1 53572B | ok LEGACY 0/1 53498B |
| 09-host-callback-addEventListener | ok LEGACY 0/1 908B | ok LEGACY 0/1 93602B | ok LEGACY 0/1 50422B | FAIL LEGACY 0/1 0B |
| 09b-host-callback-pinned-b2 | ok LEGACY 0/1 849B | ok LEGACY 0/1 93617B | ok LEGACY 0/1 33180B | FAIL LEGACY 0/1 0B |
| 10-new-plain-function | ok LEGACY 0/2 6425B | ok LEGACY 0/2 100730B | ok LEGACY 0/2 131627B | ok LEGACY 0/2 102595B |
| 11-new-class | ok IR 3/3 1100B | ok IR 3/3 22697B | ok IR 3/3 23044B | ok IR 3/3 23071B |
| 12-higher-order | ok LEGACY 2/4 12005B | ok LEGACY 2/4 44173B | ok LEGACY 2/4 61517B | ok LEGACY 2/4 61330B |
| 13-recursion-local-ref | ok LEGACY 0/1 3288B | ok LEGACY 0/1 33431B | ok LEGACY 0/1 52211B | ok LEGACY 0/1 52150B |

Cell = success · IR/LEGACY verdict · ir-emitted terminal units / terminal units · wasm bytes.

## Imports per shape × lane (module.name)

### 01-direct-call

- **gc-host** (0): _none_
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_

### 02-indirect-call-var

- **gc-host** (8): `env.__box_number`, `env.__call_function_0`, `env.__call_function_1`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__new_TypeError`, `env.__unbox_number`
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- gc-strict-no-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- standalone unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- wasi unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`

### 03-closure-mutable-local

- **gc-host** (6): `env.__call_function_1`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__new_TypeError`, `env.__unbox_number`
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- gc-strict-no-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- standalone unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- wasi unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`

### 04-closure-param

- **gc-host** (6): `env.__box_number`, `env.__call_function_1`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__unbox_number`
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_

### 05-returned-closure

- **gc-host** (10): `env.__box_number`, `env.__call_function`, `env.__call_function_0`, `env.__call_function_1`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__js_array_new`, `env.__new_TypeError`, `env.__unbox_number`
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `makeCounter: unsupported/select/body-shape-rejected — makeCounter rejected by IR selection (body-shape-rejected)`; `entry: unsupported/select/call-graph-closure — entry rejected by IR selection (call-graph-closure)`
- gc-strict-no-host unsupported: `makeCounter: unsupported/select/body-shape-rejected — makeCounter rejected by IR selection (body-shape-rejected)`; `entry: unsupported/select/call-graph-closure — entry rejected by IR selection (call-graph-closure)`
- gc-strict-no-host errors: `[warning] L0: Host import "env.__js_array_new" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-a`; `[warning] L0: Host import "env.__js_array_push" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-`; `[warning] L0: Host import "env.__js_array_new" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-a`; `[warning] L0: Host import "env.__js_array_push" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-`; `[warning] L0: Host import "env.__js_array_new" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-a`; `[warning] L0: Host import "env.__js_array_push" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-`
- standalone unsupported: `makeCounter: unsupported/select/body-shape-rejected — makeCounter rejected by IR selection (body-shape-rejected)`; `entry: unsupported/select/call-graph-closure — entry rejected by IR selection (call-graph-closure)`
- wasi unsupported: `makeCounter: unsupported/select/body-shape-rejected — makeCounter rejected by IR selection (body-shape-rejected)`; `entry: unsupported/select/call-graph-closure — entry rejected by IR selection (call-graph-closure)`

### 06-bind

- **gc-host** (10): `env.__bind_function`, `env.__box_number`, `env.__call_function`, `env.__call_function_1`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__js_array_new`, `env.__js_array_push`, `env.__unbox_number`
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- gc-strict-no-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- standalone unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- wasi unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`

### 07-call-apply

- **gc-host** (0): _none_
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `entry: unsupported/select/function-invocation-method-unsupported — entry rejected by IR selection (function-invocation-method-unsupported)`
- gc-strict-no-host unsupported: `entry: unsupported/select/function-invocation-method-unsupported — entry rejected by IR selection (function-invocation-method-unsupported)`
- standalone unsupported: `entry: unsupported/select/function-invocation-method-unsupported — entry rejected by IR selection (function-invocation-method-unsupported)`
- wasi unsupported: `entry: unsupported/select/function-invocation-method-unsupported — entry rejected by IR selection (function-invocation-method-unsupported)`

### 08-array-map-arrow

- **gc-host** (7): `env.__box_number`, `env.__call_function_1`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__new_TypeError`, `env.__unbox_number`
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `entry: unsupported/select/array-method-unsupported — entry rejected by IR selection (array-method-unsupported)`
- gc-strict-no-host unsupported: `entry: unsupported/select/array-method-unsupported — entry rejected by IR selection (array-method-unsupported)`
- standalone unsupported: `entry: unsupported/select/array-method-unsupported — entry rejected by IR selection (array-method-unsupported)`
- wasi unsupported: `entry: unsupported/select/array-method-unsupported — entry rejected by IR selection (array-method-unsupported)`

### 09-host-callback-addEventListener

- **gc-host** (5): `env.Element_set_textContent`, `env.EventTarget_addEventListener`, `env.__call_function_0`, `env.__make_callback`, `env.number_toString`
- **gc-strict-no-host** (0): _none_
- **standalone** (2): `env.Element_set_textContent`, `env.EventTarget_addEventListener`
- **wasi** (0): _none_
- gc-strict-no-host unsupported: `install: unsupported/select/body-shape-rejected — install rejected by IR selection (body-shape-rejected)`
- gc-strict-no-host errors: `[warning] L0: Host import "env.eval" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.isNaN" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.isFinite" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.alert" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.blur" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.cancelIdleCallback" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-impo`; `[warning] L0: Host import "env.captureEvents" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-al`; `[warning] L0: Host import "env.close" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.confirm" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlis`; `[warning] L0: Host import "env.focus" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.getComputedStyle" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import`; `[warning] L0: Host import "env.getSelection" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-all`; `[warning] L0: Host import "env.matchMedia" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allow`; `[warning] L0: Host import "env.moveBy" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.moveTo" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.open" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.postMessage" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allo`; `[warning] L0: Host import "env.postMessage" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allo`; `[warning] L0: Host import "env.print" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.prompt" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.releaseEvents" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-al`; `[warning] L0: Host import "env.requestIdleCallback" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-imp`; `[warning] L0: Host import "env.resizeBy" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.resizeTo" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.scroll" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.scroll" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.scrollBy" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.scrollBy" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.scrollTo" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.scrollTo" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.stop" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.toString" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.dispatchEvent" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-al`; `[warning] L0: Host import "env.cancelAnimationFrame" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-im`; `[warning] L0: Host import "env.requestAnimationFrame" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-i`; `[warning] L0: Host import "env.atob" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.btoa" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.clearInterval" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-al`; `[warning] L0: Host import "env.clearTimeout" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-all`; `[warning] L0: Host import "env.createImageBitmap" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-impor`; `[warning] L0: Host import "env.createImageBitmap" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-impor`; `[warning] L0: Host import "env.fetch" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.queueMicrotask" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-a`; `[warning] L0: Host import "env.reportError" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allo`; `[warning] L0: Host import "env.setInterval" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allo`; `[warning] L0: Host import "env.setTimeout" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allow`; `[warning] L0: Host import "env.structuredClone" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-`; `[warning] L0: Host import "env.addEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import`; `[warning] L0: Host import "env.addEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import`; `[warning] L0: Host import "env.removeEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-imp`; `[warning] L0: Host import "env.removeEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-imp`; `[warning] L0: Host import "env.EventTarget_addEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen`; `[warning] L0: Host import "env.Element_set_textContent" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host`
- standalone unsupported: `install: unsupported/select/body-shape-rejected — install rejected by IR selection (body-shape-rejected)`
- standalone errors: `[warning] L3: Host import leak (warning, #2961): host import "env.EventTarget_addEventListener" survives into the finished --target standalone binary and would fail instantia`; `[warning] L3: Host import leak (warning, #2961): host import "env.Element_set_textContent" survives into the finished --target standalone binary and would fail instantiation `
- wasi unsupported: `install: unsupported/select/body-shape-rejected — install rejected by IR selection (body-shape-rejected)`
- wasi errors: `[error] L1: Codegen error: DOM global 'EventTarget' is not available in WASI target — DOM requires a browser host`; `[error] L1: Codegen error: DOM global 'HTMLElement' is not available in WASI target — DOM requires a browser host`; `[warning] L0: Host import "env.EventTarget_addEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen`; `[warning] L0: Host import "env.Element_set_textContent" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host`

### 09b-host-callback-pinned-b2

- **gc-host** (4): `env.Element_set_textContent`, `env.EventTarget_addEventListener`, `env.__call_function_0`, `env.__make_callback`
- **gc-strict-no-host** (0): _none_
- **standalone** (2): `env.Element_set_textContent`, `env.EventTarget_addEventListener`
- **wasi** (0): _none_
- gc-strict-no-host unsupported: `install: unsupported/select/body-shape-rejected — install rejected by IR selection (body-shape-rejected)`
- gc-strict-no-host errors: `[warning] L0: Host import "env.eval" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.isNaN" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.isFinite" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.alert" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.blur" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.cancelIdleCallback" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-impo`; `[warning] L0: Host import "env.captureEvents" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-al`; `[warning] L0: Host import "env.close" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.confirm" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlis`; `[warning] L0: Host import "env.focus" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.getComputedStyle" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import`; `[warning] L0: Host import "env.getSelection" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-all`; `[warning] L0: Host import "env.matchMedia" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allow`; `[warning] L0: Host import "env.moveBy" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.moveTo" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.open" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.postMessage" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allo`; `[warning] L0: Host import "env.postMessage" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allo`; `[warning] L0: Host import "env.print" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.prompt" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.releaseEvents" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-al`; `[warning] L0: Host import "env.requestIdleCallback" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-imp`; `[warning] L0: Host import "env.resizeBy" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.resizeTo" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.scroll" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.scroll" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist`; `[warning] L0: Host import "env.scrollBy" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.scrollBy" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.scrollTo" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.scrollTo" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.stop" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.toString" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowli`; `[warning] L0: Host import "env.dispatchEvent" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-al`; `[warning] L0: Host import "env.cancelAnimationFrame" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-im`; `[warning] L0: Host import "env.requestAnimationFrame" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-i`; `[warning] L0: Host import "env.atob" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.btoa" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.t`; `[warning] L0: Host import "env.clearInterval" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-al`; `[warning] L0: Host import "env.clearTimeout" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-all`; `[warning] L0: Host import "env.createImageBitmap" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-impor`; `[warning] L0: Host import "env.createImageBitmap" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-impor`; `[warning] L0: Host import "env.fetch" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allowlist.`; `[warning] L0: Host import "env.queueMicrotask" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-a`; `[warning] L0: Host import "env.reportError" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allo`; `[warning] L0: Host import "env.setInterval" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allo`; `[warning] L0: Host import "env.setTimeout" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-allow`; `[warning] L0: Host import "env.structuredClone" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-`; `[warning] L0: Host import "env.addEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import`; `[warning] L0: Host import "env.addEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import`; `[warning] L0: Host import "env.removeEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-imp`; `[warning] L0: Host import "env.removeEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-imp`; `[warning] L0: Host import "env.EventTarget_addEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen`; `[warning] L0: Host import "env.Element_set_textContent" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host`
- standalone unsupported: `install: unsupported/select/body-shape-rejected — install rejected by IR selection (body-shape-rejected)`
- standalone errors: `[warning] L3: Host import leak (warning, #2961): host import "env.EventTarget_addEventListener" survives into the finished --target standalone binary and would fail instantia`; `[warning] L3: Host import leak (warning, #2961): host import "env.Element_set_textContent" survives into the finished --target standalone binary and would fail instantiation `
- wasi unsupported: `install: unsupported/select/body-shape-rejected — install rejected by IR selection (body-shape-rejected)`
- wasi errors: `[error] L1: Codegen error: DOM global 'EventTarget' is not available in WASI target — DOM requires a browser host`; `[error] L1: Codegen error: DOM global 'HTMLElement' is not available in WASI target — DOM requires a browser host`; `[warning] L0: Host import "env.EventTarget_addEventListener" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen`; `[warning] L0: Host import "env.Element_set_textContent" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host`

### 10-new-plain-function

- **gc-host** (8): `env.__box_number`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__extern_get`, `env.__extern_set_strict`, `env.__register_fnctor_instance`, `env.__unbox_number`
- **gc-strict-no-host** (1): `env.__register_fnctor_instance`
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- gc-strict-no-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- standalone unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- wasi unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`

### 11-new-class

- **gc-host** (0): _none_
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_

### 12-higher-order

- **gc-host** (11): `env.__box_number`, `env.__call_function`, `env.__call_function_0`, `env.__call_function_1`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__js_array_new`, `env.__js_array_push`, `env.__new_TypeError`, `env.__unbox_number`
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- gc-strict-no-host unsupported: `compose: unsupported/select/call-graph-closure — compose rejected by IR selection (call-graph-closure)`; `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- gc-strict-no-host errors: `[warning] L0: Host import "env.__js_array_new" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-a`; `[warning] L0: Host import "env.__js_array_push" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-`; `[warning] L0: Host import "env.__js_array_new" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-a`; `[warning] L0: Host import "env.__js_array_push" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-`; `[warning] L0: Host import "env.__js_array_new" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-a`; `[warning] L0: Host import "env.__js_array_push" requested under --no-host-imports / WASI strict mode, but the name is not on the dual-mode allowlist (src/codegen/host-import-`
- standalone unsupported: `compose: unsupported/select/call-graph-closure — compose rejected by IR selection (call-graph-closure)`; `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`
- wasi unsupported: `compose: unsupported/select/call-graph-closure — compose rejected by IR selection (call-graph-closure)`; `entry: unsupported/select/body-shape-rejected — entry rejected by IR selection (body-shape-rejected)`

### 13-recursion-local-ref

- **gc-host** (7): `env.__box_number`, `env.__call_function_1`, `env.__call_function_2`, `env.__call_function_3`, `env.__call_function_4`, `env.__new_TypeError`, `env.__unbox_number`
- **gc-strict-no-host** (0): _none_
- **standalone** (0): _none_
- **wasi** (0): _none_
- gc-host unsupported: `entry: unsupported/select/call-resolution-unsupported — entry rejected by IR selection (call-resolution-unsupported)`
- gc-strict-no-host unsupported: `entry: unsupported/select/call-resolution-unsupported — entry rejected by IR selection (call-resolution-unsupported)`
- standalone unsupported: `entry: unsupported/select/call-resolution-unsupported — entry rejected by IR selection (call-resolution-unsupported)`
- wasi unsupported: `entry: unsupported/select/call-resolution-unsupported — entry rejected by IR selection (call-resolution-unsupported)`

## Terminal units per shape (gc-host lane)

| shape | unit | kind | outcome | stage | code |
|---|---|---|---|---|---|
| 01-direct-call | add | function | emitted (ir) | patch |  |
| 01-direct-call | entry | function | emitted (ir) | patch |  |
| 01-direct-call | <module-init> | module-init | non-executable | select |  |
| 02-indirect-call-var | inc | function | emitted (ir) | patch |  |
| 02-indirect-call-var | dbl | function | emitted (ir) | patch |  |
| 02-indirect-call-var | entry | function | unsupported (legacy) | select | body-shape-rejected |
| 02-indirect-call-var | <module-init> | module-init | non-executable | select |  |
| 03-closure-mutable-local | entry | function | unsupported (legacy) | select | body-shape-rejected |
| 03-closure-mutable-local | <module-init> | module-init | non-executable | select |  |
| 04-closure-param | entry | function | emitted (ir) | patch |  |
| 04-closure-param | <module-init> | module-init | non-executable | select |  |
| 05-returned-closure | makeCounter | function | unsupported (legacy) | select | body-shape-rejected |
| 05-returned-closure | entry | function | unsupported (legacy) | select | call-graph-closure |
| 05-returned-closure | <module-init> | module-init | non-executable | select |  |
| 06-bind | scale | function | emitted (ir) (legacy) | patch |  |
| 06-bind | entry | function | unsupported (legacy) | select | body-shape-rejected |
| 06-bind | <module-init> | module-init | non-executable | select |  |
| 07-call-apply | sum3 | function | emitted (ir) (legacy) | patch |  |
| 07-call-apply | entry | function | unsupported (legacy) | select | function-invocation-method-unsupported |
| 07-call-apply | <module-init> | module-init | non-executable | select |  |
| 08-array-map-arrow | entry | function | unsupported (legacy) | select | array-method-unsupported |
| 08-array-map-arrow | <module-init> | module-init | non-executable | select |  |
| 09-host-callback-addEventListener | install | function | emitted (ir) (legacy) | patch |  |
| 09-host-callback-addEventListener | <module-init> | module-init | non-executable | select |  |
| 09b-host-callback-pinned-b2 | install | function | emitted (ir) (legacy) | patch |  |
| 09b-host-callback-pinned-b2 | <module-init> | module-init | non-executable | select |  |
| 10-new-plain-function | Point | function | emitted (ir) (legacy) | patch |  |
| 10-new-plain-function | entry | function | unsupported (legacy) | select | body-shape-rejected |
| 10-new-plain-function | <module-init> | module-init | non-executable | select |  |
| 11-new-class | Vec_new | class-member | emitted (ir) | patch |  |
| 11-new-class | Vec_len2 | class-member | emitted (ir) | patch |  |
| 11-new-class | entry | function | emitted (ir) | patch |  |
| 11-new-class | <module-init> | module-init | non-executable | select |  |
| 12-higher-order | compose | function | emitted (ir) (legacy) | patch |  |
| 12-higher-order | inc | function | emitted (ir) | patch |  |
| 12-higher-order | dbl | function | emitted (ir) | patch |  |
| 12-higher-order | entry | function | unsupported (legacy) | select | body-shape-rejected |
| 12-higher-order | <module-init> | module-init | non-executable | select |  |
| 13-recursion-local-ref | entry | function | unsupported (legacy) | select | call-resolution-unsupported |
| 13-recursion-local-ref | <module-init> | module-init | non-executable | select |  |
