import net from "node:net";

interface Bridge {
  readonly server: net.Server;
  readonly publicUrl: string;
}

const bridges = new Map<string, Promise<Bridge>>();

function formatProxyForLog(proxyUrl: URL): string {
  const auth = proxyUrl.username ? "***@" : "";
  return `${proxyUrl.protocol}//${auth}${proxyUrl.hostname}:${proxyUrl.port || "1080"}`;
}

function socketErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeAll(socket: net.Socket, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function connectSocket(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      socket.destroy();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

class SocketReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private error: Error | undefined;
  private waiters: Array<() => void> = [];

  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.notify();
  };

  private readonly onEnd = () => {
    this.ended = true;
    this.notify();
  };

  private readonly onError = (error: Error) => {
    this.error = error;
    this.notify();
  };

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData);
    socket.once("end", this.onEnd);
    socket.once("error", this.onError);
  }

  async readExact(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error("SOCKS5 proxy closed the connection");
      await this.waitForData();
    }

    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  detach(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("error", this.onError);
    const remaining = this.buffer;
    this.buffer = Buffer.alloc(0);
    return remaining;
  }

  private waitForData(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notify(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}

function readConnectHeader(client: net.Socket): Promise<{ header: string; extra: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const cleanup = () => {
      client.off("data", onData);
      client.off("end", onEnd);
      client.off("error", onError);
    };

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16 * 1024) {
        cleanup();
        reject(new Error("HTTP proxy header is too large"));
        return;
      }

      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      cleanup();
      resolve({
        header: buffer.subarray(0, headerEnd + 4).toString("latin1"),
        extra: buffer.subarray(headerEnd + 4),
      });
    };

    const onEnd = () => {
      cleanup();
      reject(new Error("HTTP proxy client closed before sending CONNECT"));
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    client.on("data", onData);
    client.once("end", onEnd);
    client.once("error", onError);
  });
}

function parseConnectTarget(target: string): { host: string; port: number } {
  let host = "";
  let portText = "";

  if (target.startsWith("[")) {
    const end = target.indexOf("]");
    if (end === -1 || target[end + 1] !== ":") {
      throw new Error(`Invalid CONNECT target: ${target}`);
    }
    host = target.slice(1, end);
    portText = target.slice(end + 2);
  } else {
    const separator = target.lastIndexOf(":");
    if (separator <= 0) {
      throw new Error(`Invalid CONNECT target: ${target}`);
    }
    host = target.slice(0, separator);
    portText = target.slice(separator + 1);
  }

  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CONNECT target: ${target}`);
  }

  return { host, port };
}

async function authenticateSocks5(upstream: net.Socket, reader: SocketReader, proxyUrl: URL): Promise<void> {
  const username = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  const hasAuth = username.length > 0 || password.length > 0;

  if (hasAuth) {
    const usernameBytes = Buffer.from(username);
    const passwordBytes = Buffer.from(password);
    if (usernameBytes.length > 255 || passwordBytes.length > 255) {
      throw new Error("SOCKS5 proxy username/password is too long");
    }

    await writeAll(upstream, Buffer.from([0x05, 0x01, 0x02]));
    const method = await reader.readExact(2);
    if (method[0] !== 0x05 || method[1] !== 0x02) {
      throw new Error(`SOCKS5 proxy rejected username/password auth (method=${method[1]})`);
    }

    await writeAll(
      upstream,
      Buffer.concat([
        Buffer.from([0x01, usernameBytes.length]),
        usernameBytes,
        Buffer.from([passwordBytes.length]),
        passwordBytes,
      ]),
    );
    const auth = await reader.readExact(2);
    if (auth[0] !== 0x01 || auth[1] !== 0x00) {
      throw new Error("SOCKS5 proxy username/password auth failed");
    }
    return;
  }

  await writeAll(upstream, Buffer.from([0x05, 0x01, 0x00]));
  const method = await reader.readExact(2);
  if (method[0] !== 0x05 || method[1] !== 0x00) {
    throw new Error(`SOCKS5 proxy rejected no-auth mode (method=${method[1]})`);
  }
}

async function openSocks5Tunnel(proxyUrl: URL, targetHost: string, targetPort: number): Promise<net.Socket> {
  const proxyPort = Number(proxyUrl.port || "1080");
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error(`Invalid SOCKS5 proxy port: ${proxyUrl.port}`);
  }

  const upstream = await connectSocket(proxyUrl.hostname, proxyPort);
  if (upstream.destroyed) {
    throw new Error("SOCKS5 proxy connection was reset immediately after connect");
  }
  upstream.setNoDelay(true);
  const reader = new SocketReader(upstream);

  try {
    await authenticateSocks5(upstream, reader, proxyUrl);

    const hostBytes = Buffer.from(targetHost);
    if (hostBytes.length > 255) {
      throw new Error(`CONNECT target host is too long: ${targetHost}`);
    }

    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(targetPort, 0);
    await writeAll(
      upstream,
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
        hostBytes,
        portBytes,
      ]),
    );

    const response = await reader.readExact(4);
    if (response[0] !== 0x05 || response[1] !== 0x00) {
      throw new Error(`SOCKS5 CONNECT failed (reply=${response[1]})`);
    }

    const atyp = response[3];
    if (atyp === 0x01) {
      await reader.readExact(4);
    } else if (atyp === 0x03) {
      const length = (await reader.readExact(1))[0];
      await reader.readExact(length);
    } else if (atyp === 0x04) {
      await reader.readExact(16);
    } else {
      throw new Error(`SOCKS5 proxy returned unsupported address type: ${atyp}`);
    }
    await reader.readExact(2);

    const remaining = reader.detach();
    if (remaining.length > 0) upstream.unshift(remaining);
    return upstream;
  } catch (error) {
    reader.detach();
    upstream.destroy();
    throw error;
  }
}

async function handleClient(client: net.Socket, proxyUrl: URL): Promise<void> {
  client.setNoDelay(true);
  client.on("error", () => {});

  let upstream: net.Socket | undefined;
  try {
    const { header, extra } = await readConnectHeader(client);
    const firstLine = header.split("\r\n", 1)[0] ?? "";
    const [method, target] = firstLine.split(/\s+/);
    if (method !== "CONNECT" || !target) {
      await writeAll(client, "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
      client.destroy();
      return;
    }

    const { host, port } = parseConnectTarget(target);
    {
      const MAX_RETRIES = 2;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          upstream = await openSocks5Tunnel(proxyUrl, host, port);
          break;
        } catch (err) {
          lastErr = err;
          if (attempt < MAX_RETRIES && !client.destroyed) {
            const delay = (attempt + 1) * 500;
            process.stderr.write(
              `[socks-http-bridge] SOCKS5 tunnel attempt ${attempt + 1} failed (${socketErrorMessage(err)}), retrying in ${delay}ms\n`,
            );
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      if (!upstream) throw lastErr;
    }
    upstream.on("error", () => client.destroy());

    await writeAll(client, "HTTP/1.1 200 Connection Established\r\n\r\n");
    if (extra.length > 0) upstream.write(extra);
    client.pipe(upstream);
    upstream.pipe(client);
  } catch (error) {
    process.stderr.write(
      `[socks-http-bridge] CONNECT failed via ${formatProxyForLog(proxyUrl)}: ${socketErrorMessage(error)}\n`,
    );
    if (!client.destroyed) {
      try {
        await writeAll(client, "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      } catch {
        // Ignore secondary write failures while closing the tunnel.
      }
      client.destroy();
    }
    upstream?.destroy();
  }
}

async function createBridge(proxyUrlText: string): Promise<Bridge> {
  const proxyUrl = new URL(proxyUrlText);
  if (proxyUrl.protocol !== "socks5:" && proxyUrl.protocol !== "socks5h:") {
    throw new Error(`Unsupported SOCKS bridge protocol: ${proxyUrl.protocol}`);
  }
  if (!proxyUrl.hostname) {
    throw new Error("SOCKS5 proxy host is empty");
  }

  const server = net.createServer((client) => {
    void handleClient(client, proxyUrl);
  });

  const bridge = await new Promise<Bridge>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve local SOCKS bridge address"));
        return;
      }
      resolve({ server, publicUrl: `http://127.0.0.1:${address.port}` });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  bridge.server.unref();
  process.stderr.write(
    `[socks-http-bridge] ${formatProxyForLog(proxyUrl)} exposed as ${bridge.publicUrl}\n`,
  );
  return bridge;
}

export async function httpProxyForSocksProxy(proxyUrl: string): Promise<string> {
  const trimmed = proxyUrl.trim();
  let bridge = bridges.get(trimmed);
  if (!bridge) {
    bridge = createBridge(trimmed).catch((error) => {
      bridges.delete(trimmed);
      throw error;
    });
    bridges.set(trimmed, bridge);
  }
  return (await bridge).publicUrl;
}
