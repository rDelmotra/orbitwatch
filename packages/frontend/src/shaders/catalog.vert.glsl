attribute vec3 previousPosition;
attribute vec3 currentPosition;
attribute vec3 color;
attribute float size;
attribute vec3 pickId;

uniform float uPixelRatio;
uniform float uCameraDistance;
uniform vec3 uBaseColor;
uniform float uT;

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
  gl_PointSize = (3.0 * uPixelRatio * size) / dist * uCameraDistance;
  gl_PointSize = clamp(gl_PointSize, 1.5, 20.0);

  vColor = color * uBaseColor;
  vPickId = pickId;
}
