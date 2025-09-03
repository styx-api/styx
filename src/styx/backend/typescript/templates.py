from styx.ir import core as ir


def template_build_js():
    return """const esbuild = require('esbuild');
const { execSync } = require('child_process');

// Build for ESM
esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.esm.js',
  bundle: true,
  minify: true,
  platform: 'neutral',
  format: 'esm',
  sourcemap: true,
  target: ['es2020']
}).catch(() => process.exit(1));

// Build for CommonJS
esbuild.build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.cjs.js',
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: true,
  target: ['es2020']
}).catch(() => process.exit(1));

// Generate type definitions
try {
  execSync('tsc --noCheck --emitDeclarationOnly --outDir dist/types', { 
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8' 
  });
  console.log('TypeScript declarations generated successfully');
} catch (error) {
  console.error('TypeScript compilation failed:');
  console.error(error)

  if (error.stdout) {
    console.error(error.stdout);
  }

  if (error.stderr) {
    console.error(error.stderr);
  }

  process.exit(1);
}"""


def template_package_json(project: ir.Project):
    description = (
        project.docs.description
        if project.docs.description
        else f"Styx generated wrappers for {project.docs.title or project.name}."
    )

    return f"""{{
  "name": "{project.name}",
  "version": "{project.version}",
  "description": "{description}",
  "main": "dist/index.cjs.js",
  "module": "dist/index.esm.js",
  "types": "dist/types/index.d.ts",
  "exports": {{
    ".": {{
      "types": "./dist/types/index.d.ts",
      "import": "./dist/index.esm.js",
      "require": "./dist/index.cjs.js",
      "default": "./dist/index.cjs.js"
    }}
  }},
  "files": [
    "dist"
  ],
  "scripts": {{
    "build": "node build.js",
    "prepublishOnly": "npm run build"
  }},
  "keywords": [],
  "author": "",
  "license": "{project.license or "unknown"}",
  "dependencies": {{
    "styxdefs": "^0.1.0"
  }},
  "devDependencies": {{
    "esbuild": "^0.25.0",
    "esbuild-node-externals": "^1.18.0",
    "npm-dts": "^1.3.13",
    "typescript": "^5.7.0"
  }}
}}"""


def template_tsconfig_json():
    return """{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "declaration": true,
    "declarationDir": "./dist/types",
    "outDir": "./dist",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": [
    "src/**/*"
  ],
  "exclude": [
    "node_modules",
    "dist",
  ]
}"""
