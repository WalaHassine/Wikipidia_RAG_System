import { useState } from 'react';
import MessageBubble from './MessageWindow';

export default function ChatWindow({ chat }: any) {
  const { messages, sendMessage, status } = chat;
  const [inputValue, setInputValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text || status === 'streaming') return;
    sendMessage({ text });
    setInputValue('');
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-10 py-8 flex flex-col gap-6">
        {messages.map((m: any) => (
          <MessageBubble key={m.id} message={m} />
        ))}
      </div>

      {/* Input area */}
      <div className="px-10 pb-5 flex-shrink-0">
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-3 bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm"
        >
          <button
            type="button"
            className="text-gray-400 hover:text-gray-500 transition-colors flex-shrink-0"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          <input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            className="flex-1 bg-transparent text-sm text-gray-700 placeholder-gray-400 outline-none"
            placeholder="Ask a question..."
          />

          <button
            type="submit"
            disabled={status === 'streaming' || !inputValue.trim()}
            className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" fill="white" stroke="none" />
            </svg>
          </button>
        </form>
        <p className="text-center text-xs text-gray-400 mt-2 tracking-wider font-medium">
          AI MAY PROVIDE INACCURATE INFO. VERIFY KEY CITATIONS.
        </p>
      </div>
    </div>
  );
}
