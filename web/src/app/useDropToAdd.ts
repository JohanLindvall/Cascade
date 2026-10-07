// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api } from '../api';
import { useToast } from '../components/toast';
import { acceptTorrents, dropText, droppedFiles, linksFromDrop } from '../files';
import { useLatest } from '../hooks';
import { carriesFiles, carriesPayload, isTextEntry } from './dom';

interface DropOptions {
  /**
   * The Add dialog is open. It has its own dropzone, and what lands there is
   * staged rather than started, so the window then neither lights up nor adds.
   */
  staging: boolean;
  /** Something was dropped and is on its way: where, and how many items. */
  onLaunch: (x: number, y: number, count: number) => void;
}

export interface DropTarget {
  /** A droppable drag is over the window: show the overlay. */
  dropping: boolean;
  /** Spread on the app's root element. */
  handlers: {
    onDragEnter: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
}

/**
 * Drop anywhere to add: .torrent files, and magnet links or URLs dragged out
 * of another tab, start immediately. The browser's default for any drop it is
 * not told otherwise about is to navigate to the dropped file — throwing the
 * whole UI away — so every drag over the window is claimed, and one landing
 * outside the app element is cancelled too.
 */
export function useDropToAdd({ staging, onLaunch }: DropOptions): DropTarget {
  const [dropping, setDropping] = useState(false);
  const depth = useRef(0);
  const toast = useToast();
  const options = useLatest({ staging, onLaunch });

  const submit = useCallback(
    async (form: FormData) => {
      form.append('start', '1');
      try {
        const result = await api.upload(form);
        for (const error of result.errors) toast.push('error', error);
      } catch (error) {
        toast.error(error);
      }
    },
    [toast],
  );

  const onDragEnter = useCallback((event: DragEvent) => {
    if (options.current.staging || !carriesPayload(event.dataTransfer)) return;
    depth.current += 1;
    setDropping(true);
  }, [options]);

  const onDragLeave = useCallback((event: DragEvent) => {
    if (options.current.staging || !carriesPayload(event.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDropping(false);
  }, [options]);

  const onDragOver = useCallback((event: DragEvent) => {
    // Text dragged over a field is the field's; a file is still ours.
    if (isTextEntry(event.target) && !carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDrop = useCallback((event: DragEvent) => {
    depth.current = 0;
    setDropping(false);
    const transfer = event.dataTransfer;
    // Read files from both .files and .items, synchronously — a browser that
    // exposed the drop only through .items would otherwise look like a bare
    // path drop and be turned away (see droppedFiles).
    const dropped = droppedFiles(transfer);
    // Text or a link dropped on a field is the field's own: a magnet dragged
    // into the Add dialog's link box, a name into the search.
    if (dropped.length === 0 && isTextEntry(event.target)) return;
    event.preventDefault();

    // The Add dialog stages its own drops (its dropzone stops propagation, so
    // this only ever sees the ones that missed it): say where the file should
    // land rather than swallow it without a trace, which read as dragging
    // being broken.
    if (options.current.staging) {
      toast.push('info', 'Drop it on the dialog’s dropzone — or close the dialog to add it straight away.');
      return;
    }

    const { accepted, ignored } = acceptTorrents(dropped);
    if (ignored) toast.push('info', ignored);
    if (accepted.length > 0) {
      options.current.onLaunch(event.clientX, event.clientY, accepted.length);
      const form = new FormData();
      for (const file of accepted) form.append('torrents', file);
      void submit(form);
      return;
    }
    if (dropped.length > 0) return; // Only non-torrents: already said so.

    const { links, problem } = linksFromDrop(dropText(transfer));
    if (problem) {
      toast.push(problem.level, problem.text);
      return;
    }
    options.current.onLaunch(event.clientX, event.clientY, links.length);
    const form = new FormData();
    form.append('urls', links.join('\n'));
    void submit(form);
  }, [options, submit, toast]);

  // A drop that lands outside the app element would otherwise make the
  // browser navigate to the file, discarding the UI.
  useEffect(() => {
    const block = (event: globalThis.DragEvent) => {
      if (isTextEntry(event.target) && !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  // The Add dialog opening mid-drag (the keyboard's n) takes the drag over:
  // no overlay, or stale count, may be left behind for it.
  useEffect(() => {
    if (!staging) return;
    depth.current = 0;
    setDropping(false);
  }, [staging]);

  return { dropping, handlers: { onDragEnter, onDragLeave, onDragOver, onDrop } };
}
