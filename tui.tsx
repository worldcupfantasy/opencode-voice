/**
 * OpenCode V2 TUI voice input, backed by a local SenseVoiceSmall server.
 *
 * Flow:  hotkey / footer button -> record (ffmpeg/arecord) -> POST to a FunASR
 * OpenAI-compatible `/v1/audio/transcriptions` endpoint -> transcribe ->
 * insert the text straight into the prompt input box.
 *
 * The V2 CLI plugin API does not expose the composer directly, but the
 * renderer does: `context.renderer.currentFocusedEditor` is the focused edit
 * buffer (the prompt textarea), and `EditBufferRenderable.insertText()` writes
 * into it. No dialog, no auto-send.
 */
import { Plugin } from "@opencode/plugin/tui"
// Namespace import on purpose: the host resolves this peer for us, and a missing
// binding must never take the whole plugin (keybinds included) down at setup.
import * as opentui from "@opentui/core"
import { createSignal } from "solid-js"
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

type Variant = "info" | "success" | "warning" | "error"
type Status = "idle" | "recording" | "working"

interface Options {
  /** OpenAI-compatible base URL of the local SenseVoice/FunASR server. */
  endpoint: string
  /** Model alias requested from the server (FunASR maps this to SenseVoiceSmall). */
  model: string
  /** Language hint. "auto" lets the server detect it. */
  language: string
  /** Optional env var holding a bearer token for the STT endpoint. */
  apiKeyEnv?: string
  /** argv of the recorder; the output wav path is appended. */
  recorder: string[]
  /** Insert a separating space when the prompt is not empty. */
  spacePrefix: boolean
  /**
   * Where to render the voice button:
   * - "composer" (default): the composer's own status row, right after the
   *   "Build · model" text, bottom-right inside the input box.
   * - an exposed slot path, for hosts where the composer row is unavailable.
   * - false: no button, hotkeys only.
   */
  button: false | "composer" | "prompt.footer" | "prompt.footer.status" | "session.composer.top"
  /** Keybind that records, then stops + transcribes + inserts into the prompt. */
  toggleKey: string
  /** Keybind that additionally submits the prompt after inserting. */
  submitKey: string
  /**
   * Start the local server ourselves when the first transcription is refused
   * (ECONNREFUSED). Only applies to loopback endpoints. The started server is
   * detached: it keeps running after the TUI exits.
   */
  autostart: boolean
  /** argv used to start the server (a launcher script or systemctl, ...). */
  autostartCommand: string[]
  /** Seconds to wait for the server to answer /health after starting it. */
  autostartTimeout: number
}

/** Minimal structural view of the focused editor we write into. */
interface EditorLike {
  insertText(text: string): void
  plainText?: string
  isDestroyed?: boolean
}

// ffmpeg finalises the WAV reliably on SIGINT; `parecord --file-format=wav`
// was observed to occasionally leave only the 44-byte header behind.
const DEFAULT_RECORDER = [
  "ffmpeg",
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "pulse",
  "-i",
  "default",
  "-ac",
  "1",
  "-ar",
  "16000",
  "-y",
]

/** Directory holding this plugin file — the checkout root for a local install. */
const PLUGIN_DIR = (() => {
  try {
    return fileURLToPath(new URL(".", import.meta.url))
  } catch {
    return process.cwd()
  }
})()

/** Where an auto-started server writes its output: the TUI owns the terminal. */
const AUTOSTART_LOG = join(homedir(), ".local", "share", "opencode", "sensevoice-autostart.log")

/** Default launcher: the script shipped next to this plugin. */
const DEFAULT_AUTOSTART = ["bash", join(PLUGIN_DIR, "scripts", "serve-sensevoice.sh")]

/** Only a loopback endpoint can be something we start on this machine. */
function isLocalEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0"
  } catch {
    return false
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function readOptions(raw: Readonly<Record<string, unknown>>): Options {
  const str = (key: string, fallback: string) =>
    typeof raw[key] === "string" ? (raw[key] as string) : fallback
  const button =
    raw.button === false
      ? false
      : typeof raw.button === "string"
        ? (raw.button as Options["button"])
        : "composer"
  return {
    endpoint: str("endpoint", "http://127.0.0.1:8000/v1"),
    model: str("model", "sensevoice"),
    language: str("language", "auto"),
    apiKeyEnv: typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : undefined,
    recorder:
      Array.isArray(raw.recorder) && raw.recorder.length > 0
        ? raw.recorder.map(String)
        : DEFAULT_RECORDER,
    spacePrefix: raw.spacePrefix !== false,
    button,
    toggleKey: str("toggleKey", "alt+r"),
    submitKey: str("submitKey", "alt+shift+r"),
    autostart: raw.autostart !== false,
    autostartCommand:
      Array.isArray(raw.autostartCommand) && raw.autostartCommand.length > 0
        ? raw.autostartCommand.map(String)
        : DEFAULT_AUTOSTART,
    autostartTimeout:
      typeof raw.autostartTimeout === "number" && raw.autostartTimeout > 0
        ? Math.min(raw.autostartTimeout, 600)
        : 120,
  }
}

export default Plugin.define({
  id: "local.sensevoice.voice",
  setup(context) {
    const options = readOptions(context.options)
    const [status, setStatusRaw] = createSignal<Status>("idle")
    /** Every status change repaints the button; it is not a Solid-owned node. */
    const setStatus = (next: Status) => {
      setStatusRaw(next)
      paintButton()
    }

    let child: ChildProcess | undefined
    let childFile: string | undefined
    /** The prompt editor captured when recording started. */
    let target: EditorLike | null = null
    /** Transcript kept when no editor was reachable, retried by the tick. */
    let pendingText: string | undefined
    let pendingSubmit = false
    let pendingTries = 0
    /** Server we spawned because nothing was listening (autostart). */
    let serverChild: ChildProcess | undefined
    /** The spawned launcher died without ever answering /health. */
    let serverDied = false

    /** A renderable the host already tore down must never be touched again. */
    const live = (node: unknown): boolean =>
      !!node && (node as { isDestroyed?: boolean }).isDestroyed !== true

    const toast = (message: string, variant: Variant = "info") =>
      context.ui.toast.show({ message, variant })

    function focusedEditor(): EditorLike | null {
      try {
        const editor = context.renderer.currentFocusedEditor as unknown as EditorLike | null
        return live(editor) ? editor : null
      } catch {
        return null
      }
    }

    async function start(): Promise<void> {
      if (child || status() !== "idle") return
      const file = join(tmpdir(), `sensevoice-${Date.now()}.wav`)
      const [cmd, ...args] = options.recorder
      let proc: ChildProcess
      try {
        proc = spawn(cmd, [...args, file], { stdio: ["ignore", "ignore", "pipe"] })
      } catch (error) {
        toast(`无法启动录音程序 "${cmd}": ${String(error)}`, "error")
        return
      }
      child = proc
      childFile = file
      target = focusedEditor()
      setStatus("recording")

      proc.on("error", (error) => {
        if (child === proc) {
          child = undefined
          childFile = undefined
        }
        setStatus("idle")
        toast(`录音失败: ${error.message}`, "error")
      })
      proc.on("exit", () => {
        if (child === proc) child = undefined
      })
    }

    /** Stop the recorder and return the finished wav path (if any). */
    async function stop(): Promise<string | undefined> {
      const proc = child
      const file = childFile
      child = undefined
      childFile = undefined
      if (!proc || !file) return undefined

      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        proc.once("exit", finish)
        try {
          proc.kill("SIGINT") // recorders finalise the wav header on SIGINT
        } catch {
          finish()
        }
        setTimeout(() => {
          try {
            proc.kill("SIGKILL")
          } catch {}
          finish()
        }, 5000)
      })
      return file
    }

    /** True when the failure means "nothing is listening" rather than "bad request". */
    function isConnectionError(error: unknown): boolean {
      const seen = new Set<unknown>()
      let current: unknown = error
      while (current && typeof current === "object" && !seen.has(current)) {
        seen.add(current)
        const { code, message } = current as { code?: unknown; message?: unknown }
        if (typeof code === "string" && /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH)$/.test(code)) {
          return true
        }
        if (
          typeof message === "string" &&
          /ECONNREFUSED|Unable to connect|Connection refused|connection refused/i.test(message)
        ) {
          return true
        }
        current = (current as { cause?: unknown }).cause
      }
      return false
    }

    /** `/health`, falling back to `/v1/models` for servers that only speak OpenAI. */
    async function serverHealthy(): Promise<boolean> {
      let origin: string
      try {
        origin = new URL(options.endpoint).origin
      } catch {
        return false
      }
      for (const url of [`${origin}/health`, `${origin}/v1/models`]) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
          if (res.ok) return true
        } catch {}
      }
      return false
    }

    /** Spawn the launcher, then wait for the port to answer. */
    async function startServer(): Promise<boolean> {
      // systemd (or another opencode instance) may have won the race already.
      if (await serverHealthy()) return true

      if (!serverChild && !serverDied) {
        let fd: number | undefined
        try {
          fd = openSync(AUTOSTART_LOG, "a")
          const [cmd, ...args] = options.autostartCommand
          const proc = spawn(cmd, args, {
            cwd: PLUGIN_DIR,
            detached: true, // survive the TUI exiting: it is a server
            stdio: ["ignore", fd, fd],
          })
          const onGone = () => {
            if (serverChild === proc) serverChild = undefined
            serverDied = true
          }
          proc.on("error", onGone)
          proc.on("exit", onGone)
          proc.unref()
          serverChild = proc
        } catch (error) {
          serverDied = true
          toast(`无法启动 SenseVoice 服务: ${describe(error)}`, "error")
          return false
        } finally {
          if (fd !== undefined) {
            try {
              closeSync(fd)
            } catch {}
          }
        }
      }

      const deadline = Date.now() + options.autostartTimeout * 1000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        if (await serverHealthy()) return true
        if (serverDied) return false // launcher exited without listening
      }
      return false
    }

    /** Transcribe, bringing a local server up first if nothing is listening. */
    async function transcribeWithServer(file: string): Promise<string> {
      try {
        return await transcribe(file)
      } catch (error) {
        const canAutostart = options.autostart && isLocalEndpoint(options.endpoint)
        if (!canAutostart || !isConnectionError(error)) throw error
        if (serverDied) {
          throw new Error(`${describe(error)}；自动启动失败，日志: ${AUTOSTART_LOG}`)
        }
        toast("SenseVoice 服务未启动，正在启动…", "info")
        if (!(await startServer())) {
          throw new Error(`${describe(error)}；自动启动超时，日志: ${AUTOSTART_LOG}`)
        }
        return await transcribe(file)
      }
    }

    async function transcribe(file: string): Promise<string> {
      const audio = await readFile(file)
      const form = new FormData()
      form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav")
      form.append("model", options.model)
      if (options.language && options.language !== "auto") {
        form.append("language", options.language)
      }

      const headers: Record<string, string> = {}
      const key = options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined
      if (key) headers.Authorization = `Bearer ${key}`

      const url = `${options.endpoint.replace(/\/+$/, "")}/audio/transcriptions`
      const res = await fetch(url, { method: "POST", body: form, headers })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const data = (await res.json()) as { text?: string }
      return (data.text ?? "").trim()
    }

    function insert(text: string, quiet = false): boolean {
      const write = (editor: EditorLike) => {
        const existing = editor.plainText ?? ""
        const prefix =
          options.spacePrefix && existing.length > 0 && !/\s$/.test(existing) ? " " : ""
        editor.insertText(prefix + text)
      }

      // The captured editor can be gone by now (session switch destroys it), so
      // re-resolve the focused one and skip anything the host already tore down.
      const editors: EditorLike[] = []
      for (const candidate of [target, focusedEditor()]) {
        if (!candidate || !live(candidate) || editors.includes(candidate)) continue
        editors.push(candidate)
      }

      if (editors.length === 0) {
        if (!quiet) toast("没找到输入栏，请把光标放进输入框再试一次", "warning")
        return false
      }

      let lastError: unknown
      for (const editor of editors) {
        try {
          write(editor)
          return true
        } catch (error) {
          lastError = error
          if (!live(editor) && editor === target) target = null
        }
      }
      if (!quiet) {
        toast(
          `写入输入栏失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          "error",
        )
      }
      return false
    }

    function submitPrompt(): void {
      try {
        context.keymap.dispatch("prompt.submit")
      } catch (error) {
        toast(`提交失败: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }

    async function finish(autoSubmit: boolean): Promise<void> {
      const file = await stop()
      if (!file) {
        setStatus("idle")
        return
      }
      setStatus("working")
      try {
        const text = await transcribeWithServer(file)
        if (!text) {
          toast("没有识别到语音内容", "warning")
          return
        }

        if (!insert(text, true)) {
          // Focus sat outside the composer (session list, dialog, ...). Keep the
          // transcript and retry from the tick instead of dropping it.
          pendingText = text
          pendingSubmit = autoSubmit
          pendingTries = 0
          return
        }

        if (autoSubmit) submitPrompt()
      } catch (error) {
        // With autostart on, transcribeWithServer() already explains itself.
        const suffix =
          isConnectionError(error) && !(options.autostart && isLocalEndpoint(options.endpoint))
            ? `（请确认 SenseVoice 服务已启动: ${options.endpoint}）`
            : ""
        toast(`转写失败: ${describe(error)}${suffix}`, "error")
      } finally {
        setStatus("idle")
        void rm(file, { force: true }).catch(() => {})
      }
    }

    const toggle = () => {
      if (status() === "recording") void finish(false)
      else void start()
    }
    const toggleSubmit = () => {
      if (status() === "recording") void finish(true)
      else void start()
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 5,
      commands: [
        {
          id: "sensevoice.toggle",
          title: "SenseVoice: 录音 / 停止并填入输入框",
          description: "用本地 SenseVoiceSmall 转写语音，直接写入输入框",
          group: "Voice",
          bind: options.toggleKey,
          palette: true,
          slash: { name: "voice" },
          run: () => toggle(),
        },
        {
          id: "sensevoice.submit",
          title: "SenseVoice: 录音 / 停止并填入后发送",
          group: "Voice",
          bind: options.submitKey,
          palette: true,
          run: () => toggleSubmit(),
        },
      ],
      bindings: ["sensevoice.toggle", "sensevoice.submit"],
    }))

    // --- voice button -------------------------------------------------------
    // The V2 slot tree has no path for the composer row that renders
    // "Build · model": that row is host-owned, not a slot boundary (only
    // `prompt.footer*`, the line under the box, is exposed). It is reachable
    // through the renderer though — the editor's parent holds the textarea and
    // the status row as siblings, and the status row lays out with
    // `justifyContent: space-between`, so a second child lands on its right
    // edge: the bottom-right corner of the input box, using no extra line.
    //
    // Two rules keep that safe, because the host owns the subtree and destroys
    // it on every session switch:
    //   1. never touch a renderable whose `isDestroyed` is set — writing to the
    //      text buffer of a torn-down node threw "TextBuffer is destroyed" once
    //      per second, and
    //   2. rebuild the button from scratch when it was destroyed with the old
    //      subtree, instead of re-adding the dead node.
    let mountedRow: unknown
    let button: any
    let buttonText: any
    let painted: string | undefined
    let ticker: ReturnType<typeof setInterval> | undefined

    const BUTTON_ID = "sensevoice.voice.button"
    const LABEL_ID = "sensevoice.voice.label"
    // Marker props next to the ids: the ids are also readable, but a plain flag
    // on the node keeps detection working whatever the host does with `id`.
    const BUTTON_MARK = "__sensevoiceVoiceButton"
    const LABEL_MARK = "__sensevoiceVoiceLabel"
    const isOurButton = (node: any) => !!node && (node[BUTTON_MARK] === true || node.id === BUTTON_ID)
    const isOurLabel = (node: any) => !!node && (node[LABEL_MARK] === true || node.id === LABEL_ID)
    const BoxCtor = () => (opentui as any)?.BoxRenderable as any
    const TextCtor = () => (opentui as any)?.TextRenderable as any
    // Resolved once: a host that stops exposing these classes degrades to the
    // slot button, because a setup throw would take the keybinds down with it.
    const canMount = typeof BoxCtor() === "function" && typeof TextCtor() === "function"

    const buttonLabel = () =>
      status() === "recording" ? "● 录音中" : status() === "working" ? "● 转写中" : "○ 录音"

    const buttonColor = () =>
      status() === "recording"
        ? context.theme.text.feedback.error.base
        : status() === "working"
          ? context.theme.text.base
          : context.theme.text.muted

    function detachButton(): void {
      const dead = button
      const parent: any = (dead as any)?.parent
      button = undefined
      buttonText = undefined
      mountedRow = undefined
      painted = undefined
      if (!dead) return
      // `destroy()` marks the node dead but leaves it in the parent's child list,
      // so detach explicitly — otherwise the stale node keeps painting and the
      // next mount looks like a duplicate.
      try {
        parent?.remove?.(dead)
      } catch {}
      try {
        if (live(dead)) dead.destroy()
      } catch {}
    }

    function paintButton(force = false): void {
      if (!button) return
      const text = ` ${buttonLabel()} `
      if (!force && painted === text) return
      try {
        if (!live(buttonText)) {
          detachButton()
          return
        }
        buttonText.content = text
        buttonText.fg = buttonColor()
        painted = text
      } catch {
        detachButton() // the host tore the subtree down mid-flight
      }
    }

    /** Editors in the tree, focused one first. Focus is the cheap path; the walk
     *  covers focus living outside the composer (session list, dialog, ...). */
    function editorCandidates(): EditorLike[] {
      const found: EditorLike[] = []
      const focused = focusedEditor()
      if (focused) found.push(focused)
      let visited = 0
      // Caps are only a guard against a pathological tree; a real session walks
      // a few hundred nodes, so they are set well above that.
      const walk = (node: any, depth: number): void => {
        if (!node?.getChildren || depth > 32 || visited > 20000) return
        for (const child of node.getChildren()) {
          if (++visited > 20000) return
          if (!live(child)) continue
          if (typeof child.insertText === "function" && "plainText" in child) found.push(child)
          else walk(child, depth + 1)
        }
      }
      try {
        walk((context.renderer as any).root, 0)
      } catch {}
      return found
    }

    /** The host row that renders "Build · model" inside the input box. */
    function composerStatusRow(): unknown {
      for (const editor of editorCandidates().reverse()) {
        const parent: any = (editor as any).parent
        if (!parent?.getChildren) continue
        const siblings: any[] = parent.getChildren().filter((child: any) => child !== editor)
        for (let index = siblings.length - 1; index >= 0; index--) {
          if ((siblings[index]?.getChildrenCount?.() ?? 0) > 0) return siblings[index]
        }
      }
      return undefined
    }

    function mountButton(): void {
      if (options.button !== "composer" || !canMount) return
      try {
        if ((button && !live(button)) || (buttonText && !live(buttonText))) detachButton()
        if (mountedRow && !live(mountedRow)) mountedRow = undefined

        const row: any = mountedRow ?? composerStatusRow()
        if (!live(row) || typeof row.getChildren !== "function") return

        const kids: any[] = row.getChildren()
        // Steady state: our node is attached and alive. Repaint only when the
        // label actually changed — forcing a write every tick made it blink.
        if (button && live(button) && kids.includes(button)) {
          paintButton()
          return
        }

        // (Re)attach. Adopt whatever button this row already has, so a host
        // rebuild or a second plugin instance can never stack another one.
        const existing = kids.find(isOurButton)
        if (existing && live(existing)) {
          detachButton() // drops our own node, keeps the one already in the row
          button = existing
          const children: any[] = existing.getChildren?.() ?? []
          buttonText = children.find(isOurLabel) ?? children[0]
        } else {
          for (const kid of kids) {
            if (!isOurButton(kid)) continue
            try {
              row.remove(kid)
              kid.destroy()
            } catch {}
          }
        }

        if (!button) {
          const Box = BoxCtor()
          const Text = TextCtor()
          if (typeof Box !== "function" || typeof Text !== "function") return
          button = new Box(context.renderer as any, { id: BUTTON_ID, flexShrink: 0 })
          button[BUTTON_MARK] = true
          buttonText = new Text(context.renderer as any, {
            id: LABEL_ID,
            content: ` ${buttonLabel()} `,
          })
          buttonText[LABEL_MARK] = true
          button.add(buttonText)
          button.onMouseDown = (event: any) => {
            event?.stopPropagation?.()
            toggle()
          }
        }

        mountedRow = row
        if (!(row.getChildren() as unknown[]).includes(button)) row.add(button)
        painted = undefined
        paintButton(true)
      } catch {
        detachButton() // rebuild from scratch on the next tick
      }
    }

    /** A transcript with nowhere to land yet is retried, not thrown away. */
    function retryPending(): void {
      if (pendingText === undefined) return
      if (pendingTries++ >= 30) {
        pendingText = undefined
        pendingSubmit = false
        toast("一直没找到输入栏，转写文本已丢弃（把光标放进输入框再按 alt+r）", "warning")
        return
      }
      if (!insert(pendingText, true)) return
      const submit = pendingSubmit
      pendingText = undefined
      pendingSubmit = false
      if (submit) submitPrompt()
    }

    function tick(): void {
      try {
        mountButton()
        retryPending()
      } catch {}
    }

    const slotPath =
      options.button && options.button !== "composer"
        ? options.button
        : options.button === "composer" && !canMount
          ? ("prompt.footer" as const)
          : undefined
    // Exactly one plugin instance may own the button. The CLI hot-reloads
    // plugins (every edit spins up a new instance), and two owners ping-pong:
    // each tick one adopts the row's button and deletes the other's node, which
    // shows up as a duplicated, flickering button. So a new instance shuts the
    // previous one down first; the handoff handle lives on globalThis, which
    // survives the module being re-evaluated.
    const handoff = globalThis as unknown as { __sensevoiceVoiceStop?: () => void }
    try {
      handoff.__sensevoiceVoiceStop?.()
    } catch {}

    let removeButton: (() => void) | undefined
    if (slotPath) {
      // A setup throw takes the keybinds down with it, so button placement is
      // always best-effort.
      try {
        removeButton = context.ui.slot({
          append: slotPath,
          render: () => (
            <box onMouseDown={() => toggle()}>
              <text fg={buttonColor()}> {buttonLabel()} </text>
            </box>
          ),
        })
      } catch {}
    }

    // Tears the timer and the button down. It must not be called `stop`: the
    // recorder's `stop()` above lives in the same scope, and a second function
    // declaration silently shadows it (the last one wins), so `finish()`'s
    // `await stop()` used to run this teardown instead of finalising the wav —
    // the button detached and the recorder was left running.
    function shutdown(): void {
      if (ticker) clearInterval(ticker)
      ticker = undefined
      try {
        removeButton?.()
      } catch {}
      removeButton = undefined
      detachButton()
    }
    handoff.__sensevoiceVoiceStop = shutdown

    tick()
    try {
      ticker = setInterval(tick, 1000)
    } catch {}

    return () => {
      if (handoff.__sensevoiceVoiceStop === shutdown) handoff.__sensevoiceVoiceStop = undefined
      shutdown()
      if (child) {
        try {
          child.kill("SIGINT")
        } catch {}
      }
      if (childFile) void rm(childFile, { force: true }).catch(() => {})
    }
  },
})
