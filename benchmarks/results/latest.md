# js2wasm Benchmark Results

Date: 2026-09-02
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.042ms | 0.047ms | FAILED | host-call |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.013ms | 0.038ms | 0.009ms | 0.011ms | gc-native |
| string/includes | 0.013ms | 0.075ms | 0.011ms | 0.030ms | gc-native |
| string/split | 0.276ms | 4.65ms | 1.79ms | FAILED | js |
| string/replace | 0.067ms | 0.377ms | 0.227ms | FAILED | js |
| string/case-convert | 0.049ms | 0.339ms | 0.176ms | FAILED | js |
| string/substring | 0.126ms | 0.029ms | 0.024ms | FAILED | gc-native |
| string/trim | 0.229ms | 2.29ms | 1.77ms | FAILED | js |
| string/startsWith-endsWith | 0.374ms | 1.86ms | 1.91ms | 0.403ms | js |
| array/push-pop | 1.20ms | 0.405ms | 0.410ms | FAILED | host-call |
| array/sort-i32 | 0.475ms | 0.269ms | 0.256ms | FAILED | gc-native |
| array/map-filter | 0.117ms | 0.068ms | 0.068ms | FAILED | gc-native |
| array/reduce | 1.76ms | 0.405ms | 0.401ms | FAILED | gc-native |
| array/indexOf | 4.01ms | 1.92ms | 1.96ms | FAILED | host-call |
| array/slice | 0.045ms | 0.041ms | 0.040ms | FAILED | gc-native |
| array/reverse | 5.08ms | 2.79ms | 2.79ms | FAILED | host-call |
| array/forEach | 0.054ms | 0.021ms | 0.021ms | FAILED | gc-native |
| array/find | 0.225ms | 0.015ms | 0.015ms | 0.737ms | host-call |
| dom/create-elements | 0.073ms | 0.140ms | — | — | js |
| dom/set-attributes | 0.110ms | 0.355ms | — | — | js |
| dom/read-attributes | 0.068ms | 0.094ms | — | — | js |
| dom/modify-text | 0.057ms | 0.090ms | — | — | js |
| mixed/csv-parse | 0.301ms | 4.76ms | 0.427ms | FAILED | js |
| mixed/text-search | 0.313ms | 2.84ms | 1.88ms | 0.838ms | js |
| mixed/fibonacci | 0.101ms | 0.160ms | 0.160ms | 0.159ms | js |
| mixed/matrix-multiply | 0.146ms | 43.71ms | 44.14ms | 0.532ms | js |
| mixed/sieve | 1.33ms | 1.87ms | 1.86ms | FAILED | js |

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
| string/concat-short | 10000 | 4.49 | 4.21 | 4.73 | — |
| string/concat-long | 1000 | 3.90 | 4.53 | 6.13 | — |
| string/indexOf | 1000 | 12.54 | 38.19 | 9.42 | 10.68 |
| string/includes | 1000 | 13.29 | 74.59 | 11.17 | 30.31 |
| string/split | 10000 | 27.60 | 464.88 | 179.27 | — |
| string/replace | 1000 | 66.63 | 377.12 | 227.45 | — |
| string/case-convert | 2000 | 24.70 | 169.36 | 88.22 | — |
| string/substring | 10000 | 12.61 | 2.93 | 2.37 | — |
| string/trim | 10000 | 22.90 | 229.23 | 177.47 | — |
| string/startsWith-endsWith | 20000 | 18.69 | 92.78 | 95.75 | 20.14 |
| array/map-filter | 30000 | 3.89 | 2.26 | 2.26 | — |
| array/indexOf | 1000 | 4008.92 | 1923.93 | 1961.07 | — |
| dom/create-elements | 2000 | 36.31 | 70.22 | — | — |
| dom/set-attributes | 6000 | 18.36 | 59.19 | — | — |
| dom/read-attributes | 3000 | 22.76 | 31.22 | — | — |
| dom/modify-text | 2000 | 28.61 | 44.85 | — | — |
| mixed/csv-parse | 11000 | 27.39 | 432.30 | 38.80 | — |
| mixed/text-search | 40000 | 7.82 | 70.92 | 46.92 | 20.95 |
| mixed/fibonacci | 10000 | 10.11 | 16.01 | 16.02 | 15.88 |
| mixed/matrix-multiply | 125000 | 1.17 | 349.71 | 353.11 | 4.26 |
| mixed/sieve | 200000 | 6.67 | 9.37 | 9.32 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.07x faster | 1.05x slower | — |
| string/concat-long | 1.16x slower | 1.57x slower | — |
| string/indexOf | 3.04x slower | 1.33x faster | 1.17x faster |
| string/includes | 5.61x slower | 1.19x faster | 2.28x slower |
| string/split | 16.85x slower | 6.50x slower | — |
| string/replace | 5.66x slower | 3.41x slower | — |
| string/case-convert | 6.86x slower | 3.57x slower | — |
| string/substring | 4.30x faster | 5.32x faster | — |
| string/trim | 10.01x slower | 7.75x slower | — |
| string/startsWith-endsWith | 4.96x slower | 5.12x slower | 1.08x slower |
| array/push-pop | 2.96x faster | 2.92x faster | — |
| array/sort-i32 | 1.77x faster | 1.86x faster | — |
| array/map-filter | 1.72x faster | 1.72x faster | — |
| array/reduce | 4.34x faster | 4.39x faster | — |
| array/indexOf | 2.08x faster | 2.04x faster | — |
| array/slice | 1.09x faster | 1.13x faster | — |
| array/reverse | 1.82x faster | 1.82x faster | — |
| array/forEach | 2.51x faster | 2.54x faster | — |
| array/find | 15.06x faster | 14.96x faster | 3.27x slower |
| dom/create-elements | 1.93x slower | — | — |
| dom/set-attributes | 3.22x slower | — | — |
| dom/read-attributes | 1.37x slower | — | — |
| dom/modify-text | 1.57x slower | — | — |
| mixed/csv-parse | 15.78x slower | 1.42x slower | — |
| mixed/text-search | 9.07x slower | 6.00x slower | 2.68x slower |
| mixed/fibonacci | 1.58x slower | 1.58x slower | 1.57x slower |
| mixed/matrix-multiply | 298.39x slower | 301.29x slower | 3.63x slower |
| mixed/sieve | 1.41x slower | 1.40x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.12x slower |
| string/concat-long | 1.35x slower |
| string/indexOf | 4.06x faster |
| string/includes | 6.68x faster |
| string/split | 2.59x faster |
| string/replace | 1.66x faster |
| string/case-convert | 1.92x faster |
| string/substring | 1.24x faster |
| string/trim | 1.29x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.05x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.02x slower |
| array/slice | 1.04x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 11.14x faster |
| mixed/text-search | 1.51x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
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
| array/sort-i32 | 2.8KB | 3.3KB | — |
| array/map-filter | 3.6KB | 4.1KB | — |
| array/reduce | 2.5KB | 3.0KB | — |
| array/indexOf | 1.8KB | 2.1KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.8KB | 3.4KB | — |
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
| string/concat-short | 1272.8ms | 848.3ms | — |
| string/concat-long | 613.5ms | 746.9ms | — |
| string/indexOf | 532.3ms | 748.8ms | 681.2ms |
| string/includes | 553.0ms | 742.7ms | 646.6ms |
| string/split | 619.0ms | 753.3ms | — |
| string/replace | 589.7ms | 798.6ms | — |
| string/case-convert | 626.7ms | 668.3ms | — |
| string/substring | 512.0ms | 606.0ms | — |
| string/trim | 584.2ms | 733.0ms | — |
| string/startsWith-endsWith | 577.8ms | 771.4ms | 686.3ms |
| array/push-pop | 593.1ms | 654.0ms | — |
| array/sort-i32 | 715.1ms | 785.9ms | — |
| array/map-filter | 719.5ms | 766.3ms | — |
| array/reduce | 666.4ms | 721.0ms | — |
| array/indexOf | 643.8ms | 742.1ms | — |
| array/slice | 578.6ms | 669.7ms | — |
| array/reverse | 589.4ms | 652.6ms | — |
| array/forEach | 667.4ms | 738.5ms | — |
| array/find | 579.0ms | 633.4ms | 634.7ms |
| dom/create-elements | 588.1ms | — | — |
| dom/set-attributes | 568.9ms | — | — |
| dom/read-attributes | 553.5ms | — | — |
| dom/modify-text | 540.0ms | — | — |
| mixed/csv-parse | 670.9ms | 726.6ms | — |
| mixed/text-search | 583.7ms | 727.7ms | 664.4ms |
| mixed/fibonacci | 571.6ms | 584.8ms | 574.9ms |
| mixed/matrix-multiply | 663.9ms | 728.5ms | 619.4ms |
| mixed/sieve | 644.4ms | 715.7ms | — |
