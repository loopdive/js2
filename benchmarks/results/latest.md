# js2wasm Benchmark Results

Date: 2026-08-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.031ms | 0.045ms | 0.038ms | FAILED | js |
| string/concat-long | 0.004ms | 0.004ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.065ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.051ms | 0.015ms | 0.015ms | linear-memory |
| string/split | 0.423ms | 4.96ms | 0.449ms | FAILED | js |
| string/replace | 0.109ms | 0.306ms | 0.056ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.235ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.098ms | 0.038ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.908ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.400ms | 0.357ms | 0.298ms | 0.562ms | gc-native |
| array/push-pop | 1.40ms | 0.502ms | 0.500ms | FAILED | gc-native |
| array/sort-i32 | 0.791ms | 0.292ms | 0.293ms | FAILED | host-call |
| array/map-filter | 0.071ms | 0.070ms | 0.070ms | FAILED | gc-native |
| array/reduce | 2.14ms | 0.506ms | 0.507ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.63ms | 2.63ms | FAILED | host-call |
| array/slice | 0.025ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.048ms | 0.028ms | 0.028ms | FAILED | host-call |
| array/find | 0.253ms | 0.016ms | 0.016ms | 1.07ms | host-call |
| dom/create-elements | 0.035ms | 0.157ms | — | — | js |
| dom/set-attributes | 0.103ms | 0.472ms | — | — | js |
| dom/read-attributes | 0.055ms | 0.121ms | — | — | js |
| dom/modify-text | 0.029ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.478ms | 7.45ms | 0.314ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 1.53ms | 0.267ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.292ms | 0.292ms | 0.286ms | js |
| mixed/matrix-multiply | 0.158ms | 0.225ms | 0.210ms | 0.727ms | js |
| mixed/sieve | 1.57ms | 1.41ms | 1.40ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.07 | 4.54 | 3.75 | — |
| string/concat-long | 1000 | 3.55 | 4.47 | 3.66 | — |
| string/indexOf | 1000 | 19.15 | 65.30 | 12.11 | 14.62 |
| string/includes | 1000 | 19.20 | 50.56 | 15.41 | 15.37 |
| string/split | 10000 | 42.35 | 496.42 | 44.95 | — |
| string/replace | 1000 | 109.32 | 305.96 | 56.06 | — |
| string/case-convert | 2000 | 27.79 | 117.59 | 2.51 | — |
| string/substring | 10000 | 9.84 | 3.76 | 3.07 | — |
| string/trim | 10000 | 17.04 | 90.82 | 18.64 | — |
| string/startsWith-endsWith | 20000 | 20.02 | 17.85 | 14.88 | 28.09 |
| array/map-filter | 30000 | 2.37 | 2.34 | 2.32 | — |
| array/indexOf | 1000 | 3951.50 | 2632.13 | 2632.50 | — |
| dom/create-elements | 2000 | 17.43 | 78.63 | — | — |
| dom/set-attributes | 6000 | 17.22 | 78.65 | — | — |
| dom/read-attributes | 3000 | 18.45 | 40.48 | — | — |
| dom/modify-text | 2000 | 14.54 | 53.82 | — | — |
| mixed/csv-parse | 11000 | 43.46 | 677.13 | 28.52 | — |
| mixed/text-search | 40000 | 9.73 | 38.26 | 6.67 | 27.00 |
| mixed/fibonacci | 10000 | 12.17 | 29.24 | 29.23 | 28.60 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.80 | 1.68 | 5.82 |
| mixed/sieve | 200000 | 7.85 | 7.03 | 7.00 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.48x slower | 1.22x slower | — |
| string/concat-long | 1.26x slower | 1.03x slower | — |
| string/indexOf | 3.41x slower | 1.58x faster | 1.31x faster |
| string/includes | 2.63x slower | 1.25x faster | 1.25x faster |
| string/split | 11.72x slower | 1.06x slower | — |
| string/replace | 2.80x slower | 1.95x faster | — |
| string/case-convert | 4.23x slower | 11.06x faster | — |
| string/substring | 2.62x faster | 3.20x faster | — |
| string/trim | 5.33x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.79x faster | 2.80x faster | — |
| array/sort-i32 | 2.70x faster | 2.70x faster | — |
| array/map-filter | 1.02x faster | 1.02x faster | — |
| array/reduce | 4.23x faster | 4.23x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.07x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.74x faster | 1.72x faster | — |
| array/find | 16.18x faster | 16.14x faster | 4.23x slower |
| dom/create-elements | 4.51x slower | — | — |
| dom/set-attributes | 4.57x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 3.70x slower | — | — |
| mixed/csv-parse | 15.58x slower | 1.52x faster | — |
| mixed/text-search | 3.93x slower | 1.46x faster | 2.77x slower |
| mixed/fibonacci | 2.40x slower | 2.40x slower | 2.35x slower |
| mixed/matrix-multiply | 1.42x slower | 1.33x slower | 4.59x slower |
| mixed/sieve | 1.12x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.21x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 5.39x faster |
| string/includes | 3.28x faster |
| string/split | 11.04x faster |
| string/replace | 5.46x faster |
| string/case-convert | 46.79x faster |
| string/substring | 1.22x faster |
| string/trim | 4.87x faster |
| string/startsWith-endsWith | 1.20x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.01x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x slower |
| array/find | 1.00x slower |
| mixed/csv-parse | 23.74x faster |
| mixed/text-search | 5.73x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.07x faster |
| mixed/sieve | 1.01x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 731B | — |
| string/concat-long | 223B | 935B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.0KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.7KB | — |
| string/startsWith-endsWith | 1.7KB | 3.5KB | 1.7KB |
| array/push-pop | 914B | 1.2KB | — |
| array/sort-i32 | 2.5KB | 2.9KB | — |
| array/map-filter | 3.3KB | 3.6KB | — |
| array/reduce | 2.3KB | 2.6KB | — |
| array/indexOf | 1.6KB | 2.0KB | — |
| array/slice | 994B | 1.3KB | — |
| array/reverse | 972B | 1.3KB | — |
| array/forEach | 2.5KB | 2.8KB | — |
| array/find | 920B | 1.2KB | 635B |
| dom/create-elements | 271B | — | — |
| dom/set-attributes | 524B | — | — |
| dom/read-attributes | 389B | — | — |
| dom/modify-text | 264B | — | — |
| mixed/csv-parse | 2.2KB | 4.1KB | — |
| mixed/text-search | 1.9KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 411B | 411B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.6KB | 1.9KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1270.3ms | 1071.1ms | — |
| string/concat-long | 624.2ms | 972.8ms | — |
| string/indexOf | 641.7ms | 946.3ms | 836.5ms |
| string/includes | 641.5ms | 991.1ms | 834.0ms |
| string/split | 760.8ms | 953.0ms | — |
| string/replace | 747.0ms | 1009.5ms | — |
| string/case-convert | 759.8ms | 843.4ms | — |
| string/substring | 640.9ms | 749.2ms | — |
| string/trim | 742.2ms | 943.1ms | — |
| string/startsWith-endsWith | 789.7ms | 948.3ms | 889.2ms |
| array/push-pop | 767.6ms | 838.6ms | — |
| array/sort-i32 | 866.0ms | 975.6ms | — |
| array/map-filter | 906.4ms | 977.7ms | — |
| array/reduce | 822.0ms | 908.2ms | — |
| array/indexOf | 836.3ms | 910.6ms | — |
| array/slice | 758.1ms | 826.7ms | — |
| array/reverse | 755.7ms | 803.0ms | — |
| array/forEach | 868.0ms | 928.7ms | — |
| array/find | 721.6ms | 799.6ms | 790.5ms |
| dom/create-elements | 591.3ms | — | — |
| dom/set-attributes | 681.3ms | — | — |
| dom/read-attributes | 683.0ms | — | — |
| dom/modify-text | 585.6ms | — | — |
| mixed/csv-parse | 791.5ms | 894.8ms | — |
| mixed/text-search | 761.9ms | 1009.1ms | 893.1ms |
| mixed/fibonacci | 762.5ms | 816.2ms | 806.6ms |
| mixed/matrix-multiply | 874.0ms | 895.3ms | 805.7ms |
| mixed/sieve | 828.7ms | 926.3ms | — |
