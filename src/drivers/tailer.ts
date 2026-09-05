import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const MAX_READ_BYTES = 64 * 1024;

// Incremental line reader over a FILE — the replacement for stdio pipes.
// The harness writes its output to disk, so a daemon restart never breaks
// the stream: the new daemon reopens the file at the persisted offset and
// keeps parsing where the old one stopped. A pipe, by contrast, dies with
// the daemon and EPIPEs the child (the crash class this removes).
export class FileTailer {
  // Bytes actually read (including a partial trailing line held back).
  private readOffset = 0;
  // Bytes up to the end of the last COMPLETE line — the persistable cursor.
  private lineOffset = 0;
  private leftover = "";
  private decoder = new StringDecoder("utf8");
  private decoderEnded = false;
  private watcher: fs.FSWatcher | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly filePath: string,
    private readonly opts: { startOffset?: number; onLine: (line: string, offset: number) => void; pollMs?: number },
  ) {}

  start(): void {
    if (this.stopped) return;
    const start = this.opts.startOffset ?? 0;
    this.readOffset = start;
    this.lineOffset = start;
    this.pump();
    try {
      this.watcher = fs.watch(this.filePath, () => this.pump());
      // The file may not exist yet (spawn raced us) or may sit on a mount
      // without watch support — the poll below covers both.
      this.watcher.on("error", () => {});
    } catch {}
    this.pollTimer = setInterval(() => this.pump(), this.opts.pollMs ?? 300);
  }

  stop(): void {
    this.stopped = true;
    try {
      this.watcher?.close();
    } catch {}
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.watcher = null;
    this.pollTimer = null;
  }

  // Byte position after the last fully consumed line. A partial trailing
  // line is NOT counted, so a persisted offset never re-emits half a line
  // after a restart.
  get consumedOffset(): number {
    return this.lineOffset;
  }

  // Drain the entire file to EOF, including a partial trailing line. The
  // regular pump is bounded to avoid allocating the whole unread history;
  // flush loops over bounded chunks because the process is known to be dead.
  flush(): void {
    if (this.stopped) return;
    this.drainToEof();
    this.finishPartial();
  }

  // Shutdown-drain variant of flush(): pumps to EOF but SILENTLY DROPS a
  // trailing partial line (unterminated bytes) instead of emitting it. The
  // daemon's handleShutdown path uses this so a power cut mid-line cannot
  // synthesize an error/failed event; normal flush() is unchanged.
  drainForShutdown(): void {
    if (this.stopped) return;
    this.drainToEof();
    this.leftover = "";
    try {
      this.decoder.end();
    } catch {}
    this.decoderEnded = true;
  }

  private drainToEof(): void {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const before = this.readOffset;
      this.pump();
      if (this.readOffset === before) break;
      let size: number;
      try {
        size = fs.statSync(this.filePath).size;
      } catch {
        break;
      }
      if (size <= this.readOffset) break;
    }
  }

  private pump(): void {
    if (this.stopped) return;
    let size: number;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return; // not created yet
    }
    if (size < this.readOffset) {
      // Truncated (log rewritten): both cursors and the UTF-8 decoder restart.
      this.readOffset = 0;
      this.lineOffset = 0;
      this.leftover = "";
      this.decoder = new StringDecoder("utf8");
      this.decoderEnded = false;
    }
    if (size === this.readOffset) return;

    let chunk: string;
    try {
      const fd = fs.openSync(this.filePath, "r");
      try {
        const len = Math.min(size - this.readOffset, MAX_READ_BYTES);
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = fs.readSync(fd, buf, 0, len, this.readOffset);
        if (bytesRead === 0) return;
        this.readOffset += bytesRead;
        chunk = this.decoder.write(buf.subarray(0, bytesRead));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    this.processText(chunk);
  }

  private processText(chunk: string): void {
    const data = this.leftover + chunk;
    const lines = data.split("\n");
    this.leftover = lines.pop() ?? "";
    for (const line of lines) {
      this.lineOffset += Buffer.byteLength(line, "utf8") + 1;
      // Empty lines still advance the safe cursor; parsers may ignore them.
      this.opts.onLine(line, this.lineOffset);
    }
  }

  private finishPartial(): void {
    if (!this.decoderEnded) {
      const finalChunk = this.decoder.end();
      this.decoderEnded = true;
      if (finalChunk) this.processText(finalChunk);
    }
    if (this.leftover) {
      const line = this.leftover;
      this.lineOffset += Buffer.byteLength(line, "utf8");
      this.leftover = "";
      this.opts.onLine(line, this.lineOffset);
    }
  }
}
