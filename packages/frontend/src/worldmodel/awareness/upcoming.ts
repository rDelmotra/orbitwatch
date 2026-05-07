import type { UpcomingPasses, UpcomingPassInfo } from '../types';
import type { VisualPassState } from '../../store/useStore';

export function wrapUpcomingPasses(
  observerLocation: { lat: number; lon: number; alt: number } | null,
  visualPass: VisualPassState,
  selectedName: string | null,
): UpcomingPasses {
  if (!observerLocation) {
    return { hasObserver: false, currentPass: null };
  }

  const noradId = visualPass.noradId;
  const name = selectedName ?? (noradId !== null ? `NORAD ${noradId}` : 'Unknown');

  if (visualPass.status === 'idle' || noradId === null) {
    return { hasObserver: true, currentPass: null };
  }

  if (visualPass.status === 'computing') {
    const info: UpcomingPassInfo = {
      noradId: noradId,
      name,
      status: 'computing',
      aosTimeMs: null,
      losTimeMs: null,
      tcaTimeMs: null,
      maxElevationDeg: null,
      timeToAosMs: null,
      message: null,
    };
    return { hasObserver: true, currentPass: info };
  }

  if (visualPass.status === 'no_pass') {
    const info: UpcomingPassInfo = {
      noradId: noradId,
      name,
      status: 'none',
      aosTimeMs: null,
      losTimeMs: null,
      tcaTimeMs: null,
      maxElevationDeg: null,
      timeToAosMs: null,
      message: visualPass.message,
    };
    return { hasObserver: true, currentPass: info };
  }

  if (visualPass.status === 'unavailable') {
    return { hasObserver: true, currentPass: null };
  }

  // status === 'ready'
  const { aosTimeMs, losTimeMs, tcaTimeMs, maxElevationDeg } = visualPass;
  const nowMs = Date.now();
  const timeToAosMs = aosTimeMs !== null ? aosTimeMs - nowMs : null;
  const passStatus = timeToAosMs !== null && timeToAosMs <= 0 ? 'in_view' : 'upcoming';

  const info: UpcomingPassInfo = {
    noradId: noradId,
    name,
    status: passStatus,
    aosTimeMs,
    losTimeMs,
    tcaTimeMs,
    maxElevationDeg,
    timeToAosMs: passStatus === 'in_view' ? null : timeToAosMs,
    message: null,
  };
  return { hasObserver: true, currentPass: info };
}
