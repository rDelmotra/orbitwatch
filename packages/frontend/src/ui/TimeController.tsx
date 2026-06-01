import { useStore } from '../store/useStore';

const RATE_OPTIONS = [1, 2, 5, 10] as const;

const containerStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '6px 12px',
  background: 'rgba(0, 0, 0, 0.6)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
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
};

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: 'rgba(255, 255, 255, 0.15)',
  borderColor: 'rgba(255, 255, 255, 0.5)',
};

function formatSimTime(ms: number): string {
  const d = new Date(ms);
  return d.toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
}

export function TimeController() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const simRate = useStore((s) => s.simRate);
  const simTimeMs = useStore((s) => s.simTimeMs);
  const setSimRate = useStore((s) => s.setSimRate);
  const resetSimClock = useStore((s) => s.resetSimClock);

  if (loadingPhase !== 'ready') return null;

  const isPaused = simRate === 0;
  const isRealtime = simRate === 1;

  return (
    <div style={containerStyle}>
      <button
        style={btnStyle}
        onClick={() => setSimRate(isPaused ? 1 : 0)}
        title={isPaused ? 'Play' : 'Pause'}
      >
        {isPaused ? '\u25B6' : '\u23F8'}
      </button>

      {RATE_OPTIONS.map((r) => (
        <button
          key={r}
          style={simRate === r ? activeBtnStyle : btnStyle}
          onClick={() => setSimRate(r)}
        >
          {r}x
        </button>
      ))}

      {!isRealtime && (
        <button style={btnStyle} onClick={resetSimClock} title="Reset to real time">
          RT
        </button>
      )}

      <span style={{ marginLeft: 4, color: 'rgba(255, 255, 255, 0.5)' }}>
        {formatSimTime(simTimeMs)}
      </span>
    </div>
  );
}
