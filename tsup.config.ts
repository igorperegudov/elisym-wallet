import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      keystore: 'src/keystore.ts',
      mcp: 'src/mcp.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
  },
  {
    entry: { cli: 'src/cli-entry.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    treeshake: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
