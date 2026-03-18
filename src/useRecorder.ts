import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { Command, Child } from "@tauri-apps/api/shell";
import { listen } from "@tauri-apps/api/event";

export type MeetingType =
  | "Vorlesung"
  | "Business Meeting"
  | "Sonstiges"
  | "Aufzeichung";
export type AudioSource = "mikrofon" | "system" | "beides";

export interface RecordingConfig {
  meetingType: MeetingType;
  audioSource: AudioSource;
  saveFolder: string;
  attachments: string[];
}

export interface RecorderState {
  status: "idle" | "recording" | "stopping";
  duration: number;
  fileSize: number;
  filePath: string | null;
  config: RecordingConfig | null;
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>({
    status: "idle",
    duration: 0,
    fileSize: 0,
    filePath: null,
    config: null,
  });

  const recProcess = useRef<Child | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const currentConfig = useRef<RecordingConfig | null>(null);

  // Listen for tray stop event
  useEffect(() => {
    const unlisten = listen("tray-stop-recording", () => {
      stopRecording();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Update tray every second during recording
  useEffect(() => {
    if (state.status === "recording") {
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
        const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
        const s = String(elapsed % 60).padStart(2, "0");
        const dur = `${h}:${m}:${s}`;

        setState((prev) => ({
          ...prev,
          duration: elapsed,
          fileSize: elapsed * 24000,
        }));
        invoke("update_tray_recording", { isRecording: true, duration: dur });
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      invoke("update_tray_recording", { isRecording: false, duration: "" });
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [state.status]);

  const chooseSaveFolder = useCallback(async (): Promise<string | null> => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Speicherort wählen",
    });
    return selected as string | null;
  }, []);

  const startRecording = useCallback(async (config: RecordingConfig) => {
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = config.meetingType.replace(/ /g, "_");
    const filename = `${safeName}_${ts}.mp3`;
    const filepath = `${config.saveFolder}/${filename}`;

    // Nur bei System Audio oder Beides umschalten
    if (config.audioSource === "system" || config.audioSource === "beides") {
      await new Command("SwitchAudioSource", [
        "-s",
        "Multiausgangsgerät",
        "-t",
        "output",
      ]).execute();
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Kommando und Args je nach Audio-Quelle
    let commandName = "rec";
    let recArgs: string[] = [];

    if (config.audioSource === "mikrofon") {
      // rec vom Standard-Mikrofon
      commandName = "rec";
      recArgs = ["-r", "48000", "-c", "1", filepath];
    } else if (config.audioSource === "system") {
      // sox von BlackHole
      commandName = "sox";
      recArgs = ["-t", "coreaudio", "BlackHole 2ch", filepath];
    } else {
      // Beides: Mikrofon aufnehmen
      commandName = "rec";
      recArgs = ["-r", "48000", "-c", "1", filepath];
    }

    try {
      const cmd = new Command(commandName, recArgs);
      const child = await cmd.spawn();
      recProcess.current = child;
      currentConfig.current = config;
      startTimeRef.current = Date.now();

      setState({
        status: "recording",
        duration: 0,
        fileSize: 0,
        filePath: filepath,
        config,
      });
    } catch (err) {
      console.error("rec start error:", err);
      alert(`Fehler beim Starten der Aufnahme: ${err}`);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "stopping" }));

    // Nur zurückschalten wenn System Audio verwendet wurde
    const cfg = currentConfig.current;
    if (cfg?.audioSource === "system" || cfg?.audioSource === "beides") {
      await new Command("SwitchAudioSource", [
        "-s",
        "MacBook Pro-Lautsprecher",
        "-t",
        "output",
      ]).execute();
    }

    // Prozess sauber beenden
    try {
      await new Command("pkill", ["-INT", "-x", "rec"]).execute();
    } catch (_) {}
    try {
      await new Command("pkill", ["-INT", "-x", "sox"]).execute();
    } catch (_) {}

    await new Promise((r) => setTimeout(r, 1500));

    currentConfig.current = null;
    setState((prev) => ({
      ...prev,
      status: "idle",
    }));
  }, []);

  const formatDuration = (seconds: number): string => {
    const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const s = String(seconds % 60).padStart(2, "0");
    return `${h}:${m}:${s}`;
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return {
    state,
    startRecording,
    stopRecording,
    chooseSaveFolder,
    formatDuration,
    formatFileSize,
  };
}
