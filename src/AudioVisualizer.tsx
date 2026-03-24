import { useEffect, useRef } from "react";
import { AudioSource } from "./useRecorder";

interface Props {
  audioSource?: AudioSource;
}

const BAR_COUNT = 7;
const BAR_W = 3;
const RED = "#DB4035";
// Phase offsets mirror the CSS animation delays (0, 0.1, 0.2, 0.3, 0.2, 0.1, 0s)
// converted to radians over a 1.2s cycle: delay/1.2 * 2π
const PHASE_OFFSETS = [0, 0.52, 1.05, 1.57, 1.05, 0.52, 0].map(
  (d) => (d / 1.2) * Math.PI * 2,
);
// Max bar heights matching IconWave proportions, scaled to fit canvas H=24
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

    let animId = 0;
    let audioCtx: AudioContext | null = null;
    let stream: MediaStream | null = null;
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
          const phase = t + PHASE_OFFSETS[i];
          const scale = 0.4 + 0.6 * (Math.sin(phase) * 0.5 + 0.5);
          return maxH * scale;
        });
        drawBars(heights);
      }
      tick();
    }

    async function init() {
      try {
        // Need permission first so enumerateDevices returns labels
        const defaultStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });

        if (cancelled) {
          defaultStream.getTracks().forEach((t) => t.stop());
          return;
        }

        let chosenStream = defaultStream;

        if (audioSource === "system") {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const blackhole = devices.find(
              (d) =>
                d.kind === "audioinput" && d.label.includes("BlackHole"),
            );
            if (blackhole) {
              const bhStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: blackhole.deviceId } },
                video: false,
              });
              defaultStream.getTracks().forEach((t) => t.stop());
              chosenStream = bhStream;
            }
          } catch {
            // Use default stream as fallback
          }
        }

        if (cancelled) {
          chosenStream.getTracks().forEach((t) => t.stop());
          return;
        }

        stream = chosenStream;
        audioCtx = new AudioContext();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128; // 64 frequency bins
        analyser.smoothingTimeConstant = 0.75;
        audioCtx.createMediaStreamSource(stream).connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        // Sample 7 bins from the lower-mid spectrum (voice/instrument range)
        const binIndices = [1, 3, 6, 10, 14, 18, 22];

        function draw() {
          if (cancelled) return;
          animId = requestAnimationFrame(draw);
          analyser.getByteFrequencyData(data);

          const heights = binIndices.map((idx) => {
            const v = data[idx] / 255;
            // Apply sqrt to amplify quiet signals; min 15% height
            return Math.max(H * 0.15, Math.sqrt(v) * H);
          });
          drawBars(heights);
        }
        draw();
      } catch {
        // getUserMedia failed (permission denied, no device, etc.) — animate statically
        startStaticAnimation();
      }
    }

    init();

    return () => {
      cancelled = true;
      cancelAnimationFrame(animId);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
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
