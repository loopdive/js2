# js2wasm Benchmark Results

Date: 2026-09-24
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.040ms | 0.038ms | 0.041ms | FAILED | host-call |
| string/concat-long | 0.003ms | 0.003ms | 0.004ms | FAILED | js |
| string/indexOf | 0.014ms | 0.044ms | 0.010ms | 0.012ms | gc-native |
| string/includes | 0.014ms | 0.100ms | 0.012ms | 0.013ms | gc-native |
| string/split | 0.303ms | 5.97ms | 2.09ms | FAILED | js |
| string/replace | 0.088ms | 0.457ms | 0.256ms | FAILED | js |
| string/case-convert | 0.043ms | 0.416ms | 0.210ms | FAILED | js |
| string/substring | 0.093ms | 0.032ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.130ms | 2.87ms | 2.16ms | FAILED | js |
| string/startsWith-endsWith | 0.408ms | 2.27ms | 2.29ms | 0.491ms | js |
| array/push-pop | 1.22ms | 0.416ms | 0.414ms | FAILED | gc-native |
| array/sort-i32 | 0.548ms | 0.287ms | 0.341ms | FAILED | host-call |
| array/map-filter | 0.116ms | 0.070ms | 0.069ms | FAILED | gc-native |
| array/reduce | 1.80ms | 0.426ms | 0.419ms | FAILED | gc-native |
| array/indexOf | 4.50ms | 2.23ms | 2.23ms | FAILED | gc-native |
| array/slice | 0.021ms | 0.021ms | 0.020ms | FAILED | gc-native |
| array/reverse | 7.06ms | 3.24ms | 3.17ms | FAILED | gc-native |
| array/forEach | 0.054ms | 0.020ms | 0.021ms | FAILED | host-call |
| array/find | 0.249ms | 0.013ms | 0.012ms | 0.858ms | gc-native |
| dom/create-elements | 0.038ms | 0.090ms | — | — | js |
| dom/set-attributes | 0.115ms | 0.162ms | — | — | js |
| dom/read-attributes | 0.048ms | 0.100ms | — | — | js |
| dom/modify-text | 0.035ms | 0.089ms | — | — | js |
| mixed/csv-parse | 0.368ms | 6.20ms | 0.492ms | FAILED | js |
| mixed/text-search | 0.370ms | 3.45ms | 2.17ms | 0.977ms | js |
| mixed/fibonacci | 0.114ms | 0.186ms | 0.181ms | 0.185ms | js |
| mixed/matrix-multiply | 0.162ms | 53.34ms | 53.72ms | 0.706ms | js |
| mixed/sieve | 1.60ms | 2.08ms | 2.09ms | FAILED | js |

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
| string/concat-short | 10000 | 4.01 | 3.76 | 4.14 | — |
| string/concat-long | 1000 | 3.06 | 3.38 | 3.99 | — |
| string/indexOf | 1000 | 14.17 | 43.63 | 9.82 | 11.65 |
| string/includes | 1000 | 14.10 | 100.47 | 12.06 | 12.79 |
| string/split | 10000 | 30.32 | 597.40 | 209.19 | — |
| string/replace | 1000 | 87.69 | 456.70 | 255.82 | — |
| string/case-convert | 2000 | 21.58 | 208.13 | 105.11 | — |
| string/substring | 10000 | 9.26 | 3.21 | 2.72 | — |
| string/trim | 10000 | 13.02 | 286.52 | 215.74 | — |
| string/startsWith-endsWith | 20000 | 20.40 | 113.41 | 114.73 | 24.53 |
| array/map-filter | 30000 | 3.86 | 2.35 | 2.31 | — |
| array/indexOf | 1000 | 4497.96 | 2234.37 | 2232.27 | — |
| dom/create-elements | 2000 | 19.17 | 45.09 | — | — |
| dom/set-attributes | 6000 | 19.15 | 27.03 | — | — |
| dom/read-attributes | 3000 | 16.09 | 33.34 | — | — |
| dom/modify-text | 2000 | 17.30 | 44.43 | — | — |
| mixed/csv-parse | 11000 | 33.47 | 563.69 | 44.77 | — |
| mixed/text-search | 40000 | 9.25 | 86.27 | 54.26 | 24.43 |
| mixed/fibonacci | 10000 | 11.38 | 18.60 | 18.07 | 18.50 |
| mixed/matrix-multiply | 125000 | 1.30 | 426.73 | 429.78 | 5.65 |
| mixed/sieve | 200000 | 7.99 | 10.42 | 10.44 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.07x faster | 1.03x slower | — |
| string/concat-long | 1.10x slower | 1.30x slower | — |
| string/indexOf | 3.08x slower | 1.44x faster | 1.22x faster |
| string/includes | 7.12x slower | 1.17x faster | 1.10x faster |
| string/split | 19.70x slower | 6.90x slower | — |
| string/replace | 5.21x slower | 2.92x slower | — |
| string/case-convert | 9.65x slower | 4.87x slower | — |
| string/substring | 2.89x faster | 3.40x faster | — |
| string/trim | 22.01x slower | 16.57x slower | — |
| string/startsWith-endsWith | 5.56x slower | 5.62x slower | 1.20x slower |
| array/push-pop | 2.93x faster | 2.94x faster | — |
| array/sort-i32 | 1.91x faster | 1.61x faster | — |
| array/map-filter | 1.64x faster | 1.67x faster | — |
| array/reduce | 4.22x faster | 4.30x faster | — |
| array/indexOf | 2.01x faster | 2.01x faster | — |
| array/slice | 1.03x slower | 1.02x faster | — |
| array/reverse | 2.18x faster | 2.23x faster | — |
| array/forEach | 2.69x faster | 2.58x faster | — |
| array/find | 19.12x faster | 21.10x faster | 3.45x slower |
| dom/create-elements | 2.35x slower | — | — |
| dom/set-attributes | 1.41x slower | — | — |
| dom/read-attributes | 2.07x slower | — | — |
| dom/modify-text | 2.57x slower | — | — |
| mixed/csv-parse | 16.84x slower | 1.34x slower | — |
| mixed/text-search | 9.32x slower | 5.86x slower | 2.64x slower |
| mixed/fibonacci | 1.63x slower | 1.59x slower | 1.63x slower |
| mixed/matrix-multiply | 329.51x slower | 331.86x slower | 4.36x slower |
| mixed/sieve | 1.30x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.10x slower |
| string/concat-long | 1.18x slower |
| string/indexOf | 4.44x faster |
| string/includes | 8.33x faster |
| string/split | 2.86x faster |
| string/replace | 1.79x faster |
| string/case-convert | 1.98x faster |
| string/substring | 1.18x faster |
| string/trim | 1.33x faster |
| string/startsWith-endsWith | 1.01x slower |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.19x slower |
| array/map-filter | 1.02x faster |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.05x faster |
| array/reverse | 1.02x faster |
| array/forEach | 1.04x slower |
| array/find | 1.10x faster |
| mixed/csv-parse | 12.59x faster |
| mixed/text-search | 1.59x faster |
| mixed/fibonacci | 1.03x faster |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.00x slower |

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
| mixed/matrix-multiply | 3.0KB | 3.6KB | 991B |
| mixed/sieve | 2.0KB | 2.4KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 929.8ms | 556.7ms | — |
| string/concat-long | 372.6ms | 571.8ms | — |
| string/indexOf | 336.7ms | 579.2ms | 469.0ms |
| string/includes | 316.6ms | 584.5ms | 465.1ms |
| string/split | 439.0ms | 586.5ms | — |
| string/replace | 431.0ms | 632.4ms | — |
| string/case-convert | 424.3ms | 512.5ms | — |
| string/substring | 333.4ms | 424.2ms | — |
| string/trim | 413.3ms | 602.7ms | — |
| string/startsWith-endsWith | 434.0ms | 605.6ms | 524.5ms |
| array/push-pop | 433.7ms | 523.2ms | — |
| array/sort-i32 | 597.2ms | 619.2ms | — |
| array/map-filter | 603.4ms | 655.7ms | — |
| array/reduce | 531.3ms | 615.9ms | — |
| array/indexOf | 511.2ms | 592.4ms | — |
| array/slice | 440.1ms | 512.0ms | — |
| array/reverse | 427.4ms | 513.2ms | — |
| array/forEach | 547.3ms | 684.3ms | — |
| array/find | 429.9ms | 511.2ms | 461.3ms |
| dom/create-elements | 353.0ms | — | — |
| dom/set-attributes | 326.9ms | — | — |
| dom/read-attributes | 333.8ms | — | — |
| dom/modify-text | 319.8ms | — | — |
| mixed/csv-parse | 446.0ms | 597.1ms | — |
| mixed/text-search | 440.6ms | 639.2ms | 526.4ms |
| mixed/fibonacci | 382.8ms | 418.3ms | 416.1ms |
| mixed/matrix-multiply | 541.8ms | 599.9ms | 468.7ms |
| mixed/sieve | 540.8ms | 600.2ms | — |
