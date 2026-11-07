fn main() {
    // The prebuilt ONNX Runtime for Windows always links DirectML, which we never use (CPU only):
    // delay-loaded, the 18 MB DLL need not ship.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:DirectML.dll");
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
        // The test harness of the bin has no ONNX imports: no warning about an unused delay-load.
        println!("cargo:rustc-link-arg-bins=/IGNORE:4199");
    }
}
