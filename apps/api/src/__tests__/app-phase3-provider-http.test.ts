import { describe, it, expect, vi, afterEach } from 'vitest';
import { AI_HTTP_USER_AGENT } from '../env.js';
import { postToProvider } from '../lib/providerHttp.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider HTTP helper (Groq Cloudflare gate)', () => {
  it('exports a browser-like User-Agent constant', () => {
    expect(AI_HTTP_USER_AGENT).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );
    expect(AI_HTTP_USER_AGENT.startsWith('Mozilla/5.0')).toBe(true);
  });

  it('sends the browser User-Agent header on outgoing provider calls', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const res = await postToProvider('https://api.groq.com/openai/v1/chat/completions', {
      apiKey: 'test-key',
      body: { model: 'openai/gpt-oss-20b', messages: [] },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(AI_HTTP_USER_AGENT);
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(seen[0].init.method).toBe('POST');
  });

  it('omits Authorization when no key is given but still sends the User-Agent', async () => {
    const seen: Array<{ init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push({ init });
        return new Response('{}', { status: 200 });
      }),
    );
    await postToProvider('https://example.invalid/v1/test', { body: {} });
    const headers = seen[0].init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(AI_HTTP_USER_AGENT);
    expect(headers.Authorization).toBeUndefined();
  });
});
