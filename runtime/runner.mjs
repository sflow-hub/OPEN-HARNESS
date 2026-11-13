import { createRequire as __openHarnessCreateRequire } from 'node:module'; const require = __openHarnessCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { websocketMask, websocketUnmask } = __require("http");
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output2, offset, length) {
      for (let i = 0; i < length; i++) {
        output2[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (websocketMask) {
      module.exports.mask = function(source, mask, output2, offset, length) {
        if (length < 24) _mask(source, mask, output2, offset, length);
        else websocketMask(source, mask, output2, offset, length);
      };
      module.exports.unmask = function(buffer, mask) {
        if (buffer.length < 24) _unmask(buffer, mask);
        else websocketUnmask(buffer, mask);
      };
    } else if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = __require("bufferutil");
        module.exports.mask = function(source, mask, output2, offset, length) {
          if (length < 48) _mask(source, mask, output2, offset, length);
          else bufferUtil.mask(source, mask, output2, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex: Duplex3 } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) {
          return dataLength ? [target, data] : [target];
        }
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (!dataLength) return [target];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter2 = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes, createHash: createHash8 } = __require("crypto");
    var { Duplex: Duplex3, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter2 {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            if (!options || options.protocols === void 0) {
              protocols = [];
            } else if (Array.isArray(options.protocols)) {
              protocols = options.protocols;
            } else {
              protocols = [options.protocols];
            }
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              if (options.protocols === void 0) {
                protocols = [];
              } else if (Array.isArray(options.protocols)) {
                protocols = options.protocols;
              } else {
                protocols = [options.protocols];
              }
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        this._readyState = _WebSocket.CLOSING;
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        protocols: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request2 = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const i = opts.path.indexOf(":");
        if (i === -1) {
          opts.socketPath = opts.path;
          opts.path = "";
        } else {
          opts.socketPath = opts.path.slice(0, i);
          opts.path = opts.path.slice(i + 1);
        }
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers2 = options && options.headers;
          options = { ...options, headers: {} };
          if (headers2) {
            for (const [key2, value] of Object.entries(headers2)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request2(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request2(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest2 = createHash8("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest2) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex: Duplex3 } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex3({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open2() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish2() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open2() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter2 = __require("events");
    var http = __require("http");
    var { Duplex: Duplex3 } = __require("stream");
    var { createHash: createHash8 } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter2 {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers2) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers2);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest2 = createHash8("sha1").update(key + GUID).digest("base64");
        const headers2 = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest2}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers2.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers2.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers2, req);
        socket.write(headers2.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers2) {
      message = message || http.STATUS_CODES[code];
      headers2 = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers2
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers2).map((h) => `${h}: ${headers2[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers2) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers2);
      }
    }
  }
});

// runtime/sandbox-selftest.ts
import { spawn } from "node:child_process";

// runtime/sandbox-attest.ts
import { posix } from "node:path";
function attestContainer(inspect2, expected) {
  const h = inspect2.HostConfig || {}, mounts = inspect2.Mounts || [], options = h.SecurityOpt || [], { computer } = expected;
  const root = posix.normalize(expected.stateRoot), own = `${root}/agents/${expected.agentId}`;
  const allowed = [
    { source: `${own}/managed`, destination: "/run/open-harness", rw: false },
    { source: `${own}/profile`, destination: "/home/hermes/.hermes", rw: true },
    { source: `${own}/private`, destination: "/workspace/private", rw: true },
    { source: `${root}/shared`, destination: "/workspace/shared", rw: true },
    ...(expected.teamIds || []).map((id) => ({ source: `${root}/teams/${id}/shared`, destination: `/workspace/teams/${id}`, rw: true }))
  ];
  const managedSources = new Set(allowed.map((m) => m.source));
  if (computer.access === "folders") computer.folders.forEach((folder, index) => allowed.push({ source: posix.normalize(folder.path), destination: `/workspace/mounts/folder-${index + 1}`, rw: folder.mode === "write" }));
  const matches = (m, a) => posix.normalize(m.Source) === a.source && m.RW === a.rw && m.Destination === a.destination;
  const unexpected = mounts.filter((m) => {
    const source = posix.normalize(m.Source);
    if ((source === root || root.startsWith(`${source}/`) || source.startsWith(`${root}/`)) && !managedSources.has(source)) return true;
    return !allowed.some((a) => matches(m, a));
  });
  const missing = allowed.filter((a) => !mounts.some((m) => matches(m, a)));
  const networks = Object.values(inspect2.NetworkSettings?.Networks || {}), internal = networks.length > 0 && networks.every((n) => n.Internal === true);
  const network = h.NetworkMode || "unknown", mode = computer.network?.mode || "open";
  const checks = {};
  const check = (key, ok, detail) => {
    checks[key] = { ok, detail };
  };
  check("cap_drop_all", Boolean(h.CapDrop?.some((c) => c.toUpperCase() === "ALL")) && !h.CapAdd?.length, `CapDrop=${JSON.stringify(h.CapDrop || [])}; CapAdd=${JSON.stringify(h.CapAdd || [])}`);
  check("no_new_privileges", options.some((o) => /^no-new-privileges(?:(?:=|:)true)?$/.test(o)), `SecurityOpt=${JSON.stringify(options)}`);
  check("seccomp_not_unconfined", !options.some((o) => /^seccomp[=:]unconfined$/.test(o)), options.find((o) => /^seccomp[=:]/.test(o)) || "Docker default seccomp profile");
  check("not_privileged", h.Privileged === false, `Privileged=${h.Privileged}`);
  check("readonly_rootfs", h.ReadonlyRootfs === true, h.ReadonlyRootfs ? "read-only image rootfs" : "writable image rootfs (hardening pending)");
  check("limits", Number(h.PidsLimit) > 0 && h.Memory === Math.round(computer.resources.memoryMb) * 1024 * 1024 && h.NanoCpus === computer.resources.cpu * 1e9, `PidsLimit=${h.PidsLimit}; Memory=${h.Memory}; NanoCpus=${h.NanoCpus}; expected memory=${computer.resources.memoryMb} MB, cpu=${computer.resources.cpu}`);
  check("no_docker_socket_mount", !mounts.some((m) => /(?:^|\/)docker\.sock(?:\/|$)/.test(m.Source) || /(?:^|\/)docker\.sock(?:\/|$)/.test(m.Destination)), "Mount sources and destinations checked for docker.sock");
  check("no_host_home_mount", !mounts.some((m) => {
    const s = posix.normalize(m.Source);
    return s === "/" || s === "/root" || s === "/home" || s === "/Users" || /^\/(?:home|Users)\/[^/]+$/.test(s);
  }), "Mount sources checked for host root and home directories");
  check("mounts_expected", Array.isArray(inspect2.Mounts) && unexpected.length === 0 && missing.length === 0 && mounts.length === allowed.length, unexpected.length ? `Unexpected mounts: ${unexpected.map((m) => `${m.Source}:${m.Destination}:${m.RW ? "rw" : "ro"}`).join(", ")}` : missing.length ? `Missing mounts: ${missing.map((m) => m.destination).join(", ")}` : "Exact expected mount sources, destinations and write flags");
  check("network_mode", mode === "open" || network === "none" || internal ? true : null, `NetworkMode=${network}; profile network.mode=${mode}${mode !== "open" && network !== "none" && !internal ? "; not enforced yet" : internal ? "; host-inspected internal network" : ""}`);
  return { checks };
}

// runtime/sandbox-selftest.ts
var PROBE_CHECKS = ["writes_outside_writable_mounts_denied", "docker_socket_absent", "host_home_absent", "no_privilege_escalation", "cpu_mem_pids_limited"];
function combineSandbox(checks, observations = {}, attestation = "host-attested") {
  const combined = Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, { ...value }]));
  const corroboration = { readonly_rootfs: ["writes_outside_writable_mounts_denied"], no_docker_socket_mount: ["docker_socket_absent"], no_host_home_mount: ["host_home_absent"], limits: ["cpu_mem_pids_limited"], no_new_privileges: ["no_privilege_escalation"], cap_drop_all: ["no_privilege_escalation"], seccomp_not_unconfined: ["no_privilege_escalation"] };
  for (const [key, names] of Object.entries(corroboration)) for (const name of names) {
    const fact = combined[key], observation = observations[name];
    const composite = ["no_privilege_escalation", "cpu_mem_pids_limited"].includes(name);
    const allPrivilegeFacts = ["no_new_privileges", "cap_drop_all", "seccomp_not_unconfined"].every((key2) => combined[key2]?.ok === true);
    const contradictsComposite = !composite || observation?.ok === true || name === "no_privilege_escalation" && allPrivilegeFacts || name === "cpu_mem_pids_limited";
    if (fact && observation && fact.ok !== null && observation.ok !== null && fact.ok !== observation.ok && contradictsComposite) {
      fact.tampering_suspected = true;
      fact.detail += `; tampering_suspected: probe ${name} disagrees`;
    }
  }
  const values = Object.values(combined), status = values.some((c) => c.ok === false || c.tampering_suspected) ? "red" : values.some((c) => c.ok === null) || Object.values(observations).some((c) => c.ok !== true) ? "amber" : "green";
  return { probe: "sandbox-selftest/v1", runnerKind: "container", attestation, status, checks: combined, observations };
}
var SANDBOX_EXEC_ARGS = ["env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "python", "-I", "-S", "/opt/open-harness/sandbox_selftest.py"];
function dockerJson(args2, input = "{}\n") {
  return new Promise((resolve8, reject) => {
    const child = spawn("docker", args2, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0, failure3;
    const timer = setTimeout(() => {
      failure3 = new Error("Sandbox check timed out.");
      child.kill("SIGKILL");
    }, 25e3);
    child.stdout.on("data", (part) => {
      size += part.length;
      if (size > 1e6) {
        failure3 = new Error("Sandbox check output exceeded its limit.");
        child.kill("SIGKILL");
      } else chunks.push(part);
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure3 || code) return reject(failure3 || new Error("Docker sandbox check failed."));
      try {
        resolve8(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Sandbox check returned invalid JSON."));
      }
    });
    child.stdin.end(input);
  });
}
function probeChecks(value) {
  if (!value || typeof value !== "object" || !("probe" in value) || value.probe !== "sandbox-selftest/v1" || !("checks" in value) || !value.checks || typeof value.checks !== "object" || Array.isArray(value.checks)) throw new Error("Invalid sandbox probe response.");
  const checks = value.checks;
  if (!PROBE_CHECKS.every((key) => key in checks)) throw new Error("Incomplete sandbox probe response.");
  for (const check of Object.values(value.checks)) if (!check || ![true, false, null].includes(check.ok) || typeof check.detail !== "string") throw new Error("Invalid sandbox probe check.");
  return value.checks;
}
async function sandboxSelftest(container, expected, attestation = "host-attested", transport = dockerJson) {
  const inspected = await transport(["inspect", container]);
  if (!Array.isArray(inspected) || inspected.length !== 1 || !inspected[0]?.HostConfig) throw new Error("Invalid Docker inspect response.");
  const containerInspect = inspected[0];
  if (expected.computer.network?.mode !== "open" && containerInspect.HostConfig.NetworkMode !== "none") {
    const networks = containerInspect.NetworkSettings?.Networks || {};
    const names = Object.keys(networks);
    for (const name of names) networks[name].Internal = false;
    if (names.length) {
      try {
        const metadata = await transport(["network", "inspect", ...names]);
        if (Array.isArray(metadata)) for (const name of names) {
          const network = metadata.find((n) => n.Name === name && n.Id === networks[name].NetworkID);
          networks[name].Internal = network?.Internal === true;
        }
      } catch {
      }
    }
  }
  const { checks } = attestContainer(inspected[0], expected);
  let observations;
  try {
    observations = probeChecks(await transport(["exec", "-i", container, ...SANDBOX_EXEC_ARGS]));
  } catch (error) {
    observations = { probe_available: { ok: null, detail: error instanceof Error ? error.message : "Probe unavailable; rebuild the Hermes image." } };
  }
  return combineSandbox(checks, observations, attestation);
}

// runtime/runner.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync10, readFileSync as readFileSync8, writeFileSync as writeFileSync8, chmodSync as chmodSync3, readdirSync as readdirSync5, unlinkSync as unlinkSync5 } from "node:fs";
import { homedir as homedir2, hostname, platform as platform2, arch } from "node:os";
import { join as join11, resolve as resolve7 } from "node:path";
import { spawn as spawn7 } from "node:child_process";

// runtime/docker-path.mjs
import { accessSync, constants } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { homedir } from "node:os";
function dockerCandidates(platform3 = process.platform, environment = process.env, homeDirectory = homedir()) {
  const path2 = platform3 === "win32" ? win32 : { join };
  const executable = platform3 === "win32" ? "docker.exe" : "docker";
  return [
    environment.OPEN_HARNESS_DOCKER_BINARY,
    ...(environment.PATH || "").split(platform3 === "win32" ? ";" : ":").filter(Boolean).map((directory) => path2.join(directory, executable)),
    ...platform3 === "darwin" ? ["/Applications/Docker.app/Contents/Resources/bin/docker", "/opt/homebrew/bin/docker", "/usr/local/bin/docker"] : [],
    ...platform3 === "win32" ? [win32.join(environment.ProgramFiles || "C:\\Program Files", "Docker", "Docker", "resources", "bin", executable)] : ["/usr/bin/docker", "/usr/local/bin/docker"],
    path2.join(homeDirectory, ".docker", "bin", executable)
  ].filter(Boolean);
}
function prepareDockerEnvironment(environment = process.env) {
  for (const candidate of dockerCandidates(process.platform, environment)) {
    try {
      accessSync(candidate, constants.X_OK);
      const directory = dirname(candidate), separator = process.platform === "win32" ? ";" : ":";
      if (!(environment.PATH || "").split(separator).includes(directory)) environment.PATH = directory + separator + (environment.PATH || "");
      return candidate;
    } catch {
    }
  }
  return "docker";
}
prepareDockerEnvironment();

// runtime/commands.ts
import { spawn as spawn2 } from "node:child_process";
function commandAsync(name, args2, timeout = 1e4, options = {}) {
  return new Promise((resolve8) => {
    const child = spawn2(name, args2, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], timeout, killSignal: "SIGKILL", windowsHide: true });
    let stdout = "", stderr = "", error, settled = false;
    const limit = options.maxBytes ?? 2e6;
    const done = (status) => {
      if (!settled) {
        settled = true;
        resolve8({ status, stdout, stderr, error });
      }
    };
    const append = (chunk, stream) => {
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > limit) {
        error = new Error(`${name} returned too much output.`);
        stdout = "";
        stderr = "";
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    child.once("error", (value) => {
      error = value;
      done(null);
    });
    child.once("close", done);
    child.stdin.on("error", () => {
    });
    child.stdin.end(options.input);
  });
}

// runtime/hermes.ts
import { spawn as spawn3, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { createHash, randomUUID as randomUUID3 } from "node:crypto";
import { lstatSync as lstatSync4, mkdirSync as mkdirSync2, unlinkSync as unlinkSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join3, resolve as resolve5, sep as sep2 } from "node:path";

// lib/agent-profile.ts
var DEFAULT_NETWORK = { mode: "open", allow: [] };
var UNSANDBOXED_COMPUTER_MESSAGE = "Direct access to the signed-in computer is not sandboxed and is disabled. Open Agent settings \u2192 Computer and choose a private workspace or private agent desktop.";
function isSandboxedComputer(computer) {
  return ["private", "folders"].includes(computer.access) && ["none", "virtual"].includes(computer.desktop);
}
var DEFAULT_COMPUTER = { machineId: "local", access: "private", folders: [], desktop: "none", reserveMachine: false, network: { ...DEFAULT_NETWORK, allow: [] }, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } };
var MCP_PREFIX = "mcp__";
var COORDINATION_SERVER = "open_harness";
function mcpToolId(server, tool) {
  return `${MCP_PREFIX}${server}__${tool}`;
}
function mcpServerOf(id) {
  if (!id.startsWith(MCP_PREFIX)) return null;
  const server = id.slice(MCP_PREFIX.length).split("__")[0];
  return server || null;
}
var TASK_TOOL = mcpToolId(COORDINATION_SERVER, "task");
var MESSAGE_TOOL = "mcp__open_harness__post_message";
var HANDOFF_TOOL = mcpToolId(COORDINATION_SERVER, "delegate_named_agent");
var ROUTINE_TOOL = mcpToolId(COORDINATION_SERVER, "create_open_harness_routine");
var COMPUTER_TOOL = mcpToolId(COORDINATION_SERVER, "computer");
var LEGACY_TOOL_IDS = {
  mcp_open_harness_task: TASK_TOOL,
  mcp_open_harness_delegate_named_agent: HANDOFF_TOOL,
  mcp_open_harness_create_open_harness_routine: ROUTINE_TOOL
};
function normalizeToolIds(ids, connectorNames = []) {
  return ids.map((id) => {
    if (LEGACY_TOOL_IDS[id]) return LEGACY_TOOL_IDS[id];
    if (id.startsWith(MCP_PREFIX) || !id.startsWith("mcp_")) return id;
    const server = connectorNames.find((name) => id.startsWith(`mcp_${name}_`));
    return server ? mcpToolId(server, id.slice(`mcp_${server}_`.length)) : id;
  });
}
function runToolGrants(profile) {
  const servers = /* @__PURE__ */ new Set([COORDINATION_SERVER, ...profile.connectors.filter((connector) => connector.enabled).map((connector) => connector.name)]);
  const desktop = isSandboxedComputer(profile.computer) && profile.computer.desktop === "virtual";
  return [...new Set(normalizeToolIds(profile.allowedTools, profile.connectors.map((connector) => connector.name)).map((id) => id === "computer_use" ? COMPUTER_TOOL : id).filter(
    (id) => (desktop || id !== COMPUTER_TOOL) && (!desktop || !id.startsWith("browser_")) && (!id.startsWith("mcp_") || servers.has(mcpServerOf(id) || ""))
  ))];
}

// runtime/safe-fs.ts
import { closeSync, constants as constants2, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, resolve, sep } from "node:path";
var SafeFsError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SafeFsError";
  }
};
var { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_CREAT } = constants2;
var DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
function remap(error) {
  if (error instanceof SafeFsError) return error;
  switch (error?.code) {
    case "ELOOP":
      return new SafeFsError("symlink", "Refusing to follow a symbolic link.");
    case "ENOENT":
      return new SafeFsError("not-found", "No such file or directory.");
    case "ENOTDIR":
      return new SafeFsError("invalid-path", "A path component is not a directory.");
    case "EISDIR":
      return new SafeFsError("not-regular", "Target is a directory, not a regular file.");
    case "ENXIO":
      return new SafeFsError("not-regular", "Not a regular file.");
    // O_WRONLY|O_NONBLOCK on a FIFO with no reader
    case "EWOULDBLOCK":
      return new SafeFsError("not-regular", "Not a regular file.");
    // non-blocking open would have blocked
    case "EEXIST":
      return new SafeFsError("conflict", "A file or directory already exists at that path.");
    case "ENOTEMPTY":
      return new SafeFsError("conflict", "The directory changed during removal.");
    case "EXDEV":
      return new SafeFsError("conflict", "Cannot move across filesystems; staging must share the destination filesystem.");
    default:
      return error instanceof Error ? error : new Error(String(error));
  }
}
function components(rel) {
  if (typeof rel !== "string" || rel.includes("\0") || isAbsolute(rel)) throw new SafeFsError("invalid-path", "Path must be relative and free of NUL bytes.");
  if (rel === "") return [];
  const parts = rel.split("/");
  for (const part of parts) if (part === "" || part === "." || part === ".." || part.includes("\\")) throw new SafeFsError("invalid-path", "Path must not contain empty, relative, or separator-escaped components.");
  return parts;
}
function assertTrustedAnchor(dir) {
  if (typeof dir !== "string" || dir.includes("\0") || !isAbsolute(dir) || resolve(dir) !== dir) throw new SafeFsError("invalid-path", "Anchor must be an absolute, normalized path with no traversal.");
}
var hooks = {};
function testHooksEnabled() {
  return process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS === "1";
}
function runHook(phase, name) {
  if (testHooksEnabled()) hooks[phase]?.({ phase, name });
}
var procPath = (fd, name) => `/proc/self/fd/${fd}/${name}`;
function closeQuietly(fd) {
  try {
    closeSync(fd);
  } catch {
  }
}
var probeResult;
function probe() {
  let base = null;
  try {
    base = mkdtempSync(resolve(tmpdir(), "oh-safefs-"));
    const outside = resolve(base, "outside");
    mkdirSync(outside);
    writeFileSync(resolve(outside, "canary"), "canary");
    mkdirSync(resolve(base, "d"));
    writeFileSync(resolve(base, "d", "f"), "probe", { mode: 384 });
    const anchorFd = openSync(base, DIR_FLAGS);
    try {
      const dFd = openSync(procPath(anchorFd, "d"), DIR_FLAGS);
      try {
        const fFd = openSync(procPath(dFd, "f"), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
        try {
          const st = fstatSync(fFd);
          if (!st.isFile() || st.size !== 5) throw new Error("probe read failed");
        } finally {
          closeQuietly(fFd);
        }
        if (!readdirSync(`/proc/self/fd/${dFd}`).includes("f")) throw new Error("probe readdir failed");
        if (!lstatSync(procPath(dFd, "f")).isFile()) throw new Error("probe lstat failed");
        const wFd = openSync(procPath(dFd, "g"), O_WRONLY | O_CREAT | O_NOFOLLOW, 384);
        try {
          writeSync(wFd, Buffer.from("x"));
        } finally {
          closeQuietly(wFd);
        }
        mkdirSync(procPath(dFd, "sub"), { mode: 448 });
        const subFd = openSync(procPath(dFd, "sub"), DIR_FLAGS);
        try {
          renameSync(procPath(dFd, "g"), procPath(subFd, "g"));
          unlinkSync(procPath(subFd, "g"));
        } finally {
          closeQuietly(subFd);
        }
        rmdirSync(procPath(dFd, "sub"));
        renameSync(resolve(base, "d"), resolve(base, "moved"));
        symlinkSync(outside, resolve(base, "d"));
        if (readFileSync(procPath(dFd, "f"), "utf8") !== "probe") throw new Error("held fd did not survive parent swap");
        let rejectedComponent = false;
        try {
          closeQuietly(openSync(procPath(anchorFd, "d"), DIR_FLAGS));
        } catch {
          rejectedComponent = true;
        }
        if (!rejectedComponent) throw new Error("symlinked component was not rejected");
        symlinkSync(resolve(outside, "canary"), procPath(dFd, "link"));
        let rejectedLeaf = false;
        try {
          closeQuietly(openSync(procPath(dFd, "link"), O_RDONLY | O_NOFOLLOW));
        } catch {
          rejectedLeaf = true;
        }
        if (!rejectedLeaf) throw new Error("symlinked leaf was not rejected");
      } finally {
        closeQuietly(dFd);
      }
    } finally {
      closeQuietly(anchorFd);
    }
    return "fd-relative";
  } catch {
    return "unsupported";
  } finally {
    if (base) try {
      rmSync(base, { recursive: true, force: true });
    } catch {
    }
  }
}
function safeFsMode() {
  if (testHooksEnabled()) {
    const forced = process.env.OPEN_HARNESS_SAFE_FS_MODE;
    if (forced === "path") return "path-fallback";
    if (forced === "unsupported") return "unsupported";
  }
  if (process.platform !== "linux") return "path-fallback";
  return probeResult ??= probe();
}
function requireMode() {
  const mode = safeFsMode();
  if (mode === "unsupported") throw new SafeFsError("unsupported", "Safe workspace file access is unavailable on this host.");
  return mode;
}
function openComponent(parentFd, name) {
  try {
    return openSync(procPath(parentFd, name), DIR_FLAGS);
  } catch (error) {
    const code = error?.code;
    if (code === "ELOOP" || code === "ENOTDIR") {
      const st = lstatSync(procPath(parentFd, name), { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new SafeFsError("symlink", "Refusing to traverse a symbolic link in the path.");
    }
    throw error;
  }
}
function openChain(anchor, dirParts, fds) {
  let fd = openSync(anchor, DIR_FLAGS);
  fds.push(fd);
  runHook("afterComponentOpen");
  for (const part of dirParts) {
    fd = openComponent(fd, part);
    fds.push(fd);
    runHook("afterComponentOpen", part);
  }
  return fd;
}
function withParent(anchor, rel, fn) {
  const parts = components(rel);
  if (parts.length === 0) throw new SafeFsError("invalid-path", "Operation requires a target name.");
  const fds = [];
  try {
    const parentFd = openChain(anchor, parts.slice(0, -1), fds);
    const leaf = parts[parts.length - 1];
    runHook("beforeTerminalOp", leaf);
    return fn(parentFd, leaf);
  } finally {
    for (const fd of fds) closeQuietly(fd);
  }
}
function readFd(anchor, rel, opts) {
  return withParent(anchor, rel, (parentFd, leaf) => {
    const fd = openSync(procPath(parentFd, leaf), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new SafeFsError("not-regular", "Not a regular file.");
      if (st.size > opts.maxBytes) throw new SafeFsError("too-large", `File exceeds the ${opts.maxBytes}-byte limit.`);
      const buf = Buffer.allocUnsafe(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      const data = off === st.size ? buf : buf.subarray(0, off);
      return opts.encoding ? data.toString(opts.encoding) : data;
    } finally {
      closeQuietly(fd);
    }
  });
}
function writeFd(anchor, rel, bytes2, mode, exclusive = false) {
  withParent(anchor, rel, (parentFd, leaf) => {
    const fd = openSync(procPath(parentFd, leaf), O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK | (exclusive ? constants2.O_EXCL : 0), mode);
    try {
      if (!fstatSync(fd).isFile()) throw new SafeFsError("not-regular", "Not a regular file.");
      ftruncateSync(fd, 0);
      let off = 0;
      while (off < bytes2.length) off += writeSync(fd, bytes2, off, bytes2.length - off, off);
    } finally {
      closeQuietly(fd);
    }
  });
}
function listFd(anchor, rel, max) {
  const parts = components(rel);
  const fds = [];
  try {
    const dirFd = openChain(anchor, parts, fds);
    const names = readdirSync(`/proc/self/fd/${dirFd}`);
    const out = [];
    for (const name of names) {
      if (out.length >= max) break;
      runHook("betweenReaddirAndLstat", name);
      const st = lstatSync(procPath(dirFd, name), { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      out.push({ name, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
    }
    return out;
  } finally {
    for (const fd of fds) closeQuietly(fd);
  }
}
function mkdirFd(anchor, rel) {
  withParent(anchor, rel, (parentFd, leaf) => mkdirSync(procPath(parentFd, leaf), { mode: 448 }));
}
function statFd(anchor, rel) {
  return withParent(anchor, rel, (parentFd, leaf) => {
    const st = lstatSync(procPath(parentFd, leaf), { throwIfNoEntry: false });
    if (!st) return null;
    return { name: leaf, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory(), isFile: st.isFile(), isSymbolicLink: st.isSymbolicLink() };
  });
}
function scanTree(parentFd, name, limits, depth, count) {
  if (depth > limits.maxDepth) throw new SafeFsError("too-large", "Directory tree is too deep to remove.");
  const dirFd = openSync(procPath(parentFd, name), DIR_FLAGS);
  try {
    for (const child of readdirSync(`/proc/self/fd/${dirFd}`)) {
      if (++count.n > limits.maxEntries) throw new SafeFsError("too-large", "Directory tree has too many entries to remove.");
      const st = lstatSync(procPath(dirFd, child));
      if (st.isSymbolicLink()) throw new SafeFsError("symlink", "Refusing to remove a tree that contains a symbolic link.");
      if (st.isDirectory()) scanTree(dirFd, child, limits, depth + 1, count);
    }
  } finally {
    closeQuietly(dirFd);
  }
}
function removeTree(parentFd, name, limits, depth, count) {
  if (depth > limits.maxDepth) throw new SafeFsError("too-large", "Directory tree is too deep to remove.");
  const dirFd = openSync(procPath(parentFd, name), DIR_FLAGS);
  const ident = fstatSync(dirFd);
  try {
    for (const child of readdirSync(`/proc/self/fd/${dirFd}`)) {
      if (++count.n > limits.maxEntries) throw new SafeFsError("too-large", "Directory tree has too many entries to remove.");
      runHook("duringRecursiveDescent", child);
      const st = lstatSync(procPath(dirFd, child));
      if (st.isSymbolicLink()) throw new SafeFsError("symlink", "Refusing to remove a symbolic link.");
      if (st.isDirectory()) removeTree(dirFd, child, limits, depth + 1, count);
      else unlinkSync(procPath(dirFd, child));
    }
  } finally {
    closeQuietly(dirFd);
  }
  const now = lstatSync(procPath(parentFd, name), { throwIfNoEntry: false });
  if (!now || now.dev !== ident.dev || now.ino !== ident.ino) throw new SafeFsError("conflict", "The directory changed during removal.");
  rmdirSync(procPath(parentFd, name));
}
function rmrfFd(anchor, rel, limits) {
  withParent(anchor, rel, (parentFd, leaf) => {
    const st = lstatSync(procPath(parentFd, leaf));
    if (st.isSymbolicLink()) throw new SafeFsError("symlink", "Refusing to remove a symbolic link.");
    if (st.isDirectory()) {
      scanTree(parentFd, leaf, limits, 0, { n: 0 });
      removeTree(parentFd, leaf, limits, 0, { n: 0 });
    } else unlinkSync(procPath(parentFd, leaf));
  });
}
function renameFd(stagingDir, name, anchor, rel) {
  if (components(name).length !== 1) throw new SafeFsError("invalid-path", "Staging name must be a single path component.");
  const parts = components(rel);
  if (parts.length === 0) throw new SafeFsError("invalid-path", "Rename requires a destination name.");
  const fds = [];
  try {
    const stagingFd = openSync(stagingDir, DIR_FLAGS);
    fds.push(stagingFd);
    const destParentFd = openChain(anchor, parts.slice(0, -1), fds);
    const leaf = parts[parts.length - 1];
    runHook("beforeRenameCommit", leaf);
    renameSync(procPath(stagingFd, name), procPath(destParentFd, leaf));
  } finally {
    for (const fd of fds) closeQuietly(fd);
  }
}
function containedPath(anchor, rel, allowLeafLink = false) {
  const parts = components(rel), base = resolve(anchor), target = resolve(base, parts.join("/") || ".");
  if (target !== base && !target.startsWith(base + sep)) throw new SafeFsError("invalid-path", "Path escaped the workspace.");
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = resolve(current, part);
    const st = lstatSync(current, { throwIfNoEntry: false });
    if (!st) break;
    if (st.isSymbolicLink() && !(allowLeafLink && index === parts.length - 1)) throw new SafeFsError("symlink", "Refusing to follow a symbolic link.");
    if (index < parts.length - 1 && !st.isDirectory()) throw new SafeFsError("invalid-path", "A path component is not a directory.");
  }
  return target;
}
function readFallback(anchor, rel, opts) {
  const target = containedPath(anchor, rel), st = lstatSync(target);
  if (!st.isFile()) throw new SafeFsError("not-regular", "Not a regular file.");
  const fd = openSync(target, O_RDONLY | (O_NOFOLLOW || 0) | (O_NONBLOCK || 0));
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== st.dev || actual.ino !== st.ino) throw new SafeFsError("conflict", "The file changed while opening it.");
    if (actual.size > opts.maxBytes) throw new SafeFsError("too-large", `File exceeds the ${opts.maxBytes}-byte limit.`);
    const data = Buffer.allocUnsafe(actual.size);
    let off = 0;
    while (off < data.length) {
      const n = readSync(fd, data, off, data.length - off, off);
      if (n <= 0) break;
      off += n;
    }
    return opts.encoding ? data.subarray(0, off).toString(opts.encoding) : data.subarray(0, off);
  } finally {
    closeQuietly(fd);
  }
}
function writeFallback(anchor, rel, bytes2, mode, exclusive = false) {
  const target = containedPath(anchor, rel), st = lstatSync(target, { throwIfNoEntry: false });
  if (st && !st.isFile()) throw new SafeFsError("not-regular", "Not a regular file.");
  const fd = openSync(target, O_WRONLY | O_CREAT | (O_NOFOLLOW || 0) | (O_NONBLOCK || 0) | (exclusive ? constants2.O_EXCL : 0), mode);
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || st && (actual.dev !== st.dev || actual.ino !== st.ino)) throw new SafeFsError("conflict", "The file changed while opening it.");
    ftruncateSync(fd, 0);
    let off = 0;
    while (off < bytes2.length) off += writeSync(fd, bytes2, off, bytes2.length - off, off);
  } finally {
    closeQuietly(fd);
  }
}
function listFallback(anchor, rel, max) {
  const dir = containedPath(anchor, rel), out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= max) break;
    if (entry.isSymbolicLink()) continue;
    const st = lstatSync(resolve(dir, entry.name), { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    out.push({ name: entry.name, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
  }
  return out;
}
function statFallback(anchor, rel) {
  const target = containedPath(anchor, rel, true), st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return null;
  return { name: basename(target), size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory(), isFile: st.isFile(), isSymbolicLink: st.isSymbolicLink() };
}
function scanTreeFallback(dir, limits, depth, count) {
  if (depth > limits.maxDepth) throw new SafeFsError("too-large", "Directory tree is too deep to remove.");
  for (const entry of readdirSync(dir)) {
    if (++count.n > limits.maxEntries) throw new SafeFsError("too-large", "Directory tree has too many entries to remove.");
    const full = resolve(dir, entry), st = lstatSync(full);
    if (st.isSymbolicLink()) throw new SafeFsError("symlink", "Refusing to remove a tree that contains a symbolic link.");
    if (st.isDirectory()) scanTreeFallback(full, limits, depth + 1, count);
  }
}
function removeTreeFallback(dir) {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry), st = lstatSync(full);
    if (st.isSymbolicLink()) throw new SafeFsError("symlink", "Refusing to remove a tree that contains a symbolic link.");
    if (st.isDirectory()) removeTreeFallback(full);
    else unlinkSync(full);
  }
  rmdirSync(dir);
}
function rmrfFallback(anchor, rel, limits) {
  const target = containedPath(anchor, rel), st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) throw new SafeFsError("not-found", "No such file or directory.");
  if (st.isSymbolicLink()) throw new SafeFsError("symlink", "Refusing to remove a symbolic link.");
  if (st.isDirectory()) {
    scanTreeFallback(target, limits, 0, { n: 0 });
    removeTreeFallback(target);
  } else unlinkSync(target);
}
function renameFallback(stagingDir, name, anchor, rel) {
  if (components(name).length !== 1) throw new SafeFsError("invalid-path", "Staging name must be a single path component.");
  renameSync(resolve(stagingDir, name), containedPath(anchor, rel));
}
function readInside(anchor, rel, opts) {
  assertTrustedAnchor(anchor);
  const mode = requireMode();
  try {
    return mode === "fd-relative" ? readFd(anchor, rel, opts) : readFallback(anchor, rel, opts);
  } catch (error) {
    throw remap(error);
  }
}
function writeInside(anchor, rel, data, opts) {
  assertTrustedAnchor(anchor);
  const mode = requireMode(), bytes2 = typeof data === "string" ? Buffer.from(data, opts.encoding ?? "utf8") : data;
  if (bytes2.length > opts.maxBytes) throw new SafeFsError("too-large", `Content exceeds the ${opts.maxBytes}-byte limit.`);
  try {
    if (mode === "fd-relative") writeFd(anchor, rel, bytes2, opts.mode ?? 384, opts.exclusive);
    else writeFallback(anchor, rel, bytes2, opts.mode ?? 384, opts.exclusive);
  } catch (error) {
    throw remap(error);
  }
}
function listInside(anchor, rel, opts) {
  assertTrustedAnchor(anchor);
  const mode = requireMode();
  try {
    return mode === "fd-relative" ? listFd(anchor, rel, opts.max) : listFallback(anchor, rel, opts.max);
  } catch (error) {
    throw remap(error);
  }
}
function mkdirInside(anchor, rel) {
  assertTrustedAnchor(anchor);
  const mode = requireMode();
  try {
    if (mode === "fd-relative") mkdirFd(anchor, rel);
    else mkdirSync(containedPath(anchor, rel), { mode: 448 });
  } catch (error) {
    throw remap(error);
  }
}
function rmrfInside(anchor, rel, opts) {
  assertTrustedAnchor(anchor);
  const mode = requireMode();
  try {
    if (mode === "fd-relative") rmrfFd(anchor, rel, opts);
    else rmrfFallback(anchor, rel, opts);
  } catch (error) {
    throw remap(error);
  }
}
function statInside(anchor, rel) {
  assertTrustedAnchor(anchor);
  const mode = requireMode();
  try {
    return mode === "fd-relative" ? statFd(anchor, rel) : statFallback(anchor, rel);
  } catch (error) {
    throw remap(error);
  }
}
function renameIntoInside(stagingDir, name, anchor, rel) {
  assertTrustedAnchor(stagingDir);
  assertTrustedAnchor(anchor);
  const mode = requireMode();
  try {
    if (mode === "fd-relative") renameFd(stagingDir, name, anchor, rel);
    else renameFallback(stagingDir, name, anchor, rel);
  } catch (error) {
    throw remap(error);
  }
}

// runtime/teams.ts
function safeTeamIds(teamIds) {
  return [...new Set(teamIds.map((id) => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Invalid team id.");
    return id;
  }))].sort();
}
function ensureTeamFolders(stateRoot2, teamIds) {
  const ids = safeTeamIds(teamIds);
  for (const path2 of ["teams", ...ids.flatMap((id) => [`teams/${id}`, `teams/${id}/shared`])]) {
    const info = statInside(stateRoot2, path2);
    if (info === null) mkdirInside(stateRoot2, path2);
    else if (!info.isDirectory || info.isSymbolicLink) throw new SafeFsError("symlink", "Team folders must be real directories inside this workspace.");
  }
}

// lib/hermes-pin.ts
var HERMES_RELEASE = "v2026.9.11";
var HERMES_IMAGE_TAG = HERMES_RELEASE.replace(/^v/, "");

// runtime/readiness.ts
import { existsSync, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var releaseImageFile = join2(import.meta.dirname, "release-image.json");
var releaseImage = existsSync(releaseImageFile) ? JSON.parse(readFileSync2(releaseImageFile, "utf8")) : null;
if (releaseImage && (!/^ghcr\.io\/[a-z0-9-]+\/open-harness-hermes@sha256:[a-f0-9]{64}$/.test(releaseImage.ref) || releaseImage.contract !== 11)) throw new Error("The installed runtime image manifest is invalid. Reinstall this signed Open Harness release.");
var HERMES_IMAGE = releaseImage?.ref || process.env.OPEN_HARNESS_HERMES_IMAGE || `open-harness-hermes:${HERMES_IMAGE_TAG}`;
var pullRuntime = Boolean(releaseImage) || process.env.OPEN_HARNESS_HERMES_PULL === "1";
var RUNTIME_CONTRACT = 11;
var RUNTIME_LABEL = "dev.openharness.runtime";
function classifyContract(result) {
  if (result.status !== 0) return "missing";
  return result.stdout.trim() === String(RUNTIME_CONTRACT) ? "current" : "stale";
}
var platform = ["linux", "darwin", "win32"].includes(process.platform) ? process.platform : "unknown";

// runtime/computer-validation.ts
import { accessSync as accessSync2, constants as constants3, existsSync as existsSync2, lstatSync as lstatSync2 } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";

// runtime/host-folders.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { posix as posix2 } from "node:path";
function parseHostFolderMounts(mountinfo) {
  const mounts = /* @__PURE__ */ new Map();
  for (const line of mountinfo.split("\n")) {
    const fields = line.split(" "), path2 = fields[4]?.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    if (!path2?.startsWith("/host-folders/") || !fields.includes("-") || !fields[5]) continue;
    mounts.set(path2, fields[5].split(",").includes("ro") ? "read" : "write");
  }
  return [...mounts].map(([path2, mode]) => ({ path: path2, mode })).sort((a, b) => b.path.length - a.path.length);
}
function hostFolderExports() {
  if (process.env.OPEN_HARNESS_DEPLOYMENT !== "compose") return void 0;
  try {
    return parseHostFolderMounts(readFileSync3("/proc/self/mountinfo", "utf8"));
  } catch {
    return [];
  }
}
function validateFolderExport(path2, mode, exports = hostFolderExports()) {
  if (!exports) return;
  const resolved = posix2.resolve(path2);
  const grant = exports.find((folder) => resolved === folder.path);
  if (!grant) throw new Error("This exact folder has not been shared with Open Harness. Add it to both services in your host-folder Compose override, then select its /host-folders/ path. To select a subfolder, export that subfolder separately.");
  if (mode === "write" && grant.mode === "read") throw new Error(`This folder is shared read-only with Open Harness: ${grant.path}. Choose read-only access for this agent.`);
}

// runtime/computer-validation.ts
function assertSandboxedComputer(computer) {
  if (computer && !isSandboxedComputer(computer)) throw new Error(UNSANDBOXED_COMPUTER_MESSAGE);
}
function sharedFolderSource(value, mode = "read") {
  const source = resolve2(value);
  validateFolderExport(source, mode);
  if (!existsSync2(source)) throw new Error(`Shared folder does not exist on this computer: ${value}`);
  for (let current = source; ; current = dirname2(current)) {
    const info = lstatSync2(current);
    if (info.isSymbolicLink()) throw new Error(`Shared folders cannot contain symbolic links. Select the real folder path: ${value}`);
    if (current === source && !info.isDirectory()) throw new Error(`Shared folder is not a directory: ${value}`);
    if (dirname2(current) === current) break;
  }
  return source;
}
function validateComputerTarget(profile, capabilities2, requiredSecrets = [], hasSecret = () => true) {
  assertSandboxedComputer(profile.computer);
  const issues = [];
  if (profile.computer.access !== "direct" && !capabilities2.container) issues.push("Container execution is unavailable. Install and start Docker, then retry the transfer.");
  if (profile.computer.desktop === "virtual" && !capabilities2.virtualDesktop) issues.push("A private virtual desktop requires a Linux runner with container support.");
  if (profile.computer.access === "folders") {
    for (const folder of profile.computer.folders) {
      try {
        accessSync2(sharedFolderSource(folder.path, folder.mode), constants3.R_OK | (folder.mode === "write" ? constants3.W_OK : 0));
      } catch (error) {
        issues.push(`${folder.path} is not an accessible ${folder.mode === "write" ? "read/write" : "read-only"} folder on this computer.${process.env.OPEN_HARNESS_DEPLOYMENT === "compose" && error instanceof Error ? ` ${error.message}` : ""}`);
      }
    }
  }
  for (const name of [...new Set(requiredSecrets.filter(Boolean))]) if (!hasSecret(name)) issues.push(`Credential ${name} is missing on this computer. Add it in Agent settings, then retry the transfer.`);
  if (issues.length) throw new Error(issues.join(" "));
  return { ok: true };
}

// runtime/folder-mounts.ts
import { randomUUID } from "node:crypto";
import { closeSync as closeSync2, constants as constants4, fstatSync as fstatSync2, openSync as openSync2, readFileSync as readFileSync4 } from "node:fs";
import { resolve as resolve3 } from "node:path";
var NATIVE_FOLDER_GUIDANCE = "Selected host folders require Open Harness and Docker to use the same Linux kernel. Use the local browser Compose installation with explicitly exported folders, or a native Linux runner.";
var BOOT_ID = "/proc/sys/kernel/random/boot_id";
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var CONTAINER_ID = /^[a-f0-9]{64}$/;
var ATTEMPT_LABEL = "open-harness.folder-attempt";
function requiresFolderVerification(computer) {
  return process.env.OPEN_HARNESS_DEPLOYMENT !== "compose" && computer.access === "folders" && computer.folders.length > 0;
}
function pinDirectory(path2) {
  const flags = constants4.O_RDONLY | constants4.O_DIRECTORY | constants4.O_NOFOLLOW;
  let fd = openSync2("/", flags);
  try {
    for (const component of resolve3(path2).split("/").filter(Boolean)) {
      const next = openSync2(`/proc/self/fd/${fd}/${component}`, flags);
      closeSync2(fd);
      fd = next;
    }
    const info = fstatSync2(fd, { bigint: true });
    if (!info.isDirectory()) throw new Error("not a directory");
    return { fd, device: String(info.dev), inode: String(info.ino) };
  } catch (error) {
    closeSync2(fd);
    throw new Error(`Could not safely open selected folder ${path2}. Select an existing directory without symbolic links. ${error instanceof Error ? error.message : ""}`);
  }
}
function pinSelectedFolders(folders) {
  if (process.platform !== "linux") throw new Error(NATIVE_FOLDER_GUIDANCE);
  let bootId;
  try {
    bootId = readFileSync4(BOOT_ID, "utf8").trim();
  } catch {
    throw new Error(NATIVE_FOLDER_GUIDANCE);
  }
  if (!UUID.test(bootId)) throw new Error(NATIVE_FOLDER_GUIDANCE);
  const fds = [], mounts = [];
  const close = () => {
    for (const fd of fds.splice(0)) closeSync2(fd);
  };
  try {
    folders.forEach((folder, index) => {
      const pinned = pinDirectory(folder.path);
      fds.push(pinned.fd);
      mounts.push({ path: `/workspace/mounts/folder-${index + 1}`, device: pinned.device, inode: pinned.inode, readOnly: folder.mode === "read" });
    });
    return { bootId, mounts, close };
  } catch (error) {
    close();
    throw error;
  }
}
var FOLDER_VERIFIER = `import json, os, stat, sys
with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as file:
    boot_id = file.read().strip()
with open('/proc/self/mountinfo', 'rb') as file:
    mountinfo = [line.split(b' ') for line in file]
mounts = []
for path in json.loads(sys.argv[1]):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('Selected mount is not a directory')
    options = [fields[5].split(b',') for fields in mountinfo if len(fields) > 5 and fields[4] == os.fsencode(path)]
    if len(options) != 1 or (b'ro' in options[0]) == (b'rw' in options[0]):
        raise ValueError('Selected mount has no unambiguous access mode')
    # QEMU user mode can report host filesystem flags for a read-only bind; mountinfo records per-mount flags.
    mounts.append({'path': path, 'device': str(info.st_dev), 'inode': str(info.st_ino), 'readOnly': b'ro' in options[0]})
print(json.dumps({'bootId': boot_id, 'mounts': mounts}))
`;
function verifyFolderMounts(pinned, output2) {
  let value;
  try {
    value = JSON.parse(output2);
  } catch {
    throw new Error("Docker returned invalid selected-folder verification. No agent was started.");
  }
  if (!value || value.bootId !== pinned.bootId) throw new Error(NATIVE_FOLDER_GUIDANCE);
  const mounts = value.mounts;
  if (!Array.isArray(mounts) || mounts.length !== pinned.mounts.length) throw new Error("Docker did not verify every selected folder. No agent was started.");
  for (const [index, expected] of pinned.mounts.entries()) {
    const actual = mounts[index];
    if (!actual || actual.path !== expected.path || actual.device !== expected.device || actual.inode !== expected.inode || actual.readOnly !== expected.readOnly) {
      throw new Error(`Docker could not confirm the selected folder and its access mode at ${expected.path}. Re-select the folder and retry. No agent was started.`);
    }
  }
}
async function checkedAsync(command2, args2, timeout, description) {
  const result = await command2(args2, timeout);
  if (result.status !== 0) throw new Error(`${description}: ${result.error?.message || result.stderr.trim() || "Docker did not complete the request."}`);
  return result.stdout.trim();
}
async function createVerifiedFolderContainerAsync(args2, pinned, desktop, command2 = (args3, timeout) => commandAsync("docker", args3, timeout)) {
  const attempt = randomUUID(), name = args2[args2.indexOf("--name") + 1];
  let id = "";
  try {
    id = await checkedAsync(command2, ["create", "--restart", "no", "--entrypoint", "/usr/bin/tini", "--label", `${ATTEMPT_LABEL}=${attempt}`, ...args2, "--", "/bin/sleep", "infinity"], 3e4, "Could not create the selected-folder container");
    if (!CONTAINER_ID.test(id)) {
      id = "";
      throw new Error("Docker did not return a valid selected-folder container ID.");
    }
    await checkedAsync(command2, ["start", id], 2e4, "Could not start the selected-folder container");
    const result = await checkedAsync(command2, ["exec", "--workdir", "/", id, "/usr/local/bin/python", "-I", "-S", "-c", FOLDER_VERIFIER, JSON.stringify(pinned.mounts.map((mount) => mount.path))], 15e3, "Could not verify selected folders");
    verifyFolderMounts(pinned, result);
    if (desktop) await checkedAsync(command2, ["exec", "--workdir", "/", id, "/opt/open-harness/container-init.sh", "--init-only"], 45e3, "Could not initialize the private desktop");
    return id;
  } catch (error) {
    let cleanupError = "";
    try {
      if (!id && name) {
        const inspected = await command2(["inspect", "-f", "{{json .}}", name], 1e4);
        if (inspected.status === 0) {
          const candidate = JSON.parse(inspected.stdout);
          if (candidate?.Config?.Labels?.[ATTEMPT_LABEL] === attempt && CONTAINER_ID.test(candidate.Id)) id = candidate.Id;
        } else if (!/No such (?:object|container)/i.test(inspected.stderr)) throw new Error(inspected.error?.message || inspected.stderr.trim() || "Docker could not check the incomplete creation.");
      }
      if (id) await checkedAsync(command2, ["rm", "-f", id], 2e4, "Could not remove the unverified selected-folder container");
    } catch (failure3) {
      cleanupError = ` Cleanup could not be confirmed: ${failure3 instanceof Error ? failure3.message : failure3}`;
    }
    throw new Error(`${error instanceof Error ? error.message : error}${cleanupError}`);
  } finally {
    pinned.close();
  }
}

// runtime/path-safety.ts
import { closeSync as closeSync3, constants as constants5, fstatSync as fstatSync3, lstatSync as lstatSync3, openSync as openSync3, readFileSync as readFileSync5, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { randomUUID as randomUUID2 } from "node:crypto";
import path from "node:path";
function atomicWorkspaceWrite(target, data) {
  const temporary = `${target}.${randomUUID2()}.tmp`;
  try {
    writeFileSync2(temporary, data, { mode: 384, flag: "wx" });
    renameSync2(temporary, target);
  } finally {
    rmSync2(temporary, { force: true });
  }
}
function readWorkspaceFile(target) {
  const expected = lstatSync3(target);
  if (!expected.isFile()) throw new Error("Workspace path must be a regular file.");
  const fd = openSync3(target, constants5.O_RDONLY | (constants5.O_NOFOLLOW || 0) | (constants5.O_NONBLOCK || 0));
  try {
    const actual = fstatSync3(fd);
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error("Workspace file changed while opening it. Try again.");
    return readFileSync5(fd);
  } finally {
    closeSync3(fd);
  }
}
function resolveContainedPath(root, name, paths2 = path) {
  if (!name || name.includes("\0") || name.includes(":") || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) throw new Error("Invalid workspace path.");
  const parts = name.replaceAll("\\", "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Invalid workspace path.");
  if (parts.some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error("Invalid portable workspace path.");
  const target = paths2.resolve(root, parts.join(paths2.sep));
  const relative4 = paths2.relative(paths2.resolve(root), target);
  if (!relative4 || relative4 === ".." || relative4.startsWith(`..${paths2.sep}`) || paths2.isAbsolute(relative4)) throw new Error("Path escaped the workspace.");
  return target;
}
function safeWorkspacePath(root, name) {
  const target = resolveContainedPath(root, name);
  const parts = path.relative(path.resolve(root), target).split(path.sep);
  let current = path.resolve(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = lstatSync3(current);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Workspace paths cannot contain symbolic links.");
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Workspace parent is not a directory.");
  }
  return target;
}

// runtime/container-admission.ts
import { resolve as resolve4 } from "node:path";
var workspaces = /* @__PURE__ */ new Map();
function workspace(root) {
  const key = resolve4(root);
  let value = workspaces.get(key);
  if (!value) {
    value = { closed: false, pending: /* @__PURE__ */ new Set() };
    workspaces.set(key, value);
  }
  return value;
}
function assertContainerAdmission(root) {
  if (workspace(root).closed) throw new Error("This workspace is stopping. Its computers cannot start until it restarts.");
}
function withContainerAdmission(root, start) {
  try {
    assertContainerAdmission(root);
  } catch (error) {
    return Promise.reject(error);
  }
  const value = workspace(root), operation = Promise.resolve().then(start).finally(() => value.pending.delete(operation));
  value.pending.add(operation);
  return operation;
}
async function closeContainerAdmissions(root) {
  const value = workspace(root);
  value.closed = true;
  await Promise.allSettled([...value.pending]);
}

// runtime/hermes.ts
var FIRST_SETUP_MESSAGE = "Docker is ready, but the pinned Hermes runtime still needs its first-time setup.";
var STALE_IMAGE_MESSAGE = "Docker is ready, but the agent runtime on this computer was built before a fix. Open Settings \u2192 Readiness and update it.";
function authorizeWorkspaceMounts(stateRoot2, computer) {
  if (process.env.OPEN_HARNESS_REQUIRE_RELAY_IDENTITY !== "1" || computer.access !== "folders" || computer.machineId !== "local") return;
  const shared = resolve5(stateRoot2, "shared");
  if (computer.folders.some((folder) => {
    const source = resolve5(folder.path);
    return source !== shared && !source.startsWith(shared + sep2);
  })) throw new Error("Authenticated shared workspaces may mount only their shared files. Upload project files to the workspace or use a private agent computer.");
}
function prepareExecutionDirectories(agentId, stateRoot2) {
  const names = ["shared", ...["profile", "private", "managed"].map((name) => `agents/${agentId}/${name}`)];
  const paths2 = names.map((name) => safeWorkspacePath(stateRoot2, name));
  for (const [index, path2] of paths2.entries()) {
    mkdirSync2(path2, { recursive: true, mode: 448 });
    if (!lstatSync4(safeWorkspacePath(stateRoot2, names[index])).isDirectory()) throw new Error("The managed execution workspace must contain ordinary directories.");
  }
}
function lastWords(stderrTail, keep = 3, limit = 400) {
  const lines = stderrTail.filter((line) => line.trim()).slice(-keep);
  if (!lines.length) return "";
  const text = lines.join(" | ");
  return ` Last output: ${text.length > limit ? `\u2026${text.slice(-limit)}` : text}`;
}
var GATEWAY_ENV = ["-e", "HERMES_GATEWAY_SESSION=1", "-e", "OPEN_HARNESS_RUN_LEASE=/run/open-harness/run-lease.json"];
function hermesApprovalDecision(decision) {
  return decision === "approve" || decision === "once" ? "once" : decision === "session" || decision === "always" ? decision : "deny";
}
var HermesGateway = class extends EventEmitter {
  constructor(container, allowedTools = null, native = null) {
    super();
    this.container = container;
    this.allowedTools = allowedTools;
    this.native = native;
    this.child = null;
    this.requestId = 0;
    this.pending = /* @__PURE__ */ new Map();
    this.mockApproval = null;
    this.mockInput = null;
    this.mockSessions = /* @__PURE__ */ new Map();
    this.stopping = null;
    this.stopped = false;
    // Hermes reports its failures on stderr and then dies. Without a copy, the exit
    // code is all that survives, and "exited with code 1" tells an operator nothing.
    this.stderrTail = [];
  }
  async start() {
    if (this.native) throw new Error(UNSANDBOXED_COMPUTER_MESSAGE);
    if (this.stopping) await this.stopping;
    this.stopped = false;
    if (process.env.OPEN_HARNESS_MOCK === "1") {
      queueMicrotask(() => this.emit("event", { type: "gateway.ready", payload: { mock: true } }));
      return;
    }
    if (this.child && !this.child.killed) return;
    const child = this.child = spawn3("docker", ["exec", "-i", ...GATEWAY_ENV, this.container, "node", "/run/open-harness/gateway-entry.mjs"], { stdio: ["pipe", "pipe", "pipe"] });
    let exited = false;
    const failed = (error) => {
      if (exited) return;
      exited = true;
      for (const pending2 of this.pending.values()) {
        clearTimeout(pending2.timer);
        pending2.reject(error);
      }
      this.pending.clear();
      if (this.child === child) this.child = null;
      this.emit("exit", error);
    };
    child.once("error", (error) => failed(new Error(`Could not start the Hermes ${this.native ? "host" : "container"} gateway: ${error.message}`)));
    child.stdin.on("error", (error) => failed(Object.assign(new Error(`Hermes gateway input failed: ${error.message}`), { interrupted: true })));
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.id != null && this.pending.has(String(value.id))) {
          const pending2 = this.pending.get(String(value.id));
          clearTimeout(pending2.timer);
          this.pending.delete(String(value.id));
          if (value.error) pending2.reject(new Error(value.error.message || JSON.stringify(value.error)));
          else pending2.resolve(value.result);
        } else {
          const event = value.method === "event" ? value.params : value.params?.event ?? value;
          this.emit("event", event);
        }
      } catch {
        this.emit("log", { level: "warn", message: line.slice(0, 1e3) });
      }
    });
    this.stderrTail = [];
    createInterface({ input: child.stderr }).on("line", (line) => {
      const message = line.slice(0, 1e3);
      this.stderrTail.push(message);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
      this.emit("log", { level: "debug", message });
    });
    child.once("exit", (code) => {
      const error = Object.assign(new Error(`Hermes ${this.native ? "host" : "container"} gateway exited with code ${code ?? "unknown"}.${lastWords(this.stderrTail)} Inspect its saved work before retrying.`), { interrupted: true });
      failed(error);
    });
    try {
      await new Promise((resolve8, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          this.off("event", ready);
          this.off("exit", fail);
        };
        const fail = (error) => {
          cleanup();
          reject(error);
        };
        const ready = (event) => {
          if (event?.type === "gateway.ready") {
            cleanup();
            resolve8();
          }
        };
        const timer = setTimeout(() => fail(new Error("Hermes gateway did not become ready.")), 3e4);
        this.on("event", ready);
        this.once("exit", fail);
      });
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new Error(`${error instanceof Error ? error.message : error} Cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`);
      }
      throw error;
    }
  }
  request(method, params = {}, timeout = 3e5) {
    if (process.env.OPEN_HARNESS_MOCK === "1") return this.mockRequest(method, params);
    if (!this.child) return Promise.reject(new Error("Hermes gateway is not running."));
    const id = String(++this.requestId);
    return new Promise((resolve8, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeout);
      this.pending.set(id, { resolve: resolve8, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  submitPrompt(sessionId, text, timeout = 24 * 60 * 60 * 1e3) {
    return new Promise((resolve8, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("event", onEvent);
        this.off("exit", onExit);
      };
      const onExit = (error) => {
        cleanup();
        reject(error);
      };
      const onEvent = (value) => {
        if (value.session_id !== sessionId) return;
        const payload = value.payload || {};
        if (value.type === "error") onExit(new Error(payload.message || "Hermes execution failed."));
        if (value.type === "message.complete") {
          if (payload.status === "error" || payload.status === "interrupted") onExit(Object.assign(new Error(payload.error || payload.text || "Hermes execution was interrupted."), { interrupted: payload.status === "interrupted" }));
          else {
            cleanup();
            resolve8(payload);
          }
        }
      };
      const timer = setTimeout(() => onExit(Object.assign(new Error("Hermes completion was not confirmed. Inspect the session before retrying."), { interrupted: true })), timeout);
      this.on("event", onEvent);
      this.on("exit", onExit);
      this.request("prompt.submit", { session_id: sessionId, text }, timeout).then((result) => {
        if (result?.status !== "streaming") {
          cleanup();
          resolve8(result);
        }
      }, onExit);
    });
  }
  async mockRequest(method, params) {
    if (method === "session.create") {
      const sessionId = crypto.randomUUID();
      this.mockSessions.set(sessionId, Array.isArray(params.messages) ? params.messages : []);
      return { session_id: sessionId };
    }
    if (method === "prompt.submit") {
      const prompt = String(params.text || "");
      if (prompt.includes("MOCK_HISTORY")) return { final_response: JSON.stringify(this.mockSessions.get(String(params.session_id)) || []) };
      if (prompt.includes("MOCK_TOOL:")) {
        const name = prompt.split("MOCK_TOOL:")[1].split(/\s/)[0];
        if (!this.allowedTools?.includes(name)) throw new Error(`Tool ${name} is disabled in this agent profile.`);
      }
      const canUseTerminal = this.allowedTools === null || this.allowedTools.includes("terminal");
      if (canUseTerminal) this.emit("event", { type: "tool.start", payload: { id: "mock-tool", name: "terminal", preview: "python task.py" } });
      if (prompt.includes("MOCK_SLOW")) await new Promise((resolve8) => setTimeout(resolve8, 800));
      if (prompt.includes("MOCK_APPROVAL")) {
        this.emit("event", { type: "approval.request", payload: { request_id: "mock-approval", command: "publish mock result" } });
        const decision = await new Promise((resolve8) => {
          this.mockApproval = resolve8;
        });
        if (decision === "deny") throw new Error("Mock action was denied.");
      }
      if (prompt.includes("MOCK_CLARIFY")) {
        this.emit("event", { type: "clarify.request", session_id: params.session_id, payload: { request_id: "mock-clarify", question: "What should I use?" } });
        const answer = await new Promise((resolve8) => {
          this.mockInput = resolve8;
        });
        return { final_response: `Hermes mock completed the task. Answer: ${Array.isArray(answer) ? answer.join(", ") : String(answer)}` };
      }
      if (canUseTerminal) this.emit("event", { type: "tool.complete", payload: { id: "mock-tool", name: "terminal", result: "Created and executed task.py" } });
      this.emit("event", { type: "message.delta", payload: { text: "Hermes mock completed the task." } });
      return { final_response: "Hermes mock completed the task." };
    }
    if (method === "approval.respond") {
      this.mockApproval?.(String(params.choice));
      this.mockApproval = null;
      return { resolved: 1 };
    }
    if (method === "clarify.respond") {
      this.mockInput?.(params.answer);
      this.mockInput = null;
      return { ok: true };
    }
    if (["session.steer", "session.interrupt", "process.stop"].includes(method)) return { ok: true };
    return { ok: true };
  }
  stop() {
    if (this.stopped) return Promise.resolve();
    return this.stopping ??= this.stopRuntime().finally(() => {
      this.stopping = null;
    });
  }
  async stopRuntime() {
    if (process.env.OPEN_HARNESS_MOCK !== "1" && !this.native) await new Promise((resolve8, reject) => {
      const child = spawn3("docker", ["stop", "--time", "2", this.container], { stdio: "ignore", timeout: 1e4, killSignal: "SIGKILL" });
      child.once("error", () => reject(new Error("Could not stop the agent container. Check Docker.")));
      child.once("exit", (code) => code === 0 ? resolve8() : reject(new Error("Docker could not confirm the agent container stopped.")));
    });
    this.mockApproval?.("deny");
    this.mockApproval = null;
    this.mockInput?.("");
    this.mockInput = null;
    this.child?.kill("SIGTERM");
    this.child = null;
    this.stopped = true;
    this.emit("exit", Object.assign(new Error("Agent runtime stopped."), { interrupted: true }));
  }
};
async function execDocker(args2, timeout) {
  const result = await commandAsync("docker", args2, timeout);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr || result.error?.message || "" };
}
function containerSignature(selected, imageId, stateRoot2 = "", teamIds = [], agentId = "") {
  return createHash("sha256").update(JSON.stringify({ role: "execution-v1", ...safeTeamIds(teamIds).length ? { teamIds: safeTeamIds(teamIds) } : {}, ...(selected.network?.mode ?? DEFAULT_NETWORK.mode) !== DEFAULT_NETWORK.mode || selected.network?.allow.length ? { network: selected.network } : {}, ...agentId.length > 48 ? { agentId } : {}, access: selected.access, folders: selected.folders, desktop: selected.desktop, resources: selected.resources, ...selected.browserSessionTeamId ? { browserSessionTeamId: selected.browserSessionTeamId, machineId: selected.machineId } : {}, imageId, stateRoot: stateRoot2 && resolve5(stateRoot2), ...requiresFolderVerification(selected) ? { folderStartup: "verified-inert-v1" } : {} })).digest("hex").slice(0, 24);
}
var imageIdCache = null;
var MANAGED_LABEL = "open-harness.managed";
var STATE_LABEL = "open-harness.state";
function containerStateKey(stateRoot2) {
  return createHash("sha256").update(resolve5(stateRoot2)).digest("hex").slice(0, 24);
}
function containerNameFor(agentId) {
  return `open-harness-${agentId.replace(/[^a-zA-Z0-9_.-]/g, "-")}`;
}
function teamMountArgs(stateRoot2, teamIds) {
  return safeTeamIds(teamIds).flatMap((id) => ["-v", `${safeWorkspacePath(stateRoot2, `teams/${id}/shared`)}:/workspace/teams/${id}`]);
}
function agentContainerNames(agentId, stateRoot2) {
  const safe = agentId.replace(/[^a-zA-Z0-9_.-]/g, "-"), base = containerNameFor(agentId);
  return { safe, names: [base, `${base}-${containerStateKey(stateRoot2).slice(0, 12)}`] };
}
function inspectedContainer(code, stdout, stderr, name) {
  if (code !== 0) {
    if (/No such (?:object|container)/i.test(stderr)) return null;
    throw new Error(stderr.trim() || `Docker could not inspect agent container ${name}. Check the Docker daemon.`);
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`Docker returned invalid details for agent container ${name}.`);
  }
  if (!value?.Id || !value.State || !value.Config) throw new Error(`Docker returned incomplete details for agent container ${name}.`);
  return value;
}
function ownsContainer(container, safe, stateRoot2) {
  const labels = container.Config.Labels || {};
  if (labels[MANAGED_LABEL] !== "1") return false;
  if (labels[STATE_LABEL] !== void 0) return labels[STATE_LABEL] === containerStateKey(stateRoot2);
  const expected = /* @__PURE__ */ new Map([
    ["/run/open-harness", join3(stateRoot2, "agents", safe, "managed")],
    ["/home/hermes/.hermes", join3(stateRoot2, "agents", safe, "profile")],
    ["/workspace/private", join3(stateRoot2, "agents", safe, "private")],
    ["/workspace/shared", join3(stateRoot2, "shared")]
  ]);
  return [...expected].every(([destination, source]) => container.Mounts?.some((mount) => mount.Destination === destination && resolve5(mount.Source) === resolve5(source)));
}
async function runningAgentContainer(agentId, stateRoot2) {
  const { safe, names } = agentContainerNames(agentId, stateRoot2);
  for (const name of names) {
    const result = await execDocker(["inspect", "-f", "{{json .}}", name], 5e3);
    const container = inspectedContainer(result.code, result.stdout, result.stderr, name);
    if (container?.State.Running && ownsContainer(container, safe, stateRoot2)) return container.Id;
  }
  return null;
}
async function stopAgentContainers(agentId, stateRoot2) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return;
  const { safe, names } = agentContainerNames(agentId, stateRoot2);
  for (const name of names) {
    const result = await execDocker(["inspect", "-f", "{{json .}}", name], 1e4);
    const container = inspectedContainer(result.code, result.stdout, result.stderr, name);
    if (!container || !ownsContainer(container, safe, stateRoot2) || !container.State.Running) continue;
    const stopped2 = await execDocker(["stop", "--time", "2", container.Id], 1e4);
    if (stopped2.code !== 0) throw new Error(stopped2.stderr.trim() || `Docker could not stop agent container ${name}.`);
  }
}
async function stopManagedContainers(stateRoot2) {
  const result = { stopped: [], failures: [] };
  if (process.env.OPEN_HARNESS_MOCK === "1") return result;
  const listed = await execDocker(["ps", "-q", "--filter", `label=${MANAGED_LABEL}=1`, "--filter", `label=${STATE_LABEL}=${containerStateKey(stateRoot2)}`], 5e3);
  if (listed.code !== 0) {
    result.failures.push(listed.stderr.trim() || "Docker could not list this workspace\u2019s agent containers.");
    return result;
  }
  const ids = listed.stdout.split("\n").map((id) => id.trim()).filter(Boolean);
  await Promise.all(ids.map(async (id) => {
    const stopped2 = await execDocker(["stop", "--time", "8", id], 15e3);
    if (stopped2.code === 0) result.stopped.push(id);
    else result.failures.push(`${id}: ${stopped2.stderr.trim() || "Docker could not confirm the container stopped."}`);
  }));
  return result;
}
async function imageContractAsync() {
  const result = await commandAsync("docker", ["image", "inspect", "-f", `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE], 1e4);
  return classifyContract(result);
}
async function currentImageIdAsync() {
  if (imageIdCache && Date.now() - imageIdCache.at < 5e3) return imageIdCache.id;
  const result = await commandAsync("docker", ["image", "inspect", "-f", "{{.Id}}", HERMES_IMAGE], 1e4);
  imageIdCache = { id: result.status === 0 ? result.stdout.trim() : "", at: Date.now() };
  return imageIdCache.id;
}
async function inspectContainerAsync(name) {
  const result = await commandAsync("docker", ["inspect", "-f", "{{json .}}", name], 1e4);
  return inspectedContainer(result.status, result.stdout, result.stderr, name);
}
var asyncSharing = /* @__PURE__ */ new Map();
function stateSharingAsync(stateRoot2) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return Promise.resolve({ ok: true, detail: "Deterministic test runtime shares state directly." });
  const root = resolve5(stateRoot2), cached = asyncSharing.get(root);
  if (cached && Date.now() - cached.at < 6e4) return cached.value;
  const value = (async () => {
    try {
      const dir = join3(root, ".mount-probe"), token = randomUUID3();
      mkdirSync2(dir, { recursive: true });
      const canary = `canary-${token}`;
      writeFileSync3(join3(dir, canary), token, { mode: 420 });
      try {
        const result = await commandAsync("docker", ["run", "--rm", "--user", `${process.getuid?.() ?? 1e3}:${process.getgid?.() ?? 1e3}`, "-v", `${dir}:/probe:ro`, HERMES_IMAGE, "cat", `/probe/${canary}`], 6e4);
        return result.status === 0 && result.stdout.trim() === token ? { ok: true, detail: "Docker can read the Open Harness data folder." } : { ok: false, detail: "Docker cannot read the Open Harness data folder. Add it to Docker file sharing or choose a shared data folder before running work." };
      } finally {
        try {
          unlinkSync2(join3(dir, canary));
        } catch {
        }
      }
    } catch {
      return { ok: false, detail: "Open Harness could not verify Docker access to its data folder." };
    }
  })();
  asyncSharing.set(root, { at: Date.now(), value });
  return value;
}
function ensureContainerAsync(agentId, stateRoot2, computer, fresh = false, teamIds = [], isBusy = () => false) {
  return withContainerAdmission(stateRoot2, () => startExecutionContainer(agentId, stateRoot2, computer, fresh, teamIds, isBusy));
}
async function startExecutionContainer(agentId, stateRoot2, computer, fresh = false, teamIds = [], isBusy = () => false) {
  teamIds = safeTeamIds(teamIds);
  assertSandboxedComputer(computer);
  if (computer) authorizeWorkspaceMounts(stateRoot2, computer);
  if (process.env.OPEN_HARNESS_MOCK === "1") return `mock-${agentId}`;
  const sharing = await stateSharingAsync(stateRoot2);
  if (!sharing.ok) throw new Error(sharing.detail);
  const contract = await imageContractAsync();
  if (contract !== "current") throw new Error(contract === "missing" ? FIRST_SETUP_MESSAGE : STALE_IMAGE_MESSAGE);
  const { safe, names } = agentContainerNames(agentId, stateRoot2);
  prepareExecutionDirectories(safe, stateRoot2);
  const selected = computer || { machineId: "local", access: "private", folders: [], desktop: "none", reserveMachine: false, network: DEFAULT_NETWORK, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } };
  ensureTeamFolders(stateRoot2, teamIds);
  const mounts = teamMountArgs(stateRoot2, teamIds);
  if (selected.access === "folders") selected.folders.forEach((folder, index) => {
    const source = sharedFolderSource(folder.path, folder.mode);
    mounts.push("-v", `${source}:/workspace/mounts/folder-${index + 1}${folder.mode === "read" ? ":ro" : ""}`);
  });
  const pinned = requiresFolderVerification(selected) ? pinSelectedFolders(selected.folders) : null;
  try {
    const signature2 = containerSignature(selected, await currentImageIdAsync(), stateRoot2, teamIds, agentId);
    let name = names[0], container = await inspectContainerAsync(name);
    if (!container || !ownsContainer(container, safe, stateRoot2)) {
      const alternate = await inspectContainerAsync(names[1]);
      if (alternate && !ownsContainer(alternate, safe, stateRoot2)) throw new Error(`Agent container ${names[1]} belongs to another workspace. Choose a different agent ID or remove the conflicting container yourself.`);
      if (container || alternate) {
        name = names[1];
        container = alternate;
      }
    }
    if (container) {
      if (fresh || pinned || container.Config.Labels?.["open-harness.config"] !== signature2 || !container.Config.Labels?.[STATE_LABEL]) {
        if (isBusy()) throw new Error("This agent is busy. Wait for its work to finish before updating its computer.");
        const removed = await commandAsync("docker", ["rm", "-f", container.Id], 2e4);
        if (removed.status !== 0) throw new Error(removed.stderr?.trim() || "Could not replace the previous agent container. Check the Docker daemon.");
      } else if (!container.State.Running) {
        const started = await commandAsync("docker", ["start", container.Id], 2e4);
        if (started.status !== 0) throw new Error(started.error?.code === "ETIMEDOUT" ? "Docker did not respond within 20s. Check the Docker daemon." : started.stderr.trim() || "Could not start the agent container.");
        return container.Id;
      } else return container.Id;
    }
    const profile = `${stateRoot2}/agents/${safe}/profile`, privateDir = `${stateRoot2}/agents/${safe}/private`, shared = `${stateRoot2}/shared`;
    const args2 = [
      "--name",
      name,
      "--label",
      "open-harness.role=execution",
      "--label",
      `open-harness.config=${signature2}`,
      "--label",
      `${MANAGED_LABEL}=1`,
      "--label",
      `${STATE_LABEL}=${containerStateKey(stateRoot2)}`,
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--pids-limit",
      "512",
      "--memory",
      `${Math.round(selected.resources.memoryMb)}m`,
      "--cpus",
      String(selected.resources.cpu),
      "--add-host",
      "host.docker.internal:host-gateway",
      "--user",
      `${process.getuid?.() || 1e3}:${process.getgid?.() || 1e3}`,
      "-e",
      "HOME=/workspace/private",
      "-e",
      "OPEN_HARNESS_RUNTIME_ROLE=execution",
      "-e",
      "DISPLAY=",
      "-e",
      "DBUS_SESSION_BUS_ADDRESS=",
      "-e",
      "OPEN_HARNESS_VIRTUAL_DESKTOP=0",
      "-v",
      `${stateRoot2}/agents/${safe}/managed:/run/open-harness:ro`,
      "-v",
      `${profile}:/home/hermes/.hermes`,
      "-v",
      `${privateDir}:/workspace/private`,
      "-v",
      `${shared}:/workspace/shared`,
      ...mounts,
      HERMES_IMAGE
    ];
    if (pinned) return await createVerifiedFolderContainerAsync(args2, pinned, false);
    const run2 = await commandAsync("docker", ["run", "-d", "--restart", "unless-stopped", ...args2], 3e4);
    if (run2.status !== 0) throw new Error(run2.error?.code === "ETIMEDOUT" ? "Docker did not respond within 30s. Check the Docker daemon." : run2.stderr.trim() || "Could not create the private agent workspace. Open Readiness in Settings and finish setup.");
    const created = await inspectContainerAsync(name);
    if (!created?.State.Running || !ownsContainer(created, safe, stateRoot2)) throw new Error("Docker did not confirm the private execution container started.");
    return created.Id;
  } finally {
    pinned?.close();
  }
}
async function runtimeImageIdentity() {
  if (process.env.OPEN_HARNESS_MOCK === "1") return "mock-image";
  const result = await commandAsync("docker", ["image", "inspect", "-f", "{{.Id}}", HERMES_IMAGE], 5e3);
  if (result.status !== 0) throw new Error("The agent runtime image is unavailable.");
  return result.stdout.trim();
}

// runtime/transfer-files.ts
import { createHash as createHash3, randomUUID as randomUUID5 } from "node:crypto";
import { existsSync as existsSync4, lstatSync as lstatSync6, mkdirSync as mkdirSync3, mkdtempSync as mkdtempSync2, readdirSync as readdirSync3, renameSync as renameSync3, rmSync as rmSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { dirname as dirname4, join as join5, relative as relative2 } from "node:path";

// runtime/computer-runtime.ts
import { createHash as createHash2, randomUUID as randomUUID4 } from "node:crypto";
import { cp, mkdir, open, rename } from "node:fs/promises";
import { constants as constants6, existsSync as existsSync3, lstatSync as lstatSync5, readdirSync as readdirSync2, rmSync as rmSync3 } from "node:fs";
import { dirname as dirname3, join as join4, relative, resolve as resolve6, sep as sep3 } from "node:path";
var ROLE_LABEL = "open-harness.role";
var RESOURCE_LABEL = "open-harness.computer";
var locks = /* @__PURE__ */ new Set(["SingletonLock", "SingletonSocket", "SingletonCookie"]);
var pending = /* @__PURE__ */ new Map();
function validate(agentId, computer) {
  assertSandboxedComputer(computer);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(agentId) || computer.desktop !== "virtual") throw new Error("Choose an agent with a private desktop.");
  if (computer.browserSessionTeamId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(computer.browserSessionTeamId)) throw new Error("Shared browser configuration is invalid.");
}
function desktopResourceKey(agentId, stateRoot2, computer) {
  validate(agentId, computer);
  return createHash2("sha256").update(JSON.stringify([containerStateKey(stateRoot2), computer.machineId, computer.browserSessionTeamId ? "team" : "agent", computer.browserSessionTeamId || agentId])).digest("hex").slice(0, 32);
}
function desktopResourcePaths(agentId, stateRoot2, computer) {
  const key = desktopResourceKey(agentId, stateRoot2, computer), base = safeWorkspacePath(stateRoot2, `computers/${key}`);
  return { key, name: `open-harness-desktop-${key}`, base, home: safeWorkspacePath(stateRoot2, `computers/${key}/home`), browser: safeWorkspacePath(stateRoot2, `computers/${key}/home/.config/chromium`), staging: safeWorkspacePath(stateRoot2, `computers/${key}/staging`), backup: safeWorkspacePath(stateRoot2, `computers/${key}/legacy-browser-backup`), archive: safeWorkspacePath(stateRoot2, `computers/${key}/legacy-browser-source`), migration: safeWorkspacePath(stateRoot2, `computers/${key}/migration.json`) };
}
function signature(key, image) {
  return createHash2("sha256").update(JSON.stringify({ role: "desktop-v1", key, image })).digest("hex").slice(0, 24);
}
function owned(value, stateRoot2, key) {
  const labels = value.Config.Labels || {};
  return labels[MANAGED_LABEL] === "1" && labels[STATE_LABEL] === containerStateKey(stateRoot2) && labels[ROLE_LABEL] === "desktop" && labels[RESOURCE_LABEL] === key;
}
async function inspect(id) {
  const result = await commandAsync("docker", ["inspect", "-f", "{{json .}}", id], 1e4);
  if (result.status !== 0) {
    if (/No such (?:object|container)/i.test(result.stderr)) return null;
    throw new Error("Docker could not inspect this private desktop. Check the computer connection.");
  }
  let value;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new Error("Docker returned invalid private desktop details.");
  }
  if (!value?.Id || typeof value.State?.Running !== "boolean" || !value.Config) throw new Error("Docker returned incomplete private desktop details.");
  return value;
}
function legacyBrowser(agentId, stateRoot2, computer) {
  const path2 = computer.browserSessionTeamId ? `browser-sessions/${createHash2("sha256").update(JSON.stringify([computer.browserSessionTeamId, computer.machineId])).digest("hex").slice(0, 32)}` : `agents/${agentId}/private/.config/chromium`;
  return safeWorkspacePath(stateRoot2, path2);
}
async function assertLegacyIdle(source, stateRoot2) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return;
  const listed = await commandAsync("docker", ["ps", "-q", "--filter", `label=${MANAGED_LABEL}=1`, "--filter", `label=${STATE_LABEL}=${containerStateKey(stateRoot2)}`], 1e4);
  if (listed.status !== 0) throw new Error("Docker could not confirm the old browser is idle. Stop its agent before migrating the desktop.");
  for (const id of listed.stdout.trim().split(/\s+/).filter(Boolean)) {
    const value = await inspect(id);
    if (!value?.State.Running) continue;
    if (value.Mounts?.some((mount) => {
      const path2 = relative(resolve6(mount.Source), resolve6(source));
      return path2 === "" || path2 !== ".." && !path2.startsWith(`..${sep3}`) && !path2.startsWith(sep3);
    })) throw new Error("Stop agents using the old browser before migrating the private desktop. Its browser profile has not been changed.");
  }
}
function checkBrowserTree(path2) {
  const stat = lstatSync5(path2);
  if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || !stat.isDirectory() && !stat.isFile()) throw new Error("The saved browser profile contains an unsupported link or special file. It has not been migrated.");
  if (stat.isDirectory()) {
    for (const name of readdirSync2(path2)) if (!locks.has(name)) checkBrowserTree(join4(path2, name));
  }
}
async function copyBrowser(source, target) {
  if (!lstatSync5(source).isDirectory()) throw new Error("The saved browser profile is not a directory. It has not been migrated.");
  checkBrowserTree(source);
  await cp(source, target, { recursive: true, dereference: false, force: false, errorOnExist: true, filter: (path2) => !locks.has(path2.split(sep3).at(-1) || "") });
  checkBrowserTree(target);
}
async function browserFingerprint(path2) {
  checkBrowserTree(path2);
  const digest2 = createHash2("sha256");
  const visit = async (directory) => {
    for (const name of readdirSync2(directory).sort()) {
      if (locks.has(name)) continue;
      const file = join4(directory, name), info = lstatSync5(file);
      digest2.update(JSON.stringify([relative(path2, file), info.isDirectory() ? "directory" : "file"]));
      if (info.isDirectory()) await visit(file);
      else {
        const content = createHash2("sha256"), handle = await open(file, constants6.O_RDONLY | (constants6.O_NOFOLLOW || 0));
        try {
          for await (const chunk of handle.createReadStream()) content.update(chunk);
        } finally {
          await handle.close();
        }
        digest2.update(content.digest());
      }
    }
  };
  await visit(path2);
  return digest2.digest("hex");
}
async function migrateBrowser(agentId, stateRoot2, computer) {
  const paths2 = desktopResourcePaths(agentId, stateRoot2, computer);
  if (existsSync3(paths2.migration)) {
    let saved;
    try {
      saved = JSON.parse(readWorkspaceFile(paths2.migration).toString("utf8"));
    } catch {
      throw new Error("The private desktop migration record is unreadable. Restore it before starting the computer.");
    }
    if (![1, 2].includes(saved.version) || saved.resourceKey !== paths2.key || !existsSync3(paths2.browser) || !lstatSync5(paths2.browser).isDirectory()) throw new Error("The private desktop migration is incomplete. Restore its browser backup before starting the computer.");
    if (saved.version === 2) return;
    const source2 = legacyBrowser(agentId, stateRoot2, computer), recordedSource = relative(stateRoot2, source2);
    if (saved.source === recordedSource && existsSync3(source2)) {
      await assertLegacyIdle(source2, stateRoot2);
      if (saved.backup !== relative(stateRoot2, paths2.backup) || !existsSync3(paths2.backup) || existsSync3(paths2.archive) || await browserFingerprint(source2) !== await browserFingerprint(paths2.backup)) throw new Error("The old browser folder changed after migration. Keep both copies and resolve its migration record before starting the computer. No agent files were removed.");
      atomicWorkspaceWrite(paths2.migration, JSON.stringify({ version: 0, resourceKey: paths2.key, source: recordedSource, archive: relative(stateRoot2, paths2.archive), backup: saved.backup, previousMigration: saved }));
      await rename(source2, paths2.archive);
      saved.archive = relative(stateRoot2, paths2.archive);
    } else if (saved.source === "agent-transfer" && existsSync3(source2) || saved.source !== null && saved.source !== "agent-transfer" && saved.source !== recordedSource) throw new Error("The old browser migration source is ambiguous. Restore its migration record before starting the computer.");
    atomicWorkspaceWrite(paths2.migration, JSON.stringify({ ...saved, version: 2 }));
    return;
  }
  const source = legacyBrowser(agentId, stateRoot2, computer);
  if (existsSync3(paths2.browser) || existsSync3(paths2.backup) || existsSync3(paths2.archive)) throw new Error("The private desktop migration is incomplete. Preserve its browser copies and restore the migration record before starting the computer.");
  const hasSource = existsSync3(source);
  if (hasSource) {
    await assertLegacyIdle(source, stateRoot2);
    checkBrowserTree(source);
    if (!lstatSync5(source).isDirectory()) throw new Error("The saved browser profile is not a directory. It has not been migrated.");
  }
  await mkdir(dirname3(paths2.browser), { recursive: true, mode: 448 });
  const temporary = safeWorkspacePath(stateRoot2, `computers/${paths2.key}/migration-${randomUUID4()}`);
  try {
    const record2 = { resourceKey: paths2.key, source: hasSource ? relative(stateRoot2, source) : null, archive: hasSource ? relative(stateRoot2, paths2.archive) : null, backup: hasSource ? relative(stateRoot2, paths2.backup) : null };
    atomicWorkspaceWrite(paths2.migration, JSON.stringify({ version: 0, ...record2 }));
    if (hasSource) {
      await rename(source, paths2.archive);
      await copyBrowser(paths2.archive, temporary);
      await rename(temporary, paths2.backup);
      await copyBrowser(paths2.backup, temporary);
      await rename(temporary, paths2.browser);
    } else await mkdir(paths2.browser, { recursive: true, mode: 448 });
    atomicWorkspaceWrite(paths2.migration, JSON.stringify({ version: 2, ...record2, migratedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } finally {
    rmSync3(temporary, { recursive: true, force: true });
  }
}
function desktopContainerArguments(agentId, stateRoot2, computer, imageId) {
  const paths2 = desktopResourcePaths(agentId, stateRoot2, computer);
  return [
    "--name",
    paths2.name,
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${STATE_LABEL}=${containerStateKey(stateRoot2)}`,
    "--label",
    `${ROLE_LABEL}=desktop`,
    "--label",
    `${RESOURCE_LABEL}=${paths2.key}`,
    "--label",
    `open-harness.config=${signature(paths2.key, imageId)}`,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--pids-limit",
    "256",
    "--memory",
    "1024m",
    "--cpus",
    "1",
    "--user",
    `${process.getuid?.() || 1e3}:${process.getgid?.() || 1e3}`,
    "-e",
    "OPEN_HARNESS_RUNTIME_ROLE=desktop",
    "-e",
    "OPEN_HARNESS_VIRTUAL_DESKTOP=1",
    "-e",
    "DISPLAY=:99",
    "-e",
    "HOME=/workspace/desktop",
    "-e",
    "HERMES_HOME=/workspace/desktop/.hermes",
    "-e",
    "AGENT_BROWSER_PROFILE=/workspace/desktop/.config/chromium",
    "-e",
    "OPEN_HARNESS_DOWNLOAD_DIR=/workspace/exchange/downloads",
    "--workdir",
    "/workspace/desktop",
    "-v",
    `${paths2.home}:/workspace/desktop`,
    "-v",
    `${paths2.staging}:/workspace/exchange`,
    HERMES_IMAGE
  ];
}
function ensureDesktopContainerAsync(agentId, stateRoot2, computer) {
  return withContainerAdmission(stateRoot2, () => startDesktopContainer(agentId, stateRoot2, computer));
}
async function startDesktopContainer(agentId, stateRoot2, computer) {
  const paths2 = desktopResourcePaths(agentId, stateRoot2, computer);
  if (process.env.OPEN_HARNESS_MOCK === "1") return `mock-desktop-${paths2.key}`;
  const existing = pending.get(paths2.key);
  if (existing) return existing;
  const operation = (async () => {
    const shared = await stateSharingAsync(stateRoot2);
    if (!shared.ok) throw new Error(shared.detail);
    if (await imageContractAsync() !== "current") throw new Error("Update the pinned runtime before opening the continuous private desktop.");
    const image = await runtimeImageIdentity();
    let value = await inspect(paths2.name);
    if (value && !owned(value, stateRoot2, paths2.key)) throw new Error("The private desktop container belongs to another workspace. It has not been changed.");
    if (value && value.Config.Labels?.["open-harness.config"] !== signature(paths2.key, image)) {
      if (value.State.Running) throw new Error("The private desktop needs a runtime update. Stop the computer before replacing its live browser.");
      const removed = await commandAsync("docker", ["rm", value.Id], 2e4);
      if (removed.status !== 0) throw new Error("Docker could not replace the stopped private desktop.");
      value = null;
    }
    await migrateBrowser(agentId, stateRoot2, computer);
    if (value?.State.Running) return value.Id;
    await mkdir(paths2.staging, { recursive: true, mode: 448 });
    if (value) {
      const started = await commandAsync("docker", ["start", value.Id], 2e4);
      if (started.status !== 0) throw new Error("The private desktop could not start. Check Docker.");
    } else {
      const started = await commandAsync("docker", ["run", "-d", "--restart", "unless-stopped", ...desktopContainerArguments(agentId, stateRoot2, computer, image)], 3e4);
      if (started.status !== 0) throw new Error("The private desktop could not be created. Check Docker and its available memory.");
    }
    const ready = await inspect(value?.Id || paths2.name);
    if (!ready?.State.Running || !owned(ready, stateRoot2, paths2.key)) throw new Error("Docker did not confirm the private desktop started.");
    return ready.Id;
  })();
  pending.set(paths2.key, operation);
  try {
    return await operation;
  } finally {
    if (pending.get(paths2.key) === operation) pending.delete(paths2.key);
  }
}
async function runningDesktopContainer(agentId, stateRoot2, computer) {
  const paths2 = desktopResourcePaths(agentId, stateRoot2, computer);
  if (process.env.OPEN_HARNESS_MOCK === "1") return `mock-desktop-${paths2.key}`;
  const value = await inspect(paths2.name);
  if (value && !owned(value, stateRoot2, paths2.key)) throw new Error("The private desktop container belongs to another workspace.");
  return value?.State.Running ? value.Id : null;
}
async function stopDesktopContainer(agentId, stateRoot2, computer) {
  const paths2 = desktopResourcePaths(agentId, stateRoot2, computer);
  if (process.env.OPEN_HARNESS_MOCK === "1") return;
  const value = await inspect(paths2.name);
  if (!value) return;
  if (!owned(value, stateRoot2, paths2.key)) throw new Error("The private desktop container belongs to another workspace. It has not been stopped.");
  if (!value.State.Running) return;
  const closed = await commandAsync("docker", ["exec", value.Id, "python", "/opt/open-harness/browser_shutdown.py"], 12e3);
  if (closed.status !== 0) throw new Error("The private browser could not close normally. Check it for a confirmation before moving this agent; its profile has not been transferred.");
  const stopped2 = await commandAsync("docker", ["stop", "--time", "8", value.Id], 15e3);
  if (stopped2.status !== 0 || (await inspect(value.Id))?.State.Running) throw new Error("Docker could not confirm the private desktop stopped.");
}
async function stopAgentComputer(agentId, stateRoot2, computer) {
  await stopAgentContainers(agentId, stateRoot2);
  if (computer.desktop === "virtual") await stopDesktopContainer(agentId, stateRoot2, computer);
}

// runtime/transfer-files.ts
var AGENT_TRANSFER_CLEAR_LIMIT = 8e7;
var AGENT_TRANSFER_WIRE_LIMIT = 112 * 1024 * 1024;
var browserBytes = 5e7;
var maxEntries = 1e4;
var legacyPrefix = "private/.config/chromium/";
var volatileBrowser = /* @__PURE__ */ new Set(["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort", "Cache", "Code Cache", "GPUCache", "DawnCache", "GrShaderCache", "ShaderCache", "GraphiteDawnCache", "BrowserMetrics", "Crashpad", "Crash Reports"]);
var memoryFiles = ["profile/MEMORY.md", "profile/USER.md", "profile/memories/MEMORY.md", "profile/memories/USER.md"];
var allowedRoots = ["private", ...memoryFiles, "profile/skills"];
function digest(data) {
  return createHash3("sha256").update(data).digest("hex");
}
function manifest(files) {
  return [...files].sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}:${file.checksum}`).join("\n");
}
function bundleDigest(bundle) {
  return digest(manifest(bundle.files) + (bundle.browser ? `
@desktop-browser-v1:${bundle.browser.checksum}` : ""));
}
function exportFiles(stateRoot2, agentId, omitLegacy = false) {
  const agentRoot = safeWorkspacePath(stateRoot2, `agents/${agentId}`), files = [];
  let total = 0, entries2 = 0;
  const visit = (rel, depth) => {
    if (omitLegacy && rel === "private/.config/chromium") return;
    try {
      const stat = statInside(agentRoot, rel);
      if (!stat || stat.isSymbolicLink) return;
      if (++entries2 > maxEntries) throw new Error("Managed agent data has too many entries to transfer.");
      if (stat.isDirectory) {
        if (depth > 32) throw new Error("Managed agent data exceeds the transfer depth limit of 32.");
        const children = listInside(agentRoot, rel, { max: maxEntries + 1 });
        if (children.length > maxEntries) throw new Error("Managed agent directory exceeds the transfer limit of 10000 entries.");
        for (const child of children) visit(`${rel}/${child.name}`, depth + 1);
        return;
      }
      if (!stat.isFile) return;
      safeWorkspacePath(stateRoot2, `agents/${agentId}/${rel}`);
      const data = readInside(agentRoot, rel, { maxBytes: 2e7 - total });
      total += data.length;
      files.push({ path: rel, data: data.toString("base64"), checksum: digest(data) });
    } catch (error) {
      if (error instanceof SafeFsError) {
        if (["not-found", "not-regular"].includes(error.code)) return;
        if (error.code === "symlink") error.message = "Workspace paths cannot contain symbolic links.";
        if (error.code === "too-large") throw new Error("Managed agent data exceeds the 20 MB transfer limit. Move large project files through an explicitly shared folder.");
      }
      throw error;
    }
  };
  for (const path2 of allowedRoots) visit(path2, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, checksum: digest(manifest(files)) };
}
function validateBundle(stateRoot2, agentId, bundle) {
  if (!bundle || !Array.isArray(bundle.files) || bundle.files.length > maxEntries || typeof bundle.checksum !== "string") throw new Error("Invalid transfer bundle.");
  safeWorkspacePath(stateRoot2, `agents/${agentId}`);
  let total = 0;
  const seen = /* @__PURE__ */ new Set();
  const files = bundle.files.map((file) => {
    if (!file || typeof file.path !== "string" || file.path.length > 1024 || typeof file.data !== "string" || typeof file.checksum !== "string") throw new Error("Invalid transfer file.");
    const clean = file.path.replaceAll("\\", "/");
    if (!(clean.startsWith("private/") || memoryFiles.includes(clean) || clean.startsWith("profile/skills/"))) throw new Error("Transfer contains an invalid managed path.");
    const name = `agents/${agentId}/${clean}`, target = safeWorkspacePath(stateRoot2, name);
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    if (seen.has(key)) throw new Error("Transfer contains duplicate managed paths.");
    seen.add(key);
    const data = Buffer.from(file.data, "base64");
    total += data.length;
    if (total > 1e8 || digest(data) !== file.checksum) throw new Error("Transfer checksum validation failed.");
    return { name, target, data };
  });
  let browser;
  if (bundle.browser) {
    if (bundle.browser.version !== 1 || !Array.isArray(bundle.browser.files) || bundle.browser.files.length + files.length > maxEntries || typeof bundle.browser.checksum !== "string" || total > browserBytes) throw new Error("Invalid browser transfer bundle.");
    const names = /* @__PURE__ */ new Set();
    browser = bundle.browser.files.map((file) => {
      if (!file || typeof file.path !== "string" || file.path.length > 1024 || typeof file.data !== "string" || typeof file.checksum !== "string") throw new Error("Invalid browser transfer file.");
      const target = safeWorkspacePath(stateRoot2, `browser-transfer-validation/${file.path}`), key = process.platform === "win32" ? target.toLowerCase() : target;
      if (names.has(key) || file.path.includes("\\") || file.path.split("/").some((part) => volatileBrowser.has(part))) throw new Error("Browser transfer contains duplicate or transient paths.");
      names.add(key);
      const data = Buffer.from(file.data, "base64");
      total += data.length;
      if (total > browserBytes || digest(data) !== file.checksum) throw new Error("Browser transfer checksum or size validation failed.");
      return { path: file.path, data };
    });
    if (digest(manifest(bundle.browser.files)) !== bundle.browser.checksum) throw new Error("Browser transfer checksum validation failed.");
  }
  const checksum = bundleDigest(bundle);
  if (checksum !== bundle.checksum) throw new Error("Transfer bundle checksum validation failed.");
  return { files, browser, checksum };
}
function writeManagedFiles(stateRoot2, files) {
  mkdirSync3(stateRoot2, { recursive: true, mode: 448 });
  const staging = mkdtempSync2(join5(stateRoot2, ".transfer-"));
  let committed = 0;
  try {
    for (const [index, file] of files.entries()) writeFileSync4(join5(staging, String(index)), file.data, { mode: 384, flag: "wx" });
    for (const [index, file] of files.entries()) {
      const parts = file.name.split("/");
      let parent = "";
      for (const part of parts.slice(0, -1)) {
        parent = parent ? `${parent}/${part}` : part;
        let stat = statInside(stateRoot2, parent);
        if (!stat) {
          try {
            mkdirInside(stateRoot2, parent);
          } catch (error) {
            if (!(error instanceof SafeFsError) || error.code !== "conflict") throw error;
          }
          stat = statInside(stateRoot2, parent);
        }
        if (stat?.isSymbolicLink) throw new SafeFsError("symlink", "Transfer target contains a symbolic link.");
        if (!stat?.isDirectory) throw new SafeFsError("invalid-path", "Transfer target contains a non-directory.");
      }
      const leaf = statInside(stateRoot2, file.name);
      if (leaf?.isSymbolicLink) throw new SafeFsError("symlink", "Transfer target contains a symbolic link.");
      if (leaf && !leaf.isFile) throw new SafeFsError("not-regular", "Transfer target contains a non-regular file.");
      renameIntoInside(staging, String(index), stateRoot2, file.name);
      committed++;
    }
  } catch (error) {
    if (error instanceof Error) error.message += ` (${committed} of ${files.length} files committed)`;
    throw error;
  } finally {
    rmSync4(staging, { recursive: true, force: true });
  }
}
function transferComputer(computer) {
  assertSandboxedComputer(computer);
  if (computer.browserSessionTeamId) throw new Error("Leave shared browser access before moving this agent. Team browser accounts are never copied into individual transfers.");
  return { ...computer, desktop: "virtual" };
}
async function stopped(stateRoot2, agentId, computer) {
  await stopAgentComputer(agentId, stateRoot2, computer);
  if (process.env.OPEN_HARNESS_MOCK !== "1" && (await runningAgentContainer(agentId, stateRoot2) || await runningDesktopContainer(agentId, stateRoot2, computer))) throw new Error("The agent computer must be confirmed stopped before its browser can move.");
}
async function exportAgentTransfer(stateRoot2, agentId, computer) {
  const target = transferComputer(computer);
  await stopped(stateRoot2, agentId, target);
  const bundle = exportFiles(stateRoot2, agentId, true), paths2 = desktopResourcePaths(agentId, stateRoot2, target);
  const legacy = safeWorkspacePath(stateRoot2, `agents/${agentId}/private/.config/chromium`), source = existsSync4(paths2.browser) ? paths2.browser : existsSync4(legacy) ? legacy : null;
  if (!source) return bundle;
  if (!lstatSync6(source).isDirectory()) throw new Error("The saved browser profile is not a directory.");
  const files = [];
  let total = bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.data, "base64"), 0);
  const visit = (path2, depth) => {
    if (depth > 30) throw new Error("The saved browser contains too many nested directories.");
    const name = relative2(source, path2).replaceAll("\\", "/");
    if (name.split("/").some((part) => volatileBrowser.has(part))) return;
    safeWorkspacePath(stateRoot2, relative2(stateRoot2, path2));
    const stat = lstatSync6(path2);
    if (stat.isDirectory()) {
      for (const entry of readdirSync3(path2)) visit(join5(path2, entry), depth + 1);
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("The saved browser contains a link or special file. It has not been transferred.");
    if (stat.size + total > browserBytes || files.length + bundle.files.length >= maxEntries || name.length > 1024) throw new Error("Managed files and saved browser data exceed the 50 MB transfer limit. Source data was preserved.");
    const data = readWorkspaceFile(path2), after = lstatSync6(path2);
    if (data.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("The saved browser changed during transfer. Confirm it has stopped.");
    total += data.length;
    files.push({ path: name, data: data.toString("base64"), checksum: digest(data) });
  };
  visit(source, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  bundle.browser = { version: 1, files, checksum: digest(manifest(files)) };
  bundle.checksum = bundleDigest(bundle);
  if (Buffer.byteLength(JSON.stringify(bundle)) > AGENT_TRANSFER_CLEAR_LIMIT) throw new Error("The saved browser transfer is too large. Source data was preserved.");
  return bundle;
}
async function importAgentTransfer(stateRoot2, agentId, bundle, computer) {
  const target = transferComputer(computer), validated = validateBundle(stateRoot2, agentId, bundle);
  let browser = validated.browser;
  if (!browser) {
    const legacy = bundle.files.filter((file) => file.path.replaceAll("\\", "/").startsWith(legacyPrefix));
    if (legacy.length) browser = legacy.filter((file) => !file.path.replaceAll("\\", "/").split("/").some((part) => volatileBrowser.has(part))).map((file) => ({ path: file.path.replaceAll("\\", "/").slice(legacyPrefix.length), data: Buffer.from(file.data, "base64") }));
  }
  await stopped(stateRoot2, agentId, target);
  if (!browser) {
    writeManagedFiles(stateRoot2, validated.files);
    return { checksum: validated.checksum, files: bundle.files.length };
  }
  const paths2 = desktopResourcePaths(agentId, stateRoot2, target), temporary = safeWorkspacePath(stateRoot2, `computers/${paths2.key}/transfer-${randomUUID5()}`), backup = safeWorkspacePath(stateRoot2, `computers/${paths2.key}/before-transfer-${randomUUID5()}`);
  if (existsSync4(paths2.migration) || existsSync4(safeWorkspacePath(stateRoot2, `agents/${agentId}/private/.config/chromium`))) await migrateBrowser(agentId, stateRoot2, target);
  const oldMigration = existsSync4(paths2.migration) ? readWorkspaceFile(paths2.migration) : null;
  let replaced = false, preserved = false;
  try {
    mkdirSync3(temporary, { recursive: true, mode: 448 });
    for (const file of browser) {
      const path2 = safeWorkspacePath(temporary, file.path);
      mkdirSync3(dirname4(path2), { recursive: true, mode: 448 });
      writeFileSync4(path2, file.data, { mode: 384, flag: "wx" });
    }
    writeManagedFiles(stateRoot2, validated.files.filter((file) => !relative2(safeWorkspacePath(stateRoot2, `agents/${agentId}`), file.target).replaceAll("\\", "/").startsWith(legacyPrefix)));
    safeWorkspacePath(stateRoot2, relative2(stateRoot2, paths2.browser));
    mkdirSync3(dirname4(paths2.browser), { recursive: true, mode: 448 });
    atomicWorkspaceWrite(paths2.migration, JSON.stringify({ version: 0, resourceKey: paths2.key, source: "agent-transfer-incomplete", backup: existsSync4(paths2.browser) ? relative2(stateRoot2, backup) : null, staged: relative2(stateRoot2, temporary), previousMigration: oldMigration ? JSON.parse(oldMigration.toString("utf8")) : null }));
    if (existsSync4(paths2.browser)) {
      if (!lstatSync6(paths2.browser).isDirectory()) throw new Error("The destination browser profile is not a directory.");
      renameSync3(paths2.browser, backup);
      preserved = true;
    }
    renameSync3(temporary, paths2.browser);
    replaced = true;
    atomicWorkspaceWrite(paths2.migration, JSON.stringify({ version: 2, resourceKey: paths2.key, source: "agent-transfer", archive: oldMigration ? JSON.parse(oldMigration.toString("utf8")).archive || null : null, backup: preserved ? relative2(stateRoot2, backup) : null, migratedAt: (/* @__PURE__ */ new Date()).toISOString() }));
  } catch (error) {
    if (replaced) rmSync4(paths2.browser, { recursive: true, force: true });
    if (preserved) renameSync3(backup, paths2.browser);
    if (oldMigration) atomicWorkspaceWrite(paths2.migration, oldMigration);
    else rmSync4(paths2.migration, { force: true });
    throw error;
  } finally {
    rmSync4(temporary, { recursive: true, force: true });
  }
  return { checksum: validated.checksum, files: bundle.files.length, browserFiles: browser.length };
}

// runtime/runner-response.ts
async function readRunnerResponse(response, limit = AGENT_TRANSFER_WIRE_LIMIT + 1e6) {
  const failure3 = () => new Error("The coordinator returned an invalid or oversized response.");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel().catch(() => {
    });
    throw failure3();
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure3();
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw failure3();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    await reader.cancel().catch(() => {
    });
    throw failure3();
  } finally {
    reader.releaseLock();
  }
}

// runtime/profile-runtime.ts
import { spawn as spawn4 } from "node:child_process";
import { copyFileSync, mkdirSync as mkdirSync5, chmodSync } from "node:fs";
import { join as join7 } from "node:path";

// lib/product.ts
var WORKSPACE_TOOL = "mcp__open_harness__workspace";

// runtime/profile-memory.ts
import { mkdirSync as mkdirSync4 } from "node:fs";
import { join as join6 } from "node:path";

// runtime/profiles.ts
var ProfileError = class extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
};
function validId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new ProfileError("Invalid agent ID.");
  return id;
}

// runtime/profile-memory.ts
function profileMemory(root, agentId) {
  const anchor = safeWorkspacePath(root, `agents/${validId(agentId)}`);
  mkdirSync4(anchor, { recursive: true, mode: 448 });
  for (const rel of ["profile", "profile/memories"]) {
    let stat = statInside(anchor, rel);
    if (!stat) {
      try {
        mkdirInside(anchor, rel);
      } catch (error) {
        if (!(error instanceof SafeFsError) || error.code !== "conflict") throw error;
      }
      stat = statInside(anchor, rel);
    }
    if (stat?.isSymbolicLink) throw new SafeFsError("symlink", "Workspace paths cannot contain symbolic links.");
    if (!stat?.isDirectory) throw new SafeFsError("invalid-path", "Workspace parent is not a directory.");
  }
  const paths2 = { memory: "", user: "" };
  for (const [key, file] of [["memory", "MEMORY.md"], ["user", "USER.md"]]) {
    const target = `profile/memories/${file}`, legacy = `profile/${file}`;
    const current = statInside(anchor, target), previous = statInside(anchor, legacy);
    if (current?.isSymbolicLink || previous?.isSymbolicLink) throw new SafeFsError("symlink", "Workspace paths cannot contain symbolic links.");
    if (!current && previous) {
      try {
        writeInside(anchor, target, readInside(anchor, legacy, { maxBytes: 2e5 }), { exclusive: true, maxBytes: 2e5 });
      } catch (error) {
        if (!(error instanceof SafeFsError) || error.code !== "conflict") throw error;
      }
    }
    paths2[key] = join6(anchor, target);
  }
  return paths2;
}

// runtime/model-validation.ts
var endpoints = {
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1"
};
var COMPOSE_LOCAL_MODEL_MESSAGE = "This Docker browser installation cannot use localhost or Docker host aliases for a model server on your computer. Use a hosted provider or a model server network address reachable from both the coordinator and agent containers.";
function modelEndpointIssue(baseUrl) {
  if (process.env.OPEN_HARNESS_DEPLOYMENT !== "compose" || !baseUrl) return null;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || ["0.0.0.0", "[::]", "[::1]", "host.docker.internal", "gateway.docker.internal", "[::ffff:0:0]"].includes(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host) ? COMPOSE_LOCAL_MODEL_MESSAGE : null;
}
async function failure(response, key) {
  const fallback = { 401: "The API key was rejected.", 402: "The provider account needs credits.", 403: "The provider denied access.", 404: "The model server address was not found.", 429: "The provider rate limit was reached. Try again shortly." };
  try {
    const body = await response.json();
    const detail = typeof body.error === "string" ? body.error : body.error?.message || body.message;
    if (detail) return (key ? String(detail).replaceAll(key, "[redacted]") : String(detail)).trim().slice(0, 500);
  } catch {
  }
  return fallback[response.status] || `The provider returned HTTP ${response.status}.`;
}
async function testModelConnection(model, apiKey) {
  const base = (model.baseUrl || endpoints[model.provider] || "").replace(/\/$/, "");
  const endpointIssue = modelEndpointIssue(base);
  if (endpointIssue) return { ok: false, message: endpointIssue };
  if (process.env.OPEN_HARNESS_MOCK === "1") return { ok: false, message: "Mock mode is active, so no model provider was contacted. Restart with npm run dev to test this API key and run real tasks." };
  if (!base) return { ok: false, message: "Enter the address of your model server." };
  if (!apiKey && !["local", "custom"].includes(model.provider)) return { ok: false, message: "Enter an API key for this provider." };
  const anthropic = model.provider === "anthropic" && !model.baseUrl;
  const headers2 = { "Content-Type": "application/json", ...anthropic ? { "anthropic-version": "2023-06-01", "x-api-key": apiKey } : apiKey ? { Authorization: `Bearer ${apiKey}` } : {} };
  try {
    const catalog = await fetch(`${base}/models`, { headers: headers2, signal: AbortSignal.timeout(15e3), redirect: "error" });
    if (!catalog.ok) return { ok: false, message: await failure(catalog, apiKey) };
    const rows = await catalog.json();
    if (!Array.isArray(rows.data) || !rows.data.some((row) => row.id === model.model)) return { ok: false, message: `The provider connection works, but model ${model.model} is not available to this API key.` };
    const completion = await fetch(`${base}/${anthropic ? "messages" : "chat/completions"}`, {
      method: "POST",
      headers: headers2,
      signal: AbortSignal.timeout(3e4),
      redirect: "error",
      body: JSON.stringify({ model: model.model, messages: [{ role: "user", content: "Reply with OK." }], ...model.provider === "openai" ? { max_completion_tokens: 16 } : { max_tokens: 16 }, stream: false })
    });
    if (!completion.ok) return { ok: false, message: await failure(completion, apiKey) };
    const result = await completion.json();
    if (!(anthropic ? Array.isArray(result.content) : Array.isArray(result.choices) && result.choices.length)) return { ok: false, message: "The model server returned an invalid completion response." };
    return { ok: true, message: "Provider authenticated and the selected model accepted a live test request." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach the model provider.";
    return { ok: false, message: apiKey ? message.replaceAll(apiKey, "[redacted]") : message };
  }
}

// lib/group-chat.ts
var GROUP_CHAT_TOOL = "mcp__open_harness__group_chat";

// lib/codex.ts
var CODEX_PROVIDER = "openai-codex";
function isCodexSession(value) {
  return value.startsWith('{"kind":"open-harness-codex-oauth",');
}

// runtime/profile-runtime.ts
var COORDINATION_TOOLS = [
  { id: COMPUTER_TOOL, name: "Managed computer", group: "desktop", description: "See and control the private managed browser. Human takeover keeps its current page. Existing headless browser permissions do not enable this tool; select it explicitly.", available: true },
  { id: WORKSPACE_TOOL, name: "Workspace coordination", group: "delegation", description: "Track delegated work, record checkpoints, and propose bounded responsibilities.", available: true },
  { id: GROUP_CHAT_TOOL, name: "Group conversations", group: "delegation", description: "Read and message teammates in shared group conversations.", available: true },
  { id: TASK_TOOL, name: "Task board", group: "other", description: "Read and update assigned board tasks.", available: true },
  { id: HANDOFF_TOOL, name: "Hand off to another agent", group: "delegation", description: "Assign explicit task context to a named agent on a shared team.", available: true },
  { id: MESSAGE_TOOL, name: "Post a message", group: "delegation", description: "Post an update to the current conversation without starting another run.", available: true },
  { id: ROUTINE_TOOL, name: "Create a routine", group: "scheduling", description: "Schedule work through Open Harness.", available: true }
];
var mockTools = [
  ["terminal", "terminal"],
  ["process_manage", "terminal"],
  ["execute_code", "code"],
  ["read_file", "files"],
  ["write_file", "files"],
  ["search_files", "files"],
  ["web_search", "web"],
  ["web_extract", "web"],
  ["browser_navigate", "browser"],
  ["browser_screenshot", "browser"],
  ["memory", "memory"],
  ["skills_list", "skills"],
  ["skill_manage", "skills"],
  ["session_search", "recall"],
  ["delegate_task", "delegation"]
].map(([id, group]) => ({ id, group, name: id.replaceAll("_", " "), description: "Deterministic test runtime tool.", available: true }));
function groupTool(tool) {
  const group = { file: "files", terminal: "terminal", process: "terminal", code_execution: "code", execute_code: "code", web: "web", browser: "browser", computer_use: "desktop", memory: "memory", skills: "skills", session_search: "recall", delegation: "delegation", delegate: "delegation", cronjob: "scheduling" }[tool.group] || (tool.id.startsWith("mcp_") ? "mcp" : tool.group);
  return { ...tool, group };
}
function runtimeToolCatalog(tools, profile) {
  return [...tools.filter((tool) => tool.group !== "cronjob" && tool.id !== "computer_use" && tool.id !== COMPUTER_TOOL).map((tool) => {
    const value = groupTool(tool);
    return profile?.computer.desktop === "virtual" && tool.id.startsWith("browser_") ? { ...value, available: false, reason: "This private desktop uses Managed computer. Enable that permission explicitly to use its visible browser." } : value;
  }), ...COORDINATION_TOOLS];
}
function containerBaseUrl(value) {
  const issue = modelEndpointIssue(value);
  if (issue) throw new Error(issue);
  const url = new URL(value);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "host.docker.internal";
  return url.toString().replace(/\/$/, "");
}
function runtimeProbe(container, input) {
  const probe2 = input;
  const request2 = probe2.action === "connection" && probe2.baseUrl ? { ...probe2, baseUrl: containerBaseUrl(probe2.baseUrl) } : input;
  return new Promise((resolve8, reject) => {
    const child = spawn4("docker", ["exec", "-i", container, "python", "/opt/open-harness/inspect_runtime.py"], { stdio: ["pipe", "pipe", "pipe"] });
    let output2 = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Runtime connection check timed out."));
    }, 25e3);
    child.stdout.on("data", (part) => {
      output2 += part;
      if (output2.length > 5e6) child.kill();
    });
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Docker could not start the runtime check."));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const value = JSON.parse(output2.trim());
        if (code || value.error) reject(new Error(value.error || "Runtime check failed."));
        else resolve8(value);
      } catch {
        reject(new Error("Runtime check returned an invalid response. Rebuild the Hermes image."));
      }
    });
    child.stdin.end(JSON.stringify(request2) + "\n");
  });
}
function prepareProfile(root, profile, effective, secrets, token, runId, options = {}) {
  assertSandboxedComputer(profile.computer);
  const allowedTools = runToolGrants(profile);
  const baseUrl = effective.baseUrl ? containerBaseUrl(effective.baseUrl) : "";
  const dir = join7(root, "agents", profile.id), home = join7(dir, "profile"), managed = join7(dir, "managed");
  for (const path2 of [home, managed, join7(dir, "private")]) mkdirSync5(path2, { recursive: true });
  profileMemory(root, profile.id);
  const mcp = {};
  const coordination = join7(managed, "coordination.mjs");
  copyFileSync(join7(import.meta.dirname, "hermes", "coordination.mjs"), coordination);
  chmodSync(coordination, 384);
  for (const name of ["gateway-entry.mjs", "model-proxy.mjs"]) {
    const target = join7(managed, name);
    copyFileSync(join7(import.meta.dirname, "hermes", name), target);
    chmodSync(target, 384);
  }
  const coordinationEnv = { OPEN_HARNESS_AGENT_ID: profile.id, OPEN_HARNESS_AGENT_TOKEN: token, OPEN_HARNESS_RUN_ID: runId, OPEN_HARNESS_RUN_LEASE: "/run/open-harness/run-lease.json", ...options.controlUrl ? { OPEN_HARNESS_CONTROL_URL: options.controlUrl } : {}, ...options.controlSocket ? { OPEN_HARNESS_CONTROL_SOCKET: options.controlSocket } : {} };
  if (allowedTools.some((id) => COORDINATION_TOOLS.some((t) => t.id === id))) mcp.open_harness = { command: "node", args: [options.coordinationCommand || "/run/open-harness/coordination.mjs"], env: coordinationEnv };
  const env = {};
  const secretValues = Object.fromEntries(Object.entries(secrets.environment()).filter(([, value]) => !isCodexSession(value)));
  const codex = effective.provider === CODEX_PROVIDER;
  if (codex) {
    env.OPEN_HARNESS_SCOPED_MODEL_TOKEN = "open-harness-scoped-model";
  }
  const customEndpoint = Boolean(baseUrl);
  const hermesProvider = codex ? "custom:open-harness-chatgpt" : customEndpoint ? "custom" : { local: "custom", openai: "openai-api" }[effective.provider] || effective.provider;
  const customKeyEnv = "OPEN_HARNESS_MODEL_API_KEY";
  const hasCredential = Boolean(effective.credentialRef && secretValues[effective.credentialRef]);
  if (hasCredential) {
    env[effective.credentialRef] = secretValues[effective.credentialRef];
    if (customEndpoint) env[customKeyEnv] = secretValues[effective.credentialRef];
    const providerEnv = { xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", "openai-api": "OPENAI_API_KEY" }[effective.provider];
    if (providerEnv && !customEndpoint) env[providerEnv] = secretValues[effective.credentialRef];
  }
  const providers = codex ? { "open-harness-chatgpt": { name: "Open Harness ChatGPT", api_mode: "codex_responses", base_url: "http://127.0.0.1:1/v1", key_env: "OPEN_HARNESS_SCOPED_MODEL_TOKEN", default_model: effective.model } } : customEndpoint ? { custom: { name: "custom", base_url: baseUrl, ...hasCredential ? { key_env: customKeyEnv } : {}, ...effective.model ? { default_model: effective.model } : {} } } : void 0;
  for (const c of profile.connectors.filter((c2) => c2.enabled)) {
    const connectorEnv = c.secretRef && secretValues[c.secretRef] ? { [c.secretRef]: secretValues[c.secretRef] } : {};
    Object.assign(env, connectorEnv);
    mcp[c.name] = { command: c.command, args: c.args, env: c.secretRef ? { [c.secretRef]: "${" + c.secretRef + "}" } : {} };
  }
  const config = { model: { default: effective.model, provider: hermesProvider, ...codex ? { base_url: "http://127.0.0.1:1/v1", api_mode: "codex_responses" } : effective.baseUrl ? { base_url: baseUrl } : {} }, terminal: { backend: "local", cwd: options.cwd || "/workspace/shared", home_mode: "profile" }, approvals: { mode: "manual", unattended_mode: "deny", cron_mode: "deny" }, computer_use: { permission_mode: "standard", no_overlay: profile.computer.desktop === "virtual" }, cron: { enabled: false }, delegation: { inherit_mcp_toolsets: false }, tools: { tool_search: { enabled: "off" } }, plugins: { enabled: ["open_harness_policy"] }, ...providers ? { providers } : {}, mcp_servers: mcp };
  atomicWorkspaceWrite(join7(home, "config.yaml"), JSON.stringify(config, null, 2));
  atomicWorkspaceWrite(join7(home, "SOUL.md"), profile.prompt.enabled ? profile.prompt.text : "");
  atomicWorkspaceWrite(join7(home, ".env"), Object.entries(env).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n") + "\n");
  atomicWorkspaceWrite(join7(managed, "policy.json"), JSON.stringify({ runId, revision: profile.revision, modelProvider: effective.provider, allowedTools, coordination: coordinationEnv, reviewUnclassified: options.reviewUnclassified ?? (process.env.OPEN_HARNESS_SCOPED_AUTONOMY !== "0" || process.env.OPEN_HARNESS_REQUIRE_RELAY_IDENTITY === "1") }));
  writeRunLease(root, profile.id, options.idle ? null : runId);
}
function writeRunLease(root, agentId, runId) {
  atomicWorkspaceWrite(join7(root, "agents", agentId, "managed", "run-lease.json"), JSON.stringify({ runId, active: Boolean(runId), expiresAt: Date.now() + 864e5 }));
}
async function discoverModels(gateway) {
  if (process.env.OPEN_HARNESS_MOCK === "1") return { models: [{ id: "mock-atlas", provider: "mock", label: "Mock Atlas" }, { id: "mock-scout", provider: "mock", label: "Mock Scout" }] };
  const result = await gateway.request("model.options", { refresh: true }, 3e4);
  return normalizeModels(result);
}
function normalizeModels(result) {
  const models = [];
  function walk(value, provider = "") {
    if (typeof value === "string" && provider) {
      models.push({ id: value, provider, label: value });
      return;
    }
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, provider));
      return;
    }
    const row = value;
    const p = String(row.slug || row.provider_id || row.provider || provider);
    const id = row.model_id || row.model || (p && !row.models ? row.id : "");
    if (typeof id === "string" && id && p) models.push({ id, provider: p, label: String(row.name || row.label || id) });
    for (const key of ["providers", "models", "options", "items"]) if (row[key]) walk(row[key], key === "models" ? String(row.slug || row.provider_id || row.provider || row.id || provider) : p);
  }
  walk(result);
  if (!models.length) return { models, error: "The runtime returned no model choices. Refresh or enter a custom model ID." };
  return { models: [...new Map(models.map((m) => [`${m.provider}:${m.id}`, m])).values()] };
}

// runtime/transfer-crypto.ts
import { createHash as createHash4 } from "node:crypto";

// lib/runner-crypto.ts
function base64(bytes2) {
  let binary = "";
  for (let offset = 0; offset < bytes2.length; offset += 32768) binary += String.fromCharCode(...bytes2.subarray(offset, offset + 32768));
  return btoa(binary);
}
function bytes(value) {
  const binary = atob(value), output2 = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) output2[index] = binary.charCodeAt(index);
  return output2;
}
async function generateRunnerKeyPair() {
  const pair2 = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  return { publicKey: JSON.stringify(await crypto.subtle.exportKey("jwk", pair2.publicKey)), privateKey: JSON.stringify(await crypto.subtle.exportKey("jwk", pair2.privateKey)) };
}
async function encryptRunnerSecret(publicKey, value) {
  const rsa = await crypto.subtle.importKey("jwk", JSON.parse(publicKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(value));
  const rawKey = await crypto.subtle.exportKey("raw", aes);
  const wrapped = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, rawKey);
  return { version: 1, key: base64(new Uint8Array(wrapped)), iv: base64(iv), data: base64(new Uint8Array(data)) };
}
async function decryptRunnerSecret(privateKey, payload) {
  if (payload.version !== 1) throw new Error("Unsupported encrypted credential version.");
  const rsa = await crypto.subtle.importKey("jwk", JSON.parse(privateKey), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const rawKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsa, bytes(payload.key));
  const aes = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(payload.iv) }, aes, bytes(payload.data));
  return new TextDecoder().decode(clear);
}

// runtime/transfer-crypto.ts
var purpose = "open-harness-agent-transfer";
var bindingKeys = ["transferId", "agentId", "sourceMachineId", "destinationMachineId"];
var hash = (data) => createHash4("sha256").update(data).digest("hex");
var failure2 = () => new Error("The encrypted agent transfer is invalid or belongs to another move. Source data was preserved.");
function record(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function base642(value) {
  const padding = value.indexOf("=");
  return value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value) && (padding < 0 || padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding)));
}
function bindingValid(value, expected) {
  return record(value) && bindingKeys.every((key) => typeof expected[key] === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(expected[key]) && value[key] === expected[key]);
}
function integrity(value) {
  if (!record(value) || !Array.isArray(value.files) || typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.checksum) || value.files.length > 1e4) throw failure2();
  let total = 0, count = 0;
  const manifest2 = (files2) => files2.map((file) => {
    if (!record(file) || typeof file.path !== "string" || file.path.length > 1024 || typeof file.data !== "string" || typeof file.checksum !== "string" || !/^[a-f0-9]{64}$/.test(file.checksum)) throw failure2();
    if (++count > 1e4 || file.data.length > AGENT_TRANSFER_CLEAR_LIMIT) throw failure2();
    const bytes2 = Buffer.from(file.data, "base64");
    total += bytes2.length;
    if (total > 5e7 || bytes2.toString("base64") !== file.data || hash(bytes2) !== file.checksum) throw failure2();
    return { path: file.path, checksum: file.checksum };
  }).sort((a, b) => a.path.localeCompare(b.path)).map((file) => `${file.path}:${file.checksum}`).join("\n");
  const files = manifest2(value.files);
  let browser = "";
  if (value.browser !== void 0) {
    if (!record(value.browser) || value.browser.version !== 1 || !Array.isArray(value.browser.files) || typeof value.browser.checksum !== "string") throw failure2();
    browser = hash(manifest2(value.browser.files));
    if (browser !== value.browser.checksum) throw failure2();
  }
  const checksum = hash(files + (value.browser !== void 0 ? `
@desktop-browser-v1:${browser}` : ""));
  if (checksum !== value.checksum) throw failure2();
  return { checksum, files: count };
}
function validateSealedTransfer(value, binding) {
  if (!record(value) || value.version !== 1 || value.purpose !== purpose || !bindingValid(value, binding) || Object.keys(value).some((key) => !["version", "purpose", ...bindingKeys, "checksum", "files", "encrypted"].includes(key)) || typeof value.checksum !== "string" || !/^[a-f0-9]{64}$/.test(value.checksum) || !Number.isSafeInteger(value.files) || Number(value.files) < 0 || Number(value.files) > 1e4) throw failure2();
  const encrypted = value.encrypted;
  if (!record(encrypted) || Object.keys(encrypted).some((key) => !["version", "key", "iv", "data"].includes(key)) || encrypted.version !== 1 || typeof encrypted.key !== "string" || encrypted.key.length !== 344 || typeof encrypted.iv !== "string" || encrypted.iv.length !== 16 || typeof encrypted.data !== "string" || encrypted.data.length < 24 || encrypted.data.length > AGENT_TRANSFER_WIRE_LIMIT - 4096) throw failure2();
  if (!base642(encrypted.key) || !base642(encrypted.iv) || !base642(encrypted.data)) throw failure2();
  if (Buffer.byteLength(JSON.stringify(value)) > AGENT_TRANSFER_WIRE_LIMIT) throw failure2();
  return value;
}
async function sealAgentTransfer(bundle, binding, publicKey) {
  if (!bindingValid(binding, binding)) throw failure2();
  const metadata = integrity(bundle), clear = JSON.stringify({ version: 1, purpose, ...binding, ...metadata, bundle });
  if (Buffer.byteLength(clear) > AGENT_TRANSFER_CLEAR_LIMIT) throw failure2();
  try {
    return validateSealedTransfer({ version: 1, purpose, ...binding, ...metadata, encrypted: await encryptRunnerSecret(publicKey, clear) }, binding);
  } catch {
    throw failure2();
  }
}
async function openAgentTransfer(value, binding, privateKey) {
  const sealed = validateSealedTransfer(value, binding);
  try {
    const clear = await decryptRunnerSecret(privateKey, sealed.encrypted);
    if (Buffer.byteLength(clear) > AGENT_TRANSFER_CLEAR_LIMIT) throw failure2();
    const decoded = JSON.parse(clear);
    if (!record(decoded) || decoded.version !== 1 || decoded.purpose !== purpose || !bindingValid(decoded, binding)) throw failure2();
    const metadata = integrity(decoded.bundle);
    if (metadata.checksum !== sealed.checksum || metadata.files !== sealed.files || decoded.checksum !== metadata.checksum || decoded.files !== metadata.files) throw failure2();
    return decoded.bundle;
  } catch {
    throw failure2();
  }
}

// runtime/secrets.ts
import { chmodSync as chmodSync2, existsSync as existsSync5, mkdirSync as mkdirSync6, readFileSync as readFileSync6, unlinkSync as unlinkSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname5 } from "node:path";
import { spawnSync as spawnSync2 } from "node:child_process";
import { createHash as createHash5 } from "node:crypto";
var service = "dev.openharness.secrets";
function command(name, args2, input) {
  return spawnSync2(name, args2, { input, encoding: "utf8", timeout: 8e3, windowsHide: true, maxBuffer: 2e6 });
}
var account = (path2) => `open-harness-${createHash5("sha256").update(path2).digest("hex").slice(0, 16)}`;
var DISABLED = { state: "unavailable", backend: "OS vault", reason: "OPEN_HARNESS_DISABLE_OS_VAULT=1 is set." };
function loadVault(path2) {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === "1") return DISABLED;
  try {
    if (process.platform === "darwin") {
      const backend = "macOS Keychain";
      const result = command("security", ["find-generic-password", "-s", service, "-a", account(path2), "-w"]);
      if (result.status === 0) return { state: "ok", value: result.stdout.trim(), backend };
      if (result.status === 44) return { state: "empty", backend };
      return { state: "unavailable", backend, reason: result.error ? result.error.message : (result.stderr || "").trim() || `security exited ${result.status}.` };
    }
    if (process.platform === "linux") {
      const backend = "system password vault";
      if (!process.env.DBUS_SESSION_BUS_ADDRESS) return { state: "unavailable", backend, reason: "No D-Bus session is available, so the password vault cannot be reached." };
      const result = command("secret-tool", ["lookup", "application", service, "workspace", account(path2)]);
      if (result.status === 0) return result.stdout.trim() ? { state: "ok", value: result.stdout.trim(), backend } : { state: "empty", backend };
      if (result.status === 1 && !(result.stderr || "").trim()) return { state: "empty", backend };
      return { state: "unavailable", backend, reason: result.error ? result.error.message : (result.stderr || "").trim() || `secret-tool exited ${result.status}.` };
    }
    if (process.platform === "win32") {
      const backend = "Windows account vault";
      const target = `${process.env.APPDATA || dirname5(process.execPath)}\\Open Harness\\${account(path2)}.dpapi`;
      const script = "$p=$args[0];if(-not (Test-Path -LiteralPath $p)){exit 44};$b=[IO.File]::ReadAllBytes($p);$d=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($d))";
      const result = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, target]);
      if (result.status === 0 && result.stdout) return { state: "ok", value: result.stdout, backend };
      if (result.status === 44) return { state: "empty", backend };
      return { state: "unavailable", backend, reason: result.error ? result.error.message : (result.stderr || "").trim() || `PowerShell exited ${result.status}.` };
    }
    return { state: "empty", backend: "OS vault" };
  } catch (error) {
    return { state: "unavailable", backend: "OS vault", reason: error instanceof Error ? error.message : "The OS vault could not be read." };
  }
}
function saveVault(path2, value) {
  if (process.env.OPEN_HARNESS_DISABLE_OS_VAULT === "1") return null;
  try {
    if (process.platform === "darwin") return command("security", ["add-generic-password", "-U", "-s", service, "-a", account(path2), "-w", value]).status === 0 ? "macOS Keychain" : null;
    if (process.platform === "linux" && process.env.DBUS_SESSION_BUS_ADDRESS) return command("secret-tool", ["store", "--label=Open Harness credentials", "application", service, "workspace", account(path2)], value).status === 0 ? "system password vault" : null;
    if (process.platform === "win32") {
      const target = `${process.env.APPDATA || dirname5(process.execPath)}\\Open Harness\\${account(path2)}.dpapi`;
      const script = "$p=$args[0];$v=[Console]::In.ReadToEnd();$d=Split-Path -Parent $p;New-Item -ItemType Directory -Force -Path $d|Out-Null;$b=[Text.Encoding]::UTF8.GetBytes($v);$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[IO.File]::WriteAllBytes($p,$e)";
      return command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script, target], value).status === 0 ? "Windows account vault" : null;
    }
  } catch {
  }
  return null;
}
var SecretsUnavailableError = class extends Error {
};
var SecretStore = class {
  constructor(path2) {
    this.path = path2;
    this.backend = "restricted local file";
    mkdirSync6(dirname5(path2), { recursive: true });
    this.markerPath = `${path2.replace(/\.json$/, "")}.backend`;
    const recorded = existsSync5(this.markerPath) ? readFileSync6(this.markerPath, "utf8").trim() : "";
    const vaulted = loadVault(path2);
    const onDisk = existsSync5(path2);
    if (vaulted.state === "ok") {
      this.values = this.parse(vaulted.value, vaulted.backend);
      this.backend = vaulted.backend;
    } else if (onDisk) {
      this.values = this.parse(readFileSync6(path2, "utf8"), path2);
      this.backend = "restricted local file";
    } else if (recorded.startsWith("vault")) {
      const detail = vaulted.state === "unavailable" ? vaulted.reason : "The vault reports no stored credentials.";
      throw new SecretsUnavailableError(
        `Open Harness stored its credentials in the ${recorded.slice(6) || vaulted.backend} and cannot read them now. ${detail}
Start Open Harness from an unlocked desktop session, or set OPEN_HARNESS_DISABLE_OS_VAULT=1 and re-enter the keys.
Nothing was changed. Delete ${this.markerPath} to start over with an empty credential store.`
      );
    } else this.values = {};
    if (!this.values.controlToken) {
      this.values.controlToken = crypto.randomUUID() + crypto.randomUUID();
      this.save();
    } else this.record();
    if (existsSync5(path2)) chmodSync2(path2, 384);
  }
  get token() {
    return this.values.controlToken;
  }
  set(name, value) {
    if (!/^[A-Z][A-Z0-9_]{1,80}$/.test(name)) throw new Error("Invalid secret name.");
    this.values[name] = value;
    this.save();
  }
  has(name) {
    return Boolean(this.values[name]);
  }
  names() {
    return Object.keys(this.values).filter((key) => key !== "controlToken");
  }
  environment() {
    return Object.fromEntries(Object.entries(this.values).filter(([key]) => key !== "controlToken"));
  }
  // save() reserializes the whole map, which still holds controlToken, so the vault blob
  // rewrites correctly and the dashboard token survives. The guard is defence in depth:
  // this is the one method that could otherwise brick it.
  delete(name) {
    if (name === "controlToken" || !(name in this.values)) return false;
    delete this.values[name];
    this.save();
    return true;
  }
  // Unreadable stored credentials are not the same as none: replacing them with a fresh
  // map is the one thing that cannot be undone, so say so and change nothing.
  parse(raw, source) {
    if (!raw.trim()) return {};
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new SecretsUnavailableError(`The stored Open Harness credentials in ${source} are not readable JSON. Nothing was changed. Move that entry aside to start over with an empty credential store.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecretsUnavailableError(`The stored Open Harness credentials in ${source} are not in the expected format. Nothing was changed. Move that entry aside to start over with an empty credential store.`);
    return value;
  }
  record() {
    try {
      writeFileSync5(this.markerPath, this.backend === "restricted local file" ? "file" : `vault:${this.backend}`, { mode: 384 });
    } catch {
    }
  }
  save() {
    const serialized = JSON.stringify(this.values);
    const backend = saveVault(this.path, serialized);
    if (backend) {
      const confirmed = loadVault(this.path);
      if (confirmed.state === "ok" && confirmed.value.trim() === serialized) {
        this.backend = backend;
        this.record();
        if (existsSync5(this.path)) unlinkSync3(this.path);
        return;
      }
    }
    this.backend = "restricted local file";
    writeFileSync5(this.path, JSON.stringify(this.values, null, 2), { mode: 384 });
    chmodSync2(this.path, 384);
    this.record();
  }
};

// runtime/agent-context.ts
import { mkdirSync as mkdirSync7, mkdtempSync as mkdtempSync3, rmSync as rmSync5, writeFileSync as writeFileSync6 } from "node:fs";
import { join as join8, relative as relative3 } from "node:path";
import { createHash as createHash6 } from "node:crypto";
function ensureDirectory(anchor, rel) {
  let stat = statInside(anchor, rel);
  if (!stat) {
    try {
      mkdirInside(anchor, rel);
    } catch (error) {
      if (!(error instanceof SafeFsError) || error.code !== "conflict") throw error;
    }
    stat = statInside(anchor, rel);
  }
  if (stat?.isSymbolicLink) throw new SafeFsError("symlink", "Workspace paths cannot contain symbolic links.");
  if (!stat?.isDirectory) throw new SafeFsError("invalid-path", "Workspace parent is not a directory.");
}
function write(root, anchor, rel, content) {
  const parts = rel.split("/");
  let parent = "";
  for (const part of parts.slice(0, -1)) {
    parent = parent ? `${parent}/${part}` : part;
    ensureDirectory(anchor, parent);
  }
  if (statInside(anchor, rel)?.isSymbolicLink) throw new SafeFsError("symlink", "Workspace paths cannot contain symbolic links.");
  const staging = mkdtempSync3(join8(root, ".context-"));
  try {
    writeFileSync6(join8(staging, "value"), content, { mode: 384, flag: "wx" });
    renameIntoInside(staging, "value", anchor, rel);
  } finally {
    rmSync5(staging, { recursive: true, force: true });
  }
}
function read(anchor, rel, maxBytes) {
  try {
    return readInside(anchor, rel, { encoding: "utf8", maxBytes });
  } catch (error) {
    if (error instanceof SafeFsError && error.code === "not-found") return "";
    throw error;
  }
}
function agentContext(root, agentId, input) {
  const anchor = safeWorkspacePath(root, `agents/${validId(agentId)}`);
  mkdirSync7(anchor, { recursive: true, mode: 448 });
  if (input.operation === "get" || input.operation === "set-memory") {
    const paths2 = profileMemory(root, agentId);
    const memoryPath = relative3(anchor, paths2.memory).replaceAll("\\", "/"), userPath = relative3(anchor, paths2.user).replaceAll("\\", "/");
    const memory = read(anchor, memoryPath, 2e5), user = read(anchor, userPath, 2e5);
    const revision = createHash6("sha256").update(JSON.stringify({ memory, user })).digest("hex");
    if (input.operation === "set-memory") {
      if (input.revision !== void 0 && input.revision !== revision) throw new ProfileError(`These notes changed elsewhere (revision ${revision.slice(0, 12)}). Your draft is preserved; reload the saved notes before saving again.`, 409);
      if (input.user !== void 0 && input.revision === void 0) throw new ProfileError("Reload these notes before changing personal preferences.", 409);
      const nextMemory = input.memory === void 0 ? memory : String(input.memory), nextUser = input.user === void 0 ? user : String(input.user);
      if (nextMemory.length > 5e4 || nextUser.length > 5e4) throw new ProfileError("Each memory field is limited to 50 KB.", 413);
      if (input.memory !== void 0) write(root, anchor, memoryPath, nextMemory);
      if (input.user !== void 0) write(root, anchor, userPath, nextUser);
      return { status: 200, value: { ok: true, revision: createHash6("sha256").update(JSON.stringify({ memory: nextMemory, user: nextUser })).digest("hex") } };
    }
    return { status: 200, value: { memory, user, revision, skills: statInside(anchor, "profile/skills") ? listInside(anchor, "profile/skills", { max: 1e4 }).filter((item) => item.isDirectory).map((item) => item.name).slice(0, 200) : [] } };
  }
  if (!["get-skill", "put-skill", "delete-skill"].includes(input.operation)) throw new ProfileError("Invalid context operation.");
  const name = String(input.name || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) throw new ProfileError("Invalid skill name.");
  safeWorkspacePath(root, `agents/${agentId}/profile/skills/${name}`);
  const directory = `profile/skills/${name}`, file = `${directory}/SKILL.md`;
  if (input.operation === "get-skill") {
    try {
      return { status: 200, value: { name, content: readInside(anchor, file, { encoding: "utf8", maxBytes: 1e6 }) } };
    } catch (error) {
      if (error instanceof SafeFsError && error.code === "not-found") return { status: 404, value: { error: "Skill not found." } };
      throw error;
    }
  }
  if (input.operation === "put-skill") {
    const content = String(input.content || "");
    if (Buffer.byteLength(content) > 1e6) throw new ProfileError("Skills are limited to 1 MB.", 413);
    write(root, anchor, file, content);
  } else {
    try {
      rmrfInside(anchor, directory, { maxEntries: 1e4, maxDepth: 16 });
    } catch (error) {
      if (!(error instanceof SafeFsError) || error.code !== "not-found") throw error;
    }
  }
  return { status: 200, value: { ok: true } };
}

// runtime/desktop-control.ts
import { spawn as spawn5 } from "node:child_process";

// runtime/computer-ownership.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync8, readFileSync as readFileSync7 } from "node:fs";
import { join as join9 } from "node:path";
function validComputerOwnership(value) {
  if (!value || typeof value !== "object") return false;
  const item = value;
  return Number.isSafeInteger(item.generation) && item.generation > 0 && ["agent", "human", "idle"].includes(item.owner) && typeof item.identity === "string" && item.identity.length > 0 && item.identity.length <= 200;
}
function ownershipPath(root, profile) {
  const directory = safeWorkspacePath(root, "computer-ownership");
  mkdirSync8(directory, { recursive: true, mode: 448 });
  return join9(directory, `${desktopResourceKey(profile.id, root, profile.computer)}.json`);
}
function readComputerOwnership(root, profile) {
  const path2 = ownershipPath(root, profile);
  if (!existsSync6(path2)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync7(path2, "utf8"));
  } catch {
    throw new ProfileError("Computer ownership could not be read. Control remains blocked.", 409);
  }
  if (!validComputerOwnership(value)) throw new ProfileError("Computer ownership is invalid. Control remains blocked.", 409);
  return value;
}
function claimComputerOwnership(root, profile, value) {
  if (!validComputerOwnership(value)) throw new ProfileError("Invalid computer ownership.", 409);
  const current = readComputerOwnership(root, profile);
  if (current && (value.generation < current.generation || value.generation === current.generation && (value.owner !== current.owner || value.identity !== current.identity))) throw new ProfileError("This computer request belongs to an earlier controller.", 409);
  atomicWorkspaceWrite(ownershipPath(root, profile), JSON.stringify(value));
}
function assertComputerOwnership(root, profile, value) {
  const current = readComputerOwnership(root, profile);
  if (!validComputerOwnership(value) || !current || current.generation !== value.generation || current.owner !== value.owner || current.identity !== value.identity) throw new ProfileError("Computer control changed. Reconnect before sending input.", 409);
}

// runtime/desktop-helper.ts
var DESKTOP_HELPER = String.raw`
import base64, contextlib, ctypes, json, math, os, subprocess, sys, time
from urllib.parse import urlsplit

def check_deadline(spec):
    if 'expiresAt' in spec:
        deadline = spec['expiresAt']
        if type(deadline) not in (int, float) or not math.isfinite(deadline) or deadline <= time.time() * 1000:
            raise RuntimeError('Desktop request expired.')

def browser_processes():
    result = []
    for entry in os.listdir('/proc'):
        if entry.isdigit():
            try:
                cmd = open('/proc/' + entry + '/cmdline', 'rb').read()
                profile = os.environ.get('AGENT_BROWSER_PROFILE', '/workspace/private/.config/chromium')
                if b'chromium' in cmd and b'--type=' not in cmd and ('--user-data-dir=' + profile).encode() in cmd:
                    result.append(int(entry))
            except OSError:
                pass
    return result

def browser_identity():
    for pid in sorted(browser_processes()):
        try:
            fields = open('/proc/' + str(pid) + '/stat').read().rsplit(')', 1)[1].split()
            if fields[0] != 'Z': return {'browserPid': pid, 'browserSessionId': str(pid) + ':' + fields[19]}
        except (OSError, IndexError): pass
    return {'browserPid': None, 'browserSessionId': None}

def pointer_input(spec, action):
    # XTest is already in the pinned image. The fixed protocol never invokes a shell.
    x = ctypes.CDLL('libX11.so.6'); xt = ctypes.CDLL('libXtst.so.6')
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]; x.XOpenDisplay.restype = ctypes.c_void_p
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    xt.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x.XOpenDisplay(b':99')
    if not display: raise RuntimeError('Private display is unavailable.')
    pressed = False
    def move(px, py):
        if type(px) is not int or type(py) is not int or not 0 <= px < 1440 or not 0 <= py < 900: raise RuntimeError('Pointer outside private display.')
        check_deadline(spec)
        if not xt.XTestFakeMotionEvent(display, -1, px, py, 0): raise RuntimeError('Pointer input failed.')
    def button(number, down):
        if down: check_deadline(spec)
        if not xt.XTestFakeButtonEvent(display, number, int(down), 0): raise RuntimeError('Button input failed.')
        x.XSync(display, 0)
    try:
        check_deadline(spec)
        if action['type'] == 'drag':
            move(action['fromX'], action['fromY']); button(1, True); pressed = True
            for index in range(1, 11):
                move(round(action['fromX'] + (action['toX'] - action['fromX']) * index / 10), round(action['fromY'] + (action['toY'] - action['fromY']) * index / 10))
                x.XSync(display, 0); time.sleep(.015)
        elif action['type'] == 'click':
            move(action['x'], action['y'])
            for index in range(action.get('clickCount', 1)):
                check_deadline(spec); button(2, True); button(2, False)
                if index == 0 and action.get('clickCount') == 2: time.sleep(.08)
        else:
            number = {'left': 6, 'right': 7}[action['direction']]
            for _ in range(action['amount']): check_deadline(spec); button(number, True); button(number, False)
    finally:
        try:
            if pressed: button(1, False)
        finally: x.XCloseDisplay(display)

def main(spec):
    check_deadline(spec)
    if spec['action'] == 'stop':
        sys.path.insert(0, '/opt/open-harness')
        from browser_shutdown import close_browser
        close_browser()
        return {'ok': True}
    if os.environ.get('OPEN_HARNESS_VIRTUAL_DESKTOP') != '1' or os.environ.get('DISPLAY') != ':99':
        raise RuntimeError('Only the private virtual desktop is available.')
    if spec['action'] == 'start':
        if not browser_processes():
            profile = os.environ.get('AGENT_BROWSER_PROFILE', '/workspace/private/.config/chromium')
            os.makedirs(profile, mode=0o700, exist_ok=True)
            # The previous container is confirmed stopped before reusing this profile.
            for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
                try: os.unlink(os.path.join(profile, name))
                except FileNotFoundError: pass
            downloads = os.environ.get('OPEN_HARNESS_DOWNLOAD_DIR')
            if downloads or spec.get('freshPage'):
                default_profile = os.path.join(profile, 'Default')
                os.makedirs(default_profile, mode=0o700, exist_ok=True)
                preferences_path = os.path.join(default_profile, 'Preferences')
                try:
                    with open(preferences_path) as saved: preferences = json.load(saved)
                except FileNotFoundError: preferences = {}
                if downloads:
                    os.makedirs(downloads, mode=0o700, exist_ok=True)
                    preferences.setdefault('download', {}).update({'default_directory': downloads, 'prompt_for_download': False})
                if spec.get('freshPage'):
                    preferences.setdefault('session', {}).update({'restore_on_startup': 5, 'startup_urls': []})
                    preferences.setdefault('profile', {}).update({'exit_type': 'Normal', 'exited_cleanly': True})
                temporary = preferences_path + '.open-harness-' + str(os.getpid())
                with open(temporary, 'x') as saved: json.dump(preferences, saved)
                os.replace(temporary, preferences_path)
            subprocess.Popen(['chromium', '--no-sandbox', '--disable-dev-shm-usage',
                '--force-renderer-accessibility', '--password-store=basic',
                '--user-data-dir=' + profile, *([] if spec.get('freshPage') else ['--restore-last-session']), 'about:blank'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
            deadline = time.monotonic() + 8
            while not browser_identity()['browserSessionId']:
                check_deadline(spec)
                if time.monotonic() >= deadline: raise RuntimeError('Browser startup was not confirmed.')
                time.sleep(.1)
        return {'ok': True, **browser_identity()}
    sys.path.insert(0, '/opt/open-harness')
    from cua_compat import install
    install()
    from tools.computer_use.cua_backend import CuaDriverBackend
    backend = CuaDriverBackend()
    try:
        backend.start()
        if spec['action'] == 'frame':
            cap = backend.capture(mode='vision', app='screen')
            raw = base64.b64decode(cap.png_b64 or '', validate=True)
            if not raw.startswith(b'\x89PNG\r\n\x1a\n') or len(raw) > 6000000:
                raise RuntimeError('Invalid desktop image.')
            return {'ok': True, 'image': 'data:image/png;base64,' + cap.png_b64,
                    'width': cap.width, 'height': cap.height, **browser_identity()}
        if spec['action'] == 'navigate':
            url = spec.get('url', '')
            parsed = urlsplit(url)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or any(ord(char) < 32 for char in url): raise RuntimeError('Invalid browser address.')
            backend.capture(mode='vision')
            for method, value in ((backend.key, 'Control+l'), (backend.type_text, url), (backend.key, 'Enter')):
                check_deadline(spec)
                if not method(value, delivery_mode='foreground').ok: raise RuntimeError('Browser navigation was not accepted.')
            return {'ok': True, **browser_identity()}
        action = spec['input']
        kind = action['type']
        cap = backend.capture(mode='som' if kind in ('click', 'scroll') else 'vision')
        # Setup and capture may outlast the remote request. Never apply delayed input.
        check_deadline(spec)
        if kind == 'drag' or kind == 'click' and action['button'] == 'middle' or kind == 'scroll' and action['direction'] in ('left', 'right'):
            pointer_input(spec, action)
            return {'ok': True}
        if kind == 'click':
            # Screenshots cover the desktop; CUA pointer input addresses the captured window.
            frame = next(element for element in cap.elements if element.role == 'frame')
            x, y = action['x'] - frame.bounds[0], action['y'] - frame.bounds[1]
            if not 0 <= x < frame.bounds[2] or not 0 <= y < frame.bounds[3]:
                raise RuntimeError('Click is outside the active window.')
            result = backend.click(x=int(x), y=int(y), button=action['button'], delivery_mode='foreground')
            if action.get('clickCount') == 2 and result.ok:
                time.sleep(.08); check_deadline(spec)
                result = backend.click(x=int(x), y=int(y), button=action['button'], delivery_mode='foreground')
        elif kind == 'scroll':
            result = backend.scroll(direction=action['direction'], amount=action['amount'], delivery_mode='foreground')
        elif kind == 'key':
            result = backend.key(action['key'], delivery_mode='foreground')
        elif kind == 'text':
            result = backend.type_text(action['text'], delivery_mode='foreground')
        else:
            raise RuntimeError('Unsupported desktop action.')
        if not result.ok:
            raise RuntimeError('Desktop input was not accepted.')
        return {'ok': True}
    finally:
        backend.stop()

try:
    spec = json.loads(sys.stdin.readline(25000))
    with open(os.devnull, 'w') as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        result = main(spec)
    print(json.dumps(result))
except Exception:
    # Input can contain passwords. Never expose driver errors, arguments or capture details.
    print(json.dumps({'error': 'The private desktop did not accept this request. Check its runtime and retry.'}))
    sys.exit(1)
`;

// runtime/computer-files.ts
import { createHash as createHash7 } from "node:crypto";
import { closeSync as closeSync4, constants as constants7, existsSync as existsSync7, fstatSync as fstatSync4, lstatSync as lstatSync7, mkdirSync as mkdirSync9, openSync as openSync4, readdirSync as readdirSync4, readSync as readSync2, unlinkSync as unlinkSync4, writeFileSync as writeFileSync7 } from "node:fs";
import { join as join10 } from "node:path";
var DESKTOP_FILE_LIMITS = { fileBytes: 25 * 1024 * 1024, batchBytes: 100 * 1024 * 1024, entries: 100 };
var claiming = /* @__PURE__ */ new Set();
var same = (first, second) => first.ownerId === second.ownerId && first.epoch === second.epoch && first.runId === second.runId;
function validateLease(agentId, lease) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(agentId) || lease.ownerId !== agentId || !Number.isSafeInteger(lease.epoch) || lease.epoch < 0 || lease.runId !== void 0 && !/^[\w-]{1,100}$/.test(lease.runId)) throw new Error("Desktop file ownership is invalid.");
}
function paths(agentId, root, computer) {
  const desktop = desktopResourcePaths(agentId, root, computer), prefix = `computers/${desktop.key}`;
  return { ...desktop, record: safeWorkspacePath(root, `${prefix}/exchange.json`), downloads: safeWorkspacePath(root, `${prefix}/staging/downloads`), uploads: safeWorkspacePath(root, `${prefix}/staging/uploads`), receipts: safeWorkspacePath(root, `${prefix}/receipts`) };
}
function readRecord(file, key) {
  if (!existsSync7(file)) return null;
  let value;
  try {
    value = JSON.parse(readWorkspaceFile(file).toString("utf8"));
  } catch {
    throw new Error("Desktop file ownership is unreadable.");
  }
  if (value.version !== 1 || value.resourceKey !== key || !value.lease || !value.observed || typeof value.observed !== "object" || Array.isArray(value.observed)) throw new Error("Desktop file ownership is invalid.");
  validateLease(value.lease.ownerId, value.lease);
  for (const lease of Object.values(value.observed)) validateLease(value.lease.ownerId, lease);
  return value;
}
function allowedName(name) {
  if (!name || Buffer.byteLength(name) > 180 || /^[.]/.test(name) || /[\x00-\x1f\x7f/:\\]/.test(name)) return false;
  try {
    safeWorkspacePath("/portable-desktop-exchange", name);
    return true;
  } catch {
    return false;
  }
}
var partial = (name) => /\.(?:crdownload|part|tmp)$/i.test(name);
function validateDesktopUploadName(value) {
  if (typeof value !== "string" || !allowedName(value) || partial(value)) throw new Error("Choose one ordinary file name from the agent exchange folder.");
  return value;
}
function entries(path2) {
  const names = readdirSync4(path2);
  if (names.length > DESKTOP_FILE_LIMITS.entries) throw new Error("Desktop exchange has too many files. Remove files before continuing.");
  return names.sort();
}
function identity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}
function observe(path2, record2) {
  const current = {};
  for (const name of entries(path2)) {
    const stat = lstatSync7(join10(path2, name));
    if (!stat.isFile() || stat.nlink !== 1) continue;
    const id = identity(stat);
    current[id] = record2.observed[id] || record2.lease;
  }
  record2.observed = current;
}
function readBounded(file) {
  const expected = lstatSync7(file);
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > DESKTOP_FILE_LIMITS.fileBytes) throw new Error("Desktop exchange accepts regular files up to 25 MiB only.");
  const fd = openSync4(file, constants7.O_RDONLY | (constants7.O_NOFOLLOW || 0) | (constants7.O_NONBLOCK || 0));
  try {
    const before = fstatSync4(fd);
    if (!before.isFile() || before.nlink !== 1 || identity(before) !== identity(expected)) throw new Error("Desktop file changed while opening it.");
    const data = Buffer.alloc(Math.min(before.size + 1, DESKTOP_FILE_LIMITS.fileBytes + 1));
    let size = 0;
    while (size < data.length) {
      const count = readSync2(fd, data, size, data.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync4(fd);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Desktop download is still changing.");
    return { data: data.subarray(0, size), stat: after };
  } finally {
    closeSync4(fd);
  }
}
function saveNew(file, data) {
  try {
    writeFileSync7(file, data, { flag: "wx", mode: 384 });
  } catch (error) {
    if (error.code !== "EEXIST" || !readBounded(file).data.equals(data)) throw error;
  }
}
function publish(agentId, root, computer, record2) {
  const p = paths(agentId, root, computer), result = [];
  observe(p.downloads, record2);
  let bytes2 = 0;
  for (const name of entries(p.downloads)) {
    if (!allowedName(name) || partial(name)) continue;
    const source = join10(p.downloads, name);
    let value;
    try {
      value = readBounded(source);
    } catch {
      continue;
    }
    if (bytes2 + value.data.length > DESKTOP_FILE_LIMITS.batchBytes) break;
    const origin = record2.observed[identity(value.stat)];
    if (!origin || origin.ownerId !== agentId) throw new Error("Desktop download owner changed.");
    const sha256 = createHash7("sha256").update(value.data).digest("hex"), id = createHash7("sha256").update(JSON.stringify([p.key, origin, identity(value.stat), sha256])).digest("hex").slice(0, 32);
    const nameOnDisk = `${id}-${name}`, privateDirectory = safeWorkspacePath(root, `agents/${agentId}/private/downloads`);
    mkdirSync9(privateDirectory, { recursive: true, mode: 448 });
    mkdirSync9(p.receipts, { recursive: true, mode: 448 });
    const target = safeWorkspacePath(root, `agents/${agentId}/private/downloads/${nameOnDisk}`), receiptPath = safeWorkspacePath(root, `computers/${p.key}/receipts/${id}.json`);
    saveNew(target, value.data);
    const receipt = { ...origin, id, name, path: `downloads/${nameOnDisk}`, bytes: value.data.length, sha256, savedAt: (/* @__PURE__ */ new Date()).toISOString() };
    if (!existsSync7(receiptPath)) atomicWorkspaceWrite(receiptPath, JSON.stringify(receipt));
    const now = lstatSync7(source);
    if (identity(now) === identity(value.stat) && now.size === value.stat.size && now.mtimeMs === value.stat.mtimeMs) unlinkSync4(source);
    result.push(receipt);
    bytes2 += value.data.length;
  }
  observe(p.downloads, record2);
  atomicWorkspaceWrite(p.record, JSON.stringify(record2));
  return result;
}
function clearStaging(staging) {
  const files = [], directories = [];
  const walk = (path2, depth) => {
    if (depth > 3) throw new Error("Desktop staging contains unsupported directories.");
    for (const name of readdirSync4(path2)) {
      if (files.length + directories.length >= DESKTOP_FILE_LIMITS.entries * 3) throw new Error("Desktop staging needs cleanup before it can change owners.");
      const file = join10(path2, name), stat = lstatSync7(file);
      if (stat.isDirectory()) {
        if (file !== join10(staging, "downloads") && file !== join10(staging, "uploads")) throw new Error("Desktop staging contains unsupported directories.");
        directories.push(file);
        walk(file, depth + 1);
      } else files.push(file);
    }
  };
  walk(staging, 0);
  for (const file of files) unlinkSync4(file);
}
async function claimDesktopExchange(agentId, root, computer, lease, stopBrowser) {
  validateLease(agentId, lease);
  const p = paths(agentId, root, computer);
  if (claiming.has(p.key)) throw new Error("Desktop file ownership is changing.");
  claiming.add(p.key);
  try {
    mkdirSync9(p.downloads, { recursive: true, mode: 448 });
    mkdirSync9(p.uploads, { recursive: true, mode: 448 });
    const previous = readRecord(p.record, p.key), original = JSON.stringify(previous);
    if (previous && lease.epoch < previous.lease.epoch) throw new Error("Desktop file ownership is stale.");
    const reset = previous ? previous.lease.ownerId !== agentId : readdirSync4(p.staging).some((name) => !["downloads", "uploads"].includes(name)) || entries(p.downloads).length > 0 || entries(p.uploads).length > 0;
    if (reset) {
      await stopBrowser();
      if (JSON.stringify(readRecord(p.record, p.key)) !== original) throw new Error("Desktop file ownership changed during browser shutdown.");
      if (previous) publish(previous.lease.ownerId, root, computer, previous);
      clearStaging(p.staging);
    } else if (previous) observe(p.downloads, previous);
    const next = { version: 1, resourceKey: p.key, lease: { ...lease }, observed: reset ? {} : previous?.observed || {} };
    atomicWorkspaceWrite(p.record, JSON.stringify(next));
    return { reset };
  } finally {
    claiming.delete(p.key);
  }
}
function publishDesktopDownloads(agentId, root, computer, lease) {
  validateLease(agentId, lease);
  const p = paths(agentId, root, computer), record2 = readRecord(p.record, p.key);
  if (claiming.has(p.key) || !record2 || !same(record2.lease, lease)) throw new Error("Desktop file ownership changed.");
  return publish(agentId, root, computer, record2);
}
function stageDesktopUpload(agentId, root, computer, lease, name) {
  validateLease(agentId, lease);
  const p = paths(agentId, root, computer), record2 = readRecord(p.record, p.key);
  if (claiming.has(p.key) || !record2 || !same(record2.lease, lease)) throw new Error("Desktop file ownership changed.");
  validateDesktopUploadName(name);
  const value = readBounded(safeWorkspacePath(root, `agents/${agentId}/private/exchange/${name}`));
  let total = 0;
  const existing = entries(p.uploads);
  for (const item of existing) {
    const stat = lstatSync7(join10(p.uploads, item));
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Upload staging contains an unsupported file.");
    total += stat.size;
  }
  const destination = `${createHash7("sha256").update(value.data).digest("hex").slice(0, 16)}-${name}`;
  if (!existing.includes(destination) && (existing.length >= DESKTOP_FILE_LIMITS.entries || total + value.data.length > DESKTOP_FILE_LIMITS.batchBytes)) throw new Error("Desktop upload staging is full.");
  saveNew(safeWorkspacePath(root, `computers/${p.key}/staging/uploads/${destination}`), value.data);
  return { name, bytes: value.data.length, path: `/workspace/exchange/uploads/${destination}` };
}

// runtime/desktop-control.ts
var keys = /^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Insert|Space|F(?:[1-9]|1[0-2])|[\-=[\]\\;',./`])$/;
var coordinate = (value, limit) => Number.isInteger(value) && Number(value) >= 0 && Number(value) < limit;
function validateDesktopInput(input) {
  if (!input || typeof input !== "object") throw new ProfileError("Choose a desktop action.");
  const value = input;
  if (value.type === "click" && coordinate(value.x, 1440) && coordinate(value.y, 900) && ["left", "right", "middle"].includes(String(value.button || "left")) && (value.clickCount === void 0 || [1, 2].includes(Number(value.clickCount)))) return { type: "click", x: Number(value.x), y: Number(value.y), button: value.button || "left", ...value.clickCount ? { clickCount: Number(value.clickCount) } : {} };
  if (value.type === "drag" && coordinate(value.fromX, 1440) && coordinate(value.fromY, 900) && coordinate(value.toX, 1440) && coordinate(value.toY, 900)) return { type: "drag", fromX: Number(value.fromX), fromY: Number(value.fromY), toX: Number(value.toX), toY: Number(value.toY) };
  if (value.type === "scroll" && ["up", "down", "left", "right"].includes(String(value.direction)) && Number.isInteger(value.amount) && Number(value.amount) >= 1 && Number(value.amount) <= 10) return { type: "scroll", direction: value.direction, amount: Number(value.amount) };
  if (value.type === "key" && typeof value.key === "string" && value.key.length <= 80 && keys.test(value.key)) return { type: "key", key: value.key };
  if (value.type === "text" && typeof value.text === "string" && value.text.length > 0 && value.text.length <= 4e3 && !value.text.includes("\0")) return { type: "text", text: value.text };
  throw new ProfileError("Desktop input is invalid or outside the supported screen.");
}
function validateDesktopUrl(value) {
  if (typeof value !== "string" || value.length > 4e3) throw new ProfileError("Enter a browser address.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProfileError("Enter a complete http or https browser address.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new ProfileError("Use an http or https address without embedded credentials.");
  return url.href;
}
function checkDeadline(command2) {
  if (command2.expiresAt !== void 0 && (!Number.isFinite(command2.expiresAt) || command2.expiresAt <= Date.now())) throw new ProfileError("This computer request expired. Refresh and try again.", 409);
}
var executions = /* @__PURE__ */ new Map();
async function executeDesktopCommand(root, profile, command2) {
  validId(profile.id);
  if (!isSandboxedComputer(profile.computer) || profile.computer.desktop !== "virtual") throw new ProfileError("Enable the private agent desktop in Computer settings first.", 409);
  const key = desktopResourceKey(profile.id, root, profile.computer), previous = executions.get(key);
  const work = (async () => {
    if (previous) await previous.catch(() => {
    });
    checkDeadline(command2);
    const exchangeLease = (ownership) => ({ ownerId: profile.id, epoch: ownership.generation, ...ownership.owner === "agent" ? { runId: ownership.identity } : {} });
    if (command2.action === "claim") {
      if (!validComputerOwnership(command2.ownership)) throw new ProfileError("Computer ownership is required.", 409);
      claimComputerOwnership(root, profile, command2.ownership);
      if (process.env.OPEN_HARNESS_MOCK !== "1") {
        const exchange = await claimDesktopExchange(profile.id, root, profile.computer, exchangeLease(command2.ownership), async () => {
          const container2 = await runningDesktopContainer(profile.id, root, profile.computer);
          if (container2) await desktopHelper(container2, { action: "stop", expiresAt: command2.expiresAt });
        });
        if (exchange.reset) {
          const container2 = await ensureDesktopContainerAsync(profile.id, root, profile.computer);
          await desktopHelper(container2, { action: "start", freshPage: true, expiresAt: command2.expiresAt });
        }
      }
      return { ok: true };
    }
    if (command2.ownership) assertComputerOwnership(root, profile, command2.ownership);
    else if (!["frame", "reset"].includes(command2.action) && readComputerOwnership(root, profile)) throw new ProfileError("Computer ownership is required.", 409);
    const input = command2.action === "input" ? validateDesktopInput(command2.input) : void 0;
    const url = command2.action === "navigate" ? validateDesktopUrl(command2.url) : void 0;
    if (!["start", "frame", "input", "navigate", "stage-upload", "stop", "reset"].includes(command2.action)) throw new ProfileError("Unsupported computer command.");
    if (process.env.OPEN_HARNESS_MOCK === "1") return command2.action === "frame" ? { ok: true, mock: true, image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", width: 1440, height: 900 } : { ok: true, sessionId: `mock-desktop-${key}` };
    if (command2.action === "stop") {
      await stopAgentContainers(profile.id, root);
      return { ok: true };
    }
    if (command2.action === "reset") {
      await stopAgentContainers(profile.id, root);
      await stopDesktopContainer(profile.id, root, profile.computer);
      return { ok: true };
    }
    if (command2.action === "stage-upload") {
      if (!command2.ownership) throw new ProfileError("Computer ownership is required.", 409);
      return { ok: true, ...stageDesktopUpload(profile.id, root, profile.computer, exchangeLease(command2.ownership), String(command2.fileName || "")) };
    }
    if (command2.action === "start") await ensureDesktopContainerAsync(profile.id, root, profile.computer);
    const container = await runningDesktopContainer(profile.id, root, profile.computer);
    checkDeadline(command2);
    if (command2.ownership) assertComputerOwnership(root, profile, command2.ownership);
    if (!container) throw new ProfileError("This private desktop is stopped. Take control to open it.", 409);
    const result = await desktopHelper(container, { ...command2, ...input ? { input } : {}, ...url ? { url } : {} });
    let files = {};
    if (command2.ownership) {
      try {
        files = { downloads: publishDesktopDownloads(profile.id, root, profile.computer, exchangeLease(command2.ownership)) };
      } catch {
        files = { fileExchangeError: "Some browser files could not be copied into the agent workspace. Check the exchange limits and file ownership." };
      }
    }
    return { ...result, ...files, ...command2.action === "start" ? { sessionId: `${container}:${String(result.browserSessionId || result.sessionId || "browser")}` } : {} };
  })();
  executions.set(key, work);
  try {
    return await work;
  } finally {
    if (executions.get(key) === work) executions.delete(key);
  }
}
function desktopHelper(container, command2) {
  return new Promise((resolve8, reject) => {
    const child = spawn5("docker", ["exec", "-i", container, "timeout", "--signal=KILL", "18s", "python", "-c", DESKTOP_HELPER], { stdio: ["pipe", "pipe", "ignore"], timeout: 2e4, killSignal: "SIGKILL" });
    let output2 = "", settled = false;
    const fail = () => {
      if (!settled) {
        settled = true;
        reject(new ProfileError("The private desktop did not respond. Check the runtime and retry.", 503));
      }
    };
    child.stdout.on("data", (chunk) => {
      output2 += chunk;
      if (output2.length > 9e6) {
        child.kill("SIGKILL");
        fail();
      }
    });
    child.once("error", fail);
    child.stdin.on("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail();
        return;
      }
      try {
        const result = JSON.parse(output2);
        if (!result.ok) {
          fail();
          return;
        }
        settled = true;
        resolve8(result);
      } catch {
        fail();
      }
    });
    child.stdin.end(JSON.stringify(command2) + "\n");
  });
}

// runtime/runner-duplex.ts
import { Duplex as Duplex2, Transform } from "node:stream";

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// runtime/computer-stream.ts
import { spawn as spawn6 } from "node:child_process";
import { Duplex } from "node:stream";

// runtime/desktop-stream-helper.ts
var DESKTOP_STREAM_HELPER = String.raw`
import base64, contextlib, hashlib, io, os, struct, sys, time
wire = sys.stdout.buffer
source = sys.stdin.buffer
def read(size):
    value = bytearray()
    while len(value) < size:
        chunk = source.read(size - len(value))
        if not chunk: raise EOFError()
        value.extend(chunk)
    return bytes(value)
def send(value):
    wire.write(value)
    wire.flush()
def length(value):
    output = bytearray()
    for index in range(3):
        part = value & 127 if index < 2 else value & 255
        value >>= 7 if index < 2 else 8
        output.append(part | (128 if value and index < 2 else 0))
        if not value: break
    return bytes(output)
backend = None
quiet = open(os.devnull, 'w')
failed = False
try:
    if os.environ.get('OPEN_HARNESS_VIRTUAL_DESKTOP') != '1' or os.environ.get('DISPLAY') != ':99': raise RuntimeError()
    sys.path.insert(0, '/opt/open-harness')
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        from cua_compat import install
        install()
        from tools.computer_use.cua_backend import CuaDriverBackend
        backend = CuaDriverBackend()
        backend.start()
    send(b'RFB 003.008\n')
    if read(12) != b'RFB 003.008\n': raise RuntimeError()
    send(b'\x01\x01')
    if read(1) != b'\x01': raise RuntimeError()
    send(struct.pack('>I', 0))
    read(1)
    name = b'Open Harness private desktop (input through human control)'
    send(struct.pack('>HHBBBBHHHBBBxxxI',1440,900,32,24,0,1,255,255,255,0,8,16,len(name))+name)
    encodings = set()
    previous = None
    last = 0
    while True:
        kind = read(1)[0]
        if kind == 0:
            value = read(19)
            if value[3] != 32 or value[6] != 1: raise RuntimeError()
        elif kind == 2:
            _, count = struct.unpack('>BH',read(3))
            if count > 256: raise RuntimeError()
            encodings = set(struct.unpack('>'+'i'*count,read(count*4)))
        elif kind == 3:
            incremental,x,y,width,height = struct.unpack('>BHHHH',read(9))
            # Always send a complete frame; coordinates and clipboard content never enter recordings.
            delay = .2 - (time.monotonic()-last)
            if delay > 0: time.sleep(delay)
            with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                cap = backend.capture(mode='vision',app='screen')
            raw = base64.b64decode(cap.png_b64 or '',validate=True)
            if cap.width != 1440 or cap.height != 900 or len(raw)>6000000: raise RuntimeError()
            fingerprint = hashlib.sha256(raw).digest()
            last = time.monotonic()
            if incremental and fingerprint == previous:
                send(b'\x00\x00\x00\x00')
                continue
            previous = fingerprint
            if -260 in encodings:
                payload = b'\xa0'+length(len(raw))+raw
                encoding = -260
            else:
                from PIL import Image
                payload = Image.open(io.BytesIO(raw)).convert('RGBA').tobytes()
                encoding = 0
            send(b'\x00\x00\x00\x01'+struct.pack('>HHHHi',0,0,1440,900,encoding)+payload)
        elif kind == 4: read(7)
        elif kind == 5: read(5)
        elif kind == 6:
            value = read(7)
            size = struct.unpack('>I',value[3:])[0]
            if size>65536: raise RuntimeError()
            read(size)
        else: raise RuntimeError()
except (EOFError,BrokenPipeError):
    pass
except Exception:
    failed = True
    print('The private desktop stream could not continue.', file=sys.stderr)
finally:
    if backend:
        try:
            with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                backend.stop()
        except Exception:
            if not failed: print('The private desktop stream could not continue.', file=sys.stderr)
            failed = True
    quiet.close()
if failed: raise SystemExit(1)
`;

// runtime/terminal-helper.ts
var TERMINAL_HELPER = String.raw`
import base64, errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
pid, master = pty.fork()
if pid == 0:
    os.chdir('/workspace/shared')
    os.environ.update(TERM='xterm-256color', HISTFILE='/dev/null')
    os.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-i'])
def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()
pending = bytearray()
def terminate(_signal, _frame):
    raise SystemExit()
signal.signal(signal.SIGTERM, terminate)
try:
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    while True:
        ready, _, _ = select.select([0, master], [], [], 1)
        if 0 in ready:
            chunk = os.read(0, 8192)
            if not chunk: break
            pending.extend(chunk)
            if len(pending) > 65536: raise ValueError()
            while b'\n' in pending:
                line, _, rest = pending.partition(b'\n')
                pending = bytearray(rest)
                item = json.loads(line)
                if item.get('type') == 'input':
                    value = base64.b64decode(item['data'], validate=True)
                    if len(value) > 16384: raise ValueError()
                    while value:
                        written = os.write(master, value)
                        value = value[written:]
                elif item.get('type') == 'resize':
                    rows, cols = item['rows'], item['cols']
                    if type(rows) is not int or type(cols) is not int or not 1 <= rows <= 200 or not 1 <= cols <= 500: raise ValueError()
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                else: raise ValueError()
        if master in ready:
            try: chunk = os.read(master, 4096)
            except OSError as error:
                if error.errno != errno.EIO: raise
                chunk = b''
            if not chunk: break
            emit({'type': 'output', 'data': base64.b64encode(chunk).decode('ascii')})
except (BrokenPipeError, EOFError, OSError, ValueError, KeyError, TypeError):
    pass
finally:
    os.close(master)
    try: os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError: pass
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        # Keep the child unreaped until group signaling ends, so its PID cannot be reused.
        if os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT): break
        time.sleep(.02)
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    _, status = os.waitpid(pid, 0)
    try: emit({'type': 'exit', 'code': os.waitstatus_to_exitcode(status)})
    except (BrokenPipeError, OSError): pass
`;

// runtime/computer-stream.ts
function immutableContainer(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function startComputerStream(containerId, kind) {
  if (!immutableContainer(containerId)) throw new Error("The computer container identity could not be confirmed.");
  const seconds = kind === "terminal" ? 1800 : 300;
  const child = spawn6("docker", ["exec", "-i", containerId, "timeout", "--signal=TERM", "--kill-after=3s", `${seconds}s`, "python", "-c", kind === "terminal" ? TERMINAL_HELPER : DESKTOP_STREAM_HELPER], { stdio: ["pipe", "pipe", "ignore"], timeout: (seconds + 5) * 1e3, killSignal: "SIGKILL" });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  stream.on("error", () => {
  });
  child.stdin.on("error", () => {
  });
  child.once("error", () => stream.destroy(new Error("The computer stream could not start.")));
  let closed = false, exited = false;
  child.once("close", (code) => {
    exited = true;
    if (!closed && code !== 0) stream.destroy(new Error("The computer stream could not continue."));
  });
  const close = () => {
    if (closed) return;
    closed = true;
    child.stdin.end();
    if (!exited) {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2e3);
      timer.unref();
      child.once("close", () => clearTimeout(timer));
    }
    stream.destroy();
  };
  stream.once("close", close);
  return { stream, containerId, close };
}

// runtime/runner-duplex.ts
var runnerConnections = /* @__PURE__ */ new Map();
function closeRunnerDuplex(root) {
  for (const stop of runnerConnections.get(root) || []) stop();
  runnerConnections.delete(root);
}
async function admitRunnerTerminal(agentId, expiresAt, operations, validate2, start) {
  const deadline = Math.min(expiresAt, Date.now() + 1e4);
  let previous;
  for (; ; ) {
    validate2();
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("The terminal invitation expired while the computer was busy.");
    const operation = operations.get(agentId);
    if (!operation || operation === previous) {
      let ready;
      const startup = new Promise((resolve8) => {
        ready = resolve8;
      });
      const release = () => {
        if (operations.get(agentId) === startup) operations.delete(agentId);
        ready();
      };
      operations.set(agentId, startup);
      try {
        return await start(release);
      } finally {
        release();
      }
    }
    previous = operation;
    let timer;
    try {
      await Promise.race([operation, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The computer is still busy. Reconnect the terminal and retry.")), deadline - Date.now());
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
}
async function executeRunnerDuplex(root, credentials2, command2, admission = {}) {
  assertContainerAdmission(root);
  admission.validate?.();
  const { profile, ownership, kind, expiresAt } = command2.payload;
  if (!profile || profile.id !== command2.agentId || profile.computer.machineId !== credentials2.machineId || !["terminal", "desktop"].includes(kind) || typeof expiresAt !== "number" || expiresAt <= Date.now() || !/^\/v1\/runner\/duplex\?ticket=[A-Za-z0-9_-]{43}$/.test(command2.payload.path)) throw new Error("The computer invitation is invalid or expired.");
  if (kind === "terminal" && ownership.owner !== "human") throw new Error("Take control before opening a terminal.");
  assertComputerOwnership(root, profile, ownership);
  const containerId = kind === "terminal" ? await ensureContainerAsync(profile.id, root, profile.computer) : await runningDesktopContainer(profile.id, root, profile.computer);
  assertComputerOwnership(root, profile, ownership);
  assertContainerAdmission(root);
  admission.validate?.();
  if (!immutableContainer(containerId) || expiresAt <= Date.now()) throw new Error("The computer is not ready.");
  const url = new URL(credentials2.coordinator.replace(/\/$/, "") + command2.payload.path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new import_websocket.default(url, { headers: { Authorization: `Bearer ${credentials2.token}`, "X-Open-Harness-Machine": credentials2.machineId }, maxPayload: 65536, handshakeTimeout: 5e3, perMessageDeflate: false });
  return new Promise((resolve8, reject) => {
    let source, ended = false, checking = false;
    const finish2 = (error) => {
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      clearInterval(check);
      source?.close();
      ws.terminate();
      connections.delete(stop);
      if (!connections.size) runnerConnections.delete(root);
      admission.ready?.();
      if (error) reject(error);
      else resolve8();
    };
    const stop = () => finish2(), connections = runnerConnections.get(root) || /* @__PURE__ */ new Set();
    connections.add(stop);
    runnerConnections.set(root, connections);
    const deadline = setTimeout(() => finish2(new Error("The computer connection was not accepted.")), 1e4);
    const check = setInterval(() => {
      if (checking || ended) return;
      checking = true;
      void (async () => {
        assertComputerOwnership(root, profile, ownership);
        const current = kind === "terminal" ? await runningAgentContainer(profile.id, root) : await runningDesktopContainer(profile.id, root, profile.computer);
        if (current !== containerId) throw new Error("The computer changed.");
      })().catch(() => finish2()).finally(() => {
        checking = false;
      });
    }, 1e3);
    ws.once("open", () => {
      try {
        admission.validate?.();
        assertComputerOwnership(root, profile, ownership);
        ws.send(JSON.stringify({ type: "ready", containerId }));
      } catch {
        finish2();
      }
    });
    ws.once("message", (data, binary) => {
      try {
        if (binary || JSON.parse(data.toString()).type !== "accepted" || expiresAt <= Date.now()) throw new Error("The computer invitation expired.");
        admission.validate?.();
        assertComputerOwnership(root, profile, ownership);
        clearTimeout(deadline);
        source = startComputerStream(containerId, kind);
        const stream = (0, import_stream.default)(ws, { highWaterMark: 65536 });
        stream.on("error", () => finish2());
        const guard = new Transform({ highWaterMark: 65536, transform(chunk, _encoding, callback) {
          void (async () => {
            assertComputerOwnership(root, profile, ownership);
            const current = kind === "terminal" ? await runningAgentContainer(profile.id, root) : await runningDesktopContainer(profile.id, root, profile.computer);
            if (current !== containerId) throw new Error("The computer changed.");
            assertComputerOwnership(root, profile, ownership);
            callback(null, chunk);
          })().catch(() => callback(new Error("Computer control changed.")));
        } });
        guard.on("error", () => finish2());
        stream.pipe(guard).pipe(source.stream).pipe(stream);
        source.stream.once("close", () => {
          if (!source?.stream.readableEnded) finish2();
        });
        admission.ready?.();
      } catch {
        finish2(new Error("The computer connection could not start."));
      }
    });
    ws.once("error", () => finish2(new Error("The runner computer connection failed.")));
    ws.once("close", () => finish2());
  });
}

// runtime/runner.ts
var args = /* @__PURE__ */ new Map();
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith("--")) args.set(process.argv[i].slice(2), process.argv[i + 1]?.startsWith("--") ? "" : process.argv[++i] || "");
var stateRoot = resolve7(process.env.OPEN_HARNESS_RUNNER_STATE_DIR || join11(homedir2(), ".open-harness-runner"));
var credentialPath = join11(stateRoot, "connection.json");
var spool = join11(stateRoot, "spool");
mkdirSync10(spool, { recursive: true });
var runnerSecrets;
try {
  runnerSecrets = new SecretStore(join11(stateRoot, "secrets.json"));
} catch (error) {
  console.error(error instanceof Error ? error.message : "The runner could not open its credential store.");
  process.exit(1);
}
function output(command2, args2, timeout) {
  return new Promise((resolve8) => {
    let done = false, stdout = "";
    const settle = (status) => {
      if (!done) {
        done = true;
        resolve8({ status, stdout });
      }
    };
    const child = spawn7(command2, args2, { stdio: ["ignore", "pipe", "ignore"], timeout, killSignal: "SIGKILL" });
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.on("error", () => settle(null));
    child.on("exit", (code) => settle(code));
  });
}
async function probeCapabilities() {
  const container = process.env.OPEN_HARNESS_MOCK === "1" || classifyContract(await output("docker", ["image", "inspect", "-f", `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE], 5e3)) === "current";
  return { container, direct: false, desktop: false, virtualDesktop: process.platform === "linux" && container, detail: container ? "Private agent workspaces are ready. Desktop control uses an isolated agent desktop." : "Install Docker and prepare the pinned runtime to enable sandboxed agents." };
}
var known = null;
var probing = null;
function capabilities() {
  return probing ??= probeCapabilities().then((value) => known = { ...value, protocol: 1, features: ["workspace-tools", "run-leases", "scoped-tool-review", "async-admission", "desktop-preview", "computer-duplex", "computer-ownership", "execution-quiescence", "continuous-computer", "terminal-pty", "browser-state-transfer", "sealed-agent-transfer"] }).finally(() => {
    probing = null;
  });
}
async function pair() {
  const coordinator = String(args.get("coordinator") || "").replace(/\/$/, ""), code = String(args.get("pairing-code") || "");
  if (!coordinator || !code) throw new Error("Use --coordinator URL and --pairing-code CODE, or keep an existing runner connection.");
  const target = new URL(coordinator), loopback = ["localhost", "127.0.0.1", "::1"].includes(target.hostname);
  if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) throw new Error("Remote coordinators must use HTTPS. Plain HTTP is accepted only for a coordinator on this computer.");
  const encryption = await generateRunnerKeyPair();
  const response = await fetch(`${coordinator}/v1/runner/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name: hostname(), platform: platform2(), arch: arch(), capabilities: await capabilities(), encryptionPublicKey: encryption.publicKey }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "Pairing failed.");
  const saved = { coordinator, machineId: value.machineId, token: value.token, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey };
  writeFileSync8(credentialPath, JSON.stringify(saved, null, 2), { mode: 384 });
  chmodSync3(credentialPath, 384);
  return saved;
}
var credentials = args.has("pairing-code") ? await pair() : existsSync8(credentialPath) ? JSON.parse(readFileSync8(credentialPath, "utf8")) : await pair();
if (!credentials.encryptionPrivateKey || !credentials.encryptionPublicKey) {
  const encryption = await generateRunnerKeyPair();
  credentials = { ...credentials, encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey };
  writeFileSync8(credentialPath, JSON.stringify(credentials, null, 2), { mode: 384 });
  chmodSync3(credentialPath, 384);
}
var savedTarget = new URL(credentials.coordinator);
var savedLoopback = ["localhost", "127.0.0.1", "::1"].includes(savedTarget.hostname);
if (savedTarget.protocol !== "https:" && !(savedTarget.protocol === "http:" && savedLoopback)) throw new Error("The saved remote coordinator URL is not HTTPS. Pair this runner again using a secure URL.");
if (args.has("once")) {
  console.log(`Paired ${credentials.machineId}.`);
  process.exit(0);
}
var headers = { Authorization: `Bearer ${credentials.token}`, "X-Open-Harness-Machine": credentials.machineId, "Content-Type": "application/json" };
async function request(path2, init = {}, retry = false) {
  for (; ; ) {
    try {
      const response = await fetch(credentials.coordinator + path2, { ...init, signal: init.signal || AbortSignal.timeout(35e3), headers: { ...headers, ...init.headers } });
      const value = await readRunnerResponse(response);
      if (!response.ok) throw new Error(value.error || `Coordinator returned HTTP ${response.status}.`);
      return value;
    } catch (error) {
      if (!retry) throw error;
      await new Promise((resolve8) => setTimeout(resolve8, 2e3));
    }
  }
}
var active = /* @__PURE__ */ new Map();
var admittedCommands = /* @__PURE__ */ new Set();
var agentOperations = /* @__PURE__ */ new Map();
var browserOperations = /* @__PURE__ */ new Map();
var blockedBrowserGroups = /* @__PURE__ */ new Map();
var blockedAgents = /* @__PURE__ */ new Set();
var terminalAdmissionEpochs = /* @__PURE__ */ new Map();
var admittedRuns = /* @__PURE__ */ new Map();
var shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const admissions = closeContainerAdmissions(stateRoot);
  closeRunnerDuplex(stateRoot);
  for (const admission of admittedRuns.values()) admission.cancelled = true;
  console.log(`Open Harness runner stopping on ${signal}.`);
  const deadline = setTimeout(() => {
    console.error("Runner cleanup timed out; some computers may still be running.");
    process.exit(1);
  }, 12e4);
  deadline.unref();
  await admissions;
  const stopped2 = await Promise.allSettled([...active.values()].map((live) => {
    live.stopping = true;
    writeRunLease(stateRoot, live.agentId, null);
    return live.gateway.stop();
  }));
  let failed = stopped2.some((result) => result.status === "rejected");
  try {
    const result = await stopManagedContainers(stateRoot);
    if (result.failures.length) {
      failed = true;
      console.error(result.failures.join("\n"));
    }
  } catch {
    failed = true;
    console.error("Runner computer cleanup could not be confirmed.");
  }
  clearTimeout(deadline);
  process.exit(failed ? 1 : 0);
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => void shutdown(signal));
async function deliver(record2) {
  const file = join11(spool, `${record2.id}.json`);
  if (!existsSync8(file)) writeFileSync8(file, JSON.stringify(record2), { mode: 384 });
  await request(record2.path, { method: "POST", body: JSON.stringify(record2.body) }, true);
  if (existsSync8(file)) unlinkSync5(file);
}
async function flushSpool() {
  for (const name of readdirSync5(spool).filter((name2) => name2.endsWith(".json"))) {
    try {
      await deliver(JSON.parse(readFileSync8(join11(spool, name), "utf8")));
    } catch {
    }
  }
}
async function emit(command2, event) {
  const eventId = crypto.randomUUID();
  await deliver({ id: eventId, path: `/v1/runner/commands/${command2.id}/events`, body: { eventId, runId: command2.payload.runId, event } });
}
async function finish(command2, result, error) {
  await deliver({ id: `complete-${command2.id}`, path: `/v1/runner/commands/${command2.id}/complete`, body: error ? { error: error instanceof Error ? error.message : String(error) } : { result } });
}
async function openDispatchedSecrets(sealed) {
  if (!sealed) return {};
  const opened = await Promise.all(Object.entries(sealed).map(async ([name, payload]) => [name, await decryptRunnerSecret(credentials.encryptionPrivateKey, payload)]));
  return Object.fromEntries(opened);
}
async function run(command2) {
  const payload = command2.payload;
  const profile = payload.snapshot;
  let gateway, result, failure3;
  const admittedAt = performance.now(), phase = (name) => emit(command2, { type: "run.phase", payload: { phase: name, runnerElapsedMs: Math.round(performance.now() - admittedAt) } });
  try {
    assertSandboxedComputer(profile.computer);
    const assertOwnership = () => {
      if (profile.computer.desktop === "virtual") {
        if (!payload.ownership || payload.ownership.owner !== "agent") throw new Error("The agent computer ownership is missing. Update the coordinator.");
        assertComputerOwnership(stateRoot, profile, payload.ownership);
      }
    };
    assertOwnership();
    const shared = join11(stateRoot, "shared");
    mkdirSync10(shared, { recursive: true });
    const needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter((item) => item.enabled).map((item) => item.secretRef)].filter(Boolean);
    const availableSecrets = { ...runnerSecrets.environment(), ...process.env };
    const localSecrets = Object.fromEntries(needed.filter((name) => availableSecrets[name]).map((name) => [name, availableSecrets[name]]));
    const dispatched = await openDispatchedSecrets(payload.encryptedSecrets);
    if (admittedRuns.get(payload.runId)?.cancelled) throw new Error("Run stopped before its runtime started.");
    const ephemeralSecrets = { environment: () => ({ ...localSecrets, ...dispatched }) };
    const coordinatorForContainer = credentials.coordinator.replace("://localhost", "://host.docker.internal").replace("://127.0.0.1", "://host.docker.internal");
    prepareProfile(stateRoot, profile, profile.effectiveModel, ephemeralSecrets, payload.coordinationToken, payload.runId, { controlUrl: coordinatorForContainer, reviewUnclassified: payload.reviewUnclassified });
    await phase("profile-ready");
    const container = await ensureContainerAsync(profile.id, stateRoot, profile.computer, false, command2.payload.teamIds || [], () => [...active.values()].some((live2) => live2.agentId === profile.id));
    assertOwnership();
    if (admittedRuns.get(payload.runId)?.cancelled || blockedAgents.has(profile.id)) throw new Error("Run stopped before its runtime started.");
    gateway = new HermesGateway(container, runToolGrants(profile));
    const live = { gateway, sessionId: null, commandId: command2.id, stopping: false, agentId: profile.id };
    active.set(payload.runId, live);
    gateway.on("event", (event) => void emit(command2, event));
    await gateway.start();
    await phase("gateway-ready");
    if (live.stopping) throw new Error("Run stopped before its session started.");
    const session = await gateway.request("session.create", { cwd: "/workspace/shared", profile: "default", messages: payload.history || [] });
    const sessionId = String(session?.session_id || session?.id || "");
    if (!sessionId) throw new Error("Hermes did not return a session ID.");
    live.sessionId = sessionId;
    await emit(command2, { type: "session.started", session_id: sessionId, payload: { session_id: sessionId } });
    if (live.stopping) throw new Error("Run stopped before its prompt started.");
    assertOwnership();
    await phase("prompt-dispatched");
    result = await gateway.submitPrompt(sessionId, payload.prompt);
    await phase("execution-finished");
  } catch (error) {
    failure3 = error;
  }
  try {
    await gateway?.stop();
    active.delete(payload.runId);
    await phase("cleanup-finished");
  } catch (error) {
    blockedAgents.add(profile.id);
    failure3 = new Error(`Agent cleanup could not be confirmed. Further work is blocked until it is stopped: ${error instanceof Error ? error.message : error}`);
  }
  await finish(command2, result, failure3);
}
function transferBinding(command2) {
  return { transferId: String(command2.payload.transferId || ""), agentId: command2.agentId, sourceMachineId: String(command2.payload.sourceMachineId || ""), destinationMachineId: String(command2.payload.destinationMachineId || "") };
}
async function control(command2) {
  try {
    if (command2.kind === "agent-context") {
      await finish(command2, agentContext(stateRoot, command2.agentId, command2.payload));
      return;
    }
    if (command2.kind === "store-secret") {
      const name = String(command2.payload.name || ""), value = await decryptRunnerSecret(credentials.encryptionPrivateKey, command2.payload.encrypted);
      runnerSecrets.set(name, value);
      await finish(command2, { stored: true, name, backend: runnerSecrets.backend });
      return;
    }
    if (command2.kind === "export-agent") {
      const profile = command2.payload.profile, binding = transferBinding(command2);
      if (!profile || profile.id !== command2.agentId || profile.computer.machineId !== credentials.machineId || binding.sourceMachineId !== credentials.machineId || typeof command2.payload.transferPublicKey !== "string") throw new Error("An exact source computer profile and encrypted destination are required for transfer.");
      const bundle = await exportAgentTransfer(stateRoot, command2.agentId, profile.computer);
      await finish(command2, await sealAgentTransfer(bundle, binding, command2.payload.transferPublicKey));
      return;
    }
    if (command2.kind === "import-agent") {
      const profile = command2.payload.profile;
      if (profile) assertSandboxedComputer(profile.computer);
      const binding = transferBinding(command2);
      if (!profile || profile.id !== command2.agentId || profile.computer.machineId !== credentials.machineId || binding.destinationMachineId !== credentials.machineId) throw new Error("The destination computer profile does not match this runner.");
      if (profile) validateComputerTarget(profile, await capabilities(), Array.isArray(command2.payload.requiredSecrets) ? command2.payload.requiredSecrets.map(String) : [], (name) => runnerSecrets.has(name) || Boolean(process.env[name]));
      const bundle = await openAgentTransfer(command2.payload.sealedTransfer, binding, credentials.encryptionPrivateKey);
      const imported = await importAgentTransfer(stateRoot, command2.agentId, bundle, profile.computer);
      if (profile?.computer.desktop !== "none" && profile) {
        const check = { action: "computer", desktop: profile.computer.desktop };
        const result = await runtimeProbe(await ensureDesktopContainerAsync(profile.id, stateRoot, profile.computer), check);
        if (!result.ok) throw new Error(String(result.message || "Desktop control is not ready on the destination computer."));
      }
      await finish(command2, { ...imported, validated: true });
      return;
    }
    if (command2.kind.startsWith("probe-")) {
      const profile = command2.payload.profile, shared = join11(stateRoot, "shared");
      assertSandboxedComputer(profile.computer);
      mkdirSync10(shared, { recursive: true });
      const availableSecrets = { ...runnerSecrets.environment(), ...process.env }, needed = [profile.effectiveModel.credentialRef, ...profile.connectors.filter((item) => item.enabled).map((item) => item.secretRef)].filter(Boolean), localSecrets = Object.fromEntries(needed.filter((name) => availableSecrets[name]).map((name) => [name, availableSecrets[name]])), dispatched = await openDispatchedSecrets(command2.payload.encryptedSecrets), secretSource = { environment: () => ({ ...localSecrets, ...dispatched }) };
      if (command2.kind === "probe-runtime" && command2.payload.input?.action === "model-test") {
        const model = command2.payload.input.model;
        const apiKey = command2.payload.encryptedApiKey ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command2.payload.encryptedApiKey) : availableSecrets[model.credentialRef] || "";
        await finish(command2, await testModelConnection(model, apiKey));
        return;
      }
      prepareProfile(stateRoot, profile, profile.effectiveModel, secretSource, command2.payload.coordinationToken || "", `probe-${command2.id}`, {});
      if (command2.kind === "probe-sandbox") {
        const container2 = await ensureContainerAsync(profile.id, stateRoot, profile.computer, false, command2.payload.teamIds || [], () => [...active.values()].some((live2) => live2.agentId === profile.id));
        await finish(command2, await sandboxSelftest(container2, { computer: profile.computer, teamIds: command2.payload.teamIds || [], stateRoot, agentId: profile.id }, "runner-attested"));
        return;
      }
      if (command2.kind === "probe-runtime") {
        const probeInput = { ...command2.payload.input || {} };
        if (probeInput.action === "computer") probeInput.desktop = profile.computer.desktop;
        if (probeInput.action === "connection" && !probeInput.apiKey) probeInput.apiKey = command2.payload.encryptedApiKey ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command2.payload.encryptedApiKey) : secretSource.environment()[profile.effectiveModel.credentialRef] || "";
        if (probeInput.action === "mcp" && probeInput.env) {
          for (const name of Object.keys(probeInput.env)) if (!probeInput.env[name] && secretSource.environment()[name]) probeInput.env[name] = secretSource.environment()[name];
        }
        const container2 = probeInput.action === "computer" && profile.computer.desktop === "virtual" ? await ensureDesktopContainerAsync(profile.id, stateRoot, profile.computer) : await ensureContainerAsync(profile.id, stateRoot, profile.computer, false, command2.payload.teamIds || [], () => [...active.values()].some((live2) => live2.agentId === profile.id));
        await finish(command2, await runtimeProbe(container2, probeInput));
        return;
      }
      const container = await ensureContainerAsync(profile.id, stateRoot, profile.computer, false, command2.payload.teamIds || [], () => [...active.values()].some((live2) => live2.agentId === profile.id));
      if (command2.kind === "probe-tools") {
        const input = await runtimeProbe(container, { action: "catalog" });
        await finish(command2, { source: "runtime", tools: runtimeToolCatalog(Array.isArray(input.tools) ? input.tools : [], profile) });
        return;
      }
      const gateway = new HermesGateway(container, []);
      let result;
      try {
        await gateway.start();
        result = await discoverModels(gateway);
      } finally {
        await gateway.stop();
      }
      await finish(command2, result);
      return;
    }
    const live = active.get(String(command2.payload.runId));
    if (!live && command2.kind === "stop") {
      const waiting = admittedRuns.get(String(command2.payload.runId));
      if (waiting) {
        waiting.cancelled = true;
        await finish(command2, { ok: true });
        return;
      }
    }
    if (!live) throw new Error("The requested run is no longer active on this runner.");
    if (command2.kind === "stop") {
      live.stopping = true;
      if (live.sessionId) await live.gateway.request("session.interrupt", { session_id: live.sessionId }, 5e3).catch(() => {
      });
      await live.gateway.stop();
      blockedAgents.delete(live.agentId);
    }
    if (command2.kind === "steer") {
      if (!live.sessionId) throw new Error("The agent is still starting. Try again when its session is ready.");
      await live.gateway.request("session.steer", { session_id: live.sessionId, text: String(command2.payload.text || "") });
    }
    if (command2.kind === "approval") await live.gateway.request("approval.respond", { session_id: live.sessionId, request_id: command2.payload.requestId, choice: hermesApprovalDecision(command2.payload.choice || command2.payload.decision), all: false });
    if (command2.kind === "input") {
      const type = command2.payload.type;
      if (!["clarify", "secret", "sudo"].includes(type)) throw new Error("Unsupported input request type.");
      if (type !== "clarify" && !command2.payload.encrypted) throw new Error("Sensitive input must be encrypted for this runner.");
      const value = command2.payload.encrypted ? await decryptRunnerSecret(credentials.encryptionPrivateKey, command2.payload.encrypted) : command2.payload.value;
      const key = type === "clarify" ? "answer" : type === "secret" ? "value" : "password";
      try {
        await live.gateway.request(`${type}.respond`, { request_id: command2.payload.requestId, [key]: value });
      } catch {
        throw new Error("The agent could not accept this input. Check whether its request is still pending.");
      }
    }
    await finish(command2, { ok: true });
  } catch (error) {
    await finish(command2, void 0, error);
  }
}
function browserGroup(profile) {
  return profile?.computer.browserSessionTeamId || "";
}
function browserBlocked(group) {
  const agent = blockedBrowserGroups.get(group);
  if (agent && !blockedAgents.has(agent)) blockedBrowserGroups.delete(group);
  return Boolean(agent && blockedAgents.has(agent));
}
async function desktopCommand(command2) {
  const profile = command2.payload.profile, agentId = String(profile?.id || ""), group = browserGroup(profile), action = command2.payload.action;
  const owner = command2.payload.ownership, liveOwner = owner?.owner === "agent" ? active.get(owner.identity) : void 0;
  const agentAction = Boolean(["input", "navigate", "frame", "stage-upload"].includes(action) && liveOwner?.agentId === agentId && !liveOwner.stopping);
  const complete = (value) => request(`/v1/runner/desktop/${encodeURIComponent(command2.id)}/complete`, { method: "POST", body: JSON.stringify(value) }).then(() => {
  });
  if (!agentId || agentId !== command2.agentId || action !== "claim" && (blockedAgents.has(agentId) || browserBlocked(group) || action !== "frame" && !agentAction && (agentOperations.has(agentId) || group && browserOperations.has(group)))) {
    return complete({ error: "This computer is busy. Wait for its current task to finish before taking control." });
  }
  const operation = Promise.resolve().then(async () => {
    try {
      if (typeof command2.payload.expiresAt !== "number" || !Number.isFinite(command2.payload.expiresAt) || command2.payload.expiresAt <= Date.now()) throw new Error("Desktop command expired.");
      if (owner?.owner === "agent" && ["input", "navigate", "stage-upload"].includes(action) && !agentAction) throw new Error("The task no longer controls this computer.");
      if (agentAction) assertComputerOwnership(stateRoot, profile, owner);
      if (action === "input" && !command2.payload.encrypted) throw new Error("Encrypted desktop input is required.");
      const input = action === "input" ? JSON.parse(await decryptRunnerSecret(credentials.encryptionPrivateKey, command2.payload.encrypted)) : void 0;
      if (command2.payload.expiresAt <= Date.now()) throw new Error("Desktop command expired.");
      const result = await executeDesktopCommand(stateRoot, profile, { ...command2.payload, action, input, expiresAt: command2.payload.expiresAt });
      await complete({ result });
    } catch {
      await complete({ error: "The private desktop could not complete that action. Check that the computer is online and try again." });
    }
  });
  if (action !== "frame" && action !== "claim" && !agentAction) {
    agentOperations.set(agentId, operation);
    if (group) browserOperations.set(group, operation);
  }
  try {
    await operation;
  } finally {
    if (agentOperations.get(agentId) === operation) agentOperations.delete(agentId);
    if (group && browserOperations.get(group) === operation) browserOperations.delete(group);
  }
}
async function executeCommand(command2) {
  if (shuttingDown) return;
  if (command2.kind === "desktop") return desktopCommand(command2);
  if (command2.kind === "duplex") {
    if (command2.payload.kind !== "terminal") return executeRunnerDuplex(stateRoot, credentials, command2);
    const epoch = terminalAdmissionEpochs.get(command2.agentId) || 0;
    const validate2 = () => {
      if (shuttingDown || blockedAgents.has(command2.agentId) || (terminalAdmissionEpochs.get(command2.agentId) || 0) !== epoch) throw new Error("Terminal startup was cancelled because computer control changed.");
      assertComputerOwnership(stateRoot, command2.payload.profile, command2.payload.ownership);
    };
    return admitRunnerTerminal(command2.agentId, command2.payload.expiresAt, agentOperations, validate2, (ready) => executeRunnerDuplex(stateRoot, credentials, command2, { validate: validate2, ready }));
  }
  if (command2.kind === "stop" && command2.payload.quiesce === true) {
    const profile = command2.payload.profile;
    if (!profile || profile.id !== command2.agentId || profile.computer.machineId !== credentials.machineId) return finish(command2, void 0, new Error("Invalid computer stop request."));
    terminalAdmissionEpochs.set(profile.id, (terminalAdmissionEpochs.get(profile.id) || 0) + 1);
    blockedAgents.add(profile.id);
    try {
      for (const admission2 of admittedRuns.values()) if (admission2.agentId === profile.id) admission2.cancelled = true;
      writeRunLease(stateRoot, profile.id, null);
      for (const live of active.values()) if (live.agentId === profile.id) {
        live.stopping = true;
        if (live.sessionId) await live.gateway.request("session.interrupt", { session_id: live.sessionId }, 5e3).catch(() => {
        });
        await live.gateway.stop();
      }
      await stopAgentContainers(profile.id, stateRoot);
      const pending2 = agentOperations.get(profile.id);
      if (pending2) {
        let timer;
        try {
          await Promise.race([pending2, new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Computer cleanup is still in progress.")), 3e4);
          })]);
        } finally {
          clearTimeout(timer);
        }
      }
      writeRunLease(stateRoot, profile.id, null);
      await stopAgentContainers(profile.id, stateRoot);
      blockedAgents.delete(profile.id);
      await finish(command2, { ok: true });
    } catch (error) {
      await finish(command2, void 0, error);
    }
    return;
  }
  const usesProfile = command2.kind === "run" || command2.kind.startsWith("probe-") || command2.kind === "import-agent" || command2.kind === "export-agent" || command2.kind === "agent-context";
  if (!usesProfile) return control(command2);
  const agentId = String(command2.kind === "run" ? command2.payload.snapshot?.id : command2.payload.profile?.id || command2.agentId);
  const group = browserGroup(command2.kind === "run" ? command2.payload.snapshot : command2.payload.profile);
  const previous = agentOperations.get(agentId), sharedPrevious = group ? browserOperations.get(group) : void 0;
  if (blockedAgents.has(agentId) || browserBlocked(group) || (previous || sharedPrevious) && command2.kind !== "run") {
    return finish(command2, void 0, new Error(blockedAgents.has(agentId) ? "The previous agent runtime could not be stopped. Stop it before checking settings or starting more work." : "This agent is busy. Wait for its current task or settings check to finish before checking or moving its profile."));
  }
  const admission = { cancelled: false, agentId };
  if (command2.kind === "run") admittedRuns.set(String(command2.payload.runId), admission);
  const operation = (async () => {
    await Promise.all([previous, sharedPrevious].filter(Boolean).map((item) => item.catch(() => {
    })));
    if (admission.cancelled) return finish(command2, void 0, new Error("Run stopped before its runtime started."));
    if (blockedAgents.has(agentId) || browserBlocked(group)) return finish(command2, void 0, new Error("The previous agent runtime could not be stopped."));
    return command2.kind === "run" ? run(command2) : control(command2);
  })();
  agentOperations.set(agentId, operation);
  if (group) browserOperations.set(group, operation);
  try {
    await operation;
  } finally {
    if (agentOperations.get(agentId) === operation) agentOperations.delete(agentId);
    if (group && browserOperations.get(group) === operation) browserOperations.delete(group);
    if (group && blockedAgents.has(agentId)) blockedBrowserGroups.set(group, agentId);
    if (command2.kind === "run") admittedRuns.delete(String(command2.payload.runId));
  }
}
console.log(`Open Harness runner ${credentials.machineId} connected to ${credentials.coordinator}`);
await flushSpool();
if (!known) void capabilities().catch(() => {
});
var lastHeartbeat = 0;
for (; !shuttingDown; ) {
  try {
    if (Date.now() - lastHeartbeat > 15e3) {
      void capabilities().catch(() => {
      });
      await request("/v1/runner/heartbeat", { method: "POST", body: JSON.stringify({ ...known ? { capabilities: known } : {}, encryptionPublicKey: credentials.encryptionPublicKey, activeCommandIds: [.../* @__PURE__ */ new Set([...admittedCommands, ...[...active.values()].map((item) => item.commandId)])] }) });
      lastHeartbeat = Date.now();
    }
    const started = Date.now(), result = await request("/v1/runner/commands?wait=10000");
    if (shuttingDown) break;
    for (const command2 of result.commands) {
      if (admittedCommands.has(command2.id)) continue;
      admittedCommands.add(command2.id);
      void executeCommand(command2).catch((error) => console.error(error instanceof Error ? error.message : error)).finally(() => admittedCommands.delete(command2.id));
    }
    if (!result.commands.length && Date.now() - started < 500) await new Promise((resolve8) => setTimeout(resolve8, 1e3));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await new Promise((resolve8) => setTimeout(resolve8, 1e3));
  }
}
