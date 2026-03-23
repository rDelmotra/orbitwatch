import { useStore } from '../store/useStore';
import type { ObjectCategory } from '../data/types';

const CATEGORIES: { key: ObjectCategory; label: string; color: string }[] = [
  { key: 'active_satellite', label: 'Active Satellites', color: '#4CAF50' },
  { key: 'inactive_satellite', label: 'Inactive Satellites', color: '#9E9E9E' },
  { key: 'rocket_body', label: 'Rocket Bodies', color: '#FFC107' },
  { key: 'debris', label: 'Debris', color: '#F44336' },
  { key: 'unknown', label: 'Unknown', color: '#757575' },
];

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
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

export function Legend() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const categoryCounts = useStore((s) => s.categoryCounts);

  if (loadingPhase !== 'ready') return null;

  return (
    <div style={panelStyle}>
      {CATEGORIES.map(({ key, label, color }) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: color,
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1 }}>{label}</span>
          <span style={{ color: 'rgba(255,255,255,0.5)', marginLeft: 12 }}>
            {categoryCounts[key].toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
