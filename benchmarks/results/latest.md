# js2wasm Benchmark Results

Date: 2026-09-27
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.044ms | 0.038ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.014ms | gc-native |
| string/includes | 0.015ms | 0.095ms | 0.011ms | 0.013ms | gc-native |
| string/split | 0.371ms | 6.34ms | 2.06ms | FAILED | js |
| string/replace | 0.076ms | 0.467ms | 0.214ms | FAILED | js |
| string/case-convert | 0.046ms | 0.426ms | 0.191ms | FAILED | js |
| string/substring | 0.102ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.140ms | 2.64ms | 1.86ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.95ms | 1.97ms | 0.433ms | js |
| array/push-pop | 1.33ms | 0.485ms | 0.485ms | FAILED | gc-native |
| array/sort-i32 | 0.655ms | 0.236ms | 0.236ms | FAILED | gc-native |
| array/map-filter | 0.109ms | 0.053ms | 0.053ms | FAILED | gc-native |
| array/reduce | 1.90ms | 0.484ms | 0.481ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.015ms | 0.014ms | FAILED | gc-native |
| array/reverse | 6.86ms | 3.08ms | 3.08ms | FAILED | gc-native |
| array/forEach | 0.076ms | 0.023ms | 0.023ms | FAILED | host-call |
| array/find | 0.212ms | 0.012ms | 0.012ms | 0.937ms | host-call |
| dom/create-elements | 0.030ms | 0.079ms | — | — | js |
| dom/set-attributes | 0.086ms | 0.185ms | — | — | js |
| dom/read-attributes | 0.050ms | 0.104ms | — | — | js |
| dom/modify-text | 0.023ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.364ms | 6.26ms | 0.444ms | FAILED | js |
| mixed/text-search | 0.313ms | 3.47ms | 2.02ms | 0.874ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.146ms | 50.87ms | 55.55ms | 0.562ms | js |
| mixed/sieve | 1.47ms | 1.82ms | 1.80ms | FAILED | js |

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
| string/concat-short | 10000 | 3.01 | 4.35 | 3.83 | — |
| string/concat-long | 1000 | 3.13 | 4.20 | 2.92 | — |
| string/indexOf | 1000 | 14.77 | 46.61 | 9.88 | 13.86 |
| string/includes | 1000 | 14.54 | 94.67 | 11.03 | 12.92 |
| string/split | 10000 | 37.08 | 634.32 | 205.92 | — |
| string/replace | 1000 | 75.69 | 467.32 | 213.62 | — |
| string/case-convert | 2000 | 22.83 | 213.16 | 95.54 | — |
| string/substring | 10000 | 10.20 | 3.09 | 2.67 | — |
| string/trim | 10000 | 13.98 | 264.47 | 185.86 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 97.59 | 98.66 | 21.63 |
| array/map-filter | 30000 | 3.64 | 1.77 | 1.76 | — |
| array/indexOf | 1000 | 3461.12 | 2224.06 | 2219.78 | — |
| dom/create-elements | 2000 | 14.98 | 39.48 | — | — |
| dom/set-attributes | 6000 | 14.27 | 30.81 | — | — |
| dom/read-attributes | 3000 | 16.71 | 34.67 | — | — |
| dom/modify-text | 2000 | 11.45 | 44.01 | — | — |
| mixed/csv-parse | 11000 | 33.05 | 568.91 | 40.40 | — |
| mixed/text-search | 40000 | 7.81 | 86.70 | 50.59 | 21.85 |
| mixed/fibonacci | 10000 | 9.72 | 25.40 | 25.41 | 25.25 |
| mixed/matrix-multiply | 125000 | 1.17 | 406.97 | 444.41 | 4.50 |
| mixed/sieve | 200000 | 7.35 | 9.09 | 9.01 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.45x slower | 1.27x slower | — |
| string/concat-long | 1.34x slower | 1.07x faster | — |
| string/indexOf | 3.15x slower | 1.50x faster | 1.07x faster |
| string/includes | 6.51x slower | 1.32x faster | 1.13x faster |
| string/split | 17.11x slower | 5.55x slower | — |
| string/replace | 6.17x slower | 2.82x slower | — |
| string/case-convert | 9.34x slower | 4.19x slower | — |
| string/substring | 3.30x faster | 3.83x faster | — |
| string/trim | 18.92x slower | 13.30x slower | — |
| string/startsWith-endsWith | 6.10x slower | 6.17x slower | 1.35x slower |
| array/push-pop | 2.74x faster | 2.75x faster | — |
| array/sort-i32 | 2.77x faster | 2.78x faster | — |
| array/map-filter | 2.06x faster | 2.07x faster | — |
| array/reduce | 3.92x faster | 3.94x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.25x faster | 2.31x faster | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 3.33x faster | 3.32x faster | — |
| array/find | 17.81x faster | 17.02x faster | 4.41x slower |
| dom/create-elements | 2.64x slower | — | — |
| dom/set-attributes | 2.16x slower | — | — |
| dom/read-attributes | 2.07x slower | — | — |
| dom/modify-text | 3.84x slower | — | — |
| mixed/csv-parse | 17.21x slower | 1.22x slower | — |
| mixed/text-search | 11.10x slower | 6.48x slower | 2.80x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 347.86x slower | 379.87x slower | 3.84x slower |
| mixed/sieve | 1.24x slower | 1.23x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.14x faster |
| string/concat-long | 1.44x faster |
| string/indexOf | 4.72x faster |
| string/includes | 8.59x faster |
| string/split | 3.08x faster |
| string/replace | 2.19x faster |
| string/case-convert | 2.23x faster |
| string/substring | 1.16x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.05x slower |
| mixed/csv-parse | 14.08x faster |
| mixed/text-search | 1.71x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.09x slower |
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
| string/concat-short | 873.8ms | 553.4ms | — |
| string/concat-long | 345.6ms | 509.9ms | — |
| string/indexOf | 301.9ms | 533.8ms | 437.8ms |
| string/includes | 304.3ms | 526.2ms | 429.0ms |
| string/split | 398.6ms | 536.1ms | — |
| string/replace | 400.9ms | 591.2ms | — |
| string/case-convert | 408.8ms | 484.0ms | — |
| string/substring | 314.9ms | 381.0ms | — |
| string/trim | 385.1ms | 530.7ms | — |
| string/startsWith-endsWith | 388.9ms | 590.6ms | 488.3ms |
| array/push-pop | 393.9ms | 485.3ms | — |
| array/sort-i32 | 522.1ms | 548.6ms | — |
| array/map-filter | 529.3ms | 581.8ms | — |
| array/reduce | 484.6ms | 543.0ms | — |
| array/indexOf | 460.3ms | 524.2ms | — |
| array/slice | 401.8ms | 478.9ms | — |
| array/reverse | 411.7ms | 461.1ms | — |
| array/forEach | 505.9ms | 548.1ms | — |
| array/find | 393.0ms | 467.4ms | 427.6ms |
| dom/create-elements | 338.3ms | — | — |
| dom/set-attributes | 326.5ms | — | — |
| dom/read-attributes | 313.4ms | — | — |
| dom/modify-text | 297.6ms | — | — |
| mixed/csv-parse | 406.6ms | 538.6ms | — |
| mixed/text-search | 399.8ms | 527.2ms | 492.0ms |
| mixed/fibonacci | 360.6ms | 398.3ms | 360.0ms |
| mixed/matrix-multiply | 489.1ms | 572.5ms | 400.1ms |
| mixed/sieve | 476.2ms | 520.7ms | — |
