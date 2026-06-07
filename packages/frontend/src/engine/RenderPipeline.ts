/**
 * RenderPipeline — owns the post-processing chain (pmndrs `postprocessing` EffectComposer).
 *
 * Why it exists: Takram's atmosphere/clouds render as screen-space post-process *effects*
 * (they read the depth buffer), so the final image must go through an EffectComposer rather
 * than a bare `renderer.render(scene, camera)`.
 *
 * Pass order:
 *   RenderPass → [DepthPass] → [EffectPass(clouds)] → EffectPass(...others, ToneMapping) → EffectPass(SMAA)
 *
 * - ToneMapping is last inside the "others" pass; SMAA runs after it (display-referred) as the AA —
 *   the renderer is created antialias:false so NOTHING in the depth path is multisampled.
 * - **Clouds get a DEDICATED DepthPass.** The Takram CloudsEffect does its own internal
 *   shadow/raymarch/temporal rendering, so it cannot read the composer's live depth attachment
 *   (that triggers `glBlitFramebuffer: read and write depth stencil attachments cannot be the same
 *   image` and destabilises the shared pass). The DepthPass renders the scene depth into a STANDALONE
 *   DepthTexture; we hand that to each clouds effect via `setDepthTexture()` and isolate the clouds
 *   in their own EffectPass. The atmosphere stays on pmndrs' automatic depth (it's a simple
 *   fullscreen effect and works fine that way). The DepthPass is only enabled when a clouds effect
 *   is present (it re-renders scene depth — a real cost).
 *
 * Ownership: effects handed to `setEffects()` are owned by their EffectPass (disposed on rebuild /
 * composer.dispose()). Modules that create effects must NOT dispose them.
 */
import * as THREE from 'three';
import {
  EffectComposer,
  RenderPass,
  DepthPass,
  EffectPass,
  ToneMappingEffect,
  ToneMappingMode,
  SMAAEffect,
  SMAAPreset,
  type Effect,
} from 'postprocessing';
import { CloudsEffect } from '@takram/three-clouds';

export class RenderPipeline {
  private readonly composer: EffectComposer;
  private readonly camera: THREE.Camera;
  /** Standalone scene-depth for depth-reading effects that re-render (clouds). Enabled on demand. */
  private readonly depthPass: DepthPass;
  /** Clouds run in their own pass (own decoupled depth); null when no clouds effect is active. */
  private cloudsPass: EffectPass | null = null;
  /** The clouds effects currently active — kept so we can re-bind depth after a resize. */
  private cloudEffects: CloudsEffect[] = [];
  private effectPass: EffectPass;
  /** Final antialiasing pass — always last; replaces MSAA now that the renderer is antialias:false. */
  private readonly smaaPass: EffectPass;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
  ) {
    this.camera = camera;

    // HalfFloat buffers keep the scene in linear-HDR space until the final tone map — this is
    // what makes additive satellite points + atmosphere composite correctly.
    //
    // multisampling MUST be 0: depth-reading effects sample the depth buffer; with MSAA the composer
    // keeps depth in a multisampled renderbuffer and has to blit-resolve it before sampling, which
    // fails ("read and write depth stencil attachments cannot be the same image"). multisampling 0 +
    // the renderer's antialias:false means no MSAA anywhere; SMAA below recovers edge AA.
    this.composer = new EffectComposer(renderer, {
      multisampling: 0,
      frameBufferType: THREE.HalfFloatType,
    });

    this.composer.addPass(new RenderPass(scene, camera));

    // Dedicated standalone scene-depth texture for the clouds (see header). Disabled until a clouds
    // effect is wired in via setEffects(), so the extra depth render isn't paid for otherwise.
    this.depthPass = new DepthPass(scene, camera);
    this.depthPass.enabled = false;
    this.composer.addPass(this.depthPass);

    // Start as a pure pass-through: just ACES tone mapping.
    this.effectPass = new EffectPass(camera, this.createToneMapping());
    this.composer.addPass(this.effectPass);

    // SMAA antialiasing, owned by the composer. LAST so it runs on the tone-mapped image; its own
    // pass because SMAA does multi-step edge detection on the fully-resolved frame.
    this.smaaPass = new EffectPass(camera, new SMAAEffect({ preset: SMAAPreset.HIGH }));
    this.composer.addPass(this.smaaPass);
  }

  private createToneMapping(): ToneMappingEffect {
    return new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC });
  }

  /**
   * Replace the geospatial post-process effects. Clouds (which need decoupled depth) are split into
   * their own pass fed by the DepthPass; everything else shares one pass ending in tone mapping.
   * Rebuilds the dynamic tail so order stays: RenderPass, DepthPass, [clouds], others+tonemap, SMAA.
   * Called once at startup with [] and again when async Takram modules finish initialising.
   */
  setEffects(effects: Effect[]): void {
    // Tear down the dynamic passes; keep the persistent SMAA instance and re-add it last.
    if (this.cloudsPass) {
      this.composer.removePass(this.cloudsPass);
      this.cloudsPass.dispose();
      this.cloudsPass = null;
    }
    this.composer.removePass(this.effectPass);
    this.effectPass.dispose();
    this.composer.removePass(this.smaaPass);

    this.cloudEffects = effects.filter((e): e is CloudsEffect => e instanceof CloudsEffect);
    const otherEffects = effects.filter((e) => !(e instanceof CloudsEffect));

    if (this.cloudEffects.length > 0) {
      this.depthPass.enabled = true;
      for (const clouds of this.cloudEffects) {
        clouds.setDepthTexture(this.depthPass.texture);
      }
      this.cloudsPass = new EffectPass(this.camera, ...this.cloudEffects);
      this.composer.addPass(this.cloudsPass);
    } else {
      this.depthPass.enabled = false;
    }

    this.effectPass = new EffectPass(this.camera, ...otherEffects, this.createToneMapping());
    this.composer.addPass(this.effectPass);

    this.composer.addPass(this.smaaPass);
  }

  render(): void {
    this.composer.render();
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height);
    // The DepthPass recreates/resizes its target on setSize, so re-bind the clouds' depth texture.
    if (this.cloudEffects.length > 0) {
      for (const clouds of this.cloudEffects) {
        clouds.setDepthTexture(this.depthPass.texture);
      }
    }
  }

  dispose(): void {
    this.composer.dispose();
  }
}
