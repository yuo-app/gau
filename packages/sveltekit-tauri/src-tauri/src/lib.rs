use tauri::{Manager, Emitter};
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(
            |app, _argv, _cwd| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            },
        ));
    }

    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            #[cfg(debug_assertions)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            let handle = app.handle().clone();
            let handle_for_closure = handle.clone();
            handle.deep_link().on_open_url(move |event| {
                if let Some(window) = handle_for_closure.get_webview_window("main") {
                    if let Some(url) = event.urls().first() {
                        let _ = window.emit("deep-link", url.to_string());
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
