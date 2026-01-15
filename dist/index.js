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
    this.setupSignalingChannel();
  }
  /**
   * Reserve a new DataChannel ID.
   * Uses getStats to find an unused ID, then performs a handshake with the peer.
   */
  async reserveId(label) {
    let attempts = 0;
    const maxAttempts = 5;
    while (attempts < maxAttempts) {
      attempts++;
      const candidateId = await this.findUnusedId();
      try {
        await this.performHandshake(candidateId);
        return candidateId;
      } catch (error) {
        console.warn(`ID reservation failed for ${candidateId}, retrying...`, error);
        continue;
      }
    }
    throw new RTCFetcherError("Failed to negotiate DataChannel ID after multiple attempts", "NEGOTIATION_FAILED");
  }
  async performHandshake(id) {
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
      this.send({ type: "RESERVE", id });
    });
  }
  async handleReserveRequest(message) {
    const id = message.id;
    const isUsed = await this.isIdUsed(id);
    if (isUsed) {
      this.send({ type: "NACK", id });
    } else {
      this.send({ type: "ACK", id });
      if (this.onReserved) {
        this.onReserved(id);
      }
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
  async findUnusedId() {
    const usedIds = await this.getUsedIds();
    let candidate = -1;
    for (let i = 0; i < 100; i++) {
      const rand = Math.floor(Math.random() * _Negotiator.MAX_CHANNEL_ID);
      if (rand !== _Negotiator.SIGNALING_CHANNEL_ID && !usedIds.has(rand)) {
        candidate = rand;
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
_Negotiator.SIGNALING_CHANNEL_ID = 255;
_Negotiator.MAX_CHANNEL_ID = 65534;
var Negotiator = _Negotiator;

// src/datachannelstream/streams/sendStream.ts
var SendStream = class {
  constructor(channel, highWaterMark = 64 * 1024) {
    this.channel = channel;
    this.highWaterMark = highWaterMark;
    this.stream = new WritableStream({
      write: this.writeChunk.bind(this),
      close: () => channel.close(),
      abort: () => channel.close()
    });
    this.writer = this.stream.getWriter();
  }
  get writable() {
    return this.stream;
  }
  async write(data) {
    return this.writer.write(data);
  }
  async close() {
    return this.writer.close();
  }
  async writeChunk(chunk) {
    if (this.channel.readyState !== "open") {
      throw new Error("DataChannel is not open");
    }
    if (this.channel.bufferedAmount > this.highWaterMark) {
      await this.waitForBufferedAmountLow();
    }
    try {
      this.channel.send(chunk);
    } catch (error) {
      console.error("SendStream failed to send:", error);
      throw error;
    }
  }
  waitForBufferedAmountLow() {
    return new Promise((resolve) => {
      const handler = () => {
        this.channel.removeEventListener("bufferedamountlow", handler);
        resolve();
      };
      this.channel.addEventListener("bufferedamountlow", handler);
    });
  }
};

// src/datachannelstream/streams/receiveStream.ts
var ReceiveStream = class {
  constructor(channel) {
    this.channel = channel;
    this.stream = new ReadableStream({
      start: (controller) => {
        this.channel.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            controller.enqueue(new Uint8Array(event.data));
          } else if (event.data instanceof Uint8Array) {
            controller.enqueue(event.data);
          } else {
          }
        };
        this.channel.onclose = () => controller.close();
        this.channel.onerror = (err) => controller.error(err);
      },
      cancel: () => {
        this.channel.close();
      }
    });
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

// src/rtcfetcher/core/rtcfetcher.ts
var RTCFetcher = class {
  constructor(pc, config) {
    this.pc = pc;
    this.config = config || {};
    this.masterChannel = pc.createDataChannel("rtc-fetcher-master", { negotiated: true, id: 255 });
    this.negotiator = new Negotiator(this.masterChannel, pc);
    this.incomingRequests = new ReadableStream({
      start: (controller) => {
        this.incomingRequestsController = controller;
      }
    });
    this.negotiator.onReserved = (id) => this.handleReservedChannel(id);
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
  get closed() {
    return new Promise((resolve) => {
    });
  }
  handleReservedChannel(id) {
    try {
      const channel = this.pc.createDataChannel("rtc-fetcher-req", { negotiated: true, id });
      const receiveStream = new ReceiveStream(channel);
      this.processIncomingMessage(receiveStream.readable, channel);
    } catch (e) {
      console.error("Error handling reserved channel:", e);
    }
  }
  async processIncomingMessage(stream, channel) {
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
              this.sendResponse(channel, responseData);
            },
            close: () => {
              channel.close();
            }
          }
        };
      },
      reject: (reason) => {
        channel.close();
      }
    };
    if (this.incomingRequestsController) {
      this.incomingRequestsController.enqueue(req);
    }
  }
  async sendResponse(channel, data) {
    const streams = /* @__PURE__ */ new Map();
    const processed = await this.traverseAndExtractStreams(data, async (stream) => {
      const id = await this.negotiator.reserveId("res-stream");
      streams.set(id, stream);
      return new StreamRef(id);
    });
    const encoded = msgpackCodec.encode(processed);
    const sendStream = new SendStream(channel, this.config.minBufferSize);
    streams.forEach((stream, id) => {
      const sChannel = this.pc.createDataChannel("res-stream", { negotiated: true, id });
      const sStream = new SendStream(sChannel, this.config.minBufferSize);
      stream.pipeTo(sStream.writable).catch((e) => console.error(e));
    });
    await sendStream.write(encoded);
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
      if (obj instanceof Blob || obj instanceof Uint8Array) return obj;
      const res = {};
      for (const k in obj) res[k] = await this.processedIncomingBody(obj[k]);
      return res;
    }
    return obj;
  }
  getOrOpenChannel(id) {
    return this.pc.createDataChannel("stream", { negotiated: true, id });
  }
  async bufferAndDecode(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let totalLen = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLen += value.byteLength;
      }
    } catch (e) {
      console.error(e);
      return null;
    }
    if (totalLen === 0) return null;
    const combined = new Uint8Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }
    try {
      const decoded = msgpackCodec.decode(combined);
      if (decoded && typeof decoded === "object" && "label" in decoded) {
        return decoded;
      }
    } catch (e) {
    }
    return null;
  }
  // FETCH METHOD IMPLEMENTATION REVISITED
  async fetch(label, body, options) {
    await this.opened;
    const reservedId = await this.negotiator.reserveId("req::" + label);
    const streams = /* @__PURE__ */ new Map();
    const processedBody = await this.traverseAndExtractStreams(body, async (stream) => {
      const streamId = await this.negotiator.reserveId("stream");
      streams.set(streamId, stream);
      return new StreamRef(streamId);
    });
    const encoded = msgpackCodec.encode({ label, body: processedBody });
    const mainChannel = this.pc.createDataChannel(label, { negotiated: true, id: reservedId });
    const sendStream = new SendStream(mainChannel, this.config.minBufferSize);
    streams.forEach((stream, id) => {
      const channel = this.pc.createDataChannel("stream", { negotiated: true, id });
      const sStream = new SendStream(channel, this.config.minBufferSize);
      stream.pipeTo(sStream.writable).catch((e) => console.error(e));
    });
    try {
      await sendStream.write(encoded);
      await sendStream.close();
    } catch (e) {
      mainChannel.close();
      throw e;
    }
    return new Promise((resolve, reject) => {
      const responseReader = new ReceiveStream(mainChannel);
      const reader = responseReader.readable.getReader();
      const chunks = [];
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (value) chunks.push(value);
            try {
              const total = chunks.reduce((a, c) => a + c.byteLength, 0);
              const buf = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                buf.set(c, off);
                off += c.byteLength;
              }
              const resData = msgpackCodec.decode(buf);
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
              return;
            } catch (e) {
            }
            if (done) break;
          }
        } catch (e) {
          reject(e);
        }
      })();
    });
  }
  async traverseAndExtractStreams(obj, replacer) {
    if (obj instanceof ReadableStream) {
      return replacer(obj);
    }
    if (Array.isArray(obj)) {
      return Promise.all(obj.map((item) => this.traverseAndExtractStreams(item, replacer)));
    }
    if (obj && typeof obj === "object") {
      if (obj instanceof Blob || obj instanceof Uint8Array || obj instanceof ArrayBuffer) return obj;
      const newObj = {};
      for (const key in obj) {
        newObj[key] = await this.traverseAndExtractStreams(obj[key], replacer);
      }
      return newObj;
    }
    return obj;
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
