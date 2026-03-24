#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use rustfft::{num_complex::Complex, FftPlanner};
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
                let chunk_bytes = 4800usize; // 2400 samples at 48kHz = 50ms
                let mut buf = vec![0u8; chunk_bytes];

                

                loop {
                    match reader.read_exact(&mut buf) {
                        Ok(_) => {
                            // Convert raw PCM bytes to f32 samples normalised to -1..1
                            let mut samples: Vec<Complex<f32>> = buf
                                .chunks_exact(2)
                                .map(|b| Complex {
                                    re: i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0,
                                    im: 0.0,
                                })
                                .collect();
                            // Apply Hann window to reduce spectral leakage
                            let n = samples.len();
                            for (i, s) in samples.iter_mut().enumerate() {
                                let w = 0.5 * (1.0 - (2.0 * std::f64::consts::PI * i as f64 / (n - 1) as f64).cos()) as f32;
                                s.re *= w;
                            }
                            // Run FFT
                            let mut planner = FftPlanner::<f32>::new();
                            let fft = planner.plan_fft_forward(n);
                            fft.process(&mut samples);
                            // Map FFT bins to 7 voice-optimised frequency bands
                            // At 48000 Hz with 2400 samples: bin_width = 20 Hz per bin
                            //   Bar 0: 100–300 Hz  (bass/fundamental)     → bins 5–15
                            //   Bar 1: 300–600 Hz  (low-mid)              → bins 15–30
                            //   Bar 2: 600–1200 Hz (mid, vowel formant F1)→ bins 30–60
                            //   Bar 3: 1200–2000 Hz(upper-mid, formant F2)→ bins 60–100
                            //   Bar 4: 2000–3000 Hz(presence, consonants) → bins 100–150
                            //   Bar 5: 3000–5000 Hz(sibilance/fricatives) → bins 150–250
                            //   Bar 6: 5000–8000 Hz(air/high presence)    → bins 250–400
                            let bin_ranges: [(usize, usize); 7] = [
                                (8,   15),
                                (15,  30),
                                (30,  60),  
                                (60,  100),
                                (100,  150),
                                (150, 250),
                                (250, 400),
                            ];
                            // Per-band gain: lower frequencies need more amplification
                            // (voice energy rolls off at higher frequencies).
                            let gains: [f32; 7] = [8.0, 6.0, 4.0, 3.0, 12.0, 10.0, 8.0];
                            // let gains: [f32; 7] = [0.5, 0.5, 2.0, 2.0, 12.0, 10.0, 8.0];
                            // Only use first half of FFT output (second half is mirror)
                            let half = samples.len() / 2;
                            let bands: Vec<f32> = bin_ranges.iter().zip(gains.iter()).map(|(&(lo, hi), &gain)| {
                                let hi = hi.min(half);
                                if lo >= hi { return 0.0; }
                                let energy: f32 = samples[lo..hi]
                                    .iter()
                                    .map(|c| c.norm_sqr())
                                    .sum::<f32>() / (hi - lo) as f32;
                                let rms = energy.sqrt();
                                (rms * gain).min(1.0)
                            }).collect();
                            let _ = app_handle.emit_all(
                                "volume-level",
                                serde_json::json!({ "bands": bands }),
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
