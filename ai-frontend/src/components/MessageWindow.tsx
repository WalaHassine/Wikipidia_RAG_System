import type { ReactNode } from 'react';

type CitationData = {
  id: number;
  sourceTitle: string;
  url?: string;
  location?: string;
  fileType?: string;
};

type CitationMap = Record<number, CitationData>;

const SOURCE_SEP = '\n\n---\n**Sources:**';

export default function MessageBubble({ message }: any) {
  const isUser = message.role === 'user';
  const rawText = extractText(message.parts ?? []);
  const textContent = rawText.split(SOURCE_SEP)[0];

  if (isUser) {
    const createdAt = message.metadata?.createdAt
      ? new Date(message.metadata.createdAt)
      : null;

    return (
      <div className="flex justify-end">
        <div className="flex flex-col items-end gap-1.5 max-w-lg">
          <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
            <p className="text-sm text-gray-800 leading-relaxed">{textContent}</p>
          </div>
          {createdAt && (
            <span className="text-xs text-gray-400 font-medium tracking-wide">
              YOU • {formatTime(createdAt)}
            </span>
          )}
        </div>
      </div>
    );

  }

  const citations = parseCitations(rawText);
  const { heading, paragraphs } = parseMessage(textContent);

  return (
    <div className="flex gap-3">
      {/* AI avatar */}
      <div className="w-9 h-9 rounded-full bg-slate-300 flex-shrink-0 flex items-center justify-center mt-0.5">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="white">
          <path d="M12 2L9.19 9.19H2L7.38 13.31L5.27 21L12 16.9L18.73 21L16.62 13.31L22 9.19H14.81L12 2Z" />
        </svg>
      </div>

      {/* Message content */}
      <div className="flex-1 min-w-0 pt-1">
        {heading && (
          <h2 className="text-[15px] font-bold text-gray-900 mb-2 leading-snug">{heading}</h2>
        )}
        <div className="text-[15px] text-gray-800 leading-7 space-y-4 font-normal">
          {paragraphs.map((para, i) => (
            <div key={i} className="whitespace-pre-wrap">
                {renderParagraph(para, citations)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function extractText(parts: any[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function parseCitations(rawText: string): CitationMap {
  const sepIdx = rawText.indexOf(SOURCE_SEP);
  if (sepIdx === -1) return {};
  const block = rawText.slice(sepIdx + SOURCE_SEP.length);
  const map: CitationMap = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^\[(\d+)\] \[([^\]]+)\]\(([^)]+)\)/);
    if (m) {
      map[+m[1]] = { id: +m[1], sourceTitle: m[2], url: m[3], location: 'Wikipedia', fileType: 'WEB' };
    }
  }
  return map;
}

function parseMessage(content: string): { heading: string; paragraphs: string[] } {
  const lines = content.split('\n');
  if (lines[0].startsWith('## ')) {
    const rest = lines.slice(1).join('\n').trim();
    return {
      heading: lines[0].slice(3),
      paragraphs: rest.split(/\n\n+/).filter(Boolean),
    };
  }
  return {
    heading: '',
    paragraphs: content.split(/\n\n+/).filter(Boolean),
  };
}

function renderParagraph(text: string, citations: CitationMap): ReactNode[] {
  const parts = text.split(/(\[\d+(?::[^\]]+)?\])/g);
  return parts.map((part, i) => {
    const match = part.match(/\[(\d+)(?::([^\]]+))?\]/);
    if (match) {

      const [, idStr, label] = match;
      const id = +idStr;
      const citation = citations[id];
      const meta = citation
        ? [citation.location, citation.fileType].filter(Boolean).join(' • ')
        : '';

      return (
        <span key={i} className="relative group inline-flex items-baseline gap-1">
          {citation?.url ? (
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-[18px] h-[18px] bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] rounded-full font-semibold leading-none flex-shrink-0 translate-y-[-1px] transition-colors"
            >
              {id}
            </a>
          ) : (
            <span className="inline-flex items-center justify-center w-[18px] h-[18px] bg-indigo-600 text-white text-[10px] rounded-full font-semibold leading-none flex-shrink-0 translate-y-[-1px]">
              {id}
            </span>
          )}
          {citation && (
            <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 bg-white border border-gray-200 rounded-xl shadow-lg p-3 text-left opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-20">
              <p className="text-xs font-semibold text-gray-800 leading-tight mb-1">{citation.sourceTitle}</p>
              {citation.url && (
                <p className="text-[10px] text-indigo-500 truncate mb-1">{citation.url}</p>
              )}
              {meta && <p className="text-[10px] text-gray-400 font-medium">{meta}</p>}
            </span>
          )}
          {label && <span className="text-indigo-600 font-semibold">{label}</span>}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
