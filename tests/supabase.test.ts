import { afterEach, describe, expect, test, vi } from 'vitest';
import { supabaseClient, supabaseStatus } from '@/lib/connectors/supabase';

describe('supabaseClient', () => {
  test('returns null when either env var is missing — never a half-configured client', () => {
    expect(supabaseClient({})).toBeNull();
    expect(supabaseClient({ NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' })).toBeNull();
    expect(supabaseClient({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' })).toBeNull();
  });

  test('returns a client once both are set', () => {
    const client = supabaseClient({
      NEXT_PUBLIC_SUPABASE_URL: 'https://project-ref.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    });
    expect(client).not.toBeNull();
    expect(typeof client!.from).toBe('function');
  });
});

describe('supabaseStatus', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('not_configured with no env vars — no fake connected', async () => {
    const status = await supabaseStatus({});
    expect(status.id).toBe('supabase');
    expect(status.kind).toBe('database');
    expect(status.state).toBe('not_configured');
    expect(status.detail).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  test('connected once the users table is reachable', async () => {
    const fakeClient = {
      from: () => ({
        select: () => Promise.resolve({ data: [], error: null, count: 3 }),
      }),
    } as any;
    const status = await supabaseStatus(
      { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      fakeClient,
    );
    expect(status.state).toBe('connected');
    expect(status.detail).toMatch(/3 rows/);
  });

  test('reports migrations-pending as an honest error, not connected', async () => {
    const fakeClient = {
      from: () => ({
        select: () =>
          Promise.resolve({ data: null, error: { code: '42P01', message: 'relation "public.users" does not exist' } }),
      }),
    } as any;
    const status = await supabaseStatus(
      { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' },
      fakeClient,
    );
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/migrations/i);
  });

  test('a real query failure is reported honestly, not as connected', async () => {
    const fakeClient = {
      from: () => ({
        select: () => Promise.resolve({ data: null, error: { code: '401', message: 'invalid API key' } }),
      }),
    } as any;
    const status = await supabaseStatus(
      { NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'bad-key' },
      fakeClient,
    );
    expect(status.state).toBe('error');
    expect(status.detail).toMatch(/invalid API key/);
  });
});
