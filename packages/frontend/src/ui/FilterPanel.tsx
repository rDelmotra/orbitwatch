import { useState } from 'react';
import { useStore } from '../store/useStore';
import type { ObjectCategory, OrbitalRegime } from '../data/types';

const CATEGORIES: { key: ObjectCategory; label: string; color: string }[] = [
  { key: 'active_satellite', label: 'Active Satellites', color: '#4CAF50' },
  { key: 'inactive_satellite', label: 'Inactive Satellites', color: '#9E9E9E' },
  { key: 'rocket_body', label: 'Rocket Bodies', color: '#FFC107' },
  { key: 'debris', label: 'Debris', color: '#F44336' },
  { key: 'unknown', label: 'Unknown', color: '#757575' },
  { key: 'deep_space', label: 'Deep Space', color: '#00BCD4' },
];

const REGIMES: { key: OrbitalRegime; label: string }[] = [
  { key: 'LEO', label: 'LEO' },
  { key: 'MEO', label: 'MEO' },
  { key: 'GEO', label: 'GEO' },
  { key: 'HEO', label: 'HEO' },
  { key: 'OTHER', label: 'Other' },
];

function Toggle({
  on,
  onToggle,
  disabled = false,
}: {
  on: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-disabled={disabled}
      onClick={onToggle}
      disabled={disabled}
      style={{
        width: 32,
        height: 16,
        borderRadius: 8,
        border: 'none',
        padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: on ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.08)',
        position: 'relative',
        flexShrink: 0,
        transition: 'background 0.15s',
        opacity: disabled ? 0.45 : 1,
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
  const visibilityMode = useStore((s) => s.visibilityMode);
  const observerLocation = useStore((s) => s.observerLocation);
  const setVisibilityMode = useStore((s) => s.setVisibilityMode);
  const setObserverLocation = useStore((s) => s.setObserverLocation);
  const visualList = useStore((s) => s.visualList);

  const [open, setOpen] = useState(true);

  if (loadingPhase !== 'ready') return null;

  const totalVisible = Object.values(visibleCatCounts).reduce((a, b) => a + b, 0);
  const visualModeAvailable = visualList.status === 'fresh' || visualList.status === 'stale';

  const visualStatusColor = visualList.status === 'fresh'
    ? 'rgba(76, 175, 80, 0.9)'
    : visualList.status === 'stale'
      ? 'rgba(255, 193, 7, 0.95)'
      : visualList.status === 'loading'
        ? 'rgba(255, 255, 255, 0.65)'
        : 'rgba(244, 67, 54, 0.95)';

  const visualStatusLabel = visualList.status === 'fresh'
    ? 'VISUAL list: Fresh'
    : visualList.status === 'stale'
      ? 'VISUAL list: Stale cache'
      : visualList.status === 'loading'
        ? 'VISUAL list: Loading'
        : 'VISUAL list: Unavailable';

  const handleRequestLocation = () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Convert altitude from meters to KM if available, otherwise assume roughly 0
        const altKm = pos.coords.altitude ? pos.coords.altitude / 1000 : 0.0;
        setObserverLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, alt: altKm });
        setVisibilityMode(visualModeAvailable ? 'visual' : 'radio');
      },
      (err) => {
        alert(`Unable to retrieve location: ${err.message}`);
      }
    );
  };

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

        <div style={sectionHeaderStyle}>Local Visibility</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
           {observerLocation === null ? (
               <button onClick={handleRequestLocation} style={{
                   background: 'rgba(255, 255, 255, 0.1)', border: '1px solid rgba(255, 255, 255, 0.2)', color: '#fff', padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11
               }}>
                   📍 Use My Location
               </button>
           ) : (
                <>
                  <div style={{ fontSize: 10, color: 'rgba(255, 255, 255, 0.5)', marginBottom: 4 }}>
                    Lat: {observerLocation.lat.toFixed(2)}°, Lon: {observerLocation.lon.toFixed(2)}°
                  </div>
                  <div style={{ fontSize: 10, color: visualStatusColor, marginBottom: 4 }}>
                    {visualStatusLabel}
                    {visualList.version ? ` (${visualList.version.slice(11, 19)} UTC)` : ''}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: visibilityMode === 'all' ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                     <Toggle on={visibilityMode === 'all'} onToggle={() => setVisibilityMode('all')} />
                     <span>Show All (Global)</span>
                    {visibilityMode === 'all' && <span style={countStyle}>{totalVisible.toLocaleString()}</span>}
                 </div>
                 <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: visibilityMode === 'radio' ? 1 : 0.4, transition: 'opacity 0.15s' }}>
                    <Toggle on={visibilityMode === 'radio'} onToggle={() => setVisibilityMode('radio')} />
                    <span>Radio Pass (&gt;10° Elev)</span>
                    {visibilityMode === 'radio' && <span style={countStyle}>{totalVisible.toLocaleString()}</span>}
                 </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: visibilityMode === 'visual' ? 1 : (visualModeAvailable ? 0.4 : 0.25), transition: 'opacity 0.15s' }}>
                     <Toggle
                      on={visibilityMode === 'visual'}
                      onToggle={() => setVisibilityMode('visual')}
                      disabled={!visualModeAvailable}
                     />
                     <span title="Curated CelesTrak VISUAL list + local range/elevation/sunlight constraints">Naked-Eye Candidates</span>
                     {visibilityMode === 'visual' && <span style={countStyle}>{totalVisible.toLocaleString()}</span>}
                  </div>
                  {visualList.status === 'stale' && (
                    <div style={{ fontSize: 10, color: 'rgba(255, 193, 7, 0.95)', lineHeight: 1.3, marginTop: 2 }}>
                      Using cached curated list; results may be outdated.
                    </div>
                  )}
                  {visualList.status === 'unavailable' && (
                    <div style={{ fontSize: 10, color: 'rgba(244, 67, 54, 0.95)', lineHeight: 1.3, marginTop: 2 }}>
                      Curated visual list unavailable; switched to Radio Pass mode.
                    </div>
                  )}
                </>
            )}
         </div>

        <div
          style={{
            height: 1,
            background: 'rgba(255, 255, 255, 0.08)',
            margin: '12px 0',
          }}
        />

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
