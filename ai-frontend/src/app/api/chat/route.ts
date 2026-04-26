import { NextRequest } from 'next/server';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

function extractContent(m: any): string {
  if (typeof m.content === 'string' && m.content) return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text ?? '')
      .join('');
  }
  if (Array.isArray(m.parts)) {
    return m.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text ?? '')
      .join('');
  }
  return '';
}

function toUIMessageStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const textId = 'text-0';

  const sse = (data: object | string) => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    return encoder.encode(`data: ${payload}\n\n`);
  };

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();
      controller.enqueue(sse({ type: 'text-start', id: textId }));
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (text) controller.enqueue(sse({ type: 'text-delta', id: textId, delta: text }));
        }
      } catch {
        controller.enqueue(sse({ type: 'error', errorText: 'Stream interrupted' }));
      } finally {
        reader.releaseLock();
      }
      controller.enqueue(sse({ type: 'text-end', id: textId }));
      controller.enqueue(sse({ type: 'finish', finishReason: 'stop' }));
      controller.enqueue(sse('[DONE]'));
      controller.close();
    },
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { messages, sessionId, username } = body;

  const plainMessages = (messages ?? [])
    .map((m: any) => ({
      role: m.role as 'user' | 'assistant',
      content: extractContent(m),
    }))
    .filter((m: any) => m.content);

  if (!plainMessages.length) {
    return new Response('No messages', { status: 400 });
  }

  const latestMessage = plainMessages[plainMessages.length - 1];

  const backendRes = await fetch(`${BACKEND_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: latestMessage.content,
      messages: plainMessages,
      sessionId: sessionId ?? '',
      username: username ?? 'anonymous',
    }),
  });

  if (!backendRes.ok) {
    return new Response(`Backend error: ${backendRes.status}`, { status: backendRes.status });
  }

  return new Response(toUIMessageStream(backendRes.body!), {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-vercel-ai-ui-message-stream': 'v1',
      'x-accel-buffering': 'no',
    },
  });
}
