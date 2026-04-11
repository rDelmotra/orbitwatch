import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import type { ObjectCategory } from '../data/types';

const CATEGORY_LABELS: Record<ObjectCategory, string> = {
  active_satellite: 'Active Satellite',
  inactive_satellite: 'Inactive Satellite',
  rocket_body: 'Rocket Body',
  debris: 'Debris',
  unknown: 'Unknown',
  deep_space: 'Deep Space',
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

const subsectionStyle: React.CSSProperties = {
  marginTop: 10,
  paddingTop: 8,
  borderTop: '1px solid rgba(255, 255, 255, 0.1)',
};

const subsectionHeaderStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.45)',
  fontSize: '11px',
  marginBottom: 4,
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

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatUtcClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 19)} UTC`;
}

export function InfoCard() {
  const selectedSatellite = useStore((s) => s.selectedSatellite);
  const selectedDso = useStore((s) => s.selectedDso);
  const selectedAltitude = useStore((s) => s.selectedAltitude);
  const selectedIndex = useStore((s) => s.selectedIndex);
  const setSelectedSatellite = useStore((s) => s.setSelectedSatellite);
  const setSelectedDso = useStore((s) => s.setSelectedDso);
  const showOrbitTrail = useStore((s) => s.showOrbitTrail);
  const setShowOrbitTrail = useStore((s) => s.setShowOrbitTrail);
  const triggerFlyTo = useStore((s) => s.triggerFlyTo);
  const triggerJoyride = useStore((s) => s.triggerJoyride);
  const triggerFlyToDso = useStore((s) => s.triggerFlyToDso);
  const triggerJoyrideDso = useStore((s) => s.triggerJoyrideDso);
  const cameraMode = useStore((s) => s.cameraMode);
  const setCameraMode = useStore((s) => s.setCameraMode);
  const trackingStyle = useStore((s) => s.trackingStyle);
  const visibilityMode = useStore((s) => s.visibilityMode);
  const observerLocation = useStore((s) => s.observerLocation);
  const visualListStatus = useStore((s) => s.visualList.status);
  const visualPass = useStore((s) => s.visualPass);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!selectedSatellite || visibilityMode !== 'visual') {
      return;
    }
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [selectedSatellite?.noradId, visibilityMode]);

  if (!selectedSatellite && !selectedDso) return null;

  if (selectedDso) {
    const dso = selectedDso;
    const isTracking = cameraMode === 'flying' || cameraMode === 'following';
    const followActive = isTracking && trackingStyle === 'follow';
    const joyrideActive = isTracking && trackingStyle === 'joyride';
    return (
      <div style={panelStyle}>
        <div style={headerStyle}>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff', marginBottom: 2 }}>
              {dso.name}
            </div>
            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.4)' }}>
              {dso.mission}
            </div>
          </div>
          <button
            style={closeStyle}
            onClick={() => setSelectedDso(null)}
            title="Close"
          >
            ×
          </button>
        </div>

        <Row label="Type" value="Deep Space Mission" />
        <Row label="Mission" value={dso.mission} />
        <Row label="Target" value={dso.targetBody} />
        <Row label="Regime" value={dso.regime} />
        <Row label="Provider" value={dso.provider} />
        <Row label="Freshness" value={dso.freshnessState} />

        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button
            onClick={() => {
              if (cameraMode === 'returning') {
                setCameraMode('free');
              } else if (followActive) {
                setCameraMode('returning');
              } else {
                triggerFlyToDso?.(dso.dsoId);
              }
            }}
            style={{
              flex: 1,
              padding: '6px 0',
              background: followActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
              border: `1px solid ${followActive ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
              borderRadius: 4,
              color: followActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
              fontFamily: 'monospace',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            {cameraMode === 'returning'
              ? 'Stop'
              : (followActive ? (cameraMode === 'flying' ? 'Cancel' : 'Unfollow') : 'Go to')}
          </button>
          <button
            onClick={() => {
              if (cameraMode === 'returning') {
                setCameraMode('free');
              } else if (joyrideActive) {
                setCameraMode('returning');
              } else {
                triggerJoyrideDso?.(dso.dsoId);
              }
            }}
            style={{
              flex: 1,
              padding: '6px 0',
              background: joyrideActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
              border: `1px solid ${joyrideActive ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
              borderRadius: 4,
              color: joyrideActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
              fontFamily: 'monospace',
              fontSize: '11px',
              cursor: 'pointer',
            }}
          >
            {joyrideActive ? (cameraMode === 'flying' ? 'Cancel ride' : 'Exit ride') : 'Joyride'}
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

  const s = selectedSatellite!;
  const autoVisualPredictedTrail = visibilityMode === 'visual' && observerLocation !== null;
  const passForSelected = visualPass.noradId === s.noradId ? visualPass : null;
  const passReadyMetrics = (() => {
    if (
      !passForSelected
      || passForSelected.status !== 'ready'
      || passForSelected.aosTimeMs === null
      || passForSelected.tcaTimeMs === null
      || passForSelected.losTimeMs === null
      || passForSelected.durationMs === null
      || passForSelected.maxElevationDeg === null
    ) {
      return null;
    }

    const inViewNow = nowMs >= passForSelected.aosTimeMs && nowMs <= passForSelected.losTimeMs;
    return {
      inViewNow,
      startsInMs: inViewNow ? 0 : Math.max(0, passForSelected.aosTimeMs - nowMs),
      remainingMs: inViewNow ? Math.max(0, passForSelected.losTimeMs - nowMs) : null,
      aosTimeMs: passForSelected.aosTimeMs,
      tcaTimeMs: passForSelected.tcaTimeMs,
      losTimeMs: passForSelected.losTimeMs,
      durationMs: passForSelected.durationMs,
      maxElevationDeg: passForSelected.maxElevationDeg,
    };
  })();
  const isTracking = cameraMode === 'flying' || cameraMode === 'following';
  const followActive = isTracking && trackingStyle === 'follow';
  const joyrideActive = isTracking && trackingStyle === 'joyride';

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

      {visibilityMode === 'visual' && (
        <div style={subsectionStyle}>
          <div style={subsectionHeaderStyle}>Naked-eye pass (&gt;10° elevation)</div>
          {observerLocation === null ? (
            <div style={{ color: 'rgba(255, 193, 7, 0.95)', fontSize: '11px', lineHeight: 1.35 }}>
              Observer location is required for pass prediction.
            </div>
          ) : visualListStatus === 'unavailable' ? (
            <div style={{ color: 'rgba(244, 67, 54, 0.95)', fontSize: '11px', lineHeight: 1.35 }}>
              Curated VISUAL list unavailable.
            </div>
          ) : passReadyMetrics ? (
            <>
              <Row label="State" value={passReadyMetrics.inViewNow ? 'In view now' : 'Upcoming'} />
              <Row label="Starts in" value={passReadyMetrics.inViewNow ? 'now' : formatDuration(passReadyMetrics.startsInMs)} />
              <Row label="In-view window" value={formatDuration(passReadyMetrics.durationMs)} />
              <Row
                label="Remaining"
                value={passReadyMetrics.remainingMs !== null ? formatDuration(passReadyMetrics.remainingMs) : null}
              />
              <Row label="Max elevation" value={`${passReadyMetrics.maxElevationDeg.toFixed(1)}°`} />
              <Row label="AOS" value={formatUtcClock(passReadyMetrics.aosTimeMs)} />
              <Row label="TCA" value={formatUtcClock(passReadyMetrics.tcaTimeMs)} />
              <Row label="LOS" value={formatUtcClock(passReadyMetrics.losTimeMs)} />
            </>
          ) : passForSelected?.status === 'no_pass' ? (
            <div style={{ color: 'rgba(255, 193, 7, 0.95)', fontSize: '11px', lineHeight: 1.35 }}>
              {passForSelected.message ?? 'No pass above 10° elevation in the next 24h.'}
            </div>
          ) : passForSelected?.status === 'unavailable' ? (
            <div style={{ color: 'rgba(244, 67, 54, 0.95)', fontSize: '11px', lineHeight: 1.35 }}>
              {passForSelected.message ?? 'Pass prediction unavailable.'}
            </div>
          ) : (
            <div style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '11px', lineHeight: 1.35 }}>
              Computing next pass...
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <button
          onClick={() => {
            if (cameraMode === 'returning') {
              setCameraMode('free');
            } else if (followActive) {
              setCameraMode('returning');
            } else {
              if (selectedIndex !== null) {
                triggerFlyTo?.(selectedIndex);
              }
            }
          }}
          style={{
            flex: 1,
            padding: '6px 0',
            background: followActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${followActive ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
            borderRadius: 4,
            color: followActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
            fontFamily: 'monospace',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {cameraMode === 'returning'
            ? 'Stop'
            : (followActive ? (cameraMode === 'flying' ? 'Cancel' : 'Unfollow') : 'Go to')}
        </button>
        <button
          onClick={() => {
            if (cameraMode === 'returning') {
              setCameraMode('free');
            } else if (joyrideActive) {
              setCameraMode('returning');
            } else {
              if (selectedIndex !== null) {
                triggerJoyride?.(selectedIndex);
              }
            }
          }}
          style={{
            flex: 1,
            padding: '6px 0',
            background: joyrideActive ? 'rgba(0, 229, 255, 0.2)' : 'rgba(255, 255, 255, 0.06)',
            border: `1px solid ${joyrideActive ? 'rgba(0, 229, 255, 0.5)' : 'rgba(255, 255, 255, 0.12)'}`,
            borderRadius: 4,
            color: joyrideActive ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)',
            fontFamily: 'monospace',
            fontSize: '11px',
            cursor: 'pointer',
          }}
        >
          {joyrideActive ? (cameraMode === 'flying' ? 'Cancel ride' : 'Exit ride') : 'Joyride'}
        </button>
        <button
          onClick={() => {
            if (!autoVisualPredictedTrail) {
              setShowOrbitTrail(!showOrbitTrail);
            }
          }}
          disabled={autoVisualPredictedTrail}
          title={autoVisualPredictedTrail ? 'Predicted trail auto-renders in Naked Eye mode' : undefined}
          style={{
            flex: 1,
            padding: '6px 0',
            background: autoVisualPredictedTrail
              ? 'rgba(0, 229, 255, 0.15)'
              : (showOrbitTrail ? 'rgba(0, 229, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)'),
            border: `1px solid ${autoVisualPredictedTrail
              ? 'rgba(0, 229, 255, 0.4)'
              : (showOrbitTrail ? 'rgba(0, 229, 255, 0.4)' : 'rgba(255, 255, 255, 0.12)')}`,
            borderRadius: 4,
            color: autoVisualPredictedTrail ? '#00E5FF' : (showOrbitTrail ? '#00E5FF' : 'rgba(255, 255, 255, 0.7)'),
            fontFamily: 'monospace',
            fontSize: '11px',
            cursor: autoVisualPredictedTrail ? 'default' : 'pointer',
            opacity: autoVisualPredictedTrail ? 0.9 : 1,
          }}
        >
          {autoVisualPredictedTrail ? 'Predicted trail auto' : (showOrbitTrail ? 'Hide orbit' : 'Show orbit')}
        </button>
      </div>
    </div>
  );
}
