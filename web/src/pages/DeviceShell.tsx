// DeviceShell — full-page WebSSH terminal.
//
// Keyless flow:
//   1. Page mounts → auto-connect (no login dialog). Device metadata is
//      fetched in parallel just for the title / status line.
//   2. WS opens → send the first `open` frame with cols/rows from the
//      freshly-fitted xterm (no credentials — the manager logs in with its
//      own key as the user the edge reported at install).
//   3. Manager replies with `ready` (SSH up, carries the login user) → the
//      terminal becomes interactive. Binary frames are stdout; binary user
//      input is wrapped to stdin.
//   4. `auth_error` / `exit` / WS close → write a red banner. The user can
//      hit `重连` to retry.
//
// Security:
//   - No credentials are sent or stored by the browser; auth is the
//     manager's server-side key plus RBAC on the shell endpoint.
//   - onbeforeunload sends a polite `{type:"close"}` so the manager can
//     finalize the audit row without waiting for TCP timeout.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Power, RotateCw, Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { XTerminal, type XTerminalApi } from '@/components/XTerminal';
import { getEdge, listEdges, type Edge } from '@/api/edges';
import {
  openShellSocket,
  probeShellPreflight,
  sendControl,
  type ShellControlFrameIn,
} from '@/api/webshell';
import { getToken } from '@/store/auth';
import { usePermissions } from '@/store/me';
import { tr as trInline, useI18n } from '@/i18n/locale';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { Shield } from 'lucide-react';

type ConnState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'closed'; reason?: string };

// ANSI red wrapper for inline error messages. xterm renders the escape
// sequence so we don't need a separate DOM element for status lines.
function ansiRed(s: string): string {
  return `\x1b[31m${s}\x1b[0m`;
}

function ansiDim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}

export default function DeviceShellPage() {
  const { tr } = useI18n();
  const { canMutate } = usePermissions();
  // viewer is read-only. Short-circuit before any WS setup
  // happens — backend rejects too (skill execute / shell open both
  // require non-viewer), but stopping at the page boundary keeps the
  // user from staring at a half-loaded terminal that 403s on connect.
  const { deviceId = '' } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  if (!canMutate) {
    return (
      <main className="anim-fade flex flex-1 flex-col overflow-hidden p-6">
        <PageHeader title={tr('终端', 'Terminal')} subtitle={tr('WebSSH — admin / user only', 'WebSSH — admin / user only')} />
        <Card className="p-6">
          <EmptyState
            icon={Shield}
            title={tr('只读账号不能进入终端', 'Viewer accounts cannot open the terminal')}
            hint={tr('WebSSH 会让你直接登录设备 root shell，只有 admin / user 能打开。', 'WebSSH gives root shell access. Only admin and user roles can open it.')}
          />
        </Card>
      </main>
    );
  }

  const [edge, setEdge] = useState<Edge | null>(null);
  const [edgeError, setEdgeError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>({ kind: 'idle' });
  // connectedUser is the OS user the manager logged in as, reported in the
  // `ready` frame. Shown in the status line so operators know who they are.
  const [connectedUser, setConnectedUser] = useState<string | null>(null);

  // The terminal API + ws live on refs — they're side-effectful and
  // outliving any single render is the whole point of this page.
  const termRef = useRef<XTerminalApi | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Latest cols/rows reported by xterm. We need them when sending the
  // first `open` frame (called from a callback that doesn't have direct
  // access to the terminal's geometry).
  const sizeRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  // Track whether we sent the close frame — onbeforeunload + manual close
  // should never double-fire.
  const closedSentRef = useRef(false);

  // Fetch device metadata for the title. The route param is the device_id
  // (Prom label). Manager does not yet expose GET /devices/{id}, so we
  // resolve the hostname by listing edges and matching device_id — matches
  // what Edges.tsx already does in-memory.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Cheap path: try direct lookup, fall back to list scan. The
        // manager's /edges/{id} expects an edge id, not a device id, so
        // we go straight to list. Limit=1000 mirrors the backend handler.
        const r = await listEdges();
        if (cancelled) return;
        const target = (r.items ?? []).find(
          (e) => String(e.device_id ?? '') === String(deviceId),
        );
        if (target) {
          // Refresh with full detail (host_info has more fields).
          try {
            const detail = await getEdge(target.id);
            if (!cancelled) setEdge(detail);
          } catch {
            if (!cancelled) setEdge(target);
          }
        } else {
          setEdgeError(tr('未找到该设备或设备未上线', 'Device not found or offline'));
        }
      } catch (err) {
        if (!cancelled) setEdgeError((err as Error).message || tr('加载设备信息失败', 'Failed to load device info'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  const tabTitle = useMemo(() => {
    if (!edge) return `Shell · ${deviceId}`;
    return `Shell · ${edge.name || deviceId}`;
  }, [edge, deviceId]);
  useEffect(() => {
    const prev = document.title;
    document.title = tabTitle;
    return () => {
      document.title = prev;
    };
  }, [tabTitle]);

  const writeBanner = useCallback((line: string) => {
    const t = termRef.current;
    if (!t) return;
    t.write(`\r\n${line}\r\n`);
  }, []);

  // sendCloseOnce guards against the WS-close + beforeunload double path.
  const sendCloseOnce = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    if (closedSentRef.current) return;
    closedSentRef.current = true;
    try {
      sendControl(ws, { type: 'close' });
    } catch {
      /* WS may already be closing */
    }
  }, []);

  // Tear down the socket. Caller decides whether to also dispose the
  // terminal — usually we keep it so the user can read final output.
  const teardown = useCallback(() => {
    sendCloseOnce();
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close(1000, 'client');
      } catch {
        /* noop */
      }
    }
  }, [sendCloseOnce]);

  // beforeunload: best-effort polite close. We can't await the close
  // frame; gorilla writes it on the next read tick.
  useEffect(() => {
    const onUnload = () => {
      sendCloseOnce();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.close(1000, 'unload');
        } catch {
          /* noop */
        }
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      // Final teardown when page actually unmounts (route change).
      onUnload();
    };
  }, [sendCloseOnce]);

  // openConnection: open the WS and send the geometry-only `open` frame.
  // Keyless — no credentials. Called on mount (auto-connect) and from "重连".
  const openConnection = useCallback(
    async () => {
      const token = getToken();
      if (!token) {
        writeBanner(ansiRed(tr('未登录或登录已过期，请重新登录', 'Not logged in or session expired; please log in again')));
        setConn({ kind: 'closed', reason: 'auth' });
        return;
      }
      // Tear down any previous socket (e.g. user hit "重连").
      teardown();
      closedSentRef.current = false;

      setConn({ kind: 'connecting' });

      // Pre-flight HTTP probe so 429 / 503 / 403 can be surfaced with
      // a real Chinese message — browsers don't expose upgrade-time
      // HTTP status to JS, only WS code 1006. If the probe returns a
      // non-OK status we abort before opening the socket.
      const probe = await probeShellPreflight(deviceId);
      if (probe) {
        const fatal = explainPreflight(probe.status, probe.message);
        if (fatal) {
          writeBanner(ansiRed(fatal));
          setConn({ kind: 'closed', reason: 'preflight' });
          return;
        }
      }

      const ws = openShellSocket(deviceId, token);
      wsRef.current = ws;
      const encoder = new TextEncoder();

      ws.onopen = () => {
        const { cols, rows } = sizeRef.current;
        sendControl(ws, {
          type: 'open',
          cols,
          rows,
          term: 'xterm-256color',
        });
      };

      ws.onmessage = (ev) => {
        // Binary == stdout/stderr. xterm handles it directly.
        if (ev.data instanceof ArrayBuffer) {
          termRef.current?.write(new Uint8Array(ev.data));
          return;
        }
        if (typeof ev.data !== 'string') return;
        let frame: ShellControlFrameIn | null = null;
        try {
          frame = JSON.parse(ev.data) as ShellControlFrameIn;
        } catch {
          return;
        }
        if (!frame || typeof frame.type !== 'string') return;
        switch (frame.type) {
          case 'ready': {
            const user = frame.ssh_user || '';
            setConnectedUser(user || null);
            setConn({ kind: 'open' });
            const who = user ? `${user}@${edge?.name ?? deviceId}` : String(edge?.name ?? deviceId);
            writeBanner(ansiDim(tr(`-- SSH 已连接 (${who}) --`, `-- SSH connected (${who}) --`)));
            break;
          }
          case 'auth_error':
            writeBanner(ansiRed(tr(`SSH 认证失败：${frame.message || '无法登录该设备'}`, `SSH auth failed: ${frame.message || 'cannot log in to this device'}`)));
            setConn({ kind: 'closed', reason: 'auth' });
            break;
          case 'exit': {
            const code = frame.exit_code ?? 0;
            const tail = frame.message ? `: ${frame.message}` : '';
            writeBanner(
              code === 0
                ? ansiDim(tr(`-- 会话已结束 (exit code 0)${tail} --`, `-- Session ended (exit code 0)${tail} --`))
                : ansiRed(tr(`-- 会话已结束 (exit code ${code})${tail} --`, `-- Session ended (exit code ${code})${tail} --`)),
            );
            setConn({ kind: 'closed', reason: 'exit' });
            break;
          }
        }
      };

      ws.onerror = () => {
        writeBanner(ansiRed(tr('WebSocket 连接错误', 'WebSocket connection error')));
      };

      ws.onclose = (ev) => {
        // 1006 = abnormal close (no close frame); usually means the
        // upgrade failed (auth, route, network) or the server cut the
        // socket without a close frame. Run the post-mortem probe to
        // see if the manager has a real HTTP status to report.
        if (!closedSentRef.current && ev.code === 1006) {
          writeBanner(ansiRed(tr('连接异常断开', 'Connection dropped unexpectedly')));
          // Best-effort post-mortem: hit GET on the same path; if the
          // manager replies with 429 / 503 / 403 we now know what went
          // wrong and can retell the user. Probe is fire-and-forget so
          // we don't block the close handler.
          void probeShellPreflight(deviceId).then((p) => {
            if (!p) return;
            const detail = explainPreflight(p.status, p.message);
            if (detail) writeBanner(ansiRed(detail));
          });
        } else if (ev.code !== 1000 && ev.code !== 1005) {
          writeBanner(
            ansiDim(tr(
              `-- 连接关闭 (code=${ev.code}${ev.reason ? `, ${ev.reason}` : ''}) --`,
              `-- Connection closed (code=${ev.code}${ev.reason ? `, ${ev.reason}` : ''}) --`,
            )),
          );
        }
        setConnectedUser(null);
        setConn((s) => (s.kind === 'closed' ? s : { kind: 'closed' }));
        wsRef.current = null;
      };

      // Wire xterm.onData to ws.send via the upper-scope ref. Set up here
      // so each new socket gets a fresh closure with its own encoder.
      pumpRef.current = (data: string) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(encoder.encode(data));
      };
    },
    [deviceId, edge, teardown, writeBanner],
  );

  // Auto-connect once on mount — no login dialog. Guarded by a ref so the
  // openConnection identity changing (edge metadata loading) doesn't reopen
  // a second socket.
  const autoConnectedRef = useRef(false);
  useEffect(() => {
    if (autoConnectedRef.current) return;
    autoConnectedRef.current = true;
    void openConnection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire xterm onData → ws via a ref-based pump so we don't have to
  // re-mount the terminal when the socket changes (reconnect).
  const pumpRef = useRef<(data: string) => void>(() => {});

  const onTermData = useCallback((data: string) => {
    pumpRef.current(data);
  }, []);

  const onTermResize = useCallback((cols: number, rows: number) => {
    sizeRef.current = { cols, rows };
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendControl(ws, { type: 'resize', cols, rows });
    }
  }, []);

  const attachTerm = useCallback((api: XTerminalApi) => {
    termRef.current = api;
  }, []);

  const handleManualClose = useCallback(() => {
    if (!confirm(tr('确定要关闭终端会话？', 'Close this terminal session?'))) return;
    teardown();
    navigate('/devices');
  }, [navigate, teardown]);

  const handleReconnect = useCallback(() => {
    void openConnection();
  }, [openConnection]);

  const statusLabel = useMemo(() => {
    switch (conn.kind) {
      case 'idle':
        return tr('未连接', 'Disconnected');
      case 'connecting':
        return tr('连接中…', 'Connecting…');
      case 'open':
        return tr('已连接', 'Connected');
      case 'closed':
        return tr('已断开', 'Closed');
    }
  }, [conn, tr]);

  const hostname =
    extractHostname(edge?.host_info) || edge?.name || deviceId || tr('设备', 'device');

  return (
    <main className="anim-fade flex flex-1 flex-col overflow-hidden bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-800/60 bg-zinc-900/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-300">
          <TerminalIcon size={14} className="text-zinc-500" />
          <span className="truncate font-medium text-zinc-100">{hostname}</span>
          <span className="text-zinc-600">·</span>
          <span
            className={
              conn.kind === 'open'
                ? 'text-emerald-400'
                : conn.kind === 'connecting'
                  ? 'text-amber-300'
                  : 'text-zinc-500'
            }
          >
            {statusLabel}
          </span>
          {connectedUser && (
            <>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">{connectedUser}</span>
            </>
          )}
          {edgeError && (
            <span className="ml-2 text-red-400">· {edgeError}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            onClick={handleReconnect}
            aria-label={tr('重新连接', 'Reconnect')}
          >
            <RotateCw size={12} />
            {tr('重连', 'Reconnect')}
          </Button>
          <Button
            variant="ghost"
            onClick={handleManualClose}
            aria-label={tr('关闭终端', 'Close terminal')}
          >
            <Power size={12} />
            {tr('关闭', 'Close')}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden p-2">
        <XTerminal
          onData={onTermData}
          onResize={onTermResize}
          attachRef={attachTerm}
        />
      </div>
    </main>
  );
}

// extractHostname is a slimmed-down copy of the helper in Edges.tsx; we
// duplicate rather than refactor because the field shape isn't fixed
// across edge versions and inlining keeps the dependency graph simple.
function extractHostname(hostInfo: Edge['host_info']): string | null {
  if (!hostInfo) return null;
  const obj =
    typeof hostInfo === 'string' ? safeParse(hostInfo) : hostInfo;
  if (!obj || typeof obj !== 'object') return null;
  const candidates = [
    (obj as Record<string, unknown>).hostname,
    (obj as Record<string, unknown>).hostName,
    (obj as Record<string, unknown>).nodename,
    (obj as Record<string, unknown>).host,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      const v = c.trim();
      return v.includes(':') ? v.split(':')[0] || v : v;
    }
  }
  return null;
}

// explainPreflight maps a probe HTTP status to a Chinese error string.
// Returns null when the status is fine (200/400-from-WS-upgrade-attempt
// without an Upgrade header — that's the "all good" signal).
//
// Status mapping:
//   429 → "并发会话过多（每用户最多 5 / 每设备最多 5）"
//   503 → "设备离线"
//   403 → "权限不足，请联系管理员"
//   401 → "未登录或登录已过期，请重新登录"
//   404 → "设备不存在或未上线"
//   500+ → "服务端错误"
function explainPreflight(status: number, _message: string): string | null {
  switch (status) {
    case 429:
      return trInline('并发会话过多（每用户最多 5 / 每设备最多 5）', 'Too many concurrent sessions (per user max 5 / per device max 5)');
    case 503:
      return trInline('设备离线', 'Device offline');
    case 403:
      return trInline('权限不足，请联系管理员', 'Insufficient permission; contact an admin');
    case 401:
      return trInline('未登录或登录已过期，请重新登录', 'Not logged in or session expired; please log in again');
    case 404:
      return trInline('设备不存在或未上线', 'Device not found or offline');
    default:
      if (status >= 500) return trInline('服务端错误，请稍后重试', 'Server error; please retry shortly');
      return null;
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

