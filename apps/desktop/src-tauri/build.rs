// MANUT_APP_STORE=1 at build time makes the Mac App Store edition (docs/app-store.md): the shell is built with
// `cfg(app_store)`, which leaves the in-app updater out and reads the person's real home folder from the password
// database (app_store.rs). The page reads the same variable in vite.config.ts. It is the one flag for both halves, set
// only by scripts/appstore-mac.sh, so the GitHub build is exactly what it was without it.
fn main() {
    println!("cargo::rustc-check-cfg=cfg(app_store)");
    println!("cargo::rerun-if-env-changed=MANUT_APP_STORE");
    if std::env::var("MANUT_APP_STORE").as_deref() == Ok("1") {
        println!("cargo::rustc-cfg=app_store");
    }
    tauri_build::build()
}
