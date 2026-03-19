import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { message } from "@tauri-apps/api/dialog";
import { Command, Child } from "@tauri-apps/api/shell";
import { listen } from "@tauri-apps/api/event";
import { readBinaryFile, removeFile } from "@tauri-apps/api/fs";
import { tempdir } from "@tauri-apps/api/os";
import { fetch as tauriFetch, Body } from "@tauri-apps/api/http";

// Bundled .app launches with a stripped PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// Homebrew tools (rec, sox, SwitchAudioSource) live outside that PATH, so we
// run them via /bin/sh with both Homebrew prefixes prepended. Each binary arg
// is passed as a positional parameter ($1, $2, …) so filepaths with spaces
// are handled safely without any shell-quoting juggling.
const BREW_PATH = "/opt/homebrew/bin:/usr/local/bin";

function brewSpawn(bin: string, args: string[]): Promise<Child> {
  const refs = args.map((_, i) => `"$${i + 1}"`).join(" ");
  return new Command("sh", [
    "-c", `export PATH="${BREW_PATH}:$PATH"; exec ${bin} ${refs}`,
    "--", ...args,
  ]).spawn();
}

function brewExec(bin: string, args: string[]): Promise<unknown> {
  const refs = args.map((_, i) => `"$${i + 1}"`).join(" ");
  return new Command("sh", [
    "-c", `export PATH="${BREW_PATH}:$PATH"; ${bin} ${refs}`,
    "--", ...args,
  ]).execute();
}

export type MeetingType =
  | "Vorlesung"
  | "Business Meeting"
  | "Sonstiges"
  | "Aufzeichung";
export type AudioSource = "mikrofon" | "system" | "beides";
export type UploadMode = "local" | "cloud";

export interface RecordingConfig {
  meetingType: MeetingType;
  audioSource: AudioSource;
  saveFolder: string;
  attachments: string[];
  uploadMode: UploadMode;
  webhookUrl?: string;
  email?: string;
}

export interface RecorderState {
  status: "idle" | "recording" | "stopping" | "uploading";
  duration: number;
  fileSize: number;
  filePath: string | null;
  config: RecordingConfig | null;
  uploadMessage: string;
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>({
    status: "idle",
    duration: 0,
    fileSize: 0,
    filePath: null,
    config: null,
    uploadMessage: "",
  });

  const recProcess = useRef<Child | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const currentConfig = useRef<RecordingConfig | null>(null);
  const currentFilePath = useRef<string | null>(null);

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

    let filepath: string;
    if (config.uploadMode === "cloud") {
      const tmp = await tempdir();
      filepath = `${tmp}/${filename}`;
    } else {
      filepath = `${config.saveFolder}/${filename}`;
    }

    // Nur bei System Audio oder Beides umschalten
    if (config.audioSource === "system" || config.audioSource === "beides") {
      await brewExec("SwitchAudioSource", ["-s", "Multiausgangsgerät", "-t", "output"]);
      await new Promise((r) => setTimeout(r, 2000));
    }

    try {
      let child: Child;
      if (config.audioSource === "mikrofon" || config.audioSource === "beides") {
        // rec vom Standard-Mikrofon
        child = await brewSpawn("rec", ["-r", "48000", "-c", "1", filepath]);
      } else {
        // sox von BlackHole
        child = await brewSpawn("sox", ["-t", "coreaudio", "BlackHole 2ch", filepath]);
      }
      recProcess.current = child;
      currentConfig.current = config;
      currentFilePath.current = filepath;
      startTimeRef.current = Date.now();

      setState({
        status: "recording",
        duration: 0,
        fileSize: 0,
        filePath: filepath,
        config,
        uploadMessage: "",
      });
    } catch (err) {
      console.error("rec start error:", err);
      alert(`Fehler beim Starten der Aufnahme: ${err}`);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "stopping" }));

    const cfg = currentConfig.current;
    const filePath = currentFilePath.current;

    // Nur zurückschalten wenn System Audio verwendet wurde
    if (cfg?.audioSource === "system" || cfg?.audioSource === "beides") {
      await brewExec("SwitchAudioSource", ["-s", "MacBook Pro-Lautsprecher", "-t", "output"]);
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
    currentFilePath.current = null;

    if (cfg?.uploadMode === "cloud" && filePath && cfg.webhookUrl && cfg.email) {
      setState((prev) => ({
        ...prev,
        status: "uploading",
        uploadMessage: "Datei wird hochgeladen…",
      }));

      try {
        const data = await readBinaryFile(filePath);
        const filename = filePath.split("/").pop() ?? "recording.mp3";

        const body = Body.form({
          audio: {
            file: data,
            mime: "audio/mpeg",
            fileName: filename,
          },
          email: cfg.email,
          meetingType: cfg.meetingType,
        });

        const response = await tauriFetch(cfg.webhookUrl, {
          method: "POST",
          body,
        });

        if (!response.ok) {
          throw new Error(`Server antwortete mit Status ${response.status}`);
        }

        await removeFile(filePath);
        await message("Zusammenfassung wird per Mail zugeschickt ✓", {
          title: "Upload erfolgreich",
        });
      } catch (err) {
        await message(`Upload fehlgeschlagen: ${err}`, {
          title: "Fehler",
          type: "error",
        });
      }
    }

    setState((prev) => ({
      ...prev,
      status: "idle",
      uploadMessage: "",
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
