import { RuntimeLogger, LogEvent, LogLevel, DEFAULT_LOGGER_CONFIG } from '../../core/src/ports/runtime-logger';

export class CloudflareRuntimeLogger implements RuntimeLogger {
  private config: typeof DEFAULT_LOGGER_CONFIG;
  
  constructor(config?: typeof DEFAULT_LOGGER_CONFIG) {
    this.config = config || { ...DEFAULT_LOGGER_CONFIG };
  }

  debug(event: LogEvent): void {
    if (!this.config.allowProductionDebug) return;
    this.log('debug', event);
  }

  info(event: LogEvent): void {
    this.log('info', event);
  }

  warn(event: LogEvent): void {
    this.log('warn', event);
  }

  error(event: LogEvent): void {
    this.log('error', event);
  }

  updateConfig(newConfig: typeof DEFAULT_LOGGER_CONFIG): void {
    this.config = { ...newConfig };
  }

  private log(level: LogLevel, event: LogEvent): void {
    const sanitized = this.sanitizeEvent(event);
    const entryString = JSON.stringify(sanitized);
    
    // Truncate if too long
    if (entryString.length > 8192) {
      sanitized.metadata = sanitized.metadata || {};
      sanitized.metadata.truncated = true;
    }
    
    console[this.logLevelToConsoleMethod(level)](JSON.stringify(sanitized));
  }

  private sanitizeEvent(event: LogEvent): LogEvent {
    const sanitized = { ...event };
    
    if (sanitized.metadata) {
      sanitized.metadata = this.redactSensitiveData(sanitized.metadata);
    }
    
    return sanitized;
  }

  private redactSensitiveData(data: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['secret', 'token', 'password', 'key', 'auth', 'credential'];
    const result: Record<string, unknown> = {};
    
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      
      if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        result[key] = this.redactString(value);
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.redactSensitiveData(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    
    return result;
  }

  private redactString(str: string): string {
    const patterns = [
      /Bearer\s+[a-zA-Z0-9_-]+/g,
      /[a-f0-9]{32,}/g,
      /\d{10,}/g,
      /QQ_APP_SECRET.*$/gm
    ];
    
    let result = str;
    for (const pattern of patterns) {
      result = result.replace(pattern, '[REDACTED]');
    }
    
    return result;
  }

  private logLevelToConsoleMethod(level: LogLevel): keyof Console {
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
}

export function createRuntimeLogger(
  config?: typeof DEFAULT_LOGGER_CONFIG
): RuntimeLogger {
  return new CloudflareRuntimeLogger(config);
}
