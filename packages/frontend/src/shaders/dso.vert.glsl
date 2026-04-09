attribute vec3 currentPosition;
attribute float size;
attribute vec3 pickId;

uniform float uPixelRatio;
uniform float uSelectedDsoIndex;

varying vec3 vPickId;
varying float vSelected;

void main() {
  vPickId = pickId;

  bool isSelected = uSelectedDsoIndex >= 0.0 && abs(float(gl_VertexID) - uSelectedDsoIndex) < 0.5;
  vSelected = isSelected ? 1.0 : 0.0;

  if (size < 0.01) {
    gl_Position = vec4(0.0, 0.0, -999.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  gl_Position = projectionMatrix * modelViewMatrix * vec4(currentPosition, 1.0);

  // Always-visible: no distance fade. Selected objects get a size boost.
  float baseSize = isSelected ? size * 1.8 : size;
  gl_PointSize = max(baseSize * uPixelRatio, 5.0);
}
