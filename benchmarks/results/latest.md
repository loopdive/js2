# js2wasm Benchmark Results

Date: 2026-09-04
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.045ms | 0.050ms | 0.051ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.057ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.018ms | 0.105ms | 0.014ms | 0.022ms | gc-native |
| string/split | 0.417ms | 7.58ms | 2.69ms | FAILED | js |
| string/replace | 0.110ms | 0.571ms | 0.308ms | FAILED | js |
| string/case-convert | 0.057ms | 0.575ms | 0.254ms | FAILED | js |
| string/substring | 0.099ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.162ms | 3.71ms | 2.66ms | FAILED | js |
| string/startsWith-endsWith | 0.430ms | 2.92ms | 2.91ms | 0.577ms | js |
| array/push-pop | 1.43ms | 0.498ms | 0.497ms | FAILED | gc-native |
| array/sort-i32 | 0.717ms | 0.311ms | 0.310ms | FAILED | gc-native |
| array/map-filter | 0.144ms | 0.088ms | 0.084ms | FAILED | gc-native |
| array/reduce | 2.00ms | 0.500ms | 0.498ms | FAILED | gc-native |
| array/indexOf | 4.82ms | 2.75ms | 2.75ms | FAILED | host-call |
| array/slice | 0.037ms | 0.034ms | 0.034ms | FAILED | gc-native |
| array/reverse | 7.26ms | 3.63ms | 3.63ms | FAILED | host-call |
| array/forEach | 0.107ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.265ms | 0.017ms | 0.017ms | 0.983ms | host-call |
| dom/create-elements | 0.061ms | 0.198ms | — | — | js |
| dom/set-attributes | 0.125ms | 0.516ms | — | — | js |
| dom/read-attributes | 0.068ms | 0.134ms | — | — | js |
| dom/modify-text | 0.051ms | 0.120ms | — | — | js |
| mixed/csv-parse | 0.992ms | 8.03ms | 0.586ms | FAILED | gc-native |
| mixed/text-search | 0.397ms | 4.55ms | 2.76ms | 1.53ms | js |
| mixed/fibonacci | 0.134ms | 0.353ms | 0.353ms | 0.352ms | js |
| mixed/matrix-multiply | 0.203ms | 67.65ms | 68.32ms | 0.772ms | js |
| mixed/sieve | 1.51ms | 2.18ms | 2.21ms | FAILED | js |

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
| string/concat-short | 10000 | 4.51 | 5.00 | 5.13 | — |
| string/concat-long | 1000 | 4.22 | 4.73 | 5.69 | — |
| string/indexOf | 1000 | 18.04 | 56.84 | 12.29 | 14.98 |
| string/includes | 1000 | 18.03 | 104.89 | 13.94 | 21.92 |
| string/split | 10000 | 41.70 | 757.64 | 268.69 | — |
| string/replace | 1000 | 109.66 | 571.44 | 308.39 | — |
| string/case-convert | 2000 | 28.75 | 287.71 | 126.77 | — |
| string/substring | 10000 | 9.90 | 4.19 | 3.59 | — |
| string/trim | 10000 | 16.21 | 371.30 | 265.77 | — |
| string/startsWith-endsWith | 20000 | 21.48 | 146.22 | 145.25 | 28.87 |
| array/map-filter | 30000 | 4.81 | 2.94 | 2.80 | — |
| array/indexOf | 1000 | 4824.71 | 2747.57 | 2750.13 | — |
| dom/create-elements | 2000 | 30.50 | 98.95 | — | — |
| dom/set-attributes | 6000 | 20.89 | 86.03 | — | — |
| dom/read-attributes | 3000 | 22.75 | 44.51 | — | — |
| dom/modify-text | 2000 | 25.44 | 60.04 | — | — |
| mixed/csv-parse | 11000 | 90.21 | 730.20 | 53.27 | — |
| mixed/text-search | 40000 | 9.92 | 113.85 | 69.04 | 38.37 |
| mixed/fibonacci | 10000 | 13.37 | 35.27 | 35.27 | 35.17 |
| mixed/matrix-multiply | 125000 | 1.63 | 541.20 | 546.57 | 6.17 |
| mixed/sieve | 200000 | 7.53 | 10.88 | 11.05 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.11x slower | 1.14x slower | — |
| string/concat-long | 1.12x slower | 1.35x slower | — |
| string/indexOf | 3.15x slower | 1.47x faster | 1.20x faster |
| string/includes | 5.82x slower | 1.29x faster | 1.22x slower |
| string/split | 18.17x slower | 6.44x slower | — |
| string/replace | 5.21x slower | 2.81x slower | — |
| string/case-convert | 10.01x slower | 4.41x slower | — |
| string/substring | 2.36x faster | 2.76x faster | — |
| string/trim | 22.91x slower | 16.40x slower | — |
| string/startsWith-endsWith | 6.81x slower | 6.76x slower | 1.34x slower |
| array/push-pop | 2.88x faster | 2.88x faster | — |
| array/sort-i32 | 2.30x faster | 2.31x faster | — |
| array/map-filter | 1.63x faster | 1.72x faster | — |
| array/reduce | 4.00x faster | 4.01x faster | — |
| array/indexOf | 1.76x faster | 1.75x faster | — |
| array/slice | 1.08x faster | 1.10x faster | — |
| array/reverse | 2.00x faster | 2.00x faster | — |
| array/forEach | 3.77x faster | 3.80x faster | — |
| array/find | 15.64x faster | 15.52x faster | 3.71x slower |
| dom/create-elements | 3.24x slower | — | — |
| dom/set-attributes | 4.12x slower | — | — |
| dom/read-attributes | 1.96x slower | — | — |
| dom/modify-text | 2.36x slower | — | — |
| mixed/csv-parse | 8.09x slower | 1.69x faster | — |
| mixed/text-search | 11.48x slower | 6.96x slower | 3.87x slower |
| mixed/fibonacci | 2.64x slower | 2.64x slower | 2.63x slower |
| mixed/matrix-multiply | 332.73x slower | 336.04x slower | 3.80x slower |
| mixed/sieve | 1.44x slower | 1.47x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x slower |
| string/concat-long | 1.20x slower |
| string/indexOf | 4.62x faster |
| string/includes | 7.53x faster |
| string/split | 2.82x faster |
| string/replace | 1.85x faster |
| string/case-convert | 2.27x faster |
| string/substring | 1.17x faster |
| string/trim | 1.40x faster |
| string/startsWith-endsWith | 1.01x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.05x faster |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 13.71x faster |
| mixed/text-search | 1.65x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.01x slower |
| mixed/sieve | 1.02x slower |

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
| string/concat-short | 1542.5ms | 1035.2ms | — |
| string/concat-long | 733.3ms | 953.2ms | — |
| string/indexOf | 652.4ms | 969.3ms | 818.0ms |
| string/includes | 659.9ms | 975.6ms | 824.0ms |
| string/split | 753.3ms | 977.9ms | — |
| string/replace | 734.2ms | 1076.3ms | — |
| string/case-convert | 774.7ms | 882.8ms | — |
| string/substring | 636.5ms | 747.7ms | — |
| string/trim | 734.4ms | 954.8ms | — |
| string/startsWith-endsWith | 742.3ms | 972.2ms | 883.8ms |
| array/push-pop | 761.5ms | 822.9ms | — |
| array/sort-i32 | 922.6ms | 970.0ms | — |
| array/map-filter | 927.7ms | 1034.1ms | — |
| array/reduce | 836.0ms | 980.5ms | — |
| array/indexOf | 868.1ms | 960.1ms | — |
| array/slice | 789.9ms | 867.7ms | — |
| array/reverse | 792.5ms | 850.7ms | — |
| array/forEach | 884.2ms | 984.0ms | — |
| array/find | 763.0ms | 850.0ms | 812.5ms |
| dom/create-elements | 663.4ms | — | — |
| dom/set-attributes | 705.0ms | — | — |
| dom/read-attributes | 673.1ms | — | — |
| dom/modify-text | 676.3ms | — | — |
| mixed/csv-parse | 783.7ms | 947.7ms | — |
| mixed/text-search | 751.9ms | 947.8ms | 884.8ms |
| mixed/fibonacci | 752.2ms | 810.1ms | 751.2ms |
| mixed/matrix-multiply | 921.7ms | 954.1ms | 809.1ms |
| mixed/sieve | 899.7ms | 933.3ms | — |
