# js2wasm Benchmark Results

Date: 2026-11-08
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.035ms | 0.044ms | 0.044ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.016ms | 0.016ms | 0.024ms | gc-native |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.413ms | 0.412ms | 0.412ms | FAILED | gc-native |
| string/replace | 0.101ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.059ms | 0.007ms | 0.007ms | FAILED | host-call |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | host-call |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | host-call |
| string/startsWith-endsWith | 0.401ms | 0.220ms | 0.220ms | 0.561ms | gc-native |
| array/push-pop | 1.51ms | 0.553ms | 0.551ms | FAILED | gc-native |
| array/sort-i32 | 0.797ms | 0.393ms | 0.395ms | FAILED | host-call |
| array/map-filter | 0.072ms | 0.074ms | 0.081ms | FAILED | js |
| array/reduce | 2.27ms | 0.545ms | 0.545ms | FAILED | host-call |
| array/indexOf | 3.96ms | 5.24ms | 5.24ms | FAILED | js |
| array/slice | 0.027ms | 0.028ms | 0.031ms | FAILED | js |
| array/reverse | 7.84ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.049ms | 0.049ms | FAILED | host-call |
| array/find | 0.255ms | 0.012ms | 0.012ms | 1.09ms | gc-native |
| dom/create-elements | 0.036ms | 0.948ms | — | — | js |
| dom/set-attributes | 0.105ms | 7.50ms | — | — | js |
| dom/read-attributes | 0.055ms | FAILED | — | — | js |
| dom/modify-text | 0.031ms | 1.69ms | — | — | js |
| mixed/csv-parse | 0.481ms | 0.315ms | 0.317ms | FAILED | host-call |
| mixed/text-search | 0.392ms | 0.263ms | 0.263ms | 1.08ms | host-call |
| mixed/fibonacci | 0.122ms | 0.284ms | 0.284ms | 0.281ms | js |
| mixed/matrix-multiply | 0.160ms | 0.215ms | 0.214ms | 0.735ms | js |
| mixed/sieve | 1.79ms | 2.18ms | 2.24ms | FAILED | js |

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
| string/concat-short | 10000 | 3.52 | 4.43 | 4.38 | — |
| string/concat-long | 1000 | 3.62 | 3.15 | 3.10 | — |
| string/indexOf | 1000 | 19.20 | 16.36 | 16.03 | 23.65 |
| string/includes | 1000 | 19.24 | 20.81 | 20.92 | 15.38 |
| string/split | 10000 | 41.27 | 41.23 | 41.18 | — |
| string/replace | 1000 | 101.42 | 54.20 | 54.06 | — |
| string/case-convert | 2000 | 29.60 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.88 | 3.07 | 3.08 | — |
| string/trim | 10000 | 17.03 | 16.30 | 16.30 | — |
| string/startsWith-endsWith | 20000 | 20.03 | 11.01 | 11.00 | 28.05 |
| array/map-filter | 30000 | 2.40 | 2.48 | 2.70 | — |
| array/indexOf | 1000 | 3957.73 | 5237.30 | 5239.44 | — |
| dom/create-elements | 2000 | 17.78 | 473.86 | — | — |
| dom/set-attributes | 6000 | 17.52 | 1249.62 | — | — |
| dom/read-attributes | 3000 | 18.46 | — | — | — |
| dom/modify-text | 2000 | 15.42 | 843.46 | — | — |
| mixed/csv-parse | 11000 | 43.71 | 28.68 | 28.86 | — |
| mixed/text-search | 40000 | 9.79 | 6.58 | 6.59 | 27.02 |
| mixed/fibonacci | 10000 | 12.18 | 28.36 | 28.37 | 28.08 |
| mixed/matrix-multiply | 125000 | 1.28 | 1.72 | 1.72 | 5.88 |
| mixed/sieve | 200000 | 8.97 | 10.92 | 11.18 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.26x slower | 1.24x slower | — |
| string/concat-long | 1.15x faster | 1.17x faster | — |
| string/indexOf | 1.17x faster | 1.20x faster | 1.23x slower |
| string/includes | 1.08x slower | 1.09x slower | 1.25x faster |
| string/split | 1.00x faster | 1.00x faster | — |
| string/replace | 1.87x faster | 1.88x faster | — |
| string/case-convert | 9.03x faster | 9.03x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.04x faster | 1.04x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.82x faster | 1.40x slower |
| array/push-pop | 2.74x faster | 2.75x faster | — |
| array/sort-i32 | 2.03x faster | 2.02x faster | — |
| array/map-filter | 1.03x slower | 1.12x slower | — |
| array/reduce | 4.17x faster | 4.17x faster | — |
| array/indexOf | 1.32x slower | 1.32x slower | — |
| array/slice | 1.05x slower | 1.17x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.02x faster | 1.01x faster | — |
| array/find | 20.84x faster | 21.92x faster | 4.26x slower |
| dom/create-elements | 26.65x slower | — | — |
| dom/set-attributes | 71.33x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 54.71x slower | — | — |
| mixed/csv-parse | 1.52x faster | 1.51x faster | — |
| mixed/text-search | 1.49x faster | 1.49x faster | 2.76x slower |
| mixed/fibonacci | 2.33x slower | 2.33x slower | 2.31x slower |
| mixed/matrix-multiply | 1.34x slower | 1.34x slower | 4.58x slower |
| mixed/sieve | 1.22x slower | 1.25x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.01x faster |
| string/concat-long | 1.01x faster |
| string/indexOf | 1.02x faster |
| string/includes | 1.01x slower |
| string/split | 1.00x faster |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x slower |
| string/substring | 1.00x slower |
| string/trim | 1.00x slower |
| string/startsWith-endsWith | 1.00x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.00x slower |
| array/map-filter | 1.09x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.11x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.05x faster |
| mixed/csv-parse | 1.01x slower |
| mixed/text-search | 1.00x slower |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
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
| array/sort-i32 | 28.1KB | 28.1KB | — |
| array/map-filter | 29.2KB | 29.3KB | — |
| array/reduce | 27.7KB | 27.7KB | — |
| array/indexOf | 25.5KB | 25.5KB | — |
| array/slice | 25.4KB | 25.4KB | — |
| array/reverse | 25.4KB | 25.4KB | — |
| array/forEach | 27.9KB | 27.9KB | — |
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
| string/concat-short | 1441.2ms | 596.2ms | — |
| string/concat-long | 1106.7ms | 995.9ms | — |
| string/indexOf | 1055.7ms | 1004.4ms | 593.5ms |
| string/includes | 1036.7ms | 1074.5ms | 600.4ms |
| string/split | 1120.3ms | 1097.9ms | — |
| string/replace | 1182.4ms | 1171.7ms | — |
| string/case-convert | 1106.0ms | 1095.6ms | — |
| string/substring | 571.0ms | 553.3ms | — |
| string/trim | 1121.4ms | 1098.9ms | — |
| string/startsWith-endsWith | 1096.9ms | 1102.8ms | 648.3ms |
| array/push-pop | 1103.5ms | 1079.9ms | — |
| array/sort-i32 | 1903.1ms | 1882.7ms | — |
| array/map-filter | 1946.6ms | 1924.4ms | — |
| array/reduce | 1907.8ms | 1874.6ms | — |
| array/indexOf | 1126.3ms | 1083.9ms | — |
| array/slice | 1068.7ms | 1077.3ms | — |
| array/reverse | 1130.7ms | 1110.6ms | — |
| array/forEach | 1852.9ms | 1871.8ms | — |
| array/find | 3112.4ms | 3053.6ms | 576.2ms |
| dom/create-elements | 695.2ms | — | — |
| dom/set-attributes | 643.4ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 645.0ms | — | — |
| mixed/csv-parse | 1101.3ms | 1117.5ms | — |
| mixed/text-search | 1186.2ms | 1223.3ms | 705.3ms |
| mixed/fibonacci | 652.0ms | 621.0ms | 550.0ms |
| mixed/matrix-multiply | 1197.0ms | 1162.6ms | 604.4ms |
| mixed/sieve | 1206.8ms | 1205.3ms | — |
