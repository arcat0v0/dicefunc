export interface RuntimeLogger {
  debug(event: LogEvent): void;
  info(event: LogEvent): void;
  warn(event: LogEvent): void;
  error(event: LogEvent): void;
}

export interface LogEvent {
  readonly schemaVersion: number;
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly component: string;
  readonly environment: string;
  readonly requestId?: string;
  readonly executionId?: string;
  readonly jobId?: string;
  readonly outcome?: string;
  readonly errorCode?: string;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly httpStatus?: number;
  readonly metadata?: Record<string, unknown>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const DEFAULT_LOGGER_CONFIG = {
  schemaVersion: 1,
  level: 'info' as const,
  allowProductionDebug: false,
  maxEntryBytes: 8192,
  normalEventSampleRate: 1
};

export function createRuntimeLogger(
  config: typeof DEFAULT_LOGGER_CONFIG
): RuntimeLogger {
  return {
    debug: (event: LogEvent) => {
      if (!config.allowProductionDebug) return;
      log('debug', event);
    },
    info: (event: LogEvent) => log('info', event),
    warn: (event: LogEvent) => log('warn', event),
    error: (event: LogEvent) => log('error', event)
  };
}

function log(level: LogLevel, event: LogEvent): void {
  const sanitized = sanitizeEvent(event);
  console[logLevelToConsoleMethod(level)](JSON.stringify(sanitized));
}

function sanitizeEvent(event: LogEvent): LogEvent {
  const sanitized = { ...event };
  
  if (sanitized.metadata) {
    sanitized.metadata = redactSensitiveData(sanitized.metadata);
  }
  
  const entryString = JSON.stringify(sanitized);
  if (entryString.length > 8192) {
    sanitized.metadata = sanitized.metadata || {};
    sanitized.metadata.truncated = true;
  }
  
  return sanitized;
}

function redactSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['secret', 'token', 'password', 'key', 'auth'];
  const result: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      result[key] = redactString(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

function redactString(str: string): string {
  const patterns = [
    /Bearer\s+[a-zA-Z0-9_-]+/g,
    /[a-f0-9]{32,}/g,
    /\d{10,}/g
  ];
  
  let result = str;
  for (const pattern of patterns) {
    result = result.replace(pattern, '[REDACTED]');
  }
  
  return result;
}

function logLevelToConsoleMethod(level: LogLevel): keyof Console {
  switch (level) {
    case 'debug':
      return 'debug';
    case 'info':
      return 'log';
    case 'warn':
      return 'warn';
    case 'error':
      return 'error';
  }
}
