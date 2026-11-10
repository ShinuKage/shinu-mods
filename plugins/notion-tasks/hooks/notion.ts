// Reusable Notion access over the session's connected Notion MCP server.
// Every call resolves to a Result and never throws, so a pane can show an
// error state instead of failing its hook. Stage 2 (/devlog) reuses this file.
import type { EngineInterface, McpToolResult } from 'claude-code'

type $ = EngineInterface

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

/** A suffix every Notion MCP server's tools share, used to find the server. */
const PROBE_TOOL = 'notion-query-data-sources'
/** Tried when no Notion tool is listed (a server not yet dialed). */
const FALLBACK_SERVERS = ['claude.ai Notion', 'Notion']

let cachedServer: string | undefined

/** For tests: forget the server found earlier. */
export function resetNotionServer(): void {
  cachedServer = undefined
}

/**
 * Finds the Notion MCP server's name as `$.mcp.call` takes it: the tool-name
 * spelling `mcp__<server>__notion-…` (on the desktop a connector id).
 */
export async function findNotionServer($: $): Promise<string | undefined> {
  if (cachedServer !== undefined) return cachedServer
  try {
    const tools = await $.tool.list()
    for (const t of tools) {
      const m = /^mcp__(.+)__notion-query-data-sources$/.exec(t.name)
      if (m?.[1] !== undefined) {
        cachedServer = m[1]
        return cachedServer
      }
    }
  } catch {
    // fall through to the fallbacks
  }
  return undefined
}

function errorText(r: McpToolResult): string {
  const text = r.content
    .map(b => (typeof b.text === 'string' ? b.text : ''))
    .join(' ')
    .trim()
  return text === '' ? 'Notion reported an error' : text.slice(0, 300)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Calls one Notion tool (`notion-fetch`, …) and parses its JSON text block. */
export async function callNotion<T = unknown>(
  $: $,
  tool: string,
  args: Record<string, unknown>,
): Promise<Result<T>> {
  const found = await findNotionServer($)
  const servers = found !== undefined ? [found] : FALLBACK_SERVERS
  let lastError = `No Notion connector found (no ${PROBE_TOOL} tool is connected)`
  for (const server of servers) {
    let r: McpToolResult
    try {
      r = await $.mcp.call(server, tool, args)
    } catch (err) {
      lastError = `Notion unreachable: ${message(err)}`
      continue
    }
    if (r.isError) return { ok: false, error: errorText(r) }
    if (r.structuredContent !== undefined && r.structuredContent !== null) {
      return { ok: true, value: r.structuredContent as T }
    }
    const text = r.content
      .map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('')
    try {
      return { ok: true, value: JSON.parse(text) as T }
    } catch {
      return { ok: true, value: { text } as T }
    }
  }
  return { ok: false, error: lastError }
}

export type Row = Record<string, unknown>

/** Rows of a data source (quota-free `rows` mode), with an optional filter. */
export async function queryRows(
  $: $,
  dataSource: string,
  opts: { filter?: unknown; limit?: number } = {},
): Promise<Result<Row[]>> {
  const data: Record<string, unknown> = {
    mode: 'rows',
    data_source_url: dataSource,
    limit: opts.limit ?? 100,
  }
  if (opts.filter !== undefined) data.filter = opts.filter
  const r = await callNotion<{ results?: unknown }>($, 'notion-query-data-sources', { data })
  if (!r.ok) return r
  const rows = r.value.results
  if (!Array.isArray(rows)) return { ok: false, error: 'Notion returned no rows list' }
  return { ok: true, value: rows.filter((x): x is Row => typeof x === 'object' && x !== null) }
}

export type FetchedPage = { title: string; url: string; body: string }

/** The body between `<content>` tags of a fetched page, or the whole text. */
export function pageBody(text: string): string {
  const m = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(text)
  return (m?.[1] ?? text).trim()
}

/** One page's title and Markdown body. */
export async function fetchPage($: $, id: string): Promise<Result<FetchedPage>> {
  const r = await callNotion<{ title?: unknown; url?: unknown; text?: unknown }>(
    $,
    'notion-fetch',
    { id },
  )
  if (!r.ok) return r
  const text = typeof r.value.text === 'string' ? r.value.text : ''
  return {
    ok: true,
    value: {
      title: typeof r.value.title === 'string' ? r.value.title : '',
      url: typeof r.value.url === 'string' ? r.value.url : '',
      body: pageBody(text),
    },
  }
}

/** Sets properties of a database page, as the data source's schema names them. */
export async function updateProperties(
  $: $,
  pageId: string,
  properties: Record<string, string | number | null>,
): Promise<Result<true>> {
  const r = await callNotion($, 'notion-update-page', {
    page_id: pageId,
    command: 'update_properties',
    properties,
  })
  return r.ok ? { ok: true, value: true } : r
}

/** Appends Notion-flavored Markdown to the end of a page (for /devlog). */
export async function appendToPage($: $, pageId: string, markdown: string): Promise<Result<true>> {
  const r = await callNotion($, 'notion-update-page', {
    page_id: pageId,
    command: 'insert_content',
    content: markdown,
    position: { type: 'end' },
  })
  return r.ok ? { ok: true, value: true } : r
}

/** The 32-hex page id in a Notion URL, dashed; the input when none is found. */
export function pageIdOf(urlOrId: string): string {
  const hex = /([0-9a-f]{32})(?:[?#]|$)/i.exec(urlOrId.replace(/-/g, ''))?.[1]
  if (hex === undefined) return urlOrId
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
