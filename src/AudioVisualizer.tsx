import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { AudioSource } from "./useRecorder";

interface Props {
  audioSource?: AudioSource;
}

const BAR_COUNT = 7;
const BAR_W = 3;
const RED = "#DB4035";
// Phase offsets mirror the CSS animation delays, converted to radians
const PHASE_OFFSETS = [0, 0.52, 1.05, 1.57, 1.05, 0.52, 0].map(
  (d) => (d / 1.2) * Math.PI * 2,
);
// Max bar heights matching IconWave proportions, scaled to canvas H=24
const MAX_HEIGHTS = [9.6, 19.2, 14.4, 24, 14.4, 19.2, 9.6];

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const safeR = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeR, y);
  ctx.lineTo(x + w - safeR, y);
  ctx.arcTo(x + w, y, x + w, y + safeR, safeR);
  ctx.lineTo(x + w, y + h - safeR);
  ctx.arcTo(x + w, y + h, x + w - safeR, y + h, safeR);
  ctx.lineTo(x + safeR, y + h);
  ctx.arcTo(x, y + h, x, y + h - safeR, safeR);
  ctx.lineTo(x, y + safeR);
  ctx.arcTo(x, y, x + safeR, y, safeR);
  ctx.closePath();
  ctx.fill();
}

export function AudioVisualizer({ audioSource }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width; // 40
    const H = canvas.height; // 24
    const gap = (W - BAR_COUNT * BAR_W) / (BAR_COUNT + 1);
    const minH = H * 0.15;

    let animId = 0;
    let cancelled = false;

    function drawBars(heights: number[]) {
      ctx!.clearRect(0, 0, W, H);
      ctx!.fillStyle = RED;
      for (let i = 0; i < BAR_COUNT; i++) {
        const barH = Math.max(2, heights[i]);
        const x = gap + i * (BAR_W + gap);
        const y = (H - barH) / 2;
        drawRoundRect(ctx!, x, y, BAR_W, barH, BAR_W / 2);
      }
    }

    // Fallback: replicate the CSS wave animation on canvas
    function startStaticAnimation() {
      const startTime = performance.now();
      function tick() {
        if (cancelled) return;
        animId = requestAnimationFrame(tick);
        const t = ((performance.now() - startTime) / 1200) * Math.PI * 2;
        const heights = MAX_HEIGHTS.map((maxH, i) => {
          const scale =
            0.4 + 0.6 * (Math.sin(t + PHASE_OFFSETS[i]) * 0.5 + 0.5);
          return maxH * scale;
        });
        drawBars(heights);
      }
      tick();
    }

    // ── System audio: driven by Tauri "volume-level" events from sox ──────────
    async function initSystem() {
      let displayBands = new Array(7).fill(0);
      let targetBands = new Array(7).fill(0);
      let unlisten: (() => void) | null = null;

      try {
        unlisten = await listen<{ bands: number[] }>("volume-level", (event) => {
          targetBands = event.payload.bands;
        });

        if (cancelled) {
          unlisten();
          return;
        }

        await invoke("start_volume_meter");

        if (cancelled) {
          unlisten();
          await invoke("stop_volume_meter");
          return;
        }

        function draw() {
          if (cancelled) return;
          animId = requestAnimationFrame(draw);

          for (let i = 0; i < 7; i++) {
            const alpha = targetBands[i] > displayBands[i] ? 0.6 : 0.35;
            displayBands[i] += (targetBands[i] - displayBands[i]) * alpha;
          }
          const heights = displayBands.map((level) =>
            Math.max(minH, level * H),
          );
          drawBars(heights);
        }
        draw();
      } catch {
        unlisten?.();
        startStaticAnimation();
      }

      return () => {
        unlisten?.();
        invoke("stop_volume_meter").catch(() => {});
      };
    }

    // ── Microphone: Web Audio API via getUserMedia + AnalyserNode ─────────────
    async function initMicrophone() {
      let stream: MediaStream | null = null;
      let audioCtx: AudioContext | null = null;

      try {
        audioCtx = new AudioContext({ sampleRate: 48000 });
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.5;

        stream = await navigator.mediaDevices.getUserMedia({
          audio: { sampleRate: 48000 },
          video: false,
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        audioCtx.createMediaStreamSource(stream).connect(analyser);

        analyser.fftSize = 256; // 128 frequency bins
        analyser.smoothingTimeConstant = 0.75;
        const freqData = new Uint8Array(analyser.frequencyBinCount); // 128 bins

        // Map 7 bars to log-spaced frequency bands (covers ~80Hz to ~8kHz for voice)
        // Bins at 48000Hz / 256 = 187.5 Hz per bin
        const binRanges: [number, number][] = [
          [0, 1], // ~0–375Hz   (sub/bass)
          [1, 3], // ~375–750Hz
          [3, 6], // ~750–1.1kHz
          [5, 10], // ~1–2kHz    (voice fundamental)
          [9, 16], // ~2–3kHz
          [14, 24], // ~3–5kHz
          [22, 40], // ~5–8kHz    (presence/sibilance)
        ];

        function draw() {
          if (cancelled) return;
          animId = requestAnimationFrame(draw);

          analyser.getByteFrequencyData(freqData);

          const heights = binRanges.map(([lo, hi]) => {
            let sum = 0;
            for (let i = lo; i < hi; i++) sum += freqData[i];
            const avg = sum / (hi - lo);
            const level = Math.min(1, Math.sqrt(avg / 255) * 1);
            return Math.max(minH, level * H);
          });
          drawBars(heights);
        }
        draw();
      } catch {
        stream?.getTracks().forEach((t) => t.stop());
        audioCtx?.close();
        startStaticAnimation();
      }

      return () => {
        stream?.getTracks().forEach((t) => t.stop());
        audioCtx?.close();
      };
    }

    // Dispatch to the right path and wire up cleanup
    let cleanupFn: (() => void) | undefined;

    const initPromise =
      audioSource === "system" ? initSystem() : initMicrophone();

    initPromise.then((fn) => {
      cleanupFn = fn;
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(animId);
      cleanupFn?.();
    };
  }, [audioSource]);

  return (
    <canvas
      ref={canvasRef}
      width={40}
      height={24}
      style={{ display: "block" }}
    />
  );
}
