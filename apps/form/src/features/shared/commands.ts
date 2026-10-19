// Write outcomes for revision-guarded resources and keyed commands.
// `run` closes over the exact payload, expected revision and command key, so `retry` resends them unchanged.
import { useCallback, useRef, useState } from 'react';
import { ApiError, commandKey } from '../../api/client';
import type { SaveResult } from '../contract';

export async function guardedSave<T>(run: () => Promise<T>, reload: () => Promise<T>): Promise<SaveResult<T>> {
  try {
    return { status: 'saved', value: await run() };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'stale_revision') {
        try { return { status: 'stale', latest: await reload() }; }
        catch (reloadError) { return { status: 'failed', error: asApiError(reloadError) }; }
      }
      if (error.effectUnknown) return { status: 'unknown', retry: () => guardedSave(run, reload) };
    }
    return { status: 'failed', error: asApiError(error) };
  }
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, 'client_error', error instanceof Error ? error.message : 'Form could not save this change.');
}

/**
 * Single-flight guard. The ref (not render state) decides, so retry closures created while busy still run later.
 */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const run = useCallback(async (work: () => Promise<unknown>) => {
    if (flight.current) return;
    flight.current = true; setBusy(true);
    try { await work(); } finally { flight.current = false; setBusy(false); }
  }, []);
  return { busy, run };
}

/**
 * One command key per user intent. The key survives an unknown result so the retry is the same command;
 * `intent` (the canonical payload) changing means a new command and a new key.
 */
export function useCommandKey() {
  const current = useRef<{ intent: string; key: string } | null>(null);
  const keyFor = useCallback((intent: unknown) => {
    const text = JSON.stringify(intent);
    if (!current.current || current.current.intent !== text) current.current = { intent: text, key: commandKey() };
    return current.current.key;
  }, []);
  const settle = useCallback(() => { current.current = null; }, []);
  return { keyFor, settle };
}
