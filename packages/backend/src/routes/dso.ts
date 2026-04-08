import { Router, Request, Response } from 'express';
import { getDeepSpaceCatalog } from '../services/deep-space-catalog.js';
import { readHorizonsCache } from '../cache/horizons-cache.js';
import { logger } from '../utils/logger.js';
import type { HorizonsEphemerisPoint } from '../types/index.js';

const router = Router();

// ============================================================
// GET /api/dso/all
//
// Returns the deep-space catalog + ephemeris for all objects.
// Ephemeris is keyed by horizonsId. Always 200 — objects with no cached
// ephemeris yet (e.g. first boot) receive an empty points array; the
// frontend handles this gracefully (no DSO rendered until data arrives).
//
// Response shape:
//   {
//     count: number,
//     objects: DeepSpaceCatalogEntry[],
//     ephemeris: { [horizonsId: string]: HorizonsEphemerisPoint[] }
//   }
// ============================================================
router.get('/all', (_req: Request, res: Response) => {
  const objects = getDeepSpaceCatalog();
  const ephemeris: Record<string, HorizonsEphemerisPoint[]> = {};

  for (const obj of objects) {
    const cached = readHorizonsCache(obj.horizonsId);
    if (cached) {
      ephemeris[obj.horizonsId] = cached.points;
    } else {
      ephemeris[obj.horizonsId] = [];
      logger.warn(`GET /api/dso/all: no ephemeris cache for ${obj.name} (${obj.horizonsId})`);
    }
  }

  // Cache for 1 hour — matches TLE endpoint TTL. Ephemeris updates daily.
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({
    count: objects.length,
    objects,
    ephemeris,
  });
});

export default router;
