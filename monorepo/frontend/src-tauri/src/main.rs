// src-tauri/src/main.rs — Tauri entrypoint.
//
// The webview serves the existing Svelte frontend unchanged; native tool
// execution is exposed as Tauri commands the FE's ToolExecutor calls via
// `invoke()`. See MIGRATION.md for the plan and safety-ladder mapping.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod docs;
mod filejail;
mod shell;

fn main() {
    // IRIS desktop is connect-only: the backend is an independently managed
    // service. Tauri owns only local tools and never starts/stops a server.
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(shell::init_session_store())
        .invoke_handler(tauri::generate_handler![
            shell::tool_shell_oneshot,
            shell::tool_shell_interactive,
            shell::tool_shell_write,
            shell::tool_shell_close,
            filejail::tool_file_read,
            filejail::tool_file_write,
            docs::tool_docs_list,
            docs::tool_docs_structure,
            docs::tool_docs_read,
            docs::tool_docs_search,
            audio::tool_audio_devices,
            audio::tool_audio_play,
            audio::tool_audio_read,
            audio::cancel_audio_operation,
            audio::active_audio_operation_id,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
