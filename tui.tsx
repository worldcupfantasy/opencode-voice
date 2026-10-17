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
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { spawn, type ChildProcess } from "node:child_process"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

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
}

/** Minimal structural view of the focused editor we write into. */
interface EditorLike {
  insertText(text: string): void
  plainText?: string
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
      refreshButton()
    }

    let child: ChildProcess | undefined
    let childFile: string | undefined
    /** The prompt editor captured when recording started. */
    let target: EditorLike | null = null

    const toast = (message: string, variant: Variant = "info") =>
      context.ui.toast.show({ message, variant })

    function focusedEditor(): EditorLike | null {
      try {
        return context.renderer.currentFocusedEditor ?? null
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

    function insert(text: string): boolean {
      const write = (editor: EditorLike) => {
        const existing = editor.plainText ?? ""
        const prefix =
          options.spacePrefix && existing.length > 0 && !/\s$/.test(existing) ? " " : ""
        editor.insertText(prefix + text)
      }

      const editors: EditorLike[] = []
      if (target) editors.push(target)
      const current = focusedEditor()
      if (current && current !== target) editors.push(current)

      if (editors.length === 0) {
        toast("没找到输入栏，请把光标放进输入框再试一次", "warning")
        return false
      }

      let lastError: unknown
      for (const editor of editors) {
        try {
          write(editor)
          return true
        } catch (error) {
          lastError = error
        }
      }
      toast(
        `写入输入栏失败: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        "error",
      )
      return false
    }

    async function finish(autoSubmit: boolean): Promise<void> {
      const file = await stop()
      if (!file) {
        setStatus("idle")
        return
      }
      setStatus("working")
      try {
        const text = await transcribe(file)
        if (!text) {
          toast("没有识别到语音内容", "warning")
          return
        }

        if (!insert(text)) return

        if (autoSubmit) {
          try {
            context.keymap.dispatch("prompt.submit")
          } catch (error) {
            toast(`提交失败: ${error instanceof Error ? error.message : String(error)}`, "error")
          }
        }
      } catch (error) {
        toast(
          `转写失败: ${error instanceof Error ? error.message : String(error)}（请确认 SenseVoice 服务已启动: ${options.endpoint}）`,
          "error",
        )
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
    // through the renderer though — the focused editor's parent holds the
    // textarea and the status row as siblings, and the status row lays out
    // with `justifyContent: space-between`, so a second child lands on its
    // right edge. That is exactly the bottom-right corner of the input box,
    // and it uses no extra line.
    let mountedRow: any
    let button: BoxRenderable | undefined
    let buttonText: TextRenderable | undefined
    let mountTimer: ReturnType<typeof setInterval> | undefined

    const buttonLabel = () =>
      status() === "recording" ? "● 录音中" : status() === "working" ? "● 转写中" : "○ 录音"

    const buttonColor = () =>
      status() === "recording"
        ? context.theme.text.feedback.error.base
        : status() === "working"
          ? context.theme.text.base
          : context.theme.text.muted

    function refreshButton() {
      if (!buttonText) return
      buttonText.content = ` ${buttonLabel()} `
      buttonText.fg = buttonColor()
    }

    /** The host row that renders "Build · model" inside the input box. */
    function composerStatusRow(): any | undefined {
      try {
        const editor = context.renderer.currentFocusedEditor as any
        const parent = editor?.parent
        if (!parent?.getChildren) return undefined
        const siblings: any[] = parent.getChildren().filter((child: any) => child !== editor)
        for (let index = siblings.length - 1; index >= 0; index--) {
          if ((siblings[index]?.getChildrenCount?.() ?? 0) > 0) return siblings[index]
        }
      } catch {}
      return undefined
    }

    function mountButton() {
      if (options.button !== "composer") return
      if (button && button.parent && mountedRow && !mountedRow.isDestroyed) return
      const row = composerStatusRow()
      if (!row) return
      if (!button) {
        const renderer = context.renderer as any
        button = new BoxRenderable(renderer, { id: "sensevoice.voice.button", flexShrink: 0 })
        buttonText = new TextRenderable(renderer, {
          id: "sensevoice.voice.label",
          content: " ○ 录音 ",
        })
        button.add(buttonText)
        button.onMouseDown = (event) => {
          event.stopPropagation()
          toggle()
        }
      }
      row.add(button)
      mountedRow = row
      refreshButton()
    }

    if (options.button === "composer") {
      mountButton()
      // Solid owns the composer subtree, so re-check: a re-render or a session
      // switch can drop a child the host did not create.
      mountTimer = setInterval(mountButton, 1000)
    }

    const slotPath = options.button && options.button !== "composer" ? options.button : undefined
    const removeButton = slotPath
      ? context.ui.slot({
          append: slotPath,
          render: () => (
            <box onMouseDown={() => toggle()}>
              <text fg={buttonColor()}> {buttonLabel()} </text>
            </box>
          ),
        })
      : undefined

    return () => {
      if (mountTimer) clearInterval(mountTimer)
      removeButton?.()
      try {
        button?.destroy()
      } catch {}
      if (child) {
        try {
          child.kill("SIGINT")
        } catch {}
      }
      if (childFile) void rm(childFile, { force: true }).catch(() => {})
    }
  },
})
