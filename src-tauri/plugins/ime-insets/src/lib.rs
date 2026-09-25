use tauri::{plugin::{Builder, TauriPlugin}, Runtime};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("ime-insets")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            api.register_android_plugin("dev.openharness.insets", "ImeInsetsPlugin")?;
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}
