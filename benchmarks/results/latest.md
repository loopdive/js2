# js2wasm Benchmark Results

Date: 2026-08-21
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.049ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.025ms | gc-native |
| string/includes | 0.019ms | 0.138ms | 0.015ms | 0.071ms | gc-native |
| string/split | 0.416ms | 4.91ms | 0.451ms | FAILED | js |
| string/replace | 0.108ms | 0.300ms | 0.057ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.233ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.910ms | 0.187ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 0.359ms | 0.296ms | 0.563ms | gc-native |
| array/push-pop | 1.51ms | 0.511ms | 0.516ms | FAILED | host-call |
| array/sort-i32 | 0.793ms | 0.295ms | 0.294ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.071ms | 0.071ms | FAILED | gc-native |
| array/reduce | 2.21ms | 0.524ms | 0.515ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.63ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.255ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.042ms | 0.163ms | — | — | js |
| dom/set-attributes | 0.107ms | 0.534ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.125ms | — | — | js |
| dom/modify-text | 0.031ms | 0.106ms | — | — | js |
| mixed/csv-parse | 0.997ms | 7.31ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.62ms | 0.266ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.293ms | 0.292ms | 0.288ms | js |
| mixed/matrix-multiply | 0.159ms | 0.210ms | 0.210ms | 0.719ms | js |
| mixed/sieve | 1.60ms | 1.42ms | 1.44ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.72 | 4.91 | 3.94 | — |
| string/concat-long | 1000 | 3.77 | 4.53 | 3.97 | — |
| string/indexOf | 1000 | 19.20 | 62.83 | 12.28 | 25.12 |
| string/includes | 1000 | 19.40 | 138.20 | 14.84 | 70.56 |
| string/split | 10000 | 41.64 | 491.17 | 45.06 | — |
| string/replace | 1000 | 107.93 | 299.77 | 56.71 | — |
| string/case-convert | 2000 | 27.88 | 116.55 | 2.50 | — |
| string/substring | 10000 | 9.93 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.04 | 91.01 | 18.65 | — |
| string/startsWith-endsWith | 20000 | 20.02 | 17.93 | 14.78 | 28.15 |
| array/map-filter | 30000 | 4.27 | 2.37 | 2.35 | — |
| array/indexOf | 1000 | 3952.61 | 2635.04 | 2632.68 | — |
| dom/create-elements | 2000 | 21.04 | 81.56 | — | — |
| dom/set-attributes | 6000 | 17.86 | 89.06 | — | — |
| dom/read-attributes | 3000 | 18.53 | 41.68 | — | — |
| dom/modify-text | 2000 | 15.59 | 52.90 | — | — |
| mixed/csv-parse | 11000 | 90.67 | 664.39 | 28.64 | — |
| mixed/text-search | 40000 | 9.73 | 40.55 | 6.65 | 27.20 |
| mixed/fibonacci | 10000 | 12.03 | 29.31 | 29.24 | 28.85 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.68 | 1.68 | 5.75 |
| mixed/sieve | 200000 | 7.98 | 7.11 | 7.19 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.32x slower | 1.06x slower | — |
| string/concat-long | 1.20x slower | 1.05x slower | — |
| string/indexOf | 3.27x slower | 1.56x faster | 1.31x slower |
| string/includes | 7.12x slower | 1.31x faster | 3.64x slower |
| string/split | 11.80x slower | 1.08x slower | — |
| string/replace | 2.78x slower | 1.90x faster | — |
| string/case-convert | 4.18x slower | 11.14x faster | — |
| string/substring | 2.66x faster | 3.22x faster | — |
| string/trim | 5.34x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.41x slower |
| array/push-pop | 2.95x faster | 2.92x faster | — |
| array/sort-i32 | 2.69x faster | 2.70x faster | — |
| array/map-filter | 1.80x faster | 1.81x faster | — |
| array/reduce | 4.22x faster | 4.29x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.04x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.76x faster | — |
| array/find | 15.81x faster | 15.99x faster | 4.26x slower |
| dom/create-elements | 3.88x slower | — | — |
| dom/set-attributes | 4.99x slower | — | — |
| dom/read-attributes | 2.25x slower | — | — |
| dom/modify-text | 3.39x slower | — | — |
| mixed/csv-parse | 7.33x slower | 3.17x faster | — |
| mixed/text-search | 4.17x slower | 1.46x faster | 2.80x slower |
| mixed/fibonacci | 2.44x slower | 2.43x slower | 2.40x slower |
| mixed/matrix-multiply | 1.32x slower | 1.32x slower | 4.53x slower |
| mixed/sieve | 1.12x faster | 1.11x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.25x faster |
| string/concat-long | 1.14x faster |
| string/indexOf | 5.11x faster |
| string/includes | 9.31x faster |
| string/split | 10.90x faster |
| string/replace | 5.29x faster |
| string/case-convert | 46.54x faster |
| string/substring | 1.21x faster |
| string/trim | 4.88x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.02x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.03x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 23.20x faster |
| mixed/text-search | 6.10x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.1KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.2KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.3KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.6KB | 1.7KB |
| array/push-pop | 940B | 1.3KB | — |
| array/sort-i32 | 2.6KB | 3.1KB | — |
| array/map-filter | 3.3KB | 3.8KB | — |
| array/reduce | 2.3KB | 2.8KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 3.1KB | — |
| array/find | 946B | 1.3KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.3KB | 4.2KB | — |
| mixed/text-search | 1.9KB | 4.0KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 2.0KB | 992B |
| mixed/sieve | 1.6KB | 2.0KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1422.3ms | 1146.8ms | — |
| string/concat-long | 686.1ms | 1009.9ms | — |
| string/indexOf | 695.3ms | 993.0ms | 871.0ms |
| string/includes | 707.1ms | 1018.3ms | 909.7ms |
| string/split | 862.1ms | 1029.1ms | — |
| string/replace | 845.2ms | 1129.3ms | — |
| string/case-convert | 827.5ms | 936.2ms | — |
| string/substring | 706.9ms | 796.6ms | — |
| string/trim | 812.4ms | 1006.7ms | — |
| string/startsWith-endsWith | 808.2ms | 1055.3ms | 993.3ms |
| array/push-pop | 828.0ms | 902.6ms | — |
| array/sort-i32 | 947.1ms | 1001.9ms | — |
| array/map-filter | 924.8ms | 1103.0ms | — |
| array/reduce | 871.5ms | 984.0ms | — |
| array/indexOf | 872.0ms | 944.8ms | — |
| array/slice | 816.8ms | 891.2ms | — |
| array/reverse | 804.8ms | 892.7ms | — |
| array/forEach | 877.0ms | 1010.8ms | — |
| array/find | 852.4ms | 912.1ms | 903.5ms |
| dom/create-elements | 657.1ms | — | — |
| dom/set-attributes | 741.3ms | — | — |
| dom/read-attributes | 738.5ms | — | — |
| dom/modify-text | 647.8ms | — | — |
| mixed/csv-parse | 870.0ms | 992.9ms | — |
| mixed/text-search | 817.4ms | 1067.1ms | 975.5ms |
| mixed/fibonacci | 806.3ms | 875.6ms | 862.9ms |
| mixed/matrix-multiply | 925.7ms | 968.9ms | 846.6ms |
| mixed/sieve | 912.5ms | 972.7ms | — |
