export interface PolicyEntry {
  readonly id: string;
  readonly scope: PolicyScope;
  readonly principalId?: string;
  readonly groupIds?: string[];
  readonly action: 'deny' | 'trust';
  readonly reason?: string;
  readonly version: number;
}

export type PolicyScope = 'bot' | 'group' | 'user';

export interface RateBucket {
  readonly key: string;
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly lastReset: Date;
  readonly requestCount: number;
  readonly version: number;
}

export function createPolicyEntry(
  scope: PolicyScope,
  action: 'deny' | 'trust',
  principalId?: string,
  groupIds?: string[],
  reason?: string
): PolicyEntry {
  return {
    id: `policy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    scope,
    principalId,
    groupIds,
    action,
    reason,
    version: 1
  };
}

export function checkRateLimit(
  bucket: RateBucket,
  now: Date = new Date()
): { allowed: boolean; remaining: number } {
  const timeSinceLastReset = now.getTime() - bucket.lastReset.getTime();
  
  if (timeSinceLastReset >= bucket.windowMs) {
    return {
      allowed: true,
      remaining: bucket.maxRequests - 1
    };
  }
  
  const remaining = bucket.maxRequests - bucket.requestCount;
  return {
    allowed: bucket.requestCount < bucket.maxRequests,
    remaining
  };
}

export function recordRequest(bucket: RateBucket): void {
  bucket.requestCount++;
}
