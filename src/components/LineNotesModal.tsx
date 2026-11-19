import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Heart,
  Image as ImageIcon,
  ImagePlus,
  LoaderCircle,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { lineyEngine } from "../lib/engine";
import { useAppTranslation } from "../lib/i18n";
import {
  fetchNoteMediaCached,
  fetchNotePostCached,
  getCachedNoteMedia,
  getCachedNotePost,
  setCachedNoteMedia,
  setCachedNotePost,
  type NoteMedia,
  type NotePostItem,
} from "../lib/note-preview-cache";
import { RemoteImage } from "./RemoteImage";
import "./LineAlbumsModal.css";
import "./LineNotesModal.css";

const MAX_NOTE_IMAGES = 20;
const MAX_NOTE_IMAGE_BYTES = 8 * 1024 * 1024;

type Note = NotePostItem;

type NotesPage = { posts: Note[]; nextPostId?: string };

type DraftImage = {
  id: string;
  name: string;
  dataUrl: string;
};

function formatNoteError(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, "").trim() || raw;
}

function formatNoteTimestamp(ms: number | undefined, locale: string): string {
  if (!ms || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function authorInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "N";
  return [...trimmed][0]?.toUpperCase() ?? "N";
}

function isLongPreviewText(text: string): boolean {
  if (!text) return false;
  return text.length > 130 || text.split("\n").length > 4;
}

function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return 0;
  const b64 = dataUrl.slice(comma + 1);
  return Math.floor((b64.length * 3) / 4);
}

async function fileToJpegDataUrl(file: File, readErrorText: string, sizeErrorText: string): Promise<string> {
  if (file.type === "image/jpeg" && file.size > 0 && file.size <= MAX_NOTE_IMAGE_BYTES) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(readErrorText));
      reader.onerror = () => reject(reader.error ?? new Error(readErrorText));
      reader.readAsDataURL(file);
    });
  }
  if (!file.type.startsWith("image/")) {
    throw new Error(sizeErrorText);
  }
  const bitmapUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(readErrorText));
      el.src = bitmapUrl;
    });
    const maxEdge = 2400;
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(readErrorText);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    for (const quality of [0.92, 0.82, 0.7]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlByteLength(dataUrl) <= MAX_NOTE_IMAGE_BYTES) {
        return dataUrl;
      }
    }
    throw new Error(sizeErrorText);
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
}

function NoteMediaTile({
  homeId,
  postId,
  item,
  extraCount,
  onOpen,
  cache,
}: {
  homeId: string;
  postId: string;
  item: NoteMedia;
  extraCount?: number;
  onOpen: (src: string) => void;
  cache: React.MutableRefObject<Map<string, string>>;
}) {
  const { t } = useAppTranslation();
  const tileRef = useRef<HTMLButtonElement | null>(null);
  const cacheKey = `${item.serviceName}/${item.obsNamespace}/${item.objectId}`;
  const initialCached = cache.current.get(cacheKey) ?? getCachedNoteMedia(item) ?? "";
  const [src, setSrc] = useState<string>(initialCached);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    () => (initialCached ? "ready" : "idle"),
  );

  useEffect(() => {
    if (src || status === "error") return;
    const el = tileRef.current;
    if (!el) return;
    let active = true;
    const loadPreview = () => {
      if (!active) return;
      setStatus("loading");
      void fetchNoteMediaCached(homeId, postId, item)
        .then((url) => {
          if (!active) return;
          if (url) {
            cache.current.set(cacheKey, url);
            setCachedNoteMedia(item, url);
            setSrc(url);
            setStatus("ready");
          } else {
            setStatus("error");
          }
        })
        .catch(() => {
          if (active) setStatus("error");
        });
    };
    if (typeof IntersectionObserver === "undefined") {
      loadPreview();
      return () => { active = false; };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          loadPreview();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(el);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [cache, cacheKey, homeId, item.objectId, item.obsNamespace, item.serviceName, item.url, postId, src, status]);

  return (
    <button
      ref={tileRef}
      type="button"
      className="liney-note-media-tile"
      aria-label={t("ดูรูปภาพขนาดเต็ม")}
      disabled={!src}
      onClick={(e) => {
        e.stopPropagation();
        if (src) onOpen(src);
      }}
    >
      {src ? (
        <img src={src} alt={t("รูปภาพ")} loading="lazy" />
      ) : status === "error" ? (
        <span className="liney-note-media-fallback"><ImageIcon size={20} /></span>
      ) : (
        <span className="liney-note-media-fallback"><LoaderCircle size={18} className="spin" /></span>
      )}
      {extraCount && extraCount > 0 ? (
        <span className="liney-note-media-more">+{extraCount}</span>
      ) : null}
    </button>
  );
}

export function LineNotesModal({
  homeId,
  title,
  initialPostId,
  onClose,
}: {
  homeId: string;
  title: string;
  initialPostId?: string;
  onClose: () => void;
}) {
  const { t, english } = useAppTranslation();
  const locale = english ? "en-US" : "th-TH";
  const [posts, setPosts] = useState<Note[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Standalone post detail popup state
  const [selectedPostId, setSelectedPostId] = useState<string | null>(initialPostId ?? null);
  const [standalonePost, setStandalonePost] = useState<Note | null>(() =>
    initialPostId ? (getCachedNotePost(homeId, initialPostId) ?? null) : null,
  );
  const [detailComment, setDetailComment] = useState("");

  // Composer popup modal state
  const [composerOpen, setComposerOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [composerError, setComposerError] = useState("");
  const [convertingImages, setConvertingImages] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Lightbox state for viewing all post photos (loads uncached slides lazily)
  const mediaCacheRef = useRef<Map<string, string>>(new Map());
  const [lightbox, setLightbox] = useState<{ postId: string; items: NoteMedia[]; index: number } | null>(null);
  const [lightboxSrc, setLightboxSrc] = useState("");
  const [lightboxStatus, setLightboxStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  const listSelectedPost = selectedPostId ? posts.find((post) => post.postId === selectedPostId) ?? null : null;
  const selectedPost = listSelectedPost ?? (standalonePost && standalonePost.postId === selectedPostId ? standalonePost : null);

  const load = useCallback(async (beforePostId?: string) => {
    setLoading(true);
    setError("");
    try {
      const page = await lineyEngine.request<NotesPage>("note.list", { homeId, ...(beforePostId ? { beforePostId } : {}) }, 30_000);
      for (const post of page.posts) setCachedNotePost(post);
      setPosts((current) => beforePostId
        ? [...current, ...page.posts.filter((post) => !current.some((existing) => existing.postId === post.postId))]
        : page.posts);
      setCursor(page.nextPostId && page.nextPostId !== beforePostId ? page.nextPostId : undefined);
    } catch (cause) {
      setError(formatNoteError(cause));
    } finally {
      setLoading(false);
    }
  }, [homeId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedPostId || listSelectedPost) return;
    let active = true;
    const cached = getCachedNotePost(homeId, selectedPostId);
    if (cached) {
      setStandalonePost(cached);
      return;
    }
    void fetchNotePostCached(homeId, selectedPostId).then((fetched) => {
      if (active && fetched) setStandalonePost(fetched);
    });
    return () => { active = false; };
  }, [homeId, listSelectedPost, selectedPostId]);

  useEffect(() => {
    if (composerOpen) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [composerOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (lightbox && lightbox.items.length > 1) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          setLightbox((cur) => cur ? { ...cur, index: (cur.index - 1 + cur.items.length) % cur.items.length } : null);
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          setLightbox((cur) => cur ? { ...cur, index: (cur.index + 1) % cur.items.length } : null);
          return;
        }
      }
      if (event.key !== "Escape") return;
      if (lightbox) {
        setLightbox(null);
      } else if (composerOpen && !busy) {
        setComposerOpen(false);
      } else if (selectedPostId && !busy) {
        setSelectedPostId(null);
        setDetailComment("");
      } else if (!busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, composerOpen, lightbox, onClose, selectedPostId]);

  useEffect(() => {
    if (!lightbox) {
      setLightboxSrc("");
      setLightboxStatus("idle");
      return;
    }
    const item = lightbox.items[lightbox.index];
    if (!item) return;
    let active = true;
    const fetchMedia = async (target: NoteMedia): Promise<string> => {
      const key = `${target.serviceName}/${target.obsNamespace}/${target.objectId}`;
      const cached = mediaCacheRef.current.get(key) ?? getCachedNoteMedia(target);
      if (cached) {
        mediaCacheRef.current.set(key, cached);
        return cached;
      }
      const url = await fetchNoteMediaCached(homeId, lightbox.postId, target);
      if (!url) throw new Error("empty");
      mediaCacheRef.current.set(key, url);
      return url;
    };

    const key = `${item.serviceName}/${item.obsNamespace}/${item.objectId}`;
    const immediate = mediaCacheRef.current.get(key) ?? getCachedNoteMedia(item);
    if (immediate) {
      mediaCacheRef.current.set(key, immediate);
      setLightboxSrc(immediate);
      setLightboxStatus("ready");
    } else {
      setLightboxSrc("");
      setLightboxStatus("loading");
      void fetchMedia(item)
        .then((url) => {
          if (!active) return;
          setLightboxSrc(url);
          setLightboxStatus("ready");
        })
        .catch(() => {
          if (active) setLightboxStatus("error");
        });
    }

    if (lightbox.items.length > 1) {
      const nextItem = lightbox.items[(lightbox.index + 1) % lightbox.items.length];
      if (nextItem) {
        const nextKey = `${nextItem.serviceName}/${nextItem.obsNamespace}/${nextItem.objectId}`;
        if (!mediaCacheRef.current.has(nextKey) && !getCachedNoteMedia(nextItem)) {
          void fetchMedia(nextItem).catch(() => {});
        }
      }
    }
    return () => { active = false; };
  }, [homeId, lightbox]);

  function openNewComposer() {
    setEditing(undefined);
    setDraft("");
    setDraftImages([]);
    setComposerError("");
    setComposerOpen(true);
  }

  function openEditComposer(post: Note) {
    setEditing(post.postId);
    setDraft(post.text);
    setDraftImages([]);
    setComposerError("");
    setComposerOpen(true);
  }

  function closeComposer() {
    if (busy) return;
    setComposerOpen(false);
    setEditing(undefined);
    setDraft("");
    setDraftImages([]);
    setComposerError("");
  }

  function openPostDetail(postId: string) {
    setSelectedPostId(postId);
    setDetailComment("");
  }

  async function mutate(method: string, params: Record<string, unknown>, fromComposer = false) {
    setBusy(true);
    if (fromComposer) setComposerError("");
    else setError("");
    try {
      const timeout = method === "note.create" && Array.isArray(params.images) && params.images.length > 1
        ? Math.min(180_000, 30_000 + params.images.length * 15_000)
        : 30_000;
      await lineyEngine.request(method, { homeId, ...params }, timeout);
      if (fromComposer) {
        setComposerOpen(false);
        setEditing(undefined);
        setDraft("");
        setDraftImages([]);
        setComposerError("");
      }
      if (method === "note.delete" && params.postId === selectedPostId) {
        setSelectedPostId(null);
      }
      if (method === "note.comment") {
        setDetailComment("");
      }
      await load();
    } catch (cause) {
      const message = formatNoteError(cause);
      if (fromComposer) setComposerError(message);
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function addImageFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (!files.length) {
      setComposerError(t("LINE Note รองรับภาพ JPEG ขนาดไม่เกิน 8 MB"));
      return;
    }
    const remaining = MAX_NOTE_IMAGES - draftImages.length;
    if (remaining <= 0) {
      setComposerError(t("แนบรูปภาพได้สูงสุด {{max}} รูปต่อโน้ต", { max: MAX_NOTE_IMAGES }));
      return;
    }
    const slice = files.slice(0, remaining);
    if (files.length > remaining) {
      setComposerError(t("แนบรูปภาพได้สูงสุด {{max}} รูปต่อโน้ต", { max: MAX_NOTE_IMAGES }));
    } else {
      setComposerError("");
    }
    setConvertingImages(true);
    const added: DraftImage[] = [];
    const errors: string[] = [];
    for (const file of slice) {
      try {
        const dataUrl = await fileToJpegDataUrl(
          file,
          t("อ่านภาพไม่สำเร็จ"),
          t("LINE Note รองรับภาพ JPEG ขนาดไม่เกิน 8 MB"),
        );
        added.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name || "image.jpg",
          dataUrl,
        });
      } catch (cause) {
        errors.push(formatNoteError(cause));
      }
    }
    setConvertingImages(false);
    if (added.length > 0) {
      setDraftImages((current) => [...current, ...added].slice(0, MAX_NOTE_IMAGES));
    }
    if (errors.length > 0) {
      setComposerError(errors[0]);
    }
  }

  function openPostLightbox(post: Note, startIndex: number) {
    const photoItems = (post.media ?? []).filter((m) => m.type !== "VIDEO");
    if (photoItems.length === 0) return;
    setLightbox({
      postId: post.postId,
      items: photoItems,
      index: Math.min(Math.max(0, startIndex), photoItems.length - 1),
    });
  }

  const canSubmitComposer = !busy && !convertingImages && (
    editing ? draft.trim().length > 0 : (draft.trim().length > 0 || draftImages.length > 0)
  );

  return (
    <div
      className="modal-backdrop liney-albums-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !composerOpen && !selectedPost && !lightbox) onClose();
      }}
    >
      {/* Tall vertical Notes list popup */}
      <section
        className="liney-albums-panel liney-notes-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("LINE Note of {{title}}", { title })}
      >
        <header className="liney-albums-head liney-notes-head">
          <div>
            <strong>LINE Note · {title}</strong>
            <small>
              {t("โน้ตประจำห้อง · LINEJS")}
              {!loading && posts.length > 0 ? ` · ${t("{{count}} โน้ต", { count: posts.length })}` : ""}
            </small>
          </div>
          <button
            type="button"
            className="liney-notes-new-btn"
            disabled={busy}
            onClick={openNewComposer}
          >
            <Plus size={15} />
            <span>{t("เขียนโน้ตใหม่")}</span>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("โหลดใหม่")}
            title={t("โหลดใหม่")}
            disabled={busy || loading}
            onClick={() => void load()}
          >
            <RefreshCw size={17} className={loading ? "spin" : undefined} />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("ปิด")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="liney-notes-scroll">
          {error ? <p className="liney-albums-error liney-notes-error" role="alert">{error}</p> : null}

          {loading && posts.length === 0 ? (
            <div className="liney-notes-state">
              <LoaderCircle size={22} className="spin" />
              <span>{t("กำลังโหลดโน้ต…")}</span>
            </div>
          ) : null}

          {!loading && !error && posts.length === 0 ? (
            <div className="liney-notes-empty-card">
              <div className="liney-notes-empty-icon"><FileText size={28} /></div>
              <strong>{t("ยังไม่มีโน้ตในกลุ่มนี้")}</strong>
              <button type="button" className="liney-notes-new-btn" onClick={openNewComposer}>
                <Plus size={15} />
                <span>{t("เขียนโน้ตใหม่")}</span>
              </button>
            </div>
          ) : null}

          <div className="liney-notes-feed">
            {posts.map((post) => {
              const authorLabel = post.author === "สมาชิก" ? t("สมาชิก") : post.author;
              const timestamp = formatNoteTimestamp(post.createdTime, locale);
              const photoItems = (post.media ?? []).filter((m) => m.type !== "VIDEO");
              const visiblePhotos = photoItems.slice(0, 4);
              const extraPhotos = Math.max(0, photoItems.length - 4);
              const gridCount = Math.min(4, visiblePhotos.length);
              const truncated = isLongPreviewText(post.text);

              return (
                <article
                  key={post.postId}
                  className="liney-note-post liney-note-post-preview"
                  tabIndex={0}
                  onClick={() => openPostDetail(post.postId)}
                  onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      openPostDetail(post.postId);
                    }
                  }}
                >
                  <header className="liney-note-post-head">
                    <div className="liney-note-avatar" aria-hidden="true">
                      {post.authorAvatarUrl ? (
                        <RemoteImage
                          src={post.authorAvatarUrl}
                          alt={authorLabel}
                          loading="lazy"
                          fallback={<span>{authorInitial(authorLabel)}</span>}
                        />
                      ) : (
                        <span>{authorInitial(authorLabel)}</span>
                      )}
                    </div>
                    <div className="liney-note-meta">
                      <div className="liney-note-author-row">
                        <strong>{authorLabel}</strong>
                        {post.canEdit ? <span className="liney-note-mine-badge">{t("โน้ตของคุณ")}</span> : null}
                      </div>
                      {timestamp ? <time className="liney-note-time">{timestamp}</time> : null}
                    </div>
                  </header>

                  {post.text ? (
                    <div className="liney-note-body-wrap">
                      <p className="liney-note-body liney-note-body-clamped">{post.text}</p>
                      {truncated ? <span className="liney-note-read-more">{t("อ่านเพิ่มเติม")}</span> : null}
                    </div>
                  ) : !post.hasMedia ? (
                    <p className="liney-note-body muted">{t("โน้ตที่ไม่มีข้อความ")}</p>
                  ) : null}

                  {visiblePhotos.length > 0 ? (
                    <div className={`liney-note-media-grid liney-note-media-preview count-${gridCount}`}>
                      {visiblePhotos.map((item, idx) => (
                        <NoteMediaTile
                          key={item.objectId}
                          homeId={homeId}
                          postId={post.postId}
                          item={item}
                          extraCount={idx === 3 ? extraPhotos : 0}
                          cache={mediaCacheRef}
                          onOpen={() => openPostLightbox(post, idx)}
                        />
                      ))}
                    </div>
                  ) : post.hasMedia ? (
                    <div className="liney-note-media-pill">
                      <ImageIcon size={14} />
                      <span>{t("มีไฟล์สื่อแนบ")}</span>
                    </div>
                  ) : null}

                  <footer className="liney-note-post-foot">
                    <button
                      type="button"
                      className="liney-note-action-btn"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void mutate("note.like", { postId: post.postId });
                      }}
                    >
                      <Heart size={14} />
                      <span>{t("ถูกใจ")}</span>
                      {post.likeCount !== undefined && post.likeCount > 0 ? (
                        <strong className="liney-note-count">{post.likeCount}</strong>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="liney-note-action-btn"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        openPostDetail(post.postId);
                      }}
                    >
                      <MessageCircle size={14} />
                      <span>{t("คอมเมนต์")}</span>
                      {post.commentCount !== undefined && post.commentCount > 0 ? (
                        <strong className="liney-note-count">{post.commentCount}</strong>
                      ) : null}
                    </button>
                  </footer>
                </article>
              );
            })}
          </div>

          {cursor ? (
            <button
              type="button"
              className="liney-notes-load-more"
              disabled={busy || loading}
              onClick={() => void load(cursor)}
            >
              {loading ? <LoaderCircle size={15} className="spin" /> : null}
              <span>{t("โหลดโน้ตเก่าเพิ่มเติม")}</span>
            </button>
          ) : null}
        </div>
      </section>

      {/* Standalone Post Detail Popup Window */}
      {selectedPost ? (() => {
        const authorLabel = selectedPost.author === "สมาชิก" ? t("สมาชิก") : selectedPost.author;
        const timestamp = formatNoteTimestamp(selectedPost.createdTime, locale);
        const photoItems = (selectedPost.media ?? []).filter((m) => m.type !== "VIDEO");

        return (
          <div
            className="liney-note-detail-backdrop"
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget && !composerOpen && !lightbox) {
                setSelectedPostId(null);
                setDetailComment("");
              }
            }}
          >
            <section
              className="liney-note-detail-dialog"
              role="dialog"
              aria-modal="true"
              aria-label={t("รายละเอียดโน้ต")}
            >
              <header className="liney-note-detail-head">
                <div className="liney-note-avatar" aria-hidden="true">
                  {selectedPost.authorAvatarUrl ? (
                    <RemoteImage
                      src={selectedPost.authorAvatarUrl}
                      alt={authorLabel}
                      loading="lazy"
                      fallback={<span>{authorInitial(authorLabel)}</span>}
                    />
                  ) : (
                    <span>{authorInitial(authorLabel)}</span>
                  )}
                </div>
                <div className="liney-note-meta">
                  <div className="liney-note-author-row">
                    <strong>{authorLabel}</strong>
                    {selectedPost.canEdit ? <span className="liney-note-mine-badge">{t("โน้ตของคุณ")}</span> : null}
                  </div>
                  {timestamp ? <time className="liney-note-time">{timestamp}</time> : null}
                </div>
                <div className="liney-note-owner-actions">
                  {selectedPost.canEdit && !selectedPost.hasMedia ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t("แก้ไข")}
                      title={t("แก้ไข")}
                      disabled={busy}
                      onClick={() => openEditComposer(selectedPost)}
                    >
                      <Pencil size={16} />
                    </button>
                  ) : null}
                  {selectedPost.canEdit ? (
                    <button
                      type="button"
                      className="icon-button danger"
                      aria-label={t("ลบ")}
                      title={t("ลบ")}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t("ลบโน้ตนี้จาก LINE สำหรับสมาชิกทุกคน?"))) {
                          void mutate("note.delete", { postId: selectedPost.postId });
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t("ปิด")}
                    onClick={() => {
                      setSelectedPostId(null);
                      setDetailComment("");
                    }}
                  >
                    <X size={18} />
                  </button>
                </div>
              </header>

              <div className="liney-note-detail-scroll">
                {selectedPost.text ? (
                  <p className="liney-note-body liney-note-detail-body">{selectedPost.text}</p>
                ) : !selectedPost.hasMedia ? (
                  <p className="liney-note-body muted">{t("โน้ตที่ไม่มีข้อความ")}</p>
                ) : null}

                {photoItems.length > 0 ? (
                  <div className={`liney-note-media-grid liney-note-detail-gallery count-${Math.min(3, photoItems.length)}`}>
                    {photoItems.map((item, idx) => (
                      <NoteMediaTile
                        key={item.objectId}
                        homeId={homeId}
                        postId={selectedPost.postId}
                        item={item}
                        cache={mediaCacheRef}
                        onOpen={() => openPostLightbox(selectedPost, idx)}
                      />
                    ))}
                  </div>
                ) : selectedPost.hasMedia ? (
                  <div className="liney-note-media-pill">
                    <ImageIcon size={14} />
                    <span>{t("มีไฟล์สื่อแนบ")}</span>
                  </div>
                ) : null}
              </div>

              <footer className="liney-note-detail-foot">
                <div className="liney-note-detail-actions">
                  <button
                    type="button"
                    className="liney-note-action-btn"
                    disabled={busy}
                    onClick={() => void mutate("note.like", { postId: selectedPost.postId })}
                  >
                    <Heart size={15} />
                    <span>{t("ถูกใจ")}</span>
                    {selectedPost.likeCount !== undefined && selectedPost.likeCount > 0 ? (
                      <strong className="liney-note-count">{selectedPost.likeCount}</strong>
                    ) : null}
                  </button>
                  <span className="liney-note-detail-stat">
                    <MessageCircle size={15} />
                    <span>{t("คอมเมนต์")}</span>
                    {selectedPost.commentCount !== undefined && selectedPost.commentCount > 0 ? (
                      <strong className="liney-note-count">{selectedPost.commentCount}</strong>
                    ) : null}
                  </span>
                </div>

                <form
                  className="liney-note-comment liney-note-detail-comment"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (detailComment.trim() && !busy) {
                      void mutate("note.comment", { postId: selectedPost.postId, text: detailComment });
                    }
                  }}
                >
                  <input
                    value={detailComment}
                    onChange={(e) => setDetailComment(e.target.value)}
                    maxLength={10000}
                    placeholder={t("เขียนความคิดเห็น…")}
                    disabled={busy}
                  />
                  <button type="submit" disabled={!detailComment.trim() || busy}>
                    <Send size={14} />
                    <span>{t("ส่ง")}</span>
                  </button>
                </form>
              </footer>
            </section>
          </div>
        );
      })() : null}

      {/* Composer Popup Modal */}
      {composerOpen ? (
        <div
          className="liney-note-composer-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeComposer();
          }}
        >
          <section
            className={`liney-note-composer-dialog ${dragOver ? "drag-over" : ""}`}
            role="dialog"
            aria-modal="true"
            aria-label={editing ? t("แก้ไขโน้ต") : t("เขียนโน้ตใหม่")}
            onDragOver={(e) => {
              if (editing) return;
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              if (editing) return;
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files?.length) void addImageFiles(e.dataTransfer.files);
            }}
          >
            <header className="liney-note-composer-head">
              <strong>{editing ? t("แก้ไขโน้ต") : t("เขียนโน้ตใหม่")}</strong>
              <button
                type="button"
                className="icon-button"
                aria-label={t("ปิด")}
                disabled={busy}
                onClick={closeComposer}
              >
                <X size={18} />
              </button>
            </header>

            <form
              className="liney-note-composer-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!canSubmitComposer) return;
                if (editing) {
                  void mutate("note.update", { postId: editing, text: draft }, true);
                } else {
                  const images = draftImages.map((img) => img.dataUrl);
                  void mutate("note.create", {
                    text: draft,
                    ...(images.length > 0 ? { images } : {}),
                  }, true);
                }
              }}
            >
              <div className="liney-note-composer-body">
                <textarea
                  ref={textareaRef}
                  id="liney-note-draft"
                  maxLength={10000}
                  rows={6}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t("เขียนข้อความลง Note ของกลุ่ม…")}
                  disabled={busy}
                />
                <div className="liney-note-composer-counter">
                  <span>{draft.length.toLocaleString(locale)} / 10,000</span>
                </div>

                {!editing ? (
                  <div className="liney-note-upload-section">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      disabled={busy || convertingImages}
                      onChange={(event) => {
                        const files = event.target.files;
                        if (files?.length) void addImageFiles(files);
                        event.currentTarget.value = "";
                      }}
                    />

                    <div className="liney-note-upload-bar">
                      <button
                        type="button"
                        className="liney-note-add-photo-btn"
                        disabled={busy || convertingImages || draftImages.length >= MAX_NOTE_IMAGES}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        {convertingImages ? <LoaderCircle size={15} className="spin" /> : <ImagePlus size={16} />}
                        <span>{draftImages.length > 0 ? t("เพิ่มรูปภาพเพิ่มเติม") : t("เพิ่มรูปภาพ")}</span>
                      </button>
                      <small className="liney-note-upload-hint">
                        {draftImages.length > 0
                          ? t("เลือกแล้ว {{count}} / {{max}} รูป", { count: draftImages.length, max: MAX_NOTE_IMAGES })
                          : t("เลือกได้สูงสุด {{count}} รูป · รองรับ JPEG / PNG / WebP", { count: MAX_NOTE_IMAGES })}
                      </small>
                    </div>

                    {draftImages.length > 0 ? (
                      <div className="liney-note-upload-grid">
                        {draftImages.map((img) => (
                          <div key={img.id} className="liney-note-upload-thumb">
                            <img src={img.dataUrl} alt={img.name} />
                            <button
                              type="button"
                              className="liney-note-upload-remove"
                              aria-label={t("ลบรูปแนบ")}
                              title={t("ลบรูปแนบ")}
                              disabled={busy}
                              onClick={() => setDraftImages((current) => current.filter((item) => item.id !== img.id))}
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ))}
                        {draftImages.length < MAX_NOTE_IMAGES ? (
                          <button
                            type="button"
                            className="liney-note-upload-more-tile"
                            aria-label={t("เพิ่มรูปภาพเพิ่มเติม")}
                            disabled={busy || convertingImages}
                            onClick={() => fileInputRef.current?.click()}
                          >
                            <Plus size={20} />
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {composerError ? (
                  <p className="liney-albums-error liney-note-composer-error" role="alert">{composerError}</p>
                ) : null}
              </div>

              <footer className="liney-note-composer-foot">
                <button type="button" className="liney-note-cancel-btn" disabled={busy} onClick={closeComposer}>
                  {t("ยกเลิก")}
                </button>
                <button type="submit" className="liney-note-submit-btn" disabled={!canSubmitComposer}>
                  {busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
                  <span>{busy ? t("กำลังโพสต์…") : editing ? t("บันทึกการแก้ไข") : t("โพสต์โน้ต")}</span>
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}

      {/* Full-Screen Photo Lightbox */}
      {lightbox ? (
        <div
          className="liney-note-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={t("ดูรูปภาพขนาดเต็ม")}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setLightbox(null);
          }}
        >
          {lightbox.items.length > 1 ? (
            <span className="liney-note-lightbox-counter">
              {lightbox.index + 1} / {lightbox.items.length}
            </span>
          ) : null}
          <button
            type="button"
            className="icon-button liney-note-lightbox-close"
            aria-label={t("ปิด")}
            onClick={() => setLightbox(null)}
          >
            <X size={20} />
          </button>
          {lightbox.items.length > 1 ? (
            <button
              type="button"
              className="icon-button liney-note-lightbox-nav prev"
              aria-label={t("รูปก่อนหน้า")}
              onClick={() => setLightbox((cur) => cur ? { ...cur, index: (cur.index - 1 + cur.items.length) % cur.items.length } : null)}
            >
              <ChevronLeft size={24} />
            </button>
          ) : null}
          {lightboxStatus === "loading" ? (
            <div className="liney-note-lightbox-status">
              <LoaderCircle size={28} className="spin" />
              <span>{t("กำลังโหลดรูปภาพ…")}</span>
            </div>
          ) : lightboxStatus === "error" || !lightboxSrc ? (
            <div className="liney-note-lightbox-status">
              <ImageIcon size={28} />
              <span>{t("โหลดรูปภาพหลักไม่สำเร็จ")}</span>
            </div>
          ) : (
            <img src={lightboxSrc} alt={t("รูปภาพ")} />
          )}
          {lightbox.items.length > 1 ? (
            <button
              type="button"
              className="icon-button liney-note-lightbox-nav next"
              aria-label={t("รูปถัดไป")}
              onClick={() => setLightbox((cur) => cur ? { ...cur, index: (cur.index + 1) % cur.items.length } : null)}
            >
              <ChevronRight size={24} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
