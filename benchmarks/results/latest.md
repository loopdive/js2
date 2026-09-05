# js2wasm Benchmark Results

Date: 2026-09-05
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.032ms | 0.050ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | js |
| string/indexOf | 0.019ms | 0.066ms | 0.012ms | 0.015ms | gc-native |
| string/includes | 0.019ms | 0.104ms | 0.015ms | 0.020ms | gc-native |
| string/split | 0.429ms | 8.38ms | 2.75ms | FAILED | js |
| string/replace | 0.107ms | 0.682ms | 0.327ms | FAILED | js |
| string/case-convert | 0.056ms | 0.559ms | 0.271ms | FAILED | js |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 3.78ms | 2.65ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 2.89ms | 2.98ms | 0.562ms | js |
| array/push-pop | 1.42ms | 0.504ms | 0.508ms | FAILED | host-call |
| array/sort-i32 | 0.788ms | 0.399ms | 0.292ms | FAILED | gc-native |
| array/map-filter | 0.131ms | 0.071ms | 0.070ms | FAILED | gc-native |
| array/reduce | 1.34ms | 0.507ms | 0.510ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.025ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.53ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 1.07ms | gc-native |
| dom/create-elements | 0.036ms | 0.152ms | — | — | js |
| dom/set-attributes | 0.104ms | 0.476ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.122ms | — | — | js |
| dom/modify-text | 0.029ms | 0.108ms | — | — | js |
| mixed/csv-parse | 0.486ms | 8.66ms | 0.618ms | FAILED | js |
| mixed/text-search | 0.389ms | 5.02ms | 3.00ms | 1.08ms | js |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.159ms | 72.34ms | 72.06ms | 0.716ms | js |
| mixed/sieve | 1.52ms | 2.12ms | 2.14ms | FAILED | js |

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
| string/concat-short | 10000 | 3.22 | 4.97 | 4.40 | — |
| string/concat-long | 1000 | 3.64 | 4.53 | 3.74 | — |
| string/indexOf | 1000 | 19.14 | 65.90 | 12.26 | 14.65 |
| string/includes | 1000 | 19.20 | 103.60 | 14.52 | 20.34 |
| string/split | 10000 | 42.94 | 837.60 | 274.57 | — |
| string/replace | 1000 | 107.13 | 682.07 | 327.18 | — |
| string/case-convert | 2000 | 27.99 | 279.71 | 135.41 | — |
| string/substring | 10000 | 9.90 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.06 | 377.55 | 265.37 | — |
| string/startsWith-endsWith | 20000 | 20.05 | 144.72 | 148.94 | 28.09 |
| array/map-filter | 30000 | 4.36 | 2.36 | 2.35 | — |
| array/indexOf | 1000 | 3953.71 | 2640.34 | 2640.51 | — |
| dom/create-elements | 2000 | 17.77 | 76.05 | — | — |
| dom/set-attributes | 6000 | 17.31 | 79.42 | — | — |
| dom/read-attributes | 3000 | 18.79 | 40.72 | — | — |
| dom/modify-text | 2000 | 14.72 | 54.19 | — | — |
| mixed/csv-parse | 11000 | 44.23 | 787.17 | 56.22 | — |
| mixed/text-search | 40000 | 9.73 | 125.60 | 75.00 | 26.99 |
| mixed/fibonacci | 10000 | 12.17 | 28.32 | 28.31 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.27 | 578.69 | 576.49 | 5.73 |
| mixed/sieve | 200000 | 7.62 | 10.59 | 10.68 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.54x slower | 1.36x slower | — |
| string/concat-long | 1.24x slower | 1.03x slower | — |
| string/indexOf | 3.44x slower | 1.56x faster | 1.31x faster |
| string/includes | 5.40x slower | 1.32x faster | 1.06x slower |
| string/split | 19.51x slower | 6.39x slower | — |
| string/replace | 6.37x slower | 3.05x slower | — |
| string/case-convert | 9.99x slower | 4.84x slower | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 22.13x slower | 15.55x slower | — |
| string/startsWith-endsWith | 7.22x slower | 7.43x slower | 1.40x slower |
| array/push-pop | 2.82x faster | 2.79x faster | — |
| array/sort-i32 | 1.98x faster | 2.69x faster | — |
| array/map-filter | 1.84x faster | 1.86x faster | — |
| array/reduce | 2.65x faster | 2.64x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.11x slower | 1.09x slower | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.77x faster | 1.78x faster | — |
| array/find | 16.16x faster | 16.23x faster | 4.22x slower |
| dom/create-elements | 4.28x slower | — | — |
| dom/set-attributes | 4.59x slower | — | — |
| dom/read-attributes | 2.17x slower | — | — |
| dom/modify-text | 3.68x slower | — | — |
| mixed/csv-parse | 17.80x slower | 1.27x slower | — |
| mixed/text-search | 12.90x slower | 7.71x slower | 2.77x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 456.33x slower | 454.59x slower | 4.52x slower |
| mixed/sieve | 1.39x slower | 1.40x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.13x faster |
| string/concat-long | 1.21x faster |
| string/indexOf | 5.37x faster |
| string/includes | 7.13x faster |
| string/split | 3.05x faster |
| string/replace | 2.08x faster |
| string/case-convert | 2.07x faster |
| string/substring | 1.22x faster |
| string/trim | 1.42x faster |
| string/startsWith-endsWith | 1.03x slower |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.36x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.01x faster |
| array/find | 1.00x faster |
| mixed/csv-parse | 14.00x faster |
| mixed/text-search | 1.67x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.01x slower |

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
| string/concat-short | 1721.6ms | 1070.2ms | — |
| string/concat-long | 776.3ms | 1019.6ms | — |
| string/indexOf | 675.4ms | 975.3ms | 863.1ms |
| string/includes | 691.0ms | 999.2ms | 845.9ms |
| string/split | 773.6ms | 1000.6ms | — |
| string/replace | 803.4ms | 1043.5ms | — |
| string/case-convert | 807.9ms | 899.1ms | — |
| string/substring | 669.1ms | 772.5ms | — |
| string/trim | 748.5ms | 968.5ms | — |
| string/startsWith-endsWith | 785.3ms | 993.1ms | 900.9ms |
| array/push-pop | 787.8ms | 872.9ms | — |
| array/sort-i32 | 937.1ms | 1012.7ms | — |
| array/map-filter | 949.9ms | 1047.8ms | — |
| array/reduce | 883.6ms | 872.2ms | — |
| array/indexOf | 889.9ms | 947.5ms | — |
| array/slice | 798.6ms | 876.1ms | — |
| array/reverse | 793.7ms | 855.7ms | — |
| array/forEach | 894.7ms | 1028.2ms | — |
| array/find | 778.8ms | 833.2ms | 813.0ms |
| dom/create-elements | 708.5ms | — | — |
| dom/set-attributes | 685.5ms | — | — |
| dom/read-attributes | 688.7ms | — | — |
| dom/modify-text | 664.8ms | — | — |
| mixed/csv-parse | 798.6ms | 963.0ms | — |
| mixed/text-search | 784.1ms | 953.5ms | 914.7ms |
| mixed/fibonacci | 768.4ms | 770.3ms | 777.1ms |
| mixed/matrix-multiply | 902.2ms | 977.4ms | 800.8ms |
| mixed/sieve | 884.2ms | 935.6ms | — |
