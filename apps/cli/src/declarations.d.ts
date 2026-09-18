declare module 'js-yaml' {
  export interface LoadOptions {
    filename?: string | undefined;
    onWarning?(this: null, e: Error): void;
    schema?: unknown;
    json?: boolean | undefined;
    listener?(this: null, op: string, state: unknown): void;
  }
  export function load(str: string, opts?: LoadOptions): unknown;
  export const DEFAULT_SCHEMA: unknown;
}

declare module '@dicefunc/core' {
  export interface RandomSource {
    integer(minInclusive: number, maxInclusive: number): number;
  }
  export type KeepDropType = 'kl' | 'kh' | 'dl' | 'dh';
  export function createWebCryptoRandomSource(): RandomSource;
  export function rollDice(faces: number, count: number, randomSource: RandomSource): number[];
  export function applyKeepDrop(
    rolls: number[],
    keepDropType: KeepDropType,
    count: number,
  ): number[];
  export interface ParsedDiceExpression {
    readonly type: string;
    readonly faces: number;
    readonly count: number;
    readonly keepDrop?: KeepDropType | undefined;
    readonly keepCount?: number | undefined;
    readonly modifier?: number | undefined;
    readonly reason?: string | undefined;
  }
  export function parseDiceExpression(expression: string): {
    success: boolean;
    expression?: ParsedDiceExpression | undefined;
    error?: string | undefined;
  };
}
