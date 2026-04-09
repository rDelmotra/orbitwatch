import { useEffect, useRef } from 'react';
import { Engine } from './engine/Engine';
import { LoadingScreen } from './ui/LoadingScreen';
import { HUD } from './ui/HUD';
import { FilterPanel } from './ui/FilterPanel';
import { SearchBar } from './ui/SearchBar';
import { InfoCard } from './ui/InfoCard';
import { Tooltip } from './ui/Tooltip';
import { ClusterPopup } from './ui/ClusterPopup';
import { DevOverlay } from './ui/DevOverlay';
import { useStore } from './store/useStore';

function DsoLabels() {
  const labelPositions = useStore((s) => s.dsoLabelPositions);
  const loadingPhase = useStore((s) => s.loadingPhase);
  if (loadingPhase !== 'ready') return null;

  return (
    <>
      {labelPositions.map((label) => {
        if (!label.visible) return null;
        return (
          <div
            key={label.dsoId}
            style={{
              position: 'absolute',
              left: label.screenX + 10,
              top: label.screenY - 6,
              color: '#00BCD4',
              fontFamily: 'monospace',
              fontSize: '11px',
              fontWeight: 500,
              letterSpacing: '0.05em',
              pointerEvents: 'none',
              textShadow: '0 0 6px rgba(0,188,212,0.7), 0 1px 3px rgba(0,0,0,0.9)',
              whiteSpace: 'nowrap',
              userSelect: 'none',
            }}
          >
            {label.name}
          </div>
        );
      })}
    </>
  );
}

function ResetViewButton() {
  const cameraMode = useStore((s) => s.cameraMode);
  const triggerResetCamera = useStore((s) => s.triggerResetCamera);
  const loadingPhase = useStore((s) => s.loadingPhase);

  if (loadingPhase !== 'ready' || cameraMode === 'returning') return null;

  return (
    <button
      onClick={() => triggerResetCamera?.()}
      style={{
        position: 'absolute',
        bottom: 16,
        right: 16,
        padding: '6px 12px',
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(4px)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: 6,
        color: 'rgba(255, 255, 255, 0.7)',
        fontFamily: 'monospace',
        fontSize: '11px',
        cursor: 'pointer',
        pointerEvents: 'auto',
      }}
    >
      Reset view
    </button>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new Engine(canvas);
    engineRef.current = engine;
    engine.start();

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        <HUD />
        <SearchBar />
        <FilterPanel />
        <InfoCard />
        <DsoLabels />
        <ResetViewButton />
      </div>
      <Tooltip />
      <ClusterPopup />
      {import.meta.env.DEV && <DevOverlay />}
      <LoadingScreen />
    </div>
  );
}
