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

// Returns a configured Command without spawning — callers can attach event
// listeners before calling .spawn().
function brewCommand(bin: string, args: string[]): Command {
  const refs = args.map((_, i) => `"$${i + 1}"`).join(" ");
  return new Command("sh", [
    "-c",
    `export PATH="${BREW_PATH}:$PATH"; exec ${bin} ${refs}`,
    "--",
    ...args,
  ]);
}

// function brewSpawn(bin: string, args: string[]): Promise<Child> {
//   return brewCommand(bin, args).spawn();
// }

function brewExec(bin: string, args: string[]): Promise<unknown> {
  const refs = args.map((_, i) => `"$${i + 1}"`).join(" ");
  return new Command("sh", [
    "-c",
    `export PATH="${BREW_PATH}:$PATH"; ${bin} ${refs}`,
    "--",
    ...args,
  ]).execute();
}

// Returns the name of the current default audio output device using SwitchAudioSource.
async function getCurrentOutputDevice(): Promise<string> {
  const result = (await new Command("sh", [
    "-c",
    `export PATH="${BREW_PATH}:$PATH"; SwitchAudioSource -c`,
  ]).execute()) as { stdout: string };
  return result.stdout.trim();
}

// Returns the name of the first Multi-Output aggregate device whose active
// sub-device list contains a device with "BlackHole" in its name.
// Uses CoreAudio via Python3 ctypes — no external dependencies required.
// Returns null if no such device is found.
async function findMultiOutputDeviceWithBlackHole(): Promise<string | null> {
  // Python constants:
  //   kAudioObjectSystemObject                        = 1
  //   kAudioHardwarePropertyDevices                   = 'dev#' = 0x64657623
  //   kAudioObjectPropertyScopeGlobal                 = 'glob' = 0x676c6f62
  //   kAudioObjectPropertyElementMain                 = 0
  //   kAudioObjectPropertyName                        = 'lnam' = 0x6c6e616d  (CFStringRef)
  //   kAudioAggregateDevicePropertyFullSubDeviceList  = 'grup' = 0x67727570  (CFArrayRef of UID CFStrings)
  //   kCFStringEncodingUTF8                           = 0x08000100
  //
  // 'grup' (Full) is used instead of 'agrp' (Active) because ActiveSubDeviceList is
  // empty when the aggregate device is not the current default output.
  // 'lnam' is the correct CFString name selector; the deprecated 'name' returns a
  // raw C-string and treating it as CFStringRef causes a segfault.
  const pyScript = `import ctypes
CA=ctypes.CDLL("/System/Library/Frameworks/CoreAudio.framework/CoreAudio")
CF=ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
PA=ctypes.c_uint32*3
CA.AudioObjectGetPropertyDataSize.argtypes=[ctypes.c_uint32,ctypes.POINTER(PA),ctypes.c_uint32,ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32)]
CA.AudioObjectGetPropertyDataSize.restype=ctypes.c_int32
CA.AudioObjectGetPropertyData.argtypes=[ctypes.c_uint32,ctypes.POINTER(PA),ctypes.c_uint32,ctypes.c_void_p,ctypes.POINTER(ctypes.c_uint32),ctypes.c_void_p]
CA.AudioObjectGetPropertyData.restype=ctypes.c_int32
CF.CFArrayGetCount.argtypes=[ctypes.c_void_p];CF.CFArrayGetCount.restype=ctypes.c_long
CF.CFArrayGetValueAtIndex.argtypes=[ctypes.c_void_p,ctypes.c_long];CF.CFArrayGetValueAtIndex.restype=ctypes.c_void_p
CF.CFStringGetCString.argtypes=[ctypes.c_void_p,ctypes.c_char_p,ctypes.c_long,ctypes.c_uint32];CF.CFStringGetCString.restype=ctypes.c_bool
CF.CFRelease.argtypes=[ctypes.c_void_p];CF.CFRelease.restype=None
def mk(s,sc=0x676c6f62,el=0):return PA(s,sc,el)
def cs(ref):
 b=ctypes.create_string_buffer(512)
 return b.value.decode("utf-8","replace") if CF.CFStringGetCString(ref,b,512,0x08000100) else ""
def nm(d):
 a=mk(0x6c6e616d);r=(ctypes.c_void_p*1)(0);sz=ctypes.c_uint32(8)
 if CA.AudioObjectGetPropertyData(d,a,0,None,ctypes.byref(sz),r)or not r[0]:return""
 s=cs(r[0]);CF.CFRelease(r[0]);return s
a=mk(0x64657623);sz=ctypes.c_uint32(0);CA.AudioObjectGetPropertyDataSize(1,a,0,None,ctypes.byref(sz))
ids=(ctypes.c_uint32*(sz.value//4))();sz2=ctypes.c_uint32(sz.value);CA.AudioObjectGetPropertyData(1,a,0,None,ctypes.byref(sz2),ids)
for d in ids:
 fa=mk(0x67727570);fsz=ctypes.c_uint32(0)
 if CA.AudioObjectGetPropertyDataSize(d,fa,0,None,ctypes.byref(fsz))or not fsz.value:continue
 arr=(ctypes.c_void_p*1)(0);fsz2=ctypes.c_uint32(fsz.value)
 if CA.AudioObjectGetPropertyData(d,fa,0,None,ctypes.byref(fsz2),arr)or not arr[0]:continue
 n=CF.CFArrayGetCount(arr[0]);f=False
 for i in range(n):
  uid=CF.CFArrayGetValueAtIndex(arr[0],i)
  if uid and"BlackHole"in cs(uid):f=True;break
 CF.CFRelease(arr[0])
 if f:print(nm(d));raise SystemExit(0)`;

  const result = (await new Command("sh", [
    "-c",
    `/usr/bin/python3 -c "$1"`,
    "--",
    pyScript,
  ]).execute()) as { stdout: string; stderr: string; code: number | null };

  const name = result.stdout.trim();
  return name || null;
}

export type MeetingType =
  | "Vorlesung"
  | "Business Meeting"
  | "Sonstiges"
  | "Aufzeichnung";
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
  apiKey?: string;
}

export interface RecorderState {
  status: "idle" | "recording" | "stopping" | "uploading";
  duration: number;
  fileSize: number;
  filePath: string | null;
  config: RecordingConfig | null;
  uploadMessage: string;
  error: string | null;
}

export function useRecorder() {
  const [state, setState] = useState<RecorderState>({
    status: "idle",
    duration: 0,
    fileSize: 0,
    filePath: null,
    config: null,
    uploadMessage: "",
    error: null,
  });

  const recProcess = useRef<Child | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const currentConfig = useRef<RecordingConfig | null>(null);
  const currentFilePath = useRef<string | null>(null);
  const defaultOutputDevice = useRef<string>("");

  // Cleans up audio device and processes after a recording failure, then
  // transitions back to idle with the error message visible.
  const handleRecordingError = useCallback(async (message: string) => {
    const cfg = currentConfig.current;
    if (!cfg) return; // guard: already stopped or never started

    // Clear refs before cleanup so the process close-event doesn't re-enter.
    currentConfig.current = null;
    currentFilePath.current = null;

    if (cfg.audioSource === "system" || cfg.audioSource === "beides") {
      const restoreDevice = defaultOutputDevice.current;
      defaultOutputDevice.current = "";
      if (restoreDevice) {
        try {
          await brewExec("SwitchAudioSource", [
            "-s",
            restoreDevice,
            "-t",
            "output",
          ]);
        } catch (_) {}
      }
    }

    try {
      await new Command("pkill", ["-INT", "-x", "rec"]).execute();
    } catch (_) {}
    try {
      await new Command("pkill", ["-INT", "-x", "sox"]).execute();
    } catch (_) {}

    setState((prev) => ({ ...prev, status: "idle", error: message }));
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  // Listen for recording-error events emitted by the Rust backend
  // (e.g. volume-meter sox spawn failure or stderr FAIL lines).
  useEffect(() => {
    const unlisten = listen<string>("recording-error", (event) => {
      handleRecordingError(event.payload);
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [handleRecordingError]);

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

  const startRecording = useCallback(
    async (config: RecordingConfig) => {
      setState((prev) => ({ ...prev, error: null }));
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
        try {
          defaultOutputDevice.current = await getCurrentOutputDevice();
          const multiOutputDevice = await findMultiOutputDeviceWithBlackHole();
          if (!multiOutputDevice) {
            throw new Error(
              "Kein Multi-Output-Gerät mit BlackHole gefunden.\n\n" +
                "Bitte erstellen Sie in der Audio-MIDI-Konfiguration ein Multi-Output-Gerät " +
                "das BlackHole als Untergerät enthält.",
            );
          }
          await brewExec("SwitchAudioSource", [
            "-s",
            multiOutputDevice,
            "-t",
            "output",
          ]);
          await new Promise((r) => setTimeout(r, 2000));
        } catch (err) {
          setState((prev) => ({
            ...prev,
            error: `System-Audio konnte nicht aktiviert werden: ${err}`,
          }));
          return;
        }
      }

      try {
        let cmd: Command;
        if (
          config.audioSource === "mikrofon" ||
          config.audioSource === "beides"
        ) {
          // Force macOS to stabilise at 48000 Hz before recording starts
          const warmupCtx = new AudioContext({ sampleRate: 48000 });
          await navigator.mediaDevices
            .getUserMedia({
              audio: { sampleRate: 48000 },
              video: false,
            })
            .then((s) => {
              s.getTracks().forEach((t) => t.stop());
            })
            .catch(() => {});
          await new Promise((r) => setTimeout(r, 800));
          warmupCtx.close();

          // rec vom Standard-Mikrofon
          cmd = brewCommand("rec", ["-r", "48000", "-c", "1", filepath]);
        } else {
          // sox von BlackHole
          cmd = brewCommand("sox", [
            "-t",
            "coreaudio",
            "BlackHole 2ch",
            filepath,
          ]);
        }

        // Capture stderr and watch for unexpected process exit.
        // The close handler only fires handleRecordingError if currentConfig is
        // still set (i.e. we haven't already started an intentional stop).
        let stderrBuf = "";
        cmd.stderr.on("data", (line: string) => {
          stderrBuf += line + "\n";
        });
        cmd.on("close", ({ code }: { code: number | null }) => {
          if (code !== null && code !== 0 && currentConfig.current !== null) {
            void handleRecordingError(
              stderrBuf.trim() || `Aufnahme unerwartet beendet (Code ${code})`,
            );
          }
        });

        const child = await cmd.spawn();
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
          error: null,
        });
      } catch (err) {
        console.error("rec start error:", err);
        setState((prev) => ({
          ...prev,
          error: `Aufnahme konnte nicht gestartet werden: ${err}`,
        }));
      }
    },
    [handleRecordingError],
  );

  const stopRecording = useCallback(async () => {
    setState((prev) => ({ ...prev, status: "stopping" }));

    const cfg = currentConfig.current;
    const filePath = currentFilePath.current;

    // Clear refs BEFORE sending pkill so the recording-process close event
    // doesn't treat the intentional SIGINT as an unexpected failure.
    currentConfig.current = null;
    currentFilePath.current = null;

    // Nur zurückschalten wenn System Audio verwendet wurde
    if (cfg?.audioSource === "system" || cfg?.audioSource === "beides") {
      const restoreDevice = defaultOutputDevice.current;
      defaultOutputDevice.current = "";
      if (restoreDevice) {
        await brewExec("SwitchAudioSource", [
          "-s",
          restoreDevice,
          "-t",
          "output",
        ]);
      }
    }

    // Prozess sauber beenden
    try {
      await new Command("pkill", ["-INT", "-x", "rec"]).execute();
    } catch (_) {}
    try {
      await new Command("pkill", ["-INT", "-x", "sox"]).execute();
    } catch (_) {}

    await new Promise((r) => setTimeout(r, 1500));

    if (
      cfg?.uploadMode === "cloud" &&
      filePath &&
      cfg.webhookUrl &&
      cfg.email
    ) {
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
          headers: { "X-API-Key": cfg.apiKey ?? "" },
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
    clearError,
  };
}
