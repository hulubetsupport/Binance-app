import path from 'node:path';
import express from 'express';
import { createExpressApp } from './server/app.ts';
import { loadConfig } from './server/config.ts';
import { createDatabase } from './server/db.ts';

async function main() {
  const config = loadConfig();
  const db = await createDatabase(config);
  const { app, botRuntime, startExpiryWorker } = createExpressApp(db, config);

  // Serve standalone GitHub Pages files (/docs) for direct verification & dual deployment
  const docsDir = path.resolve(process.cwd(), 'docs');
  app.use('/gh-pages', express.static(docsDir));

  if (!config.isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const expiryTimer = startExpiryWorker();
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`EthioP2P Marketplace server running on http://0.0.0.0:${config.port}`);
    botRuntime.setupWebhook().catch(() => {});
  });

  const shutdown = async () => {
    clearInterval(expiryTimer);
    server.close();
    await db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
