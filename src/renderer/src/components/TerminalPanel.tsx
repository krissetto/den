import { useEffect, useRef, useState, useCallback } from 'react'
import { PanelRight, Info, Play, RefreshCw, AlertTriangle } from 'lucide-react'
import { Terminal, FitAddon } from 'ghostty-web'
import type { Ghostty, ITheme } from 'ghostty-web'
import { loadGhostty } from '../lib/ghostty'
import { useStore, unackedBlockCount } from '../store'
import { termTheme as resolveTermTheme } from '../lib/termThemes'
import type { Sandbox } from '../types'

interface XTermProps {
  sandboxId: string
  visible: boolean
  theme: ITheme
  // Subscribe to live output; return an unsubscribe fn. `write` feeds the terminal.
  subscribe: (write: (data: string) => void) => (() => void) | undefined
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
  // Called once after the first fit with the real size (start/attach the session).
  onStart: (cols: number, rows: number) => void
  onDispose?: () => void
  // If provided, the terminal accepts dropped files (e.g. images for the agent).
  onDropFiles?: (files: File[]) => void
  // Bumping this number forces a redraw (refit + repaint the attached TUI).
  redraw?: number
}

// A real VT100 terminal (xterm.js) that handles full-screen TUIs like Claude Code.
function XTerm({ sandboxId, visible, theme, subscribe, onInput, onResize, onStart, onDispose, onDropFiles, redraw }: XTermProps) {
  const ref = useRef<HTMLDivElement>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termRef = useRef<Terminal | null>(null)
  // Size last pushed to the PTY, shared so the visibility effect can tell whether
  // it needs to resync the backend (a hidden tab is laid out at a different size
  // than the visible one — see the visibility effect below).
  const sentColsRef = useRef(0)
  const sentRowsRef = useRef(0)
  // onResize identity changes each render; keep it in a ref so forceRedraw can be
  // a stable callback (otherwise effects depending on it would re-fire endlessly).
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize
  const [dragging, setDragging] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const themeKey = JSON.stringify(theme)

  // Force the attached agent to repaint. Refit, then push the size to the PTY:
  // if it changed that's a real SIGWINCH (the TUI redraws); if it's unchanged —
  // e.g. a fresh terminal after a sandbox switch reattaching to a running agent,
  // where the grid matches but our buffer is empty — do a brief resize round-trip
  // so the agent still redraws its full frame. This is the redraw "toggling a
  // side panel" used to trigger, now done deliberately.
  const forceRedraw = useCallback(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return
    try {
      fit.fit()
      if (term.rows <= 0) return
      const resize = onResizeRef.current
      if (term.cols !== sentColsRef.current || term.rows !== sentRowsRef.current) {
        sentColsRef.current = term.cols; sentRowsRef.current = term.rows
        resize(term.cols, term.rows)
      } else {
        resize(term.cols, Math.max(1, term.rows - 1))
        requestAnimationFrame(() => { try { resize(term.cols, term.rows) } catch { /* ignore */ } })
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!ref.current) return
    let disposed = false
    let term: Terminal | undefined
    let fit: FitAddon | undefined
    let settleT: ReturnType<typeof setTimeout> | undefined
    let ro: ResizeObserver | undefined
    let dataDisp: { dispose: () => void } | undefined
    let selDisp: { dispose: () => void } | undefined
    let unsub: (() => void) | undefined

    const openTerminal = async () => {
      let ghostty: Ghostty
      try {
        ghostty = await loadGhostty()
      } catch (error) {
        if (!disposed) setInitError(error instanceof Error ? error.message : String(error))
        return
      }
      if (disposed || !ref.current) return
      setInitError(null)
      term = new Terminal({
        ghostty,
        cursorBlink: true,
        fontFamily: 'Menlo, Monaco, "SF Mono", "DejaVu Sans Mono", monospace',
        fontSize: 12,
        theme,
        scrollback: 5000
      })
      termRef.current = term
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(ref.current)
      fitRef.current = fit

      const refit = () => {
        try {
          fit?.fit()
        } catch { /* container not sized yet */ }
      }
      const syncSize = () => {
        if (disposed || !term) return
        if (term.cols !== sentColsRef.current || term.rows !== sentRowsRef.current) {
          sentColsRef.current = term.cols; sentRowsRef.current = term.rows
          onResize(term.cols, term.rows)
        }
      }
      const kick = () => { if (!disposed) { refit(); syncSize() } }

      refit()
      sentColsRef.current = term.cols; sentRowsRef.current = term.rows
      onStart(term.cols, term.rows)
      requestAnimationFrame(() => { kick(); requestAnimationFrame(kick) })
      settleT = setTimeout(() => { if (!disposed) forceRedraw() }, 150)
      document.fonts?.ready?.then(() => { if (!disposed) forceRedraw() }).catch(() => {})
      if (visible) setTimeout(() => { try { term?.focus() } catch { /* ignore */ } }, 0)

      unsub = subscribe((data) => term?.write(data))
      dataDisp = term.onData(onInput)
      selDisp = term.onSelectionChange(() => {
        const sel = term?.getSelection()
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {})
      })
      term.attachCustomWheelEventHandler((event) => {
        if (!term?.hasMouseTracking()) return false

        const canvas = ref.current?.querySelector('canvas')
        if (!canvas) return false
        const bounds = canvas.getBoundingClientRect()
        // ghostty-web reserves a 12px gutter at the right of the canvas. The
        // terminal grid ends before it, so derive cells from the content width.
        const contentWidth = Math.max(1, bounds.width - 12)
        const col = Math.max(1, Math.min(term.cols, Math.floor((event.clientX - bounds.left) / (contentWidth / term.cols)) + 1))
        const row = Math.max(1, Math.min(term.rows, Math.floor((event.clientY - bounds.top) / (bounds.height / term.rows)) + 1))
        const modifiers = (event.shiftKey ? 4 : 0) | (event.altKey ? 8 : 0) | (event.ctrlKey ? 16 : 0)
        const button = (event.deltaY < 0 ? 64 : 65) + modifiers
        const data = term.getMode(1006)
          ? `\x1b[<${button};${col};${row}M`
          : `\x1b[M${String.fromCharCode(button + 32, Math.min(255, col + 32), Math.min(255, row + 32))}`
        onInput(data)
        return true
      })
      term.attachCustomKeyEventHandler((e) => {
        if (e.type === 'keydown' && (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyV') {
          navigator.clipboard?.readText().then((text) => { if (text) onInput(text) }).catch(() => {})
          return true
        }
        return false
      })

      ro = new ResizeObserver(kick)
      ro.observe(ref.current)
    }

    void openTerminal()

    return () => {
      disposed = true
      if (settleT) clearTimeout(settleT)
      ro?.disconnect()
      dataDisp?.dispose()
      selDisp?.dispose()
      unsub?.()
      term?.dispose()
      termRef.current = null
      fitRef.current = null
      onDispose?.()
    }
    // Re-create the terminal when the sandbox changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandboxId, themeKey])

  // Force a repaint when this tab becomes visible (the inactive tab is laid out
  // at a different size than the active one, so the agent's last frame won't match
  // the now-visible grid) and refocus it.
  useEffect(() => {
    if (!visible) { termRef.current?.blur(); return }
    const raf = requestAnimationFrame(() => {
      forceRedraw()
      try { termRef.current?.focus() } catch { /* ignore */ }
    })
    return () => cancelAnimationFrame(raf)
  }, [visible, forceRedraw])

  // Explicit redraw trigger (the toolbar "Redraw" control). Only the visible
  // terminal needs it; the hidden sibling repaints when it's shown.
  useEffect(() => {
    if (redraw && visible) forceRedraw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redraw])

  // A drop only fires if dragover is preventDefault'd — otherwise Electron's
  // default file-open kicks in and the drop never reaches us.
  const dnd = onDropFiles
    ? {
        onDragOver: (e: React.DragEvent) => {
          if (![...e.dataTransfer.types].includes('Files')) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          if (!dragging) setDragging(true)
        },
        onDragLeave: (e: React.DragEvent) => {
          // Ignore leaves into child nodes; only clear when leaving the container.
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          setDragging(false)
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault()
          setDragging(false)
          const files = [...e.dataTransfer.files]
          if (files.length) onDropFiles(files)
        }
      }
    : {}

  // Clicking anywhere in the container (incl. padding) focuses the terminal.
  // The xterm mount (`ref`) is a dedicated inner div so xterm can own its DOM
  // while React owns the wrapper (overlay + drop handlers).
  return (
    <div
      onMouseDown={() => { if (visible) termRef.current?.focus() }}
      style={{ position: 'relative', flex: 1, minHeight: 0, width: '100%', height: '100%' }}
      {...dnd}
    >
      <div ref={ref} style={{ width: '100%', height: '100%', padding: '6px 8px' }} />
      {initError && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', padding: 24, color: theme.foreground }}>
          <span role="alert">Terminal failed to initialize: {initError}</span>
        </div>
      )}
      {dragging && (
        <div className="term-drop">
          <span>Drop files to attach to the agent</span>
        </div>
      )}
    </div>
  )
}

// Placeholder with an inline Start button (so you don't reach for the header).
function StoppedView({ theme, label, status, onStart }: { theme: ITheme; label: string; status: string; onStart?: () => void }) {
  const busy = status !== 'stopped'
  return (
    <div style={{
      flex: 1, background: theme.background, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16
    }}>
      <span style={{ color: theme.foreground, opacity: 0.4, fontSize: 12 }}>{label}</span>
      {onStart && (
        <button className="btn btn-primary btn-sm" onClick={onStart} disabled={busy}>
          <Play size={11} fill="currentColor" strokeWidth={0} />
          {status === 'starting' ? 'Starting…' : 'Start sandbox'}
        </button>
      )}
    </div>
  )
}

// ── Agent tab ─────────────────────────────────────────────────────────────

function AgentTerminal({ sandbox, visible, theme, onStart, redraw }: { sandbox: Sandbox; visible: boolean; theme: ITheme; onStart?: () => void; redraw: number }) {
  if (sandbox.status !== 'running') {
    return <StoppedView theme={theme} label="Start the sandbox to launch the agent." status={sandbox.status} onStart={onStart} />
  }
  return (
    <XTerm
      sandboxId={sandbox.id}
      visible={visible}
      theme={theme}
      redraw={redraw}
      subscribe={(write) => window.minipit?.onAgentOutput((name, data) => { if (name === sandbox.name) write(data) })}
      onInput={(data) => window.minipit?.agentWrite(sandbox.name, data)}
      onResize={(cols, rows) => window.minipit?.agentResize(sandbox.name, cols, rows)}
      onStart={(cols, rows) => window.minipit?.agentEnsure(sandbox.name, cols, rows)}
      onDropFiles={async (files) => {
        // Copy each dropped file into the sandbox, then type its in-sandbox path
        // into the agent — TUIs like Claude Code take a file path, not raw bytes.
        // Any file type works (images, PDFs, docs, spreadsheets, text, …); the
        // agent decides how to read it. Skip directories (no type, zero size).
        const paths: string[] = []
        for (const file of files) {
          if (!file.type && file.size === 0) continue
          const bytes = new Uint8Array(await file.arrayBuffer())
          const path = await window.minipit?.agentDropFile(sandbox.name, file.name, bytes)
          if (path) paths.push(path)
        }
        // One write with space-separated paths so multiple files land as args.
        if (paths.length) window.minipit?.agentWrite(sandbox.name, paths.join(' ') + ' ')
      }}
    />
  )
}

// ── Shell tab ─────────────────────────────────────────────────────────────

function ShellTerminal({ sandbox, visible, theme, onStart, redraw }: { sandbox: Sandbox; visible: boolean; theme: ITheme; onStart?: () => void; redraw: number }) {
  if (sandbox.status !== 'running') {
    return <StoppedView theme={theme} label="Start the sandbox to open a shell." status={sandbox.status} onStart={onStart} />
  }
  return (
    <XTerm
      sandboxId={sandbox.id}
      visible={visible}
      theme={theme}
      redraw={redraw}
      subscribe={(write) => window.minipit?.onPtyOutput((name, data) => { if (name === sandbox.name) write(data) })}
      onInput={(data) => window.minipit?.ptyWrite(sandbox.name, data)}
      onResize={(cols, rows) => window.minipit?.ptyResize(sandbox.name, cols, rows)}
      onStart={(cols, rows) => window.minipit?.ptyStart(sandbox.name, cols, rows)}
      onDispose={() => window.minipit?.ptyStop(sandbox.name)}
    />
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────

export function TerminalPanel({ sandbox, dock, onToggleFiles, onShowInfo, onStart }: {
  sandbox: Sandbox
  dock?: 'files' | 'info' | null
  onToggleFiles?: () => void
  onShowInfo?: () => void
  onStart?: () => void
}) {
  const [segment, setSegment] = useState<'agent' | 'shell'>('agent')
  // Bumped by the Redraw control to force the visible terminal to repaint — an
  // escape hatch for the occasional blank/stale agent view.
  const [redrawNonce, setRedrawNonce] = useState(0)
  const termThemeId = useStore((s) => s.termTheme)
  const appTheme = useStore((s) => s.theme)
  const theme = resolveTermTheme(termThemeId, appTheme).theme
  const bg = theme.background ?? '#0a0a0a'
  // Pending (unacknowledged) network-policy denials for this sandbox — surfaced
  // as a red warning next to Info, which opens the panel (clearing the badge).
  const hasBlocks = useStore((s) => unackedBlockCount(s.policyBlocks, s.blocksSeenAt, sandbox.name) > 0)

  return (
    <div
      className="term"
      style={{ ['--tbg' as string]: bg, ['--tfg' as string]: theme.foreground ?? '#d4d4d4' }}
    >
      <div className="term-bar">
        <div className="term-seg">
          <div className={`term-seg-item${segment === 'agent' ? ' active' : ''}`} onClick={() => setSegment('agent')}>
            Agent
          </div>
          <div className={`term-seg-item${segment === 'shell' ? ' active' : ''}`} onClick={() => setSegment('shell')}>
            Shell
          </div>
        </div>
        <div className="term-right">
          <button
            className="term-files"
            onClick={() => setRedrawNonce((n) => n + 1)}
            title="Redraw terminal (force a repaint)"
          >
            <RefreshCw size={13} />
          </button>
          {hasBlocks && onShowInfo && (
            <button
              className="term-files term-warn"
              onClick={onShowInfo}
              title="Network requests blocked — view details"
            >
              <AlertTriangle size={14} />
            </button>
          )}
          {onShowInfo && (
            <button
              className={`term-files${dock === 'info' ? ' active' : ''}`}
              onClick={onShowInfo}
              title="Sandbox info"
            >
              <Info size={14} />
              Info
            </button>
          )}
          {onToggleFiles && (
            <button
              className={`term-files${dock === 'files' ? ' active' : ''}`}
              onClick={onToggleFiles}
              title={dock === 'files' ? 'Hide files' : 'Show files'}
            >
              <PanelRight size={14} />
              Files
            </button>
          )}
        </div>
      </div>

      {/*
        Keep both mounted (visibility, not display:none) so each terminal keeps
        its dimensions and session when switching segments.
      */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: bg,
        visibility: segment === 'agent' ? 'visible' : 'hidden',
        pointerEvents: segment === 'agent' ? 'auto' : 'none',
        position: segment === 'agent' ? 'relative' : 'absolute',
        inset: segment === 'agent' ? undefined : 0
      }}>
        <AgentTerminal sandbox={sandbox} visible={segment === 'agent'} theme={theme} onStart={onStart} redraw={redrawNonce} />
      </div>

      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: bg,
        visibility: segment === 'shell' ? 'visible' : 'hidden',
        pointerEvents: segment === 'shell' ? 'auto' : 'none',
        position: segment === 'shell' ? 'relative' : 'absolute',
        inset: segment === 'shell' ? undefined : 0
      }}>
        <ShellTerminal sandbox={sandbox} visible={segment === 'shell'} theme={theme} onStart={onStart} redraw={redrawNonce} />
      </div>
    </div>
  )
}
