#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem,
};

fn build_tray_menu(is_recording: bool) -> SystemTrayMenu {
    if is_recording {
        SystemTrayMenu::new()
            .add_item(CustomMenuItem::new("status", "🔴 Aufnahme läuft...").disabled())
            .add_native_item(SystemTrayMenuItem::Separator)
            .add_item(CustomMenuItem::new("show", "Fenster öffnen"))
            .add_item(CustomMenuItem::new("stop", "⏹ Aufnahme stoppen"))
            .add_native_item(SystemTrayMenuItem::Separator)
            .add_item(CustomMenuItem::new("quit", "Beenden"))
    } else {
        SystemTrayMenu::new()
            .add_item(CustomMenuItem::new("status", "⚪ Bereit").disabled())
            .add_native_item(SystemTrayMenuItem::Separator)
            .add_item(CustomMenuItem::new("show", "Aufnahme starten"))
            .add_native_item(SystemTrayMenuItem::Separator)
            .add_item(CustomMenuItem::new("quit", "Beenden"))
    }
}

#[tauri::command]
fn update_tray_recording(app_handle: tauri::AppHandle, is_recording: bool, duration: String) {
    let tray = app_handle.tray_handle();
    if is_recording {
        let _ = tray.set_tooltip(&format!("🔴 REC {}", duration));
        let menu = build_tray_menu(true);
        let _ = tray.set_menu(menu);
    } else {
        let _ = tray.set_tooltip("Call Recorder");
        let menu = build_tray_menu(false);
        let _ = tray.set_menu(menu);
    }
}

fn main() {
    let tray = SystemTray::new().with_menu(build_tray_menu(false));

    tauri::Builder::default()
        .system_tray(tray)
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "show" => {
                    let window = app.get_window("main").unwrap();
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
                "stop" => {
                    app.emit_all("tray-stop-recording", {}).unwrap();
                    let window = app.get_window("main").unwrap();
                    window.show().unwrap();
                    window.set_focus().unwrap();
                }
                "quit" => {
                    app.emit_all("tray-quit", {}).unwrap();
                    std::process::exit(0);
                }
                _ => {}
            },
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![update_tray_recording])
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
