# js2wasm Benchmark Results

Date: 2026-08-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.028ms | 0.044ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.051ms | 0.015ms | 0.018ms | gc-native |
| string/split | 0.412ms | 4.79ms | 0.449ms | FAILED | js |
| string/replace | 0.116ms | 0.309ms | 0.071ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.238ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.894ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.402ms | 0.359ms | 0.288ms | 0.560ms | gc-native |
| array/push-pop | 1.39ms | 0.503ms | 0.503ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.304ms | 0.300ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.069ms | 0.069ms | FAILED | gc-native |
| array/reduce | 2.18ms | 0.505ms | 0.511ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.83ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.036ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.571ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.125ms | — | — | js |
| dom/modify-text | 0.031ms | 0.113ms | — | — | js |
| mixed/csv-parse | 0.481ms | 7.53ms | 0.318ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.55ms | 0.266ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.119ms | 0.235ms | 0.235ms | 0.250ms | js |
| mixed/matrix-multiply | 0.158ms | 0.210ms | 0.219ms | 0.720ms | js |
| mixed/sieve | 1.56ms | 1.42ms | 1.39ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 2.81 | 4.43 | 3.83 | — |
| string/concat-long | 1000 | 3.60 | 4.53 | 3.78 | — |
| string/indexOf | 1000 | 19.16 | 65.08 | 12.33 | 14.61 |
| string/includes | 1000 | 19.17 | 51.46 | 14.59 | 18.00 |
| string/split | 10000 | 41.20 | 478.60 | 44.88 | — |
| string/replace | 1000 | 116.36 | 309.47 | 71.04 | — |
| string/case-convert | 2000 | 27.81 | 118.87 | 2.50 | — |
| string/substring | 10000 | 9.90 | 3.74 | 3.07 | — |
| string/trim | 10000 | 16.98 | 89.44 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.08 | 17.97 | 14.41 | 28.00 |
| array/map-filter | 30000 | 4.28 | 2.29 | 2.29 | — |
| array/indexOf | 1000 | 3948.80 | 2639.14 | 2637.74 | — |
| dom/create-elements | 2000 | 17.76 | 76.20 | — | — |
| dom/set-attributes | 6000 | 17.49 | 95.21 | — | — |
| dom/read-attributes | 3000 | 18.36 | 41.74 | — | — |
| dom/modify-text | 2000 | 15.62 | 56.65 | — | — |
| mixed/csv-parse | 11000 | 43.69 | 684.25 | 28.91 | — |
| mixed/text-search | 40000 | 9.72 | 38.84 | 6.65 | 26.98 |
| mixed/fibonacci | 10000 | 11.86 | 23.48 | 23.47 | 24.97 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.68 | 1.75 | 5.76 |
| mixed/sieve | 200000 | 7.79 | 7.11 | 6.96 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.58x slower | 1.36x slower | — |
| string/concat-long | 1.26x slower | 1.05x slower | — |
| string/indexOf | 3.40x slower | 1.55x faster | 1.31x faster |
| string/includes | 2.68x slower | 1.31x faster | 1.06x faster |
| string/split | 11.62x slower | 1.09x slower | — |
| string/replace | 2.66x slower | 1.64x faster | — |
| string/case-convert | 4.27x slower | 11.11x faster | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 5.27x slower | 1.10x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.39x faster | 1.39x slower |
| array/push-pop | 2.76x faster | 2.76x faster | — |
| array/sort-i32 | 2.60x faster | 2.64x faster | — |
| array/map-filter | 1.87x faster | 1.87x faster | — |
| array/reduce | 4.31x faster | 4.26x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.05x slower | 1.06x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.75x faster | 1.75x faster | — |
| array/find | 15.87x faster | 15.91x faster | 4.23x slower |
| dom/create-elements | 4.29x slower | — | — |
| dom/set-attributes | 5.45x slower | — | — |
| dom/read-attributes | 2.27x slower | — | — |
| dom/modify-text | 3.63x slower | — | — |
| mixed/csv-parse | 15.66x slower | 1.51x faster | — |
| mixed/text-search | 4.00x slower | 1.46x faster | 2.78x slower |
| mixed/fibonacci | 1.98x slower | 1.98x slower | 2.10x slower |
| mixed/matrix-multiply | 1.33x slower | 1.39x slower | 4.57x slower |
| mixed/sieve | 1.10x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.20x faster |
| string/indexOf | 5.28x faster |
| string/includes | 3.53x faster |
| string/split | 10.66x faster |
| string/replace | 4.36x faster |
| string/case-convert | 47.48x faster |
| string/substring | 1.22x faster |
| string/trim | 4.80x faster |
| string/startsWith-endsWith | 1.25x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.01x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 23.67x faster |
| mixed/text-search | 5.84x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.04x slower |
| mixed/sieve | 1.02x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 427B | 1.1KB | 10.4KB |
| string/includes | 414B | 1.1KB | 10.4KB |
| string/split | 1.5KB | 3.0KB | — |
| string/replace | 1.7KB | 3.9KB | — |
| string/case-convert | 1.6KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 874B | 1.2KB | — |
| array/sort-i32 | 2.7KB | 3.0KB | — |
| array/map-filter | 3.2KB | 3.5KB | — |
| array/reduce | 2.2KB | 2.5KB | — |
| array/indexOf | 1.7KB | 2.0KB | — |
| array/slice | 954B | 1.2KB | — |
| array/reverse | 932B | 1.2KB | — |
| array/forEach | 2.4KB | 2.8KB | — |
| array/find | 880B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.8KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 350B | 350B | 342B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.4KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1304.0ms | 1146.4ms | — |
| string/concat-long | 655.8ms | 995.5ms | — |
| string/indexOf | 822.8ms | 1009.8ms | 862.2ms |
| string/includes | 794.6ms | 1045.4ms | 883.9ms |
| string/split | 759.6ms | 1070.0ms | — |
| string/replace | 829.9ms | 1142.1ms | — |
| string/case-convert | 815.6ms | 974.1ms | — |
| string/substring | 661.5ms | 739.7ms | — |
| string/trim | 739.0ms | 989.8ms | — |
| string/startsWith-endsWith | 731.8ms | 990.3ms | 925.7ms |
| array/push-pop | 781.8ms | 807.3ms | — |
| array/sort-i32 | 949.5ms | 1018.7ms | — |
| array/map-filter | 922.5ms | 1005.1ms | — |
| array/reduce | 832.2ms | 943.6ms | — |
| array/indexOf | 955.2ms | 980.3ms | — |
| array/slice | 760.7ms | 871.8ms | — |
| array/reverse | 777.1ms | 814.1ms | — |
| array/forEach | 861.0ms | 963.0ms | — |
| array/find | 767.9ms | 862.8ms | 859.2ms |
| dom/create-elements | 639.2ms | — | — |
| dom/set-attributes | 749.4ms | — | — |
| dom/read-attributes | 719.9ms | — | — |
| dom/modify-text | 648.9ms | — | — |
| mixed/csv-parse | 783.8ms | 1022.6ms | — |
| mixed/text-search | 800.8ms | 1059.1ms | 910.1ms |
| mixed/fibonacci | 845.5ms | 911.7ms | 825.6ms |
| mixed/matrix-multiply | 829.9ms | 970.6ms | 804.4ms |
| mixed/sieve | 854.4ms | 940.6ms | — |
