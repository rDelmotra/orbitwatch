/**
 * TileEarthSurface — streaming LOD imagery globe via `3d-tiles-renderer`.
 *
 * This is the real answer to "joyride-grade surface detail": instead of one huge texture (which
 * the GPU clamps at 16384 and costs ~GBs of VRAM), it drapes ESRI World Imagery as XYZ tiles on a
 * WGS84 ellipsoid and streams only the tiles in view at the zoom level the camera needs — so you
 * get effectively 100k+ resolution near the camera for a few MB of VRAM.
 *
 * Integration:
 *   - The tileset lives in WGS84 ECEF metres, Z-up. We parent `tiles.group` to the Earth group
 *     (so it co-rotates with GAST and stays locked to satellite positions), scale metres→Earth-
 *     radii, and rotate ECEF Z-up → scene Y-up.
 *   - 3d-tiles-renderer accounts for the group's world transform when computing screen-space
 *     error, so LOD still works through the scale.
 *   - The fallback textured sphere is hidden once real imagery starts covering it (they share the
 *     same radius, so leaving both would z-fight).
 *   - DAY/NIGHT: ESRI imagery is uniform full-daylight (unlit MeshBasicMaterial) with no night side
 *     and no terminator — wrong for astronaut POV and it washed out the dim night-side satellites.
 *     We relight each tile material via `onBeforeCompile`: a soft sun-direction terminator darkens
 *     the night hemisphere and tones the day side down. The factor uses the fragment's world radial
 *     (= surface normal, since Earth center is the scene origin) dotted with the world-space (ECI)
 *     sun — the SAME frame that lights the satellites — so the terminator is physically correct and
 *     stays locked to the surface as GAST rotates the Earth group. All tile materials share one sun
 *     uniform object, updated once per frame.
 *   - CRITICAL: tile meshes are forced OPAQUE on load. The image plugin builds them with
 *     `MeshBasicMaterial({ transparent: true })`, which drops them into the transparent render
 *     queue alongside the satellite `THREE.Points` (also transparent, depthWrite:false). Transparent
 *     objects sort back-to-front per-object, and the single satellite Points object sorts by its
 *     bounding-center (≈ Earth's center) — so near-side tiles, being closer than the center, render
 *     AFTER the satellites and (since the satellites never wrote depth) paint imagery straight over
 *     them. The camera-facing satellites vanish, surviving only at the limb. Forcing the tiles
 *     opaque (depthWrite + opaque queue, drawn before transparent overlays) restores correct
 *     occlusion: near-side satellites in front, far-side hidden behind the globe.
 *
 * Failsafe: any failure (construction, network) leaves the module not-ready and the fallback
 * sphere visible.
 *
 * KNOWN CALIBRATION (first cut — needs visual tuning):
 *   - `LON_OFFSET_RAD`: aligns the imagery prime meridian with the existing texture / satellite
 *     frame. Start at 0 and rotate until coastlines line up under known satellites.
 *   - Depth/render order vs the fallback clouds shell and satellites.
 */
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { XYZTilesPlugin } from '3d-tiles-renderer/plugins';
import { METERS_TO_ER, EARTH_RADIUS_METERS } from './constants';
import type { GeospatialModule, GeospatialContext, FrameState } from './types';

/** Payload of the tiles renderer's `load-model` event (engine-specific scene object). */
interface LoadModelEvent {
  scene: THREE.Object3D;
}

/** ESRI World Imagery — free public XYZ endpoint, sub-metre in many regions. */
const ESRI_WORLD_IMAGERY_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

/** Calibration: rotation about the polar (scene-Y) axis to align the imagery prime meridian. */
const LON_OFFSET_RAD = 0;

// ── Day/night relight tuning ──────────────────────────────────────────────────
/** Brightness multiplier on the fully-lit (sub-solar) day side — tones the bright ESRI imagery. */
const TILE_DAY_EXPOSURE = 0.55;
/** Brightness multiplier on the full-night hemisphere (small, not pure black, so coasts stay faint). */
const TILE_NIGHT_LEVEL = 0.045;
/** Half-width of the dawn/dusk blend, in dot(normal,sun) units (~asin → ±~7° at 0.12). */
const TILE_TERMINATOR_SOFTNESS = 0.12;

// ── Night-lights (NASA VIIRS Black Marble) ────────────────────────────────────
/**
 * VIIRS Black Marble city lights as XYZ tiles from NASA GIBS (EPSG:3857 / Web-Mercator, PNG,
 * yearly composite). A second streamed layer — NOT the old static texture — so it sharpens with the
 * day imagery when joyriding low. REST order is {TileMatrix}/{TileRow}/{TileCol} = {z}/{y}/{x}.
 */
const BLACK_MARBLE_URL =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
/** Black Marble tops out at zoom 8 → 9 levels (0..8). Capping avoids 400s on deeper requests. */
const BLACK_MARBLE_LEVELS = 9;
/** Lift the lights shell ~3 km above the day surface so it never z-fights the day tiles. */
const NIGHT_RADIUS_LIFT = 1.0005;
/**
 * Linear-HDR gain on the city lights before ACES tone-mapping (higher = brighter cities).
 * Black Marble is VIIRS-native ~500 m/px (GIBS caps at zoom 8) — far softer than the sub-meter day
 * imagery, and there is no higher-res free global night source. Keeping this modest is deliberate:
 * real city lights from orbit are diffuse glows, so a lower gain reads as natural bloom rather than
 * a blurry texture.
 */
const TILE_NIGHT_LIGHTS_INTENSITY = 2.0;

export class TileEarthSurface implements GeospatialModule {
  readonly name = 'tile-earth';

  private _ready = false;
  private _failed = false;
  private _tiles: TilesRenderer | null = null;
  private _camera: THREE.PerspectiveCamera | null = null;
  private _renderer: THREE.WebGLRenderer | null = null;
  private _surfaceHidden = false;
  private _onLoad: ((e: LoadModelEvent) => void) | null = null;
  private _nightTiles: TilesRenderer | null = null;
  private _onNightLoad: ((e: LoadModelEvent) => void) | null = null;

  // Shared uniforms injected into every tile material by `_relight` — mutated in place each frame
  // so one write updates all tiles.
  private readonly _sunUniform = { value: new THREE.Vector3(1, 0, 0) };
  private readonly _dayExposure = { value: TILE_DAY_EXPOSURE };
  private readonly _nightLevel = { value: TILE_NIGHT_LEVEL };
  private readonly _terminatorSoftness = { value: TILE_TERMINATOR_SOFTNESS };
  private readonly _nightIntensity = { value: TILE_NIGHT_LIGHTS_INTENSITY };

  /**
   * onBeforeCompile hook (stable ref → all tile programs share one cache key & one sun uniform).
   * Injects a soft day/night terminator into the unlit MeshBasicMaterial.
   */
  private readonly _relight = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    shader.uniforms.uSunDirection = this._sunUniform;
    shader.uniforms.uDayExposure = this._dayExposure;
    shader.uniforms.uNightLevel = this._nightLevel;
    shader.uniforms.uTerminatorSoftness = this._terminatorSoftness;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTileWorldPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n  vTileWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vTileWorldPos;
uniform vec3 uSunDirection;
uniform float uDayExposure;
uniform float uNightLevel;
uniform float uTerminatorSoftness;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  {
    // Earth center is the scene origin, so the world radial IS the surface normal.
    vec3 R = normalize(vTileWorldPos);
    float ndl = dot(R, normalize(uSunDirection));
    float day = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, ndl);
    diffuseColor.rgb *= mix(uNightLevel, uDayExposure, day);
  }`,
      );
  };

  /**
   * onBeforeCompile for the Black Marble layer. The lights texture is city lights on black, drawn
   * with AdditiveBlending (so black adds nothing). We gate it to the NIGHT side via `1 - day` from
   * the same terminator and push it into the fragment alpha (additive contribution = rgb * alpha),
   * so cities glow only on the dark hemisphere and fade through dawn/dusk.
   */
  private readonly _nightRelight = (shader: THREE.WebGLProgramParametersWithUniforms): void => {
    shader.uniforms.uSunDirection = this._sunUniform;
    shader.uniforms.uTerminatorSoftness = this._terminatorSoftness;
    shader.uniforms.uNightIntensity = this._nightIntensity;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTileWorldPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n  vTileWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vTileWorldPos;
uniform vec3 uSunDirection;
uniform float uTerminatorSoftness;
uniform float uNightIntensity;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  {
    vec3 R = normalize(vTileWorldPos);
    float ndl = dot(R, normalize(uSunDirection));
    float day = smoothstep(-uTerminatorSoftness, uTerminatorSoftness, ndl);
    float night = 1.0 - day;
    diffuseColor.rgb *= uNightIntensity;
    diffuseColor.a = night;   // AdditiveBlending: contribution = rgb * a → lights only at night
  }`,
      );
  };

  get ready(): boolean {
    return this._ready;
  }

  get failed(): boolean {
    return this._failed;
  }

  async init(ctx: GeospatialContext): Promise<void> {
    try {
      const tiles = new TilesRenderer();

      // Our whole scene is a SPHERE of radius 1 ER (6371 km). The tiles default to the WGS84
      // ellipsoid (equatorial 6378 km, polar 6357 km), so after scaling the surface would sit
      // ~7 km ABOVE 1 ER at the equator — poking through and swallowing surface markers like the
      // observer cone. Pin the tile ellipsoid to a 6371 km sphere so its surface coincides exactly
      // with our scene sphere. Must be set before tiles process (read in the plugin's projection).
      tiles.ellipsoid.radius.set(
        EARTH_RADIUS_METERS,
        EARTH_RADIUS_METERS,
        EARTH_RADIUS_METERS,
      );

      tiles.registerPlugin(
        new XYZTilesPlugin({
          shape: 'ellipsoid',
          useRecommendedSettings: true,
          url: ESRI_WORLD_IMAGERY_URL,
        }),
      );
      // NOTE: no TilesFadePlugin — it animates per-tile opacity and so keeps tile materials
      // transparent, which is exactly what broke satellite occlusion (see header). Without it the
      // tiles can be forced opaque.

      tiles.setCamera(ctx.camera);
      tiles.setResolutionFromRenderer(ctx.camera, ctx.renderer);

      // Fit the ECEF-metres, Z-up tileset into our ECI, Earth-radii, Y-up scene.
      const g = tiles.group;
      g.scale.setScalar(METERS_TO_ER);
      g.rotation.set(-Math.PI / 2, LON_OFFSET_RAD, 0);
      ctx.earthGroup.add(g);

      // On each tile load: (1) force its material opaque so it occludes satellites correctly,
      // (2) inject the day/night relight, and (3) retire the fallback sphere once the first imagery
      // covers it (same radius → avoid z-fight).
      this._onLoad = (e: LoadModelEvent) => {
        e.scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) {
            mat.transparent = false;
            mat.depthWrite = true;
            mat.depthTest = true;
            mat.onBeforeCompile = this._relight;
            mat.needsUpdate = true;
          }
        });
        if (!this._surfaceHidden) {
          this._surfaceHidden = true;
          ctx.fallback.hideSurface();
        }
      };
      tiles.addEventListener('load-model', this._onLoad as (e: object) => void);

      this._tiles = tiles;
      this._camera = ctx.camera;
      this._renderer = ctx.renderer;
      this._ready = true;

      // City lights are a best-effort second layer — its own try/catch so a GIBS failure never
      // takes down the day surface.
      this._initNightLights(ctx);
    } catch (err) {
      this._failed = true;
      console.warn('[geospatial] tile earth init failed; keeping fallback sphere:', err);
    }
  }

  /** Streams NASA Black Marble city lights as a second additive, night-gated tile layer. */
  private _initNightLights(ctx: GeospatialContext): void {
    try {
      const night = new TilesRenderer();
      night.ellipsoid.radius.set(
        EARTH_RADIUS_METERS,
        EARTH_RADIUS_METERS,
        EARTH_RADIUS_METERS,
      );
      night.registerPlugin(
        new XYZTilesPlugin({
          shape: 'ellipsoid',
          levels: BLACK_MARBLE_LEVELS,
          url: BLACK_MARBLE_URL,
        }),
      );
      night.setCamera(ctx.camera);
      night.setResolutionFromRenderer(ctx.camera, ctx.renderer);

      const g = night.group;
      // Same fit as the day surface, lifted a hair so the additive lights never z-fight it.
      g.scale.setScalar(METERS_TO_ER * NIGHT_RADIUS_LIFT);
      g.rotation.set(-Math.PI / 2, LON_OFFSET_RAD, 0);
      ctx.earthGroup.add(g);

      this._onNightLoad = (e: LoadModelEvent) => {
        e.scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const mat of mats) {
            mat.transparent = true;
            mat.depthWrite = false;       // don't occlude; the day surface owns depth
            mat.depthTest = true;         // but stay hidden behind the Earth on the far side
            mat.blending = THREE.AdditiveBlending;
            mat.onBeforeCompile = this._nightRelight;
            mat.needsUpdate = true;
          }
        });
      };
      night.addEventListener('load-model', this._onNightLoad as (e: object) => void);

      this._nightTiles = night;
    } catch (err) {
      console.warn('[geospatial] night-lights layer unavailable; day surface unaffected:', err);
    }
  }

  update(frame: FrameState): void {
    if (!this._tiles || !this._camera || !this._renderer) return;
    // World-space (ECI) sun — same frame that lights the satellites. One write feeds every tile.
    this._sunUniform.value.copy(frame.sunDirectionECI);
    // Resolution can change on resize; cheap to set each frame.
    this._tiles.setResolutionFromRenderer(this._camera, this._renderer);
    this._tiles.update();

    if (this._nightTiles) {
      this._nightTiles.setResolutionFromRenderer(this._camera, this._renderer);
      this._nightTiles.update();
    }
  }

  dispose(): void {
    if (this._nightTiles) {
      if (this._onNightLoad) {
        this._nightTiles.removeEventListener('load-model', this._onNightLoad as (e: object) => void);
        this._onNightLoad = null;
      }
      this._nightTiles.group.removeFromParent();
      this._nightTiles.dispose();
      this._nightTiles = null;
    }
    if (!this._tiles) return;
    if (this._onLoad) {
      this._tiles.removeEventListener('load-model', this._onLoad as (e: object) => void);
      this._onLoad = null;
    }
    this._tiles.group.removeFromParent();
    this._tiles.dispose();
    this._tiles = null;
  }
}
