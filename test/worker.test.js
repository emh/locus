import assert from "node:assert/strict";
import test from "node:test";
import {
  materializeMutations,
  normalizeListRoom,
  normalizeProfileRoom,
  parseRoomRoute,
  validateMutation
} from "../workers/sync/src/index.js";

test("room routes extract kind, invite code, and action", () => {
  assert.deepEqual(parseRoomRoute("/api/profiles/ab12/sync"), { kind: "profiles", code: "AB12", action: "sync" });
  assert.deepEqual(parseRoomRoute("/api/lists/CD34/collaborators"), { kind: "lists", code: "CD34", action: "collaborators" });
  assert.equal(parseRoomRoute("/api/groups/AB12"), null);
});

test("rooms normalize profile and list metadata without requiring unique names", () => {
  const profile = normalizeProfileRoom({
    code: "ab-12",
    user: { id: "user-1", name: " Evan " }
  });
  assert.equal(profile.code, "AB12");
  assert.equal(profile.user.name, "Evan");

  const room = normalizeListRoom({
    code: "cd-34",
    user: { id: "user-1", name: "Evan" },
    list: { id: "list-1", name: " Lunch " }
  });
  assert.equal(room.code, "CD34");
  assert.equal(room.listId, "list-1");
  assert.equal(room.ownerUserId, "user-1");
});

test("worker validation accepts duplicate display names with stable user ids", () => {
  const room = normalizeListRoom({
    code: "list1",
    user: { id: "user-1", name: "Alex" },
    list: { id: "list-1", name: "Lunch" }
  });
  const first = validateMutation(mutation({
    id: "collab-1",
    entityType: "collaborator",
    entityId: "list-1:user-1",
    field: "_create",
    value: { listId: "list-1", userId: "user-1", name: "Alex" }
  }), room, { mode: "initial" });
  const second = validateMutation(mutation({
    id: "collab-2",
    entityType: "collaborator",
    entityId: "list-1:user-2",
    field: "_create",
    authorId: "user-2",
    value: { listId: "list-1", userId: "user-2", name: "Alex" }
  }), room, { mode: "initial" });

  assert.equal(first.value.name, "Alex");
  assert.equal(second.value.userId, "user-2");
});

test("worker materialization applies list entries and filters deleted entries", () => {
  const room = normalizeListRoom({
    code: "list1",
    user: { id: "user-1", name: "Evan" },
    list: { id: "list-1", name: "Lunch" }
  });
  const createList = mutation({
    id: "list-create",
    entityType: "list",
    entityId: "list-1",
    field: "_create",
    timestamp: hlc(100),
    value: { id: "list-1", name: "Lunch", sharedCode: "LIST1" }
  });
  const createPlace = mutation({
    id: "place-create",
    entityType: "place",
    entityId: "place-1",
    field: "_create",
    timestamp: hlc(101),
    value: { id: "place-1", url: "https://example.com", name: "Example" }
  });
  const createItem = mutation({
    id: "item-create",
    entityType: "list_item",
    entityId: "list-1:place-1",
    field: "_create",
    timestamp: hlc(102),
    value: { id: "list-1:place-1", listId: "list-1", placeId: "place-1", addedByUserId: "user-1", addedByName: "Evan" }
  });
  const deleteItem = mutation({
    id: "item-delete",
    entityType: "list_item",
    entityId: "list-1:place-1",
    field: "deleted",
    value: true,
    timestamp: hlc(103)
  });

  const visible = materializeMutations([createList, createPlace, createItem], room);
  assert.equal(visible.lists[0].name, "Lunch");
  assert.equal(visible.places[0].name, "Example");
  assert.equal(visible.listItems.length, 1);

  const deleted = materializeMutations([createList, createPlace, createItem, deleteItem], room);
  assert.equal(deleted.listItems.length, 0);
});

function mutation(overrides) {
  return {
    id: "mutation",
    entityType: "place",
    entityId: "place",
    field: "name",
    value: "value",
    timestamp: hlc(100),
    authorId: "user-1",
    authorName: "Evan",
    deviceId: "device-a",
    ...overrides
  };
}

function hlc(wallTime, counter = 0, device = "device-a") {
  return `${String(wallTime).padStart(13, "0")}:${String(counter).padStart(4, "0")}:${device}`;
}
