import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pg from 'pg';
import { config } from '../config';
import { buildHermeticAssembly, injectIntake } from '../demo/driver';
import { NeedService } from '../ledger/needService';
import { PostgresEventStore } from '../ledger/store/postgresStore';
import { createRelayMcpServer } from './server';
import type { NeedReadPort } from './tools';

// CLI entrypoint for the Relay read-only MCP server (`npm run mcp`), so Claude Desktop (or
// any stdio MCP client) can query live relief operations. stdout is the MCP wire — ALL logs
// go to console.error (never stdout, never the pino `logger`, which writes to stdout and
// would corrupt the protocol stream).
//
// Store selection degrades gracefully: PostgresEventStore when DATABASE_URL is set (the real
// hosted ledger), otherwise an in-memory store seeded with the hermetic demo flood so the
// Claude Desktop demo has live, is_demo-flagged data with zero env.

/** A resolved read model + a reference clock + a cleanup hook. */
interface ReadModel {
  service: NeedReadPort;
  now: () => number;
  mode: string;
  close: () => Promise<void>;
}

/** A handful of intake messages to seed the offline demo ledger (mirrors the flood demo). */
const DEMO_INTAKE: readonly string[] = [
  'Terrace flooded in Velachery, family of four needs drinking water and food',
  'Dialysis patient stranded near Taramani, needs transport to hospital urgently',
  'Elderly couple trapped on the first floor in Pallikaranai as water rises',
  'Shelter running low on baby formula and blankets in Adyar',
];

async function buildReadModel(): Promise<ReadModel> {
  if (config.databaseUrl !== '') {
    const pool = new pg.Pool({ connectionString: config.databaseUrl });
    const store = new PostgresEventStore({ pool });
    await store.init();
    const service = new NeedService(store);
    const readModel: NeedReadPort = {
      listNeeds: (now) => service.listNeeds(now),
      getPublicId: (needId) => store.getPublicId(needId),
    };
    return {
      service: readModel,
      now: () => Date.now(),
      mode: 'postgres (live ledger)',
      close: () => pool.end(),
    };
  }

  // Offline: seed the hermetic assembly so the demo has real ledger data with zero env. The
  // assembly's clock is fixed at `base`, so a snapshot taken at `base` is stable & consistent.
  const base = Date.now();
  const assembly = buildHermeticAssembly({ baseClockMs: base });
  for (let i = 0; i < DEMO_INTAKE.length; i += 1) {
    const text = DEMO_INTAKE[i];
    if (text === undefined) continue;
    await injectIntake(assembly, {
      eventId: `mcp-seed-${i}`,
      messageTs: `${Math.floor(base / 1000)}.${String(i).padStart(6, '0')}`,
      userId: `demo_reporter_${i}`,
      text,
    });
  }
  const readModel: NeedReadPort = {
    listNeeds: (now) => assembly.service.listNeeds(now),
    getPublicId: (needId) => assembly.store.getPublicId(needId),
  };
  return {
    service: readModel,
    now: () => base,
    mode: 'memory (hermetic demo seed)',
    close: async () => {},
  };
}

async function main(): Promise<void> {
  const readModel = await buildReadModel();
  const server = createRelayMcpServer({ service: readModel.service, now: readModel.now });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[relay-mcp] read-only MCP server connected over stdio · store: ${readModel.mode} · ` +
      'tools: search_needs, get_need, get_sitrep',
  );

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.error(`[relay-mcp] ${signal} received, shutting down`);
    try {
      await server.close();
      await readModel.close();
    } catch (err) {
      console.error('[relay-mcp] shutdown error', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[relay-mcp] fatal', err);
  process.exit(1);
});
