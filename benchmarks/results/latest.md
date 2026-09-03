# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.034ms | 0.051ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.064ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.117ms | 0.015ms | 0.020ms | gc-native |
| string/split | 0.424ms | 8.08ms | 3.39ms | FAILED | js |
| string/replace | 0.106ms | 0.717ms | 0.370ms | FAILED | js |
| string/case-convert | 0.056ms | 0.676ms | 0.324ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 4.53ms | 3.19ms | FAILED | js |
| string/startsWith-endsWith | 0.403ms | 3.62ms | 3.44ms | 0.560ms | js |
| array/push-pop | 1.49ms | 0.502ms | 0.515ms | FAILED | host-call |
| array/sort-i32 | 0.795ms | 0.294ms | 0.567ms | FAILED | host-call |
| array/map-filter | 0.135ms | 0.071ms | 0.072ms | FAILED | host-call |
| array/reduce | 2.15ms | 0.506ms | 0.516ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.026ms | 0.028ms | 0.029ms | FAILED | js |
| array/reverse | 7.86ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.253ms | 0.017ms | 0.017ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 0.155ms | — | — | js |
| dom/set-attributes | 0.105ms | 0.495ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.110ms | — | — | js |
| mixed/csv-parse | 0.493ms | 8.38ms | 0.665ms | FAILED | js |
| mixed/text-search | 0.390ms | 4.66ms | 2.85ms | 1.13ms | js |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 1.32ms | js |
| mixed/matrix-multiply | 0.158ms | 74.53ms | 75.10ms | 0.722ms | js |
| mixed/sieve | 1.62ms | 2.12ms | 2.12ms | FAILED | js |

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
| string/concat-short | 10000 | 3.45 | 5.12 | 4.41 | — |
| string/concat-long | 1000 | 3.59 | 4.57 | 3.67 | — |
| string/indexOf | 1000 | 19.16 | 63.63 | 12.06 | 14.69 |
| string/includes | 1000 | 19.20 | 117.06 | 14.53 | 19.55 |
| string/split | 10000 | 42.45 | 808.10 | 339.12 | — |
| string/replace | 1000 | 105.87 | 717.45 | 369.90 | — |
| string/case-convert | 2000 | 27.97 | 337.95 | 162.09 | — |
| string/substring | 10000 | 9.94 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.04 | 453.17 | 319.36 | — |
| string/startsWith-endsWith | 20000 | 20.14 | 180.93 | 171.94 | 28.02 |
| array/map-filter | 30000 | 4.50 | 2.38 | 2.38 | — |
| array/indexOf | 1000 | 3952.22 | 2642.62 | 2641.08 | — |
| dom/create-elements | 2000 | 18.21 | 77.30 | — | — |
| dom/set-attributes | 6000 | 17.50 | 82.56 | — | — |
| dom/read-attributes | 3000 | 18.67 | 40.41 | — | — |
| dom/modify-text | 2000 | 14.74 | 55.17 | — | — |
| mixed/csv-parse | 11000 | 44.83 | 761.62 | 60.46 | — |
| mixed/text-search | 40000 | 9.74 | 116.51 | 71.17 | 28.19 |
| mixed/fibonacci | 10000 | 12.03 | 28.32 | 28.31 | 132.26 |
| mixed/matrix-multiply | 125000 | 1.27 | 596.21 | 600.80 | 5.77 |
| mixed/sieve | 200000 | 8.09 | 10.60 | 10.59 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.28x slower | — |
| string/concat-long | 1.27x slower | 1.02x slower | — |
| string/indexOf | 3.32x slower | 1.59x faster | 1.30x faster |
| string/includes | 6.10x slower | 1.32x faster | 1.02x slower |
| string/split | 19.04x slower | 7.99x slower | — |
| string/replace | 6.78x slower | 3.49x slower | — |
| string/case-convert | 12.08x slower | 5.80x slower | — |
| string/substring | 2.66x faster | 3.23x faster | — |
| string/trim | 26.60x slower | 18.75x slower | — |
| string/startsWith-endsWith | 8.98x slower | 8.54x slower | 1.39x slower |
| array/push-pop | 2.96x faster | 2.89x faster | — |
| array/sort-i32 | 2.70x faster | 1.40x faster | — |
| array/map-filter | 1.89x faster | 1.89x faster | — |
| array/reduce | 4.25x faster | 4.16x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.06x slower | 1.10x slower | — |
| array/reverse | 2.23x faster | 2.23x faster | — |
| array/forEach | 1.76x faster | 1.76x faster | — |
| array/find | 15.15x faster | 15.35x faster | 4.26x slower |
| dom/create-elements | 4.25x slower | — | — |
| dom/set-attributes | 4.72x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.74x slower | — | — |
| mixed/csv-parse | 16.99x slower | 1.35x slower | — |
| mixed/text-search | 11.96x slower | 7.30x slower | 2.89x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 10.99x slower |
| mixed/matrix-multiply | 471.28x slower | 474.91x slower | 4.56x slower |
| mixed/sieve | 1.31x slower | 1.31x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.16x faster |
| string/concat-long | 1.24x faster |
| string/indexOf | 5.28x faster |
| string/includes | 8.06x faster |
| string/split | 2.38x faster |
| string/replace | 1.94x faster |
| string/case-convert | 2.08x faster |
| string/substring | 1.22x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.05x faster |
| array/push-pop | 1.03x slower |
| array/sort-i32 | 1.93x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.04x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.01x faster |
| mixed/csv-parse | 12.60x faster |
| mixed/text-search | 1.64x faster |
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
| string/concat-short | 1733.1ms | 1085.4ms | — |
| string/concat-long | 777.4ms | 966.8ms | — |
| string/indexOf | 661.9ms | 984.2ms | 847.0ms |
| string/includes | 682.3ms | 972.8ms | 837.7ms |
| string/split | 768.4ms | 955.9ms | — |
| string/replace | 775.4ms | 1069.3ms | — |
| string/case-convert | 827.6ms | 904.8ms | — |
| string/substring | 679.3ms | 771.0ms | — |
| string/trim | 781.3ms | 1009.7ms | — |
| string/startsWith-endsWith | 778.1ms | 1049.3ms | 972.2ms |
| array/push-pop | 810.2ms | 871.4ms | — |
| array/sort-i32 | 980.1ms | 1094.4ms | — |
| array/map-filter | 957.6ms | 1055.9ms | — |
| array/reduce | 909.0ms | 1080.4ms | — |
| array/indexOf | 907.7ms | 1032.2ms | — |
| array/slice | 808.8ms | 916.8ms | — |
| array/reverse | 812.3ms | 912.5ms | — |
| array/forEach | 910.4ms | 1063.3ms | — |
| array/find | 816.7ms | 927.4ms | 889.2ms |
| dom/create-elements | 749.9ms | — | — |
| dom/set-attributes | 772.4ms | — | — |
| dom/read-attributes | 708.3ms | — | — |
| dom/modify-text | 703.2ms | — | — |
| mixed/csv-parse | 854.9ms | 986.1ms | — |
| mixed/text-search | 827.1ms | 1031.3ms | 917.5ms |
| mixed/fibonacci | 772.5ms | 843.3ms | 796.5ms |
| mixed/matrix-multiply | 964.7ms | 1008.3ms | 871.6ms |
| mixed/sieve | 864.4ms | 996.7ms | — |
