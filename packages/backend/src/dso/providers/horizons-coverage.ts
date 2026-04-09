import type { DsoRegistryEntry } from '../registry/index.js';

export interface HorizonsCoverageBounds {
  earliestAvailable: Date | null;
  latestAvailable: Date | null;
}

export interface HorizonsRequestWindow {
  windowStart: Date;
  windowEnd: Date;
}

const COVERAGE_LOWER_BOUND_REGEX =
  /prior to\s+(A\.D\.\s+\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*TDB/i;
const COVERAGE_UPPER_BOUND_REGEX =
  /after\s+(A\.D\.\s+\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*TDB/i;

function parseCalendarDateTdbToDate(calendarDateRaw: string): Date {
  const match = calendarDateRaw.match(
    /^A\.D\.\s+(\d{4})-([A-Za-z]{3})-(\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/,
  );
  if (!match) {
    throw new Error(`Unexpected Horizons calendar date format: ${calendarDateRaw}`);
  }

  const [, year, monthToken, day, time] = match;
  const normalizedMonthToken = `${monthToken[0].toUpperCase()}${monthToken.slice(1).toLowerCase()}`;
  const month = {
    Jan: '01',
    Feb: '02',
    Mar: '03',
    Apr: '04',
    May: '05',
    Jun: '06',
    Jul: '07',
    Aug: '08',
    Sep: '09',
    Oct: '10',
    Nov: '11',
    Dec: '12',
  }[normalizedMonthToken];

  if (!month) {
    throw new Error(`Unexpected Horizons month token: ${monthToken}`);
  }

  const parsed = new Date(`${year}-${month}-${day}T${time}Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid Horizons calendar date: ${calendarDateRaw}`);
  }

  return parsed;
}

function tryParseCoverageBound(calendarDateRaw: string): Date | null {
  try {
    return parseCalendarDateTdbToDate(calendarDateRaw);
  } catch {
    return null;
  }
}

export function extractCoverageBoundsFromError(message: string): HorizonsCoverageBounds | null {
  const lowerMatch = message.match(COVERAGE_LOWER_BOUND_REGEX);
  const upperMatch = message.match(COVERAGE_UPPER_BOUND_REGEX);

  if (!lowerMatch && !upperMatch) {
    return null;
  }

  return {
    earliestAvailable: lowerMatch ? tryParseCoverageBound(lowerMatch[1]) : null,
    latestAvailable: upperMatch ? tryParseCoverageBound(upperMatch[1]) : null,
  };
}

export function clampWindowToCoverageBounds(
  entry: DsoRegistryEntry,
  windowStart: Date,
  windowEnd: Date,
  coverageBounds: HorizonsCoverageBounds,
): HorizonsRequestWindow | null {
  const originalStartMs = windowStart.getTime();
  const originalEndMs = windowEnd.getTime();
  const marginMs = entry.sampleStepSec * 1000;

  let clampedStartMs = originalStartMs;
  let clampedEndMs = originalEndMs;

  if (coverageBounds.earliestAvailable) {
    clampedStartMs = Math.max(
      clampedStartMs,
      coverageBounds.earliestAvailable.getTime() + marginMs,
    );
  }

  if (coverageBounds.latestAvailable) {
    clampedEndMs = Math.min(
      clampedEndMs,
      coverageBounds.latestAvailable.getTime() - marginMs,
    );
  }

  if (clampedEndMs <= clampedStartMs) {
    return null;
  }

  if (clampedEndMs - clampedStartMs < marginMs) {
    return null;
  }

  if (clampedStartMs === originalStartMs && clampedEndMs === originalEndMs) {
    return null;
  }

  return {
    windowStart: new Date(clampedStartMs),
    windowEnd: new Date(clampedEndMs),
  };
}

export function deriveClampedRetryWindowFromError(
  entry: DsoRegistryEntry,
  windowStart: Date,
  windowEnd: Date,
  errorMessage: string,
): HorizonsRequestWindow | null {
  const coverageBounds = extractCoverageBoundsFromError(errorMessage);
  if (!coverageBounds || (!coverageBounds.earliestAvailable && !coverageBounds.latestAvailable)) {
    return null;
  }

  return clampWindowToCoverageBounds(entry, windowStart, windowEnd, coverageBounds);
}
