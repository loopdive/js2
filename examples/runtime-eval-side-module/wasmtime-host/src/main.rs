// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Native provider for the #3630 runtime-eval side-module broker. Its imports
// deliberately mirror the JavaScript WebAssembly object API, but store native
// Wasmtime Module and Instance values inside opaque externrefs.

use std::env;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use wasmtime::error::Context;
use wasmtime::{
    Caller, Config, Engine, ExternRef, Instance, Linker, Memory, MemoryType, Module, Result,
    Rooted, Store, bail, format_err,
};

const SOURCE_OFFSET: usize = 0;
const SOURCE_CAPACITY: usize = 32 * 1024;
const MEMORY_PAGES: u32 = 64;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct HostState {
    memory: Option<Memory>,
    repo_root: PathBuf,
    compile_count: u32,
    last_side_module_bytes: usize,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("runtime-eval-side-module-wasmtime-host: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = env::args().skip(1);
    let broker_path = PathBuf::from(args.next().ok_or_else(|| format_err!(USAGE))?);
    let repo_root = PathBuf::from(args.next().ok_or_else(|| format_err!(USAGE))?);
    let source = args.next().unwrap_or_else(|| "6 * 7".to_owned());
    if args.next().is_some() {
        bail!(USAGE);
    }

    let source_bytes = source.as_bytes();
    if source_bytes.len() > SOURCE_CAPACITY {
        bail!("eval source exceeds {SOURCE_CAPACITY} byte proof-of-concept limit");
    }

    let mut config = Config::new();
    config.wasm_exceptions(true);
    config.wasm_function_references(true);
    config.wasm_gc(true);
    let engine = Engine::new(&config)?;
    let broker_module = Module::from_file(&engine, &broker_path)
        .with_context(|| format!("failed to compile broker {}", broker_path.display()))?;

    let mut linker = Linker::new(&engine);
    define_compiler_import(&mut linker)?;
    define_webassembly_imports(&mut linker)?;

    let mut store = Store::new(
        &engine,
        HostState {
            repo_root,
            ..HostState::default()
        },
    );
    let memory = Memory::new(&mut store, MemoryType::new(MEMORY_PAGES, None))?;
    store.data_mut().memory = Some(memory);
    linker.define(&mut store, "WebAssembly", "memory", memory)?;

    let broker = linker.instantiate(&mut store, &broker_module)?;
    memory.write(&mut store, SOURCE_OFFSET, source_bytes)?;
    let eval = broker.get_typed_func::<(i32, i32), f64>(&mut store, "evalF64")?;
    let result = eval.call(
        &mut store,
        (SOURCE_OFFSET as i32, source_bytes.len() as i32),
    )?;

    println!(
        "{{\"host\":\"wasmtime\",\"source\":{:?},\"result\":{},\"compileCount\":{},\"sideModuleBytes\":{}}}",
        source,
        result,
        store.data().compile_count,
        store.data().last_side_module_bytes,
    );
    Ok(())
}

fn define_compiler_import(linker: &mut Linker<HostState>) -> Result<()> {
    linker.func_wrap(
        "js2wasm:compiler",
        "compileEval",
        |mut caller: Caller<'_, HostState>,
         source_pointer: i32,
         source_length: i32,
         output_pointer: i32,
         output_capacity: i32|
         -> Result<i32> {
            let source =
                read_memory_string(&caller, source_pointer, source_length, "compileEval source")?;
            let binary = compile_with_js2wasm(&caller.data().repo_root, &source)?;
            let output_pointer = checked_usize(output_pointer, "compileEval output pointer")?;
            let output_capacity = checked_usize(output_capacity, "compileEval output capacity")?;
            if binary.len() > output_capacity {
                bail!(
                    "compiled side module is {} B; capacity is {} B",
                    binary.len(),
                    output_capacity
                );
            }
            memory(&caller)?.write(&mut caller, output_pointer, &binary)?;
            caller.data_mut().compile_count += 1;
            caller.data_mut().last_side_module_bytes = binary.len();
            i32::try_from(binary.len()).context("compiled side module exceeds i32 length")
        },
    )?;
    Ok(())
}

fn define_webassembly_imports(linker: &mut Linker<HostState>) -> Result<()> {
    linker.func_wrap(
        "WebAssembly",
        "Module",
        |mut caller: Caller<'_, HostState>,
         pointer: i32,
         length: i32|
         -> Result<Option<Rooted<ExternRef>>> {
            let binary = read_memory(&caller, pointer, length, "WebAssembly.Module bytes")?;
            let module = Module::new(caller.engine(), &binary)?;
            Ok(Some(ExternRef::new(&mut caller, module)?))
        },
    )?;

    linker.func_wrap(
        "WebAssembly",
        "Instance",
        |mut caller: Caller<'_, HostState>,
         module_ref: Option<Rooted<ExternRef>>|
         -> Result<Option<Rooted<ExternRef>>> {
            let module_ref =
                module_ref.ok_or_else(|| format_err!("WebAssembly.Instance received null"))?;
            let module = module_ref
                .data(&caller)?
                .ok_or_else(|| format_err!("WebAssembly.Instance externref has no host data"))?
                .downcast_ref::<Module>()
                .ok_or_else(|| format_err!("WebAssembly.Instance expects a Wasmtime Module"))?
                .clone();
            let instance = Instance::new(&mut caller, &module, &[])?;
            Ok(Some(ExternRef::new(&mut caller, instance)?))
        },
    )?;

    linker.func_wrap(
        "WebAssembly.Instance",
        "callExportF64",
        |mut caller: Caller<'_, HostState>,
         instance_ref: Option<Rooted<ExternRef>>,
         name_pointer: i32,
         name_length: i32|
         -> Result<f64> {
            let name = read_memory_string(
                &caller,
                name_pointer,
                name_length,
                "callExportF64 export name",
            )?;
            let instance_ref =
                instance_ref.ok_or_else(|| format_err!("callExportF64 received null"))?;
            let instance = *instance_ref
                .data(&caller)?
                .ok_or_else(|| format_err!("callExportF64 externref has no host data"))?
                .downcast_ref::<Instance>()
                .ok_or_else(|| format_err!("callExportF64 expects a Wasmtime Instance"))?;
            let function = instance.get_typed_func::<(), f64>(&mut caller, &name)?;
            Ok(function.call(&mut caller, ())?)
        },
    )?;
    Ok(())
}

fn compile_with_js2wasm(repo_root: &Path, source: &str) -> Result<Vec<u8>> {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let output_path = env::temp_dir().join(format!(
        "js2wasm-runtime-eval-{}-{sequence}.wasm",
        std::process::id()
    ));
    let helper = repo_root.join("examples/runtime-eval-side-module/compiler.mjs");

    let mut child = Command::new("node")
        .arg("--import")
        .arg("tsx")
        .arg(&helper)
        .arg(&output_path)
        .current_dir(repo_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("failed to start compiler helper {}", helper.display()))?;
    child
        .stdin
        .take()
        .ok_or_else(|| format_err!("compiler helper stdin was not piped"))?
        .write_all(source.as_bytes())?;
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let _ = fs::remove_file(&output_path);
        bail!(
            "compiler helper failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let binary = fs::read(&output_path)
        .with_context(|| format!("compiler helper did not write {}", output_path.display()))?;
    fs::remove_file(&output_path)?;
    Ok(binary)
}

fn memory(caller: &Caller<'_, HostState>) -> Result<Memory> {
    caller
        .data()
        .memory
        .ok_or_else(|| format_err!("WebAssembly::memory is not installed"))
}

fn read_memory(
    caller: &Caller<'_, HostState>,
    pointer: i32,
    length: i32,
    label: &str,
) -> Result<Vec<u8>> {
    let pointer = checked_usize(pointer, &format!("{label} pointer"))?;
    let length = checked_usize(length, &format!("{label} length"))?;
    let mut bytes = vec![0; length];
    memory(caller)?.read(caller, pointer, &mut bytes)?;
    Ok(bytes)
}

fn read_memory_string(
    caller: &Caller<'_, HostState>,
    pointer: i32,
    length: i32,
    label: &str,
) -> Result<String> {
    String::from_utf8(read_memory(caller, pointer, length, label)?)
        .with_context(|| format!("{label} is not valid UTF-8"))
}

fn checked_usize(value: i32, label: &str) -> Result<usize> {
    usize::try_from(value).with_context(|| format!("{label} is negative"))
}

const USAGE: &str =
    "usage: runtime-eval-side-module-wasmtime-host <broker.wasm> <repo-root> [expression]";
