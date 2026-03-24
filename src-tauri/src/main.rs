#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::io::Read;
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::thread;
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

struct VolumeMeter(Mutex<Option<Child>>);

#[tauri::command]
fn start_volume_meter(
    app_handle: tauri::AppHandle,
    state: tauri::State<VolumeMeter>,
) {
    let mut guard = state.0.lock().unwrap();

    // Kill any existing meter process
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
    }

    // Spawn sox reading BlackHole 2ch as raw 16-bit mono PCM to stdout.
    // `exec` replaces sh so the stored PID is sox itself, making kill() work.
    let result = StdCommand::new("/bin/sh")
        .args([
            "-c",
            "export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; \
             exec sox -t coreaudio 'BlackHole 2ch' \
             -t raw -r 48000 -e signed-integer -b 16 -c 1 -",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();

    match result {
        Ok(mut child) => {
            let stdout = child.stdout.take().unwrap();
            *guard = Some(child);
            drop(guard); // release lock before spawning reader thread

            thread::spawn(move || {
                let mut reader = std::io::BufReader::new(stdout);
                // 50 ms worth of samples: 48000 Hz × 0.05 s × 2 bytes = 4800 bytes
                let chunk_bytes = 4800usize;
                let sample_count = chunk_bytes / 2; // i16 samples
                let mut buf = vec![0u8; chunk_bytes];

                loop {
                    match reader.read_exact(&mut buf) {
                        Ok(_) => {
                            let sum_sq: f64 = buf
                                .chunks_exact(2)
                                .map(|b| {
                                    let s = i16::from_le_bytes([b[0], b[1]]) as f64;
                                    s * s
                                })
                                .sum();
                            let rms = (sum_sq / sample_count as f64).sqrt();
                            // Normalize to 0..1 and apply 4× gain for quiet signals
                            let level = ((rms / 32768.0).sqrt() * 2.0).min(1.0) as f32;
                            let _ = app_handle.emit_all(
                                "volume-level",
                                serde_json::json!({ "level": level }),
                            );
                        }
                        Err(_) => break, // process was killed or ended
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("start_volume_meter: failed to spawn sox: {}", e);
        }
    }
}

#[tauri::command]
fn stop_volume_meter(state: tauri::State<VolumeMeter>) {
    let mut guard = state.0.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
    }
}

fn main() {
    let tray = SystemTray::new().with_menu(build_tray_menu(false));

    tauri::Builder::default()
        .manage(VolumeMeter(Mutex::new(None)))
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
        .invoke_handler(tauri::generate_handler![
            update_tray_recording,
            start_volume_meter,
            stop_volume_meter,
        ])
        .on_window_event(|event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event.event() {
                event.window().hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
