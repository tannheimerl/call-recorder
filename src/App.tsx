import { useRef, useState } from "react";
import { Command } from "@tauri-apps/api/shell";
import {
  useRecorder,
  AudioSource,
  RecordingConfig,
  UploadMode,
} from "./useRecorder";
import "./App.css";

// ─── Icons ───────────────────────────────────────────────────────────────────
const IconMic = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

const IconMonitor = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

// const IconBoth = () => (
//   <svg
//     width="18"
//     height="18"
//     viewBox="0 0 24 24"
//     fill="none"
//     stroke="currentColor"
//     strokeWidth="2"
//     strokeLinecap="round"
//     strokeLinejoin="round"
//   >
//     <path d="M9 18V5l12-2v13" />
//     <circle cx="6" cy="18" r="3" />
//     <circle cx="18" cy="16" r="3" />
//   </svg>
// );

const IconFolder = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

const IconStop = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </svg>
);

const IconRecord = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="12" r="8" />
  </svg>
);

const IconLogo = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
    <rect width="28" height="28" rx="8" fill="#DB4035" />
    <path
      d="M14 6a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V9a3 3 0 0 0-3-3Z"
      fill="white"
    />
    <path
      d="M9 13v1a5 5 0 0 0 10 0v-1"
      stroke="white"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
    <line
      x1="14"
      y1="19"
      x2="14"
      y2="22"
      stroke="white"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
    <line
      x1="11"
      y1="22"
      x2="17"
      y2="22"
      stroke="white"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

const IconWave = () => (
  <svg width="32" height="20" viewBox="0 0 32 20" fill="none">
    <rect
      x="0"
      y="6"
      width="3"
      height="8"
      rx="1.5"
      fill="currentColor"
      className="wave-bar bar1"
    />
    <rect
      x="5"
      y="2"
      width="3"
      height="16"
      rx="1.5"
      fill="currentColor"
      className="wave-bar bar2"
    />
    <rect
      x="10"
      y="4"
      width="3"
      height="12"
      rx="1.5"
      fill="currentColor"
      className="wave-bar bar3"
    />
    <rect
      x="15"
      y="0"
      width="3"
      height="20"
      rx="1.5"
      fill="currentColor"
      className="wave-bar bar4"
    />
    <rect
      x="20"
      y="4"
      width="3"
      height="12"
      rx="1.5"
      fill="currentColor"
      className="wave-bar bar5"
    />
    <rect
      x="25"
      y="2"
      width="3"
      height="16"
      rx="1.5"
      fill="currentColor"
      className="wave-bar bar6"
    />
    <rect
      x="30"
      y="6"
      width="3"
      height="8"
      rx="1.5"
      fill="currentColor"
      className="wave-bar bar7"
    />
  </svg>
);

// ─── Setup View ──────────────────────────────────────────────────────────────
function SetupView({
  onStart,
}: {
  onStart: (config: RecordingConfig) => void;
}) {
  const [audioSource, setAudioSource] = useState<AudioSource>("system");
  const [saveFolder, setSaveFolder] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadMode>(
    () => (localStorage.getItem("uploadMode") as UploadMode) || "local",
  );
  const [webhookUrl, setWebhookUrl] = useState(
    () => localStorage.getItem("webhookUrl") || "",
  );
  const [email, setEmail] = useState(() => localStorage.getItem("email") || "");
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem("apiKey") || "",
  );

  const handleChooseFolder = async () => {
    const { open: openDialog } = await import("@tauri-apps/api/dialog");
    const selected = await openDialog({
      directory: true,
      title: "Speicherort wählen",
    });
    if (selected) setSaveFolder(selected as string);
  };

  const handleModeChange = (mode: UploadMode) => {
    setUploadMode(mode);
    localStorage.setItem("uploadMode", mode);
  };

  const handleWebhookChange = (v: string) => {
    setWebhookUrl(v);
    localStorage.setItem("webhookUrl", v);
  };

  const handleEmailChange = (v: string) => {
    setEmail(v);
    localStorage.setItem("email", v);
  };

  const handleApiKeyChange = (v: string) => {
    setApiKey(v);
    localStorage.setItem("apiKey", v);
  };

  const canStart =
    !starting &&
    (uploadMode === "local"
      ? !!saveFolder
      : !!webhookUrl && !!email && !!apiKey);

  const handleStart = () => {
    if (!canStart) return;
    setStarting(true);
    onStart({
      meetingType: "Aufzeichnung",
      audioSource,
      saveFolder,
      attachments: [],
      uploadMode,
      webhookUrl: uploadMode === "cloud" ? webhookUrl : undefined,
      email: uploadMode === "cloud" ? email : undefined,
      apiKey: uploadMode === "cloud" ? apiKey : undefined,
    });
  };

  const audioSources: {
    value: AudioSource;
    label: string;
    sub: string;
    icon: JSX.Element;
  }[] = [
    {
      value: "mikrofon",
      label: "Mikrofon",
      sub: "Nur deine Stimme",
      icon: <IconMic />,
    },
    {
      value: "system",
      label: "System Audio",
      sub: "Alle Teilnehmer via BlackHole",
      icon: <IconMonitor />,
    },
    // {
    //   value: "beides",
    //   label: "Beides",
    //   sub: "Mic + System Audio gemischt",
    //   icon: <IconBoth />,
    // },
  ];

  return (
    <div className="view setup-view">
      <header className="app-header">
        <div className="logo">
          <IconLogo />
          <span className="logo-text">Noto</span>
        </div>
      </header>

      <div className="content">
        {/* Audio Source */}
        <section className="section">
          <label className="section-label">Audioquelle</label>
          <div className="card-group">
            {audioSources.map((s) => (
              <button
                key={s.value}
                className={`audio-card ${audioSource === s.value ? "active" : ""}`}
                onClick={() => setAudioSource(s.value)}
              >
                <div className="audio-card-icon">{s.icon}</div>
                <div className="audio-card-text">
                  <span className="audio-card-label">{s.label}</span>
                  <span className="audio-card-sub">{s.sub}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {/* Upload Mode Toggle */}
        <section className="section">
          <label className="section-label">Speichermodus</label>
          <div className="mode-toggle">
            <button
              className={`mode-btn ${uploadMode === "local" ? "active" : ""}`}
              onClick={() => handleModeChange("local")}
            >
              Lokal
            </button>
            <button
              className={`mode-btn ${uploadMode === "cloud" ? "active" : ""}`}
              onClick={() => handleModeChange("cloud")}
            >
              Cloud
            </button>
          </div>
        </section>

        {/* Local: Save Folder */}
        {uploadMode === "local" && (
          <section className="section">
            <label className="section-label">Speicherort</label>
            <button className="folder-btn" onClick={handleChooseFolder}>
              <IconFolder />
              <span className="folder-path">
                {saveFolder
                  ? saveFolder.split("/").slice(-2).join("/")
                  : "Ordner wählen…"}
              </span>
            </button>
          </section>
        )}

        {/* Cloud: Settings */}
        {uploadMode === "cloud" && (
          <section className="section">
            <label className="section-label">Cloud-Einstellungen</label>
            <input
              className="text-input"
              type="url"
              placeholder="Webhook URL (z.B. https://server/webhook/audio)"
              value={webhookUrl}
              onChange={(e) => handleWebhookChange(e.target.value)}
            />
            <input
              className="text-input"
              type="password"
              placeholder="API Key"
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
            />
            <input
              className="text-input"
              type="email"
              placeholder="E-Mail für Zusammenfassung"
              value={email}
              onChange={(e) => handleEmailChange(e.target.value)}
            />
          </section>
        )}
      </div>

      <footer className="app-footer">
        <button
          className={`start-btn ${!canStart ? "disabled" : ""}`}
          onClick={handleStart}
          disabled={!canStart}
        >
          {starting ? (
            <>
              <span className="btn-spinner" /> Starte…
            </>
          ) : (
            <>
              <IconRecord /> Aufnahme starten
            </>
          )}
        </button>
      </footer>
    </div>
  );
}

// ─── Volume Slider ────────────────────────────────────────────────────────────
function VolumeSlider() {
  const [volume, setVolume] = useState(20);
  const [isMuted, setIsMuted] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setSystemVolume = async (value: number, muted: boolean) => {
    try {
      await new Command("osascript", [
        "-e",
        `set volume output volume ${value}`,
      ]).execute();
      await new Command("osascript", [
        "-e",
        `set volume output muted ${muted ? "true" : "false"}`,
      ]).execute();
    } catch {}
  };

  const handleChange = (value: number) => {
    setVolume(value);
    const muted = value === 0;
    setIsMuted(muted);

    // Debounce: warte 150ms bis User aufgehört hat zu scrollen
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSystemVolume(value, muted);
    }, 150);
  };

  const toggleMute = async () => {
    const next = !isMuted;
    setIsMuted(next);
    setVolume(next ? 0 : 20);
    await setSystemVolume(next ? 0 : volume, next);
  };

  return (
    <div className="volume-slider-row">
      <button
        className={`mute-btn${isMuted ? " mute-btn--active" : ""}`}
        onClick={toggleMute}
        title={isMuted ? "Unmute" : "Mute"}
      >
        {isMuted ? "🔇" : "🔊"}
      </button>
      <input
        type="range"
        min={0}
        max={100}
        value={volume}
        className={`volume-slider${isMuted ? " volume-slider--muted" : ""}`}
        onChange={(e) => handleChange(Number(e.target.value))}
      />
      <span className="volume-value">{volume}%</span>
    </div>
  );
}

// ─── Recording View ──────────────────────────────────────────────────────────
function RecordingView({
  duration,
  fileSize,
  filePath,
  config,
  onStop,
  formatDuration,
  formatFileSize,
}: {
  duration: number;
  fileSize: number;
  filePath: string | null;
  config: RecordingConfig | null;
  onStop: () => void;
  formatDuration: (s: number) => string;
  formatFileSize: (b: number) => string;
}) {
  return (
    <div className="view recording-view">
      <header className="app-header">
        <div className="logo">
          <IconLogo />
          <span className="logo-text">Noto</span>
        </div>
      </header>

      <div className="content recording-content">
        <div className="waveform-container">
          <div className="waveform-icon">
            <IconWave />
          </div>
        </div>

        <div className="timer">{formatDuration(duration)}</div>

        <div className="recording-meta">
          {
            // TODO: Meeting Type anzeigen sobald es mehr als "Aufzeichnung" gibt
          }
          {/* <div className="meta-item">
            <span className="meta-label">Typ</span>
            <span className="meta-value">{config?.meetingType}</span>
          </div> */}
          <div className="meta-divider" />
          <div className="meta-item">
            <span className="meta-label">Audio</span>
            <span className="meta-value">
              {config?.audioSource === "mikrofon"
                ? "Mikrofon"
                : config?.audioSource === "system"
                  ? "System"
                  : "Beides"}
            </span>
          </div>
          <div className="meta-divider" />
          <div className="meta-item">
            <span className="meta-label">Grösse</span>
            <span className="meta-value">{formatFileSize(fileSize)}</span>
          </div>
        </div>

        <VolumeSlider />

        {filePath && (
          <div className="filepath">
            <span className="filepath-label">Speichert in</span>
            <span className="filepath-value">
              {filePath.split("/").slice(-2).join("/")}
            </span>
          </div>
        )}

        {config?.attachments && config.attachments.length > 0 && (
          <div className="attachments-badge">
            📎 {config.attachments.length} Unterlage
            {config.attachments.length > 1 ? "n" : ""} verknüpft
          </div>
        )}
      </div>

      <footer className="app-footer">
        <button className="stop-btn" onClick={onStop}>
          <IconStop />
          Aufnahme stoppen
        </button>
        {/* <p className="hint">
          Das Fenster kann geschlossen werden — die Aufnahme läuft weiter.
        </p> */}
      </footer>
    </div>
  );
}

// ─── Stopping View ───────────────────────────────────────────────────────────
function StoppingView({ uploadMessage }: { uploadMessage?: string }) {
  return (
    <div className="view stopping-view">
      <div className="stopping-content">
        <div className="spinner" />
        {uploadMessage ? (
          <p>{uploadMessage}</p>
        ) : (
          <>
            <p>Aufnahme wird gespeichert…</p>
            <p className="hint">Syncthing überträgt die Datei automatisch.</p>
          </>
        )}
      </div>
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const {
    state,
    startRecording,
    stopRecording,
    formatDuration,
    formatFileSize,
  } = useRecorder();

  if (state.status === "stopping") return <StoppingView />;
  if (state.status === "uploading")
    return <StoppingView uploadMessage={state.uploadMessage} />;

  if (state.status === "recording") {
    return (
      <RecordingView
        duration={state.duration}
        fileSize={state.fileSize}
        filePath={state.filePath}
        config={state.config}
        onStop={stopRecording}
        formatDuration={formatDuration}
        formatFileSize={formatFileSize}
      />
    );
  }

  return <SetupView onStart={startRecording} />;
}
