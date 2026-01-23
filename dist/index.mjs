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
  async sendReady(id, label) {
    this.send({ type: "READY", id, label });
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
        const finalLabel = message.label || waiting.label;
        this.onReserved(id, waiting.channel, finalLabel);
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
    let limit = max && max > 0 ? max : 256;
    console.log(`[Negotiator] findUnusedId. Detected max: ${max}, Using limit: ${255}`);
    if (limit > 255) limit = 255;
    const start = Math.floor(Math.random() * (limit - 1)) + 1;
    let candidate = -1;
    for (let offset = 0; offset < limit - 1; offset++) {
      let i = start + offset;
      if (i >= limit) i -= limit - 1;
      const rangeSize = limit - 1;
      const zeroBased = (start - 1 + offset) % rangeSize;
      i = zeroBased + 1;
      if (i === _Negotiator.SIGNALING_CHANNEL_ID) continue;
      if (!usedIds.has(i) && !excludedIds?.has(i)) {
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

// src/rtcfetcher/qpack/utils.ts
function encodeInt(value, prefixBits) {
  const max = (1 << prefixBits) - 1;
  if (value < max) return [value];
  const bytes = [max];
  value -= max;
  while (value >= 128) {
    bytes.push(value & 127 | 128);
    value >>= 7;
  }
  bytes.push(value);
  return bytes;
}
function decodeVarInt(buf, prefixBits, pos) {
  const maxPrefix = (1 << prefixBits) - 1;
  let byte = buf[pos];
  let value = byte & maxPrefix;
  pos++;
  if (value < maxPrefix) {
    return { value, next: pos };
  }
  let m = 0;
  while (true) {
    if (pos >= buf.length) throw new Error("Incomplete integer encoding");
    byte = buf[pos++];
    value += (byte & 127) << m;
    if ((byte & 128) === 0) break;
    m += 7;
  }
  return { value, next: pos };
}

// src/rtcfetcher/qpack/huffman.ts
var huffman_codes = new Uint32Array([
  8184,
  //(0)
  8388568,
  //(1)
  268435426,
  //(2)
  268435427,
  //(3)
  268435428,
  //(4)
  268435429,
  //(5)
  268435430,
  //(6)
  268435431,
  //(7)
  268435432,
  //(8)
  16777194,
  //(9)
  1073741820,
  //(10)
  268435433,
  //(11)
  268435434,
  //(12)
  1073741821,
  //(13)
  268435435,
  //(14)
  268435436,
  //(15)
  268435437,
  //(16)
  268435438,
  //(17)
  268435439,
  //(18)
  268435440,
  //(19)
  268435441,
  //(20)
  268435442,
  //(21)
  1073741822,
  //(22)
  268435443,
  //(23)
  268435444,
  //(24)
  268435445,
  //(25)
  268435446,
  //(26)
  268435447,
  //(27)
  268435448,
  //(28)
  268435449,
  //(29)
  268435450,
  //(30)
  268435451,
  //(31)
  20,
  //' ' (32)
  1016,
  //'!' (33)
  1017,
  //'"' (34)
  4090,
  //'#' (35)
  8185,
  //'$' (36)
  21,
  //'%' (37)
  248,
  //'&' (38)
  2042,
  //''' (39)
  1018,
  //'(' (40)
  1019,
  //')' (41)
  249,
  //'*' (42)
  2043,
  //'+' (43)
  250,
  //',' (44)
  22,
  //'-' (45)
  23,
  //'.' (46)
  24,
  //'/' (47)
  0,
  //'0' (48)
  1,
  //'1' (49)
  2,
  //'2' (50)
  25,
  //'3' (51)
  26,
  //'4' (52)
  27,
  //'5' (53)
  28,
  //'6' (54)
  29,
  //'7' (55)
  30,
  //'8' (56)
  31,
  //'9' (57)
  92,
  //':' (58)
  251,
  //';' (59)
  32764,
  //'<' (60)
  32,
  //'=' (61)
  4091,
  //'>' (62)
  1020,
  //'?' (63)
  8186,
  //'@' (64)
  33,
  //'A' (65)
  93,
  //'B' (66)
  94,
  //'C' (67)
  95,
  //'D' (68)
  96,
  //'E' (69)
  97,
  //'F' (70)
  98,
  //'G' (71)
  99,
  //'H' (72)
  100,
  //'I' (73)
  101,
  //'J' (74)
  102,
  //'K' (75)
  103,
  //'L' (76)
  104,
  //'M' (77)
  105,
  //'N' (78)
  106,
  //'O' (79)
  107,
  //'P' (80)
  108,
  //'Q' (81)
  109,
  //'R' (82)
  110,
  //'S' (83)
  111,
  //'T' (84)
  112,
  //'U' (85)
  113,
  //'V' (86)
  114,
  //'W' (87)
  252,
  //'X' (88)
  115,
  //'Y' (89)
  253,
  //'Z' (90)
  8187,
  //'[' (91)
  524272,
  //'\' (92)
  8188,
  //']' (93)
  16380,
  //'^' (94)
  34,
  //'_' (95)
  32765,
  //'`' (96)
  3,
  //'a' (97)
  35,
  //'b' (98)
  4,
  //'c' (99)
  36,
  //'d' (100)
  5,
  //'e' (101)
  37,
  //'f' (102)
  38,
  //'g' (103)
  39,
  //'h' (104)
  6,
  //'i' (105)
  116,
  //'j' (106)
  117,
  //'k' (107)
  40,
  //'l' (108)
  41,
  //'m' (109)
  42,
  //'n' (110)
  7,
  //'o' (111)
  43,
  //'p' (112)
  118,
  //'q' (113)
  44,
  //'r' (114)
  8,
  //'s' (115)
  9,
  //'t' (116)
  45,
  //'u' (117)
  119,
  //'v' (118)
  120,
  //'w' (119)
  121,
  //'x' (120)
  122,
  //'y' (121)
  123,
  //'z' (122)
  32766,
  //'{' (123)
  2044,
  //'|' (124)
  16381,
  //'}' (125)
  8189,
  //'~' (126)
  268435452,
  //(127)
  1048550,
  //(128)
  4194258,
  //(129)
  1048551,
  //(130)
  1048552,
  //(131)
  4194259,
  //(132)
  4194260,
  //(133)
  4194261,
  //(134)
  8388569,
  //(135)
  4194262,
  //(136)
  8388570,
  //(137)
  8388571,
  //(138)
  8388572,
  //(139)
  8388573,
  //(140)
  8388574,
  //(141)
  16777195,
  //(142)
  8388575,
  //(143)
  16777196,
  //(144)
  16777197,
  //(145)
  4194263,
  //(146)
  8388576,
  //(147)
  16777198,
  //(148)
  8388577,
  //(149)
  8388578,
  //(150)
  8388579,
  //(151)
  8388580,
  //(152)
  2097116,
  //(153)
  4194264,
  //(154)
  8388581,
  //(155)
  4194265,
  //(156)
  8388582,
  //(157)
  8388583,
  //(158)
  16777199,
  //(159)
  4194266,
  //(160)
  2097117,
  //(161)
  1048553,
  //(162)
  4194267,
  //(163)
  4194268,
  //(164)
  8388584,
  //(165)
  8388585,
  //(166)
  2097118,
  //(167)
  8388586,
  //(168)
  4194269,
  //(169)
  4194270,
  //(170)
  16777200,
  //(171)
  2097119,
  //(172)
  4194271,
  //(173)
  8388587,
  //(174)
  8388588,
  //(175)
  2097120,
  //(176)
  2097121,
  //(177)
  4194272,
  //(178)
  2097122,
  //(179)
  8388589,
  //(180)
  4194273,
  //(181)
  8388590,
  //(182)
  8388591,
  //(183)
  1048554,
  //(184)
  4194274,
  //(185)
  4194275,
  //(186)
  4194276,
  //(187)
  8388592,
  //(188)
  4194277,
  //(189)
  4194278,
  //(190)
  8388593,
  //(191)
  67108832,
  //(192)
  67108833,
  //(193)
  1048555,
  //(194)
  524273,
  //(195)
  4194279,
  //(196)
  8388594,
  //(197)
  4194280,
  //(198)
  33554412,
  //(199)
  67108834,
  //(200)
  67108835,
  //(201)
  67108836,
  //(202)
  134217694,
  //(203)
  134217695,
  //(204)
  67108837,
  //(205)
  16777201,
  //(206)
  33554413,
  //(207)
  524274,
  //(208)
  2097123,
  //(209)
  67108838,
  //(210)
  134217696,
  //(211)
  134217697,
  //(212)
  67108839,
  //(213)
  134217698,
  //(214)
  16777202,
  //(215)
  2097124,
  //(216)
  2097125,
  //(217)
  67108840,
  //(218)
  67108841,
  //(219)
  268435453,
  //(220)
  134217699,
  //(221)
  134217700,
  //(222)
  134217701,
  //(223)
  1048556,
  //(224)
  16777203,
  //(225)
  1048557,
  //(226)
  2097126,
  //(227)
  4194281,
  //(228)
  2097127,
  //(229)
  2097128,
  //(230)
  8388595,
  //(231)
  4194282,
  //(232)
  4194283,
  //(233)
  33554414,
  //(234)
  33554415,
  //(235)
  16777204,
  //(236)
  16777205,
  //(237)
  67108842,
  //(238)
  8388596,
  //(239)
  67108843,
  //(240)
  134217702,
  //(241)
  67108844,
  //(242)
  67108845,
  //(243)
  134217703,
  //(244)
  134217704,
  //(245)
  134217705,
  //(246)
  134217706,
  //(247)
  134217707,
  //(248)
  268435454,
  //(249)
  134217708,
  //(250)
  134217709,
  //(251)
  134217710,
  //(252)
  134217711,
  //(253)
  134217712,
  //(254)
  67108846,
  //(255)
  1073741823
  //EOS (256)
]);
var huffman_bits = new Uint8Array([13, 23, 28, 28, 28, 28, 28, 28, 28, 24, 30, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 30, 28, 28, 28, 28, 28, 28, 28, 28, 28, 6, 10, 10, 12, 13, 6, 8, 11, 10, 10, 8, 11, 8, 6, 6, 6, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 7, 8, 15, 6, 12, 10, 13, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 8, 7, 8, 13, 19, 13, 14, 6, 15, 5, 6, 5, 6, 5, 6, 6, 6, 5, 7, 7, 6, 6, 6, 5, 6, 7, 6, 5, 5, 6, 7, 7, 7, 7, 7, 15, 11, 14, 13, 28, 20, 22, 20, 20, 22, 22, 22, 23, 22, 23, 23, 23, 23, 23, 24, 23, 24, 24, 22, 23, 24, 23, 23, 23, 23, 21, 22, 23, 22, 23, 23, 24, 22, 21, 20, 22, 22, 23, 23, 21, 23, 22, 22, 24, 21, 22, 23, 23, 21, 21, 22, 21, 23, 22, 23, 23, 20, 22, 22, 22, 23, 22, 22, 23, 26, 26, 20, 19, 22, 23, 22, 25, 26, 26, 26, 27, 27, 26, 24, 25, 19, 21, 26, 27, 27, 26, 27, 24, 21, 21, 26, 26, 28, 27, 27, 27, 20, 24, 20, 21, 22, 21, 21, 23, 22, 22, 25, 25, 24, 24, 26, 23, 26, 27, 26, 26, 27, 27, 27, 27, 27, 28, 27, 27, 27, 27, 27, 26, 30]);
function buildHuffmanDecodeTrie() {
  const root = {};
  for (let i = 0; i < huffman_codes.length; i++) {
    const code = huffman_codes[i];
    const length = huffman_bits[i];
    let node = root;
    for (let j = length - 1; j >= 0; j--) {
      const bit = code >> j & 1;
      if (!node[bit]) node[bit] = {};
      node = node[bit];
    }
    node.symbol = i;
  }
  return root;
}
var huffman_flat_decode_tables = buildHuffmanDecodeTrie();
function decodeHuffman(buf) {
  const output = [];
  let node = huffman_flat_decode_tables;
  let current = 0;
  let nbits = 0;
  for (let i = 0; i < buf.length; i++) {
    current = current << 8 | buf[i];
    nbits += 8;
    while (nbits > 0) {
      const bit = current >> nbits - 1 & 1;
      const nextNode = node[bit];
      if (!nextNode) throw new Error("Invalid Huffman encoding");
      node = nextNode;
      nbits--;
      if (node.symbol !== void 0) {
        output.push(node.symbol);
        node = huffman_flat_decode_tables;
      }
    }
  }
  const padding = (1 << nbits) - 1;
  if ((current & padding) !== padding) {
    throw new Error("Invalid Huffman padding");
  }
  return new TextDecoder().decode(Uint8Array.from(output));
}

// src/rtcfetcher/qpack/static-table.ts
var qpack_static_table_entries = [
  [":authority", ""],
  [":path", "/"],
  ["age", "0"],
  ["content-disposition", ""],
  ["content-length", "0"],
  ["cookie", ""],
  ["date", ""],
  ["etag", ""],
  ["if-modified-since", ""],
  ["if-none-match", ""],
  ["last-modified", ""],
  ["link", ""],
  ["location", ""],
  ["referer", ""],
  ["set-cookie", ""],
  [":method", "CONNECT"],
  [":method", "DELETE"],
  [":method", "GET"],
  [":method", "HEAD"],
  [":method", "OPTIONS"],
  [":method", "POST"],
  [":method", "PUT"],
  [":scheme", "http"],
  [":scheme", "https"],
  [":status", "103"],
  [":status", "200"],
  [":status", "304"],
  [":status", "404"],
  [":status", "503"],
  ["accept", "*/*"],
  ["accept", "application/dns-message"],
  ["accept-encoding", "gzip, deflate, br"],
  ["accept-ranges", "bytes"],
  ["access-control-allow-headers", "cache-control"],
  ["access-control-allow-headers", "content-type"],
  ["access-control-allow-origin", "*"],
  ["cache-control", "max-age=0"],
  ["cache-control", "max-age=2592000"],
  ["cache-control", "max-age=604800"],
  ["cache-control", "no-cache"],
  ["cache-control", "no-store"],
  ["cache-control", "public, max-age=31536000"],
  ["content-encoding", "br"],
  ["content-encoding", "gzip"],
  ["content-type", "application/dns-message"],
  ["content-type", "application/javascript"],
  ["content-type", "application/json"],
  ["content-type", "application/x-www-form-urlencoded"],
  ["content-type", "image/gif"],
  ["content-type", "image/jpeg"],
  ["content-type", "image/png"],
  ["content-type", "text/css"],
  ["content-type", "text/html; charset=utf-8"],
  ["content-type", "text/plain"],
  ["content-type", "text/plain;charset=utf-8"],
  ["range", "bytes=0-"],
  ["strict-transport-security", "max-age=31536000"],
  ["strict-transport-security", "max-age=31536000; includesubdomains"],
  ["strict-transport-security", "max-age=31536000; includesubdomains; preload"],
  ["vary", "accept-encoding"],
  ["vary", "origin"],
  ["x-content-type-options", "nosniff"],
  ["x-xss-protection", "1; mode=block"],
  [":status", "100"],
  [":status", "204"],
  [":status", "206"],
  [":status", "302"],
  [":status", "400"],
  [":status", "403"],
  [":status", "421"],
  [":status", "425"],
  [":status", "500"],
  ["accept-language", ""],
  ["access-control-allow-credentials", "FALSE"],
  ["access-control-allow-credentials", "TRUE"],
  ["access-control-allow-headers", "*"],
  ["access-control-allow-methods", "get"],
  ["access-control-allow-methods", "get, post, options"],
  ["access-control-allow-methods", "options"],
  ["access-control-expose-headers", "content-length"],
  ["access-control-request-headers", "content-type"],
  ["access-control-request-method", "get"],
  ["access-control-request-method", "post"],
  ["alt-svc", "clear"],
  ["authorization", ""],
  ["content-security-policy", "script-src 'none'; object-src 'none'; base-uri 'none'"],
  ["early-data", "1"],
  ["expect-ct", ""],
  ["forwarded", ""],
  ["if-range", ""],
  ["origin", ""],
  ["purpose", "prefetch"],
  ["server", ""],
  ["timing-allow-origin", "*"],
  ["upgrade-insecure-requests", "1"],
  ["user-agent", ""],
  ["x-forwarded-for", ""],
  ["x-frame-options", "deny"],
  ["x-frame-options", "sameorigin"]
];

// src/rtcfetcher/qpack/qpack.ts
function encodeQpack(headers, context) {
  const out = [];
  let requiredInsertCount = 0;
  const fieldLines = [];
  let maxDynamicIndexUsed = -1;
  for (const h of headers) {
    const nameLc = h.name.toLowerCase();
    const valueStr = String(h.value);
    let bestStaticIndex = -1;
    let bestStaticNameMatch = -1;
    for (let i = 0; i < qpack_static_table_entries.length; i++) {
      const entry = qpack_static_table_entries[i];
      if (entry[0] === nameLc) {
        if (entry[1] === valueStr) {
          bestStaticIndex = i;
          break;
        }
        if (bestStaticNameMatch === -1) bestStaticNameMatch = i;
      }
    }
    let bestDynamicIndex = -1;
    let bestDynamicNameMatch = -1;
    if (context) {
      const match = context.remoteTable.search(nameLc, valueStr);
      if (match) {
        if (match.valueMatch) bestDynamicIndex = match.index;
        else if (match.nameMatch) bestDynamicNameMatch = match.index;
      }
    }
    if (bestStaticIndex !== -1) {
      const enc = encodeInt(bestStaticIndex, 6);
      fieldLines.push(128 | 64 | enc[0], ...enc.slice(1));
      continue;
    }
    if (bestDynamicIndex !== -1) {
      const currentInsertCount = context.remoteTable.getInsertedCount();
      if (bestDynamicIndex > maxDynamicIndexUsed) {
        maxDynamicIndexUsed = bestDynamicIndex;
      }
      const relativeIndex = currentInsertCount - 1 - bestDynamicIndex;
      const enc = encodeInt(relativeIndex, 6);
      fieldLines.push(128 | 0 | enc[0], ...enc.slice(1));
      continue;
    }
    const isStreamRef = valueStr.startsWith("::streamref::");
    if (context && !isStreamRef) {
      const absIndex = context.insertToDynamicTable(nameLc, valueStr);
      if (absIndex > maxDynamicIndexUsed) {
        maxDynamicIndexUsed = absIndex;
      }
      const currentInsertCount = context.remoteTable.getInsertedCount();
      const relativeIndex = currentInsertCount - 1 - absIndex;
      const enc = encodeInt(relativeIndex, 6);
      fieldLines.push(128 | enc[0], ...enc.slice(1));
      continue;
    }
    if (bestStaticNameMatch !== -1) {
      const enc = encodeInt(bestStaticNameMatch, 4);
      fieldLines.push(64 | 16 | enc[0], ...enc.slice(1));
      const valBytes = new TextEncoder().encode(valueStr);
      const valLen = encodeInt(valBytes.length, 7);
      fieldLines.push(...valLen, ...valBytes);
    } else if (bestDynamicNameMatch !== -1) {
      if (bestDynamicNameMatch > maxDynamicIndexUsed) maxDynamicIndexUsed = bestDynamicNameMatch;
      const currentInsertCount = context.remoteTable.getInsertedCount();
      const relativeIndex = currentInsertCount - 1 - bestDynamicNameMatch;
      const enc = encodeInt(relativeIndex, 4);
      fieldLines.push(64 | 0 | enc[0], ...enc.slice(1));
      const valBytes = new TextEncoder().encode(valueStr);
      const valLen = encodeInt(valBytes.length, 7);
      fieldLines.push(...valLen, ...valBytes);
    } else {
      const nameBytes = new TextEncoder().encode(nameLc);
      const nameLen = encodeInt(nameBytes.length, 3);
      fieldLines.push(32 | nameLen[0], ...nameLen.slice(1), ...nameBytes);
      const valBytes = new TextEncoder().encode(valueStr);
      const valLen = encodeInt(valBytes.length, 7);
      fieldLines.push(...valLen, ...valBytes);
    }
  }
  requiredInsertCount = maxDynamicIndexUsed === -1 ? 0 : maxDynamicIndexUsed + 1;
  const ricEnc = encodeInt(requiredInsertCount, 8);
  out.push(...ricEnc);
  const dbEnc = encodeInt(0, 7);
  out.push(0 | dbEnc[0], ...dbEnc.slice(1));
  out.push(...fieldLines);
  return new Uint8Array(out);
}
function decodeQpack(buf, context) {
  let pos = 0;
  const headers = [];
  const ric = decodeVarInt(buf, 8, pos);
  pos = ric.next;
  const requiredInsertCount = ric.value;
  const db = decodeVarInt(buf, 7, pos);
  const sign = (buf[pos] & 128) !== 0;
  pos = db.next;
  let baseIndex;
  if (!sign) {
    baseIndex = requiredInsertCount + db.value;
  } else {
    baseIndex = requiredInsertCount - db.value - 1;
  }
  if (context && context.localTable.getInsertedCount() < requiredInsertCount) {
    throw new Error(`QPACK Blocked: Required Insert Count ${requiredInsertCount} > Local ${context.localTable.getInsertedCount()}`);
  }
  while (pos < buf.length) {
    let byte = buf[pos];
    if ((byte & 128) === 128) {
      const hasT = (byte & 64) !== 0;
      const idxRes = decodeVarInt(buf, 6, pos);
      pos = idxRes.next;
      if (hasT) {
        if (idxRes.value < qpack_static_table_entries.length) {
          const e = qpack_static_table_entries[idxRes.value];
          headers.push({ name: e[0], value: e[1] });
        } else throw new Error("QPACK Static Index Error");
      } else {
        const absIndex = baseIndex - idxRes.value - 1;
        if (!context) throw new Error("QPACK Dynamic Entry without Context");
        const entry = context.localTable.getEntry(absIndex);
        if (!entry) throw new Error(`QPACK Dynamic Entry Not Found: Abs ${absIndex}`);
        headers.push({ name: entry.name, value: entry.value });
      }
      continue;
    }
    if ((byte & 192) === 64) {
      const hasT = (byte & 16) !== 0;
      const nameIdxRes = decodeVarInt(buf, 4, pos);
      pos = nameIdxRes.next;
      let name = "";
      if (hasT) {
        if (nameIdxRes.value < qpack_static_table_entries.length) {
          name = qpack_static_table_entries[nameIdxRes.value][0];
        } else throw new Error("QPACK Static Name Index Error");
      } else {
        const absIndex = baseIndex - nameIdxRes.value - 1;
        if (!context) throw new Error("QPACK Dynamic Name Ref without Context");
        const entry = context.localTable.getEntry(absIndex);
        if (!entry) throw new Error(`QPACK Dynamic Entry Not Found: Abs ${absIndex}`);
        name = entry.name;
      }
      const valH = (buf[pos] & 128) !== 0;
      const valLenRes = decodeVarInt(buf, 7, pos);
      pos = valLenRes.next;
      const valBytes = buf.subarray(pos, pos + valLenRes.value);
      pos += valLenRes.value;
      const value = valH ? decodeHuffman(valBytes) : new TextDecoder().decode(valBytes);
      headers.push({ name, value });
      continue;
    }
    if ((byte & 224) === 32) {
      const nameH = (byte & 8) !== 0;
      const nameLenRes = decodeVarInt(buf, 3, pos);
      pos = nameLenRes.next;
      const nameBytes = buf.subarray(pos, pos + nameLenRes.value);
      pos += nameLenRes.value;
      const name = nameH ? decodeHuffman(nameBytes) : new TextDecoder().decode(nameBytes);
      const valH = (buf[pos] & 128) !== 0;
      const valLenRes = decodeVarInt(buf, 7, pos);
      pos = valLenRes.next;
      const valBytes = buf.subarray(pos, pos + valLenRes.value);
      pos += valLenRes.value;
      const value = valH ? decodeHuffman(valBytes) : new TextDecoder().decode(valBytes);
      headers.push({ name, value });
      continue;
    }
    throw new Error(`Unknown QPACK instruction at byte ${pos}`);
  }
  return headers;
}

// src/rtcfetcher/types/stream-ref.ts
var StreamRef = class {
  constructor(id) {
    this.id = id;
  }
};

// src/rtcfetcher/qpack/dynamic-table.ts
var DynamicTable = class {
  constructor(capacity = 4096) {
    // Entries are stored in insertion order.
    // The "absolute index" increases with each insertion.
    // RFC 9204 uses absolute indices to reference entries consistently.
    // In this array:
    // entries[0] is the OLDEST entry (smallest absolute index still in table).
    // entries[length-1] is the NEWEST entry (largest absolute index).
    //
    // However, QPACK relative indexing is 0-based from the newest.
    // Relative Index 0 -> Newest Entry
    // Relative Index 1 -> 2nd Newest Entry
    this.entries = [];
    // Total number of insertions made to the dynamic table (Lifetime)
    // This corresponds to 'inserted_count' in RFC.
    this.insertedCount = 0;
    // Current size of the table in bytes
    this.currentSize = 0;
    // The index of the first entry in 'entries' relative to absolute index 0.
    // If we have dropped N entries, the first entry in 'entries' has absolute index N.
    this.droppedCount = 0;
    this.ENTRY_OVERHEAD = 32;
    this.capacity = capacity;
  }
  getInsertedCount() {
    return this.insertedCount;
  }
  setCapacity(capacity) {
    this.capacity = capacity;
    this.evict();
  }
  insert(name, value) {
    const size = name.length + value.length + this.ENTRY_OVERHEAD;
    if (size > this.capacity) {
      this.clear();
      this.insertedCount++;
      return;
    }
    this.evict(this.capacity - size);
    this.entries.push({ name, value, size });
    this.currentSize += size;
    this.insertedCount++;
  }
  duplicate(absoluteIndex) {
    const entry = this.getEntry(absoluteIndex);
    if (!entry) throw new Error(`Cannot duplicate: Entry ${absoluteIndex} not found`);
    this.insert(entry.name, entry.value);
  }
  evict(targetSize = this.capacity) {
    while (this.currentSize > targetSize && this.entries.length > 0) {
      const entry = this.entries.shift();
      this.currentSize -= entry.size;
      this.droppedCount++;
    }
  }
  clear() {
    this.droppedCount += this.entries.length;
    this.entries = [];
    this.currentSize = 0;
  }
  // Get entry by Absolute Index
  getEntry(absoluteIndex) {
    if (absoluteIndex < this.droppedCount) return void 0;
    const arrayIndex = absoluteIndex - this.droppedCount;
    if (arrayIndex >= this.entries.length) return void 0;
    return this.entries[arrayIndex];
  }
  // Get entry by Relative Index (0 = Newest)
  getEntryRelative(relativeIndex) {
    const arrayIndex = this.entries.length - 1 - relativeIndex;
    if (arrayIndex < 0) return void 0;
    return this.entries[arrayIndex];
  }
  // Convert Absolute <-> Relative
  // Base Index is usually the Insert Count.
  // Relative Index = Base Index - 1 - Absolute Index
  // specific to the encoder/decoder state during a block processing.
  // This method is generic for table lookup.
  // Search for matching name (and value)
  // Returns { index: absoluteIndex, nameMatch: boolean, valueMatch: boolean }
  search(name, value) {
    let bestMatch = null;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      const absIndex = this.droppedCount + i;
      if (entry.name === name) {
        if (entry.value === value) {
          return { index: absIndex, nameMatch: true, valueMatch: true };
        }
        if (!bestMatch) {
          bestMatch = { index: absIndex, nameMatch: true, valueMatch: false };
        }
      }
    }
    return bestMatch;
  }
};

// src/rtcfetcher/qpack/instruction.ts
function encodeEncoderInstruction(inst) {
  const parts = [];
  if (inst.type === "set_capacity") {
    const firstByte = 32;
    const encOut = encodeInt(inst.capacity, 5);
    parts.push(firstByte | encOut[0], ...encOut.slice(1));
  } else if (inst.type === "insert_with_name_ref") {
    const tBit = inst.fromStatic ? 64 : 0;
    const firstByte = 128 | tBit;
    const nameEnc = encodeInt(inst.nameIndex, 6);
    parts.push(firstByte | nameEnc[0], ...nameEnc.slice(1));
    const valBytes = new TextEncoder().encode(inst.value);
    const valLen = encodeInt(valBytes.length, 7);
    parts.push(...valLen, ...valBytes);
  } else if (inst.type === "insert_without_name_ref") {
    const nameBytes = new TextEncoder().encode(inst.name);
    const nameLen = encodeInt(nameBytes.length, 5);
    const firstByte = 64;
    parts.push(firstByte | nameLen[0], ...nameLen.slice(1), ...nameBytes);
    const valBytes = new TextEncoder().encode(inst.value);
    const valLen = encodeInt(valBytes.length, 7);
    parts.push(...valLen, ...valBytes);
  } else if (inst.type === "duplicate") {
    const encOut = encodeInt(inst.index, 5);
    parts.push(0 | encOut[0], ...encOut.slice(1));
  }
  return new Uint8Array(parts);
}

// src/rtcfetcher/qpack/qpack-context.ts
var QpackContext = class {
  constructor() {
    this.localTable = new DynamicTable(4096);
    this.remoteTable = new DynamicTable(4096);
  }
  attachChannels(encoderStream, decoderStream) {
    this.encoderStream = encoderStream;
    this.decoderStream = decoderStream;
    this.setupDecoderStreamHandler();
  }
  // Encoder Logic: Insert into dynamic table and send instruction
  insertToDynamicTable(name, value) {
    this.remoteTable.insert(name, value);
    if (this.encoderStream && this.encoderStream.readyState === "open") {
      const inst = encodeEncoderInstruction({
        type: "insert_without_name_ref",
        name,
        value
      });
      this.encoderStream.send(inst);
    } else {
      console.warn("[QPACK] Encoder stream not ready, dynamic insert skipped/queued?");
    }
    return this.remoteTable.getInsertedCount() - 1;
  }
  // Decoder Logic: Handle incoming instructions from Remote Encoder
  setupDecoderStreamHandler() {
    if (!this.decoderStream) return;
    this.decoderStream.onmessage = (ev) => {
      const data = new Uint8Array(ev.data);
    };
  }
};

// src/rtcfetcher/qpack/qpack-codec.ts
var STREAM_REF_PREFIX = "::streamref::";
var QpackCodec = class {
  constructor(context) {
    this.context = context || new QpackContext();
  }
  getContext() {
    return this.context;
  }
  // Flattens an object into headers
  flattenObject(obj, prefix = "", headers) {
    if (obj === null || obj === void 0) return;
    if (obj instanceof StreamRef) {
      headers.push({ name: prefix, value: STREAM_REF_PREFIX + obj.id });
      return;
    }
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        this.flattenObject(item, `${prefix}[${index}]`, headers);
      });
      return;
    }
    if (typeof obj === "object") {
      if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) {
      }
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          const newKey = prefix ? `${prefix}.${key}` : key;
          this.flattenObject(obj[key], newKey, headers);
        }
      }
      return;
    }
    headers.push({ name: prefix, value: String(obj) });
  }
  inflateHeaders(headers) {
    const result = {};
    for (const h of headers) {
      const key = h.name;
      let value = h.value;
      if (typeof value === "string" && value.startsWith(STREAM_REF_PREFIX)) {
        const id = parseInt(value.substring(STREAM_REF_PREFIX.length), 10);
        value = new StreamRef(id);
      } else if (!isNaN(Number(value)) && value.trim() !== "") {
        value = Number(value);
      } else if (value === "true") value = true;
      else if (value === "false") value = false;
      this.setPath(result, key, value);
    }
    return result;
  }
  setPath(obj, path, value) {
    const normalizedPath = path.replace(/\[(\d+)\]/g, ".$1");
    const parts = normalizedPath.split(".").filter((p) => p !== "");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const nextPart = parts[i + 1];
      const isNextIndex = /^\d+$/.test(nextPart);
      if (!(part in current)) {
        current[part] = isNextIndex ? [] : {};
      }
      current = current[part];
    }
    const last = parts[parts.length - 1];
    if (Array.isArray(current) && /^\d+$/.test(last)) {
      current[parseInt(last)] = value;
    } else {
      current[last] = value;
    }
  }
  encode(data) {
    try {
      const headers = [];
      this.flattenObject(data, "", headers);
      return encodeQpack(headers, this.context);
    } catch (error) {
      throw new RTCSerializationError("Failed to encode data with QPACK", error);
    }
  }
  decode(data) {
    try {
      const headers = decodeQpack(data, this.context);
      return this.inflateHeaders(headers);
    } catch (error) {
      throw new RTCSerializationError("Failed to decode QPACK data", error);
    }
  }
};
var qpackCodec = new QpackCodec();

// src/rtcfetcher/core/rtc-response.ts
var RTCResponse = class {
  constructor(body, streamReplacer) {
    // Cache for rehydrated streams to ensure we return the same instance
    this._streamCache = /* @__PURE__ */ new Map();
    this._body = body;
    this._streamReplacer = streamReplacer;
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop in target) {
          const value = target[prop];
          if (typeof value === "function") {
            return value.bind(target);
          }
          return value;
        }
        console.log(`[RTCResponse Proxy] Accessing: ${String(prop)}`);
        const bodyVal = target._body ? target._body[prop] : void 0;
        console.log(`[RTCResponse Proxy] Value:`, bodyVal);
        return target._wrapValue(bodyVal);
      }
    });
  }
  // Helper to wrap values in Proxy recursively or rehydrate streams
  _wrapValue(value) {
    if (value instanceof StreamRef) {
      return this._getOrHydrateStream(value);
    }
    if (value && typeof value === "object") {
      return new Proxy(value, {
        get: (target, prop) => {
          const val = target[prop];
          return this._wrapValue(val);
        }
      });
    }
    return value;
  }
  _getOrHydrateStream(ref) {
    if (this._streamCache.has(ref.id)) {
      return this._streamCache.get(ref.id);
    }
    const stream = this._streamReplacer(ref);
    if (!stream) {
      throw new Error(`Stream ID ${ref.id} not found`);
    }
    this._streamCache.set(ref.id, stream);
    return stream;
  }
  get ok() {
    return true;
  }
  async json() {
    return this.processBodyAndBufferStreams(this._body);
  }
  async text() {
    const processed = await this.processBodyAndBufferStreams(this._body);
    if (typeof processed === "string") return processed;
    if (processed instanceof Uint8Array) return new TextDecoder().decode(processed);
    return JSON.stringify(processed);
  }
  async blob() {
    const processed = await this.processBodyAndBufferStreams(this._body);
    if (processed instanceof Blob) return processed;
    if (processed instanceof Uint8Array) return new Blob([processed]);
    if (processed instanceof ArrayBuffer) return new Blob([processed]);
    return new Blob([JSON.stringify(processed)], { type: "application/json" });
  }
  // Recursively replace StreamRef with buffered content (Uint8Array)
  async processBodyAndBufferStreams(obj) {
    if (obj instanceof StreamRef) {
      const stream = this._getOrHydrateStream(obj);
      return this._consumeStream(stream);
    }
    if (Array.isArray(obj)) {
      return Promise.all(obj.map((item) => this.processBodyAndBufferStreams(item)));
    }
    if (obj && typeof obj === "object") {
      if (obj instanceof Blob || obj instanceof ArrayBuffer || obj instanceof Uint8Array) {
        return obj;
      }
      if (obj instanceof ReadableStream) {
        return this._consumeStream(obj);
      }
      const newObj = {};
      for (const key in obj) {
        newObj[key] = await this.processBodyAndBufferStreams(obj[key]);
      }
      return newObj;
    }
    return obj;
  }
  async _consumeStream(stream) {
    if (stream.locked) {
      throw new Error("Stream is locked. Cannot buffer content for json().");
    }
    const reader = stream.getReader();
    const chunks = [];
    let totalLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalLength += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
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
    // ID Pool for 0-RTT negotiation (Stores Physical Channel Objects)
    this.idPool = [];
    // Pending Queue for Backpressure
    this.pendingChannelQueue = [];
    this.config = config || {};
    this.masterChannel = pc.createDataChannel("rtc-fetcher-master", { negotiated: true, id: 0 });
    this.negotiator = new Negotiator(this.masterChannel, pc);
    this.qpackEncoderStream = pc.createDataChannel("qpack-encoder", { negotiated: true, id: 1 });
    this.qpackDecoderStream = pc.createDataChannel("qpack-decoder", { negotiated: true, id: 2 });
    this.qpackContext = new QpackContext();
    this.qpackContext.attachChannels(this.qpackEncoderStream, this.qpackDecoderStream);
    this.qpackCodec = new QpackCodec(this.qpackContext);
    this.incomingRequests = new ReadableStream({
      start: (controller) => {
        this.incomingRequestsController = controller;
      },
      pull: () => {
        this.pumpIncomingRequests();
      }
    }, {
      highWaterMark: this.config.incomingHighWaterMark ?? 5
    });
    this.negotiator.onReserved = (id, channel, label) => this.handleReservedChannel(id, channel, label);
    this.opened = new Promise((resolve) => {
      const checkOpen = () => {
        if (this.masterChannel.readyState === "open" && this.qpackEncoderStream.readyState === "open" && this.qpackDecoderStream.readyState === "open") {
          this.refillPool();
          resolve();
          return true;
        }
        return false;
      };
      if (!checkOpen()) {
        const handler = () => checkOpen();
        this.masterChannel.addEventListener("open", handler);
        this.qpackEncoderStream.addEventListener("open", handler);
        this.qpackDecoderStream.addEventListener("open", handler);
      }
    });
  }
  async refillPool() {
    const targetSize = this.config.prefetchPoolSize ?? 5;
    if (this.idPool.length >= targetSize) return;
    console.log(`[RTCFetcher] Refilling ID Pool (Current: ${this.idPool.length}, Target: ${targetSize})`);
    while (this.idPool.length < targetSize) {
      try {
        const excluded = /* @__PURE__ */ new Set([1, 2, ...this.reservedChannels.keys(), ...this.idPool.map((p) => p.id)]);
        const id = await this.negotiator.reserveId("__pooled__", excluded);
        const channel = this.pc.createDataChannel("__pooled__", { negotiated: true, id });
        console.log(`[RTCFetcher] Created Pooled Channel ID: ${id}`);
        this.idPool.push({ id, channel });
      } catch (e) {
        console.warn("[RTCFetcher] Failed to refill ID pool:", e);
        break;
      }
    }
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
      let endpoint = label || "default";
      if (endpoint.startsWith("req::")) {
        endpoint = endpoint.substring(5);
      }
      console.log(`[RTCFetcher] Handle Req Channel ID: ${id}, Label: ${endpoint}`);
      const channel = existingChannel || this.pc.createDataChannel("rtc-fetcher-req", { negotiated: true, id });
      this.pendingChannelQueue.push({ label: endpoint, channel });
      this.pumpIncomingRequests();
    } catch (e) {
      console.error("Error handling reserved channel:", e);
    }
  }
  pumpIncomingRequests() {
    if (!this.incomingRequestsController) return;
    while (this.incomingRequestsController.desiredSize !== null && this.incomingRequestsController.desiredSize > 0 && this.pendingChannelQueue.length > 0) {
      const item = this.pendingChannelQueue.shift();
      this.createAndEnqueueRequest(item.label, item.channel);
    }
  }
  createAndEnqueueRequest(label, channel) {
    const req = {
      label,
      open: async () => {
        console.log(`[RTCFetcher] Opening Request: ${label} (ID: ${channel.id})`);
        const controller = new DataChannelController(channel);
        const receiveStream = new ReceiveStream(controller);
        const info = await this.bufferAndDecode(receiveStream.readable);
        if (!info) {
          controller.close();
          throw new Error("Failed to decode request body");
        }
        const { body } = info;
        const processedBody = await this.processedIncomingBody(body);
        return {
          req: { label, body: processedBody },
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
        channel.close();
      }
    };
    this.incomingRequestsController?.enqueue(req);
  }
  async sendResponse(controller, data) {
    const streams = /* @__PURE__ */ new Map();
    const preCreatedChannels = /* @__PURE__ */ new Map();
    const excludedIds = /* @__PURE__ */ new Set();
    if (controller.underlyingChannel.id !== null) {
      excludedIds.add(controller.underlyingChannel.id);
    }
    const processed = await this.traverseAndExtractStreams(data, async (stream) => {
      let id;
      let pooledChannel;
      if (this.idPool.length > 0) {
        const pooled = this.idPool.shift();
        id = pooled.id;
        pooledChannel = pooled.channel;
        this.refillPool();
      } else {
        id = await this.negotiator.reserveId("res-stream", excludedIds);
      }
      excludedIds.add(id);
      if (pooledChannel) {
        preCreatedChannels.set(id, pooledChannel);
      }
      streams.set(id, stream);
      return new StreamRef(id);
    });
    const encoded = this.qpackCodec.encode(processed);
    const sendStream = new SendStream(controller, this.config.minBufferSize);
    const streamReadyPromises = [];
    streams.forEach((stream, id) => {
      const sChannel = preCreatedChannels.get(id) || this.pc.createDataChannel("res-stream", { negotiated: true, id });
      const sStream = new SendStream(sChannel, this.config.minBufferSize);
      stream.pipeTo(sStream.writable).catch((e) => console.error(e));
      streamReadyPromises.push(this.negotiator.sendReady(id, "res-stream"));
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
      const decoded = this.qpackCodec.decode(bodyBytes);
      if (decoded && typeof decoded === "object") {
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
  async fetch(label, body, options) {
    if (options?.signal?.aborted) {
      throw options.signal.reason || new Error("Aborted");
    }
    await this.opened;
    let reservedId;
    let isPooled = false;
    let pooledChannel;
    if (this.idPool.length > 0) {
      const pooled = this.idPool.shift();
      reservedId = pooled.id;
      pooledChannel = pooled.channel;
      console.log(`[RTCFetcher] Using Pooled ID: ${reservedId}`);
      isPooled = true;
      this.refillPool();
    } else {
      console.log(`[RTCFetcher] Pool Empty. Negotiating directly...`);
      reservedId = await this.negotiator.findUnusedId();
      isPooled = false;
    }
    const streams = /* @__PURE__ */ new Map();
    const streamCache = /* @__PURE__ */ new Map();
    const preCreatedStreamChannels = /* @__PURE__ */ new Map();
    const excludedIds = /* @__PURE__ */ new Set([reservedId, ...this.idPool.map((p) => p.id)]);
    const processedBody = await this.traverseAndExtractStreams(body, async (stream) => {
      if (streamCache.has(stream)) return streamCache.get(stream);
      let streamId;
      if (this.idPool.length > 0) {
        const p = this.idPool.shift();
        streamId = p.id;
        preCreatedStreamChannels.set(streamId, p.channel);
        this.refillPool();
      } else {
        streamId = await this.negotiator.reserveId("stream", excludedIds);
      }
      excludedIds.add(streamId);
      streams.set(streamId, stream);
      const ref = new StreamRef(streamId);
      streamCache.set(stream, ref);
      return ref;
    });
    if (!isPooled) {
      await this.negotiator.performHandshake(reservedId, "req::" + label);
    }
    console.log("Reserved ID (Local):", reservedId);
    const mainChannel = pooledChannel || this.pc.createDataChannel(label, { negotiated: true, id: reservedId });
    const controller = new DataChannelController(mainChannel);
    const signal = options?.signal;
    const abortHandler = () => {
      console.log(`[RTCFetcher] AbortSignal fired. Closing request channel ${reservedId}`);
      controller.close();
    };
    if (signal) {
      signal.addEventListener("abort", abortHandler);
      controller.underlyingChannel.addEventListener("close", () => {
        signal.removeEventListener("abort", abortHandler);
      });
    }
    const responseReader = new ReceiveStream(controller);
    const sendStream = new SendStream(controller, this.config.minBufferSize);
    await this.negotiator.sendReady(reservedId, "req::" + label);
    const encoded = this.qpackCodec.encode({ label, body: processedBody });
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
      const channel = preCreatedStreamChannels.get(id) || this.pc.createDataChannel("stream", { negotiated: true, id });
      const sStream = new SendStream(channel, this.config.minBufferSize);
      stream.pipeTo(sStream.writable).catch((e) => console.error(e));
      streamReadyPromises.push(this.negotiator.sendReady(id, "stream"));
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
          const resData = this.qpackCodec.decode(bodyBuf);
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

// src/rtcfetcher/utils/msgpack-codec.ts
import { encode, decode, ExtensionCodec } from "@msgpack/msgpack";
var HEADERS_EXT_TYPE = 1;
var STREAM_REF_EXT_TYPE = 2;
var MsgPackCodec = class {
  constructor() {
    this.extensionCodec = new ExtensionCodec();
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
          return encode(entries);
        }
        return null;
      },
      decode: (data) => {
        const entries = decode(data);
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
          return encode(object.id);
        }
        return null;
      },
      decode: (data) => {
        const id = decode(data);
        return new StreamRef(id);
      }
    });
  }
  encode(data) {
    try {
      return encode(data, { extensionCodec: this.extensionCodec });
    } catch (error) {
      throw new RTCSerializationError("Failed to encode data with MessagePack", error);
    }
  }
  decode(data) {
    try {
      return decode(data, { extensionCodec: this.extensionCodec });
    } catch (error) {
      throw new RTCSerializationError("Failed to decode MessagePack data", error);
    }
  }
};
var msgpackCodec = new MsgPackCodec();
export {
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
};
