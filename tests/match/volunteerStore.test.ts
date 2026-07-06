import { describe, expect, it } from 'vitest';
import { InMemoryVolunteerStore, type Volunteer } from '../../src/match/volunteerStore';

// Registry contract on the hermetic in-memory store (the same shape the Pg store returns).

const V = (over: Partial<Volunteer> & Pick<Volunteer, 'slack_user_id' | 'display_name'>): Volunteer => ({
  skills: [],
  languages: [],
  home_locality: null,
  radius_km: 5,
  capacity_per_day: 2,
  availability: {},
  active_load: 0,
  is_demo: false,
  ...over,
});

describe('InMemoryVolunteerStore', () => {
  it('upsert then getBySlackUser round-trips the row', async () => {
    const store = new InMemoryVolunteerStore();
    await store.upsert(
      V({ slack_user_id: 'U1', display_name: 'Anitha', skills: ['medical'], languages: ['ta', 'en'] }),
    );
    const got = await store.getBySlackUser('U1');
    expect(got?.display_name).toBe('Anitha');
    expect(got?.skills).toEqual(['medical']);
    expect(got?.languages).toEqual(['ta', 'en']);
    expect(await store.getBySlackUser('nope')).toBeNull();
  });

  it('upsert is update-by-slack_user_id (no duplicate rows)', async () => {
    const store = new InMemoryVolunteerStore();
    await store.upsert(V({ slack_user_id: 'U1', display_name: 'Anitha', radius_km: 5 }));
    await store.upsert(V({ slack_user_id: 'U1', display_name: 'Anitha R', radius_km: 9 }));
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.display_name).toBe('Anitha R');
    expect(list[0]?.radius_km).toBe(9);
  });

  it('list is sorted by display_name', async () => {
    const store = new InMemoryVolunteerStore();
    await store.upsert(V({ slack_user_id: 'U2', display_name: 'Zara' }));
    await store.upsert(V({ slack_user_id: 'U1', display_name: 'Anitha' }));
    await store.upsert(V({ slack_user_id: 'U3', display_name: 'Meena' }));
    expect((await store.list()).map((v) => v.display_name)).toEqual(['Anitha', 'Meena', 'Zara']);
  });

  it('incrementLoad adjusts by delta and clamps at 0', async () => {
    const store = new InMemoryVolunteerStore();
    await store.upsert(V({ slack_user_id: 'U1', display_name: 'Anitha', active_load: 0 }));
    await store.incrementLoad('U1', 2);
    expect((await store.getBySlackUser('U1'))?.active_load).toBe(2);
    await store.incrementLoad('U1', -1);
    expect((await store.getBySlackUser('U1'))?.active_load).toBe(1);
    await store.incrementLoad('U1', -5); // clamps, never negative
    expect((await store.getBySlackUser('U1'))?.active_load).toBe(0);
  });

  it('incrementLoad on an unknown volunteer is a no-op', async () => {
    const store = new InMemoryVolunteerStore();
    await expect(store.incrementLoad('ghost', 1)).resolves.toBeUndefined();
    expect(await store.getBySlackUser('ghost')).toBeNull();
  });

  it('upsert preserves accumulated load across re-onboarding', async () => {
    const store = new InMemoryVolunteerStore();
    await store.upsert(V({ slack_user_id: 'U1', display_name: 'Anitha' }));
    await store.incrementLoad('U1', 3);
    await store.upsert(V({ slack_user_id: 'U1', display_name: 'Anitha', skills: ['boat'] }));
    const got = await store.getBySlackUser('U1');
    expect(got?.active_load).toBe(3); // load is not reset by re-onboarding
    expect(got?.skills).toEqual(['boat']); // other fields updated
  });

  it('returns defensive copies (mutating a result never mutates the store)', async () => {
    const store = new InMemoryVolunteerStore();
    await store.upsert(V({ slack_user_id: 'U1', display_name: 'Anitha', skills: ['medical'] }));
    const got = await store.getBySlackUser('U1');
    got?.skills.push('boat');
    expect((await store.getBySlackUser('U1'))?.skills).toEqual(['medical']);
  });

  it('seeds from the constructor', async () => {
    const store = new InMemoryVolunteerStore([V({ slack_user_id: 'U1', display_name: 'Seeded' })]);
    expect((await store.getBySlackUser('U1'))?.display_name).toBe('Seeded');
  });
});
