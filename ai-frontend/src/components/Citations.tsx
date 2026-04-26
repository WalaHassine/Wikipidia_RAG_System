export type CitationData = {
  id: number;
  sourceTitle: string;
  url?: string;
  excerpt?: string;
  location?: string;
  fileType?: string;
};

export default function CitationCard({ citation }: { citation: CitationData }) {
  const titleEl = citation.url ? (
    <a
      href={citation.url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs font-semibold text-indigo-700 hover:underline leading-tight"
    >
      {citation.sourceTitle}
    </a>
  ) : (
    <p className="text-xs font-semibold text-gray-800 leading-tight">{citation.sourceTitle}</p>
  );

  const meta = [citation.location, citation.fileType].filter(Boolean).join(' • ');

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm">
      <div className="flex items-start gap-2 mb-2.5">
        <span className="flex-shrink-0 w-[18px] h-[18px] rounded-full bg-indigo-100 text-indigo-600 text-[10px] flex items-center justify-center font-semibold leading-none">
          {citation.id}
        </span>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-gray-400 flex-shrink-0 mt-0.5"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
        {titleEl}
      </div>
      {citation.excerpt && (
        <p className="text-xs text-gray-500 leading-relaxed mb-2.5">{citation.excerpt}</p>
      )}
      {meta && <p className="text-xs text-gray-400 font-medium">{meta}</p>}
    </div>
  );
}
