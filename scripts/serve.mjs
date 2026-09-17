import { createServer } from './server.mjs';
const port = Number(process.env.PORT || 4173);
const origin = process.env.MORI_POC_ORIGIN || `http://localhost:${port}`;
const server = createServer({ origin, apiBaseUrl: process.env.MORI_API_BASE_URL || 'http://localhost:8000' });
server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `Port ${port} is in use. Set PORT and the matching backend callback URL.` : 'Cannot start the preview server.'); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Mori preview: ${origin}`));
