import { useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';

// ============================================================
// Time controller — a live/review scrubber (replaces the old fast-forward bar).
//
// The system is always live: the wall clock keeps ticking (right edge), the
// backend keeps feeding. This bar lets you "rewind the tape" — scrub the VIEW
// clock into the past (the Engine reseeds the catalog to that UTC day's epoch-
// correct elements) — while a single ● LIVE click snaps back to now.
//
// Scrub granularity is per-UTC-day: that matches the historical catalog (one
// snapshot per day) and keeps onChange sparse. Within a day, play/speed animates
// the view forward; the displayed time is continuous so the live thumb tracks now.
//
// Graceful: when history is unavailable (backend without DATABASE_URL →
// historyStatus !== 'available'), the bar is today-only — play/pause/speed + LIVE,
// i.e. effectively the prior behavior, with no deep past to scrub into.
// ============================================================

const SPEED_OPTIONS = [1, 2, 5, 10] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
// A little room right of "now" so the thumb can sit ahead and you can scrub/play
// slightly into the (predicted) future using current elements.
const FUTURE_HEADROOM_MS = DAY_MS;

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '8px 14px',
  width: 'min(92vw, 720px)',
  boxSizing: 'border-box',
  background: 'rgba(0, 0, 0, 0.6)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 10,
  fontFamily: 'monospace',
  fontSize: '11px',
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'auto',
  userSelect: 'none',
};

const btnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 4,
  color: 'rgba(255, 255, 255, 0.85)',
  fontFamily: 'monospace',
  fontSize: '11px',
  padding: '2px 6px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: 'rgba(255, 255, 255, 0.15)',
  borderColor: 'rgba(255, 255, 255, 0.5)',
};

const liveBtnStyle: React.CSSProperties = {
  ...btnStyle,
  color: 'rgba(255, 255, 255, 0.55)',
};

const liveActiveBtnStyle: React.CSSProperties = {
  ...btnStyle,
  color: '#fff',
  background: 'rgba(76, 175, 80, 0.25)',
  borderColor: 'rgba(76, 175, 80, 0.8)',
};

const sliderStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 120,
  cursor: 'pointer',
  accentColor: '#4caf50',
};

const timeStyle: React.CSSProperties = {
  whiteSpace: 'nowrap',
  minWidth: 168,
  textAlign: 'right',
  color: 'rgba(255, 255, 255, 0.7)',
};

function formatSimTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}

/** Midnight UTC of the day containing `ms`. */
function startOfUtcDayMs(ms: number): number {
  return Date.parse(new Date(ms).toISOString().slice(0, 10) + 'T00:00:00.000Z');
}

export function TimeController() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const simRate = useStore((s) => s.simRate);
  const simTimeMs = useStore((s) => s.simTimeMs);
  const wallClockMs = useStore((s) => s.wallClockMs);
  const viewMode = useStore((s) => s.viewMode);
  const historyStatus = useStore((s) => s.historyStatus);
  const historyCoverage = useStore((s) => s.historyCoverage);
  const historyLoading = useStore((s) => s.historyLoading);
  const setSimRate = useStore((s) => s.setSimRate);
  const reviewAt = useStore((s) => s.reviewAt);
  const goLive = useStore((s) => s.goLive);

  // Remember the last non-zero speed so play resumes at the chosen rate.
  const lastRateRef = useRef(1);
  useEffect(() => {
    if (simRate !== 0) lastRateRef.current = simRate;
  }, [simRate]);

  if (loadingPhase !== 'ready') return null;

  const isLive = viewMode === 'live';
  const isPaused = simRate === 0;

  const now = wallClockMs || Date.now();
  // Left bound = earliest covered day (else today-only when history is off).
  const minMs =
    historyStatus === 'available' && historyCoverage?.from
      ? Date.parse(historyCoverage.from + 'T00:00:00.000Z')
      : startOfUtcDayMs(now);
  const maxMs = now + FUTURE_HEADROOM_MS;
  // Continuous value so the thumb tracks "now" smoothly when live; drag snaps to days.
  const valueMs = Math.min(Math.max(simTimeMs, minMs), maxMs);

  const togglePlay = () => setSimRate(isPaused ? lastRateRef.current : 0);

  return (
    <div style={containerStyle}>
      <button
        style={isLive ? liveActiveBtnStyle : liveBtnStyle}
        onClick={goLive}
        title="Jump to live"
      >
        {'●'} LIVE
      </button>

      <button style={btnStyle} onClick={togglePlay} title={isPaused ? 'Play' : 'Pause'}>
        {isPaused ? '▶' : '⏸'}
      </button>

      <input
        type="range"
        min={minMs}
        max={maxMs}
        step={DAY_MS}
        value={valueMs}
        // Grabbing the timeline pauses playback so the thumb stays where you drop it.
        onPointerDown={() => {
          if (simRate !== 0) setSimRate(0);
        }}
        onChange={(e) => reviewAt(new Date(Number(e.target.value)))}
        style={sliderStyle}
        aria-label="Scrub simulation time"
      />

      {SPEED_OPTIONS.map((r) => (
        <button
          key={r}
          style={!isPaused && simRate === r ? activeBtnStyle : btnStyle}
          onClick={() => setSimRate(r)}
          title={`${r}× speed`}
        >
          {r}x
        </button>
      ))}

      <span style={timeStyle}>
        {historyLoading ? 'loading day…' : formatSimTime(valueMs)}
      </span>
    </div>
  );
}
