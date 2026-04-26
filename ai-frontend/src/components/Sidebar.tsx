import type { Session } from '../app/chat/page';

type SidebarProps = {
  username: string;
  sessions: Session[];
  currentSessionId: string;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
};

export default function Sidebar({
  username,
  sessions,
  currentSessionId,
  onNewSession,
  onSelectSession,
}: SidebarProps) {
  return (
    <aside className="w-60 bg-white border-r border-gray-100 flex flex-col flex-shrink-0">
      {/* Brand */}
      <div className="px-4 pt-5 pb-4 border-b border-gray-50">
        <div className="flex items-center gap-2.5">
          <span className="text-indigo-500 text-base leading-none">✦</span>
          <div>
            <p className="text-sm font-semibold text-gray-900 leading-tight">Research Suite</p>
            <p className="text-xs text-gray-400 mt-0.5">Editorial Intelligence</p>
          </div>
        </div>
      </div>

      {/* New Chat */}
      <div className="px-3 pt-3 pb-2">
        <button
          onClick={onNewSession}
          className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors w-full"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Chat
        </button>
      </div>

      {/* Recent conversations */}
      <div className="px-3 py-2 flex-1 overflow-y-auto">
        <p className="text-xs font-semibold text-gray-400 tracking-widest px-2 mb-1.5">RECENT</p>
        <nav className="flex flex-col gap-0.5">
          {sessions.length === 0 ? (
            <p className="text-xs text-gray-400 px-2 py-2">No conversations yet.</p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.sessionId}
                onClick={() => onSelectSession(s.sessionId)}
                className={`flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm w-full text-left transition-colors ${
                  s.sessionId === currentSessionId
                    ? 'bg-indigo-50 text-indigo-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="flex-shrink-0 text-gray-400"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span className="truncate">{s.title}</span>
              </button>
            ))
          )}
        </nav>
      </div>

      {/* User */}
      <div className="px-3 py-3 border-t border-gray-50 flex flex-col gap-0.5">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-300 to-indigo-500 flex items-center justify-center flex-shrink-0">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="white">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <span className="text-sm text-gray-700 font-medium truncate">{username}</span>
        </div>
        <button className="flex items-center gap-2.5 px-2 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-50 w-full text-left transition-colors">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="flex-shrink-0"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Help Center
        </button>
      </div>
    </aside>
  );
}
