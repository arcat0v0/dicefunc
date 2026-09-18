export type PolicyScope = 'bot' | 'group' | 'user';

export interface PolicyEntry {
  readonly id: string;
  readonly scope: PolicyScope;
  readonly principalId?: string | undefined;
  readonly groupIds?: readonly string[] | undefined;
  readonly effect: 'deny' | 'trust';
  readonly reason?: string | undefined;
  readonly version: number;
}

export function createPolicyEntry(
  id: string,
  input: {
    readonly scope: PolicyScope;
    readonly effect: 'deny' | 'trust';
    readonly principalId?: string | undefined;
    readonly groupIds?: readonly string[] | undefined;
    readonly reason?: string | undefined;
    readonly version?: number | undefined;
  },
): PolicyEntry {
  const entry: {
    id: string;
    scope: PolicyScope;
    effect: 'deny' | 'trust';
    version: number;
    principalId?: string | undefined;
    groupIds?: readonly string[] | undefined;
    reason?: string | undefined;
  } = {
    id,
    scope: input.scope,
    effect: input.effect,
    version: input.version ?? 1,
  };

  if (input.principalId !== undefined) {
    entry.principalId = input.principalId;
  }
  if (input.groupIds !== undefined) {
    entry.groupIds = input.groupIds;
  }
  if (input.reason !== undefined) {
    entry.reason = input.reason;
  }

  return entry;
}
