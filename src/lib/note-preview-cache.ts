import { lineyEngine } from "./engine";

export type NoteMedia = {
  objectId: string;
  type: string;
  serviceName: string;
  obsNamespace: string;
  url?: string;
  width?: number;
  height?: number;
};

export type NotePostItem = {
  postId: string;
  homeId: string;
  text: string;
  author: string;
  authorAvatarUrl?: string;
  createdTime?: number;
  canEdit: boolean;
  hasMedia?: boolean;
  media?: NoteMedia[];
  likeCount?: number;
  commentCount?: number;
};

const MAX_POST_CACHE = 120;
const MAX_MEDIA_CACHE = 180;

const notePostCache = new Map<string, NotePostItem>();
const notePostInflight = new Map<string, Promise<NotePostItem | null>>();
const noteMediaCache = new Map<string, string>();
const noteMediaInflight = new Map<string, Promise<string | null>>();

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

export function noteMediaCacheKey(item: Pick<NoteMedia, "serviceName" | "obsNamespace" | "objectId">): string {
  return `${item.serviceName}/${item.obsNamespace}/${item.objectId}`;
}

export function getCachedNoteMedia(item: Pick<NoteMedia, "serviceName" | "obsNamespace" | "objectId">): string | undefined {
  return noteMediaCache.get(noteMediaCacheKey(item));
}

export function setCachedNoteMedia(item: Pick<NoteMedia, "serviceName" | "obsNamespace" | "objectId">, dataUrl: string): void {
  setBounded(noteMediaCache, noteMediaCacheKey(item), dataUrl, MAX_MEDIA_CACHE);
}

export function getCachedNotePost(homeId: string, postId: string): NotePostItem | undefined {
  return notePostCache.get(`${homeId}/${postId}`);
}

export function setCachedNotePost(post: NotePostItem): void {
  if (!post.homeId || !post.postId) return;
  setBounded(notePostCache, `${post.homeId}/${post.postId}`, post, MAX_POST_CACHE);
}

export function extractNotePostIdFromLink(link?: string): string | undefined {
  const raw = String(link ?? "").trim();
  if (!raw) return undefined;
  try {
    const normalized = raw.startsWith("/")
      ? `https://line.me${raw}`
      : raw.replace(/^line:\/\//i, "https://line.me/");
    const url = new URL(normalized);
    const param = url.searchParams.get("postId") ?? url.searchParams.get("post_id");
    if (param && /^[A-Za-z0-9._-]{1,160}$/.test(param)) return param;
  } catch {
    // Fallback to regex extraction below
  }
  const match = raw.match(/(?:[?&]|%3F|%26)post(?:Id|_id)(?:=|%3D)([A-Za-z0-9._-]{1,160})/i);
  return match?.[1];
}

export async function fetchNotePostCached(homeId: string, postId: string): Promise<NotePostItem | null> {
  const key = `${homeId}/${postId}`;
  const cached = notePostCache.get(key);
  if (cached) return cached;
  const inflight = notePostInflight.get(key);
  if (inflight) return inflight;
  const promise = lineyEngine
    .request<NotePostItem>("note.get", { homeId, postId }, 20_000)
    .then((post) => {
      if (post?.postId) {
        setCachedNotePost(post);
        return post;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      notePostInflight.delete(key);
    });
  notePostInflight.set(key, promise);
  return promise;
}

export async function fetchNoteMediaCached(
  homeId: string,
  postId: string,
  item: NoteMedia,
): Promise<string | null> {
  const key = noteMediaCacheKey(item);
  const cached = noteMediaCache.get(key);
  if (cached) return cached;
  const inflight = noteMediaInflight.get(key);
  if (inflight) return inflight;
  const promise = lineyEngine
    .request<{ dataUrl: string }>(
      "note.media.preview",
      {
        homeId,
        postId,
        objectId: item.objectId,
        serviceName: item.serviceName,
        obsNamespace: item.obsNamespace,
        ...(item.url ? { url: item.url } : {}),
      },
      25_000,
    )
    .then((res) => {
      if (res?.dataUrl) {
        setCachedNoteMedia(item, res.dataUrl);
        return res.dataUrl;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      noteMediaInflight.delete(key);
    });
  noteMediaInflight.set(key, promise);
  return promise;
}
