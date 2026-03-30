attribute vec3 previousPosition;
attribute vec3 currentPosition;
attribute float size;
attribute vec3 pickId;

uniform float uPixelRatio;
uniform float uCameraDistance;
uniform float uT;

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
  float cameraScale = pow(max(uCameraDistance, 1.0), 0.55);
  float distAttenuation = pow(max(dist, 0.0001), 0.72);
  float pointSize = (2.9 * uPixelRatio * size * cameraScale) / distAttenuation;
  float logDist = log2(dist + 1.0);
  float sizeFade = 1.0 - smoothstep(log2(5.0), log2(140.0), logDist);
  float alphaFade = 1.0 - smoothstep(log2(6.0), log2(180.0), logDist);

  pointSize *= pow(max(sizeFade, 0.0), 0.82);
  if (pointSize < 0.16 || alphaFade < 0.01) {
    gl_Position = vec4(0.0, 0.0, -999.0, 1.0);
    gl_PointSize = 0.0;
    vPickId = pickId;
    return;
  }

  gl_PointSize = clamp(pointSize * 1.5, 0.65, 30.0);

  vPickId = pickId;
}
