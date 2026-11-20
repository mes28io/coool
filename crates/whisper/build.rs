//! Builds the vendored whisper.cpp (see whisper.cpp/VENDOR.md) with the `cc` crate: no CMake, only the C/C++ compiler
//! that Xcode's command line tools already provide.
//!
//! - Always optimized (`-O3`), also in `tauri dev`: a debug build of ggml is far too slow to transcribe with.
//! - Apple silicon: ggml's Metal backend, its shader source embedded in the binary (as CMake's
//!   `GGML_METAL_EMBED_LIBRARY` does), plus Accelerate for the CPU parts. Code is built for the M1 baseline, so the
//!   binary runs on every Apple silicon Mac (never `-mcpu=native`).
//! - Elsewhere (Intel Macs, Linux CI) the crate builds a stub: `available()` is false and loading a model fails with a
//!   plain message. coool targets Apple silicon.

use std::env;
use std::path::{Path, PathBuf};

const W: &str = "whisper.cpp";

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=shim/shim.c");
    println!("cargo:rerun-if-changed={W}");
    println!("cargo:rerun-if-env-changed=COOOL_WHISPER_STUB");
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if os != "macos" || arch != "aarch64" || env::var_os("COOOL_WHISPER_STUB").is_some() {
        println!("cargo:rustc-cfg=whisper_stub");
        println!("cargo::rustc-check-cfg=cfg(whisper_stub)");
        return;
    }
    println!("cargo::rustc-check-cfg=cfg(whisper_stub)");
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    // The same floor as the rest of the app (cc would otherwise take this Mac's own macOS version).
    if env::var_os("MACOSX_DEPLOYMENT_TARGET").is_none() {
        // SAFETY: nothing else runs in this build script.
        unsafe { env::set_var("MACOSX_DEPLOYMENT_TARGET", "13.0") };
    }
    let src = |p: &str| PathBuf::from(W).join(p);

    let includes = [src("include"), src("ggml/include"), src("ggml/src"), src("ggml/src/ggml-cpu"), src("ggml/src/ggml-metal")];
    let defines: &[(&str, Option<&str>)] = &[
        ("NDEBUG", None),
        ("_DARWIN_C_SOURCE", None),
        ("_XOPEN_SOURCE", Some("600")),
        ("GGML_USE_CPU", None),
        ("GGML_USE_METAL", None),
        ("GGML_USE_ACCELERATE", None),
        ("ACCELERATE_NEW_LAPACK", None),
        ("ACCELERATE_LAPACK_ILP64", None),
        ("GGML_METAL_EMBED_LIBRARY", None),
        ("GGML_METAL_NDEBUG", None),
        ("GGML_SCHED_MAX_COPIES", Some("4")),
        ("GGML_VERSION", Some("\"0.9.5\"")),
        ("GGML_COMMIT", Some("\"whisper.cpp-v1.8.3\"")),
        ("WHISPER_VERSION", Some("\"1.8.3\"")),
    ];
    let base = |cpp: bool| {
        let mut b = cc::Build::new();
        b.cpp(cpp).opt_level(3).debug(false).warnings(false).includes(&includes);
        for (k, v) in defines {
            b.define(k, *v);
        }
        // Every Apple silicon Mac, not only this one.
        b.flag("-mcpu=apple-m1");
        if cpp {
            b.std("c++17");
        } else {
            b.std("c11");
        }
        b
    };

    // C and Objective-C (ggml's core, CPU kernels, Metal glue, coool's shim) and the embedded shaders.
    let mut c = base(false);
    for f in [
        "ggml/src/ggml.c",
        "ggml/src/ggml-alloc.c",
        "ggml/src/ggml-quants.c",
        "ggml/src/ggml-cpu/ggml-cpu.c",
        "ggml/src/ggml-cpu/quants.c",
        "ggml/src/ggml-cpu/arch/arm/quants.c",
    ] {
        c.file(src(f));
    }
    for f in ["ggml/src/ggml-metal/ggml-metal-device.m", "ggml/src/ggml-metal/ggml-metal-context.m"] {
        c.file(src(f));
    }
    c.file("shim/shim.c");
    c.file(metal_embed(&out));
    c.compile("coool_whisper_c");

    // C++ (whisper itself, the backend registry, ggml's C++ parts).
    let mut cpp = base(true);
    for f in [
        "src/whisper.cpp",
        "ggml/src/ggml.cpp",
        "ggml/src/ggml-backend.cpp",
        "ggml/src/ggml-backend-reg.cpp",
        "ggml/src/ggml-opt.cpp",
        "ggml/src/ggml-threading.cpp",
        "ggml/src/gguf.cpp",
        "ggml/src/ggml-cpu/ggml-cpu.cpp",
        "ggml/src/ggml-cpu/repack.cpp",
        "ggml/src/ggml-cpu/hbm.cpp",
        "ggml/src/ggml-cpu/traits.cpp",
        "ggml/src/ggml-cpu/amx/amx.cpp",
        "ggml/src/ggml-cpu/amx/mmq.cpp",
        "ggml/src/ggml-cpu/binary-ops.cpp",
        "ggml/src/ggml-cpu/unary-ops.cpp",
        "ggml/src/ggml-cpu/vec.cpp",
        "ggml/src/ggml-cpu/ops.cpp",
        "ggml/src/ggml-cpu/arch/arm/repack.cpp",
        "ggml/src/ggml-metal/ggml-metal.cpp",
        "ggml/src/ggml-metal/ggml-metal-device.cpp",
        "ggml/src/ggml-metal/ggml-metal-common.cpp",
        "ggml/src/ggml-metal/ggml-metal-ops.cpp",
    ] {
        cpp.file(src(f));
    }
    cpp.compile("coool_whisper_cpp");

    for fw in ["Foundation", "Metal", "MetalKit", "Accelerate"] {
        println!("cargo:rustc-link-lib=framework={fw}");
    }
    // ggml's Metal glue uses `@available`, which calls `__isPlatformVersionAtLeast` from clang's own runtime. clang
    // adds that library when it links; rustc doesn't, and a release link fails without it.
    let rt = std::process::Command::new(c.get_compiler().path()).arg("--print-file-name=libclang_rt.osx.a").output();
    if let Ok(o) = rt {
        let p = PathBuf::from(String::from_utf8_lossy(&o.stdout).trim());
        if let (true, Some(dir)) = (p.is_file(), p.parent()) {
            println!("cargo:rustc-link-search=native={}", dir.display());
            println!("cargo:rustc-link-lib=static=clang_rt.osx");
        }
    }
}

/// The Metal shader source with its two headers inlined, wrapped in an assembly file that puts it between the
/// `ggml_metallib_start` / `_end` symbols ggml-metal-device.m reads it from (CMake's GGML_METAL_EMBED_LIBRARY).
fn metal_embed(out: &Path) -> PathBuf {
    let dir = Path::new(W).join("ggml/src");
    let read = |p: PathBuf| std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let metal = read(dir.join("ggml-metal/ggml-metal.metal"));
    let common = read(dir.join("ggml-common.h"));
    let imp = read(dir.join("ggml-metal/ggml-metal-impl.h"));
    let mut merged = String::with_capacity(metal.len() + common.len() + imp.len());
    for line in metal.lines() {
        if line.contains("__embed_ggml-common.h__") {
            merged.push_str(&common);
            merged.push('\n');
        } else if line.trim() == "#include \"ggml-metal-impl.h\"" {
            merged.push_str(&imp);
            merged.push('\n');
        } else {
            merged.push_str(line);
            merged.push('\n');
        }
    }
    let metal_out = out.join("ggml-metal-embed.metal");
    std::fs::write(&metal_out, merged).unwrap();
    let asm = out.join("ggml-metal-embed.s");
    std::fs::write(
        &asm,
        format!(
            ".section __DATA,__ggml_metallib\n.globl _ggml_metallib_start\n_ggml_metallib_start:\n.incbin \"{}\"\n.globl _ggml_metallib_end\n_ggml_metallib_end:\n",
            metal_out.display()
        ),
    )
    .unwrap();
    asm
}
