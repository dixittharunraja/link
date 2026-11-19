fn main() {
  // Android 15+ devices with 16 KB pages (and Google Play) require native libraries whose LOAD
  // segments are 16 KB aligned; NDK r27's linker defaults to 4 KB.
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
    println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
  }
  tauri_build::build()
}
