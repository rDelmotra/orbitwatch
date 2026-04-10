import * as THREE from 'three';

export class VisualPassTrailsRenderer {
  private scene: THREE.Scene;
  private lineSegments: THREE.LineSegments | null = null;
  private points: THREE.Points | null = null;
  private lineGeometry: THREE.BufferGeometry | null = null;
  private pointGeometry: THREE.BufferGeometry | null = null;
  private lineMaterial: THREE.LineBasicMaterial;
  private pointMaterial: THREE.PointsMaterial;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.lineMaterial = new THREE.LineBasicMaterial({
      color: 0x00bcd4,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      depthTest: true,
    });
    this.pointMaterial = new THREE.PointsMaterial({
      color: 0x00bcd4,
      transparent: true,
      opacity: 0.22,
      size: 0.004,
      sizeAttenuation: true,
      depthWrite: false,
      depthTest: true,
    });
  }

  setTrails(trailsTeme: Float32Array[]): void {
    if (trailsTeme.length === 0) {
      this.clear();
      return;
    }

    const segmentCoords: number[] = [];
    const pointCoords: number[] = [];

    for (const trail of trailsTeme) {
      const pointCount = Math.floor(trail.length / 3);
      if (pointCount < 2) {
        continue;
      }

      let prevX = trail[0];
      let prevY = trail[1];
      let prevZ = trail[2];
      pointCoords.push(prevX, prevZ, -prevY);

      for (let i = 1; i < pointCount; i++) {
        const i3 = i * 3;
        const x = trail[i3];
        const y = trail[i3 + 1];
        const z = trail[i3 + 2];

        // TEME -> Three.js axis swap (x, z, -y)
        segmentCoords.push(
          prevX, prevZ, -prevY,
          x, z, -y,
        );
        pointCoords.push(x, z, -y);

        prevX = x;
        prevY = y;
        prevZ = z;
      }
    }

    if (segmentCoords.length === 0 || pointCoords.length === 0) {
      this.clear();
      return;
    }

    this.clear();

    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(segmentCoords), 3),
    );
    this.lineSegments = new THREE.LineSegments(this.lineGeometry, this.lineMaterial);
    this.lineSegments.frustumCulled = false;
    this.lineSegments.renderOrder = 2;
    this.scene.add(this.lineSegments);

    this.pointGeometry = new THREE.BufferGeometry();
    this.pointGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(pointCoords), 3),
    );
    this.points = new THREE.Points(this.pointGeometry, this.pointMaterial);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.scene.add(this.points);
  }

  clear(): void {
    if (this.lineSegments) {
      this.scene.remove(this.lineSegments);
      this.lineSegments = null;
    }
    if (this.points) {
      this.scene.remove(this.points);
      this.points = null;
    }
    if (this.lineGeometry) {
      this.lineGeometry.dispose();
      this.lineGeometry = null;
    }
    if (this.pointGeometry) {
      this.pointGeometry.dispose();
      this.pointGeometry = null;
    }
  }

  dispose(): void {
    this.clear();
    this.lineMaterial.dispose();
    this.pointMaterial.dispose();
  }
}
