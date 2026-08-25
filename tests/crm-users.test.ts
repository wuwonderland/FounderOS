import { describe, expect, test } from 'vitest';
import { getOrCreateUser, listUsers, updateUserMetadata } from '@/lib/crm/users';

function makeQueryBuilder(resultsByTerminal: Record<string, { data?: unknown; error?: unknown }>) {
  let terminal = 'select';
  const builder: any = {};
  for (const passthrough of ['select', 'eq', 'order', 'limit']) {
    builder[passthrough] = () => builder;
  }
  builder.insert = () => {
    terminal = 'insert';
    return builder;
  };
  builder.update = () => {
    terminal = 'update';
    return builder;
  };
  builder.maybeSingle = () => {
    terminal = 'maybeSingle';
    return builder;
  };
  builder.single = () => {
    terminal = 'single';
    return builder;
  };
  builder.then = (resolve: any, reject: any) =>
    Promise.resolve(resultsByTerminal[terminal] ?? { data: null, error: null }).then(resolve, reject);
  return builder;
}

const row = {
  id: 'u1',
  email: 'a@b.com',
  full_name: 'A B',
  avatar_url: null,
  metadata: { tag: 'x' },
  created_at: 't1',
  updated_at: 't2',
};

describe('getOrCreateUser', () => {
  test('returns null with no Supabase client configured', async () => {
    expect(await getOrCreateUser('a@b.com', { env: {} })).toBeNull();
  });

  test('returns the existing row when found', async () => {
    const client = { from: () => makeQueryBuilder({ maybeSingle: { data: row, error: null } }) } as any;
    const user = await getOrCreateUser('a@b.com', { client });
    expect(user).toEqual({
      id: 'u1',
      email: 'a@b.com',
      fullName: 'A B',
      avatarUrl: null,
      metadata: { tag: 'x' },
      createdAt: 't1',
      updatedAt: 't2',
    });
  });

  test('creates a new row when none is found', async () => {
    const client = {
      from: () =>
        makeQueryBuilder({
          maybeSingle: { data: null, error: null },
          single: { data: row, error: null },
        }),
    } as any;
    const user = await getOrCreateUser('a@b.com', { client, fullName: 'A B' });
    expect(user?.id).toBe('u1');
  });

  test('returns null when the lookup errors', async () => {
    const client = { from: () => makeQueryBuilder({ maybeSingle: { data: null, error: { message: 'boom' } } }) } as any;
    expect(await getOrCreateUser('a@b.com', { client })).toBeNull();
  });
});

describe('listUsers', () => {
  test('empty array with no client', async () => {
    expect(await listUsers({ env: {} })).toEqual([]);
  });

  test('maps rows newest first', async () => {
    const client = { from: () => makeQueryBuilder({ select: { data: [row], error: null } }) } as any;
    const users = await listUsers({ client });
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('a@b.com');
  });

  test('empty array on query failure', async () => {
    const client = { from: () => makeQueryBuilder({ select: { data: null, error: { message: 'boom' } } }) } as any;
    expect(await listUsers({ client })).toEqual([]);
  });
});

describe('updateUserMetadata', () => {
  test('null with no client', async () => {
    expect(await updateUserMetadata('u1', { tag: 'y' }, { env: {} })).toBeNull();
  });

  test('merges the patch into existing metadata', async () => {
    const client = {
      from: () =>
        makeQueryBuilder({
          maybeSingle: { data: { metadata: { tag: 'x', keep: true } }, error: null },
          single: { data: { ...row, metadata: { tag: 'y', keep: true } }, error: null },
        }),
    } as any;
    const user = await updateUserMetadata('u1', { tag: 'y' }, { client });
    expect(user?.metadata).toEqual({ tag: 'y', keep: true });
  });

  test('null when the user is not found', async () => {
    const client = { from: () => makeQueryBuilder({ maybeSingle: { data: null, error: null } }) } as any;
    expect(await updateUserMetadata('missing', { tag: 'y' }, { client })).toBeNull();
  });
});
