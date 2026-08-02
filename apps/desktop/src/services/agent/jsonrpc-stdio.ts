import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Line-delimited JSON-RPC 2.0 over a child process's stdio.
 *
 * ACP is bidirectional: the client calls the agent (`session/prompt`) and the
 * agent calls back into the client (`session/request_permission`, filesystem
 * reads). A one-way RPC client is therefore not enough — both directions need
 * request/response correlation, which is what this provides.
 */

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** Handles a request *from* the agent. Returning a value replies with it. */
export type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

export interface JsonRpcProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called for stderr output — agents use it for diagnostics. */
  onStderr?: (line: string) => void;
  /** Called once when the process exits for any reason. */
  onExit?: (info: { code: number | null; signal: string | null }) => void;
}

export class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<
    string,
    NotificationHandler
  >();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closed = false;

  constructor(private readonly options: JsonRpcProcessOptions) {
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => this.onStderr(chunk));

    // A spawn failure (ENOENT) arrives as an error event, not a rejected
    // promise, and must fail every in-flight call rather than hang them.
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) => {
      this.fail(
        new Error(
          `Agent process exited (${signal ? `signal ${signal}` : `code ${code}`}).`,
        ),
      );
      options.onExit?.({ code, signal });
    });
  }

  /** Registers a handler for a method the agent may call on us. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error("Agent process is not running."));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) {
      return;
    }
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.fail(new Error("Agent process closed."));
    this.child.stdin.end();
    this.child.kill();
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    // Messages are newline-delimited; a chunk can hold several or a fragment.
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        this.handleLine(line);
      }
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    let newline = this.stderrBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stderrBuffer.slice(0, newline).trimEnd();
      this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
      if (line) {
        this.options.onStderr?.(line);
      }
      newline = this.stderrBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Some agents print banners or logs to stdout before speaking JSON-RPC.
      // Treating that as fatal would make them unusable, so route it to stderr
      // handling and carry on.
      this.options.onStderr?.(line);
      return;
    }

    const id = message.id;
    const method = message.method;

    if (typeof method === "string") {
      if (id === undefined || id === null) {
        this.notificationHandlers.get(method)?.(message.params);
        return;
      }
      void this.handleIncomingRequest(
        id as number | string,
        method,
        message.params,
      );
      return;
    }

    // No method means it's a reply to something we sent.
    if (typeof id === "number") {
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);

      const error = message.error as JsonRpcError | undefined;
      if (error) {
        pending.reject(new Error(error.message || "Agent returned an error."));
        return;
      }
      pending.resolve(message.result);
    }
  }

  private async handleIncomingRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      // -32601 is JSON-RPC's "method not found". Answering keeps the agent
      // moving; staying silent would wedge it waiting on us.
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }

    try {
      const result = await handler(params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      this.write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Rejects every in-flight call. Safe to call more than once. */
  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
