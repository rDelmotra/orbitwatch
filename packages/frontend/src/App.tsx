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
      </div>
      <Tooltip />
      <ClusterPopup />
      {import.meta.env.DEV && <DevOverlay />}
      <LoadingScreen />
    </div>
  );
}
