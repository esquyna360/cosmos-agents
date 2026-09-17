/** "agora", "5 min", "3 h", "2 d", then a date. Input is unix seconds. */
export function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return "";
  const diff = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (diff < 60) return "agora";
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 86_400 * 7) return `${Math.floor(diff / 86_400)} d`;
  return new Date(unixSeconds * 1000).toLocaleDateString("pt-BR", {
    day: "numeric",
    month: "short",
  });
}
