attribute vec3 previousPosition;
attribute vec3 currentPosition;
attribute float size;
attribute vec3 pickId;

uniform float uPixelRatio;
uniform float uT;

varying vec3 vPickId;

void main() {
  vPickId = pickId;

  // Hide objects with no size (not yet loaded)
  if (size < 0.01) {
    gl_Position = vec4(0.0, 0.0, -999.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  vec3 pos = mix(previousPosition, currentPosition, uT);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

  // No distance fade — DSOs must remain pickable at any distance
  gl_PointSize = max(size * uPixelRatio * 1.5, 8.0);
}
