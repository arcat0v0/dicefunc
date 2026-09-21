export function computeJrrp(userId: string, date: Date = new Date()): number {
  const utcMillis = date.getTime();
  const utc8Millis = utcMillis + 8 * 60 * 60 * 1000;
  const dayNumber = Math.floor(utc8Millis / (24 * 60 * 60 * 1000));

  let hash = 0x811c9dc5;
  const str = `${userId}:${dayNumber}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  const positiveHash = Math.abs(hash);
  return (positiveHash % 100) + 1;
}
