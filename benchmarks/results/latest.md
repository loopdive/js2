# js2wasm Benchmark Results

Date: 2026-08-10
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.048ms | 0.049ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.060ms | 0.013ms | 0.025ms | gc-native |
| string/includes | 0.019ms | 0.123ms | 0.014ms | 0.017ms | gc-native |
| string/split | 0.421ms | 4.67ms | 0.505ms | FAILED | js |
| string/replace | 0.095ms | 0.228ms | 0.068ms | FAILED | gc-native |
| string/case-convert | 0.058ms | 0.267ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.104ms | 0.040ms | 0.034ms | FAILED | gc-native |
| string/trim | 0.173ms | 0.937ms | 0.197ms | FAILED | js |
| string/startsWith-endsWith | 0.413ms | 0.337ms | 0.307ms | 0.554ms | gc-native |
| array/push-pop | 1.67ms | 0.603ms | 0.599ms | FAILED | gc-native |
| array/sort-i32 | 0.839ms | 0.306ms | 0.307ms | FAILED | host-call |
| array/map-filter | 0.134ms | 0.065ms | 0.065ms | FAILED | gc-native |
| array/reduce | 2.39ms | 0.601ms | 0.605ms | FAILED | host-call |
| array/indexOf | 4.46ms | 2.86ms | 2.86ms | FAILED | gc-native |
| array/slice | 0.036ms | 0.017ms | 0.017ms | FAILED | host-call |
| array/reverse | 8.85ms | 3.98ms | 3.97ms | FAILED | gc-native |
| array/forEach | 0.052ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.271ms | 0.015ms | 0.015ms | 1.11ms | host-call |
| dom/create-elements | 0.200ms | 0.160ms | — | — | host-call |
| dom/set-attributes | 0.112ms | 0.558ms | — | — | js |
| dom/read-attributes | 0.061ms | 0.134ms | — | — | js |
| dom/modify-text | 0.032ms | 0.120ms | — | — | js |
| mixed/csv-parse | 0.475ms | 6.72ms | 0.308ms | FAILED | gc-native |
| mixed/text-search | 0.403ms | 1.31ms | 0.293ms | 1.13ms | gc-native |
| mixed/fibonacci | 0.125ms | 0.273ms | 0.273ms | 0.284ms | js |
| mixed/matrix-multiply | 0.185ms | 0.209ms | 0.209ms | 0.718ms | js |
| mixed/sieve | 1.77ms | 1.51ms | 1.48ms | FAILED | gc-native |

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
| string/concat-short | 10000 | 3.35 | 4.81 | 4.93 | — |
| string/concat-long | 1000 | 4.05 | 5.06 | 3.34 | — |
| string/indexOf | 1000 | 18.96 | 60.35 | 12.58 | 24.68 |
| string/includes | 1000 | 18.69 | 123.12 | 14.26 | 16.73 |
| string/split | 10000 | 42.11 | 466.62 | 50.53 | — |
| string/replace | 1000 | 95.35 | 227.68 | 68.40 | — |
| string/case-convert | 2000 | 28.95 | 133.28 | 2.68 | — |
| string/substring | 10000 | 10.40 | 3.99 | 3.44 | — |
| string/trim | 10000 | 17.26 | 93.67 | 19.68 | — |
| string/startsWith-endsWith | 20000 | 20.64 | 16.87 | 15.34 | 27.68 |
| array/map-filter | 30000 | 4.48 | 2.17 | 2.17 | — |
| array/indexOf | 1000 | 4456.77 | 2862.45 | 2861.34 | — |
| dom/create-elements | 2000 | 100.23 | 80.19 | — | — |
| dom/set-attributes | 6000 | 18.63 | 92.97 | — | — |
| dom/read-attributes | 3000 | 20.44 | 44.73 | — | — |
| dom/modify-text | 2000 | 15.83 | 59.80 | — | — |
| mixed/csv-parse | 11000 | 43.20 | 610.60 | 28.01 | — |
| mixed/text-search | 40000 | 10.07 | 32.69 | 7.32 | 28.16 |
| mixed/fibonacci | 10000 | 12.52 | 27.29 | 27.28 | 28.35 |
| mixed/matrix-multiply | 125000 | 1.48 | 1.67 | 1.67 | 5.74 |
| mixed/sieve | 200000 | 8.86 | 7.57 | 7.41 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.44x slower | 1.47x slower | — |
| string/concat-long | 1.25x slower | 1.21x faster | — |
| string/indexOf | 3.18x slower | 1.51x faster | 1.30x slower |
| string/includes | 6.59x slower | 1.31x faster | 1.12x faster |
| string/split | 11.08x slower | 1.20x slower | — |
| string/replace | 2.39x slower | 1.39x faster | — |
| string/case-convert | 4.60x slower | 10.81x faster | — |
| string/substring | 2.60x faster | 3.03x faster | — |
| string/trim | 5.43x slower | 1.14x slower | — |
| string/startsWith-endsWith | 1.22x faster | 1.35x faster | 1.34x slower |
| array/push-pop | 2.76x faster | 2.78x faster | — |
| array/sort-i32 | 2.75x faster | 2.73x faster | — |
| array/map-filter | 2.06x faster | 2.07x faster | — |
| array/reduce | 3.97x faster | 3.95x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.07x faster | 2.07x faster | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.82x faster | 1.83x faster | — |
| array/find | 18.49x faster | 18.10x faster | 4.12x slower |
| dom/create-elements | 1.25x faster | — | — |
| dom/set-attributes | 4.99x slower | — | — |
| dom/read-attributes | 2.19x slower | — | — |
| dom/modify-text | 3.78x slower | — | — |
| mixed/csv-parse | 14.13x slower | 1.54x faster | — |
| mixed/text-search | 3.25x slower | 1.38x faster | 2.80x slower |
| mixed/fibonacci | 2.18x slower | 2.18x slower | 2.26x slower |
| mixed/matrix-multiply | 1.13x slower | 1.13x slower | 3.88x slower |
| mixed/sieve | 1.17x faster | 1.20x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.03x slower |
| string/concat-long | 1.51x faster |
| string/indexOf | 4.80x faster |
| string/includes | 8.63x faster |
| string/split | 9.23x faster |
| string/replace | 3.33x faster |
| string/case-convert | 49.78x faster |
| string/substring | 1.16x faster |
| string/trim | 4.76x faster |
| string/startsWith-endsWith | 1.10x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.00x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x faster |
| array/find | 1.02x slower |
| mixed/csv-parse | 21.80x faster |
| mixed/text-search | 4.46x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
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
| string/concat-short | 1257.3ms | 1078.0ms | — |
| string/concat-long | 621.0ms | 946.7ms | — |
| string/indexOf | 774.6ms | 973.0ms | 843.4ms |
| string/includes | 812.5ms | 985.7ms | 840.5ms |
| string/split | 761.7ms | 943.6ms | — |
| string/replace | 808.0ms | 1074.4ms | — |
| string/case-convert | 783.3ms | 839.8ms | — |
| string/substring | 651.4ms | 764.7ms | — |
| string/trim | 738.0ms | 967.8ms | — |
| string/startsWith-endsWith | 730.6ms | 972.6ms | 898.1ms |
| array/push-pop | 765.9ms | 794.2ms | — |
| array/sort-i32 | 936.9ms | 981.1ms | — |
| array/map-filter | 871.8ms | 990.6ms | — |
| array/reduce | 820.7ms | 892.2ms | — |
| array/indexOf | 955.9ms | 958.3ms | — |
| array/slice | 748.9ms | 791.6ms | — |
| array/reverse | 752.1ms | 816.6ms | — |
| array/forEach | 856.7ms | 914.8ms | — |
| array/find | 732.8ms | 824.9ms | 822.7ms |
| dom/create-elements | 657.9ms | — | — |
| dom/set-attributes | 725.7ms | — | — |
| dom/read-attributes | 706.2ms | — | — |
| dom/modify-text | 637.5ms | — | — |
| mixed/csv-parse | 801.1ms | 981.1ms | — |
| mixed/text-search | 764.5ms | 984.5ms | 886.3ms |
| mixed/fibonacci | 807.6ms | 865.4ms | 763.6ms |
| mixed/matrix-multiply | 834.1ms | 877.9ms | 811.4ms |
| mixed/sieve | 803.3ms | 897.6ms | — |
