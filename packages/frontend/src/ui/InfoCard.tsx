import { useStore } from '../store/useStore';
import type { ObjectCategory } from '../data/types';

const CATEGORY_LABELS: Record<ObjectCategory, string> = {
  active_satellite: 'Active Satellite',
  inactive_satellite: 'Inactive Satellite',
  rocket_body: 'Rocket Body',
  debris: 'Debris',
  unknown: 'Unknown',
};

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  right: 16,
  width: 280,
  padding: '14px 16px',
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  fontFamily: 'monospace',
  fontSize: '12px',
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'auto',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '3px 0',
};

const labelStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.45)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: 10,
  paddingBottom: 8,
  borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
};

const closeStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'rgba(255, 255, 255, 0.5)',
  cursor: 'pointer',
  fontSize: '16px',
  padding: '0 0 0 8px',
  lineHeight: 1,
};

function Row({ label, value }: { label: string; value: string | number | null }) {
  if (value === null || value === '') return null;
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

export function InfoCard() {
  const selectedSatellite = useStore((s) => s.selectedSatellite);
  const selectedAltitude = useStore((s) => s.selectedAltitude);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const setSelectedSatellite = useStore((s) => s.setSelectedSatellite);
  const showOrbitTrail = useStore((s) => s.showOrbitTrail);
  const setShowOrbitTrail = useStore((s) => s.setShowOrbitTrail);
  const triggerFlyTo = useStore((s) => s.triggerFlyTo);
  const cameraMode = useStore((s) => s.cameraMode);
  const setCameraMode = useStore((s) => s.setCameraMode);

  if (!selectedSatellite) return null;

  const s = selectedSatellite;

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff', marginBottom: 2 }}>
            {s.name}
          </div>
          <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
            NORAD {s.noradId}
          </div>
        </div>
        <button
          style={closeStyle}
          onClick={() => setSelectedSatellite(null, null)}
          title="Close"
        >
          ×
        </button>
      </div>

      <Row label="Status" value={CATEGORY_LABELS[s.category]} />
      <Row label="Type" value={s.objectType} />
      <Row label="Regime" value={s.regime} />
      <Row label="Altitude" value={selectedAltitude !== null ? `${selectedAltitude.toLocaleString()} km` : null} />
      <Row label="Period" value={`${s.period.toFixed(1)} min`} />
      <Row label="Inclination" value={`${s.inclination.toFixed(1)}°`} />
      <Row label="Apogee" value={`${Math.round(s.apogee).toLocaleString()} km`} />
      <Row label="Perigee" value={`${Math.round(s.perigee).toLocaleString()} km`} />
      <Row label="Country" value={s.countryCode} />
      <Row label="Launch" value={s.launchDate} />
      <Row label="Epoch" value={s.epoch?.slice(0, 10) ?? null} />

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          onClick={() => {
            if (cameraMode === 'flying' || cameraMode === 'following') {
              setCameraMode('returning');
            } else if (cameraMode === 'returning') {
              setCameraMode('free');
            } else {
              triggerFlyTo?.(selectedIndex!);
            }
          }}
          style={{
            flex: 1,
            padding: '6px 0',
            background: cameraMode !== 'free' ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${cameraMode !== 'free' ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
            borderRadius: 4,
            color: cameraMode !== 'free' ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
            fontFamily: 'monospace',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {cameraMode === 'following' ? 'Unfollow' : cameraMode === 'flying' ? 'Cancel' : cameraMode === 'returning' ? 'Stop' : 'Go to'}
        </button>
        <button
          onClick={() => setShowOrbitTrail(!showOrbitTrail)}
          style={{
            flex: 1,
            padding: '6px 0',
            background: showOrbitTrail ? 'rgba(0, 229, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${showOrbitTrail ? 'rgba(0, 229, 255, 0.4)' : 'rgba(255, 255, 255, 0.12)'}`,
            borderRadius: 4,
            color: showOrbitTrail ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
            fontFamily: 'monospace',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {showOrbitTrail ? 'Hide orbit' : 'Show orbit'}
        </button>
      </div>
    </div>
  );
}
