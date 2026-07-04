import { pino } from 'pino';
import { config } from '../config';

// Structured logs only. Raw Slack message text must NEVER be logged — pass
// derived fields (ids, types, counts). safeLog (Phase 2) enforces this at the
// call sites that handle intake content.
export const logger = pino({
  level: config.logLevel,
  base: { service: 'relay' },
});
