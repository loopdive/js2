# js2wasm Benchmark Results

Date: 2026-09-23
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.027ms | 0.040ms | 0.039ms | FAILED | js |
| string/concat-long | 0.003ms | 0.004ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.015ms | 0.047ms | 0.010ms | 0.014ms | gc-native |
| string/includes | 0.015ms | 0.093ms | 0.011ms | 0.018ms | gc-native |
| string/split | 0.333ms | 6.26ms | 2.06ms | FAILED | js |
| string/replace | 0.075ms | 0.437ms | 0.217ms | FAILED | js |
| string/case-convert | 0.045ms | 0.427ms | 0.186ms | FAILED | js |
| string/substring | 0.081ms | 0.031ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.134ms | 2.52ms | 1.85ms | FAILED | js |
| string/startsWith-endsWith | 0.320ms | 1.96ms | 2.02ms | 0.433ms | js |
| array/push-pop | 1.30ms | 0.481ms | 0.481ms | FAILED | host-call |
| array/sort-i32 | 0.663ms | 0.235ms | 0.237ms | FAILED | host-call |
| array/map-filter | 0.108ms | 0.052ms | 0.053ms | FAILED | host-call |
| array/reduce | 1.27ms | 0.476ms | 0.471ms | FAILED | gc-native |
| array/indexOf | 3.46ms | 2.22ms | 2.22ms | FAILED | gc-native |
| array/slice | 0.032ms | 0.014ms | 0.014ms | FAILED | host-call |
| array/reverse | 6.86ms | 3.08ms | 3.09ms | FAILED | host-call |
| array/forEach | 0.043ms | 0.023ms | 0.023ms | FAILED | gc-native |
| array/find | 0.213ms | 0.012ms | 0.012ms | 0.870ms | host-call |
| dom/create-elements | 0.200ms | 0.082ms | — | — | host-call |
| dom/set-attributes | 0.094ms | 0.193ms | — | — | js |
| dom/read-attributes | 0.051ms | 0.104ms | — | — | js |
| dom/modify-text | 0.027ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.362ms | 6.32ms | 0.440ms | FAILED | js |
| mixed/text-search | 0.313ms | 3.56ms | 1.95ms | 0.873ms | js |
| mixed/fibonacci | 0.097ms | 0.254ms | 0.254ms | 0.252ms | js |
| mixed/matrix-multiply | 0.148ms | 49.71ms | 50.18ms | 0.562ms | js |
| mixed/sieve | 1.41ms | 1.81ms | 1.81ms | FAILED | js |

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
| string/concat-short | 10000 | 2.68 | 4.00 | 3.88 | — |
| string/concat-long | 1000 | 3.38 | 4.29 | 2.96 | — |
| string/indexOf | 1000 | 14.78 | 46.61 | 9.81 | 13.67 |
| string/includes | 1000 | 14.59 | 93.36 | 11.12 | 18.44 |
| string/split | 10000 | 33.28 | 625.81 | 205.88 | — |
| string/replace | 1000 | 74.91 | 436.55 | 217.15 | — |
| string/case-convert | 2000 | 22.51 | 213.42 | 92.86 | — |
| string/substring | 10000 | 8.11 | 3.09 | 2.66 | — |
| string/trim | 10000 | 13.42 | 252.33 | 185.43 | — |
| string/startsWith-endsWith | 20000 | 16.00 | 97.83 | 100.97 | 21.65 |
| array/map-filter | 30000 | 3.61 | 1.75 | 1.75 | — |
| array/indexOf | 1000 | 3463.46 | 2221.30 | 2220.22 | — |
| dom/create-elements | 2000 | 99.99 | 41.17 | — | — |
| dom/set-attributes | 6000 | 15.71 | 32.16 | — | — |
| dom/read-attributes | 3000 | 16.99 | 34.82 | — | — |
| dom/modify-text | 2000 | 13.67 | 44.49 | — | — |
| mixed/csv-parse | 11000 | 32.92 | 574.49 | 39.97 | — |
| mixed/text-search | 40000 | 7.82 | 88.92 | 48.68 | 21.81 |
| mixed/fibonacci | 10000 | 9.71 | 25.40 | 25.40 | 25.24 |
| mixed/matrix-multiply | 125000 | 1.18 | 397.66 | 401.44 | 4.49 |
| mixed/sieve | 200000 | 7.04 | 9.05 | 9.05 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.45x slower | — |
| string/concat-long | 1.27x slower | 1.14x faster | — |
| string/indexOf | 3.15x slower | 1.51x faster | 1.08x faster |
| string/includes | 6.40x slower | 1.31x faster | 1.26x slower |
| string/split | 18.81x slower | 6.19x slower | — |
| string/replace | 5.83x slower | 2.90x slower | — |
| string/case-convert | 9.48x slower | 4.13x slower | — |
| string/substring | 2.63x faster | 3.05x faster | — |
| string/trim | 18.81x slower | 13.82x slower | — |
| string/startsWith-endsWith | 6.11x slower | 6.31x slower | 1.35x slower |
| array/push-pop | 2.70x faster | 2.69x faster | — |
| array/sort-i32 | 2.83x faster | 2.80x faster | — |
| array/map-filter | 2.07x faster | 2.06x faster | — |
| array/reduce | 2.67x faster | 2.70x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.28x faster | 2.26x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.90x faster | 1.90x faster | — |
| array/find | 17.74x faster | 17.22x faster | 4.08x slower |
| dom/create-elements | 2.43x faster | — | — |
| dom/set-attributes | 2.05x slower | — | — |
| dom/read-attributes | 2.05x slower | — | — |
| dom/modify-text | 3.26x slower | — | — |
| mixed/csv-parse | 17.45x slower | 1.21x slower | — |
| mixed/text-search | 11.38x slower | 6.23x slower | 2.79x slower |
| mixed/fibonacci | 2.61x slower | 2.61x slower | 2.60x slower |
| mixed/matrix-multiply | 336.99x slower | 340.19x slower | 3.81x slower |
| mixed/sieve | 1.29x slower | 1.28x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x faster |
| string/concat-long | 1.45x faster |
| string/indexOf | 4.75x faster |
| string/includes | 8.40x faster |
| string/split | 3.04x faster |
| string/replace | 2.01x faster |
| string/case-convert | 2.30x faster |
| string/substring | 1.16x faster |
| string/trim | 1.36x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.00x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.03x slower |
| mixed/csv-parse | 14.37x faster |
| mixed/text-search | 1.83x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.00x faster |

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
| array/sort-i32 | 3.3KB | 3.9KB | — |
| array/map-filter | 4.5KB | 5.0KB | — |
| array/reduce | 3.1KB | 3.6KB | — |
| array/indexOf | 2.1KB | 2.5KB | — |
| array/slice | 1.3KB | 1.7KB | — |
| array/reverse | 1.2KB | 1.7KB | — |
| array/forEach | 3.5KB | 4.1KB | — |
| array/find | 1.2KB | 1.6KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.5KB | 4.5KB | — |
| mixed/text-search | 2.2KB | 4.3KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 882.8ms | 481.1ms | — |
| string/concat-long | 341.0ms | 506.6ms | — |
| string/indexOf | 296.6ms | 505.4ms | 419.4ms |
| string/includes | 288.4ms | 522.9ms | 441.0ms |
| string/split | 479.2ms | 594.1ms | — |
| string/replace | 382.0ms | 589.1ms | — |
| string/case-convert | 412.0ms | 461.2ms | — |
| string/substring | 348.4ms | 380.3ms | — |
| string/trim | 380.5ms | 516.4ms | — |
| string/startsWith-endsWith | 374.7ms | 577.3ms | 463.4ms |
| array/push-pop | 399.8ms | 445.5ms | — |
| array/sort-i32 | 523.6ms | 529.8ms | — |
| array/map-filter | 531.9ms | 591.5ms | — |
| array/reduce | 477.5ms | 533.9ms | — |
| array/indexOf | 463.0ms | 534.1ms | — |
| array/slice | 394.3ms | 474.7ms | — |
| array/reverse | 386.4ms | 452.6ms | — |
| array/forEach | 505.4ms | 563.1ms | — |
| array/find | 387.5ms | 455.4ms | 425.5ms |
| dom/create-elements | 360.6ms | — | — |
| dom/set-attributes | 316.8ms | — | — |
| dom/read-attributes | 313.6ms | — | — |
| dom/modify-text | 299.4ms | — | — |
| mixed/csv-parse | 402.0ms | 533.8ms | — |
| mixed/text-search | 385.3ms | 544.0ms | 472.8ms |
| mixed/fibonacci | 365.3ms | 376.6ms | 364.3ms |
| mixed/matrix-multiply | 504.7ms | 541.8ms | 402.3ms |
| mixed/sieve | 460.4ms | 525.9ms | — |
