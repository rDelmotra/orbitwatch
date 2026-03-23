import { useEffect } from 'react';
import { useDevStore } from '../store/devStore';
import type { ValidationReport } from '../store/devStore';

const panelStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 16,
  left: 16,
  padding: '10px 14px',
  background: 'rgba(0, 0, 0, 0.75)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.15)',
  borderRadius: 6,
  fontFamily: 'monospace',
  fontSize: '11px',
  lineHeight: '16px',
  color: 'rgba(255, 255, 255, 0.9)',
  pointerEvents: 'none',
  zIndex: 9999,
  minWidth: 240,
  userSelect: 'none',
};

const ok = '#4CAF50';
const warn = '#FFC107';
const fail = '#F44336';

function statusColor(pass: boolean): string {
  return pass ? ok : fail;
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'rgba(255,255,255,0.6)' }}>{label}</span>
      <span style={{ color: color ?? 'rgba(255,255,255,0.9)' }}>{value}</span>
    </div>
  );
}

function Divider() {
  return <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', margin: '4px 0' }} />;
}

function ReportView({ r }: { r: ValidationReport }) {
  const failRate = r.totalLoaded > 0
    ? ((r.propagationFailures / r.totalLoaded) * 100).toFixed(1)
    : '0';

  return (
    <>
      <div style={{ color: 'rgba(255,255,255,0.4)', marginBottom: 4, fontSize: '10px', letterSpacing: '0.5px' }}>
        DEV VALIDATION
      </div>

      <Row
        label="ISS alt"
        value={r.issAltitudeKm !== null ? `${r.issAltitudeKm} km` : 'not found'}
        color={r.issAltitudeKm !== null ? statusColor(r.issAltitudeOk) : warn}
      />
      <Row
        label="GEO mag"
        value={`${r.geoAvgMagnitude} (${r.geoCount})`}
        color={statusColor(r.geoOk)}
      />
      <Row
        label="Inside Earth"
        value={String(r.insideEarthCount)}
        color={statusColor(r.insideEarthOk)}
      />

      <Divider />

      <Row label="Loaded" value={r.totalLoaded.toLocaleString()} />
      <Row label="Valid" value={r.totalValid.toLocaleString()} />
      <Row
        label="Prop fails"
        value={`${r.propagationFailures.toLocaleString()} (${failRate}%)`}
        color={r.propagationFailures > r.totalLoaded * 0.05 ? warn : undefined}
      />

      <Divider />

      <Row
        label="Worker tick"
        value={`${r.workerTickMs} ms`}
        color={r.workerTickMs > 1500 ? warn : undefined}
      />
      <Row
        label="Frame"
        value={`${r.frameTimeMs} ms`}
        color={r.frameTimeMs > 16 ? warn : undefined}
      />
      <Row
        label="FPS"
        value={String(r.fps)}
        color={r.fps < 30 ? fail : r.fps < 55 ? warn : ok}
      />
    </>
  );
}

export function DevOverlay() {
  const visible = useDevStore((s) => s.visible);
  const report = useDevStore((s) => s.report);
  const toggle = useDevStore((s) => s.toggle);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  if (!visible) return null;

  return (
    <div style={panelStyle}>
      {report ? <ReportView r={report} /> : (
        <span style={{ color: 'rgba(255,255,255,0.4)' }}>Waiting for data...</span>
      )}
    </div>
  );
}
