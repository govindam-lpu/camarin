import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Flag, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { timeAgo } from '../lib/format';
import { useToasts } from './Toasts';

/**
 * In-app notification center (D-007). Polls every 10s; new flagged/failed
 * notifications also surface as toasts the moment the poll sees them.
 */
export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const seenIds = useRef<Set<string> | null>(null);
  const navigate = useNavigate();
  const { push } = useToasts();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: api.notifications,
    refetchInterval: 10_000,
  });

  // Toast newly-arrived unread notifications (skip the very first load).
  useEffect(() => {
    if (!data) return;
    if (seenIds.current === null) {
      seenIds.current = new Set(data.notifications.map((n) => n.id));
      return;
    }
    for (const n of data.notifications) {
      if (!seenIds.current.has(n.id)) {
        seenIds.current.add(n.id);
        if (!n.read) push(n.type === 'job_flagged' ? 'flag' : 'error', n.message);
      }
    }
  }, [data, push]);

  // Click-outside closes the panel.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const unread = data?.unreadCount ?? 0;

  const markAllRead = async () => {
    await api.markNotificationsRead({ all: true });
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        className="relative flex size-9 items-center justify-center rounded-md border border-edge bg-surface text-muted transition-colors hover:text-ink"
      >
        <Bell size={16} />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-alarm px-1 font-mono text-[10px] font-semibold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-40 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-edge bg-raised shadow-xl shadow-black/50">
          <div className="flex items-center justify-between border-b border-edge px-4 py-2.5">
            <span className="font-mono text-xs font-medium uppercase tracking-wider text-muted">
              Notifications
            </span>
            {unread > 0 && (
              <button
                onClick={() => void markAllRead()}
                className="font-mono text-xs text-amber hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {!data || data.notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-faint">
                Nothing yet. Flagged or failed jobs will appear here.
              </p>
            ) : (
              data.notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    void api.markNotificationsRead({ ids: [n.id] }).then(() => {
                      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
                    });
                    navigate(`/jobs/${n.jobId}`);
                  }}
                  className="flex w-full items-start gap-3 border-b border-edge/50 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-surface"
                >
                  {n.type === 'job_flagged' ? (
                    <Flag size={15} className="mt-0.5 shrink-0 text-alarm" />
                  ) : (
                    <XCircle size={15} className="mt-0.5 shrink-0 text-alarm" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm leading-snug ${n.read ? 'text-muted' : ''}`}>
                      {n.message}
                    </span>
                    <span className="mt-0.5 block font-mono text-[11px] text-faint">
                      {timeAgo(n.createdAt)}
                    </span>
                  </span>
                  {!n.read && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-amber" />}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
