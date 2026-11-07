import { defineConfig } from 'vite';
import { env } from 'node:process';
export default defineConfig({
  base: './', build: { target: 'es2022', sourcemap: false }, server: { port: 5173, strictPort: true },
  plugins: [{ name:'local-api-config', configureServer(server) {
    if (!env.PPI_LOCAL_API_URL) return;
    server.middlewares.use((request,response,next)=>{
      if (request.url?.split('?')[0] !== '/config.json') return next();
      response.setHeader('Content-Type','application/json'); response.setHeader('Cache-Control','no-store');
      response.end(JSON.stringify({apiUrl:env.PPI_LOCAL_API_URL,turnstileSiteKey:''}));
    });
  } }]
});
