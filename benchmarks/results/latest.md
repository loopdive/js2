# js2wasm Benchmark Results

Date: 2026-08-11
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.039ms | 0.074ms | 0.045ms | FAILED | js |
| string/concat-long | 0.005ms | 0.006ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.022ms | 0.071ms | 0.014ms | 0.072ms | gc-native |
| string/includes | 0.022ms | 0.050ms | 0.016ms | 0.030ms | gc-native |
| string/split | 0.490ms | 5.52ms | 0.590ms | FAILED | js |
| string/replace | 0.113ms | 0.258ms | 0.080ms | FAILED | gc-native |
| string/case-convert | 0.068ms | 0.264ms | 0.006ms | FAILED | gc-native |
| string/substring | 0.121ms | 0.047ms | 0.040ms | FAILED | gc-native |
| string/trim | 0.204ms | 1.07ms | 0.229ms | FAILED | js |
| string/startsWith-endsWith | 0.483ms | 0.391ms | 0.358ms | 0.654ms | gc-native |
| array/push-pop | 1.86ms | 0.693ms | 0.692ms | FAILED | gc-native |
| array/sort-i32 | 0.978ms | 0.660ms | 0.354ms | FAILED | gc-native |
| array/map-filter | 0.156ms | 0.075ms | 0.075ms | FAILED | gc-native |
| array/reduce | 1.84ms | 0.689ms | 0.691ms | FAILED | host-call |
| array/indexOf | 5.20ms | 3.34ms | 3.34ms | FAILED | host-call |
| array/slice | 0.036ms | 0.018ms | 0.019ms | FAILED | host-call |
| array/reverse | 10.31ms | 4.64ms | 4.64ms | FAILED | gc-native |
| array/forEach | 0.059ms | 0.033ms | 0.033ms | FAILED | host-call |
| array/find | 0.314ms | 0.017ms | 0.017ms | 1.30ms | gc-native |
| dom/create-elements | 0.063ms | 0.208ms | — | — | js |
| dom/set-attributes | 0.128ms | 0.232ms | — | — | js |
| dom/read-attributes | 0.071ms | 0.153ms | — | — | js |
| dom/modify-text | 0.038ms | 0.134ms | — | — | js |
| mixed/csv-parse | 0.543ms | 7.84ms | 0.360ms | FAILED | gc-native |
| mixed/text-search | 0.470ms | 1.52ms | 0.342ms | 1.29ms | gc-native |
| mixed/fibonacci | 0.146ms | 0.318ms | 0.318ms | 0.329ms | js |
| mixed/matrix-multiply | 0.213ms | 0.244ms | 0.243ms | 0.835ms | js |
| mixed/sieve | 2.06ms | 1.68ms | 1.72ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.85 | 7.36 | 4.51 | — |
| string/concat-long | 1000 | 5.03 | 6.19 | 3.79 | — |
| string/indexOf | 1000 | 22.03 | 70.89 | 14.45 | 71.64 |
| string/includes | 1000 | 21.74 | 49.96 | 16.42 | 29.57 |
| string/split | 10000 | 49.04 | 552.29 | 59.01 | — |
| string/replace | 1000 | 112.66 | 257.63 | 80.50 | — |
| string/case-convert | 2000 | 33.84 | 132.10 | 3.05 | — |
| string/substring | 10000 | 12.15 | 4.67 | 4.01 | — |
| string/trim | 10000 | 20.37 | 107.43 | 22.93 | — |
| string/startsWith-endsWith | 20000 | 24.14 | 19.55 | 17.89 | 32.71 |
| array/map-filter | 30000 | 5.22 | 2.51 | 2.50 | — |
| array/indexOf | 1000 | 5197.72 | 3339.17 | 3339.84 | — |
| dom/create-elements | 2000 | 31.54 | 103.88 | — | — |
| dom/set-attributes | 6000 | 21.27 | 38.67 | — | — |
| dom/read-attributes | 3000 | 23.60 | 50.91 | — | — |
| dom/modify-text | 2000 | 18.88 | 66.95 | — | — |
| mixed/csv-parse | 11000 | 49.32 | 712.28 | 32.72 | — |
| mixed/text-search | 40000 | 11.74 | 37.91 | 8.55 | 32.31 |
| mixed/fibonacci | 10000 | 14.62 | 31.84 | 31.85 | 32.90 |
| mixed/matrix-multiply | 125000 | 1.70 | 1.95 | 1.95 | 6.68 |
| mixed/sieve | 200000 | 10.29 | 8.40 | 8.59 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.91x slower | 1.17x slower | — |
| string/concat-long | 1.23x slower | 1.33x faster | — |
| string/indexOf | 3.22x slower | 1.52x faster | 3.25x slower |
| string/includes | 2.30x slower | 1.32x faster | 1.36x slower |
| string/split | 11.26x slower | 1.20x slower | — |
| string/replace | 2.29x slower | 1.40x faster | — |
| string/case-convert | 3.90x slower | 11.09x faster | — |
| string/substring | 2.60x faster | 3.03x faster | — |
| string/trim | 5.27x slower | 1.13x slower | — |
| string/startsWith-endsWith | 1.23x faster | 1.35x faster | 1.36x slower |
| array/push-pop | 2.68x faster | 2.69x faster | — |
| array/sort-i32 | 1.48x faster | 2.76x faster | — |
| array/map-filter | 2.08x faster | 2.08x faster | — |
| array/reduce | 2.67x faster | 2.66x faster | — |
| array/indexOf | 1.56x faster | 1.56x faster | — |
| array/slice | 2.04x faster | 1.92x faster | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.79x faster | 1.79x faster | — |
| array/find | 18.70x faster | 19.00x faster | 4.13x slower |
| dom/create-elements | 3.29x slower | — | — |
| dom/set-attributes | 1.82x slower | — | — |
| dom/read-attributes | 2.16x slower | — | — |
| dom/modify-text | 3.55x slower | — | — |
| mixed/csv-parse | 14.44x slower | 1.51x faster | — |
| mixed/text-search | 3.23x slower | 1.37x faster | 2.75x slower |
| mixed/fibonacci | 2.18x slower | 2.18x slower | 2.25x slower |
| mixed/matrix-multiply | 1.14x slower | 1.14x slower | 3.92x slower |
| mixed/sieve | 1.23x faster | 1.20x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.63x faster |
| string/concat-long | 1.63x faster |
| string/indexOf | 4.90x faster |
| string/includes | 3.04x faster |
| string/split | 9.36x faster |
| string/replace | 3.20x faster |
| string/case-convert | 43.29x faster |
| string/substring | 1.16x faster |
| string/trim | 4.68x faster |
| string/startsWith-endsWith | 1.09x faster |
| array/push-pop | 1.00x faster |
| array/sort-i32 | 1.87x faster |
| array/map-filter | 1.00x faster |
| array/reduce | 1.00x slower |
| array/indexOf | 1.00x slower |
| array/slice | 1.06x slower |
| array/reverse | 1.00x faster |
| array/forEach | 1.00x slower |
| array/find | 1.02x faster |
| mixed/csv-parse | 21.77x faster |
| mixed/text-search | 4.43x faster |
| mixed/fibonacci | 1.00x slower |
| mixed/matrix-multiply | 1.00x faster |
| mixed/sieve | 1.02x slower |

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
| string/concat-short | 1393.9ms | 1259.1ms | — |
| string/concat-long | 739.1ms | 1096.4ms | — |
| string/indexOf | 883.2ms | 1120.4ms | 987.0ms |
| string/includes | 963.8ms | 1141.5ms | 982.6ms |
| string/split | 888.0ms | 1109.0ms | — |
| string/replace | 1023.5ms | 1260.5ms | — |
| string/case-convert | 927.8ms | 943.3ms | — |
| string/substring | 732.3ms | 857.1ms | — |
| string/trim | 865.4ms | 1109.9ms | — |
| string/startsWith-endsWith | 854.8ms | 1188.1ms | 1008.6ms |
| array/push-pop | 884.6ms | 948.1ms | — |
| array/sort-i32 | 1081.8ms | 1134.1ms | — |
| array/map-filter | 1017.6ms | 1197.5ms | — |
| array/reduce | 958.9ms | 1010.8ms | — |
| array/indexOf | 1045.7ms | 1124.6ms | — |
| array/slice | 868.5ms | 970.8ms | — |
| array/reverse | 868.3ms | 916.5ms | — |
| array/forEach | 1003.7ms | 1061.9ms | — |
| array/find | 846.7ms | 969.3ms | 952.6ms |
| dom/create-elements | 741.8ms | — | — |
| dom/set-attributes | 849.5ms | — | — |
| dom/read-attributes | 813.7ms | — | — |
| dom/modify-text | 738.6ms | — | — |
| mixed/csv-parse | 936.3ms | 1142.5ms | — |
| mixed/text-search | 907.0ms | 1163.6ms | 1054.5ms |
| mixed/fibonacci | 930.0ms | 991.1ms | 907.7ms |
| mixed/matrix-multiply | 985.6ms | 1005.7ms | 882.1ms |
| mixed/sieve | 960.3ms | 1021.7ms | — |
