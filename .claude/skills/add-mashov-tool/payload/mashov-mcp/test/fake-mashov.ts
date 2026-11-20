/**
 * Synthetic Mashov API for tests. All names, ids, and credentials are made up.
 */
import type { FetchLike } from '../src/mashov-client.js';

export const CREDS = { semel: 999999, username: 'synthetic-user-0000', password: 'Synthetic-Pass-Do-Not-Leak-42' };
export const API = 'https://mashov.test/api/';

export const CHILDREN = [
  { childGuid: 'guid-aaaa-1111', privateName: 'Alef', familyName: 'Testfamily', classCode: 'ג', classNum: 2 },
  { childGuid: 'guid-bbbb-2222', privateName: 'Bet', familyName: 'Testfamily', classCode: 'ה', classNum: 1 },
];

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeOptions {
  loginStatus?: number;
  loginHeaders?: Record<string, string>;
  loginBody?: unknown;
  /** Per-path override: return a Response for a GET path (without API prefix). */
  route?: (path: string, call: Call) => Response | undefined;
  data?: Record<string, unknown>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const DATA: Record<string, unknown> = {
  homework: [
    {
      lessonDate: '2026-11-09T00:00:00',
      lesson: 2,
      subjectName: 'Math',
      homework: 'Page 12, ex. 1-4',
      remark: null,
      studentGuid: 'guid-aaaa-1111',
      groupId: 77,
    },
    {
      lessonDate: '2026-11-08T00:00:00',
      lesson: 1,
      subjectName: 'English',
      homework: '<p>Read&nbsp;chapter 3</p>',
      lessonId: 5,
    },
    { lessonDate: '2026-11-07T00:00:00', lesson: 3, subjectName: 'Art', homework: '' },
  ],
  behave: [
    {
      lessonDate: '2026-11-02T00:00:00',
      lesson: 1,
      achvaName: 'Late',
      justified: -1,
      subject: 'Math',
      reporter: 'T. Teacher',
      studentGuid: 'guid-aaaa-1111',
      reporterGuid: 'r-1',
    },
  ],
  grades: [
    {
      eventDate: '2026-10-20T00:00:00',
      subjectName: 'Math',
      gradingEvent: 'Quiz 1',
      grade: 92,
      gradeType: 'quiz',
      teacherName: 'T. Teacher',
      studentGuid: 'guid-aaaa-1111',
    },
    {
      eventDate: '2026-09-15T00:00:00',
      subjectName: 'Bible',
      gradingEvent: 'Test',
      grade: 85,
      teacherName: 'U. Teacher',
    },
    { eventDate: '2026-09-10T00:00:00', subjectName: 'Gym', gradingEvent: 'Not graded yet' },
  ],
  timetable: [
    {
      timeTable: { day: 2, lesson: 1, roomNum: '12' },
      groupDetails: { subjectName: 'English', groupTeachers: [{ teacherName: 'V. Teacher' }] },
    },
    {
      timeTable: { day: 1, lesson: 2, roomNum: '7' },
      groupDetails: { subjectName: 'Math', groupTeachers: [{ teacherName: 'T. Teacher' }] },
    },
  ],
  messageBoard: [
    {
      title: 'Trip on Thursday',
      body: 'Bring water and a hat.',
      startDate: '2026-11-05T00:00:00',
      senderName: 'School office',
      email: 'office@school.test',
      internalId: 'x-1',
    },
  ],
  holidays: [
    { hollyDayName: 'Past break', startDate: '2026-09-22T00:00:00', endDate: '2026-09-24T00:00:00' },
    { holidayName: 'Hanukkah', startDate: '2026-12-06T00:00:00', endDate: '2026-12-13T00:00:00' },
  ],
  'mail/counts': {
    unreadConversations: 3,
    inboxConversations: 40,
    lastMessage: { subject: 'Secret subject', body: 'MAIL BODY MUST NOT LEAK' },
  },
};

export function fakeMashov(opts: FakeOptions = {}) {
  const calls: Call[] = [];
  let logins = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    if (!url.startsWith(API)) throw new Error(`unexpected host: ${url}`);
    const path = url.slice(API.length);
    if (path === 'login') {
      logins++;
      if (call.method !== 'POST') return json({}, 405);
      const status = opts.loginStatus ?? 200;
      if (status !== 200) return json(opts.loginBody ?? { message: 'bad' }, status, opts.loginHeaders);
      const h = new Headers({ 'content-type': 'application/json', 'x-csrf-token': `csrf-${logins}` });
      h.append('set-cookie', `MashovSessionID=sess-${logins}; Path=/; HttpOnly`);
      h.append('set-cookie', `Csrf-Token=csrf-${logins}; Path=/`);
      return new Response(JSON.stringify(opts.loginBody ?? { accessToken: { children: CHILDREN }, credential: {} }), {
        status: 200,
        headers: h,
      });
    }
    const override = opts.route?.(path, call);
    if (override) return override;
    if (
      call.headers['x-csrf-token'] !== `csrf-${logins}` ||
      !call.headers.cookie?.includes(`MashovSessionID=sess-${logins}`)
    ) {
      return json({ message: 'unauthorized' }, 401);
    }
    const data = { ...DATA, ...opts.data };
    const m = /^students\/([^/]+)\/([A-Za-z]+)/.exec(path);
    const key = m ? m[2] : path.split('?')[0];
    if (key in data) return json(data[key]);
    return json({ message: 'not found' }, 404);
  };
  return {
    fetch,
    calls,
    get logins() {
      return logins;
    },
  };
}
