import { useQueryClient } from '@tanstack/react-query';
import { ImageUp } from 'lucide-react';
import { useCallback, useRef, useState, type DragEvent } from 'react';
import { api, ApiRequestError } from '../api/client';
import { useToasts } from './Toasts';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Client-side pre-validation is UX only — the API layer re-enforces everything
 * (size, MIME, magic bytes). Multiple files upload concurrently on purpose:
 * it demonstrates parallel pipeline processing.
 */
export function UploadDropzone() {
  const [dragOver, setDragOver] = useState(false);
  const [busyCount, setBusyCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { push } = useToasts();
  const queryClient = useQueryClient();

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      const accepted: File[] = [];
      for (const file of list) {
        if (!ACCEPTED_TYPES.includes(file.type)) {
          push('error', `"${file.name}" skipped — only JPG, PNG, or WEBP images are accepted`);
        } else if (file.size > MAX_BYTES) {
          push('error', `"${file.name}" skipped — larger than the 5MB limit`);
        } else {
          accepted.push(file);
        }
      }
      if (accepted.length === 0) return;

      setBusyCount((n) => n + accepted.length);
      await Promise.all(
        accepted.map(async (file) => {
          try {
            const { job } = await api.uploadJob(file);
            if (job.status === 'failed') {
              // Enqueue hiccup (D-018): the file is stored; Retry recovers it.
              push('error', `"${file.name}" uploaded but not queued — press Retry on the job`);
            } else {
              push('success', `"${file.name}" queued for processing`);
            }
          } catch (err) {
            const message =
              err instanceof ApiRequestError ? err.message : `Upload failed for "${file.name}"`;
            push('error', message);
          } finally {
            setBusyCount((n) => n - 1);
            void queryClient.invalidateQueries({ queryKey: ['jobs'] });
          }
        }),
      );
    },
    [push, queryClient],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      void handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Upload images"
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`group flex cursor-pointer items-center gap-4 rounded-lg border border-dashed px-5 py-5 transition-colors ${
        dragOver
          ? 'border-amber bg-amber/10'
          : 'border-edge-strong bg-surface hover:border-amber/60 hover:bg-raised'
      }`}
    >
      <div
        className={`flex size-11 shrink-0 items-center justify-center rounded-md border transition-colors ${
          dragOver
            ? 'border-amber/60 bg-amber/15 text-amber'
            : 'border-edge bg-raised text-muted group-hover:text-amber'
        }`}
      >
        <ImageUp size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {busyCount > 0
            ? `Uploading ${busyCount} file${busyCount > 1 ? 's' : ''}…`
            : 'Drop images to develop, or click to browse'}
        </p>
        <p className="mt-0.5 font-mono text-xs text-faint">
          JPG · PNG · WEBP — up to 5MB each. Multiple files process in parallel.
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
