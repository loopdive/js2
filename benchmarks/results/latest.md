# js2wasm Benchmark Results

Date: 2026-08-14
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.037ms | 0.045ms | 0.039ms | FAILED | js |
| string/concat-long | 0.004ms | 0.005ms | 0.004ms | FAILED | gc-native |
| string/indexOf | 0.019ms | 0.063ms | 0.012ms | 0.017ms | gc-native |
| string/includes | 0.019ms | 0.115ms | 0.015ms | 0.015ms | gc-native |
| string/split | 0.414ms | 4.92ms | 0.449ms | FAILED | js |
| string/replace | 0.111ms | 0.319ms | 0.071ms | FAILED | gc-native |
| string/case-convert | 0.056ms | 0.231ms | 0.005ms | FAILED | gc-native |
| string/substring | 0.099ms | 0.037ms | 0.031ms | FAILED | gc-native |
| string/trim | 0.171ms | 0.910ms | 0.186ms | FAILED | js |
| string/startsWith-endsWith | 0.401ms | 0.359ms | 0.297ms | 0.562ms | gc-native |
| array/push-pop | 1.47ms | 0.505ms | 0.510ms | FAILED | host-call |
| array/sort-i32 | 0.790ms | 0.295ms | 0.298ms | FAILED | host-call |
| array/map-filter | 0.129ms | 0.071ms | 0.071ms | FAILED | host-call |
| array/reduce | 2.19ms | 0.511ms | 0.509ms | FAILED | gc-native |
| array/indexOf | 3.95ms | 2.64ms | 2.64ms | FAILED | gc-native |
| array/slice | 0.027ms | 0.029ms | 0.029ms | FAILED | js |
| array/reverse | 7.83ms | 3.52ms | 3.52ms | FAILED | host-call |
| array/forEach | 0.050ms | 0.028ms | 0.028ms | FAILED | gc-native |
| array/find | 0.254ms | 0.016ms | 0.016ms | 0.997ms | host-call |
| dom/create-elements | 0.256ms | 0.172ms | — | — | host-call |
| dom/set-attributes | 0.106ms | 0.541ms | — | — | js |
| dom/read-attributes | 0.056ms | 0.127ms | — | — | js |
| dom/modify-text | 0.033ms | 0.109ms | — | — | js |
| mixed/csv-parse | 0.477ms | 7.11ms | 0.318ms | FAILED | gc-native |
| mixed/text-search | 0.390ms | 1.57ms | 0.263ms | 1.08ms | gc-native |
| mixed/fibonacci | 0.120ms | 0.292ms | 0.292ms | 0.288ms | js |
| mixed/matrix-multiply | 0.158ms | 0.213ms | 0.212ms | 0.714ms | js |
| mixed/sieve | 1.59ms | 1.40ms | 1.42ms | FAILED | host-call |

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
| string/concat-short | 10000 | 3.65 | 4.48 | 3.89 | — |
| string/concat-long | 1000 | 3.76 | 4.59 | 3.76 | — |
| string/indexOf | 1000 | 19.22 | 63.17 | 12.26 | 17.16 |
| string/includes | 1000 | 19.22 | 115.22 | 14.64 | 15.37 |
| string/split | 10000 | 41.44 | 492.14 | 44.90 | — |
| string/replace | 1000 | 111.25 | 319.31 | 71.42 | — |
| string/case-convert | 2000 | 27.85 | 115.53 | 2.52 | — |
| string/substring | 10000 | 9.91 | 3.74 | 3.08 | — |
| string/trim | 10000 | 17.08 | 90.99 | 18.63 | — |
| string/startsWith-endsWith | 20000 | 20.07 | 17.95 | 14.83 | 28.08 |
| array/map-filter | 30000 | 4.29 | 2.37 | 2.38 | — |
| array/indexOf | 1000 | 3948.07 | 2635.19 | 2635.14 | — |
| dom/create-elements | 2000 | 128.08 | 86.19 | — | — |
| dom/set-attributes | 6000 | 17.65 | 90.10 | — | — |
| dom/read-attributes | 3000 | 18.66 | 42.32 | — | — |
| dom/modify-text | 2000 | 16.29 | 54.46 | — | — |
| mixed/csv-parse | 11000 | 43.34 | 646.24 | 28.86 | — |
| mixed/text-search | 40000 | 9.75 | 39.14 | 6.58 | 26.88 |
| mixed/fibonacci | 10000 | 12.02 | 29.18 | 29.16 | 28.80 |
| mixed/matrix-multiply | 125000 | 1.27 | 1.71 | 1.70 | 5.71 |
| mixed/sieve | 200000 | 7.96 | 7.02 | 7.10 | — |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1.23x slower | 1.06x slower | — |
| string/concat-long | 1.22x slower | 1.00x faster | — |
| string/indexOf | 3.29x slower | 1.57x faster | 1.12x faster |
| string/includes | 5.99x slower | 1.31x faster | 1.25x faster |
| string/split | 11.88x slower | 1.08x slower | — |
| string/replace | 2.87x slower | 1.56x faster | — |
| string/case-convert | 4.15x slower | 11.07x faster | — |
| string/substring | 2.65x faster | 3.22x faster | — |
| string/trim | 5.33x slower | 1.09x slower | — |
| string/startsWith-endsWith | 1.12x faster | 1.35x faster | 1.40x slower |
| array/push-pop | 2.90x faster | 2.87x faster | — |
| array/sort-i32 | 2.68x faster | 2.65x faster | — |
| array/map-filter | 1.81x faster | 1.81x faster | — |
| array/reduce | 4.28x faster | 4.30x faster | — |
| array/indexOf | 1.50x faster | 1.50x faster | — |
| array/slice | 1.08x slower | 1.08x slower | — |
| array/reverse | 2.22x faster | 2.22x faster | — |
| array/forEach | 1.76x faster | 1.77x faster | — |
| array/find | 15.74x faster | 15.56x faster | 3.92x slower |
| dom/create-elements | 1.49x faster | — | — |
| dom/set-attributes | 5.10x slower | — | — |
| dom/read-attributes | 2.27x slower | — | — |
| dom/modify-text | 3.34x slower | — | — |
| mixed/csv-parse | 14.91x slower | 1.50x faster | — |
| mixed/text-search | 4.01x slower | 1.48x faster | 2.76x slower |
| mixed/fibonacci | 2.43x slower | 2.43x slower | 2.40x slower |
| mixed/matrix-multiply | 1.35x slower | 1.34x slower | 4.50x slower |
| mixed/sieve | 1.13x faster | 1.12x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 1.15x faster |
| string/concat-long | 1.22x faster |
| string/indexOf | 5.15x faster |
| string/includes | 7.87x faster |
| string/split | 10.96x faster |
| string/replace | 4.47x faster |
| string/case-convert | 45.94x faster |
| string/substring | 1.22x faster |
| string/trim | 4.88x faster |
| string/startsWith-endsWith | 1.21x faster |
| array/push-pop | 1.01x slower |
| array/sort-i32 | 1.01x slower |
| array/map-filter | 1.00x slower |
| array/reduce | 1.00x faster |
| array/indexOf | 1.00x faster |
| array/slice | 1.00x faster |
| array/reverse | 1.00x slower |
| array/forEach | 1.00x faster |
| array/find | 1.01x slower |
| mixed/csv-parse | 22.39x faster |
| mixed/text-search | 5.94x faster |
| mixed/fibonacci | 1.00x faster |
| mixed/matrix-multiply | 1.01x faster |
| mixed/sieve | 1.01x slower |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 197B | 736B | — |
| string/concat-long | 223B | 940B | — |
| string/indexOf | 254B | 1.1KB | 10.4KB |
| string/includes | 241B | 1.1KB | 10.4KB |
| string/split | 1.6KB | 3.0KB | — |
| string/replace | 1.6KB | 4.0KB | — |
| string/case-convert | 1.5KB | 2.1KB | — |
| string/substring | 202B | 279B | — |
| string/trim | 1.2KB | 2.6KB | — |
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
| mixed/csv-parse | 2.2KB | 4.0KB | — |
| mixed/text-search | 1.9KB | 3.9KB | 1.9KB |
| mixed/fibonacci | 405B | 405B | 386B |
| mixed/matrix-multiply | 1.6KB | 1.9KB | 992B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1361.3ms | 1130.9ms | — |
| string/concat-long | 657.1ms | 1001.5ms | — |
| string/indexOf | 678.0ms | 1019.8ms | 867.5ms |
| string/includes | 677.6ms | 1003.7ms | 842.6ms |
| string/split | 780.5ms | 1004.0ms | — |
| string/replace | 803.0ms | 1129.6ms | — |
| string/case-convert | 813.1ms | 835.5ms | — |
| string/substring | 664.1ms | 761.0ms | — |
| string/trim | 750.2ms | 998.5ms | — |
| string/startsWith-endsWith | 785.4ms | 1013.5ms | 937.9ms |
| array/push-pop | 812.5ms | 873.7ms | — |
| array/sort-i32 | 909.5ms | 989.6ms | — |
| array/map-filter | 961.3ms | 1042.1ms | — |
| array/reduce | 860.0ms | 927.3ms | — |
| array/indexOf | 869.4ms | 953.1ms | — |
| array/slice | 784.8ms | 837.7ms | — |
| array/reverse | 779.1ms | 849.9ms | — |
| array/forEach | 886.6ms | 981.4ms | — |
| array/find | 761.1ms | 834.6ms | 856.9ms |
| dom/create-elements | 688.5ms | — | — |
| dom/set-attributes | 749.1ms | — | — |
| dom/read-attributes | 735.7ms | — | — |
| dom/modify-text | 665.6ms | — | — |
| mixed/csv-parse | 857.7ms | 1066.7ms | — |
| mixed/text-search | 774.1ms | 1046.7ms | 932.1ms |
| mixed/fibonacci | 866.7ms | 916.2ms | 809.7ms |
| mixed/matrix-multiply | 870.9ms | 943.0ms | 809.6ms |
| mixed/sieve | 858.7ms | 900.2ms | — |
