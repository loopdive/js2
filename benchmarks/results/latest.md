# js2wasm Benchmark Results

Date: 2026-09-03
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.047ms | 0.055ms | 0.058ms | FAILED | js |
| string/concat-long | 0.005ms | 0.005ms | 0.006ms | FAILED | js |
| string/indexOf | 0.018ms | 0.057ms | 0.013ms | 0.028ms | gc-native |
| string/includes | 0.018ms | 0.101ms | 0.014ms | 0.015ms | gc-native |
| string/split | 0.398ms | 7.75ms | 2.67ms | FAILED | js |
| string/replace | 0.107ms | 0.560ms | 0.317ms | FAILED | js |
| string/case-convert | 0.057ms | 0.596ms | 0.253ms | FAILED | js |
| string/substring | 0.102ms | 0.042ms | 0.036ms | FAILED | gc-native |
| string/trim | 0.160ms | 3.64ms | 2.65ms | FAILED | js |
| string/startsWith-endsWith | 0.428ms | 2.90ms | 2.90ms | 0.580ms | js |
| array/push-pop | 1.40ms | 0.517ms | 0.508ms | FAILED | gc-native |
| array/sort-i32 | 0.718ms | 0.313ms | 0.311ms | FAILED | gc-native |
| array/map-filter | 0.152ms | 0.087ms | 0.087ms | FAILED | gc-native |
| array/reduce | 2.05ms | 0.510ms | 0.518ms | FAILED | host-call |
| array/indexOf | 4.83ms | 2.75ms | 2.76ms | FAILED | host-call |
| array/slice | 0.046ms | 0.037ms | 0.038ms | FAILED | host-call |
| array/reverse | 7.27ms | 3.67ms | 3.66ms | FAILED | gc-native |
| array/forEach | 0.080ms | 0.029ms | 0.029ms | FAILED | gc-native |
| array/find | 0.269ms | 0.018ms | 0.018ms | 0.986ms | host-call |
| dom/create-elements | 0.062ms | 0.182ms | — | — | js |
| dom/set-attributes | 0.128ms | 0.554ms | — | — | js |
| dom/read-attributes | 0.073ms | 0.136ms | — | — | js |
| dom/modify-text | 0.056ms | 0.123ms | — | — | js |
| mixed/csv-parse | 0.449ms | 8.06ms | 1.29ms | FAILED | js |
| mixed/text-search | 0.393ms | 4.30ms | 2.78ms | 1.22ms | js |
| mixed/fibonacci | 0.134ms | 0.354ms | 0.353ms | 0.355ms | js |
| mixed/matrix-multiply | 0.208ms | 67.70ms | 68.75ms | 0.829ms | js |
| mixed/sieve | 1.54ms | 2.38ms | 2.24ms | FAILED | js |

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
| string/concat-short | 10000 | 4.66 | 5.49 | 5.78 | — |
| string/concat-long | 1000 | 4.73 | 5.29 | 5.90 | — |
| string/indexOf | 1000 | 18.19 | 57.03 | 12.67 | 28.39 |
| string/includes | 1000 | 18.21 | 100.97 | 13.95 | 15.17 |
| string/split | 10000 | 39.83 | 774.92 | 267.26 | — |
| string/replace | 1000 | 107.03 | 559.86 | 316.66 | — |
| string/case-convert | 2000 | 28.69 | 297.96 | 126.44 | — |
| string/substring | 10000 | 10.22 | 4.19 | 3.59 | — |
| string/trim | 10000 | 16.05 | 364.43 | 264.60 | — |
| string/startsWith-endsWith | 20000 | 21.40 | 144.89 | 144.85 | 29.02 |
| array/map-filter | 30000 | 5.07 | 2.91 | 2.89 | — |
| array/indexOf | 1000 | 4831.15 | 2754.31 | 2757.16 | — |
| dom/create-elements | 2000 | 31.19 | 91.11 | — | — |
| dom/set-attributes | 6000 | 21.29 | 92.33 | — | — |
| dom/read-attributes | 3000 | 24.23 | 45.19 | — | — |
| dom/modify-text | 2000 | 27.79 | 61.38 | — | — |
| mixed/csv-parse | 11000 | 40.82 | 732.46 | 117.65 | — |
| mixed/text-search | 40000 | 9.83 | 107.40 | 69.45 | 30.50 |
| mixed/fibonacci | 10000 | 13.38 | 35.38 | 35.29 | 35.47 |
| mixed/matrix-multiply | 125000 | 1.66 | 541.58 | 549.96 | 6.63 |
| mixed/sieve | 200000 | 7.69 | 11.89 | 11.19 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.18x slower | 1.24x slower | — |
| string/concat-long | 1.12x slower | 1.25x slower | — |
| string/indexOf | 3.13x slower | 1.44x faster | 1.56x slower |
| string/includes | 5.54x slower | 1.31x faster | 1.20x faster |
| string/split | 19.46x slower | 6.71x slower | — |
| string/replace | 5.23x slower | 2.96x slower | — |
| string/case-convert | 10.39x slower | 4.41x slower | — |
| string/substring | 2.44x faster | 2.85x faster | — |
| string/trim | 22.71x slower | 16.49x slower | — |
| string/startsWith-endsWith | 6.77x slower | 6.77x slower | 1.36x slower |
| array/push-pop | 2.71x faster | 2.76x faster | — |
| array/sort-i32 | 2.29x faster | 2.31x faster | — |
| array/map-filter | 1.74x faster | 1.76x faster | — |
| array/reduce | 4.02x faster | 3.96x faster | — |
| array/indexOf | 1.75x faster | 1.75x faster | — |
| array/slice | 1.22x faster | 1.20x faster | — |
| array/reverse | 1.98x faster | 1.99x faster | — |
| array/forEach | 2.74x faster | 2.80x faster | — |
| array/find | 15.13x faster | 15.10x faster | 3.67x slower |
| dom/create-elements | 2.92x slower | — | — |
| dom/set-attributes | 4.34x slower | — | — |
| dom/read-attributes | 1.87x slower | — | — |
| dom/modify-text | 2.21x slower | — | — |
| mixed/csv-parse | 17.94x slower | 2.88x slower | — |
| mixed/text-search | 10.93x slower | 7.07x slower | 3.10x slower |
| mixed/fibonacci | 2.65x slower | 2.64x slower | 2.65x slower |
| mixed/matrix-multiply | 325.99x slower | 331.03x slower | 3.99x slower |
| mixed/sieve | 1.55x slower | 1.46x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.05x slower |
| string/concat-long | 1.12x slower |
| string/indexOf | 4.50x faster |
| string/includes | 7.24x faster |
| string/split | 2.90x faster |
| string/replace | 1.77x faster |
| string/case-convert | 2.36x faster |
| string/substring | 1.17x faster |
| string/trim | 1.38x faster |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.02x faster |
| array/sort-i32 | 1.01x faster |
| array/map-filter | 1.01x faster |
| array/reduce | 1.02x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.02x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.02x faster |
| array/find | 1.00x slower |
| mixed/csv-parse | 6.23x faster |
| mixed/text-search | 1.55x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.02x slower |
| mixed/sieve | 1.06x faster |

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
| string/concat-short | 1711.0ms | 1141.8ms | — |
| string/concat-long | 783.3ms | 1012.1ms | — |
| string/indexOf | 696.2ms | 1005.3ms | 849.2ms |
| string/includes | 681.7ms | 987.5ms | 852.7ms |
| string/split | 777.0ms | 1006.2ms | — |
| string/replace | 779.6ms | 1047.6ms | — |
| string/case-convert | 820.6ms | 941.1ms | — |
| string/substring | 687.2ms | 777.9ms | — |
| string/trim | 753.4ms | 976.6ms | — |
| string/startsWith-endsWith | 778.8ms | 1029.9ms | 935.3ms |
| array/push-pop | 795.2ms | 894.8ms | — |
| array/sort-i32 | 978.7ms | 1032.3ms | — |
| array/map-filter | 987.1ms | 1055.8ms | — |
| array/reduce | 905.9ms | 981.8ms | — |
| array/indexOf | 896.9ms | 998.0ms | — |
| array/slice | 802.9ms | 923.3ms | — |
| array/reverse | 812.1ms | 923.0ms | — |
| array/forEach | 941.5ms | 1041.9ms | — |
| array/find | 810.0ms | 918.4ms | 851.7ms |
| dom/create-elements | 723.0ms | — | — |
| dom/set-attributes | 758.4ms | — | — |
| dom/read-attributes | 700.6ms | — | — |
| dom/modify-text | 682.3ms | — | — |
| mixed/csv-parse | 822.2ms | 1023.4ms | — |
| mixed/text-search | 830.7ms | 1033.2ms | 933.5ms |
| mixed/fibonacci | 773.6ms | 853.4ms | 772.5ms |
| mixed/matrix-multiply | 1012.5ms | 1016.1ms | 855.3ms |
| mixed/sieve | 892.1ms | 966.9ms | — |
