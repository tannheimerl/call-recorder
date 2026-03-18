# Call Recorder

Tauri + React Menu Bar App für macOS. Nimmt Meetings und Vorlesungen auf und speichert sie in einen Syncthing-Ordner zur automatischen n8n-Verarbeitung.

## Voraussetzungen

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js (via brew)
brew install node

# ffmpeg + BlackHole + SwitchAudioSource
brew install ffmpeg
brew install blackhole-2ch
brew install switchaudio-osx
```

## Setup

```bash
# Abhängigkeiten installieren
npm install

# Entwicklungsmodus starten
npm run tauri dev

# App bauen (für Produktion)
npm run tauri build
```

## Erste Schritte nach dem Build

1. `Call Recorder.app` in `/Applications` verschieben
2. App starten → erscheint in der Menüleiste (⚪ Icon)
3. Klick auf Icon → Fenster öffnet sich
4. Meeting-Typ und Audio-Quelle wählen
5. Speicherort = dein Syncthing-Ordner
6. Aufnahme starten

## Audio-Quellen

| Option | Beschreibung |
|--------|-------------|
| Mikrofon | Nur deine Stimme (kein BlackHole nötig) |
| System Audio | Alle Call-Teilnehmer via BlackHole |
| Beides | Mic + System Audio gemischt |

## n8n Integration

Die Aufnahmen landen automatisch via Syncthing auf dem Server.
n8n verarbeitet sie in der Nacht (Transkription + Zusammenfassung).

## Projektstruktur

```
call-recorder/
├── src/                    # React Frontend
│   ├── App.tsx             # Haupt-UI (Setup + Recording Views)
│   ├── App.css             # Styling
│   ├── useRecorder.ts      # Recording-Logik & State
│   └── main.tsx            # Entry Point
├── src-tauri/              # Rust Backend
│   ├── src/main.rs         # System Tray + Tauri Commands
│   ├── Cargo.toml          # Rust Dependencies
│   └── tauri.conf.json     # App-Konfiguration
├── package.json
└── vite.config.ts
```
