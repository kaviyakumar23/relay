import http from 'node:http';
import { config } from './config';
import { logger } from './lib/logger';

// Walking-skeleton placeholder (commit 1): a bare /healthz so Docker, the ALB
// health check, and UptimeRobot have a target from day one. Phase C replaces
// this with the Bolt app (Socket Mode locally, HTTP mode on AWS) which serves
// the same /healthz via customRoutes.
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'relay' }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(config.port, () => {
  logger.info({ port: config.port }, 'relay placeholder server up');
});
