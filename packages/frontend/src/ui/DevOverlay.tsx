import { useEffect } from 'react';
import { useDevStore } from '../store/devStore';
import type { ValidationReport, AwarenessSnapshot } from '../store/devStore';

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

function fmtMs(ms: number): string {
  if (ms < 0) return `${Math.abs(Math.round(ms / 1000))}s ago`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m${r.toString().padStart(2, '0')}s`;
}

function WorldModelPanel({ snap }: { snap: AwarenessSnapshot }) {
  const { frustum, notables, behavior, observer, upcoming, changes } = snap;
  const delta = changes.inViewDelta;
  const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '±0';

  const regimeStr = Object.entries(frustum.byRegime)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');

  return (
    <>
      <Divider />
      <div style={{ color: 'rgba(255,255,255,0.4)', marginBottom: 4, fontSize: '10px', letterSpacing: '0.5px' }}>
        WORLD MODEL (5Hz) #{snap.snapshotId}
      </div>

      <Row label="In view" value={`${frustum.inViewCount} (${deltaStr})  ${regimeStr}`} />
      {frustum.topGroups[0] && (
        <Row label="Top group" value={`${frustum.topGroups[0].regime}/${frustum.topGroups[0].category}: ${frustum.topGroups[0].count}`} />
      )}
      <Row label="Peripheral" value={String(frustum.peripheralCount)} />

      <Divider />

      {notables.map((n) => {
        const loc = n.inFrustum ? 'in-view' : n.inPeripheral ? 'periph' : 'offscreen';
        const light = n.eclipsed ? 'eclipsed' : 'sunlit';
        return (
          <Row
            key={n.noradId}
            label={n.name.length > 14 ? n.name.slice(0, 13) + '…' : n.name}
            value={`${Math.round(n.altitudeKm)}km  ${loc}  ${light}`}
            color={n.inFrustum ? ok : n.inPeripheral ? warn : undefined}
          />
        );
      })}

      <Divider />

      <Row label="Camera" value={`${behavior.cameraMode}  stat ${behavior.stationaryDurationSec.toFixed(1)}s  ω${behavior.angularVelocityRadPerSec.toFixed(3)}`} />
      {behavior.dominantRegimeInView && (
        <Row label="Looking at" value={behavior.dominantRegimeInView} />
      )}
      {observer.active ? (
        <Row label="Observer" value={`${observer.twilightPhase}  ${observer.nakedEyeQuality} visibility`} />
      ) : (
        <Row label="Observer" value="not set" color="rgba(255,255,255,0.3)" />
      )}

      {upcoming.hasObserver && upcoming.currentPass && (
        <>
          <Divider />
          <div style={{ color: 'rgba(255,255,255,0.4)', marginBottom: 2, fontSize: '10px', letterSpacing: '0.5px' }}>
            UPCOMING (world-frame)
          </div>
          {upcoming.currentPass.status === 'computing' && (
            <Row label={upcoming.currentPass.name} value="computing…" />
          )}
          {upcoming.currentPass.status === 'upcoming' && upcoming.currentPass.timeToAosMs !== null && (
            <Row
              label={upcoming.currentPass.name}
              value={`pass in ${fmtMs(upcoming.currentPass.timeToAosMs)}  max el ${upcoming.currentPass.maxElevationDeg?.toFixed(0)}°`}
              color={ok}
            />
          )}
          {upcoming.currentPass.status === 'in_view' && (
            <Row
              label={upcoming.currentPass.name}
              value={`IN VIEW now  LOS in ${upcoming.currentPass.losTimeMs ? fmtMs(upcoming.currentPass.losTimeMs - Date.now()) : '?'}`}
              color={ok}
            />
          )}
          {upcoming.currentPass.status === 'none' && (
            <Row label={upcoming.currentPass.name} value="no pass 24h" color="rgba(255,255,255,0.3)" />
          )}
        </>
      )}

      {changes.notableTransitions.length > 0 && (
        <>
          <Divider />
          {changes.notableTransitions.slice(0, 3).map((t, i) => (
            <Row key={i} label="→" value={`${t.name} ${t.kind.replace(/_/g, ' ')}`} color={warn} />
          ))}
        </>
      )}
    </>
  );
}

export function DevOverlay() {
  const visible = useDevStore((s) => s.visible);
  const report = useDevStore((s) => s.report);
  const worldModelSnapshot = useDevStore((s) => s.worldModelSnapshot);
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
      {worldModelSnapshot && <WorldModelPanel snap={worldModelSnapshot} />}
    </div>
  );
}
