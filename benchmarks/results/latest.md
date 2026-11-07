# js2wasm Benchmark Results

Date: 2026-11-07
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.046ms | 0.042ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | host-call |
| string/indexOf | 0.020ms | 0.016ms | 0.016ms | 0.016ms | linear-memory |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.016ms | linear-memory |
| string/split | 0.424ms | 0.411ms | 0.412ms | FAILED | host-call |
| string/replace | 0.105ms | 0.054ms | 0.054ms | FAILED | host-call |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.163ms | 0.164ms | FAILED | host-call |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.220ms | 0.561ms | host-call |
| array/push-pop | 1.51ms | 0.540ms | 0.534ms | FAILED | gc-native |
| array/sort-i32 | 0.792ms | 0.394ms | 0.395ms | FAILED | host-call |
| array/map-filter | 0.127ms | 0.076ms | 0.081ms | FAILED | host-call |
| array/reduce | 2.23ms | 0.535ms | 0.539ms | FAILED | host-call |
| array/indexOf | 3.95ms | 5.23ms | 5.23ms | FAILED | js |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.049ms | 0.049ms | 0.049ms | FAILED | js |
| array/find | 0.254ms | 0.012ms | 0.012ms | 1.08ms | gc-native |
| dom/create-elements | 0.033ms | 0.926ms | — | — | js |
| dom/set-attributes | 0.105ms | 6.73ms | — | — | js |
| dom/read-attributes | 0.058ms | FAILED | — | — | js |
| dom/modify-text | 0.029ms | 1.68ms | — | — | js |
| mixed/csv-parse | 0.490ms | 0.319ms | 0.315ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 0.265ms | 0.263ms | 1.10ms | gc-native |
| mixed/fibonacci | 0.122ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.158ms | 0.214ms | 0.230ms | 0.725ms | js |
| mixed/sieve | 1.64ms | 2.15ms | 2.18ms | FAILED | js |

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
| string/concat-short | 10000 | 3.54 | 4.56 | 4.23 | — |
| string/concat-long | 1000 | 3.63 | 3.08 | 3.16 | — |
| string/indexOf | 1000 | 19.84 | 16.31 | 16.32 | 15.61 |
| string/includes | 1000 | 19.23 | 20.81 | 20.76 | 15.90 |
| string/split | 10000 | 42.39 | 41.09 | 41.21 | — |
| string/replace | 1000 | 104.69 | 54.24 | 54.47 | — |
| string/case-convert | 2000 | 28.05 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.89 | 3.07 | 3.07 | — |
| string/trim | 10000 | 16.97 | 16.26 | 16.39 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 11.00 | 11.01 | 28.03 |
| array/map-filter | 30000 | 4.25 | 2.52 | 2.71 | — |
| array/indexOf | 1000 | 3954.10 | 5229.64 | 5226.02 | — |
| dom/create-elements | 2000 | 16.75 | 463.08 | — | — |
| dom/set-attributes | 6000 | 17.43 | 1122.10 | — | — |
| dom/read-attributes | 3000 | 19.27 | — | — | — |
| dom/modify-text | 2000 | 14.47 | 837.94 | — | — |
| mixed/csv-parse | 11000 | 44.53 | 28.98 | 28.60 | — |
| mixed/text-search | 40000 | 9.75 | 6.62 | 6.56 | 27.49 |
| mixed/fibonacci | 10000 | 12.18 | 28.33 | 28.33 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.26 | 1.71 | 1.84 | 5.80 |
| mixed/sieve | 200000 | 8.20 | 10.75 | 10.90 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.29x slower | 1.19x slower | — |
| string/concat-long | 1.18x faster | 1.15x faster | — |
| string/indexOf | 1.22x faster | 1.22x faster | 1.27x faster |
| string/includes | 1.08x slower | 1.08x slower | 1.21x faster |
| string/split | 1.03x faster | 1.03x faster | — |
| string/replace | 1.93x faster | 1.92x faster | — |
| string/case-convert | 8.56x faster | 8.56x faster | — |
| string/substring | 3.22x faster | 3.22x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.79x faster | 2.82x faster | — |
| array/sort-i32 | 2.01x faster | 2.01x faster | — |
| array/map-filter | 1.68x faster | 1.57x faster | — |
| array/reduce | 4.17x faster | 4.14x faster | — |
| array/indexOf | 1.32x slower | 1.32x slower | — |
| array/slice | 1.07x slower | 1.07x slower | — |
| array/reverse | 2.23x faster | 2.22x faster | — |
| array/forEach | 1.00x slower | 1.01x slower | — |
| array/find | 21.55x faster | 21.82x faster | 4.27x slower |
| dom/create-elements | 27.65x slower | — | — |
| dom/set-attributes | 64.37x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 57.91x slower | — | — |
| mixed/csv-parse | 1.54x faster | 1.56x faster | — |
| mixed/text-search | 1.47x faster | 1.49x faster | 2.82x slower |
| mixed/fibonacci | 2.32x slower | 2.32x slower | 2.30x slower |
| mixed/matrix-multiply | 1.35x slower | 1.46x slower | 4.59x slower |
| mixed/sieve | 1.31x slower | 1.33x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.08x faster |
| string/concat-long | 1.03x slower |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x faster |
| string/split | 1.00x slower |
| string/replace | 1.00x slower |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x faster |
| string/trim | 1.01x slower |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.01x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.07x slower |
| array/reduce | 1.01x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x slower |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.01x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.08x slower |
| mixed/sieve | 1.01x slower |

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
| array/sort-i32 | 28.0KB | 28.0KB | — |
| array/map-filter | 29.1KB | 29.1KB | — |
| array/reduce | 27.6KB | 27.6KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.8KB | 27.8KB | — |
| array/find | 61.9KB | 61.9KB | 666B |
| dom/create-elements | 1.9KB | — | — |
| dom/set-attributes | 2.3KB | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 1.9KB | — | — |
| mixed/csv-parse | 27.8KB | 27.8KB | — |
| mixed/text-search | 27.7KB | 27.7KB | 1.9KB |
| mixed/fibonacci | 1.2KB | 1.2KB | 411B |
| mixed/matrix-multiply | 26.6KB | 26.6KB | 1019B |
| mixed/sieve | 26.5KB | 26.5KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1448.0ms | 607.0ms | — |
| string/concat-long | 1120.2ms | 1029.8ms | — |
| string/indexOf | 1028.9ms | 1002.7ms | 602.1ms |
| string/includes | 1014.4ms | 1031.2ms | 606.3ms |
| string/split | 1127.4ms | 1141.4ms | — |
| string/replace | 1144.5ms | 1148.0ms | — |
| string/case-convert | 1102.9ms | 1082.2ms | — |
| string/substring | 537.7ms | 525.1ms | — |
| string/trim | 1062.3ms | 1063.2ms | — |
| string/startsWith-endsWith | 1131.7ms | 1122.8ms | 655.8ms |
| array/push-pop | 1097.2ms | 1063.7ms | — |
| array/sort-i32 | 1191.8ms | 1159.6ms | — |
| array/map-filter | 1225.4ms | 1202.2ms | — |
| array/reduce | 1164.9ms | 1168.3ms | — |
| array/indexOf | 1111.4ms | 1088.4ms | — |
| array/slice | 1082.4ms | 1070.9ms | — |
| array/reverse | 1086.5ms | 1078.7ms | — |
| array/forEach | 1151.0ms | 1119.8ms | — |
| array/find | 3088.1ms | 3083.7ms | 579.0ms |
| dom/create-elements | 701.6ms | — | — |
| dom/set-attributes | 627.6ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 640.4ms | — | — |
| mixed/csv-parse | 1114.6ms | 1121.1ms | — |
| mixed/text-search | 1112.5ms | 1140.6ms | 669.1ms |
| mixed/fibonacci | 606.5ms | 556.6ms | 509.9ms |
| mixed/matrix-multiply | 1141.4ms | 1114.3ms | 546.6ms |
| mixed/sieve | 1115.3ms | 1116.3ms | — |
