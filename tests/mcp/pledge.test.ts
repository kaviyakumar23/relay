import { describe, expect, it } from 'vitest';
import { slaDueAtIso } from '../../src/drift/sla';
import { isEvent } from '../../src/ledger/events';
import { NeedService } from '../../src/ledger/needService';
import { InMemoryEventStore } from '../../src/ledger/store/memoryStore';
import { InMemoryVolunteerStore } from '../../src/match/volunteerStore';
import { agentVolunteerId } from '../../src/mcp-server/pledge';
import { createRelayTools, type RelayToolDeps, type ToolResult } from '../../src/mcp-server/tools';
import { agent, human, isoClock, system } from '../ledger/helpers';

// Moonshot #2 — "Relay holds AI agents accountable too." End-to-end coverage of the pledge_support
// write tool, exercised by DIRECT CALL against an in-memory NeedService + InMemoryVolunteerStore
// (no transport, no SDK server) so it is hermetic and proves the contract itself:
//   • writes disabled → a clear "writes disabled" result and ZERO ledger change.
//   • writes enabled → an AGENT-actor PledgeProposed is recorded, the need is NOT auto-claimed
//     (still awaiting a human), and the output is PII-free.
//   • an agent can NEVER self-assign past the human gate — only a human's Assigned commits it.
//   • after a human confirms (Assigned), the obligation drifts on the SAME SLA machinery as any
//     human promise — no parallel path.
//   • unknown need id → clean not-found; un-pledgeable state → a helpful message, no event.

const NOW = Date.parse('2026-07-06T02:00:00.000Z');
const PLEDGER = 'Chennai Food Bank agent';

/** Parse a tool result's single text block back into JSON. */
const payload = (r: ToolResult): Record<string, unknown> =>
  JSON.parse(r.content[0]?.text ?? 'null') as Record<string, unknown>;

/** Every key appearing anywhere in a (possibly nested) JSON value. */
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

const PII_MARKERS = ['contact', 'phone', 'mobile', 'address', 'email'];

/** Assert no key anywhere in the payload looks like beneficiary PII. */
function assertNoPii(value: unknown): void {
  for (const key of collectKeys(value)) {
    const lower = key.toLowerCase();
    for (const marker of PII_MARKERS) {
      expect(lower.includes(marker), `PII-looking key leaked: ${key}`).toBe(false);
    }
  }
}

interface Harness {
  svc: NeedService;
  store: InMemoryEventStore;
  volunteers: InMemoryVolunteerStore;
  needId: string;
  publicId: string;
  /** Build the tool surface with writes on/off (default on). */
  tools(opts?: { enabled?: boolean; withWrite?: boolean }): ReturnType<typeof createRelayTools>;
}

/** Seed a single OPEN food/high need (create → extract → human triage-confirm) and return a harness. */
async function seedOpenNeed(): Promise<Harness> {
  const store = new InMemoryEventStore();
  const svc = new NeedService(store, () => NOW);
  const volunteers = new InMemoryVolunteerStore();
  const at = isoClock(NOW - 3_600_000);

  const created = await svc.createNeed({
    source: { permalink: 'https://relay.demo/need-1' },
    actor: system('intake'),
    at: at(),
    idempotencyKey: 'need-1',
  });
  if (created.status !== 'created') throw new Error('seed create failed');
  const needId = created.needId;
  const publicId = created.publicId;

  const ext = await svc.dispatch(
    needId,
    {
      type: 'ExtractionCompleted',
      payload: { need_type: 'food', severity: 'high', location_text: 'Adyar', people_count: 4 },
    },
    { actor: agent(), at: at(), idempotencyKey: 'n1-extract' },
  );
  if (ext.status !== 'applied') throw new Error('seed extract failed');
  const triaged = await svc.dispatch(
    needId,
    { type: 'TriageConfirmed', payload: {} },
    { actor: human(), at: at(), idempotencyKey: 'n1-triage' },
  );
  if (triaged.status !== 'applied') throw new Error('seed triage failed');

  const readPort = {
    listNeeds: (now?: number) => svc.listNeeds(now),
    getPublicId: (id: string) => store.getPublicId(id),
  };

  return {
    svc,
    store,
    volunteers,
    needId,
    publicId,
    tools({ enabled = true, withWrite = true } = {}) {
      const deps: RelayToolDeps = { service: readPort, now: () => NOW };
      if (withWrite) {
        deps.write = {
          dispatch: (id, command, ctx) => svc.dispatch(id, command, ctx),
          volunteers,
          enabled,
        };
      }
      return createRelayTools(deps);
    },
  };
}

describe('pledge_support — writes disabled', () => {
  it('returns a clear "writes disabled" result and changes NOTHING on the ledger', async () => {
    const h = await seedOpenNeed();
    const before = await h.svc.getEvents(h.needId);

    const res = await h.tools({ enabled: false }).pledge_support({ need_public_id: h.publicId, pledged_by: PLEDGER });
    const body = payload(res);
    expect(body.status).toBe('writes_disabled');
    expect(String(body.message)).toContain('RELAY_MCP_WRITES_ENABLED');

    // No new event, no agent volunteer registered.
    const after = await h.svc.getEvents(h.needId);
    expect(after.length).toBe(before.length);
    expect(after.some((e) => isEvent(e, 'PledgeProposed'))).toBe(false);
    expect(await h.volunteers.getBySlackUser(agentVolunteerId(PLEDGER))).toBeNull();
  });

  it('is equally inert when no write surface is composed at all', async () => {
    const h = await seedOpenNeed();
    const res = await h.tools({ withWrite: false }).pledge_support({ need_public_id: h.publicId, pledged_by: PLEDGER });
    expect(payload(res).status).toBe('writes_disabled');
    expect((await h.svc.getEvents(h.needId)).some((e) => isEvent(e, 'PledgeProposed'))).toBe(false);
  });
});

describe('pledge_support — writes enabled', () => {
  it('records an AGENT-actor proposal, does NOT auto-claim, and returns a PII-free result', async () => {
    const h = await seedOpenNeed();
    const res = await h
      .tools()
      .pledge_support({ need_public_id: h.publicId, pledged_by: PLEDGER, note: 'can deliver 200 meals by 6pm' });

    const body = payload(res);
    expect(res.isError).toBeUndefined();
    expect(body.status).toBe('pledge_filed');
    expect(body.requires_confirmation).toBe(true);
    expect(body.need_public_id).toBe(h.publicId);
    assertNoPii(body);

    // The pledge is on the ledger as an AGENT event — the accountability record.
    const events = await h.svc.getEvents(h.needId);
    const pledge = events.find((e) => isEvent(e, 'PledgeProposed'));
    expect(pledge).toBeDefined();
    expect(pledge?.actor.type).toBe('agent');
    if (pledge && isEvent(pledge, 'PledgeProposed')) {
      expect(pledge.payload.volunteer_id).toBe(agentVolunteerId(PLEDGER));
      expect(pledge.payload.pledged_by).toBe(PLEDGER);
      expect(pledge.payload.note).toBe('can deliver 200 meals by 6pm');
    }

    // NOT auto-claimed: a human still has to confirm. State is MATCH_SUGGESTED (still open), no volunteer.
    const need = await h.svc.getNeed(h.needId, NOW);
    expect(need?.state).toBe('MATCH_SUGGESTED');
    expect(need?.assigned_volunteer_id).toBeNull();

    // An is_agent volunteer was registered for the pledger.
    const vol = await h.volunteers.getBySlackUser(agentVolunteerId(PLEDGER));
    expect(vol?.is_agent).toBe(true);
    expect(vol?.display_name).toBe(PLEDGER);
  });

  it('is idempotent — the same agent pledging the same need twice files ONE proposal', async () => {
    const h = await seedOpenNeed();
    const tools = h.tools();
    await tools.pledge_support({ need_public_id: h.publicId, pledged_by: PLEDGER });
    const second = await tools.pledge_support({ need_public_id: h.publicId, pledged_by: PLEDGER });
    expect(payload(second).status).toBe('pledge_filed'); // still a clean "filed" result
    const pledges = (await h.svc.getEvents(h.needId)).filter((e) => isEvent(e, 'PledgeProposed'));
    expect(pledges).toHaveLength(1);
  });
});

describe('pledge_support — the human gate is never bypassed', () => {
  it('an agent CANNOT self-assign the pledged need — only a human Assigned commits it', async () => {
    const h = await seedOpenNeed();
    await h.tools().pledge_support({ need_public_id: h.publicId, pledged_by: PLEDGER });
    const volId = agentVolunteerId(PLEDGER);

    // The agent tries to assign itself → the engine rejects it at the human gate.
    const agentAssign = await h.svc.dispatch(
      h.needId,
      { type: 'Assigned', payload: { volunteer_id: volId, obligation_id: 'ob-agent' } },
      { actor: agent(volId), at: new Date(NOW).toISOString(), idempotencyKey: 'agent-self-assign' },
    );
    expect(agentAssign.status).toBe('rejected');
    expect(agentAssign.code).toBe('HUMAN_GATE');
    expect((await h.svc.getNeed(h.needId, NOW))?.state).toBe('MATCH_SUGGESTED'); // still not claimed

    // A human confirms → the exact same Assigned event now applies → CLAIMED, committed to the agent.
    const humanAssign = await h.svc.dispatch(
      h.needId,
      { type: 'Assigned', payload: { volunteer_id: volId, obligation_id: 'ob-human' } },
      { actor: human('U_COORD'), at: new Date(NOW).toISOString(), idempotencyKey: 'human-confirm' },
    );
    expect(humanAssign.status).toBe('applied');
    const need = await h.svc.getNeed(h.needId, NOW);
    expect(need?.state).toBe('CLAIMED');
    expect(need?.assigned_volunteer_id).toBe(volId);
  });

  it('after the human confirm, the obligation drifts on the SAME SLA machinery as a human promise', async () => {
    const h = await seedOpenNeed();
    await h.tools().pledge_support({ need_public_id: h.publicId, pledged_by: PLEDGER });
    const volId = agentVolunteerId(PLEDGER);

    // Human confirm stamps an SLA exactly like the human Assign handler does (slaDueAtIso).
    const assignedAt = NOW;
    const slaIso = slaDueAtIso('food', 'high', assignedAt);
    const confirm = await h.svc.dispatch(
      h.needId,
      { type: 'Assigned', payload: { volunteer_id: volId, obligation_id: 'ob-1', sla_due_at: slaIso } },
      {
        actor: human('U_COORD'),
        at: new Date(assignedAt).toISOString(),
        idempotencyKey: 'confirm-sla',
        now: assignedAt,
      },
    );
    expect(confirm.status).toBe('applied');

    // Before due: on time. Past due: drifting — the identical projection flag any human obligation uses.
    const dueMs = Date.parse(slaIso);
    const onTime = await h.svc.getNeed(h.needId, dueMs - 60_000);
    expect(onTime?.flags.is_drifting).toBe(false);
    const overdue = await h.svc.getNeed(h.needId, dueMs + 60_000);
    expect(overdue?.state).toBe('CLAIMED');
    expect(overdue?.flags.is_drifting).toBe(true);
    expect(overdue?.sla_due_at).toBe(slaIso);
  });
});

describe('pledge_support — resolution errors are clean (never throws)', () => {
  it('an unknown need id returns a clean not-found result', async () => {
    const h = await seedOpenNeed();
    const res = await h.tools().pledge_support({ need_public_id: 'N-9999', pledged_by: PLEDGER });
    expect(res.isError).toBe(true);
    const body = payload(res);
    expect(body.error).toBe('not_found');
    expect(String(body.message)).toContain('N-9999');
    // Nothing registered, nothing appended anywhere.
    expect(await h.volunteers.getBySlackUser(agentVolunteerId(PLEDGER))).toBeNull();
  });

  it('a need past the pledgeable window returns a helpful message and files no pledge', async () => {
    const h = await seedOpenNeed();
    // Move the need to CLAIMED via a human Assign — no longer OPEN/MATCH_SUGGESTED.
    await h.svc.dispatch(
      h.needId,
      { type: 'Assigned', payload: { volunteer_id: 'V_HUMAN', obligation_id: 'ob-x' } },
      { actor: human('U_COORD'), at: new Date(NOW).toISOString(), idempotencyKey: 'pre-claim' },
    );
    const res = await h.tools().pledge_support({ need_public_id: h.publicId, pledged_by: PLEDGER });
    const body = payload(res);
    expect(body.status).toBe('not_pledgeable');
    expect(body.state).toBe('CLAIMED');
    expect(String(body.message)).toContain('CLAIMED');
    expect((await h.svc.getEvents(h.needId)).some((e) => isEvent(e, 'PledgeProposed'))).toBe(false);
  });
});
