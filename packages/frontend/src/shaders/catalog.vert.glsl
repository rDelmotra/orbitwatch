attribute vec3 previousPosition;
attribute vec3 currentPosition;
attribute vec3 color;
attribute float size;
attribute vec3 pickId;

uniform float uPixelRatio;
uniform float uCameraDistance;
uniform vec3 uBaseColor;
uniform float uT;
uniform float uSelectedIndex;    // -1.0 = no selection
uniform float uTimeSinceArrival; // seconds since camera arrived; -1.0 = no pulse

varying vec3 vColor;
varying vec3 vPickId;

void main() {
  if (size < 0.01) {
    gl_Position = vec4(0.0, 0.0, -999.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  vec3 lerpedPos = mix(previousPosition, currentPosition, uT);
  vec4 viewPos = modelViewMatrix * vec4(lerpedPos, 1.0);
  gl_Position = projectionMatrix * viewPos;

  float dist = length(viewPos.xyz);
  float pointSize = (3.0 * uPixelRatio * size) / dist * uCameraDistance;

  // gl_VertexID is available in WebGL 2 / GLSL ES 3.00 (Three.js r165+)
  bool isSelected = uSelectedIndex >= 0.0 && abs(float(gl_VertexID) - uSelectedIndex) < 0.5;

  if (isSelected) {
    float sizeBoost = 2.5;

    // Triple pulse: 3 cycles over 1.5 seconds (2 Hz → ω = 4π ≈ 12.566)
    if (uTimeSinceArrival >= 0.0 && uTimeSinceArrival < 1.5) {
      float pulse = sin(uTimeSinceArrival * 12.566);
      sizeBoost = 2.5 + 1.5 * pulse; // oscillates [1.0, 4.0]
    }

    pointSize *= max(sizeBoost, 1.0);
    vColor = vec3(0.0, 0.898, 1.0); // cyan override for selected object
  } else {
    vColor = color * uBaseColor;
  }

  gl_PointSize = clamp(pointSize, 1.5, 20.0);
  vPickId = pickId;
}
