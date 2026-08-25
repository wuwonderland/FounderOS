import { Client } from '@notionhq/client';
import type { PageObjectResponse } from '@notionhq/client';
import type { ConnectorStatus } from '@/lib/connectors/types';

export type NotionPage = { id: string; title: string; lastEdited: string; url: string };

function client(env: Record<string, string | undefined>): Client | null {
  return env.NOTION_API_KEY ? new Client({ auth: env.NOTION_API_KEY }) : null;
}

export async function notionStatus(env: Record<string, string | undefined> = process.env): Promise<ConnectorStatus> {
  const notion = client(env);
  if (!notion) {
    return {
      id: 'notion',
      name: 'Notion',
      kind: 'notion',
      state: 'not_configured',
      detail: 'Set NOTION_API_KEY (internal integration secret) in .env.local and share target pages with it.',
    };
  }
  try {
    const me = await notion.users.me({});
    return {
      id: 'notion',
      name: 'Notion',
      kind: 'notion',
      state: 'connected',
      detail: `Connected as ${me.name ?? 'integration'}`,
    };
  } catch (err) {
    return {
      id: 'notion',
      name: 'Notion',
      kind: 'notion',
      state: 'error',
      detail: `Key set but auth failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function recentPages(
  limit = 10,
  env: Record<string, string | undefined> = process.env,
): Promise<NotionPage[]> {
  const notion = client(env);
  if (!notion) throw new Error('NOTION_API_KEY is not set');
  const res = await notion.search({
    page_size: limit,
    sort: { direction: 'descending', timestamp: 'last_edited_time' },
  });
  return res.results.map((page) => {
    const p = page as { id: string; url?: string; last_edited_time?: string; properties?: Record<string, unknown> };
    let title = 'Untitled';
    for (const prop of Object.values(p.properties ?? {})) {
      const t = prop as { type?: string; title?: { plain_text?: string }[] };
      if (t.type === 'title' && t.title?.length) {
        title = t.title.map((s) => s.plain_text ?? '').join('');
        break;
      }
    }
    return { id: p.id, title, lastEdited: p.last_edited_time ?? '', url: p.url ?? '' };
  });
}

export type NotionCriterion = { id: string; title: string; url: string; text: string };

function extractPlainText(rich: { plain_text?: string }[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text ?? '').join('');
}

/** Flattens one page's properties into a readable "Field: value" block —
    good enough for prompt injection (see lib/agents/orchestrator.ts), not
    a full property-type-aware renderer. Unsupported property types are
    skipped rather than guessed at. */
function renderProperties(properties: PageObjectResponse['properties']): string {
  const lines: string[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    switch (prop.type) {
      case 'title':
        lines.push(`${name}: ${extractPlainText(prop.title)}`);
        break;
      case 'rich_text':
        lines.push(`${name}: ${extractPlainText(prop.rich_text)}`);
        break;
      case 'select':
        if (prop.select) lines.push(`${name}: ${prop.select.name}`);
        break;
      case 'multi_select':
        if (prop.multi_select.length) lines.push(`${name}: ${prop.multi_select.map((s) => s.name).join(', ')}`);
        break;
      case 'checkbox':
        lines.push(`${name}: ${prop.checkbox ? 'yes' : 'no'}`);
        break;
      case 'status':
        if (prop.status) lines.push(`${name}: ${prop.status.name}`);
        break;
      case 'url':
        if (prop.url) lines.push(`${name}: ${prop.url}`);
        break;
      default:
        break; // date/number/people/relation/etc. — skip rather than guess a rendering
    }
  }
  return lines.join('\n');
}

/** Fetches task specs / acceptance criteria from a configured Notion
    database — used to ground the Dev Team Agent in the operator's actual
    standards (see lib/agents/orchestrator.ts). The modern Notion API
    queries a database's DATA SOURCE, not the database directly, so this
    retrieves the database first to resolve its (first) data source id,
    then queries that. Never throws — a missing key, bad database id, or a
    database with no rows all come back as an honest empty/error result. */
export async function fetchCriteria(
  databaseId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; items: NotionCriterion[] } | { ok: false; error: string }> {
  const notion = client(env);
  if (!notion) return { ok: false, error: 'NOTION_API_KEY is not set' };
  try {
    const db = await notion.databases.retrieve({ database_id: databaseId });
    // GetDatabaseResponse is a union with a "partial" variant (returned
    // when the integration's access is limited) that lacks data_sources —
    // narrow before reading it rather than asserting.
    if (!('data_sources' in db)) return { ok: false, error: `no full access to database ${databaseId} (partial response)` };
    const dataSourceId = db.data_sources[0]?.id;
    if (!dataSourceId) return { ok: false, error: `database ${databaseId} has no data sources` };

    const result = await notion.dataSources.query({ data_source_id: dataSourceId, page_size: 50 });
    const items: NotionCriterion[] = [];
    for (const page of result.results) {
      if (page.object !== 'page' || !('properties' in page)) continue;
      const p = page as PageObjectResponse;
      let title = 'Untitled';
      for (const prop of Object.values(p.properties)) {
        if (prop.type === 'title') {
          title = extractPlainText(prop.title) || title;
          break;
        }
      }
      items.push({ id: p.id, title, url: p.url ?? '', text: renderProperties(p.properties) });
    }
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Renders fetched criteria as a plain-text block for prompt injection. */
export function formatCriteriaForPrompt(items: NotionCriterion[]): string {
  if (items.length === 0) return '';
  return items.map((item) => `### ${item.title}\n${item.text}`).join('\n\n');
}
