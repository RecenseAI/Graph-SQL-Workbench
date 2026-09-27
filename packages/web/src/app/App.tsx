import { useEffect } from 'react';
import { Splitter } from './Splitter.tsx';
import { TitleBar } from './TitleBar.tsx';
import { StatusBar } from './StatusBar.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { HelpSheet } from './HelpSheet.tsx';
import { ConnectionPanel } from '../features/connections/ConnectionPanel.tsx';
import { SchemaTree } from '../features/schema/SchemaTree.tsx';
import { HistoryPanel } from '../features/insight/InsightPanels.tsx';
import { ErDiagram } from '../features/er/ErDiagram.tsx';
import { EditorPane } from '../features/editor/EditorPane.tsx';
import { ResultDock } from '../features/results/ResultDock.tsx';
import { CellInspector } from '../features/results/CellInspector.tsx';
import { useWorkbench, activeTab } from '../store/workbench.ts';
import { IconDatabase, IconGraph, IconHistory, IconLink } from './Icons.tsx';
import { IconButton } from '../ui/primitives.tsx';

export function App() {
  const init = useWorkbench((s) => s.init);
  const pollHealth = useWorkbench((s) => s.pollHealth);
  const sidebarWidth = useWorkbench((s) => s.sidebarWidth);
  const setSidebarWidth = useWorkbench((s) => s.setSidebarWidth);
  const dockHeight = useWorkbench((s) => s.dockHeight);
  const setDockHeight = useWorkbench((s) => s.setDockHeight);
  const sidebarView = useWorkbench((s) => s.sidebarView);
  const setSidebarView = useWorkbench((s) => s.setSidebarView);
  const setPaletteOpen = useWorkbench((s) => s.setPaletteOpen);
  const addTab = useWorkbench((s) => s.addTab);
  const run = useWorkbench((s) => s.run);
  const tab = useWorkbench(activeTab);

  useEffect(() => {
    void init();
    const timer = window.setInterval(() => void pollHealth(), 15_000);
    return () => window.clearInterval(timer);
  }, [init, pollHealth]);

  // Global shortcuts. Editor-local ones live in the Monaco instance so they do not fire while
  // the user is typing in a filter box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.ctrlKey || event.metaKey;
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (meta && event.key.toLowerCase() === 't') {
        event.preventDefault();
        addTab('sql');
        return;
      }
      const target = event.target as HTMLElement | null;
      const inField = target ? ['INPUT', 'TEXTAREA'].includes(target.tagName) : false;
      const inEditor = target?.closest('.monaco-editor') !== null && target?.closest('.monaco-editor') !== undefined;
      if (!inField && !inEditor && (event.key === 'F5' || (meta && event.key === 'Enter')) && tab) {
        event.preventDefault();
        void run(tab.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addTab, run, setPaletteOpen, tab]);

  const views = [
    { id: 'schema' as const, label: 'Schema', icon: <IconGraph size={15} /> },
    { id: 'connections' as const, label: 'Connections', icon: <IconDatabase size={15} /> },
    { id: 'er' as const, label: 'Relationship diagram', icon: <IconLink size={15} /> },
    { id: 'history' as const, label: 'History', icon: <IconHistory size={15} /> },
  ];

  return (
    <div className="flex h-full flex-col bg-bg-0 text-ink-0">
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        {/* Activity rail */}
        <nav className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-line bg-bg-1 py-1.5">
          {views.map((view) => (
            <IconButton
              key={view.id}
              label={view.label}
              size={28}
              active={sidebarView === view.id}
              onClick={() => setSidebarView(view.id)}
            >
              {view.icon}
            </IconButton>
          ))}
        </nav>

        {/* Sidebar */}
        <aside className="flex shrink-0 flex-col overflow-hidden bg-bg-1" style={{ width: sidebarWidth }}>
          {sidebarView === 'schema' ? (
            <SchemaTree />
          ) : sidebarView === 'connections' ? (
            <ConnectionPanel />
          ) : sidebarView === 'er' ? (
            <ErDiagram variant="sidebar" />
          ) : (
            <HistoryPanel />
          )}
        </aside>
        <Splitter
          orientation="vertical"
          size={sidebarWidth}
          onSize={setSidebarWidth}
          min={220}
          max={560}
          label="Resize sidebar"
        />

        {/* Editor and results */}
        <main className="flex min-w-0 flex-1 flex-col">
          <EditorPane />
          <Splitter
            orientation="horizontal"
            size={dockHeight}
            onSize={setDockHeight}
            min={120}
            max={760}
            side="after"
            label="Resize results"
          />
          <section data-testid="dock" className="shrink-0 overflow-hidden" style={{ height: dockHeight }}>
            <ResultDock />
          </section>
        </main>

        <CellInspector />
      </div>

      <StatusBar />
      <CommandPalette />
      <HelpSheet />
    </div>
  );
}
