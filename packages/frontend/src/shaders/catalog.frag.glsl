varying vec3 vColor;
varying float vDistanceFade;

void main() {
  // gl_PointCoord goes from (0,0) to (1,1) across the point quad
  // We want a circle centered at (0.5, 0.5)
  vec2 center = gl_PointCoord - vec2(0.5);
  float dist = length(center);

  // Discard pixels outside the circle
  if (dist > 0.5) discard;

  // Soft edge: hard center, fades out
  float alpha = (1.0 - smoothstep(0.2, 0.5, dist)) * 0.92 * vDistanceFade;

  // Slight brightness boost at center for glow feel
  float glow = 0.92 + 0.25 * (1.0 - smoothstep(0.0, 0.25, dist));

  gl_FragColor = vec4(vColor * glow, alpha);
}
