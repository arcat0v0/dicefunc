import { Command } from 'commander';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { load } from 'js-yaml';

export const checkConfig = new Command()
  .name('check')
  .description('Check configuration files for errors')
  .option('-d, --dir <path>', 'Configuration directory', './config')
  .action(async (options) => {
    console.log(`Checking configuration in: ${options.dir}`);
    
    const errors: string[] = [];
    const warnings: string[] = [];
    
    try {
      // Check if directory exists
      if (!fs.existsSync(options.dir)) {
        console.error(`Error: Directory not found: ${options.dir}`);
        process.exit(1);
      }
      
      // Read and validate YAML files
      const files = readYamlFiles(options.dir);
      
      for (const file of files) {
        try {
          const content = fs.readFileSync(file.path, 'utf-8');
          const data = load(content, { 
            schema: yaml.DEFAULT_SCHEMA,
            json: true
          });
          
          // Basic schema validation
          if (!data.schemaVersion) {
            warnings.push(`${file.path}: Missing schemaVersion`);
          }
          
          if (typeof data.schemaVersion !== 'number') {
            errors.push(`${file.path}: Invalid schemaVersion type`);
          }
          
          console.log(`✓ ${file.relativePath}`);
        } catch (error) {
          errors.push(`${file.path}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      if (errors.length > 0) {
        console.error('\nErrors:');
        errors.forEach(e => console.error(`  ✗ ${e}`));
        process.exit(1);
      }
      
      if (warnings.length > 0) {
        console.warn('\nWarnings:');
        warnings.forEach(w => console.warn(`  ⚠ ${w}`));
      }
      
      console.log(`\n检查完成：${files.length} 个文件，${errors.length} 个错误，${warnings.length} 个警告`);
      
    } catch (error) {
      console.error('配置检查失败:', error);
      process.exit(1);
    }
  });

interface YamlFile {
  path: string;
  relativePath: string;
}

function readYamlFiles(dir: string): YamlFile[] {
  const files: YamlFile[] = [];
  
  function traverse(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = `${currentDir}/${entry.name}`;
      const relativePath = fullPath.replace(`${dir}/`, '');
      
      if (entry.isDirectory()) {
        traverse(fullPath);
      } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
        files.push({
          path: fullPath,
          relativePath
        });
      }
    }
  }
  
  traverse(dir);
  return files;
}
