'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import Sidebar from '../../components/Sidebar';
import ChatWindow from '../../components/ChatWindow';
import SourcePanel from '../../components/SourcePanel';
import type { CitationData } from '../../components/Citations';

type AppMessage = UIMessage<{ createdAt?: string }>;

export type Session = {
  sessionId: string;
  title: string;
  createdAt: string;
};

const SOURCE_SEP = '\n\n---\n**Sources:**\n';

function extractTextFromParts(parts: any[]): string {
  return (parts ?? [])
    .filter((p: any) => p.type === 'text')
    .map((p: any) => p.text)
    .join('');
}

function parseSourcesFromMessage(msg: AppMessage): CitationData[] {
  const text = extractTextFromParts(msg.parts ?? []);
  const sepIdx = text.indexOf(SOURCE_SEP);
  if (sepIdx === -1) return [];
  return text
    .slice(sepIdx + SOURCE_SEP.length)
    .trim()
    .split('\n')
    .flatMap((line) => {
      const m = line.match(/^\[(\d+)\] \[([^\]]+)\]\(([^)]+)\)/);
      if (!m) return [];
      return [{ id: +m[1], sourceTitle: m[2], url: m[3], location: 'Wikipedia', fileType: 'WEB' }];
    });
}

function parseSources(messages: AppMessage[]): CitationData[] {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last) return [];
  return parseSourcesFromMessage(last);
}

function getSessionTitle(messages: AppMessage[]): string {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return 'New Conversation';
  return extractTextFromParts(first.parts ?? []).slice(0, 60) || 'New Conversation';
}

function loadSessions(username: string): Session[] {
  try {
    return JSON.parse(localStorage.getItem(`sessions:${username}`) ?? '[]');
  } catch {
    return [];
  }
}

function saveSessions(username: string, sessions: Session[]) {
  localStorage.setItem(`sessions:${username}`, JSON.stringify(sessions));
}

function loadMessages(username: string, sessionId: string): AppMessage[] {
  try {
    return JSON.parse(localStorage.getItem(`messages:${username}:${sessionId}`) ?? '[]');
  } catch {
    return [];
  }
}

function saveMessages(username: string, sessionId: string, messages: AppMessage[]) {
  localStorage.setItem(`messages:${username}:${sessionId}`, JSON.stringify(messages));
}

export default function ChatPage() {
  const [mounted, setMounted] = useState(false);
  const [username, setUsername] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem('username');
    if (stored) {
      setUsername(stored);
      setSessions(loadSessions(stored));
    }
  }, []);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const usernameRef = useRef(username);
  usernameRef.current = username;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        body: () => ({
          sessionId: sessionIdRef.current,
          username: usernameRef.current,
        }),
      }),
    [],
  );

  const chat = useChat<AppMessage>({ transport });

  useEffect(() => {
    if (!mounted || !username) return;
    chat.setMessages(loadMessages(username, sessionId));
  }, [sessionId, username, mounted]);

  // Persist messages and session title whenever messages change.
  useEffect(() => {
    if (!username || !mounted || chat.messages.length === 0) return;
    const msgs = chat.messages as AppMessage[];
    saveMessages(username, sessionId, msgs);
    const title = getSessionTitle(msgs);
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.sessionId === sessionId);
      const updated =
        idx >= 0
          ? prev.map((s, i) => (i === idx ? { ...s, title } : s))
          : [{ sessionId, title, createdAt: new Date().toISOString() }, ...prev];
      saveSessions(username, updated);
      return updated;
    });
  }, [chat.messages, sessionId, username, mounted]);

  // Citations are derived: show the selected message's sources, or fall back to
  // the most recent assistant message's sources.
  const citations = useMemo(() => {
    const msgs = chat.messages as AppMessage[];
    if (selectedMessageId) {
      const msg = msgs.find((m) => m.id === selectedMessageId);
      if (msg?.role === 'assistant') return parseSourcesFromMessage(msg);
    }
    return parseSources(msgs);
  }, [chat.messages, selectedMessageId]);

  const handleNewSession = () => {
    setSessionId(crypto.randomUUID());
    setSelectedMessageId(null);
  };

  const handleSelectSession = (id: string) => {
    if (id === sessionId) return;
    setSessionId(id);
    setSelectedMessageId(null);
  };

  const handleSelectMessage = (id: string) => {
    setSelectedMessageId((prev) => (prev === id ? null : id));
  };

  const handleSetUsername = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const trimmed = usernameInput.trim();
    if (!trimmed) return;
    localStorage.setItem('username', trimmed);
    setUsername(trimmed);
    setSessions(loadSessions(trimmed));
  };

  const handleSignOut = () => {
    localStorage.removeItem('username');
    setUsername('');
    setUsernameInput('');
    setSessions([]);
    chat.setMessages([]);
    setSelectedMessageId(null);
  };

  if (!mounted) return null;

  if (!username) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50">
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 w-full max-w-sm">
          <div className="flex items-center gap-2.5 mb-6">
            <span className="text-indigo-500 text-xl leading-none">✦</span>
            <p className="text-sm font-semibold text-gray-900">Luminous Logic AI</p>
          </div>
          <h1 className="text-lg font-bold text-gray-900 mb-1">Welcome</h1>
          <p className="text-sm text-gray-500 mb-5">Enter a username to get started.</p>
          <form onSubmit={handleSetUsername} className="flex flex-col gap-3">
            <input
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              placeholder="Your username"
              className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm text-gray-800 outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              autoFocus
            />
            <button
              type="submit"
              disabled={!usernameInput.trim()}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
            >
              Continue
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-slate-50 overflow-hidden">
      <header className="flex items-center justify-between px-6 h-14 bg-white border-b border-gray-100 flex-shrink-0">
        <span className="text-sm font-semibold text-gray-900 tracking-tight">
          Luminous Logic AI
        </span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium">{username}</span>
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-blue-300 to-indigo-500 flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
          </div>
          <button
            onClick={handleSignOut}
            title="Sign out"
            className="text-gray-400 hover:text-red-500 transition-colors"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          username={username}
          sessions={sessions}
          currentSessionId={sessionId}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onSignOut={handleSignOut}
        />
        <ChatWindow
          chat={chat}
          selectedMessageId={selectedMessageId}
          onSelectMessage={handleSelectMessage}
        />
        <SourcePanel citations={citations} hasSelection={selectedMessageId !== null} />
      </div>
    </div>
  );
}
