import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Loads a fixture as the exact bytes on disk. Signature tests must sign the
 * raw body, not a re-serialised object, exactly like the webhook route does.
 */
export function fixtureBuffer(name: string): Buffer {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
}

export function fixtureText(name: string): string {
  return fixtureBuffer(name).toString('utf8');
}

export function fixtureJson<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(fixtureText(name)) as T;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeResponseSpec {
  status: number;
  body: unknown;
}

/**
 * Minimal fetch double: replays queued responses in order and records every
 * request. The last response is repeated when the queue is exhausted.
 */
export function fakeFetch(responses: FakeResponseSpec[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Headers)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) headers[k] = v;
    }
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const spec = queue.length > 1 ? queue.shift()! : queue[0]!;
    const text = typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    return new Response(text, {
      status: spec.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}
