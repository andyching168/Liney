import { Buffer } from "node:buffer";
import type { Client } from "@evex/linejs";
import { decodeProfileImage } from "./profile-media";

export type NoteMediaItem = {
  objectId: string;
  type: string;
  serviceName: string;
  obsNamespace: string;
  url?: string;
  width?: number;
  height?: number;
};

export type NotePost = {
  postId: string;
  homeId: string;
  text: string;
  author: string;
  authorAvatarUrl?: string;
  createdTime?: number;
  likeCount?: number;
  commentCount?: number;
  canEdit: boolean;
  hasMedia: boolean;
  media?: NoteMediaItem[];
};

type NoteResponse = { code?: number; message?: string; result?: unknown };
type TimelineApi = Pick<Client["base"]["timeline"], "listPost" | "getPost" | "createPost" | "updatePost" | "deletePost" | "likePost" | "createComment" | "uploadNoteMedia"> & {
  initTimeline?: () => Promise<void>;
  timelineHeaders?: Record<string, string>;
};
type NoteClient = {
  base: {
    timeline: TimelineApi;
    profile?: { mid?: string };
    endpoint?: string;
    request?: { getHeader?: (method?: string) => Record<string, string> };
    fetch?: (info: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
};

const MAX_NOTE_IMAGES = 20;
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function noteRoomId(homeId: unknown): string {
  if (typeof homeId !== "string" || !/^[cs][a-f0-9]{30,}$/i.test(homeId)) {
    throw new TypeError("Notes require a LINE group/OpenChat room ID");
  }
  return homeId;
}

export function notePostId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) {
    throw new TypeError("Invalid Note post ID");
  }
  return value;
}

function noteText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 10000) {
    throw new TypeError("Note text must contain 1–10000 characters");
  }
  return value.trim();
}

function checkedResponse(response: NoteResponse): Record<string, unknown> {
  if (response.code !== undefined && ![0, 200].includes(response.code)) {
    throw new Error(response.message || `LINE Note failed (code ${response.code})`);
  }
  return object(response.result);
}

function safeMediaSegment(value: unknown, fallback: string): string {
  const raw = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : fallback;
}

function allowedNoteMediaUrl(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("https://")) return undefined;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith(".line-scdn.net") || host.endsWith(".line-apps.com") || host.endsWith(".line.naver.jp")) {
      return parsed.toString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function projectMediaList(rawMedia: unknown): NoteMediaItem[] {
  if (!Array.isArray(rawMedia)) return [];
  const items: NoteMediaItem[] = [];
  for (const entry of rawMedia.slice(0, MAX_NOTE_IMAGES)) {
    const rec = object(entry);
    const obsRes = object(rec.obsResourceId);
    const objectId = String(rec.objectId ?? rec.oid ?? obsRes.oid ?? "").trim();
    if (!objectId || !/^[A-Za-z0-9._-]{1,160}$/.test(objectId)) continue;
    const width = Number(rec.width);
    const height = Number(rec.height);
    const url = allowedNoteMediaUrl(rec.url ?? rec.obsUrl ?? rec.thumbnailUrl);
    items.push({
      objectId,
      type: String(rec.type ?? "PHOTO").toUpperCase(),
      serviceName: safeMediaSegment(rec.serviceName ?? obsRes.serviceName, "myhome"),
      obsNamespace: safeMediaSegment(rec.obsNamespace ?? rec.spaceId ?? rec.sid ?? obsRes.sid, "h"),
      ...(url ? { url } : {}),
      ...(Number.isFinite(width) && width > 0 ? { width } : {}),
      ...(Number.isFinite(height) && height > 0 ? { height } : {}),
    });
  }
  return items;
}

function projectPost(value: unknown, homeId: string, selfMid?: string): NotePost | null {
  const outer = object(value);
  const record = outer.post !== undefined ? object(outer.post) : outer;
  const info = object(record.postInfo);
  const content = object(record.contents);
  const writer = object(info.writer ?? record.userInfo);
  const postId = String(info.postId ?? record.postId ?? "");
  if (!postId) return null;
  const created = Number(info.createdTime ?? record.createdTime);
  const likes = Number(info.likeCount ?? record.likeCount);
  const comments = Number(info.commentCount ?? record.commentCount);
  const writerMid = String(info.writerMid ?? info.authorMid ?? writer.mid ?? record.writerMid ?? "");
  const rawPic = String(writer.pictureUrl ?? writer.picturePath ?? "").trim();
  const authorAvatarUrl = rawPic.startsWith("https://")
    ? rawPic
    : rawPic.startsWith("/")
      ? `https://obs.line-scdn.net${rawPic}/preview`
      : undefined;
  const media = projectMediaList(content.media);
  return {
    postId,
    homeId,
    text: String(content.text ?? record.text ?? ""),
    author: String(info.writerName ?? writer.nickname ?? writer.displayName ?? record.writerName ?? writerMid ?? "สมาชิก"),
    ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
    ...(Number.isFinite(created) ? { createdTime: created } : {}),
    ...(Number.isFinite(likes) ? { likeCount: likes } : {}),
    ...(Number.isFinite(comments) ? { commentCount: comments } : {}),
    canEdit: Boolean(selfMid && writerMid && selfMid === writerMid),
    hasMedia: media.length > 0 || (Array.isArray(content.media) && content.media.length > 0),
    ...(media.length > 0 ? { media } : {}),
  };
}

export function projectNoteList(result: unknown, homeId: string, selfMid?: string): { posts: NotePost[]; nextPostId?: string; updatedTime?: number } {
  const data = object(result);
  const candidate = [
    data.feeds,
    object(data.feedList).feeds,
    data.posts,
    data.postList,
    data.homePosts,
    object(data.homePostList).posts,
    object(data.timeline).posts,
  ].find(Array.isArray);
  if (!candidate) {
    throw new Error("Unsupported LINE Note response format");
  }
  const posts = (candidate as unknown[]).map((item) => projectPost(item, homeId, selfMid)).filter((item): item is NotePost => item !== null);
  const next = String(data.nextPostId ?? data.nextScrollId ?? data.nextCursor ?? "");
  const updatedTime = Number(data.updatedTime);
  return {
    posts,
    ...(next ? { nextPostId: next } : {}),
    ...(Number.isFinite(updatedTime) && updatedTime > 0 ? { updatedTime } : {}),
  };
}

export async function listNotes(client: NoteClient, homeId: string, postId?: string) {
  const room = noteRoomId(homeId);
  const result = checkedResponse(await client.base.timeline.listPost({
    homeId: room,
    ...(postId ? { postId: notePostId(postId) } : {}),
    sourceType: "TALKROOM",
  }));
  return projectNoteList(result, room, client.base.profile?.mid);
}

export async function getNote(client: NoteClient, homeId: string, postId: string) {
  const room = noteRoomId(homeId);
  const pid = notePostId(postId);
  try {
    const result = checkedResponse(await client.base.timeline.getPost({ homeId: room, postId: pid }));
    const post = projectPost(result.feed ?? result.post ?? result, room, client.base.profile?.mid);
    if (post) return post;
  } catch (err) {
    try {
      const page = await listNotes(client, room);
      const found = page.posts.find((item) => item.postId === pid);
      if (found) return found;
    } catch {
      // Surface the original getPost error below.
    }
    throw err;
  }
  throw new Error("LINE did not return a Note post");
}

export async function createNote(client: NoteClient, homeId: string, text: string, imageData?: unknown) {
  const room = noteRoomId(homeId);
  const rawImages = Array.isArray(imageData)
    ? imageData.filter((item) => item !== undefined && item !== null)
    : imageData !== undefined && imageData !== null
      ? [imageData]
      : [];
  if (rawImages.length > MAX_NOTE_IMAGES) {
    throw new TypeError(`LINE Note supports at most ${MAX_NOTE_IMAGES} images per post`);
  }
  const trimmedText = typeof text === "string" ? text.trim() : "";
  if (trimmedText.length > 10000) {
    throw new TypeError("Note text must contain 1–10000 characters");
  }
  if (!trimmedText && rawImages.length === 0) {
    throw new TypeError("Note text must contain 1–10000 characters");
  }
  let media: { mediaObjectIds: string[]; mediaObjectTypes: string[] } | undefined;
  if (rawImages.length > 0) {
    const mediaObjectIds: string[] = [];
    const mediaObjectTypes: string[] = [];
    for (let i = 0; i < rawImages.length; i++) {
      const { bytes, mime } = decodeProfileImage(rawImages[i]);
      if (mime !== "image/jpeg") throw new TypeError("LINE Note image upload requires JPEG");
      // LINEJS uploadNoteMedia hashes `${mid}-${Date.now()}` as oid; ensure distinct ms across batch uploads.
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, 2));
      const upload = await client.base.timeline.uploadNoteMedia("image", new Blob([new Uint8Array(bytes)], { type: mime }));
      if (!upload.objId) throw new Error("LINE did not return the Note media object ID");
      mediaObjectIds.push(upload.objId);
      mediaObjectTypes.push("PHOTO");
    }
    media = { mediaObjectIds, mediaObjectTypes };
  }
  const response = await client.base.timeline.createPost({
    homeId: room,
    ...(trimmedText ? { text: trimmedText } : {}),
    sourceType: "TALKROOM",
    readPermissionType: "GROUP",
    readPermissionGids: [room],
    ...media,
  });
  return checkedResponse(response);
}

function detectImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length < 12) return undefined;
  const header = Buffer.from(bytes.subarray(0, 12));
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "image/jpeg";
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

export async function previewNoteMedia(
  client: NoteClient,
  options: { homeId?: string; postId?: string; objectId: string; serviceName?: string; obsNamespace?: string; url?: string },
): Promise<{ dataUrl: string; bytes: number }> {
  const objectId = String(options.objectId ?? "").trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(objectId)) {
    throw new TypeError("Invalid Note media object ID");
  }
  const serviceName = safeMediaSegment(options.serviceName, "myhome");
  const obsNamespace = safeMediaSegment(options.obsNamespace, "h");
  const safeHomeId = typeof options.homeId === "string" && /^[cs][a-f0-9]{30,}$/i.test(options.homeId) ? options.homeId : undefined;
  const safePostId = typeof options.postId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(options.postId) ? options.postId : undefined;
  const directUrl = allowedNoteMediaUrl(options.url);
  if (typeof client.base.timeline.initTimeline === "function") {
    await client.base.timeline.initTimeline();
  }
  const fetcher = client.base.fetch ?? globalThis.fetch;
  const endpoint = client.base.endpoint || "legy.line-apps.com";
  const tlHeaders: Record<string, string> = { ...(client.base.timeline.timelineHeaders ?? {}) };
  delete tlHeaders["content-type"];
  const channelToken = tlHeaders["x-line-channeltoken"] ?? tlHeaders["X-Line-ChannelToken"] ?? "";
  const authToken = tlHeaders["x-line-access"] ?? "";
  const appHeader = tlHeaders["x-line-application"] ?? "";
  const uaHeader = tlHeaders["user-agent"] ?? "";
  const selfMid = client.base.profile?.mid ?? tlHeaders["x-line-mid"] ?? "";

  const baseApp: Record<string, string> = {
    accept: "*/*",
    ...(uaHeader ? { "user-agent": uaHeader } : {}),
    ...(appHeader ? { "x-line-application": appHeader } : {}),
  };
  const tokenOnly: Record<string, string> = {
    ...baseApp,
    ...(channelToken ? { "X-Line-ChannelToken": channelToken } : {}),
    ...(selfMid ? { "X-Line-Mid": selfMid } : {}),
  };
  const accessOnly: Record<string, string> = {
    ...baseApp,
    ...(authToken ? { "X-Line-Access": authToken } : {}),
  };
  const noteContext: Record<string, string> = {
    ...(safeHomeId ? { "X-Line-Home-Id": safeHomeId, "X-Line-Chat-Id": safeHomeId, "X-Line-Group-Id": safeHomeId } : {}),
    ...(safePostId ? { "X-Line-Post-Id": safePostId } : {}),
  };
  const encodedOid = encodeURIComponent(objectId);
  const obsUrl = `https://obs.line-apps.com/r/${serviceName}/${obsNamespace}/${encodedOid}`;
  const obsPreviewUrl = `${obsUrl}/m800x1200`;
  const scdnUrl = `https://obs.line-scdn.net/r/${serviceName}/${obsNamespace}/${encodedOid}`;
  const legyOaUrl = `https://${endpoint}/oa/r/${serviceName}/${obsNamespace}/${encodedOid}`;
  const legyBaseHeaders: Record<string, string> = {
    ...(client.base.request?.getHeader?.("GET") ?? tlHeaders),
    ...(channelToken ? { "X-Line-ChannelToken": channelToken } : {}),
    ...(selfMid ? { "X-Line-Mid": selfMid } : {}),
    ...noteContext,
  };
  delete legyBaseHeaders["content-type"];

  type Attempt = { label: string; url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: Uint8Array };
  const attempts: Attempt[] = [];
  if (directUrl) {
    attempts.push({ label: "direct", url: directUrl, method: "GET", headers: tokenOnly });
  }
  // 1. Access-only (same as Talk OBS downloadMessageData)
  attempts.push({ label: "obs:access:m800", url: obsPreviewUrl, method: "GET", headers: accessOnly });
  attempts.push({ label: "obs:access:full", url: obsUrl, method: "GET", headers: accessOnly });
  // 2. Access + Note context headers
  attempts.push({ label: "obs:access+ctx", url: obsUrl, method: "GET", headers: { ...accessOnly, ...noteContext } });
  // 3. ChannelToken-only (without V3 JWT x-line-access)
  attempts.push({ label: "obs:token:m800", url: obsPreviewUrl, method: "GET", headers: tokenOnly });
  attempts.push({ label: "obs:token:full", url: obsUrl, method: "GET", headers: tokenOnly });
  // 4. ChannelToken + Note context headers
  attempts.push({ label: "obs:token+ctx", url: obsUrl, method: "GET", headers: { ...tokenOnly, ...noteContext } });
  // 5. ChannelToken + X-OBS-Params (homeId/postId)
  if (safeHomeId || safePostId) {
    const obsParams = Buffer.from(JSON.stringify({
      ...(safeHomeId ? { homeId: safeHomeId } : {}),
      ...(safePostId ? { postId: safePostId } : {}),
    })).toString("base64");
    attempts.push({ label: "obs:token+params", url: obsUrl, method: "GET", headers: { ...tokenOnly, "X-OBS-Params": obsParams } });
    attempts.push({ label: "obs:access+params", url: obsUrl, method: "GET", headers: { ...accessOnly, "X-OBS-Params": obsParams } });
  }
  // 6. SCDN with access-only & token-only
  attempts.push({ label: "scdn:access", url: scdnUrl, method: "GET", headers: accessOnly });
  attempts.push({ label: "scdn:token", url: scdnUrl, method: "GET", headers: tokenOnly });
  // 7. LEGY /oa/r/ proxy with context
  attempts.push({ label: "legy:oa", url: legyOaUrl, method: "POST", headers: legyBaseHeaders, body: new Uint8Array() });

  const statuses: string[] = [];
  for (const attempt of attempts) {
    try {
      const res = await fetcher(attempt.url, {
        method: attempt.method,
        headers: attempt.headers,
        ...(attempt.body ? { body: attempt.body as unknown as BodyInit } : {}),
      });
      const xlc = res.headers.get("x-lc");
      const obsErr = res.headers.get("x-obs-error") ?? res.headers.get("x-line-obs-error");
      statuses.push(`${attempt.label}=${res.status}${xlc ? `/xlc:${xlc}` : ""}${obsErr ? `/err:${obsErr}` : ""}`);
      if (!res.ok) continue;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_PREVIEW_BYTES) continue;
      const mime = detectImageMime(buf);
      if (!mime) continue;
      return { dataUrl: `data:${mime};base64,${Buffer.from(buf).toString("base64")}`, bytes: buf.length };
    } catch {
      statuses.push(`${attempt.label}=err`);
    }
  }
  console.error(`[note-media] unavailable service=${serviceName} ns=${obsNamespace} statuses=${statuses.join(",")}`);
  throw new Error("Note media preview is unavailable");
}

export async function updateNote(client: NoteClient, homeId: string, postId: string, text: string) {
  return checkedResponse(await client.base.timeline.updatePost({
    homeId: noteRoomId(homeId), postId: notePostId(postId), text: noteText(text),
  }));
}

export async function deleteNote(client: NoteClient, homeId: string, postId: string) {
  return checkedResponse(await client.base.timeline.deletePost({
    homeId: noteRoomId(homeId), postId: notePostId(postId),
  }));
}

export async function likeNote(client: NoteClient, homeId: string, postId: string) {
  return checkedResponse(await client.base.timeline.likePost({
    homeId: noteRoomId(homeId), contentId: notePostId(postId), sourceType: "TALKROOM",
  }));
}

export async function commentNote(client: NoteClient, homeId: string, postId: string, text: string) {
  return checkedResponse(await client.base.timeline.createComment({
    homeId: noteRoomId(homeId), contentId: notePostId(postId), commentText: noteText(text), sourceType: "TALKROOM",
  }));
}
