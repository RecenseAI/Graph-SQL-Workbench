import { useState } from 'react';
import type { GraphQLRunResponse } from '@gqlwb/shared';
import { api, ApiError } from '../../lib/api.ts';
import { useWorkbench, type EditorTab } from '../../store/workbench.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { Badge, Button, EmptyState, cx } from '../../ui/primitives.tsx';
import { IconGraph, IconPlay } from '../../app/Icons.tsx';

/**
 * The GraphQL tab: the endpoint, unmediated.
 *
 * It exists because every claim the SQL side makes should be checkable. Paste a document from the
 * Generated GraphQL panel here and you see exactly what the endpoint returned, with no flattening,
 * no pagination loop and no shredding in between.
 */
export function GraphqlRunner({ tab }: { tab: EditorTab }) {
  const connectionId = useWorkbench((s) => s.activeConnectionId);
  const [response, setResponse] = useState<GraphQLRunResponse | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [running, setRunning] = useState(false);

  const send = async () => {
    if (!connectionId) {
      setError({ message: 'Add a connection first.' });
      return;
    }
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
      const result = await api.runGraphQL({ connectionId, document: tab.content });
      setResponse(result);
    } catch (err) {
      if (err instanceof ApiError) setError({ message: err.message, ...(err.hint ? { hint: err.hint } : {}) });
      else setError({ message: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-bg-1 px-2">
        <Button tone="primary" size="sm" icon={<IconPlay size={11} />} busy={running} onClick={() => void send()}>
          Send
        </Button>
        {response ? (
          <>
            <Badge tone={response.errors?.length ? 'warn' : 'ok'}>HTTP {response.status}</Badge>
            <span className="tnum text-[11px] text-ink-3">{response.ms} ms</span>
            <span className="tnum text-[11px] text-ink-3">{(response.bytes / 1024).toFixed(1)} kB</span>
            {response.errors?.length ? <Badge tone="err">{response.errors.length} errors</Badge> : null}
          </>
        ) : null}
      </div>

      <div className="min-h-0 flex-[3]">
        <CodeEditor tab={tab} onRun={() => void send()} onRunStatement={() => void send()} onStop={() => undefined} />
      </div>

      <div className="flex min-h-0 flex-[2] flex-col border-t border-line bg-bg-1">
        <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
          Response
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error ? (
            <div className="m-2 rounded border border-err/40 bg-err/10 p-2 text-[11px] leading-relaxed text-err">
              <p className="font-medium">{error.message}</p>
              {error.hint ? <p className="mt-1 text-ink-1">{error.hint}</p> : null}
            </div>
          ) : response ? (
            <>
              {response.errors?.length ? (
                <ul className="m-2 space-y-1 rounded border border-warn/40 bg-warn/10 p-2">
                  {response.errors.map((err, index) => (
                    <li key={index} className="text-[11px] leading-relaxed text-warn">
                      <span className="font-medium">{err.message}</span>
                      {err.path?.length ? <span className="text-ink-2"> at {err.path.join('.')}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <pre className={cx('p-2 font-mono text-[11px] leading-relaxed text-ink-1')}>
                {JSON.stringify(response.data, null, 2)}
              </pre>
            </>
          ) : (
            <EmptyState title="No response yet" icon={<IconGraph size={22} />}>
              Send a document to see exactly what the endpoint returns. Mutations are refused: the workbench is
              read-only.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}
