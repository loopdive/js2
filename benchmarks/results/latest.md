# js2wasm Benchmark Results

Date: 2026-07-30
Node: v25.7.0
Platform: linux x64

## Summary

| Benchmark | JS | Host-call | GC-native | Linear | Winner |
|-----------|-----|-----------|-----------|--------|--------|
| string/concat-short | 0.026ms | 0.081ms | 0.037ms | — | js |
| string/concat-long | 0.004ms | 0.011ms | 0.021ms | — | js |
| string/indexOf | 0.022ms | 0.737ms | 0.069ms | — | js |
| string/includes | 0.023ms | 0.704ms | 0.041ms | — | js |
| string/split | 0.408ms | 22.01ms | 1.07ms | — | js |
| string/replace | 0.042ms | 0.905ms | 0.140ms | — | js |
| string/case-convert | <0.001ms | 1.26ms | 4.41ms | — | js |
| string/substring | 0.004ms | 6.50ms | 0.024ms | — | js |
| string/trim | 0.150ms | 6.10ms | 0.512ms | — | js |
| string/startsWith-endsWith | 0.252ms | 13.39ms | 0.660ms | — | js |
| array/push-pop | 1.46ms | 1.84ms | 0.826ms | — | gc-native |
| array/sort-i32 | 0.798ms | 1366.5ms | — | — | js |
| array/map-filter | 0.355ms | 0.633ms | 0.059ms | — | gc-native |
| array/reduce | 1.35ms | 1.83ms | 1.64ms | — | js |
| array/indexOf | 3.94ms | 3.39ms | 2.57ms | — | gc-native |
| array/slice | 0.026ms | 0.195ms | 0.023ms | — | gc-native |
| array/reverse | 7.83ms | 3.39ms | 4.31ms | — | host-call |
| array/forEach | 0.083ms | 0.082ms | 0.122ms | — | host-call |
| array/find | 0.236ms | 0.768ms | — | — | js |
| dom/create-elements | 0.057ms | — | — | — | js |
| dom/set-attributes | 0.114ms | — | — | — | js |
| dom/read-attributes | 0.067ms | — | — | — | js |
| dom/modify-text | 0.451ms | — | — | — | js |
| mixed/csv-parse | 0.471ms | 33.49ms | 0.853ms | — | js |
| mixed/text-search | 0.213ms | 27.20ms | 0.986ms | — | js |
| mixed/fibonacci | 0.118ms | 1.18ms | — | 1.18ms | js |
| mixed/matrix-multiply | 0.156ms | 0.477ms | 0.736ms | 2.13ms | js |
| mixed/sieve | 1.60ms | 2.10ms | 1.15ms | — | gc-native |

## Speedup vs JS baseline

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 3.16x slower | 1.46x slower | — |
| string/concat-long | 2.68x slower | 4.99x slower | — |
| string/indexOf | 33.67x slower | 3.14x slower | — |
| string/includes | 30.18x slower | 1.74x slower | — |
| string/split | 53.91x slower | 2.62x slower | — |
| string/replace | 21.56x slower | 3.33x slower | — |
| string/case-convert | 2923.08x slower | 10234.99x slower | — |
| string/substring | 1786.45x slower | 6.60x slower | — |
| string/trim | 40.62x slower | 3.41x slower | — |
| string/startsWith-endsWith | 53.20x slower | 2.62x slower | — |
| array/push-pop | 1.26x slower | 1.77x faster | — |
| array/sort-i32 | 1712.01x slower | — | — |
| array/map-filter | 1.78x slower | 6.03x faster | — |
| array/reduce | 1.35x slower | 1.21x slower | — |
| array/indexOf | 1.16x faster | 1.53x faster | — |
| array/slice | 7.55x slower | 1.12x faster | — |
| array/reverse | 2.31x faster | 1.81x faster | — |
| array/forEach | 1.01x faster | 1.47x slower | — |
| array/find | 3.26x slower | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 71.09x slower | 1.81x slower | — |
| mixed/text-search | 127.64x slower | 4.63x slower | — |
| mixed/fibonacci | 10.04x slower | — | 10.02x slower |
| mixed/matrix-multiply | 3.06x slower | 4.72x slower | 13.67x slower |
| mixed/sieve | 1.31x slower | 1.39x faster | — |

## GC-native vs Host-call

| Benchmark | Speedup |
|-----------|---------|
| string/concat-short | 2.17x faster |
| string/concat-long | 1.86x slower |
| string/indexOf | 10.72x faster |
| string/includes | 17.30x faster |
| string/split | 20.56x faster |
| string/replace | 6.48x faster |
| string/case-convert | 3.50x slower |
| string/substring | 270.78x faster |
| string/trim | 11.93x faster |
| string/startsWith-endsWith | 20.29x faster |
| array/push-pop | 2.23x faster |
| array/map-filter | 10.75x faster |
| array/reduce | 1.12x faster |
| array/indexOf | 1.32x faster |
| array/slice | 8.47x faster |
| array/reverse | 1.27x slower |
| array/forEach | 1.49x slower |
| mixed/csv-parse | 39.28x faster |
| mixed/text-search | 27.58x faster |
| mixed/matrix-multiply | 1.54x slower |
| mixed/sieve | 1.82x faster |

## Binary sizes

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 209B | 1.7KB | — |
| string/concat-long | 236B | 1.9KB | — |
| string/indexOf | 216B | 2.1KB | — |
| string/includes | 236B | 2.1KB | — |
| string/split | 973B | 1.7KB | — |
| string/replace | 289B | 2.5KB | — |
| string/case-convert | 249B | 11.5KB | — |
| string/substring | 239B | 1.3KB | — |
| string/trim | 205B | 1.8KB | — |
| string/startsWith-endsWith | 330B | 1.7KB | — |
| array/push-pop | 947B | 1.4KB | — |
| array/sort-i32 | 1.2KB | — | — |
| array/map-filter | 2.7KB | 2.8KB | — |
| array/reduce | 1.9KB | 2.5KB | — |
| array/indexOf | 1022B | 1.5KB | — |
| array/slice | 1.0KB | 1.5KB | — |
| array/reverse | 1.0KB | 1.5KB | — |
| array/forEach | 2.1KB | 2.7KB | — |
| array/find | 2.3KB | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 1.4KB | 2.9KB | — |
| mixed/text-search | 600B | 2.2KB | — |
| mixed/fibonacci | 157B | — | 173B |
| mixed/matrix-multiply | 1.5KB | 1.8KB | 950B |
| mixed/sieve | 1.5KB | 1.8KB | — |

## Compile times

| Benchmark | Host-call | GC-native | Linear |
|-----------|-----------|-----------|--------|
| string/concat-short | 1325.1ms | 1182.0ms | — |
| string/concat-long | 612.2ms | 976.6ms | — |
| string/indexOf | 570.0ms | 986.1ms | — |
| string/includes | 572.4ms | 979.6ms | — |
| string/split | 720.0ms | 992.1ms | — |
| string/replace | 556.1ms | 996.8ms | — |
| string/case-convert | 553.7ms | 1268.6ms | — |
| string/substring | 562.0ms | 879.7ms | — |
| string/trim | 560.1ms | 962.6ms | — |
| string/startsWith-endsWith | 624.1ms | 1014.1ms | — |
| array/push-pop | 782.0ms | 865.0ms | — |
| array/sort-i32 | 815.6ms | — | — |
| array/map-filter | 949.1ms | 964.5ms | — |
| array/reduce | 830.3ms | 929.3ms | — |
| array/indexOf | 759.8ms | 844.6ms | — |
| array/slice | 755.1ms | 860.4ms | — |
| array/reverse | 750.5ms | 825.9ms | — |
| array/forEach | 833.4ms | 926.2ms | — |
| array/find | 847.9ms | — | — |
| dom/create-elements | — | — | — |
| dom/set-attributes | — | — | — |
| dom/read-attributes | — | — | — |
| dom/modify-text | — | — | — |
| mixed/csv-parse | 772.9ms | 964.7ms | — |
| mixed/text-search | 650.6ms | 1043.7ms | — |
| mixed/fibonacci | 670.2ms | — | 671.0ms |
| mixed/matrix-multiply | 860.0ms | 893.4ms | 823.6ms |
| mixed/sieve | 798.5ms | 900.2ms | — |
