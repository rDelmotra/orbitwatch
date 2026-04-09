varying float vSelected;

void main() {
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c);
  if (d > 0.5) discard;

  // Cyan/teal: #00BCD4 = (0.0, 0.737, 0.831)
  vec3 color = vSelected > 0.5 ? vec3(0.4, 0.95, 1.0) : vec3(0.0, 0.737, 0.831);

  // Bright core + outer glow ring
  float core = 1.0 - smoothstep(0.0, 0.25, d);
  float ring = smoothstep(0.28, 0.34, d) * (1.0 - smoothstep(0.42, 0.50, d));
  float alpha = core * 0.95 + ring * 0.65;

  if (vSelected > 0.5) alpha = min(alpha * 1.3, 1.0);

  gl_FragColor = vec4(color, alpha);
}
