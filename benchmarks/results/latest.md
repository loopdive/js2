# js2wasm Benchmark Results

Date: 2026-09-15
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.029ms | 0.049ms | 0.041ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.018ms | gc-native |
| string/includes | 0.019ms | 0.129ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.426ms | 8.34ms | 2.91ms | FAILED | js |
| string/replace | 0.104ms | 0.690ms | 0.328ms | FAILED | js |
| string/case-convert | 0.058ms | 0.607ms | 0.261ms | FAILED | js |
| string/substring | 0.099ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 3.75ms | 2.86ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.87ms | 2.99ms | 0.561ms | js |
| array/push-pop | 1.44ms | 0.516ms | 0.504ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.294ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.072ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.17ms | 0.508ms | 0.507ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.029ms | 0.029ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.036ms | 0.095ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.220ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.135ms | — | — | js |
| dom/modify-text | 0.029ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.482ms | 8.65ms | 0.595ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.05ms | 2.79ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 71.11ms | 74.28ms | 0.718ms | js |
| mixed/sieve | 1.56ms | 2.12ms | 2.11ms | FAILED | js |

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
| string/concat-short | 10000 | 2.90 | 4.89 | 4.15 | — |
| string/concat-long | 1000 | 3.72 | 4.49 | 3.89 | — |
| string/indexOf | 1000 | 19.15 | 63.80 | 12.07 | 17.71 |
| string/includes | 1000 | 19.20 | 128.92 | 14.79 | 15.49 |
| string/split | 10000 | 42.57 | 834.23 | 290.83 | — |
| string/replace | 1000 | 104.42 | 689.52 | 327.66 | — |
| string/case-convert | 2000 | 29.05 | 303.73 | 130.67 | — |
| string/substring | 10000 | 9.95 | 3.77 | 3.07 | — |
| string/trim | 10000 | 17.01 | 374.78 | 285.64 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 143.65 | 149.39 | 28.04 |
| array/map-filter | 30000 | 2.40 | 2.34 | 2.33 | — |
| array/indexOf | 1000 | 3950.24 | 2643.53 | 2640.30 | — |
| dom/create-elements | 2000 | 18.11 | 47.59 | — | — |
| dom/set-attributes | 6000 | 17.56 | 36.62 | — | — |
| dom/read-attributes | 3000 | 18.66 | 44.89 | — | — |
| dom/modify-text | 2000 | 14.61 | 54.22 | — | — |
| mixed/csv-parse | 11000 | 43.83 | 786.09 | 54.14 | — |
| mixed/text-search | 40000 | 9.73 | 126.36 | 69.80 | 27.07 |
| mixed/fibonacci | 10000 | 12.19 | 28.32 | 28.32 | 28.09 |
| mixed/matrix-multiply | 125000 | 1.27 | 568.87 | 594.26 | 5.74 |
| mixed/sieve | 200000 | 7.78 | 10.60 | 10.53 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.69x slower | 1.43x slower | — |
| string/concat-long | 1.21x slower | 1.05x slower | — |
| string/indexOf | 3.33x slower | 1.59x faster | 1.08x faster |
| string/includes | 6.71x slower | 1.30x faster | 1.24x faster |
| string/split | 19.60x slower | 6.83x slower | — |
| string/replace | 6.60x slower | 3.14x slower | — |
| string/case-convert | 10.45x slower | 4.50x slower | — |
| string/substring | 2.64x faster | 3.24x faster | — |
| string/trim | 22.04x slower | 16.80x slower | — |
| string/startsWith-endsWith | 7.16x slower | 7.44x slower | 1.40x slower |
| array/push-pop | 2.79x faster | 2.86x faster | — |
| array/sort-i32 | 2.69x faster | 2.71x faster | — |
| array/map-filter | 1.03x faster | 1.03x faster | — |
| array/reduce | 4.28x faster | 4.28x faster | — |
| array/indexOf | 1.49x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.09x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.76x faster | 1.75x faster | — |
| array/find | 16.05x faster | 15.97x faster | 4.24x slower |
| dom/create-elements | 2.63x slower | — | — |
| dom/set-attributes | 2.09x slower | — | — |
| dom/read-attributes | 2.41x slower | — | — |
| dom/modify-text | 3.71x slower | — | — |
| mixed/csv-parse | 17.93x slower | 1.24x slower | — |
| mixed/text-search | 12.98x slower | 7.17x slower | 2.78x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.30x slower |
| mixed/matrix-multiply | 449.49x slower | 469.55x slower | 4.54x slower |
| mixed/sieve | 1.36x slower | 1.35x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.18x faster |
| string/concat-long | 1.16x faster |
| string/indexOf | 5.29x faster |
| string/includes | 8.71x faster |
| string/split | 2.87x faster |
| string/replace | 2.10x faster |
| string/case-convert | 2.32x faster |
| string/substring | 1.23x faster |
| string/trim | 1.31x faster |
| string/startsWith-endsWith | 1.04x slower |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.01x slower |
| mixed/csv-parse | 14.52x faster |
| mixed/text-search | 1.81x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 745B | — |
| string/concat-long | 223B | 932B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.1KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.7KB | 3.2KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 999B | 1.3KB | — |
| array/reverse | 977B | 1.3KB | — |
| array/forEach | 2.8KB | 3.3KB | — |
| array/find | 946B | 1.3KB | 634B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 438B | 438B | 411B |
| mixed/matrix-multiply | 2.6KB | 3.2KB | 991B |
| mixed/sieve | 1.7KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1185.4ms | 633.6ms | — |
| string/concat-long | 440.5ms | 685.7ms | — |
| string/indexOf | 391.0ms | 672.7ms | 557.4ms |
| string/includes | 371.6ms | 661.4ms | 556.9ms |
| string/split | 518.2ms | 723.4ms | — |
| string/replace | 497.0ms | 733.8ms | — |
| string/case-convert | 498.8ms | 588.7ms | — |
| string/substring | 387.4ms | 487.0ms | — |
| string/trim | 489.1ms | 677.2ms | — |
| string/startsWith-endsWith | 484.7ms | 720.3ms | 616.3ms |
| array/push-pop | 496.2ms | 580.0ms | — |
| array/sort-i32 | 651.2ms | 755.9ms | — |
| array/map-filter | 684.9ms | 736.2ms | — |
| array/reduce | 598.5ms | 724.7ms | — |
| array/indexOf | 583.1ms | 685.5ms | — |
| array/slice | 512.9ms | 593.6ms | — |
| array/reverse | 510.4ms | 586.7ms | — |
| array/forEach | 647.4ms | 700.8ms | — |
| array/find | 495.6ms | 564.0ms | 546.9ms |
| dom/create-elements | 423.6ms | — | — |
| dom/set-attributes | 418.6ms | — | — |
| dom/read-attributes | 411.6ms | — | — |
| dom/modify-text | 402.2ms | — | — |
| mixed/csv-parse | 496.9ms | 677.7ms | — |
| mixed/text-search | 503.0ms | 712.2ms | 645.8ms |
| mixed/fibonacci | 462.7ms | 520.6ms | 475.0ms |
| mixed/matrix-multiply | 636.2ms | 722.3ms | 527.8ms |
| mixed/sieve | 598.1ms | 678.2ms | — |
