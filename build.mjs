// пересборка интерфейса: node build.mjs  (нужен esbuild + react, react-dom)
import { build } from 'esbuild';
await build({ entryPoints: ['renderer/src/app.jsx'], bundle: true, outfile: 'renderer/renderer.js', minify: true, target: 'chrome120',
  define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic', loader: { '.jsx': 'jsx' } });
console.log('built renderer/renderer.js');
