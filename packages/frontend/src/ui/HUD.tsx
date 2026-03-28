import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  left: 16,
  padding: '12px 16px',
  background: 'rgba(0, 0, 0, 0.6)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  fontFamily: 'monospace',
  fontSize: '12px',
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
};

function formatUTC(date: Date): string {
  return date.toISOString().slice(11, 19) + ' UTC';
}

function formatFreshness(timestamp: number | null): string {
  if (timestamp === null) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Data: just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Data: ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Data: ${hours} hr ago`;
}

export function HUD() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const objectCount = useStore((s) => s.objectCount);
  const dataTimestamp = useStore((s) => s.dataTimestamp);
  const [utc, setUtc] = useState(() => formatUTC(new Date()));
  const [freshness, setFreshness] = useState(() => formatFreshness(dataTimestamp));

  useEffect(() => {
    const id = setInterval(() => setUtc(formatUTC(new Date())), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setFreshness(formatFreshness(dataTimestamp));
    if (dataTimestamp === null) return;
    const id = setInterval(() => setFreshness(formatFreshness(dataTimestamp)), 60_000);
    return () => clearInterval(id);
  }, [dataTimestamp]);

  if (loadingPhase !== 'ready') return null;

  return (
    <div style={panelStyle}>
      <span>{utc}</span>
      <span>Tracking {objectCount.toLocaleString()} objects</span>
      {freshness && <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: '11px' }}>{freshness}</span>}
      <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '10px', marginTop: '4px', pointerEvents: 'auto' }}>
        Data provided by{' '}
        <a
          href="https://www.space-track.org"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'underline' }}
        >
          Space-Track.org
        </a>
      </span>
      <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: '10px', marginTop: '2px', pointerEvents: 'auto' }}>
        Data courtesy of{' '}
        <a
          href="https://celestrak.org"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: 'inherit', textDecoration: 'underline' }}
        >
          CelesTrak
        </a>
      </span>
    </div>
  );
}
