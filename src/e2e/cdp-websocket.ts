import { createHash, randomBytes } from "node:crypto";
import { createConnection, type Socket } from "node:net";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type CdpEnvelope = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: string };
};

function assertLoopbackWebSocket(url: URL): void {
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing non-loopback CDP websocket: ${url.toString()}`);
  }
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
  } else if (payload.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, mask, masked]);
}

export class CdpWebSocketClient {
  private readonly socket: Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly eventListeners = new Map<string, Set<(params: unknown) => void>>();
  private fragmentedOpcode: number | undefined;
  private fragmentedChunks: Buffer[] = [];
  private closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.feed(chunk));
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => this.failAll(new Error("CDP websocket closed")));
  }

  static async connect(urlValue: string, timeoutMs = 8_000): Promise<CdpWebSocketClient> {
    const url = new URL(urlValue);
    assertLoopbackWebSocket(url);
    const port = Number(url.port || "80");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid CDP websocket port: ${url.port}`);
    }

    const socket = createConnection({ host: url.hostname === "[::1]" ? "::1" : url.hostname, port });
    const key = randomBytes(16).toString("base64");
    const expectedAccept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    const requestTarget = `${url.pathname || "/"}${url.search}`;
    const hostHeader = url.hostname.includes(":") ? `[${url.hostname.replace(/^\[|\]$/g, "")}]:${port}` : `${url.hostname}:${port}`;

    const { remainder } = await new Promise<{ remainder: Buffer }>((resolve, reject) => {
      let handshake = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error("Timed out during CDP websocket handshake")), timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off("data", onData);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("CDP websocket closed during handshake"));
      };
      const onData = (chunk: Buffer) => {
        handshake = Buffer.concat([handshake, chunk]);
        const boundary = handshake.indexOf("\r\n\r\n");
        if (boundary < 0) return;

        cleanup();
        const headerText = handshake.subarray(0, boundary).toString("utf8");
        const lines = headerText.split("\r\n");
        if (!/^HTTP\/1\.[01] 101\b/.test(lines[0] ?? "")) {
          reject(new Error(`CDP websocket upgrade failed: ${lines[0] ?? "missing status"}`));
          return;
        }
        const headers = new Map<string, string>();
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(":");
          if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        if (headers.get("sec-websocket-accept") !== expectedAccept) {
          reject(new Error("CDP websocket returned an invalid Sec-WebSocket-Accept header"));
          return;
        }
        resolve({ remainder: handshake.subarray(boundary + 4) });
      };

      socket.on("data", onData);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("connect", () => {
        socket.write(
          [
            `GET ${requestTarget} HTTP/1.1`,
            `Host: ${hostHeader}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
    });

    const client = new CdpWebSocketClient(socket);
    if (remainder.length > 0) client.feed(remainder);
    return client;
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (this.closed) throw new Error("CDP websocket is closed");
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP response: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    this.socket.write(encodeClientFrame(0x1, payload));
    return response;
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set<(params: unknown) => void>();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
    return () => {
      const current = this.eventListeners.get(method);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.eventListeners.delete(method);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(encodeClientFrame(0x8, Buffer.alloc(0)));
    } catch {
      // Best effort close.
    }
    this.socket.destroy();
    this.failAll(new Error("CDP websocket closed by client"));
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let offset = 2;
      let payloadLength = second & 0x7f;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.failAll(new Error("CDP websocket frame is too large"));
          return;
        }
        payloadLength = Number(bigLength);
        offset += 8;
      }

      let mask: Buffer | undefined;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + payloadLength) return;

      let payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(offset + payloadLength);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = payload[index]! ^ mask[index % 4]!;
        }
      }
      this.handleFrame(opcode, fin, payload);
    }
  }

  private handleFrame(opcode: number, fin: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      this.closed = true;
      this.socket.destroy();
      this.failAll(new Error("CDP websocket closed by browser"));
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(encodeClientFrame(0xa, payload));
      return;
    }
    if (opcode === 0xa) return;

    if (opcode === 0x0) {
      if (this.fragmentedOpcode === undefined) return;
      this.fragmentedChunks.push(payload);
      if (!fin) return;
      const completedOpcode = this.fragmentedOpcode;
      const completed = Buffer.concat(this.fragmentedChunks);
      this.fragmentedOpcode = undefined;
      this.fragmentedChunks = [];
      if (completedOpcode === 0x1) this.handleText(completed);
      return;
    }

    if (opcode !== 0x1 && opcode !== 0x2) return;
    if (!fin) {
      this.fragmentedOpcode = opcode;
      this.fragmentedChunks = [payload];
      return;
    }
    if (opcode === 0x1) this.handleText(payload);
  }

  private handleText(payload: Buffer): void {
    let message: CdpEnvelope;
    try {
      message = JSON.parse(payload.toString("utf8")) as CdpEnvelope;
    } catch {
      return;
    }
    if (message.id === undefined) {
      if (message.method) {
        for (const listener of this.eventListeners.get(message.method) ?? []) {
          try {
            listener(message.params);
          } catch {
            // Diagnostic/event listeners must never break CDP request handling.
          }
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`CDP error ${message.error.code ?? ""}: ${message.error.message ?? "unknown error"}`.trim()));
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
