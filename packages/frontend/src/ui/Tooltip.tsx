import { useStore } from '../store/useStore';

export function Tooltip() {
  const name = useStore((s) => s.hoveredName);
  const x = useStore((s) => s.hoverScreenX);
  const y = useStore((s) => s.hoverScreenY);

  if (!name) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: x + 14,
        top: y - 10,
        padding: '4px 8px',
        background: 'rgba(0, 0, 0, 0.8)',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: 4,
        fontFamily: 'monospace',
        fontSize: '11px',
        color: '#fff',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        zIndex: 900,
      }}
    >
      {name}
    </div>
  );
}
