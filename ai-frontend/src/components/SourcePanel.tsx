import CitationCard from './Citations';
import type { CitationData } from './Citations';

export default function SourcePanel({ citations }: { citations: CitationData[] }) {
  return (
    <aside className="w-72 bg-slate-50 border-l border-gray-100 flex flex-col flex-shrink-0">
      {/* Panel header */}
      <div className="px-5 py-4 bg-white border-b border-gray-100 flex items-center justify-between flex-shrink-0">
        <div>
          <p className="text-[10px] font-semibold text-gray-400 tracking-widest uppercase mb-0.5">
            Source Context
          </p>
          <h3 className="text-sm font-bold text-gray-900">Verified Citations</h3>
        </div>
        <button className="text-gray-400 hover:text-gray-600 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </button>
      </div>

      {/* Citations list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-3">
        {citations.map((c) => (
          <CitationCard key={c.id} citation={c} />
        ))}

        {/* Add source placeholder */}
        <button className="border-2 border-dashed border-gray-200 rounded-xl h-24 flex items-center justify-center text-gray-300 hover:border-indigo-200 hover:text-indigo-300 transition-colors">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-100 bg-white flex-shrink-0">
        <button className="w-full text-xs font-semibold text-gray-500 hover:text-gray-700 tracking-widest uppercase py-1.5 transition-colors">
          Manage Sources
        </button>
      </div>
    </aside>
  );
}
