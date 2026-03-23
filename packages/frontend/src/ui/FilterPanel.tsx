import { useState } from 'react';
import { useStore } from '../store/useStore';
import type { ObjectCategory, OrbitalRegime } from '../data/types';

const CATEGORIES: { key: ObjectCategory; label: string; color: string }[] = [
  { key: 'active_satellite', label: 'Active Satellites', color: '#4CAF50' },
  { key: 'inactive_satellite', label: 'Inactive Satellites', color: '#9E9E9E' },
  { key: 'rocket_body', label: 'Rocket Bodies', color: '#FFC107' },
  { key: 'debris', label: 'Debris', color: '#F44336' },
  { key: 'unknown', label: 'Unknown', color: '#757575' },
];

const REGIMES: { key: OrbitalRegime; label: string }[] = [
  { key: 'LEO', label: 'LEO' },
  { key: 'MEO', label: 'MEO' },
  { key: 'GEO', label: 'GEO' },
  { key: 'HEO', label: 'HEO' },
  { key: 'OTHER', label: 'Other' },
];

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      style={{
        width: 32,
        height: 16,
        borderRadius: 8,
        border: 'none',
        padding: 0,
        cursor: 'pointer',
        background: on ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.08)',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 0.15s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: on ? '#fff' : 'rgba(255, 255, 255, 0.35)',
          transition: 'left 0.15s, background 0.15s',
        }}
      />
    </button>
  );
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  left: 16,
  width: 260,
  padding: '14px 16px',
  background: 'rgba(0, 0, 0, 0.7)',
  backdropFilter: 'blur(4px)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 8,
  fontFamily: 'monospace',
  fontSize: 12,
  color: 'rgba(255, 255, 255, 0.85)',
  pointerEvents: 'auto' as const,
  transition: 'transform 0.25s ease, opacity 0.25s ease',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'rgba(255, 255, 255, 0.35)',
  marginBottom: 8,
};

const countStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'rgba(255, 255, 255, 0.4)',
  marginLeft: 'auto',
  flexShrink: 0,
  paddingLeft: 8,
};

export function FilterPanel() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const categoryFilters = useStore((s) => s.categoryFilters);
  const regimeFilters = useStore((s) => s.regimeFilters);
  const categoryCounts = useStore((s) => s.categoryCounts);
  const regimeCounts = useStore((s) => s.regimeCounts);
  const visibleCatCounts = useStore((s) => s.visibleCategoryCounts);
  const visibleRegCounts = useStore((s) => s.visibleRegimeCounts);
  const toggleCategory = useStore((s) => s.toggleCategoryFilter);
  const toggleRegime = useStore((s) => s.toggleRegimeFilter);
  const [open, setOpen] = useState(true);

  if (loadingPhase !== 'ready') return null;

  return (
    <>
      {/* Collapsed toggle button */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            position: 'absolute',
            bottom: 16,
            left: 16,
            width: 36,
            height: 36,
            borderRadius: 8,
            border: '1px solid rgba(255, 255, 255, 0.1)',
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)',
            color: 'rgba(255, 255, 255, 0.7)',
            cursor: 'pointer',
            fontFamily: 'monospace',
            fontSize: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'auto',
          }}
          title="Show filters"
        >
          &#9776;
        </button>
      )}

      {/* Main panel */}
      <div
        style={{
          ...panelStyle,
          transform: open ? 'translateX(0)' : 'translateX(-120%)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {/* Close button */}
        <button
          onClick={() => setOpen(false)}
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'none',
            border: 'none',
            color: 'rgba(255, 255, 255, 0.4)',
            cursor: 'pointer',
            fontFamily: 'monospace',
            fontSize: 14,
            padding: '2px 6px',
          }}
        >
          &times;
        </button>

        {/* Object Type section */}
        <div style={sectionHeaderStyle}>Object Type</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {CATEGORIES.map(({ key, label, color }) => {
            const on = categoryFilters[key];
            return (
              <div
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  opacity: on ? 1 : 0.4,
                  transition: 'opacity 0.15s',
                }}
              >
                <Toggle on={on} onToggle={() => toggleCategory(key)} />
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: color,
                    flexShrink: 0,
                  }}
                />
                <span>{label}</span>
                <span style={countStyle}>
                  {visibleCatCounts[key].toLocaleString()}
                  {' / '}
                  {categoryCounts[key].toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>

        {/* Separator */}
        <div
          style={{
            height: 1,
            background: 'rgba(255, 255, 255, 0.08)',
            margin: '12px 0',
          }}
        />

        {/* Orbital Regime section */}
        <div style={sectionHeaderStyle}>Orbital Regime</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {REGIMES.map(({ key, label }) => {
            const on = regimeFilters[key];
            return (
              <div
                key={key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  opacity: on ? 1 : 0.4,
                  transition: 'opacity 0.15s',
                }}
              >
                <Toggle on={on} onToggle={() => toggleRegime(key)} />
                <span>{label}</span>
                <span style={countStyle}>
                  {visibleRegCounts[key].toLocaleString()}
                  {' / '}
                  {regimeCounts[key].toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
