import { useState, useEffect } from 'react';
import { useStore, type LoadingPhase } from '../store/useStore';

const PHASE_MESSAGES: Record<LoadingPhase, string> = {
  fetching: 'Downloading catalog data...',
  initializing: 'Initializing propagation engine...',
  propagating: 'Computing orbital positions...',
  ready: '',
};

const PHASE_PROGRESS: Record<LoadingPhase, number> = {
  fetching: 33,
  initializing: 66,
  propagating: 90,
  ready: 100,
};

export function LoadingScreen() {
  const loadingPhase = useStore((s) => s.loadingPhase);
  const loadingError = useStore((s) => s.loadingError);
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (loadingPhase === 'ready') {
      setFading(true);
      const timer = setTimeout(() => setVisible(false), 1000);
      return () => clearTimeout(timer);
    }
  }, [loadingPhase]);

  if (!visible) return null;

  const progress = PHASE_PROGRESS[loadingPhase];

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: fading ? 0 : 1,
        transition: 'opacity 1s ease-out',
        pointerEvents: fading ? 'none' : 'auto',
      }}
    >
      <h1
        style={{
          fontFamily: 'monospace',
          fontSize: '2rem',
          color: '#fff',
          letterSpacing: '0.3em',
          marginBottom: '2rem',
          fontWeight: 300,
        }}
      >
        ORBITWATCH
      </h1>

      <div
        style={{
          width: '280px',
          height: '3px',
          background: 'rgba(255, 255, 255, 0.15)',
          borderRadius: '2px',
          overflow: 'hidden',
          marginBottom: '1rem',
        }}
      >
        <div
          style={{
            width: `${progress}%`,
            height: '100%',
            background: '#00E5FF',
            borderRadius: '2px',
            transition: 'width 0.4s ease-out',
          }}
        />
      </div>

      <p
        style={{
          fontFamily: 'monospace',
          fontSize: '0.8rem',
          color: 'rgba(255, 255, 255, 0.5)',
        }}
      >
        {loadingError ? (
          <span style={{ color: '#F44336' }}>{loadingError}</span>
        ) : (
          PHASE_MESSAGES[loadingPhase]
        )}
      </p>
    </div>
  );
}
