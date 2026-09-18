export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  readonly schemaVersion: number;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly component: string;
  readonly environment: string;
  readonly requestId?: string | undefined;
  readonly executionId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly outcome?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly attempt?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly httpStatus?: number | undefined;
  readonly metadata?: Record<string, number | boolean | string> | undefined;
}

const METADATA_STRING_REGEX = /^[A-Za-z0-9_.:-]+$/;

export function isValidMetadataValue(value: unknown): value is number | boolean | string {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'string') {
    return value.length <= 128 && METADATA_STRING_REGEX.test(value);
  }
  return false;
}

export function buildLogEntry(input: {
  readonly schemaVersion?: number | undefined;
  readonly timestamp?: string | undefined;
  readonly level: LogLevel;
  readonly event: string;
  readonly component: string;
  readonly environment: string;
  readonly requestId?: string | undefined;
  readonly executionId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly outcome?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly attempt?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly httpStatus?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): LogEvent {
  let filteredMetadata: Record<string, number | boolean | string> | undefined;

  if (input.metadata) {
    const validEntries: Record<string, number | boolean | string> = {};
    for (const [key, value] of Object.entries(input.metadata)) {
      if (isValidMetadataValue(value)) {
        validEntries[key] = value;
      }
    }
    if (Object.keys(validEntries).length > 0) {
      filteredMetadata = validEntries;
    }
  }

  const result: {
    schemaVersion: number;
    timestamp: string;
    level: LogLevel;
    event: string;
    component: string;
    environment: string;
    requestId?: string | undefined;
    executionId?: string | undefined;
    jobId?: string | undefined;
    outcome?: string | undefined;
    errorCode?: string | undefined;
    attempt?: number | undefined;
    durationMs?: number | undefined;
    httpStatus?: number | undefined;
    metadata?: Record<string, number | boolean | string> | undefined;
  } = {
    schemaVersion: input.schemaVersion ?? 1,
    timestamp: input.timestamp ?? new Date().toISOString(),
    level: input.level,
    event: input.event,
    component: input.component,
    environment: input.environment,
  };

  if (input.requestId !== undefined) result.requestId = input.requestId;
  if (input.executionId !== undefined) result.executionId = input.executionId;
  if (input.jobId !== undefined) result.jobId = input.jobId;
  if (input.outcome !== undefined) result.outcome = input.outcome;
  if (input.errorCode !== undefined) result.errorCode = input.errorCode;
  if (input.attempt !== undefined) result.attempt = input.attempt;
  if (input.durationMs !== undefined) result.durationMs = input.durationMs;
  if (input.httpStatus !== undefined) result.httpStatus = input.httpStatus;
  if (filteredMetadata !== undefined) result.metadata = filteredMetadata;

  return result;
}

type MutableLogEvent = {
  -readonly [K in keyof LogEvent]?: LogEvent[K];
};

export function serializeLogEntry(entry: LogEvent, maxBytes = 8192): string | null {
  const encoder = new TextEncoder();
  const initialString = JSON.stringify(entry);
  if (encoder.encode(initialString).length <= maxBytes) {
    return initialString;
  }

  if (entry.metadata) {
    const metaCopy: Record<string, number | boolean | string> = { ...entry.metadata };
    const keys = Object.keys(metaCopy);

    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i];
      if (key === undefined) {
        continue;
      }
      delete metaCopy[key];

      const candidateObj: MutableLogEvent = { ...entry };
      if (Object.keys(metaCopy).length > 0) {
        candidateObj.metadata = metaCopy;
      } else {
        candidateObj.metadata = undefined;
      }

      const candidateStr = JSON.stringify(candidateObj);
      if (encoder.encode(candidateStr).length <= maxBytes) {
        return candidateStr;
      }
    }

    const stripped: MutableLogEvent = { ...entry };
    stripped.metadata = undefined;
    const strippedStr = JSON.stringify(stripped);
    if (encoder.encode(strippedStr).length <= maxBytes) {
      return strippedStr;
    }
  }

  return null;
}

export interface RuntimeLogger {
  log(entry: LogEvent): boolean;
  child(fields: Partial<LogEvent>): RuntimeLogger;
}
