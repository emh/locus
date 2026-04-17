const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

const PLACE_FIELDS = new Set([
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
]);

const LIST_FIELDS = new Set(["name", "dateCreated", "ownerUserId", "ownerName", "sharedCode", "deleted"]);
const LIST_ITEM_FIELDS = new Set(["listId", "placeId", "addedByUserId", "addedByName", "addedAt", "deleted"]);
const COLLABORATOR_FIELDS = new Set(["listId", "userId", "name", "joinedAt", "deleted"]);

export class LocusRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = this.initialize();
  }

  async initialize() {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS mutations (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.state.storage.sql.exec("CREATE INDEX IF NOT EXISTS mutations_timestamp_idx ON mutations(timestamp)");
  }

  async fetch(request) {
    await this.ready;
    const cors = corsHeaders(request, this.env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, this.env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);
    const route = parseRoomRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    try {
      if (!route.action && request.method === "POST") {
        return this.createRoom(request, route, cors);
      }

      if (!route.action && request.method === "GET") {
        return json(await this.materializedPayload(await this.requireRoom()), 200, cors);
      }

      if (route.action === "sync" && request.method === "GET") {
        return this.handleWebSocket(request);
      }

      if (route.action === "sync" && request.method === "POST") {
        return this.handleHttpSync(request, cors);
      }

      if (route.action === "state" && request.method === "GET") {
        return json(await this.materializedPayload(await this.requireRoom()), 200, cors);
      }

      if (route.kind === "lists" && route.action === "collaborators" && request.method === "POST") {
        return this.joinCollaborator(request, cors);
      }

      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      return json({ error: messageFromError(error) }, error?.status || 400, cors);
    }
  }

  async createRoom(request, route, cors) {
    if (request.headers.get("X-Locus-Internal-Create") !== "1") {
      return json({ error: "Not found" }, 404, cors);
    }

    const existing = await this.getRoom();
    if (existing) return json({ error: "Invite code already exists" }, 409, cors);

    const body = await request.json();
    const room = route.kind === "profiles"
      ? normalizeProfileRoom({ code: route.code, user: body.user })
      : normalizeListRoom({ code: route.code, list: body.list, user: body.user });

    await this.saveRoom(room);

    if (room.type === "profile") {
      const accepted = await this.acceptMutations(Array.isArray(body.mutations) ? body.mutations : [], room);
      const payload = await this.materializedPayload(room);
      return json({ ...payload, confirmedIds: accepted.map(mutation => mutation.id) }, 200, cors);
    }

    const seed = createListSeedMutations(body, room);
    await this.insertMutations(seed);
    const payload = await this.materializedPayload(room);
    this.broadcast(null, { type: "mutations", items: seed, highWatermark: await this.highWatermark() });
    return json({ ...payload, confirmedIds: seed.map(mutation => mutation.id) }, 200, cors);
  }

  async handleWebSocket(request) {
    await this.requireRoom();

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "Expected WebSocket upgrade" }, 426);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHttpSync(request, cors) {
    const room = await this.requireRoom();
    const body = await request.json();
    const accepted = await this.acceptMutations(Array.isArray(body.mutations) ? body.mutations : [], room);
    const mutations = await this.listSince(typeof body.since === "string" ? body.since : "");
    return json({
      room,
      mutations,
      confirmedIds: accepted.map(mutation => mutation.id),
      highWatermark: await this.highWatermark()
    }, 200, cors);
  }

  async joinCollaborator(request, cors) {
    const room = await this.requireRoom();
    if (room.type !== "list") throw statusError("List not found", 404);

    const body = await request.json();
    const user = normalizeUser(body.user);
    const current = await this.materializedPayload(room);
    const existing = (current.collaboratorsByList[room.listId] || []).find(collaborator => collaborator.userId === user.id && !collaborator.deleted);

    if (!existing) {
      const mutation = serverMutation("collaborator", collaboratorId(room.listId, user.id), "_create", {
        id: collaboratorId(room.listId, user.id),
        listId: room.listId,
        userId: user.id,
        name: user.name,
        joinedAt: new Date().toISOString(),
        deleted: false
      }, user, 0);
      await this.insertMutations([validateMutation(mutation, room, { mode: "initial" })]);
      this.broadcast(null, { type: "mutations", items: [mutation], highWatermark: await this.highWatermark() });
    }

    return json(await this.materializedPayload(room), 200, cors);
  }

  async webSocketMessage(socket, raw) {
    await this.ready;

    try {
      const room = await this.requireRoom();
      const message = parseSocketMessage(raw);

      if (message.type === "sync") {
        socket.send(JSON.stringify({ type: "room", room }));
        socket.send(JSON.stringify({
          type: "mutations",
          items: await this.listSince(typeof message.since === "string" ? message.since : ""),
          highWatermark: await this.highWatermark()
        }));
        return;
      }

      if (message.type === "push") {
        const accepted = await this.acceptMutations(Array.isArray(message.mutations) ? message.mutations : [], room);
        const highWatermark = await this.highWatermark();
        socket.send(JSON.stringify({
          type: "ack",
          confirmedIds: accepted.map(mutation => mutation.id),
          highWatermark
        }));

        if (accepted.length) {
          this.broadcast(socket, {
            type: "mutations",
            items: accepted,
            highWatermark
          });
        }
        return;
      }

      socket.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", message: messageFromError(error) }));
    }
  }

  webSocketClose() {}

  webSocketError() {}

  broadcast(sender, message) {
    const raw = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      if (socket !== sender) {
        try {
          socket.send(raw);
        } catch {
          // Ignore dead sockets; the runtime will close them.
        }
      }
    }
  }

  async acceptMutations(input, room) {
    const accepted = [];

    for (const candidate of input) {
      const mutation = validateMutation(candidate, room, { mode: "accept" });
      await this.authorizeMutation(mutation, room);
      const exists = [...this.state.storage.sql.exec("SELECT id FROM mutations WHERE id = ?", mutation.id)];
      if (exists.length) continue;

      this.state.storage.sql.exec(
        "INSERT INTO mutations (id, timestamp, json, created_at) VALUES (?, ?, ?, ?)",
        mutation.id,
        mutation.timestamp,
        JSON.stringify(mutation),
        Date.now()
      );
      accepted.push(mutation);
    }

    return accepted;
  }

  async authorizeMutation(mutation, room) {
    if (room.type === "profile") {
      return;
    }

    if (mutation.entityType === "collaborator") {
      throw new Error("Use the collaborator join endpoint");
    }

    if (mutation.entityType === "list" && mutation.entityId !== room.listId) {
      throw new Error("Invalid list");
    }

    if (mutation.entityType === "list_item") {
      const listId = String(mutation.value?.listId || mutation.entityId.split(":")[0] || "");
      if (listId !== room.listId) throw new Error("Invalid list item");
    }

    const collaborators = await this.collaboratorIds(room);
    if (!collaborators.has(mutation.authorId)) throw new Error("Invalid collaborator");
  }

  async collaboratorIds(room) {
    const state = materializeMutations(await this.listSince(""), room);
    return new Set((state.collaboratorsByList[room.listId] || [])
      .filter(collaborator => !collaborator.deleted)
      .map(collaborator => collaborator.userId));
  }

  async insertMutations(mutations) {
    for (const mutation of mutations) {
      const exists = [...this.state.storage.sql.exec("SELECT id FROM mutations WHERE id = ?", mutation.id)];
      if (exists.length) continue;
      this.state.storage.sql.exec(
        "INSERT INTO mutations (id, timestamp, json, created_at) VALUES (?, ?, ?, ?)",
        mutation.id,
        mutation.timestamp,
        JSON.stringify(mutation),
        Date.now()
      );
    }
  }

  async listSince(since) {
    const query = since
      ? this.state.storage.sql.exec("SELECT json FROM mutations WHERE timestamp > ? ORDER BY timestamp ASC, id ASC", since)
      : this.state.storage.sql.exec("SELECT json FROM mutations ORDER BY timestamp ASC, id ASC");
    return [...query].map(row => JSON.parse(row.json));
  }

  async highWatermark() {
    const rows = [...this.state.storage.sql.exec("SELECT timestamp FROM mutations ORDER BY timestamp DESC LIMIT 1")];
    return rows[0]?.timestamp || "";
  }

  async materializedPayload(room) {
    const mutations = await this.listSince("");
    const state = materializeMutations(mutations, room);
    return {
      room,
      code: room.code,
      user: room.user || null,
      mutations,
      places: state.places,
      lists: state.lists,
      listItems: state.listItems,
      collaboratorsByList: state.collaboratorsByList,
      highWatermark: await this.highWatermark()
    };
  }

  async getRoom() {
    return await this.state.storage.get("room") || null;
  }

  async requireRoom() {
    const room = await this.getRoom();
    if (!room) throw statusError("Room not found", 404);
    return room;
  }

  async saveRoom(room) {
    await this.state.storage.put("room", room);
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (!isAllowedOrigin(request, env)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/profiles") {
      return createRoomWithFreshCode(request, env, cors, "profiles");
    }

    if (request.method === "POST" && url.pathname === "/api/lists") {
      return createRoomWithFreshCode(request, env, cors, "lists");
    }

    const route = parseRoomRoute(url.pathname);
    if (!route) return json({ error: "Not found" }, 404, cors);

    const id = env.LOCUS_ROOM.idFromName(`${route.kind}:${route.code}`);
    const room = env.LOCUS_ROOM.get(id);
    return room.fetch(request);
  }
};

async function createRoomWithFreshCode(request, env, cors, kind) {
  const body = await request.text();

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = generateInviteCode();
    const id = env.LOCUS_ROOM.idFromName(`${kind}:${code}`);
    const room = env.LOCUS_ROOM.get(id);
    const url = new URL(request.url);
    url.pathname = `/api/${kind}/${code}`;

    const response = await room.fetch(new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": request.headers.get("Content-Type") || "application/json",
        "Origin": request.headers.get("Origin") || "",
        "X-Locus-Internal-Create": "1"
      },
      body
    }));

    if (response.status !== 409) return response;
  }

  return json({ error: "Could not create invite code" }, 500, cors);
}

export function parseRoomRoute(pathname) {
  const match = /^\/api\/(profiles|lists)\/([A-Za-z0-9]+)(?:\/(sync|state|collaborators))?\/?$/.exec(pathname);
  if (!match) return null;
  return {
    kind: match[1],
    code: normalizeCode(match[2]),
    action: match[3] || ""
  };
}

export function generateInviteCode(length = CODE_LENGTH) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export function normalizeProfileRoom(input = {}) {
  const code = normalizeCode(input.code);
  const user = normalizeUser(input.user);
  if (!code) throw new Error("Code is required");
  return {
    type: "profile",
    code,
    user,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString()
  };
}

export function normalizeListRoom(input = {}) {
  const code = normalizeCode(input.code);
  const user = normalizeUser(input.user);
  const list = normalizeList({ ...input.list, sharedCode: code, ownerUserId: input.list?.ownerUserId || user.id, ownerName: input.list?.ownerName || user.name });
  if (!code) throw new Error("Code is required");
  if (!list.id) throw new Error("List id is required");
  return {
    type: "list",
    code,
    listId: list.id,
    name: list.name,
    ownerUserId: user.id,
    ownerName: user.name,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString()
  };
}

export function validateMutation(input, room, options = {}) {
  if (!input || typeof input !== "object") throw new Error("Mutation must be an object");
  const mutation = {
    id: stringValue(input.id, "Mutation id"),
    entityType: stringValue(input.entityType, "Entity type"),
    entityId: stringValue(input.entityId, "Entity id"),
    field: stringValue(input.field, "Field"),
    value: input.value,
    timestamp: stringValue(input.timestamp, "Timestamp"),
    authorId: stringValue(input.authorId, "Author id"),
    authorName: normalizeUserName(input.authorName),
    deviceId: stringValue(input.deviceId, "Device id")
  };

  if (!mutation.authorName) throw new Error("Author name is required");
  if (!["place", "list", "list_item", "collaborator"].includes(mutation.entityType)) throw new Error("Invalid entity type");
  if (!isHlc(mutation.timestamp)) throw new Error("Invalid timestamp");

  if (mutation.entityType === "place") return validatePlaceMutation(mutation);
  if (mutation.entityType === "list") return validateListMutation(mutation, room);
  if (mutation.entityType === "list_item") return validateListItemMutation(mutation, room);
  return validateCollaboratorMutation(mutation, room, options);
}

export function materializeMutations(mutations, room) {
  const state = {
    places: [],
    lists: [],
    listItems: [],
    collaboratorsByList: {},
    placeClocks: {},
    listClocks: {},
    listItemClocks: {},
    collaboratorClocks: {}
  };

  for (const mutation of mutations
    .map(item => validateMutation(item, room, { mode: "materialize" }))
    .sort(compareMutation)) {
    applyServerMutation(state, mutation);
  }

  return {
    places: state.places.filter(place => !place.deleted),
    lists: state.lists.filter(list => !list.deleted),
    listItems: state.listItems.filter(item => !item.deleted),
    collaboratorsByList: Object.fromEntries(Object.entries(state.collaboratorsByList).map(([listId, collaborators]) => [
      listId,
      collaborators.filter(collaborator => !collaborator.deleted)
    ]))
  };
}

export function applyServerMutation(state, mutation) {
  if (mutation.entityType === "place") return applyEntityMutation(state, mutation, "places", "placeClocks", normalizePlace, PLACE_FIELDS, coercePlaceField);
  if (mutation.entityType === "list") return applyEntityMutation(state, mutation, "lists", "listClocks", normalizeList, LIST_FIELDS, coerceListField);
  if (mutation.entityType === "list_item") return applyEntityMutation(state, mutation, "listItems", "listItemClocks", normalizeListItem, LIST_ITEM_FIELDS, coerceListItemField);
  if (mutation.entityType === "collaborator") return applyCollaboratorMutation(state, mutation);
  return false;
}

function createListSeedMutations(body, room) {
  const user = normalizeUser(body.user);
  const list = normalizeList({
    ...body.list,
    id: room.listId,
    ownerUserId: user.id,
    ownerName: user.name,
    sharedCode: room.code
  });
  const now = Date.now();
  let counter = 0;
  const seed = [
    serverMutation("collaborator", collaboratorId(list.id, user.id), "_create", {
      id: collaboratorId(list.id, user.id),
      listId: list.id,
      userId: user.id,
      name: user.name,
      joinedAt: new Date(now).toISOString(),
      deleted: false
    }, user, counter++, now),
    serverMutation("list", list.id, "_create", list, user, counter++, now)
  ];

  for (const place of Array.isArray(body.places) ? body.places : []) {
    const normalized = normalizePlace(place);
    seed.push(serverMutation("place", normalized.id, "_create", normalized, user, counter++, now));
  }

  for (const item of Array.isArray(body.listItems) ? body.listItems : []) {
    const normalized = normalizeListItem({ ...item, listId: list.id });
    if (!normalized.placeId) continue;
    seed.push(serverMutation("list_item", normalized.id, "_create", normalized, user, counter++, now));
  }

  return seed.map(mutation => validateMutation(mutation, room, { mode: "initial" }));
}

function serverMutation(entityType, entityId, field, value, user, counter = 0, now = Date.now()) {
  return {
    id: crypto.randomUUID(),
    entityType,
    entityId,
    field,
    value,
    timestamp: `${String(now).padStart(13, "0")}:${String(counter).padStart(4, "0")}:server`,
    authorId: user.id,
    authorName: user.name,
    deviceId: "server"
  };
}

function validatePlaceMutation(mutation) {
  if (mutation.field === "_create") {
    if (!mutation.value || typeof mutation.value !== "object") throw new Error("Place create value is required");
    return { ...mutation, value: normalizePlace({ ...mutation.value, id: mutation.entityId }) };
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!PLACE_FIELDS.has(field)) throw new Error("Invalid place field");
  return { ...mutation, field, value: coercePlaceField(field, mutation.value) };
}

function validateListMutation(mutation, room) {
  if (mutation.field === "_create") {
    if (!mutation.value || typeof mutation.value !== "object") throw new Error("List create value is required");
    const list = normalizeList({ ...mutation.value, id: mutation.entityId, sharedCode: room?.type === "list" ? room.code : mutation.value.sharedCode });
    if (!list.name) throw new Error("List name is required");
    return { ...mutation, value: list };
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!LIST_FIELDS.has(field)) throw new Error("Invalid list field");
  return { ...mutation, field, value: coerceListField(field, mutation.value) };
}

function validateListItemMutation(mutation, room) {
  if (mutation.field === "_create") {
    if (!mutation.value || typeof mutation.value !== "object") throw new Error("List item create value is required");
    const item = normalizeListItem({ ...mutation.value, id: mutation.entityId });
    if (!item.listId || !item.placeId) throw new Error("List item value is required");
    if (room?.type === "list" && item.listId !== room.listId) throw new Error("Invalid list item");
    return { ...mutation, value: item };
  }

  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  if (!LIST_ITEM_FIELDS.has(field)) throw new Error("Invalid list item field");
  return { ...mutation, field, value: coerceListItemField(field, mutation.value) };
}

function validateCollaboratorMutation(mutation, room, options = {}) {
  if (mutation.field !== "_create" && mutation.field !== "_delete" && !COLLABORATOR_FIELDS.has(mutation.field)) {
    throw new Error("Invalid collaborator field");
  }

  if (mutation.field === "_create") {
    if (!mutation.value || typeof mutation.value !== "object") throw new Error("Collaborator create value is required");
    const collaborator = normalizeCollaborator({ ...mutation.value, id: mutation.entityId });
    if (!collaborator.listId || !collaborator.userId || !collaborator.name) throw new Error("Collaborator value is required");
    if (room?.type === "list" && collaborator.listId !== room.listId) throw new Error("Invalid collaborator");
    return { ...mutation, value: collaborator };
  }

  if (options.mode === "accept") throw new Error("Use the collaborator join endpoint");
  const field = mutation.field === "_delete" ? "deleted" : mutation.field;
  return { ...mutation, field, value: coerceCollaboratorField(field, mutation.value) };
}

function applyEntityMutation(state, mutation, collectionKey, clockKey, normalize, fields, coerce) {
  state[clockKey][mutation.entityId] ||= {};
  const clocks = state[clockKey][mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalize({ ...mutation.value, id: mutation.entityId });
    let entity = state[collectionKey].find(candidate => candidate.id === mutation.entityId);
    if (!entity) {
      state[collectionKey].push(incoming);
      entity = state[collectionKey][state[collectionKey].length - 1];
    }

    for (const field of fields) {
      if (Object.hasOwn(incoming, field) && shouldApply(clocks[field], mutation.timestamp)) {
        entity[field] = incoming[field];
        clocks[field] = mutation.timestamp;
      }
    }
    return true;
  }

  if (!fields.has(mutation.field)) return false;
  let entity = state[collectionKey].find(candidate => candidate.id === mutation.entityId);
  if (!entity) {
    entity = normalize({ id: mutation.entityId });
    state[collectionKey].push(entity);
  }
  if (!shouldApply(clocks[mutation.field], mutation.timestamp)) return false;
  entity[mutation.field] = coerce(mutation.field, mutation.value);
  clocks[mutation.field] = mutation.timestamp;
  return true;
}

function applyCollaboratorMutation(state, mutation) {
  state.collaboratorClocks[mutation.entityId] ||= {};
  const clocks = state.collaboratorClocks[mutation.entityId];

  if (mutation.field === "_create") {
    const incoming = normalizeCollaborator({ ...mutation.value, id: mutation.entityId });
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
    return true;
  }

  const [listId = ""] = mutation.entityId.split(":");
  state.collaboratorsByList[listId] ||= [];
  let collaborator = state.collaboratorsByList[listId].find(candidate => candidate.id === mutation.entityId);
  if (!collaborator) {
    collaborator = normalizeCollaborator({ id: mutation.entityId, listId });
    state.collaboratorsByList[listId].push(collaborator);
  }
  if (!shouldApply(clocks[mutation.field], mutation.timestamp)) return false;
  collaborator[mutation.field] = coerceCollaboratorField(mutation.field, mutation.value);
  clocks[mutation.field] = mutation.timestamp;
  return true;
}

function normalizePlace(input = {}) {
  return {
    id: String(input.id || ""),
    url: stringOr(input.url, ""),
    originalUrl: stringOr(input.originalUrl, input.url || ""),
    canonicalUrl: stringOr(input.canonicalUrl, input.url || ""),
    source: stringOr(input.source, ""),
    name: String(input.name || "").trim().slice(0, 200) || "Untitled place",
    address: stringOr(input.address, ""),
    city: stringOr(input.city, ""),
    state: stringOr(input.state, ""),
    country: stringOr(input.country, ""),
    type: stringOr(input.type, "Other").slice(0, 80),
    tags: Array.isArray(input.tags) ? input.tags.map(tag => String(tag || "").trim()).filter(Boolean).slice(0, 8) : [],
    description: stringOr(input.description, "").slice(0, 5000),
    notes: stringOr(input.notes, "").slice(0, 5000),
    lat: numberOrNull(input.lat),
    lng: numberOrNull(input.lng),
    osmId: stringOr(input.osmId, ""),
    osmType: stringOr(input.osmType, ""),
    geocodeStatus: stringOr(input.geocodeStatus, ""),
    dateAdded: typeof input.dateAdded === "string" && input.dateAdded ? input.dateAdded : new Date().toISOString(),
    dateUpdated: typeof input.dateUpdated === "string" ? input.dateUpdated : "",
    status: stringOr(input.status, ""),
    error: stringOr(input.error, ""),
    isFavorite: Boolean(input.isFavorite),
    addedByUserId: stringOr(input.addedByUserId, ""),
    addedByName: stringOr(input.addedByName, ""),
    deleted: Boolean(input.deleted)
  };
}

function normalizeList(input = {}) {
  const name = String(input.name || "").replace(/\s+/g, " ").trim();
  return {
    id: String(input.id || ""),
    name: name || "Untitled list",
    dateCreated: typeof input.dateCreated === "string" && input.dateCreated ? input.dateCreated : new Date().toISOString(),
    ownerUserId: stringOr(input.ownerUserId, ""),
    ownerName: stringOr(input.ownerName, ""),
    sharedCode: normalizeCode(input.sharedCode),
    deleted: Boolean(input.deleted)
  };
}

function normalizeListItem(input = {}) {
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

function normalizeCollaborator(input = {}) {
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

function normalizeUser(input = {}) {
  const id = stringValue(input.id, "User id");
  const name = normalizeUserName(input.name);
  if (!name) throw new Error("Name is required");
  return {
    id,
    name,
    profileCode: normalizeCode(input.profileCode)
  };
}

function coercePlaceField(field, value) {
  if (field === "deleted" || field === "isFavorite") return Boolean(value);
  if (field === "lat" || field === "lng") return numberOrNull(value);
  if (field === "tags") return Array.isArray(value) ? value.map(tag => String(tag || "").trim()).filter(Boolean).slice(0, 8) : [];
  return String(value || "").trim();
}

function coerceListField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "sharedCode") return normalizeCode(value);
  if (field === "name") return String(value || "").replace(/\s+/g, " ").trim() || "Untitled list";
  return String(value || "").trim();
}

function coerceListItemField(field, value) {
  if (field === "deleted") return Boolean(value);
  return String(value || "").trim();
}

function coerceCollaboratorField(field, value) {
  if (field === "deleted") return Boolean(value);
  if (field === "name") return normalizeUserName(value);
  return String(value || "").trim();
}

function compareMutation(left, right) {
  return compareHlc(left.timestamp, right.timestamp) || left.id.localeCompare(right.id);
}

function compareHlc(left, right) {
  const a = parseHlc(left);
  const b = parseHlc(right);
  if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  return a.deviceId.localeCompare(b.deviceId);
}

function parseHlc(value) {
  const [wallTime, counter, ...deviceParts] = String(value || "").split(":");
  return {
    wallTime: Number.parseInt(wallTime, 10) || 0,
    counter: Number.parseInt(counter, 10) || 0,
    deviceId: deviceParts.join(":")
  };
}

function shouldApply(currentTimestamp, incomingTimestamp) {
  return !currentTimestamp || compareHlc(incomingTimestamp, currentTimestamp) >= 0;
}

function isHlc(value) {
  return /^\d{13}:\d{4}:.+/.test(value);
}

function listItemId(listId, placeId) {
  return `${String(listId)}:${String(placeId)}`;
}

function collaboratorId(listId, userId) {
  return `${String(listId)}:${String(userId)}`;
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeUserName(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringValue(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function numberOrNull(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins(env);
  const allowOrigin = origin && (allowed.includes("*") || allowed.includes(origin)) ? origin : "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };

  if (allowOrigin) {
    headers["Access-Control-Allow-Origin"] = allowOrigin;
  }

  return headers;
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  const allowed = allowedOrigins(env);
  return allowed.includes("*") || allowed.includes(origin);
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}

function parseSocketMessage(raw) {
  if (typeof raw === "string") return JSON.parse(raw);
  return JSON.parse(new TextDecoder().decode(raw));
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}
