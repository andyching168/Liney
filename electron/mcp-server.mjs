// Built-in MCP server (Streamable HTTP, stateless). Binds to 127.0.0.1 only and requires a Bearer token.
// It talks to the engine through the injected `call(method, params)` (main-process engine RPC),
// so it never touches LINEJS or SQLite directly.
import http from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

let server = null;

const TYPE_LABEL = { 0: "text", 1: "image", 2: "video", 3: "audio", 7: "sticker", 13: "contact", 14: "file", 15: "location", 16: "post" };
const iso = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null; };

export function formatChat(chat) {
  return {
    id: String(chat.id),
    kind: chat.kind,
    name: chat.name || String(chat.id),
    unread: Number(chat.unread || 0),
    lastMessage: chat.preview || chat.lastMessageTime
      ? { time: iso(chat.lastMessageTime), text: chat.preview || "" }
      : null,
  };
}

export function formatMessage(message) {
  return {
    id: String(message.id),
    time: iso(message.createdTime),
    from: message.isMine ? "me" : (message.senderName || message.senderId || "unknown"),
    fromMe: Boolean(message.isMine),
    type: TYPE_LABEL[message.contentType ?? 0] || String(message.contentType),
    text: message.text || "",
    ...(message.unsent ? { unsent: true } : {}),
  };
}

function buildServer(call, allowSend) {
  const mcp = new McpServer({ name: "line-linux", version: "1.0.0" });
  const asText = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
  const guard = (fn) => async (args) => {
    try { return asText(await fn(args)); }
    catch (error) { return { isError: true, content: [{ type: "text", text: String(error?.message || error) }] }; }
  };
  const findChat = async (chatId) => {
    const chats = await call("chat.list", {}, 30000);
    return Array.isArray(chats) ? chats.find((chat) => chat.id === chatId) : undefined;
  };

  mcp.tool("list_chats", "List Liney/LINE chats (most recently active first) with id, name, unread count and last message",
    { limit: z.number().int().min(1).max(100).default(30), unread_only: z.boolean().default(false) },
    guard(async ({ limit, unread_only }) => {
      const chats = await call("chat.list", {}, 30000);
      const list = (Array.isArray(chats) ? chats : [])
        .filter((chat) => !unread_only || Number(chat.unread || 0) > 0)
        .sort((a, b) => Number(b.lastMessageTime || 0) - Number(a.lastMessageTime || 0))
        .slice(0, limit);
      return list.map(formatChat);
    }));

  mcp.tool("get_messages", "Read the most recent messages of a chat (oldest to newest)",
    { chat_id: z.string().describe("id returned by list_chats"), limit: z.number().int().min(1).max(100).default(30) },
    guard(async ({ chat_id, limit }) => {
      const chat = await findChat(chat_id);
      if (!chat) throw new Error("chat id not found");
      const messages = await call("message.list", { chatId: chat_id, kind: chat.kind === "openchat" ? "openchat" : "talk", limit }, 45000);
      const sorted = (Array.isArray(messages) ? messages : [])
        .sort((a, b) => Number(a.createdTime) - Number(b.createdTime))
        .slice(-limit);
      return { chat: { id: chat.id, kind: chat.kind, name: chat.name }, messages: sorted.map(formatMessage) };
    }));

  if (allowSend) {
    mcp.tool("send_message", "Send a text message as the user in a chat (externally visible; use with care)",
      { chat_id: z.string(), text: z.string().min(1).max(5000) },
      guard(async ({ chat_id, text }) => {
        const chat = await findChat(chat_id);
        if (!chat) throw new Error("chat id not found");
        await call("message.send", { chatId: chat_id, kind: chat.kind === "openchat" ? "openchat" : undefined, text }, 60000);
        return { sent: true, to: { id: chat.id, name: chat.name } };
      }));
  }
  return mcp;
}

function tokenOk(header, token) {
  const match = /^Bearer (.+)$/.exec(header || "");
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function start({ port, token, allowSend, call }) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(async (req, res) => {
      const reply = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      // Reject browser requests (Origin) and non-local Host headers: blocks DNS rebinding and cross-site calls.
      if (req.headers.origin) return reply(403, { error: "origin not allowed" });
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "")) return reply(403, { error: "bad host" });
      if (!tokenOk(req.headers.authorization, token)) return reply(401, { error: "unauthorized" });
      if (!req.url.startsWith("/mcp")) return reply(404, { error: "not found" });
      if (req.method !== "POST") return reply(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });

      const mcp = buildServer(call, allowSend);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); mcp.close(); });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) reply(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    });
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => { server = srv; resolve(); });
  });
}

export function stop() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    const s = server; server = null;
    s.close(() => resolve());
    s.closeAllConnections?.();
  });
}

export const running = () => Boolean(server);
export const newToken = () => crypto.randomBytes(24).toString("base64url");
