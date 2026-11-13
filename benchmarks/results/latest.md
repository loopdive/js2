# js2wasm Benchmark Results

Date: 2026-11-13
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.033ms | 0.045ms | 0.045ms | FAILED | js |
| string/concat-long | 0.004ms | 0.003ms | 0.003ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.017ms | 0.017ms | 0.019ms | host-call |
| string/includes | 0.019ms | 0.021ms | 0.021ms | 0.015ms | linear-memory |
| string/split | 0.416ms | 0.410ms | 0.413ms | FAILED | host-call |
| string/replace | 0.109ms | 0.054ms | 0.054ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.007ms | 0.007ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.031ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.170ms | 0.163ms | 0.163ms | FAILED | gc-native |
| string/startsWith-endsWith | 0.400ms | 0.220ms | 0.220ms | 0.559ms | host-call |
| array/push-pop | 1.48ms | 0.525ms | 0.534ms | FAILED | host-call |
| array/sort-i32 | 0.792ms | 0.394ms | 0.398ms | FAILED | host-call |
| array/map-filter | 0.131ms | 0.076ms | 0.082ms | FAILED | host-call |
| array/reduce | 1.42ms | 0.536ms | 0.537ms | FAILED | host-call |
| array/indexOf | 3.96ms | 5.24ms | 5.23ms | FAILED | js |
| array/slice | 0.026ms | 0.028ms | 0.028ms | FAILED | js |
| array/reverse | 7.84ms | 3.53ms | 3.52ms | FAILED | gc-native |
| array/forEach | 0.050ms | 0.050ms | 0.050ms | FAILED | js |
| array/find | 0.255ms | 0.012ms | 0.012ms | 1.08ms | gc-native |
| dom/create-elements | 0.036ms | 1.17ms | — | — | js |
| dom/set-attributes | 0.107ms | 8.89ms | — | — | js |
| dom/read-attributes | 0.056ms | FAILED | — | — | js |
| dom/modify-text | 0.031ms | 2.09ms | — | — | js |
| mixed/csv-parse | 0.474ms | 0.319ms | 0.317ms | FAILED | gc-native |
| mixed/text-search | 0.389ms | 0.263ms | 0.263ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.283ms | 0.283ms | 0.281ms | js |
| mixed/matrix-multiply | 0.160ms | 0.230ms | 0.214ms | 0.723ms | js |
| mixed/sieve | 1.70ms | 2.31ms | 2.31ms | FAILED | js |

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
| string/concat-short | 10000 | 3.32 | 4.55 | 4.54 | — |
| string/concat-long | 1000 | 3.61 | 3.32 | 3.22 | — |
| string/indexOf | 1000 | 19.23 | 16.54 | 16.57 | 18.89 |
| string/includes | 1000 | 19.26 | 21.12 | 21.05 | 15.39 |
| string/split | 10000 | 41.61 | 40.99 | 41.30 | — |
| string/replace | 1000 | 109.10 | 54.19 | 54.08 | — |
| string/case-convert | 2000 | 27.88 | 3.28 | 3.28 | — |
| string/substring | 10000 | 9.86 | 3.08 | 3.07 | — |
| string/trim | 10000 | 17.03 | 16.29 | 16.26 | — |
| string/startsWith-endsWith | 20000 | 19.98 | 11.01 | 11.02 | 27.95 |
| array/map-filter | 30000 | 4.36 | 2.54 | 2.74 | — |
| array/indexOf | 1000 | 3955.00 | 5237.41 | 5234.47 | — |
| dom/create-elements | 2000 | 18.20 | 586.43 | — | — |
| dom/set-attributes | 6000 | 17.77 | 1481.77 | — | — |
| dom/read-attributes | 3000 | 18.76 | — | — | — |
| dom/modify-text | 2000 | 15.35 | 1042.79 | — | — |
| mixed/csv-parse | 11000 | 43.07 | 28.97 | 28.79 | — |
| mixed/text-search | 40000 | 9.73 | 6.57 | 6.57 | 27.05 |
| mixed/fibonacci | 10000 | 12.03 | 28.34 | 28.34 | 28.07 |
| mixed/matrix-multiply | 125000 | 1.28 | 1.84 | 1.71 | 5.78 |
| mixed/sieve | 200000 | 8.50 | 11.55 | 11.55 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.37x slower | 1.37x slower | — |
| string/concat-long | 1.09x faster | 1.12x faster | — |
| string/indexOf | 1.16x faster | 1.16x faster | 1.02x faster |
| string/includes | 1.10x slower | 1.09x slower | 1.25x faster |
| string/split | 1.02x faster | 1.01x faster | — |
| string/replace | 2.01x faster | 2.02x faster | — |
| string/case-convert | 8.50x faster | 8.51x faster | — |
| string/substring | 3.21x faster | 3.21x faster | — |
| string/trim | 1.04x faster | 1.05x faster | — |
| string/startsWith-endsWith | 1.82x faster | 1.81x faster | 1.40x slower |
| array/push-pop | 2.82x faster | 2.77x faster | — |
| array/sort-i32 | 2.01x faster | 1.99x faster | — |
| array/map-filter | 1.72x faster | 1.59x faster | — |
| array/reduce | 2.66x faster | 2.65x faster | — |
| array/indexOf | 1.32x slower | 1.32x slower | — |
| array/slice | 1.07x slower | 1.07x slower | — |
| array/reverse | 2.22x faster | 2.23x faster | — |
| array/forEach | 1.00x slower | 1.01x slower | — |
| array/find | 20.79x faster | 20.96x faster | 4.25x slower |
| dom/create-elements | 32.22x slower | — | — |
| dom/set-attributes | 83.36x slower | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 67.93x slower | — | — |
| mixed/csv-parse | 1.49x faster | 1.50x faster | — |
| mixed/text-search | 1.48x faster | 1.48x faster | 2.78x slower |
| mixed/fibonacci | 2.36x slower | 2.36x slower | 2.33x slower |
| mixed/matrix-multiply | 1.43x slower | 1.33x slower | 4.50x slower |
| mixed/sieve | 1.36x slower | 1.36x slower | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.00x faster |
| string/concat-long | 1.03x faster |
| string/indexOf | 1.00x slower |
| string/includes | 1.00x faster |
| string/split | 1.01x slower |
| string/replace | 1.00x faster |
| string/case-convert | 1.00x faster |
| string/substring | 1.00x faster |
| string/trim | 1.00x faster |
| string/startsWith-endsWith | 1.00x slower |
| array/push-pop | 1.02x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.08x slower |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x faster |
| array/forEach | 1.01x slower |
| array/find | 1.01x faster |
| mixed/csv-parse | 1.01x faster |
| mixed/text-search | 1.00x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.07x faster |
| mixed/sieve | 1.00x slower |

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
| mixed/sieve | 26.6KB | 26.6KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1470.1ms | 606.2ms | — |
| string/concat-long | 1108.4ms | 1007.4ms | — |
| string/indexOf | 1014.7ms | 988.9ms | 586.8ms |
| string/includes | 1027.5ms | 1026.9ms | 605.1ms |
| string/split | 1107.9ms | 1092.8ms | — |
| string/replace | 1199.7ms | 1165.2ms | — |
| string/case-convert | 1086.8ms | 1112.3ms | — |
| string/substring | 550.7ms | 546.0ms | — |
| string/trim | 1081.4ms | 1091.3ms | — |
| string/startsWith-endsWith | 1120.5ms | 1113.9ms | 674.1ms |
| array/push-pop | 1067.9ms | 1081.6ms | — |
| array/sort-i32 | 1940.0ms | 1885.6ms | — |
| array/map-filter | 1978.2ms | 1980.9ms | — |
| array/reduce | 1933.2ms | 1890.7ms | — |
| array/indexOf | 1120.9ms | 1137.3ms | — |
| array/slice | 1110.8ms | 1074.6ms | — |
| array/reverse | 1089.7ms | 1087.5ms | — |
| array/forEach | 1896.2ms | 1898.7ms | — |
| array/find | 3166.6ms | 3067.5ms | 589.9ms |
| dom/create-elements | 709.8ms | — | — |
| dom/set-attributes | 666.1ms | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | 654.1ms | — | — |
| mixed/csv-parse | 1110.9ms | 1103.0ms | — |
| mixed/text-search | 1106.6ms | 1148.7ms | 655.4ms |
| mixed/fibonacci | 586.0ms | 588.9ms | 515.8ms |
| mixed/matrix-multiply | 1135.7ms | 1135.1ms | 578.8ms |
| mixed/sieve | 1128.6ms | 1162.9ms | — |
