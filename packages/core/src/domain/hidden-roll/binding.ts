import type { RandomSource } from '../../ports/random-source.js';

export interface HiddenRollLinkChallenge {
  readonly id: string;
  readonly c2cPrincipalId: string;
  readonly userOpenid: string;
  readonly version: number;
  readonly expiresAt: Date;
  readonly activeMessagesEnabled: boolean;
}

export interface HiddenRollBinding {
  readonly id: string;
  readonly groupScopeId: string;
  readonly groupPrincipalId: string;
  readonly c2cPrincipalId: string;
  readonly userOpenid: string;
  readonly activeMessagesEnabled: boolean;
  readonly version: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashHiddenRollLinkToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createHiddenRollLinkToken(
  random: RandomSource,
): Promise<{ readonly token: string; readonly tokenHash: string }> {
  const token = bytesToBase64Url(await random.bytes(32));
  return {
    token,
    tokenHash: await hashHiddenRollLinkToken(token),
  };
}

export function isHiddenRollLinkToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
