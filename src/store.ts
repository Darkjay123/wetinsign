import pg from 'pg';

export interface Store {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  count(): Promise<number>;
}

class MemoryStore implements Store {
  private m = new Map<string, unknown>();
  async get(k: string) { return this.m.get(k); }
  async put(k: string, v: unknown) { this.m.set(k, v); }
  async count() { return this.m.size; }
}

/** Rumpty Cloud managed PostgreSQL. Caches decoded results so repeat lookups are instant and free. */
class PgStore implements Store {
  private ready: Promise<void>;
  constructor(private pool: pg.Pool) {
    this.ready = pool
      .query(`create table if not exists explanations (
        key text primary key,
        result jsonb not null,
        created_at timestamptz not null default now()
      )`)
      .then(() => undefined);
  }
  async get(k: string) {
    await this.ready;
    const r = await this.pool.query('select result from explanations where key = $1', [k]);
    return r.rows[0]?.result;
  }
  async put(k: string, v: unknown) {
    await this.ready;
    await this.pool.query(
      'insert into explanations (key, result) values ($1, $2) on conflict (key) do update set result = excluded.result',
      [k, JSON.stringify(v)],
    );
  }
  async count() {
    await this.ready;
    const r = await this.pool.query('select count(*)::int as n from explanations');
    return r.rows[0].n as number;
  }
}

export function createStore(url = process.env.DATABASE_URL): Store {
  if (!url) return new MemoryStore();
  const ssl = /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined;
  return new PgStore(new pg.Pool({ connectionString: url, ssl, max: 5 }));
}
