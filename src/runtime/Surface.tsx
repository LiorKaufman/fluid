import { useEffect, useRef, useState } from 'react';
import sdk from './sdk.js?raw';
import {
  errorEnvelope,
  type Frontend,
  type FrontendSummary,
  type Snapshot,
} from '../protocol/index';
import { backend } from './backend';
import { frontendSource } from './frontend-source';

export function wrapFrontend(html: string, instance = crypto.randomUUID()) {
  // The first policy remains effective even if imported HTML adds another policy.
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${sdk.replace('__FLUID_INSTANCE__', instance)}</script></head><body>${html}</body></html>`;
}
export function Surface({
  frontend,
  snapshot,
  onError,
}: {
  frontend: FrontendSummary;
  snapshot: Snapshot;
  onError: (message: string) => void;
}) {
  const [source, setSource] = useState<Frontend>();
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    let cancelled = false;
    void frontendSource(frontend).then(
      (value) => {
        if (!cancelled) setSource(value);
      },
      (error: Error) => {
        if (!cancelled) onErrorRef.current(error.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [frontend.id, frontend.version, frontend.updatedAt]);
  if (
    !source ||
    source.id !== frontend.id ||
    source.version !== frontend.version
  )
    return (
      <div className="boot" role="status">
        Loading interface…
      </div>
    );
  return (
    <LoadedSurface frontend={source} snapshot={snapshot} onError={onError} />
  );
}

function LoadedSurface({
  frontend,
  snapshot,
  onError,
}: {
  frontend: Frontend;
  snapshot: Snapshot;
  onError: (message: string) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const [ready, setReady] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  useEffect(() => {
    let session: string | undefined,
      cancelled = false,
      connected = false;
    const instance = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout>;
    const sessionPromise = backend.request<string>('openSession', frontend.id);
    const receive = async (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== 'fluid:ready' ||
        event.data.instance !== instance ||
        connected
      )
        return;
      connected = true;
      try {
        session = await sessionPromise;
        if (cancelled) {
          void backend.request('closeSession', session);
          return;
        }
        const channel = new MessageChannel();
        port.current = channel.port1;
        channel.port1.onmessage = async ({ data }) => {
          if (
            !data ||
            typeof data.id !== 'string' ||
            typeof data.capability !== 'string'
          )
            return;
          try {
            const value = await backend.request(
              'call',
              session,
              data.capability,
              data.input ?? {},
            );
            channel.port1.postMessage({ id: data.id, ok: true, value });
          } catch (error) {
            channel.port1.postMessage({ id: data.id, ...errorEnvelope(error) });
          }
        };
        channel.port1.start();
        frame.current?.contentWindow?.postMessage(
          { type: 'fluid:init', instance },
          '*',
          [channel.port2],
        );
        setReady(true);
        clearTimeout(timer);
      } catch (error) {
        onErrorRef.current((error as Error).message);
      }
    };
    window.addEventListener('message', receive);
    // Register before assigning srcdoc: a cached document can run immediately.
    if (frame.current)
      frame.current.srcdoc = wrapFrontend(frontend.html, instance);
    timer = setTimeout(() => {
      if (!connected)
        onErrorRef.current(
          'This interface did not connect. You can restore Studio from the sidebar.',
        );
    }, 8000);
    sessionPromise.catch((error) => onErrorRef.current(error.message));
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setReady(false);
      window.removeEventListener('message', receive);
      port.current?.close();
      port.current = null;
      void sessionPromise
        .then((token) => backend.request('closeSession', token))
        .catch(() => {});
    };
  }, [frontend.id, frontend.version, frontend.html]);
  // Data and grant changes cause a re-read; audit-only changes do not create loops.
  const signal = JSON.stringify([
    snapshot.grants[frontend.id],
    snapshot.activity
      .filter(
        (a) => a.outcome === 'allowed' || a.action === 'permissions.update',
      )
      .map((a) => a.id),
  ]);
  useEffect(() => {
    if (ready) port.current?.postMessage({ type: 'changed' });
  }, [signal, ready]);
  return (
    <iframe
      ref={frame}
      className="surface"
      title={`${frontend.name} interface`}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
    />
  );
}
