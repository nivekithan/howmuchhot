// Normalized difference, then RGB. Keep the shader and legend on the same scale.
const stops = [
  [-1, 94, 60, 153],
  [-0.5, 50, 136, 189],
  [-0.2, 135, 216, 223],
  [0, 246, 243, 223],
  [0.2, 254, 224, 139],
  [0.5, 244, 109, 67],
  [1, 165, 0, 38],
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
