# js2wasm Benchmark Results

Date: 2026-10-20
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.021ms | 0.042ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.015ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.016ms | linear-memory |
| string/split | 0.424ms | 0.413ms | 0.412ms | FAILED | gc-native |
| string/replace | 0.102ms | 0.055ms | 0.055ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.162ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.220ms | 0.560ms | gc-native |
| array/push-pop | 1.38ms | 0.506ms | 0.498ms | FAILED | gc-native |
| array/sort-i32 | 0.791ms | 0.396ms | 0.396ms | FAILED | gc-native |
| array/map-filter | 0.128ms | 0.075ms | 0.081ms | FAILED | host-call |
| array/reduce | 1.34ms | 0.501ms | 0.504ms | FAILED | host-call |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | host-call |
| array/slice | 0.026ms | 0.027ms | 0.027ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.048ms | 0.049ms | 0.049ms | FAILED | js |
| array/find | 0.253ms | 0.012ms | 0.012ms | 1.12ms | host-call |
| dom/create-elements | 0.041ms | 0.958ms | — | — | js |
| dom/set-attributes | 0.102ms | 6.86ms | — | — | js |
| dom/read-attributes | 0.057ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | 1.68ms | — | — | js |
| mixed/csv-parse | 0.477ms | 0.318ms | 0.317ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 0.263ms | 0.263ms | 1.09ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.157ms | 0.213ms | 0.213ms | 0.718ms | js |
| mixed/sieve | 1.55ms | 2.09ms | 2.13ms | FAILED | js |

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
| dom/read-attributes | host-call | warmup | dereferencing a null pointer |
| mixed/csv-parse | linear-memory | mid-loop | memory access out of bounds |
| mixed/sieve | linear-memory | mid-loop | memory access out of bounds |

## Cost per operation (ns)

| Benchmark | ops/call | JS | Host-call | GC-native | Linear |
|-----------|----------|-----|-----------|-----------|--------|
| string/concat-short | 10000 | 2.14 | 4.25 | 4.43 | — |
| string/concat-long | 1000 | 3.65 | 3.15 | 3.02 | — |
| string/indexOf | 1000 | 19.16 | 16.42 | 16.44 | 14.58 |
| string/includes | 1000 | 19.25 | 21.01 | 21.00 | 15.91 |
| string/split | 10000 | 42.44 | 41.32 | 41.15 | — |
| string/replace | 1000 | 101.71 | 55.19 | 55.25 | — |
| string/case-convert | 2000 | 27.82 | 3.27 | 3.27 | — |
| string/substring | 10000 | 9.85 | 3.07 | 3.07 | — |
| string/trim | 10000 | 16.97 | 16.24 | 16.26 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 11.02 | 11.01 | 27.98 |
| array/map-filter | 30000 | 4.27 | 2.49 | 2.70 | — |
| array/indexOf | 1000 | 3951.15 | 2637.90 | 2638.92 | — |
| dom/create-elements | 2000 | 20.44 | 479.08 | — | — |
| dom/set-attributes | 6000 | 17.02 | 1143.85 | — | — |
| dom/read-attributes | 3000 | 18.84 | — | — | — |
| dom/modify-text | 2000 | 14.54 | 841.69 | — | — |
| mixed/csv-parse | 11000 | 43.35 | 28.91 | 28.83 | — |
| mixed/text-search | 40000 | 9.75 | 6.58 | 6.57 | 27.34 |
| mixed/fibonacci | 10000 | 12.02 | 28.30 | 28.30 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.25 | 1.70 | 1.70 | 5.75 |
| mixed/sieve | 200000 | 7.73 | 10.46 | 10.63 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.99x slower | 2.07x slower | — |
| string/concat-long | 1.16x faster | 1.21x faster | — |
| string/indexOf | 1.17x faster | 1.17x faster | 1.31x faster |
| string/includes | 1.09x slower | 1.09x slower | 1.21x faster |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 1.84x faster | 1.84x faster | — |
| string/case-convert | 8.50x faster | 8.50x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.74x faster | 2.78x faster | — |
| array/sort-i32 | 2.00x faster | 2.00x faster | — |
| array/map-filter | 1.71x faster | 1.58x faster | — |
| array/reduce | 2.67x faster | 2.65x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.03x slower | 1.02x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.01x slower | 1.01x slower | — |
| array/find | 21.70x faster | 21.37x faster | 4.44x slower |
| dom/create-elements | 23.43x slower | — | — |
| dom/set-attributes | 67.21x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 57.88x slower | — | — |
| mixed/csv-parse | 1.50x faster | 1.50x faster | — |
| mixed/text-search | 1.48x faster | 1.48x faster | 2.80x slower |
| mixed/fibonacci | 2.35x slower | 2.35x slower | 2.34x slower |
| mixed/matrix-multiply | 1.36x slower | 1.36x slower | 4.59x slower |
| mixed/sieve | 1.35x slower | 1.37x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.04x slower |
| string/concat-long | 1.04x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x faster |
| string/split | 1.00x faster |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x faster |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x faster |
| array/map-filter | 1.09x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.01x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.02x slower |
| mixed/csv-parse | 1.00x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.00x slower |
| mixed/sieve | 1.02x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.5KB | 1.5KB | — |
| string/concat-long | 18.8KB | 18.8KB | — |
| string/indexOf | 18.9KB | 18.9KB | 10.4KB |
| string/includes | 19.0KB | 19.0KB | 10.4KB |
| string/split | 26.7KB | 26.7KB | — |
| string/replace | 27.5KB | 27.5KB | — |
| string/case-convert | 26.3KB | 26.3KB | — |
| string/substring | 1.0KB | 1.0KB | — |
| string/trim | 26.3KB | 26.3KB | — |
| string/startsWith-endsWith | 27.3KB | 27.3KB | 1.7KB |
| array/push-pop | 25.3KB | 25.3KB | — |
| array/sort-i32 | 27.8KB | 27.8KB | — |
| array/map-filter | 28.9KB | 29.0KB | — |
| array/reduce | 27.4KB | 27.4KB | — |
| array/indexOf | 26.4KB | 26.4KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.6KB | 27.6KB | — |
| array/find | 61.8KB | 61.8KB | 634B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 991B |
| mixed/sieve | 26.5KB | 26.5KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1398.7ms | 558.9ms | — |
| string/concat-long | 1056.9ms | 983.1ms | — |
| string/indexOf | 948.0ms | 977.9ms | 563.7ms |
| string/includes | 955.2ms | 988.2ms | 568.9ms |
| string/split | 1064.3ms | 1079.0ms | — |
| string/replace | 1203.5ms | 1142.8ms | — |
| string/case-convert | 1026.8ms | 1020.5ms | — |
| string/substring | 498.2ms | 490.6ms | — |
| string/trim | 1018.2ms | 1049.6ms | — |
| string/startsWith-endsWith | 1042.3ms | 1042.7ms | 622.8ms |
| array/push-pop | 996.3ms | 1007.4ms | — |
| array/sort-i32 | 1085.0ms | 1099.0ms | — |
| array/map-filter | 1177.9ms | 1147.0ms | — |
| array/reduce | 1099.8ms | 1064.7ms | — |
| array/indexOf | 1072.6ms | 1049.9ms | — |
| array/slice | 1017.2ms | 1014.4ms | — |
| array/reverse | 1042.6ms | 1004.4ms | — |
| array/forEach | 1076.4ms | 1069.6ms | — |
| array/find | 2402.2ms | 2325.2ms | 554.8ms |
| dom/create-elements | 659.9ms | — | — |
| dom/set-attributes | 587.5ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 596.1ms | — | — |
| mixed/csv-parse | 1044.4ms | 1054.8ms | — |
| mixed/text-search | 1045.8ms | 1112.9ms | 623.4ms |
| mixed/fibonacci | 537.9ms | 519.4ms | 467.7ms |
| mixed/matrix-multiply | 1056.2ms | 1048.6ms | 514.2ms |
| mixed/sieve | 1063.1ms | 1060.0ms | — |
