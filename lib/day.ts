/**
 * The listener's own calendar day, as YYYY-MM-DD. The daily budget resets at
 * local midnight wherever the listener is, not at midnight UTC.
 */
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
