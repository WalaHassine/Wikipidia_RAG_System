import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';

export interface ChatSource {
  title: string;
  url: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

@Injectable()
export class ChatRepository {
  constructor(@Inject('PG_POOL') private pool: Pool) {}

  /** Insert or ignore the user row; return the user UUID. */
  async upsertUser(username: string): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO users (username)
       VALUES ($1)
       ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`,
      [username],
    );
    return res.rows[0].id;
  }

  /** Create the session row if it doesn't exist; refresh updated_at otherwise. */
  async upsertSession(sessionId: string, userId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
      [sessionId, userId],
    );
  }

  /** Persist a single chat turn and return its generated UUID. */
  async saveMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
  ): Promise<string> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO messages (session_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [sessionId, role, content],
    );
    return res.rows[0].id;
  }

  /**
   * Return up to `limit` most-recent messages for the session in
   * chronological order (oldest first).
   */
  async getLastMessages(
    sessionId: string,
    limit: number,
  ): Promise<ChatMessage[]> {
    const res = await this.pool.query<{ role: string; content: string }>(
      `SELECT role, content
       FROM (
         SELECT role, content, created_at
         FROM messages
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2
       ) sub
       ORDER BY created_at ASC`,
      [sessionId, limit],
    );
    return res.rows as ChatMessage[];
  }

  /** Store RAG source references linked to an assistant message. */
  async saveCitations(
    messageId: string,
    sessionId: string,
    sources: ChatSource[],
  ): Promise<void> {
    for (let i = 0; i < sources.length; i++) {
      await this.pool.query(
        `INSERT INTO citations
           (message_id, session_id, citation_index, source_title, url)
         VALUES ($1, $2, $3, $4, $5)`,
        [messageId, sessionId, i + 1, sources[i].title, sources[i].url ?? null],
      );
    }
  }
}
