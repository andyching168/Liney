import { describe, expect, test } from "bun:test";
import {
  noteRoomId, notePostId, projectNoteList, listNotes, getNote, createNote, updateNote, deleteNote, likeNote, commentNote,
} from "./notes";

const room = `c${"a".repeat(32)}`;
function fakeClient() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const timeline = Object.fromEntries(["listPost", "getPost", "createPost", "updatePost", "deletePost", "likePost", "createComment", "uploadNoteMedia"].map((method) => [
    method, async (params: unknown) => {
      calls.push({ method, params });
      return { code: 200, result: method === "listPost" ? { posts: [{ postInfo: { postId: "post-1", writerMid: "u-self", likeCount: 4 }, contents: { text: "hello" } }] } : {} };
    },
  ]));
  return { client: { base: { timeline, profile: { mid: "u-self" } } } as any, calls };
}

describe("LINE Note operations", () => {
  test("accepts group and square MIDs, rejects direct messages and invalid IDs", () => {
    expect(noteRoomId(room)).toBe(room);
    expect(noteRoomId(`s${"a".repeat(32)}`)).toStartWith("s");
    expect(() => noteRoomId(`u${"a".repeat(32)}`)).toThrow();
    expect(() => noteRoomId("../bad")).toThrow();
    expect(() => notePostId("../../hello")).toThrow();
  });

  test("lists sanitized Note posts in the selected room", async () => {
    const { client, calls } = fakeClient();
    const result = await listNotes(client, room);
    expect(result.posts).toEqual([{ postId: "post-1", homeId: room, text: "hello", author: "u-self", likeCount: 4, canEdit: true, hasMedia: false }]);
    expect(calls[0]).toEqual({ method: "listPost", params: { homeId: room, sourceType: "TALKROOM" } });
  });

  test("creates Note with group-only read permissions", async () => {
    const { client, calls } = fakeClient();
    await createNote(client, room, " hello ");
    expect(calls[0]).toEqual({ method: "createPost", params: {
      homeId: room, text: "hello", sourceType: "TALKROOM", readPermissionType: "GROUP", readPermissionGids: [room],
    } });
    await expect(createNote(client, room, "")).rejects.toThrow();
    await expect(createNote(client, room, "x".repeat(10001))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("uploads Note JPEG through LINEJS OBS before creating post", async () => {
    const { client, calls } = fakeClient();
    client.base.timeline.uploadNoteMedia = async (type: string, data: Blob) => {
      calls.push({ method: "uploadNoteMedia", params: { type, size: data.size } });
      return { objId: "test-photo", objHash: "hash" };
    };
    const jpeg = Buffer.from([255,216,255,224,0,0]);
    await createNote(client, room, "image note", `data:image/jpeg;base64,${jpeg.toString("base64")}` as never);
    expect(calls[0]).toEqual({ method: "uploadNoteMedia", params: { type: "image", size: jpeg.length } });
    expect(calls[1].params).toMatchObject({ mediaObjectIds: ["test-photo"], mediaObjectTypes: ["PHOTO"] });
    const png = Buffer.from([137,80,78,71,13,10,26,10]);
    await expect(createNote(client, room, "image note", `data:image/png;base64,${png.toString("base64")}`)).rejects.toThrow("requires JPEG");
  });

  test("routes edit, delete, like, comment to same room", async () => {
    const { client, calls } = fakeClient();
    await updateNote(client, room, "post-1", "updated");
    await deleteNote(client, room, "post-1");
    await likeNote(client, room, "post-1");
    await commentNote(client, room, "post-1", "comment");
    expect(calls.map((call) => call.method)).toEqual(["updatePost", "deletePost", "likePost", "createComment"]);
    expect(calls[2].params).toMatchObject({ homeId: room, contentId: "post-1", sourceType: "TALKROOM" });
    expect(calls[3].params).toMatchObject({ homeId: room, contentId: "post-1", commentText: "comment" });
  });

  test("never treats incompatible response formats as successful empty feed", () => {
    expect(() => projectNoteList({ other: [] }, room)).toThrow("Unsupported LINE Note response");
  });

  test("uploads multiple Note JPEGs and attaches all mediaObjectIds in order", async () => {
    const { client, calls } = fakeClient();
    let seq = 0;
    client.base.timeline.uploadNoteMedia = async (type: string, data: Blob) => {
      seq++;
      calls.push({ method: "uploadNoteMedia", params: { type, size: data.size } });
      return { objId: `photo-${seq}`, objHash: `hash-${seq}` };
    };
    const jpeg = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 224, 0, 0]).toString("base64")}`;
    await createNote(client, room, "multi photo note", [jpeg, jpeg, jpeg]);
    expect(calls.filter((c) => c.method === "uploadNoteMedia")).toHaveLength(3);
    expect(calls[3]).toMatchObject({
      method: "createPost",
      params: {
        homeId: room,
        text: "multi photo note",
        mediaObjectIds: ["photo-1", "photo-2", "photo-3"],
        mediaObjectTypes: ["PHOTO", "PHOTO", "PHOTO"],
      },
    });
  });

  test("projects feeds-wrapped Note posts with media metadata", () => {
    const projected = projectNoteList({
      feeds: [{
        post: {
          postInfo: { postId: "p-99", writerMid: "u-1", writerName: "Alice", createdTime: 1700000000000, likeCount: 2, commentCount: 1 },
          contents: { text: "hello feed", media: [{ objectId: "oid-1", type: "PHOTO", serviceName: "myhome", obsNamespace: "h" }] },
        },
      }],
      nextScrollId: "cursor-2",
    }, room, "u-1");
    expect(projected.nextPostId).toBe("cursor-2");
    expect(projected.posts[0]).toMatchObject({
      postId: "p-99",
      author: "Alice",
      canEdit: true,
      hasMedia: true,
      media: [{ objectId: "oid-1", type: "PHOTO", serviceName: "myhome", obsNamespace: "h" }],
    });
  });

  test("getNote unwraps result.feed and falls back to listNotes when getPost fails", async () => {
    const { client } = fakeClient();
    client.base.timeline.getPost = async () => ({
      code: 200,
      result: {
        feed: {
          postInfo: { postId: "p-77", writerMid: "u-self", createdTime: 1700000000000 },
          contents: {
            text: "with photos",
            media: [{ objectId: "oid-a", type: "PHOTO", serviceName: "privnote", obsNamespace: "post" }],
          },
        },
      },
    });
    const post = await getNote(client, room, "p-77");
    expect(post).toMatchObject({ postId: "p-77", text: "with photos", hasMedia: true });
    expect(post.media).toHaveLength(1);

    client.base.timeline.getPost = async () => ({ code: 500, message: "temporary" });
    const fallback = await getNote(client, room, "post-1");
    expect(fallback).toMatchObject({ postId: "post-1", text: "hello" });
  });
});
