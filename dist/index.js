"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  Negotiator: () => Negotiator,
  RTCConnectionError: () => RTCConnectionError,
  RTCFetcher: () => RTCFetcher,
  RTCFetcherError: () => RTCFetcherError,
  RTCResponse: () => RTCResponse,
  RTCSerializationError: () => RTCSerializationError,
  RTCTimeoutError: () => RTCTimeoutError,
  ReceiveStream: () => ReceiveStream,
  SendStream: () => SendStream,
  msgpackCodec: () => msgpackCodec
});
module.exports = __toCommonJS(index_exports);

// src/negotiation/messages.ts
var encodeNegotiationMessage = (message) => {
  return JSON.stringify(message);
};
var decodeNegotiationMessage = (data) => {
  return JSON.parse(data);
};

// src/rtcfetcher/errors/rtc-fetcher-error.ts
var RTCFetcherError = class _RTCFetcherError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "RTCFetcherError";
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, _RTCFetcherError);
    }
  }
};
var RTCTimeoutError = class extends RTCFetcherError {
  constructor(message = "Request timed out") {
    super(message, "TIMEOUT");
    this.name = "RTCTimeoutError";
  }
};
var RTCConnectionError = class extends RTCFetcherError {
  constructor(message = "Connection lost") {
    super(message, "CONNECTION_LOST");
    this.name = "RTCConnectionError";
  }
};
var RTCSerializationError = class extends RTCFetcherError {
  constructor(message = "Serialization failed", cause) {
    super(message, "SERIALIZATION_FAILED", cause);
    this.name = "RTCSerializationError";
  }
};

// src/negotiation/id-negotiator.ts
var _Negotiator = class _Negotiator {
  constructor(signalingChannel, pc) {
    this.signalingChannel = signalingChannel;
    this.pc = pc;
    // SCTP limit 65535, 255 reserved
    this.pendingReservations = /* @__PURE__ */ new Map();
    // Reservations that are ACKed but waiting for READY from peer
    this.waitingForReady = /* @__PURE__ */ new Map();
    this.setupSignalingChannel();
  }
  async sendReady(id) {
    this.send({ type: "READY", id });
  }
  /**
   * Reserve a new DataChannel ID.
   * Uses getStats to find an unused ID, then performs a handshake with the peer.
   */
  async reserveId(label, excludedIds = /* @__PURE__ */ new Set()) {
    let attempts = 0;
    const maxAttempts = 5;
    while (attempts < maxAttempts) {
      attempts++;
      const candidateId = await this.findUnusedId(excludedIds);
      try {
        await this.performHandshake(candidateId, label);
        return candidateId;
      } catch (error) {
        excludedIds.add(candidateId);
        continue;
      }
    }
    throw new RTCFetcherError("Failed to negotiate DataChannel ID after multiple attempts", "NEGOTIATION_FAILED");
  }
  async performHandshake(id, label) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingReservations.delete(id);
        reject(new Error("Reservation timeout"));
      }, 3e3);
      this.pendingReservations.set(id, {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });
      this.send({ type: "RESERVE", id, label });
    });
  }
  async handleReserveRequest(message) {
    const id = message.id;
    if (this.waitingForReady.has(id)) {
      console.log(`[Negotiator] Duplicate Reserve Request for ID ${id}. Resending ACK.`);
      this.send({ type: "ACK", id });
      return;
    }
    let isUsed = await this.isIdUsed(id);
    console.log(`[Negotiator] Handle Reserve ID: ${id}. isUsed (stats): ${isUsed}`);
    let probeChannel;
    if (!isUsed) {
      try {
        probeChannel = this.pc.createDataChannel("probe", { negotiated: true, id });
        console.log(`[Negotiator] Probe created for ID ${id}. State: ${probeChannel.readyState}`);
      } catch (e) {
        console.warn(`ID ${id} probing failed, marking as used.`, e);
        isUsed = true;
      }
    }
    if (isUsed) {
      console.warn(`[Negotiator] Rejecting ID ${id} (Used or Probe Failed)`);
      this.send({ type: "NACK", id });
    } else {
      this.waitingForReady.set(id, { channel: probeChannel, label: message.label });
      this.send({ type: "ACK", id });
    }
  }
  handleReady(message) {
    const id = message.id;
    const waiting = this.waitingForReady.get(id);
    if (waiting) {
      this.waitingForReady.delete(id);
      if (this.onReserved) {
        this.onReserved(id, waiting.channel, waiting.label);
      }
    } else {
    }
  }
  handleAck(message) {
    const id = message.id;
    const pending = this.pendingReservations.get(id);
    if (pending) {
      this.pendingReservations.delete(id);
      pending.resolve();
    }
  }
  handleNack(message) {
    const id = message.id;
    const pending = this.pendingReservations.get(id);
    if (pending) {
      this.pendingReservations.delete(id);
      pending.reject(new Error("ID rejected by peer"));
    }
  }
  setupSignalingChannel() {
    this.signalingChannel.onmessage = async (event) => {
      try {
        const message = decodeNegotiationMessage(event.data);
        switch (message.type) {
          case "RESERVE":
            await this.handleReserveRequest(message);
            break;
          case "ACK":
            this.handleAck(message);
            break;
          case "NACK":
            this.handleNack(message);
            break;
          case "READY":
            this.handleReady(message);
            break;
        }
      } catch (error) {
        console.error("Signaling channel error:", error);
      }
    };
  }
  send(message) {
    if (this.signalingChannel.readyState === "open") {
      this.signalingChannel.send(encodeNegotiationMessage(message));
    } else {
      console.warn("Signaling channel is not open, cannot send message", message);
    }
  }
  async findUnusedId(excludedIds) {
    const usedIds = await this.getUsedIds();
    const sctp = this.pc.sctp;
    const max = sctp?.maxChannels ?? sctp?.maxDataChannels;
    const limit = max && max > 0 ? max : 256;
    let candidate = -1;
    for (let i = 1; i < limit; i++) {
      if (i !== _Negotiator.SIGNALING_CHANNEL_ID && !usedIds.has(i) && !excludedIds?.has(i)) {
        candidate = i;
        break;
      }
    }
    if (candidate === -1) {
      throw new RTCFetcherError("No available ID found", "NO_ID_AVAILABLE");
    }
    return candidate;
  }
  async isIdUsed(id) {
    const usedIds = await this.getUsedIds();
    return usedIds.has(id);
  }
  async getUsedIds() {
    const stats = await this.pc.getStats();
    const usedIds = /* @__PURE__ */ new Set();
    stats.forEach((report) => {
      if (report.type === "data-channel" && typeof report.dataChannelIdentifier === "number") {
        usedIds.add(report.dataChannelIdentifier);
      }
    });
    this.pendingReservations.forEach((_, id) => usedIds.add(id));
    return usedIds;
  }
};
_Negotiator.SIGNALING_CHANNEL_ID = 0;
_Negotiator.MAX_CHANNEL_ID = 65534;
var Negotiator = _Negotiator;

// src/datachannelstream/framing/channel-controller.ts
var MSG_TYPE_DATA = 1;
var MSG_TYPE_CREDIT = 2;
var DataChannelController = class {
  constructor(channel) {
    this.channel = channel;
    this.pendingCredit = 0;
    this.instanceId = Math.random().toString(36).substring(7);
    console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] Created. Type: ${channel.constructor?.name}`);
    this.channel.binaryType = "arraybuffer";
    this.channel.onmessage = this.handleMessage.bind(this);
  }
  set onCredit(handler) {
    console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] Setting onCredit handler. Pending: ${this.pendingCredit}`);
    this._onCredit = handler;
    if (handler && this.pendingCredit > 0) {
      console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] Flushing pending credit: ${this.pendingCredit}`);
      handler(this.pendingCredit);
      this.pendingCredit = 0;
    }
  }
  get onCredit() {
    return this._onCredit;
  }
  get readyState() {
    return this.channel.readyState;
  }
  get bufferedAmount() {
    return this.channel.bufferedAmount;
  }
  get underlyingChannel() {
    return this.channel;
  }
  sendData(data) {
    if (this.channel.readyState !== "open") {
      console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Attempted sendData on non-open channel (${this.channel.readyState})`);
      return;
    }
    const frame = new Uint8Array(1 + data.byteLength);
    frame[0] = MSG_TYPE_DATA;
    frame.set(data, 1);
    try {
      this.channel.send(frame);
    } catch (e) {
      console.error(`[DataChannelController:${this.channel.id}:${this.instanceId}] sendData failed`, e);
      throw e;
    }
  }
  sendCredit(amount) {
    if (this.channel.readyState !== "open") {
      console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Attempted sendCredit on non-open channel (${this.channel.readyState})`);
      return;
    }
    const frame = new Uint8Array(1 + 4);
    frame[0] = MSG_TYPE_CREDIT;
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    view.setUint32(1, amount, true);
    try {
      this.channel.send(frame);
    } catch (e) {
      console.error(`[DataChannelController:${this.channel.id}:${this.instanceId}] sendCredit failed`, e);
    }
  }
  close() {
    this.channel.close();
  }
  handleMessage(event) {
    const data = event.data;
    if (data instanceof ArrayBuffer) {
      this.processBuffer(new Uint8Array(data));
    } else if (data instanceof Uint8Array) {
      this.processBuffer(data);
    } else {
      console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Received non-binary data, ignoring.`);
    }
  }
  processBuffer(buffer) {
    if (buffer.byteLength < 1) return;
    const type = buffer[0];
    if (type === MSG_TYPE_DATA) {
      if (this.onData) {
        this.onData(buffer.subarray(1));
      } else {
        console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] No onData handler!`);
      }
    } else if (type === MSG_TYPE_CREDIT) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const credit = view.getUint32(1, true);
      console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] CREDIT frame. Amount: ${credit}`);
      if (buffer.byteLength >= 5) {
        if (this._onCredit) {
          this._onCredit(credit);
        } else {
          console.log(`[DataChannelController:${this.channel.id}:${this.instanceId}] No onCredit handler! Buffering: ${credit}`);
          this.pendingCredit += credit;
        }
      }
    } else {
      console.warn(`[DataChannelController:${this.channel.id}:${this.instanceId}] Unknown message type:`, type);
    }
  }
};

// src/datachannelstream/streams/sendStream.ts
var SendStream = class {
  constructor(channelOrController, highWaterMark = 64 * 1024) {
    this.highWaterMark = highWaterMark;
    this.sendWindow = 0;
    // Initial window is 0, waiting for grant? Or start with some?
    // Plan said: "Initial window: determined by config (e.g., 64KB? or 0 and wait for initial grant?)."
    // To match common behavior, maybe start with 0 and wait for receiver to say "I'm ready"?
    // Or assume receiver starts with some buffer?
    // Let's assume 0 and wait for initial credit from Receiver (who sends it on start).
    this.creditResolvers = [];
    this.maxChunkSize = 16 * 1024;
    if ("sendCredit" in channelOrController && typeof channelOrController.sendCredit === "function") {
      this.controller = channelOrController;
    } else {
      this.controller = new DataChannelController(channelOrController);
    }
    this.controller.onCredit = (amount) => {
      console.log(`[SendStream] Received credit: ${amount}. Current Window: ${this.sendWindow} -> ${this.sendWindow + amount}`);
      this.sendWindow += amount;
      this.processPendingWrites();
    };
    this.stream = new WritableStream({
      write: this.writeChunk.bind(this),
      close: async () => {
        if (this.controller.bufferedAmount > 0) {
          await this.waitForBufferedAmountLow();
        }
        await new Promise((r) => setTimeout(r, 100));
        this.controller.close();
      },
      abort: () => {
        this.controller.close();
      }
    });
  }
  get writable() {
    return this.stream;
  }
  async write(data) {
    if (!this.writer) {
      this.writer = this.stream.getWriter();
    }
    return this.writer.write(data);
  }
  async close() {
    if (!this.writer) {
      if (this.stream.locked) {
        return;
      }
      this.writer = this.stream.getWriter();
    }
    return this.writer.close();
  }
  // 16KB MTU limit
  async writeChunk(chunk) {
    if (this.controller.readyState !== "open") {
      await new Promise((resolve, reject) => {
        if (this.controller.readyState === "open") return resolve();
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (_e) => {
          cleanup();
          reject(new Error("DataChannel error during wait for open"));
        };
        const onClose = () => {
          cleanup();
          reject(new Error("DataChannel closed before open"));
        };
        const cleanup = () => {
          this.controller.underlyingChannel.removeEventListener("open", onOpen);
          this.controller.underlyingChannel.removeEventListener("error", onError);
          this.controller.underlyingChannel.removeEventListener("close", onClose);
        };
        this.controller.underlyingChannel.addEventListener("open", onOpen);
        this.controller.underlyingChannel.addEventListener("error", onError);
        this.controller.underlyingChannel.addEventListener("close", onClose);
      });
    }
    let offset = 0;
    while (offset < chunk.byteLength) {
      const remaining = chunk.byteLength - offset;
      while (this.sendWindow === 0) {
        console.log(`[SendStream] Waiting for credit. Needed > 0, Current: ${this.sendWindow}`);
        await this.waitForCredit();
      }
      const toSendSize = Math.min(remaining, this.sendWindow, this.maxChunkSize);
      const slice = chunk.subarray(offset, offset + toSendSize);
      if (this.controller.bufferedAmount > this.highWaterMark) {
        await this.waitForBufferedAmountLow();
      }
      try {
        this.controller.sendData(slice);
        this.sendWindow -= toSendSize;
        offset += toSendSize;
        console.log(`[SendStream] Sent fragment ${toSendSize} bytes. Offset: ${offset}/${chunk.byteLength}`);
      } catch (error) {
        console.error("SendStream failed to send:", error);
        throw error;
      }
    }
  }
  waitForCredit() {
    return new Promise((resolve) => {
      this.creditResolvers.push(resolve);
    });
  }
  processPendingWrites() {
    while (this.creditResolvers.length > 0 && this.sendWindow > 0) {
      const resolver = this.creditResolvers.shift();
      if (resolver) resolver();
    }
  }
  waitForBufferedAmountLow() {
    return new Promise((resolve) => {
      const handler = () => {
        this.controller.underlyingChannel.removeEventListener("bufferedamountlow", handler);
        resolve();
      };
      this.controller.underlyingChannel.addEventListener("bufferedamountlow", handler);
    });
  }
};

// src/datachannelstream/streams/receiveStream.ts
var ReceiveStream = class {
  // 64KB
  constructor(channelOrController) {
    this.unacknowledgedBytes = 0;
    this.initialCredit = 64 * 1024;
    if ("sendCredit" in channelOrController && typeof channelOrController.sendCredit === "function") {
      this.controller = channelOrController;
    } else {
      this.controller = new DataChannelController(channelOrController);
    }
    this.stream = new ReadableStream({
      start: (controller) => {
        const init = () => {
          this.controller.sendCredit(this.initialCredit);
          console.log(`[ReceiveStream] Sent initial credit: ${this.initialCredit}`);
          this.controller.onData = (data) => {
            controller.enqueue(data);
            this.unacknowledgedBytes += data.byteLength;
            if (controller.desiredSize !== null && controller.desiredSize > 0) {
              this.flushCredits();
            }
          };
        };
        if (this.controller.readyState === "open") {
          init();
        } else {
          const onOpen = () => {
            this.controller.underlyingChannel.removeEventListener("open", onOpen);
            init();
          };
          this.controller.underlyingChannel.addEventListener("open", onOpen);
        }
        this.controller.underlyingChannel.onclose = () => {
          console.log("channel close");
          try {
            controller.close();
          } catch (e) {
          }
        };
        this.controller.underlyingChannel.onerror = (event) => {
          const err = event instanceof ErrorEvent ? event.error : event;
          if (err && err.name === "OperationError") {
            console.warn("[ReceiveStream] Ignoring OperationError on DataChannel (likely close race).", err);
            return;
          }
          try {
            controller.error(err || new Error("RTCDataChannel error"));
          } catch (e) {
          }
        };
        this.controller.underlyingChannel.addEventListener("open", () => console.log("channel open"));
      },
      pull: (_controller) => {
        this.flushCredits();
      },
      cancel: () => {
        this.controller.close();
      }
    }, {
      highWaterMark: this.initialCredit
      // Match HWM to our credit window logic
    });
  }
  flushCredits() {
    if (this.unacknowledgedBytes > 0) {
      console.log(`[ReceiveStream] Flushing credits: ${this.unacknowledgedBytes}`);
      this.controller.sendCredit(this.unacknowledgedBytes);
      this.unacknowledgedBytes = 0;
    }
  }
  get readable() {
    return this.stream;
  }
};

// src/rtcfetcher/utils/msgpack-codec.ts
var import_msgpack = require("@msgpack/msgpack");

// src/rtcfetcher/types/stream-ref.ts
var StreamRef = class {
  constructor(id) {
    this.id = id;
  }
};

// src/rtcfetcher/utils/msgpack-codec.ts
var HEADERS_EXT_TYPE = 1;
var STREAM_REF_EXT_TYPE = 2;
var MsgPackCodec = class {
  constructor() {
    this.extensionCodec = new import_msgpack.ExtensionCodec();
    this.initializeExtensions();
  }
  initializeExtensions() {
    this.extensionCodec.register({
      type: HEADERS_EXT_TYPE,
      encode: (object) => {
        if (object instanceof Headers) {
          const entries = [];
          object.forEach((value, key) => {
            entries.push([key, value]);
          });
          return (0, import_msgpack.encode)(entries);
        }
        return null;
      },
      decode: (data) => {
        const entries = (0, import_msgpack.decode)(data);
        const headers = new Headers();
        for (const [key, value] of entries) {
          headers.append(key, value);
        }
        return headers;
      }
    });
    this.extensionCodec.register({
      type: STREAM_REF_EXT_TYPE,
      encode: (object) => {
        if (object instanceof StreamRef) {
          return (0, import_msgpack.encode)(object.id);
        }
        return null;
      },
      decode: (data) => {
        const id = (0, import_msgpack.decode)(data);
        return new StreamRef(id);
      }
    });
  }
  encode(data) {
    try {
      return (0, import_msgpack.encode)(data, { extensionCodec: this.extensionCodec });
    } catch (error) {
      throw new RTCSerializationError("Failed to encode data with MessagePack", error);
    }
  }
  decode(data) {
    try {
      return (0, import_msgpack.decode)(data, { extensionCodec: this.extensionCodec });
    } catch (error) {
      throw new RTCSerializationError("Failed to decode MessagePack data", error);
    }
  }
};
var msgpackCodec = new MsgPackCodec();

// src/rtcfetcher/core/rtc-response.ts
var RTCResponse = class {
  constructor(body, streamReplacer) {
    this._body = body;
    this._streamReplacer = streamReplacer;
  }
  get ok() {
    return true;
  }
  async json() {
    return this.processBody(this._body);
  }
  async text() {
    const processed = await this.processBody(this._body);
    if (typeof processed === "string") return processed;
    return JSON.stringify(processed);
  }
  async blob() {
    const processed = await this.processBody(this._body);
    if (processed instanceof Blob) return processed;
    if (processed instanceof Uint8Array) return new Blob([processed]);
    if (processed instanceof ArrayBuffer) return new Blob([processed]);
    throw new Error("Body is not a Blob or binary data");
  }
  // Recursively replace StreamRef with actual ReadableStreams
  async processBody(obj) {
    if (obj instanceof StreamRef) {
      const stream = this._streamReplacer(obj);
      if (!stream) throw new Error(`Stream ID ${obj.id} not found`);
      return stream;
    }
    if (Array.isArray(obj)) {
      return Promise.all(obj.map((item) => this.processBody(item)));
    }
    if (obj && typeof obj === "object") {
      if (obj instanceof Blob || obj instanceof ArrayBuffer || obj instanceof Uint8Array) {
        return obj;
      }
      const newObj = {};
      for (const key in obj) {
        newObj[key] = await this.processBody(obj[key]);
      }
      return newObj;
    }
    return obj;
  }
};

// src/rtcfetcher/utils/stream-traversal.ts
var THRESHOLD = 16 * 1024;
async function traverseAndOptimizeStreams(obj, replacer) {
  if (obj instanceof ReadableStream) {
    return replacer(obj);
  }
  if (typeof Blob !== "undefined" && obj instanceof Blob) {
    if (obj.size > THRESHOLD) {
      return replacer(obj.stream());
    }
    return obj;
  }
  if (obj instanceof Uint8Array) {
    if (obj.byteLength > THRESHOLD) {
      return replacer(uint8ArrayToStream(obj));
    }
    return obj;
  }
  if (obj instanceof ArrayBuffer) {
    if (obj.byteLength > THRESHOLD) {
      return replacer(uint8ArrayToStream(new Uint8Array(obj)));
    }
    return obj;
  }
  if (typeof obj === "string") {
    if (obj.length > THRESHOLD) {
      return replacer(stringToStream(obj));
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    return Promise.all(obj.map((item) => traverseAndOptimizeStreams(item, replacer)));
  }
  if (obj && typeof obj === "object") {
    const newObj = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        newObj[key] = await traverseAndOptimizeStreams(obj[key], replacer);
      }
    }
    return newObj;
  }
  return obj;
}
function uint8ArrayToStream(data) {
  return new ReadableStream({
    start(controller) {
      const chunkSize = 16 * 1024;
      for (let i = 0; i < data.byteLength; i += chunkSize) {
        controller.enqueue(data.subarray(i, i + chunkSize));
      }
      controller.close();
    }
  });
}
function stringToStream(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  return uint8ArrayToStream(data);
}

// src/rtcfetcher/core/rtcfetcher.ts
var RTCFetcher = class {
  constructor(pc, config) {
    this.pc = pc;
    // Cache reserved channels (streams) to avoid collisions
    this.reservedChannels = /* @__PURE__ */ new Map();
    this.config = config || {};
    this.masterChannel = pc.createDataChannel("rtc-fetcher-master", { negotiated: true, id: 0 });
    this.negotiator = new Negotiator(this.masterChannel, pc);
    this.incomingRequests = new ReadableStream({
      start: (controller) => {
        this.incomingRequestsController = controller;
      }
    });
    this.negotiator.onReserved = (id, channel, label) => this.handleReservedChannel(id, channel, label);
    this.opened = new Promise((resolve) => {
      const checkOpen = () => {
        if (this.masterChannel.readyState === "open") {
          resolve();
          return true;
        }
        return false;
      };
      if (!checkOpen()) {
        this.masterChannel.onopen = () => checkOpen();
      }
    });
  }
  handleReservedChannel(id, existingChannel, label) {
    try {
      if (label && (label === "stream" || label === "res-stream")) {
        if (existingChannel) {
          console.log(`[RTCFetcher] Storing reserved channel for ID ${id} (Label: ${label})`);
          this.reservedChannels.set(id, existingChannel);
        } else {
          console.warn(`[RTCFetcher] Stream ID ${id} reserved but no existing channel passed! (Label: ${label})`);
        }
        return;
      }
      console.log("Reserved ID:", id);
      const channel = existingChannel || this.pc.createDataChannel("rtc-fetcher-req", { negotiated: true, id });
      console.log("Created/Reused channel:", channel.id);
      const controller = new DataChannelController(channel);
      const receiveStream = new ReceiveStream(controller);
      this.processIncomingMessage(receiveStream.readable, controller);
    } catch (e) {
      console.error("Error handling reserved channel:", e);
    }
  }
  async processIncomingMessage(stream, controller) {
    const info = await this.bufferAndDecode(stream);
    if (!info) return;
    const { label, body } = info;
    const processedBody = await this.processedIncomingBody(body);
    const req = {
      endpoint: label,
      // We use endpoint property in IncomingRequest interface
      // We match IncomingRequest interface from src/rtcfetcher/types/message.ts?
      // "open(): Promise<{ req: object, res: { send } }>"
      open: async () => {
        return {
          req: { label, body: processedBody },
          // Adjust structure as needed
          res: {
            send: (responseData) => {
              this.sendResponse(controller, responseData);
            },
            close: () => {
              controller.close();
            }
          }
        };
      },
      reject: (_reason) => {
        controller.close();
      }
    };
    if (this.incomingRequestsController) {
      this.incomingRequestsController.enqueue(req);
    }
  }
  async sendResponse(controller, data) {
    const streams = /* @__PURE__ */ new Map();
    const excludedIds = /* @__PURE__ */ new Set();
    if (controller.underlyingChannel.id !== null) {
      excludedIds.add(controller.underlyingChannel.id);
    }
    const processed = await this.traverseAndExtractStreams(data, async (stream) => {
      const id = await this.negotiator.reserveId("res-stream", excludedIds);
      excludedIds.add(id);
      streams.set(id, stream);
      return new StreamRef(id);
    });
    const encoded = msgpackCodec.encode(processed);
    const sendStream = new SendStream(controller, this.config.minBufferSize);
    const streamReadyPromises = [];
    streams.forEach((stream, id) => {
      const sChannel = this.pc.createDataChannel("res-stream", { negotiated: true, id });
      const sStream = new SendStream(sChannel, this.config.minBufferSize);
      stream.pipeTo(sStream.writable).catch((e) => console.error(e));
      streamReadyPromises.push(this.negotiator.sendReady(id));
    });
    await Promise.all(streamReadyPromises);
    try {
      const lenBytes = new Uint8Array(4);
      new DataView(lenBytes.buffer).setUint32(0, encoded.byteLength, true);
      await sendStream.write(lenBytes);
      await sendStream.write(encoded);
    } catch (e) {
      console.error("Error sending response:", e);
    }
  }
  async processedIncomingBody(obj) {
    if (obj instanceof StreamRef) {
      return new ReadableStream({
        start: (controller) => {
          const channel = this.getOrOpenChannel(obj.id);
          const s = new ReceiveStream(channel);
          s.readable.pipeTo(new WritableStream({
            write: (c) => controller.enqueue(c),
            close: () => controller.close(),
            abort: (e) => controller.error(e)
          }));
        }
      });
    }
    if (Array.isArray(obj)) return Promise.all(obj.map((o) => this.processedIncomingBody(o)));
    if (obj && typeof obj === "object") {
      if (obj instanceof Blob || obj instanceof Uint8Array || obj instanceof ArrayBuffer) return obj;
      const newObj = {};
      for (const k in obj) newObj[k] = await this.processedIncomingBody(obj[k]);
      return newObj;
    }
    return obj;
  }
  getOrOpenChannel(id) {
    if (this.reservedChannels.has(id)) {
      console.log(`[RTCFetcher] getOrOpenChannel Hit: Reusing reserved channel for ID ${id}`);
      const channel = this.reservedChannels.get(id);
      this.reservedChannels.delete(id);
      return channel;
    }
    console.log(`[RTCFetcher] getOrOpenChannel Miss: Creating new channel for ID ${id}`);
    return this.pc.createDataChannel("stream", { negotiated: true, id });
  }
  async bufferAndDecode(stream) {
    const reader = stream.getReader();
    const readExact = async (n) => {
      const buf = new Uint8Array(n);
      let offset = 0;
      while (offset < n) {
        const { done, value } = await reader.read();
        if (done) return null;
        const needed = n - offset;
        const take = Math.min(needed, value.byteLength);
        buf.set(value.subarray(0, take), offset);
        offset += take;
        if (value.byteLength > take) {
          console.warn("Excess data in Request Channel");
        }
      }
      return buf;
    };
    try {
      const header = await readExact(4);
      if (!header) return null;
      const len = new DataView(header.buffer).getUint32(0, true);
      const bodyBytes = await readExact(len);
      if (!bodyBytes) return null;
      const decoded = msgpackCodec.decode(bodyBytes);
      if (decoded && typeof decoded === "object" && "label" in decoded) {
        return decoded;
      }
    } catch (e) {
      console.error("Error bufferAndDecode:", e);
      return null;
    } finally {
      reader.releaseLock();
    }
    return null;
  }
  async fetch(label, body, _options) {
    await this.opened;
    const reservedId = await this.negotiator.findUnusedId();
    const streams = /* @__PURE__ */ new Map();
    const streamCache = /* @__PURE__ */ new Map();
    const excludedIds = /* @__PURE__ */ new Set([reservedId]);
    const processedBody = await this.traverseAndExtractStreams(body, async (stream) => {
      if (streamCache.has(stream)) return streamCache.get(stream);
      const streamId = await this.negotiator.reserveId("stream", excludedIds);
      excludedIds.add(streamId);
      streams.set(streamId, stream);
      const ref = new StreamRef(streamId);
      streamCache.set(stream, ref);
      return ref;
    });
    await this.negotiator.performHandshake(reservedId, "req::" + label);
    console.log("Reserved ID (Local):", reservedId);
    const mainChannel = this.pc.createDataChannel(label, { negotiated: true, id: reservedId });
    const controller = new DataChannelController(mainChannel);
    const responseReader = new ReceiveStream(controller);
    const sendStream = new SendStream(controller, this.config.minBufferSize);
    await this.negotiator.sendReady(reservedId);
    const encoded = msgpackCodec.encode({ label, body: processedBody });
    if (controller.readyState !== "open") {
      await new Promise((resolve, reject) => {
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onError = (_e) => {
          cleanup();
          reject(new Error("DataChannel error while waiting for open"));
        };
        const cleanup = () => {
          controller.underlyingChannel.removeEventListener("open", onOpen);
          controller.underlyingChannel.removeEventListener("error", onError);
        };
        controller.underlyingChannel.addEventListener("open", onOpen);
        controller.underlyingChannel.addEventListener("error", onError);
      });
    }
    const streamReadyPromises = [];
    streams.forEach((stream, id) => {
      const channel = this.pc.createDataChannel("stream", { negotiated: true, id });
      const sStream = new SendStream(channel, this.config.minBufferSize);
      stream.pipeTo(sStream.writable).catch((e) => console.error(e));
      streamReadyPromises.push(this.negotiator.sendReady(id));
    });
    await Promise.all(streamReadyPromises);
    try {
      const lenBytes = new Uint8Array(4);
      new DataView(lenBytes.buffer).setUint32(0, encoded.byteLength, true);
      await sendStream.write(lenBytes);
      await sendStream.write(encoded);
    } catch (e) {
      controller.close();
      throw e;
    }
    return new Promise((resolve, reject) => {
      const reader = responseReader.readable.getReader();
      const readExact = async (n) => {
        const buf = new Uint8Array(n);
        let offset = 0;
        while (offset < n) {
          const { done, value } = await reader.read();
          if (done) throw new Error("Unexpected EOF reading response");
          const needed = n - offset;
          const take = Math.min(needed, value.byteLength);
          buf.set(value.subarray(0, take), offset);
          offset += take;
          if (value.byteLength > take) console.warn("Excess data in response channel");
        }
        return buf;
      };
      (async () => {
        try {
          const lenBuf = await readExact(4);
          const len = new DataView(lenBuf.buffer).getUint32(0, true);
          const bodyBuf = await readExact(len);
          const resData = msgpackCodec.decode(bodyBuf);
          resolve(new RTCResponse(resData, (ref) => {
            return new ReadableStream({
              start: (c) => {
                const ch = this.getOrOpenChannel(ref.id);
                const rs = new ReceiveStream(ch);
                rs.readable.pipeTo(new WritableStream({
                  write: (x) => c.enqueue(x),
                  close: () => c.close(),
                  abort: (e) => c.error(e)
                }));
              }
            });
          }));
        } catch (e) {
          reject(e);
        } finally {
          reader.releaseLock();
        }
      })();
    });
  }
  async traverseAndExtractStreams(obj, replacer) {
    return traverseAndOptimizeStreams(obj, replacer);
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Negotiator,
  RTCConnectionError,
  RTCFetcher,
  RTCFetcherError,
  RTCResponse,
  RTCSerializationError,
  RTCTimeoutError,
  ReceiveStream,
  SendStream,
  msgpackCodec
});
