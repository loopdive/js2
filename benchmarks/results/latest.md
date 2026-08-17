# js2wasm Benchmark Results

Date: 2026-08-17
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.030ms | 0.045ms | 0.037ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.111ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.412ms | 5.01ms | 0.448ms | FAILED | js |
| string/replace | 0.103ms | 0.303ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.242ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.919ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.357ms | 0.296ms | 0.562ms | gc-native |
| array/push-pop | 1.39ms | 0.504ms | 0.498ms | FAILED | gc-native |
| array/sort-i32 | 0.793ms | 0.297ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.070ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.12ms | 0.505ms | 0.501ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.024ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.027ms | FAILED | gc-native |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.08ms | gc-native |
| dom/create-elements | 0.041ms | 0.164ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.491ms | — | — | js |
| dom/read-attributes | 0.054ms | 0.120ms | — | — | js |
| dom/modify-text | 0.029ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.475ms | 7.24ms | 0.317ms | FAILED | gc-native |
| mixed/text-search | 0.394ms | 1.62ms | 0.265ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.289ms | js |
| mixed/matrix-multiply | 0.157ms | 0.209ms | 0.225ms | 0.715ms | js |
| mixed/sieve | 1.55ms | 1.39ms | 1.41ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.05 | 4.54 | 3.71 | — |
| string/concat-long | 1000 | 3.56 | 4.51 | 3.60 | — |
| string/indexOf | 1000 | 19.08 | 62.52 | 12.26 | 14.71 |
| string/includes | 1000 | 19.18 | 110.58 | 14.39 | 15.38 |
| string/split | 10000 | 41.24 | 501.08 | 44.83 | — |
| string/replace | 1000 | 103.50 | 302.81 | 56.35 | — |
| string/case-convert | 2000 | 27.84 | 121.23 | 2.51 | — |
| string/substring | 10000 | 9.86 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.98 | 91.92 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.04 | 17.86 | 14.80 | 28.08 |
| array/map-filter | 30000 | 4.35 | 2.35 | 2.30 | — |
| array/indexOf | 1000 | 3948.31 | 2632.68 | 2634.07 | — |
| dom/create-elements | 2000 | 20.59 | 82.22 | — | — |
| dom/set-attributes | 6000 | 17.24 | 81.82 | — | — |
| dom/read-attributes | 3000 | 18.16 | 40.06 | — | — |
| dom/modify-text | 2000 | 14.48 | 54.30 | — | — |
| mixed/csv-parse | 11000 | 43.15 | 658.40 | 28.79 | — |
| mixed/text-search | 40000 | 9.84 | 40.49 | 6.64 | 27.43 |
| mixed/fibonacci | 10000 | 12.17 | 29.24 | 29.16 | 28.86 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.67 | 1.80 | 5.72 |
| mixed/sieve | 200000 | 7.73 | 6.94 | 7.04 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.49x slower | 1.22x slower | — |
| string/concat-long | 1.27x slower | 1.01x slower | — |
| string/indexOf | 3.28x slower | 1.56x faster | 1.30x faster |
| string/includes | 5.76x slower | 1.33x faster | 1.25x faster |
| string/split | 12.15x slower | 1.09x slower | — |
| string/replace | 2.93x slower | 1.84x faster | — |
| string/case-convert | 4.35x slower | 11.09x faster | — |
| string/substring | 2.64x faster | 3.21x faster | — |
| string/trim | 5.41x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.75x faster | 2.78x faster | — |
| array/sort-i32 | 2.67x faster | 2.71x faster | — |
| array/map-filter | 1.85x faster | 1.89x faster | — |
| array/reduce | 4.19x faster | 4.22x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.12x slower | 1.13x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.75x faster | — |
| array/find | 16.08x faster | 16.29x faster | 4.26x slower |
| dom/create-elements | 3.99x slower | — | — |
| dom/set-attributes | 4.75x slower | — | — |
| dom/read-attributes | 2.21x slower | — | — |
| dom/modify-text | 3.75x slower | — | — |
| mixed/csv-parse | 15.26x slower | 1.50x faster | — |
| mixed/text-search | 4.12x slower | 1.48x faster | 2.79x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.37x slower |
| mixed/matrix-multiply | 1.33x slower | 1.43x slower | 4.55x slower |
| mixed/sieve | 1.11x faster | 1.10x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.22x faster |
| string/concat-long | 1.25x faster |
| string/indexOf | 5.10x faster |
| string/includes | 7.69x faster |
| string/split | 11.18x faster |
| string/replace | 5.37x faster |
| string/case-convert | 48.29x faster |
| string/substring | 1.22x faster |
| string/trim | 4.93x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.02x faster |
| array/map-filter | 1.02x faster |
| array/reduce | 1.01x faster |
| array/indexOf | 1.00x slower |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 22.87x faster |
| mixed/text-search | 6.10x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.08x slower |
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
| array/sort-i32 | 2.6KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.7KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 1020B | 1.3KB | — |
| array/reverse | 998B | 1.3KB | — |
| array/forEach | 2.5KB | 2.9KB | — |
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
| string/concat-short | 1435.6ms | 1129.4ms | — |
| string/concat-long | 658.8ms | 966.7ms | — |
| string/indexOf | 669.8ms | 965.2ms | 828.0ms |
| string/includes | 676.5ms | 965.7ms | 849.2ms |
| string/split | 753.4ms | 981.1ms | — |
| string/replace | 775.4ms | 1037.7ms | — |
| string/case-convert | 778.4ms | 830.8ms | — |
| string/substring | 630.6ms | 738.3ms | — |
| string/trim | 756.4ms | 951.9ms | — |
| string/startsWith-endsWith | 740.7ms | 948.2ms | 907.0ms |
| array/push-pop | 792.8ms | 849.8ms | — |
| array/sort-i32 | 905.9ms | 993.5ms | — |
| array/map-filter | 901.0ms | 999.3ms | — |
| array/reduce | 843.6ms | 900.5ms | — |
| array/indexOf | 824.9ms | 888.5ms | — |
| array/slice | 755.9ms | 812.3ms | — |
| array/reverse | 738.1ms | 830.5ms | — |
| array/forEach | 834.1ms | 928.3ms | — |
| array/find | 733.8ms | 837.2ms | 815.7ms |
| dom/create-elements | 620.5ms | — | — |
| dom/set-attributes | 684.7ms | — | — |
| dom/read-attributes | 666.8ms | — | — |
| dom/modify-text | 588.4ms | — | — |
| mixed/csv-parse | 777.9ms | 951.6ms | — |
| mixed/text-search | 763.1ms | 966.3ms | 890.7ms |
| mixed/fibonacci | 768.8ms | 807.6ms | 791.2ms |
| mixed/matrix-multiply | 844.5ms | 958.0ms | 800.8ms |
| mixed/sieve | 855.9ms | 922.8ms | — |
