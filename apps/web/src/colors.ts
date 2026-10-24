// Normalized difference, then RGB. Keep the shader and legend on the same scale.
// Dark at zero so near-normal areas recede; lightness rises steadily towards both extremes.
const stops = [
  [-1, 36, 84, 122],
  [-0.5, 86, 148, 170],
  [-0.2, 170, 206, 206],
  [0, 238, 233, 220],
  [0.2, 234, 206, 160],
  [0.5, 210, 140, 90],
  [1, 150, 64, 46],
] as const;

export const temperatureGradient = `linear-gradient(90deg, ${stops
  .map(([value, r, g, b]) => `rgb(${r} ${g} ${b}) ${((value + 1) * 100) / 2}%`)
  .join(", ")})`;

const rgb = (stop: (typeof stops)[number]) =>
  `vec3(${stop
    .slice(1)
    .map((value) => (value / 255).toFixed(7))
    .join(", ")})`;

export const temperatureColorShader = `
vec3 temperatureColor(float value) {
${stops
  .slice(1)
  .map((stop, index) => {
    const previous = stops[index]!;
    return `  if (value <= ${stop[0].toFixed(2)}) return mix(${rgb(previous)}, ${rgb(stop)},
    clamp((value - (${previous[0].toFixed(2)})) / ${(stop[0] - previous[0]).toFixed(2)}, 0., 1.));`;
  })
  .join("\n")}
  return ${rgb(stops[stops.length - 1]!)};
}`;

/** CSS colour for a normalized difference, matching the shader. */
export function temperatureCss(value: number) {
  const clamped = Math.max(-1, Math.min(1, value));
  const index = Math.max(
    1,
    stops.findIndex(([stop]) => clamped <= stop),
  );
  const [from, r0, g0, b0] = stops[index - 1]!;
  const [to, r1, g1, b1] = stops[index]!;
  const t = (clamped - from) / (to - from);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(r0, r1)} ${mix(g0, g1)} ${mix(b0, b1)})`;
}
