export function formatAudioTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function parseAudioTime(value: string): number {
  if (!/^\d{2}:[0-5]\d:[0-5]\d$/.test(value)) return NaN;
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}
