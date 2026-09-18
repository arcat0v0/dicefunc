import * as yaml from 'js-yaml';
import { load } from 'js-yaml';

export interface ConfigCompilerOptions {
  strict?: boolean;
  allowUnknownFields?: boolean;
}

export interface CompiledConfig {
  readonly schemaVersion: number;
  readonly data: Record<string, unknown>;
  readonly digest: string;
}

export class ConfigCompiler {
  private options: ConfigCompilerOptions;
  
  constructor(options?: ConfigCompilerOptions) {
    this.options = {
      strict: true,
      allowUnknownFields: false,
      ...options
    };
  }
  
  compile(filePath: string, content: string): CompiledConfig {
    // Parse YAML
    let data: unknown;
    
    try {
      data = load(content, {
        schema: yaml.DEFAULT_SCHEMA,
        json: true
      });
    } catch (error) {
      throw new Error(`Failed to parse YAML in ${filePath}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    if (typeof data !== 'object' || data === null) {
      throw new Error(`Invalid config structure in ${filePath}`);
    }
    
    // Validate schema version
    const configData = data as Record<string, unknown>;
    if (!('schemaVersion' in configData)) {
      throw new Error(`Missing schemaVersion in ${filePath}`);
    }
    
    if (typeof configData.schemaVersion !== 'number') {
      throw new Error(`Invalid schemaVersion type in ${filePath}`);
    }
    
    // Calculate digest
    const digest = this.calculateDigest(content);
    
    return {
      schemaVersion: configData.schemaVersion,
      data: configData,
      digest
    };
  }
  
  private calculateDigest(content: string): string {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    
    return crypto.subtle.digest('SHA-256', data)
      .then(hash => Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(''));
  }
  
  mergeConfigs(...configs: CompiledConfig[]): CompiledConfig {
    if (configs.length === 0) {
      throw new Error('Cannot merge empty configs');
    }
    
    const merged: Record<string, unknown> = {};
    let maxSchemaVersion = 0;
    
    for (const config of configs) {
      if (config.schemaVersion > maxSchemaVersion) {
        maxSchemaVersion = config.schemaVersion;
      }
      
      Object.assign(merged, config.data);
    }
    
    return {
      schemaVersion: maxSchemaVersion,
      data: merged,
      digest: this.calculateDigest(JSON.stringify(merged))
    };
  }
}

export function createConfigCompiler(options?: ConfigCompilerOptions): ConfigCompiler {
  return new ConfigCompiler(options);
}
