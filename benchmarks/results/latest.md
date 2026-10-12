# js2wasm Benchmark Results

Date: 2026-10-12
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.025ms | 0.043ms | 0.036ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.013ms | gc-native |
| string/includes | 0.015ms | 0.095ms | 0.011ms | 0.032ms | gc-native |
| string/split | 0.325ms | 6.21ms | 2.07ms | FAILED | js |
| string/replace | 0.074ms | 0.463ms | 0.221ms | FAILED | js |
| string/case-convert | 0.045ms | 0.449ms | 0.189ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.135ms | 2.65ms | 1.88ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 2.01ms | 1.98ms | 0.433ms | js |
| array/push-pop | 1.32ms | 0.484ms | 0.481ms | FAILED | gc-native |
| array/sort-i32 | 0.657ms | 0.234ms | 0.278ms | FAILED | host-call |
| array/map-filter | 0.109ms | 0.053ms | 0.053ms | FAILED | host-call |
| array/reduce | 1.91ms | 0.508ms | 0.484ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.23ms | 2.23ms | FAILED | gc-native |
| array/slice | 0.034ms | 0.015ms | 0.015ms | FAILED | gc-native |
| array/reverse | 6.91ms | 3.08ms | 3.08ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.941ms | gc-native |
| dom/create-elements | 0.031ms | 0.080ms | — | — | js |
| dom/set-attributes | 0.087ms | 0.185ms | — | — | js |
| dom/read-attributes | 0.049ms | 0.104ms | — | — | js |
| dom/modify-text | 0.023ms | 0.091ms | — | — | js |
| mixed/csv-parse | 0.362ms | 6.22ms | 0.440ms | FAILED | js |
| mixed/text-search | 0.312ms | 3.54ms | 1.99ms | 0.872ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.253ms | js |
| mixed/matrix-multiply | 0.147ms | 50.82ms | 52.33ms | 0.561ms | js |
| mixed/sieve | 1.42ms | 1.82ms | 1.81ms | FAILED | js |

## Failed strategies

| Benchmark | Strategy | Phase | Error |
|-----------|----------|-------|-------|
| string/concat-short | linear-memory | warmup | memory access out of bounds |
| string/concat-long | linear-memory | warmup | memory access out of bounds |
| string/split | linear-memory | mid-loop | memory access out of bounds |
| string/replace | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/case-convert | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/substring | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| string/trim | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/push-pop | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/sort-i32 | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/map-filter | linear-memory | mid-loop | memory access out of bounds |
| array/reduce | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/indexOf | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/slice | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/reverse | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| array/forEach | linear-memory | setup | Compilation failed (fast=true, target=linear): |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.45 | 4.33 | 3.57 | — |
| string/concat-long | 1000 | 3.46 | 4.01 | 2.98 | — |
| string/indexOf | 1000 | 14.78 | 46.70 | 9.85 | 13.00 |
| string/includes | 1000 | 14.57 | 94.61 | 11.04 | 32.22 |
| string/split | 10000 | 32.50 | 620.78 | 207.03 | — |
| string/replace | 1000 | 73.87 | 462.96 | 221.26 | — |
| string/case-convert | 2000 | 22.66 | 224.71 | 94.47 | — |
| string/substring | 10000 | 8.14 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.46 | 264.77 | 187.72 | — |
| string/startsWith-endsWith | 20000 | 15.99 | 100.44 | 98.90 | 21.67 |
| array/map-filter | 30000 | 3.65 | 1.75 | 1.75 | — |
| array/indexOf | 1000 | 3460.95 | 2230.05 | 2229.19 | — |
| dom/create-elements | 2000 | 15.55 | 39.83 | — | — |
| dom/set-attributes | 6000 | 14.42 | 30.77 | — | — |
| dom/read-attributes | 3000 | 16.40 | 34.52 | — | — |
| dom/modify-text | 2000 | 11.69 | 45.44 | — | — |
| mixed/csv-parse | 11000 | 32.91 | 565.63 | 40.01 | — |
| mixed/text-search | 40000 | 7.81 | 88.60 | 49.87 | 21.81 |
| mixed/fibonacci | 10000 | 9.72 | 25.39 | 25.40 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.18 | 406.59 | 418.65 | 4.49 |
| mixed/sieve | 200000 | 7.11 | 9.10 | 9.04 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.77x slower | 1.46x slower | — |
| string/concat-long | 1.16x slower | 1.16x faster | — |
| string/indexOf | 3.16x slower | 1.50x faster | 1.14x faster |
| string/includes | 6.50x slower | 1.32x faster | 2.21x slower |
| string/split | 19.10x slower | 6.37x slower | — |
| string/replace | 6.27x slower | 3.00x slower | — |
| string/case-convert | 9.92x slower | 4.17x slower | — |
| string/substring | 2.64x faster | 3.05x faster | — |
| string/trim | 19.67x slower | 13.95x slower | — |
| string/startsWith-endsWith | 6.28x slower | 6.18x slower | 1.36x slower |
| array/push-pop | 2.74x faster | 2.75x faster | — |
| array/sort-i32 | 2.81x faster | 2.36x faster | — |
| array/map-filter | 2.08x faster | 2.08x faster | — |
| array/reduce | 3.77x faster | 3.96x faster | — |
| array/indexOf | 1.55x faster | 1.55x faster | — |
| array/slice | 2.32x faster | 2.36x faster | — |
| array/reverse | 2.24x faster | 2.24x faster | — |
| array/forEach | 1.90x faster | 1.89x faster | — |
| array/find | 17.82x faster | 17.83x faster | 4.42x slower |
| dom/create-elements | 2.56x slower | — | — |
| dom/set-attributes | 2.13x slower | — | — |
| dom/read-attributes | 2.10x slower | — | — |
| dom/modify-text | 3.89x slower | — | — |
| mixed/csv-parse | 17.19x slower | 1.22x slower | — |
| mixed/text-search | 11.34x slower | 6.38x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 345.85x slower | 356.10x slower | 3.82x slower |
| mixed/sieve | 1.28x slower | 1.27x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.35x faster |
| string/indexOf | 4.74x faster |
| string/includes | 8.57x faster |
| string/split | 3.00x faster |
| string/replace | 2.09x faster |
| string/case-convert | 2.38x faster |
| string/substring | 1.16x faster |
| string/trim | 1.41x faster |
| string/startsWith-endsWith | 1.02x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.19x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.05x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.00x faster |
| mixed/csv-parse | 14.14x faster |
| mixed/text-search | 1.78x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.03x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.8KB | 3.5KB | — |
| string/replace | 1.9KB | 4.4KB | — |
| string/case-convert | 1.8KB | 2.5KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.5KB | 3.1KB | — |
| string/startsWith-endsWith | 2.0KB | 4.0KB | 1.7KB |
| array/push-pop | 1.2KB | 1.6KB | — |
| array/sort-i32 | 3.3KB | 3.8KB | — |
| array/map-filter | 4.3KB | 4.8KB | — |
| array/reduce | 3.0KB | 3.5KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.4KB | 4.0KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 907.0ms | 511.2ms | — |
| string/concat-long | 362.9ms | 512.5ms | — |
| string/indexOf | 304.8ms | 518.4ms | 432.7ms |
| string/includes | 303.8ms | 518.3ms | 442.1ms |
| string/split | 428.6ms | 541.4ms | — |
| string/replace | 407.0ms | 573.1ms | — |
| string/case-convert | 403.0ms | 477.1ms | — |
| string/substring | 371.3ms | 381.3ms | — |
| string/trim | 387.6ms | 547.5ms | — |
| string/startsWith-endsWith | 382.5ms | 545.1ms | 488.3ms |
| array/push-pop | 403.1ms | 454.1ms | — |
| array/sort-i32 | 550.7ms | 607.1ms | — |
| array/map-filter | 572.0ms | 595.3ms | — |
| array/reduce | 491.2ms | 547.2ms | — |
| array/indexOf | 462.4ms | 513.9ms | — |
| array/slice | 410.1ms | 466.7ms | — |
| array/reverse | 400.4ms | 457.9ms | — |
| array/forEach | 502.1ms | 538.6ms | — |
| array/find | 383.3ms | 460.7ms | 434.6ms |
| dom/create-elements | 335.5ms | — | — |
| dom/set-attributes | 311.4ms | — | — |
| dom/read-attributes | 309.8ms | — | — |
| dom/modify-text | 306.0ms | — | — |
| mixed/csv-parse | 408.0ms | 527.7ms | — |
| mixed/text-search | 404.7ms | 536.6ms | 504.1ms |
| mixed/fibonacci | 362.1ms | 387.6ms | 381.7ms |
| mixed/matrix-multiply | 489.6ms | 538.8ms | 412.7ms |
| mixed/sieve | 470.3ms | 541.2ms | — |
