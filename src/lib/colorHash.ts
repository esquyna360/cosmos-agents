// Stable HSL color from a string. fnv1a-32 → hue. Saturation/lightness are
// fixed so the palette stays cohesive across the sidebar.
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function colorForPath(path: string): string {
  const hue = fnv1a(path) % 360;
  return `hsl(${hue} 62% 58%)`;
}
