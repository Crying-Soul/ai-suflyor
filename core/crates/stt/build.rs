fn main() {
    println!("cargo:rerun-if-changed=native/shim.c");
    println!("cargo:rerun-if-changed=native/include");
    cc::Build::new()
        .file("native/shim.c")
        .include("native/include")
        .opt_level(2)
        .warnings(false)
        .compile("whisper_shim");
}
