import { normalizePlace } from "./place.js";

export const PLACE_FIELDS = [
  "url",
  "originalUrl",
  "canonicalUrl",
  "source",
  "name",
  "address",
  "city",
  "state",
  "country",
  "type",
  "tags",
  "description",
  "notes",
  "lat",
  "lng",
  "osmId",
  "osmType",
  "geocodeStatus",
  "dateAdded",
  "dateUpdated",
  "status",
  "error",
  "isFavorite",
  "addedByUserId",
  "addedByName",
  "deleted"
];

export const LIST_FIELDS = [
  "name",
  "dateCreated",
  "ownerUserId",
  "ownerName",
  "sharedCode",
  "deleted"
];

export const LIST_ITEM_FIELDS = [
  "listId",
  "placeId",
  "addedByUserId",
  "addedByName",
  "addedAt",
  "deleted"
];

export const COLLABORATOR_FIELDS = [
  "listId",
  "userId",
  "name",
  "joinedAt",
  "deleted"
];

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createDeviceId() {
  return createId();
}

export function createUser(name) {
  return {
    id: createId(),
    name: normalizeUserName(name),
    profileCode: ""
  };
}

export function normalizeUser(user) {
  if (!user || typeof user !== "object") return null;
  const id = typeof user.id === "string" && user.id.trim() ? user.id.trim() : "";
  const name = normalizeUserName(user.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    profileCode: normalizeCode(user.profileCode)
  };
}

export function normalizeUserName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function serializeHlc(wallTime, counter, deviceId) {
  return `${String(Math.max(0, Number(wallTime) || 0)).padStart(13, "0")}:${String(Math.max(0, Number(counter) || 0)).padStart(4, "0")}:${deviceId || ""}`;
}

export function parseHlc(value) {
  if (typeof value !== "string" || !value) {
    return { wallTime: 0, counter: 0, deviceId: "" };
  }

  const [wallTime, counter, ...deviceParts] = value.split(":");
  return {
    wallTime: Number.parseInt(wallTime, 10) || 0,
    counter: Number.parseInt(counter, 10) || 0,
    deviceId: deviceParts.join(":")
  };
}

export function compareHlc(left, right) {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.deviceId.localeCompare(b.deviceId);
}

export function tickHlc(state, now = Date.now(), deviceId = state.deviceId) {
  const clock = normalizeClock(state.hlc);
  const wallTime = Math.max(clock.wallTime, now);
  const counter = wallTime === clock.wallTime ? clock.counter + 1 : 0;
  state.hlc = { wallTime, counter };
  return serializeHlc(wallTime, counter, deviceId);
}

export function observeHlc(state, timestamp, now = Date.now(), deviceId = state.deviceId) {
  const local = normalizeClock(state.hlc);
  const remote = parseHlc(timestamp);
  const wallTime = Math.max(local.wallTime, remote.wallTime, now);
  let counter = 0;

  if (wallTime === local.wallTime && wallTime === remote.wallTime) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (wallTime === local.wallTime) {
    counter = local.counter + 1;
  } else if (wallTime === remote.wallTime) {
    counter = remote.counter + 1;
  }

  state.hlc = { wallTime, counter };
  return serializeHlc(wallTime, counter, deviceId);
}

export function createMutation(state, entityType, entityId, field, value) {
  const user = state.user;
  if (!user?.id || !user.name) throw new Error("User name required");

  return {
    id: createId(),
    entityType,
    entityId: String(entityId || ""),
    field: String(field || ""),
    value,
    timestamp: tickHlc(state, Date.now(), state.deviceId),
    authorId: user.id,
    authorName: user.name,
    deviceId: state.deviceId
  };
}

export function normalizePlaceRecord(input = {}) {
  return {
    ...normalizePlace({
      ...input,
      url: input.url || input.canonicalUrl || input.originalUrl || ""
    }),
    addedByUserId: stringOr(input.addedByUserId, ""),
    addedByName: stringOr(input.addedByName, ""),
    deleted: Boolean(input.deleted)
  };
}

export function normalizeList(input = {}) {
  const name = String(input.name || "").replace(/\s+/g, " ").trim();
  return {
    id: String(input.id || createId()),
    name: name || "Untitled list",
    dateCreated: typeof input.dateCreated === "string" && input.dateCreated ? input.dateCreated : new Date().toISOString(),
    ownerUserId: stringOr(input.ownerUserId, ""),
    ownerName: stringOr(input.ownerName, ""),
    sharedCode: normalizeCode(input.sharedCode),
    deleted: Boolean(input.deleted)
  };
}

export function listItemId(listId, placeId) {
  return `${String(listId)}:${String(placeId)}`;
}

export function normalizeListItem(input = {}) {
  const listId = String(input.listId || "");
  const placeId = String(input.placeId || "");
  return {
    id: String(input.id || listItemId(listId, placeId)),
    listId,
    placeId,
    addedByUserId: stringOr(input.addedByUserId, ""),
    addedByName: stringOr(input.addedByName, ""),
    addedAt: typeof input.addedAt === "string" && input.addedAt ? input.addedAt : new Date().toISOString(),
    deleted: Boolean(input.deleted)
  };
}

export function collaboratorId(listId, userId) {
  return `${String(listId)}:${String(userId)}`;
}

export function normalizeCollaborator(input = {}) {
  const listId = String(input.listId || "");
  const userId = String(input.userId || "");
  return {
    id: String(input.id || collaboratorId(listId, userId)),
    listId,
    userId,
    name: normalizeUserName(input.name),
    joinedAt: typeof input.joinedAt === "string" && input.joinedAt ? input.joinedAt : new Date().toISOString(),
    deleted: Boolean(input.deleted)
  };
}

export function visiblePlaces(places = []) {
  return places.filter(place => !place.deleted);
}

export function visibleLists(lists = []) {
  return lists.filter(list => !list.deleted);
}

export function visibleListItems(items = []) {
  return items.filter(item => !item.deleted);
}

export function getListItems(state, listId, options = {}) {
  const includeDeleted = Boolean(options.includeDeleted);
  return (state.listItems || [])
    .filter(item => item.listId === String(listId))
    .filter(item => includeDeleted || !item.deleted);
}

export function getListPlaceIds(state, listId) {
  return getListItems(state, listId).map(item => item.placeId);
}

export function applyMutations(state, mutations = []) {
  let changed = false;
  for (const mutation of mutations) {
    changed = applyMutation(state, mutation) || changed;
  }
  return changed;
}

export function applyMutation(state, mutation) {
  if (!isMutationLike(mutation)) return false;
  observeHlc(state, mutation.timestamp);

  if (mutation.entityType === "place") return applyPlaceMutation(state, mutation);
  if (mutation.entityType === "list") return applyListMutation(state, mutation);
  if (mutation.entityType === "list_item") return applyListItemMutation(state, mutation);
  if (mutation.entityType === "collaborator") return applyCollaboratorMutation(state, mutation);
  return false;
}

function applyPlaceMutation(state, mutation) {
  state.placeClocks ||= {};
  state.placeClocks[mutation.entityId] ||= {};
  const clocks = state.placeClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizePlaceRecord({ ...mutation.value, id: mutation.entityId });
    let place = state.places.find(candidate => candidate.id === mutation.entityId);
    if (!place) {
      state.places.push(incoming);
      place = state.places[state.places.length - 1];
    }

    for (const field of PLACE_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        place[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = normalizePlaceField(mutation.field);
  if (!PLACE_FIELDS.includes(field)) return false;

  let place = state.places.find(candidate => candidate.id === mutation.entityId);
  if (!place) {
    place = normalizePlaceRecord({ id: mutation.entityId, url: "" });
    state.places.push(place);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  place[field] = coercePlaceField(field, mutation.value);
  clocks[field] = mutation.timestamp;
  return true;
}

function applyListMutation(state, mutation) {
  state.listClocks ||= {};
  state.listClocks[mutation.entityId] ||= {};
  const clocks = state.listClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeList({ ...mutation.value, id: mutation.entityId });
    let list = state.lists.find(candidate => candidate.id === mutation.entityId);
    if (!list) {
      state.lists.push(incoming);
      list = state.lists[state.lists.length - 1];
    }

    for (const field of LIST_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        list[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!LIST_FIELDS.includes(field)) return false;

  let list = state.lists.find(candidate => candidate.id === mutation.entityId);
  if (!list) {
    list = normalizeList({ id: mutation.entityId });
    state.lists.push(list);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  list[field] = coerceListField(field, mutation.value);
  clocks[field] = mutation.timestamp;
  return true;
}

function applyListItemMutation(state, mutation) {
  state.listItemClocks ||= {};
  state.listItemClocks[mutation.entityId] ||= {};
  const clocks = state.listItemClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeListItem({ ...mutation.value, id: mutation.entityId });
    if (!incoming.listId || !incoming.placeId) return false;
    let item = state.listItems.find(candidate => candidate.id === mutation.entityId);
    if (!item) {
      state.listItems.push(incoming);
      item = state.listItems[state.listItems.length - 1];
    }

    for (const field of LIST_ITEM_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        item[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!LIST_ITEM_FIELDS.includes(field)) return false;

  let item = state.listItems.find(candidate => candidate.id === mutation.entityId);
  if (!item) {
    const [listId = "", placeId = ""] = mutation.entityId.split(":");
    item = normalizeListItem({ id: mutation.entityId, listId, placeId });
    state.listItems.push(item);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  item[field] = coerceListItemField(field, mutation.value);
  clocks[field] = mutation.timestamp;
  return true;
}

function applyCollaboratorMutation(state, mutation) {
  state.collaboratorClocks ||= {};
  state.collaboratorClocks[mutation.entityId] ||= {};
  const clocks = state.collaboratorClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeCollaborator({ ...mutation.value, id: mutation.entityId });
    if (!incoming.listId || !incoming.userId || !incoming.name) return false;
    state.collaboratorsByList ||= {};
    state.collaboratorsByList[incoming.listId] ||= [];
    let collaborator = state.collaboratorsByList[incoming.listId].find(candidate => candidate.id === mutation.entityId);
    if (!collaborator) {
      state.collaboratorsByList[incoming.listId].push(incoming);
      collaborator = state.collaboratorsByList[incoming.listId][state.collaboratorsByList[incoming.listId].length - 1];
    }

    for (const field of COLLABORATOR_FIELDS) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        collaborator[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    clocks._create = maxHlc(clocks._create, mutation.timestamp);
    return true;
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!COLLABORATOR_FIELDS.includes(field)) return false;

  const [listId = "", userId = ""] = mutation.entityId.split(":");
  state.collaboratorsByList ||= {};
  state.collaboratorsByList[listId] ||= [];
  let collaborator = state.collaboratorsByList[listId].find(candidate => candidate.id === mutation.entityId);
  if (!collaborator) {
    collaborator = normalizeCollaborator({ id: mutation.entityId, listId, userId });
    state.collaboratorsByList[listId].push(collaborator);
  }

  if (!shouldApply(clocks[field], mutation.timestamp)) return false;
  collaborator[field] = coerceCollaboratorField(field, mutation.value);
  clocks[field] = mutation.timestamp;
  return true;
}

function normalizePlaceField(field) {
  if (field === "_delete") return "deleted";
  return field;
}

function coercePlaceField(field, value) {
  if (field === "deleted" || field === "isFavorite") return Boolean(value);
  if (field === "lat" || field === "lng") {
    if (value == null || String(value).trim() === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (field === "tags") {
    return Array.isArray(value)
      ? value.map(tag => String(tag || "").trim()).filter(Boolean).slice(0, 8)
      : [];
  }
  if (field === "dateAdded" || field === "dateUpdated") return value || "";
  return String(value || "").trim();
}

function coerceListField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "sharedCode") return normalizeCode(value);
  if (field === "dateCreated") return value || new Date().toISOString();
  if (field === "name") return String(value || "").replace(/\s+/g, " ").trim() || "Untitled list";
  return String(value || "").trim();
}

function coerceListItemField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "addedAt") return value || new Date().toISOString();
  return String(value || "").trim();
}

function coerceCollaboratorField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "joinedAt") return value || new Date().toISOString();
  if (field === "name") return normalizeUserName(value);
  return String(value || "").trim();
}

function normalizeClock(clock) {
  return {
    wallTime: Number.isFinite(clock?.wallTime) ? clock.wallTime : 0,
    counter: Number.isFinite(clock?.counter) ? clock.counter : 0
  };
}

function shouldApply(currentTimestamp, incomingTimestamp) {
  return !currentTimestamp || compareHlc(incomingTimestamp, currentTimestamp) >= 0;
}

function maxHlc(left, right) {
  if (!left) return right || "";
  if (!right) return left || "";
  return compareHlc(left, right) >= 0 ? left : right;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function isMutationLike(mutation) {
  return Boolean(
    mutation &&
    typeof mutation.id === "string" &&
    ["place", "list", "list_item", "collaborator"].includes(mutation.entityType) &&
    typeof mutation.entityId === "string" &&
    typeof mutation.field === "string" &&
    typeof mutation.timestamp === "string"
  );
}
