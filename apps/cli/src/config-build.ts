import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';

export const buildConfig = new Command()
  .name('build')
  .description('Build configuration into optimized format')
  .option('-d, --dir <path>', 'Configuration directory', './config')
  .option('-o, --output <path>', 'Output directory', './dist/config')
  .action(async (options) => {
    console.log(`Building configuration from: ${options.dir}`);
    console.log(`Output to: ${options.output}`);
    
    try {
      // Create output directory
      if (!fs.existsSync(options.output)) {
        fs.mkdirSync(options.output, { recursive: true });
      }
      
      // Read all YAML files
      const yamlFiles = readYamlFiles(options.dir);
      
      for (const file of yamlFiles) {
        const content = fs.readFileSync(file.path, 'utf-8');
        const data = JSON.parse(content);
        
        // Write compiled config
        const outputFile = path.join(
          options.output,
          `${file.relativePath}.json`
        );
        
        const outputDir = path.dirname(outputFile);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        
        fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
        console.log(`✓ ${file.relativePath} -> ${path.basename(outputFile)}`);
      }
      
      console.log(`\n构建完成：${yamlFiles.length} 个文件已编译`);
      
    } catch (error) {
      console.error('配置编译失败:', error);
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
