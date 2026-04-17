import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMutation,
  collaboratorId,
  compareHlc,
  listItemId,
  parseHlc,
  serializeHlc,
  tickHlc
} from "../app/model.js";

test("hybrid logical clock is stable and totally ordered", () => {
  const state = { deviceId: "device-b", hlc: { wallTime: 0, counter: 0 } };
  const first = tickHlc(state, 100);
  const second = tickHlc(state, 100);
  const third = tickHlc(state, 99);

  assert.equal(first, "0000000000100:0000:device-b");
  assert.equal(second, "0000000000100:0001:device-b");
  assert.equal(third, "0000000000100:0002:device-b");
  assert.equal(compareHlc(first, second), -1);
  assert.equal(compareHlc(second, third), -1);
  assert.deepEqual(parseHlc(third), { wallTime: 100, counter: 2, deviceId: "device-b" });
  assert.equal(compareHlc(serializeHlc(100, 2, "device-a"), third), -1);
});

test("place fields use last-write-wins per field", () => {
  const state = emptyState();

  applyMutation(state, mutation({
    id: "create-place",
    entityType: "place",
    entityId: "place-1",
    field: "_create",
    timestamp: hlc(100),
    value: {
      id: "place-1",
      url: "https://example.com/a",
      name: "Original",
      city: "Vancouver",
      type: "Cafe"
    }
  }));

  applyMutation(state, mutation({
    id: "new-name",
    entityType: "place",
    entityId: "place-1",
    field: "name",
    value: "New",
    timestamp: hlc(102)
  }));

  applyMutation(state, mutation({
    id: "old-name",
    entityType: "place",
    entityId: "place-1",
    field: "name",
    value: "Old",
    timestamp: hlc(101, 0, "device-c")
  }));

  assert.equal(state.places[0].name, "New");
  assert.equal(state.places[0].city, "Vancouver");
});

test("list item and collaborator ids are stable", () => {
  assert.equal(listItemId("list-1", "place-1"), "list-1:place-1");
  assert.equal(collaboratorId("list-1", "user-1"), "list-1:user-1");
});

function emptyState() {
  return {
    deviceId: "device-a",
    user: { id: "user-a", name: "A" },
    hlc: { wallTime: 0, counter: 0 },
    places: [],
    lists: [],
    listItems: [],
    collaboratorsByList: {},
    placeClocks: {},
    listClocks: {},
    listItemClocks: {},
    collaboratorClocks: {}
  };
}

function mutation(overrides) {
  return {
    id: "mutation",
    entityType: "place",
    entityId: "place",
    field: "name",
    value: "value",
    timestamp: hlc(100),
    authorId: "user-a",
    authorName: "A",
    deviceId: "device-a",
    ...overrides
  };
}

function hlc(wallTime, counter = 0, device = "device-a") {
  return `${String(wallTime).padStart(13, "0")}:${String(counter).padStart(4, "0")}:${device}`;
}
