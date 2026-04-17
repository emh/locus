import assert from "node:assert/strict";
import test from "node:test";
import { createInitialState, migrateLegacyForUser, normalizeStoredState } from "../app/storage.js";

test("stored state normalizes v2 sync state", () => {
  const state = normalizeStoredState({
    deviceId: "device-1",
    user: { id: "user-1", name: " Evan ", profileCode: "ab-12" },
    places: [{ id: "place-1", url: "https://example.com", name: "Example" }],
    lists: [{ id: "list-1", name: "Lunch", sharedCode: "cd-34" }],
    listItems: [{ listId: "list-1", placeId: "place-1" }],
    sharedListSync: {
      "cd-34": {
        listId: "list-1",
        lastSyncTimestamp: "0000000000100:0000:device-1",
        mutationQueue: [{ id: "m-1", entityType: "list", entityId: "list-1", field: "name", timestamp: "0000000000100:0000:device-1" }]
      }
    }
  });

  assert.equal(state.user.name, "Evan");
  assert.equal(state.user.profileCode, "AB12");
  assert.equal(state.lists[0].sharedCode, "CD34");
  assert.equal(state.sharedListSync.CD34.listId, "list-1");
  assert.equal(state.sharedListSync.CD34.mutationQueue.length, 1);
});

test("legacy migration attributes places and list entries to chosen user", () => {
  const state = {
    ...createInitialState(),
    pendingLegacy: {
      places: [{ id: "place-1", url: "https://example.com", name: "Example" }],
      lists: [{ id: "list-1", name: "Lunch", placeIds: ["place-1"], dateCreated: "2026-04-17T00:00:00.000Z" }]
    }
  };

  migrateLegacyForUser(state, " Evan ");

  assert.equal(state.user.name, "Evan");
  assert.equal(state.places[0].addedByUserId, state.user.id);
  assert.equal(state.lists[0].ownerUserId, state.user.id);
  assert.equal(state.listItems[0].addedByUserId, state.user.id);
  assert.equal(state.collaboratorsByList["list-1"][0].name, "Evan");
  assert.equal(state.profileSync.mutationQueue.length, 4);
  assert.equal(state.pendingLegacy, undefined);
});
