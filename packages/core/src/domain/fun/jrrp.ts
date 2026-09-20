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

export function formatJrrpComment(jrrp: number): string {
  if (jrrp > 95) {
    return '人品爆表！';
  }
  if (jrrp > 80) {
    return '运气还不错！';
  }
  if (jrrp > 50) {
    return '人品还行吧';
  }
  if (jrrp > 10) {
    return '今天不太行';
  }
  return '流年不利啊！';
}

export function formatJrrpReply(actorName: string, jrrp: number): string {
  return `${actorName} 今日人品为${jrrp}，${formatJrrpComment(jrrp)}`;
}
