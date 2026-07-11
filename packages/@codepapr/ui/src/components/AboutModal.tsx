interface AboutModalProps {
  lang: string | undefined;
  onClose: () => void;
}

export function AboutModal({ lang, onClose }: AboutModalProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-[#2a2d3a] bg-[#10131b] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#2a2d3a] px-5 py-4">
          <h2 className="text-base font-semibold text-slate-100">
            {lang === 'en' ? 'About CodePapr' : lang === 'zh-TW' ? '關於 CodePapr' : '关于 CodePapr'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-500 transition-colors hover:text-slate-200"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-5 text-sm leading-relaxed text-slate-400">
          <div className="mb-4">
            <p className="text-lg font-bold text-slate-100">CodePapr</p>
            <p className="text-xs text-slate-500">v0.1.0</p>
          </div>
          <p className="mb-4">
            {lang === 'en'
              ? 'A local-first coding agent workbench optimized for the DeepSeek model cache. Multi-agent collaboration with Explore, Scout, and Mentor sub-agents.'
              : lang === 'zh-TW'
              ? '一個面向 DeepSeek 緩存優化的本地編程 Agent 工作台。支援 Explore、Scout、Mentor 子代理多智能體協作。'
              : '一个面向 DeepSeek 缓存优化的本地编程 Agent 工作台。支持 Explore、Scout、Mentor 子代理多智能体协作。'}
          </p>

          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
            {lang === 'en' ? 'License' : lang === 'zh-TW' ? '許可證' : '许可证'}
          </h3>
          <p className="mb-4">MIT License</p>
          <p className="mb-2 text-xs">
            Copyright (c) 2025 CodePapr
          </p>
          <p className="mb-2 text-xs">
            Permission is hereby granted, free of charge, to any person obtaining a copy
            of this software and associated documentation files (the "Software"), to deal
            in the Software without restriction, including without limitation the rights
            to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
            copies of the Software, and to permit persons to whom the Software is
            furnished to do so.
          </p>
          <p className="mb-2 text-xs">
            THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
            IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
            FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
            AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
            LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
            OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
            SOFTWARE.
          </p>

          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-[0.15em] text-slate-500">
            {lang === 'en' ? 'Built With' : lang === 'zh-TW' ? '技術棧' : '技术栈'}
          </h3>
          <p className="text-xs">Tauri 2 · React · TypeScript · Rust · DeepSeek · Monaco Editor</p>
        </div>
      </div>
    </div>
  );
}
