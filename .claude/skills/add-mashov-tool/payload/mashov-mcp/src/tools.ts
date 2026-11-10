/** MCP tool definitions. Every tool is read-only and returns compact JSON text. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { MashovClient, MashovError, type Child } from './mashov-client.js';
import type { Logger } from './log.js';
import {
  ChildSelectionError,
  childLabel,
  childView,
  normalizeBehavior,
  normalizeGrades,
  normalizeHolidays,
  normalizeHomework,
  normalizeMailCounts,
  normalizeNotices,
  normalizeTimetable,
  resolveChildren,
} from './normalize.js';

export const TOOL_NAMES = [
  'mashov_children',
  'mashov_homework',
  'mashov_grades',
  'mashov_timetable',
  'mashov_behavior',
  'mashov_notices',
  'mashov_holidays',
] as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isoDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function shift(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

const childArg = z
  .string()
  .max(80)
  .optional()
  .describe('Child first name (see mashov_children). Omit for all children.');
const dayArg = (what: string) =>
  z.string().regex(ISO_DAY, 'use YYYY-MM-DD').optional().describe(`${what} (YYYY-MM-DD)`);

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Error text that is safe to hand to the agent (our own messages only). */
function errorText(err: unknown): string {
  if (err instanceof MashovError || err instanceof ChildSelectionError) return err.message;
  return 'Internal error in the Mashov MCP server (see host log)';
}

function errorCode(err: unknown): string {
  if (err instanceof MashovError) return err.code;
  if (err instanceof ChildSelectionError) return 'bad_child';
  return 'internal';
}

export interface ToolDeps {
  client: MashovClient;
  log: Logger;
  now?: () => Date;
}

export function buildServer({ client, log, now = () => new Date() }: ToolDeps): McpServer {
  const server = new McpServer({ name: 'mashov', version: '0.1.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  /** Run a tool body, logging only name, outcome code, and duration. */
  async function run(tool: string, body: () => Promise<unknown>): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await body();
      log.info('tool', { tool, status: 'ok', ms: Date.now() - started });
      return ok(data);
    } catch (err) {
      log.warn('tool', { tool, status: errorCode(err), ms: Date.now() - started });
      return fail(errorText(err));
    }
  }

  /** Fetch one resource per selected child; per-child failures don't sink the others. */
  async function perChild<T>(childQuery: string | undefined, fetchOne: (c: Child) => Promise<T>) {
    const selected = resolveChildren(await client.getChildren(), childQuery);
    return Promise.all(
      selected.map(async (c) => {
        try {
          return { child: childLabel(c), ...((await fetchOne(c)) as object) };
        } catch (err) {
          if (err instanceof MashovError && (err.code === 'auth' || err.code === 'changepass')) throw err;
          return { child: childLabel(c), error: errorText(err) };
        }
      }),
    );
  }

  const student = (c: Child, rest: string) => `students/${encodeURIComponent(c.guid)}/${rest}`;

  server.registerTool(
    'mashov_children',
    {
      description: 'List the children on the Mashov parent account (first name and class).',
      annotations,
    },
    () =>
      run('mashov_children', async () => ({
        year: client.year,
        children: (await client.getChildren()).map(childView),
      })),
  );

  server.registerTool(
    'mashov_homework',
    {
      description: 'Homework assigned per lesson. Defaults to the last 7 days through the next 14.',
      inputSchema: { child: childArg, from: dayArg('First lesson date'), to: dayArg('Last lesson date') },
      annotations,
    },
    ({ child, from, to }) =>
      run('mashov_homework', async () => {
        const today = now();
        const f = from ?? isoDay(shift(today, -7));
        const t = to ?? isoDay(shift(today, 14));
        const q = new URLSearchParams({ from: f, to: t, year: String(client.year) });
        return {
          from: f,
          to: t,
          results: await perChild(child, async (c) =>
            normalizeHomework(await client.get(student(c, `homework?${q}`), 'homework')),
          ),
        };
      }),
  );

  server.registerTool(
    'mashov_grades',
    {
      description: 'Grades for the current school year, newest first. Optionally only those on/after `since`.',
      inputSchema: { child: childArg, since: dayArg('Only grades on or after this date') },
      annotations,
    },
    ({ child, since }) =>
      run('mashov_grades', async () => ({
        since,
        results: await perChild(child, async (c) =>
          normalizeGrades(await client.get(student(c, 'grades'), 'grades'), since),
        ),
      })),
  );

  server.registerTool(
    'mashov_timetable',
    {
      description: 'Weekly timetable: day (1=Sunday … 7=Saturday), lesson number, subject, teacher, room.',
      inputSchema: { child: childArg },
      annotations,
    },
    ({ child }) =>
      run('mashov_timetable', async () => ({
        results: await perChild(child, async (c) =>
          normalizeTimetable(await client.get(student(c, 'timetable'), 'timetable')),
        ),
      })),
  );

  server.registerTool(
    'mashov_behavior',
    {
      description: 'Attendance and behavior events (absences, lateness, praise …). Defaults to the last 30 days.',
      inputSchema: { child: childArg, from: dayArg('Start date'), to: dayArg('End date') },
      annotations,
    },
    ({ child, from, to }) =>
      run('mashov_behavior', async () => {
        const today = now();
        const f = from ?? isoDay(shift(today, -30));
        const t = to ?? isoDay(today);
        const q = new URLSearchParams({ from: f, to: t, year: String(client.year) });
        return {
          from: f,
          to: t,
          results: await perChild(child, async (c) =>
            normalizeBehavior(await client.get(student(c, `behave?${q}`), 'behavior')),
          ),
        };
      }),
  );

  server.registerTool(
    'mashov_notices',
    {
      description:
        'School message-board notices per child, newest first, plus the unread mail count. Mail contents are never read.',
      inputSchema: { child: childArg },
      annotations,
    },
    ({ child }) =>
      run('mashov_notices', async () => {
        const results = await perChild(child, async (c) =>
          normalizeNotices(await client.get(student(c, 'messageBoard'), 'notices')),
        );
        let mail: { unread?: number; inbox?: number } | { error: string };
        try {
          mail = normalizeMailCounts(await client.get('mail/counts', 'mail counts'));
        } catch (err) {
          mail = { error: errorText(err) };
        }
        return { results, mail };
      }),
  );

  server.registerTool(
    'mashov_holidays',
    {
      description: 'School holidays and vacations. By default only those not yet over.',
      inputSchema: { include_past: z.boolean().optional().describe('Include holidays that already ended') },
      annotations,
    },
    ({ include_past }) =>
      run('mashov_holidays', async () =>
        normalizeHolidays(await client.get('holidays', 'holidays'), include_past ? undefined : isoDay(now())),
      ),
  );

  return server;
}
