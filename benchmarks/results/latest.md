# js2wasm Benchmark Results

Date: 2026-10-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.044ms | 0.048ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.004ms | 0.006ms | FAILED | js |
| string/indexOf | 0.012ms | 0.036ms | 0.009ms | 0.011ms | gc-native |
| string/includes | 0.014ms | 0.078ms | 0.011ms | 0.028ms | gc-native |
| string/split | 0.275ms | 4.67ms | 1.77ms | FAILED | js |
| string/replace | 0.063ms | 0.420ms | 0.210ms | FAILED | js |
| string/case-convert | 0.044ms | 0.329ms | 0.166ms | FAILED | js |
| string/substring | 0.124ms | 0.027ms | 0.027ms | FAILED | gc-native |
| string/trim | 0.225ms | 2.27ms | 1.72ms | FAILED | js |
| string/startsWith-endsWith | 0.359ms | 1.91ms | 1.90ms | 0.391ms | js |
| array/push-pop | 1.07ms | 0.331ms | 0.344ms | FAILED | host-call |
| array/sort-i32 | 0.459ms | 0.251ms | 0.248ms | FAILED | gc-native |
| array/map-filter | 0.100ms | 0.077ms | 0.065ms | FAILED | gc-native |
| array/reduce | 1.67ms | 0.366ms | 0.351ms | FAILED | gc-native |
| array/indexOf | 3.91ms | 1.88ms | 1.88ms | FAILED | gc-native |
| array/slice | 0.033ms | 0.025ms | 0.031ms | FAILED | host-call |
| array/reverse | 4.96ms | 2.72ms | 2.72ms | FAILED | gc-native |
| array/forEach | 0.051ms | 0.021ms | 0.019ms | FAILED | gc-native |
| array/find | 0.217ms | 0.012ms | 0.012ms | 0.714ms | host-call |
| dom/create-elements | 0.051ms | 0.091ms | — | — | js |
| dom/set-attributes | 0.106ms | 0.135ms | — | — | js |
| dom/read-attributes | 0.060ms | 0.092ms | — | — | js |
| dom/modify-text | 0.051ms | 0.088ms | — | — | js |
| mixed/csv-parse | 0.294ms | 4.77ms | 0.405ms | FAILED | js |
| mixed/text-search | 0.306ms | 2.77ms | 1.81ms | 0.813ms | js |
| mixed/fibonacci | 0.097ms | 0.156ms | 0.156ms | 0.155ms | js |
| mixed/matrix-multiply | 0.143ms | 43.15ms | 45.77ms | 0.532ms | js |
| mixed/sieve | 1.29ms | 1.80ms | 1.80ms | FAILED | js |

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
| string/concat-short | 10000 | 4.52 | 4.45 | 4.81 | — |
| string/concat-long | 1000 | 3.90 | 4.24 | 5.52 | — |
| string/indexOf | 1000 | 11.75 | 36.41 | 8.75 | 10.98 |
| string/includes | 1000 | 13.59 | 78.07 | 10.76 | 27.82 |
| string/split | 10000 | 27.48 | 467.19 | 176.83 | — |
| string/replace | 1000 | 63.20 | 419.80 | 209.51 | — |
| string/case-convert | 2000 | 21.76 | 164.49 | 82.82 | — |
| string/substring | 10000 | 12.41 | 2.73 | 2.68 | — |
| string/trim | 10000 | 22.54 | 226.61 | 172.41 | — |
| string/startsWith-endsWith | 20000 | 17.94 | 95.48 | 95.22 | 19.53 |
| array/map-filter | 30000 | 3.32 | 2.58 | 2.17 | — |
| array/indexOf | 1000 | 3909.67 | 1879.88 | 1876.54 | — |
| dom/create-elements | 2000 | 25.75 | 45.68 | — | — |
| dom/set-attributes | 6000 | 17.61 | 22.52 | — | — |
| dom/read-attributes | 3000 | 19.84 | 30.51 | — | — |
| dom/modify-text | 2000 | 25.27 | 43.99 | — | — |
| mixed/csv-parse | 11000 | 26.72 | 433.51 | 36.82 | — |
| mixed/text-search | 40000 | 7.65 | 69.17 | 45.15 | 20.32 |
| mixed/fibonacci | 10000 | 9.75 | 15.62 | 15.62 | 15.50 |
| mixed/matrix-multiply | 125000 | 1.14 | 345.21 | 366.16 | 4.26 |
| mixed/sieve | 200000 | 6.47 | 9.01 | 9.01 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.02x faster | 1.06x slower | — |
| string/concat-long | 1.09x slower | 1.41x slower | — |
| string/indexOf | 3.10x slower | 1.34x faster | 1.07x faster |
| string/includes | 5.74x slower | 1.26x faster | 2.05x slower |
| string/split | 17.00x slower | 6.44x slower | — |
| string/replace | 6.64x slower | 3.32x slower | — |
| string/case-convert | 7.56x slower | 3.81x slower | — |
| string/substring | 4.54x faster | 4.63x faster | — |
| string/trim | 10.05x slower | 7.65x slower | — |
| string/startsWith-endsWith | 5.32x slower | 5.31x slower | 1.09x slower |
| array/push-pop | 3.24x faster | 3.11x faster | — |
| array/sort-i32 | 1.82x faster | 1.85x faster | — |
| array/map-filter | 1.29x faster | 1.53x faster | — |
| array/reduce | 4.55x faster | 4.75x faster | — |
| array/indexOf | 2.08x faster | 2.08x faster | — |
| array/slice | 1.33x faster | 1.05x faster | — |
| array/reverse | 1.82x faster | 1.82x faster | — |
| array/forEach | 2.44x faster | 2.60x faster | — |
| array/find | 18.43x faster | 17.41x faster | 3.29x slower |
| dom/create-elements | 1.77x slower | — | — |
| dom/set-attributes | 1.28x slower | — | — |
| dom/read-attributes | 1.54x slower | — | — |
| dom/modify-text | 1.74x slower | — | — |
| mixed/csv-parse | 16.22x slower | 1.38x slower | — |
| mixed/text-search | 9.05x slower | 5.90x slower | 2.66x slower |
| mixed/fibonacci | 1.60x slower | 1.60x slower | 1.59x slower |
| mixed/matrix-multiply | 301.64x slower | 319.95x slower | 3.72x slower |
| mixed/sieve | 1.39x slower | 1.39x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x slower |
| string/concat-long | 1.30x slower |
| string/indexOf | 4.16x faster |
| string/includes | 7.26x faster |
| string/split | 2.64x faster |
| string/replace | 2.00x faster |
| string/case-convert | 1.99x faster |
| string/substring | 1.02x faster |
| string/trim | 1.31x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.04x slower |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.19x faster |
| array/reduce | 1.04x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.27x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.07x faster |
| array/find | 1.06x slower |
| mixed/csv-parse | 11.77x faster |
| mixed/text-search | 1.53x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.06x slower |
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
| mixed/matrix-multiply | 3.5KB | 4.0KB | 991B |
| mixed/sieve | 2.5KB | 2.7KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 859.4ms | 459.0ms | — |
| string/concat-long | 317.3ms | 466.4ms | — |
| string/indexOf | 280.5ms | 469.5ms | 439.7ms |
| string/includes | 310.1ms | 460.2ms | 383.1ms |
| string/split | 357.6ms | 488.6ms | — |
| string/replace | 412.1ms | 593.7ms | — |
| string/case-convert | 359.9ms | 479.4ms | — |
| string/substring | 288.3ms | 384.5ms | — |
| string/trim | 352.5ms | 476.0ms | — |
| string/startsWith-endsWith | 351.5ms | 476.0ms | 430.4ms |
| array/push-pop | 358.1ms | 410.1ms | — |
| array/sort-i32 | 482.5ms | 497.9ms | — |
| array/map-filter | 502.0ms | 523.6ms | — |
| array/reduce | 433.3ms | 521.0ms | — |
| array/indexOf | 444.8ms | 462.1ms | — |
| array/slice | 422.4ms | 428.3ms | — |
| array/reverse | 344.5ms | 415.6ms | — |
| array/forEach | 450.4ms | 492.4ms | — |
| array/find | 349.3ms | 413.4ms | 381.3ms |
| dom/create-elements | 344.5ms | — | — |
| dom/set-attributes | 304.2ms | — | — |
| dom/read-attributes | 286.3ms | — | — |
| dom/modify-text | 283.2ms | — | — |
| mixed/csv-parse | 386.5ms | 479.3ms | — |
| mixed/text-search | 357.5ms | 484.3ms | 446.9ms |
| mixed/fibonacci | 342.0ms | 363.9ms | 339.9ms |
| mixed/matrix-multiply | 466.6ms | 490.0ms | 383.2ms |
| mixed/sieve | 425.1ms | 484.5ms | — |
