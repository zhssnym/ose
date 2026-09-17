use std::path::PathBuf;

fn main() {
    // The CI stamp (update.rs `build_info`) is read with `option_env!`; without these lines a
    // cached build would keep the previous commit's stamp.
    println!("cargo:rerun-if-env-changed=OSE_BUILD_SHA");
    println!("cargo:rerun-if-env-changed=OSE_BUILD_DATE");

    // The kernel bundles and the shell are embedded by `generate_context!` when the crate is
    // compiled, and cargo does not know that. A directory here means "any file under it", so a
    // change to the JavaScript alone rebuilds the exe instead of shipping the previous one.
    println!("cargo:rerun-if-changed=../dist-kernel");

    // On Windows, tauri-build compiles the icon and version resource and links it into bin
    // targets only, together with an application manifest that opts the process into Common
    // Controls v6. tauri (`common-controls-v6`, a default feature) and the dialog plugin both
    // import `TaskDialogIndirect`, which only that comctl32 exports, so any executable without
    // the manifest fails to load with STATUS_ENTRYPOINT_NOT_FOUND: the library's unit-test
    // harness did, and `cargo test` never ran on Windows. The manifest is therefore compiled
    // apart from tauri-build's resource and linked into every target, and tauri-build is told
    // to leave its own out so it is embedded exactly once.
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("tauri-build failed");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_manifest();
    }
}

fn embed_manifest() {
    println!("cargo:rerun-if-changed=windows-app.manifest");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR is set for build scripts"));
    let manifest = out.join("windows-app.manifest");
    std::fs::copy("windows-app.manifest", &manifest).expect("copy windows-app.manifest");
    // RT_MANIFEST is resource type 24; the application manifest is id 1.
    let rc = out.join("windows-app-manifest.rc");
    let path = manifest.to_string_lossy().replace('\\', "/");
    std::fs::write(&rc, format!("1 24 \"{path}\"\n")).expect("write the manifest rc");
    embed_resource::compile_for_everything(&rc, embed_resource::NONE)
        .manifest_required()
        .expect("compile the application manifest");
}
