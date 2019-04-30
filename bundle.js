(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
const OBSERVATION_OPTIONS = {
  attributes: true,
  childList: true,
  subtree: true,
  attributeFilter: ['src', 'href']
}

module.exports = class SourceRewriter {
  constructor ({ loadDatURL, makeLink, delay }) {
    this.delay = delay
    this.loadDatURL = loadDatURL
    this.makeLink = makeLink
    this.lastRewrote = 0
    this.observer = new window.MutationObserver(() => this.rewrite())
  }

  start () {
    this.observer.observe(document.body, OBSERVATION_OPTIONS)
  }

  stop () {
    this.observer.disconnect()
  }

  tryRewrite () {
    const time = Date.now()
    if ((time - this.lastRewrote) > this.delay) {
      this.lastRewrote = time
      this.rewrite()
    }
  }

  // Rewrite any links, stylesheets, and external resources for dat
  async rewrite () {
    const anchorItems = document.querySelectorAll('a')

    for (let item of anchorItems) {
      const url = item.getAttribute('href')
      if (shouldFilter(url)) continue

      item.href = this.makeLink(item.href)
    }

    const linkItems = document.querySelectorAll('link')

    for (let item of linkItems) {
      const url = item.getAttribute('href')

      if (shouldFilter(url)) continue

      // The URL must either be a dat url or relative to the current path
      // Clear the current URL while the content loads
      item.href = ''

      const blobURL = await this.loadDatURL(url)

      // Set the src to a blob URL of the content
      item.href = blobURL
    }

    // Find all HTML elements that might be loading some content
    const srcItems = document.querySelectorAll('[src]')

    for (let item of srcItems) {
      const url = item.getAttribute('src')

      if (shouldFilter(url)) continue

      // The URL must either be a dat url or relative to the current path
      // Clear the current URL while the content loads
      item.src = ''

      // Load the content asynchronously so that everything can be loaded in paralell
      const blobURL = await this.loadDatURL(url)

      // Set the src to a blob URL of the content
      item.src = blobURL
    }

    // console.log({ srcItems, anchorItems, linkItems })
  }
}

function shouldFilter (url) {
  // If there's no src, skip it
  if (!url) return true

  // This was probably already filtered
  if (url.startsWith('blob:')) return true

  // If it's loading from the legacy web, skip it
  if (url.startsWith('http:') || url.startsWith('https:')) return true

  return false
}

},{}],2:[function(require,module,exports){
/* global XMLHttpRequest, CustomEvent */
const IS_RELATIVE = /^\.\/|^\.\.\/|^\//

module.exports = class XMLPatcher {
  constructor (loadBuffer) {
    this._loadBuffer = loadBuffer
  }

  patch () {
    this._open = XMLHttpRequest.prototype.open
    this._send = XMLHttpRequest.prototype.send
    this._addEventListener = XMLHttpRequest.prototype.addEventListener
    this._fetch = window.fetch

    const loadBuffer = this._loadBuffer
    const _open = this._open
    const _send = this._send
    const _addEventListener = this._addEventListener
    const _fetch = this._fetch

    XMLHttpRequest.prototype.open = function (method, url) {
      this.__isDat = shouldInterceptURL(url)
      if (!this.__isDat) {
        return _open.apply(this, arguments)
      }
    }

    XMLHttpRequest.prototype.send = function () {
      if (!this.__isDat) return _send.apply(this, arguments)
      loadBuffer(this.__isDat).then((buffer) => {
        let response = null
        const { responseType } = this
        if (responseType === 'arraybuffer') {
          response = buffer.buffer
        } else if (responseType === 'blob') {

        } else if (responseType === 'json') {
          const text = buffer.toString()
          try {
            response = JSON.parse(text)
          } catch (e) {
            response = {}
          }
        } else {
          response = buffer.toString()
        }

        const finalResponse = Object.create(this, {
          status: {
            value: 200
          },
          response: {
            value: response
          }
        })

        this.__loadHandler.call(finalResponse, new CustomEvent('load', {}))
      }).catch((e) => {
        console.log('Error intercepting XHR', e)
        this.dispatchEvent(new CustomEvent('error', {}))
      })
    }

    XMLHttpRequest.prototype.addEventListener = function (name, listener) {
      if (name === 'load') this.__loadHandler = listener
      return _addEventListener.apply(this, arguments)
    }

    window.fetch = function (url) {
      const isDat = shouldInterceptURL(url)

      if (!isDat) return _fetch.apply(this, arguments)
      console.log('intercepting fetch', url)

      return loadBuffer(isDat).then((buffer) => {
        return new FakeResponse(buffer, url)
      })
    }
  }

  unpatch () {
    XMLHttpRequest.prototype.open = this._open
    XMLHttpRequest.prototype.send = this._send
    XMLHttpRequest.prototype.addEventListener = this._addEventListener
    window.fetch = this._fetch
  }
}

class FakeResponse {
  constructor (buffer, url) {
    this.body = new FakeBody(buffer)
    this.url = url
  }
  get headers () {
    return {}
  }
  get ok () {
    return true
  }
  get status () {
    return 200
  }
  get statusText () {
    return 'OK'
  }
  get useFinalURL () {
    return true
  }
}

class FakeBody {
  constructor (buffer) {
    this._buffer = buffer
  }
  async arrayBuffer () {
    return this._buffer.buffer
  }
  async text () {
    return this.buffer.toString('utf-8')
  }
  async json () {
    return JSON.parse(await this.text())
  }
}

function shouldInterceptURL (url) {
  if (!(url.startsWith('http:') || url.startsWith('https:'))) {
    if (!url.match(IS_RELATIVE) && !url.startsWith('dat://')) {
      url = './' + url
    }
    return url
  } else return ''
}

},{}],3:[function(require,module,exports){
const DatJs = require('dat-js')
const mimelite = require('mime/lite')
const toBlobURL = require('stream-to-blob-url')
const resolveDatPathRaw = require('resolve-dat-path')

const SourceRewriter = require('./SourceRewriter')
const XHRPatcher = require('./XHRPatcher')

const DAT_REGEX = /dat:\/\/([^/]+)\/?([^#?]*)?/i
const REWRITE_DELAY = 1000

const injectStyle = `
<style>
${document.getElementById('transferrable-styles').innerHTML}
</style>
`

const injectMobileMeta = `
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0">
`

module.exports = {
  loadContentToPage
}

const dat = new DatJs({
  persist: true
})

async function loadContentToPage (url) {
  const { path } = parseDatURL(url)

  const archive = await getArchive(url)
  startPatching(url)
  await renderContent(archive, path || '')
  setTimeout(() => {
    startRewriting(url)
  }, 100)
}

function startRewriting (url) {
  const rewriter = new SourceRewriter({
    delay: REWRITE_DELAY,
    loadDatURL: (toLoadURL) => {
      if (!toLoadURL.startsWith('dat://')) toLoadURL = resolveRelative(url, toLoadURL)
      console.log('Loading content', toLoadURL)
      return loadDatURL(toLoadURL)
    },
    makeLink: (toLinkURL) => {
      if (!toLinkURL.startsWith('dat://')) toLinkURL = resolveRelative(url, toLinkURL)

      const finalURL = new URL(window.location)
      finalURL.searchParams.set('url', toLinkURL)

      return finalURL.href
    }
  })

  rewriter.rewrite()
  rewriter.start()
}

function startPatching (url) {
  const patcher = new XHRPatcher((toLoadURL) => {
    if (!toLoadURL.startsWith('dat://')) toLoadURL = resolveRelative(url, toLoadURL)

    return loadDatBuffer(toLoadURL)
  })

  patcher.patch()
}

async function loadDatBuffer (url) {
  const archive = await getArchive(url)
  const { path } = parseDatURL(url)

  const found = await resolveDatPath(archive, path)

  return getFileBuffer(archive, found.path)
}

async function loadDatURL (url) {
  const archive = await getArchive(url)

  const { path } = parseDatURL(url)

  const found = await resolveDatPath(archive, path)

  var mimeType = mimelite.getType(path)

  return getBlobURL(archive, found.path, mimeType)
}

async function renderContent (archive, path) {
  const found = await resolveDatPath(archive, path || '/')

  if (found.type === 'file') {
    await renderFile(archive, found.path)
  } else if (found.type === 'directory') {
    await renderFolder(archive, found.path)
  }
}

async function renderFolder (archive, path) {
  const files = await getDirFiles(archive, path)

  const url = `dat://${archive.key.toString('hex')}`
  const parent = getParentDir(path)
  if (!path.endsWith('/')) path += '/'
  if (!path.startsWith('/')) path = '/' + path

  setContent(`
    <title>${path.split('/').pop()}</title>
    ${injectMobileMeta}
    ${injectStyle}
    <ul>
      <li>
        <a href="${url}/">/</a>
      </li>
      <li >
        <a href="${url}/${parent}">../</a>
      </li>
    ${files.map((file) => `
      <li>
        <a href="${url}${path}${file}">./${file}</a>
      </li>
    `).join('\n')}
    </ul>
  `)
}

async function renderFile (archive, path) {
  var mimeType = mimelite.getType(path)

  if (mimeType.match('image')) {
    const blobURL = await getBlobURL(archive, path, mimeType)
    setContent(`
      <title>${path.split('/').pop()}</title>
      ${injectMobileMeta}
      ${injectStyle}
      <img src="${blobURL}" />
    `)
  } else if (mimeType.match('video')) {
    const blobURL = await getBlobURL(archive, path, mimeType)
    setContent(`
      <title>${path.split('/').pop()}</title>
      ${injectMobileMeta}
      ${injectStyle}
      <video controls>
        <source src="${blobURL}" type="${mimeType}">
      </video>
    `)
  } else if (mimeType.match('html')) {
    const text = await getText(archive, path)
    setContent(text)
  } else {
    const text = await getText(archive, path)
    setContent(`
      <title>${path.split('/').pop()}</title>
      ${injectMobileMeta}
      ${injectStyle}
      <main style="white-space: pre-wrap;">${text}</main>
    `)
  }
}

function resolveRelative (origin, relativePath) {
  const { key, version, path } = parseDatURL(origin)

  const resolvedURL = new URL(relativePath, `https://example.com/${path}`)
  const finalPath = resolvedURL.pathname

  const versionString = version ? `+${version}` : ''

  return `dat://${key}${versionString}${finalPath}`
}

function parseDatURL (url) {
  let [, key, path] = url.toString().match(DAT_REGEX)
  let version = null
  if (key.includes('+')) [key, version] = key.split('+')

  return {
    key,
    path,
    version
  }
}

function getParentDir (path) {
  const pathParts = path.split('/')
  pathParts.pop()
  return pathParts.join('/')
}

function setContent (content) {
  console.log('Setting content')
  console.log(content)
  document.open()
  document.write(content)
  document.close()
}

function getDirFiles (archive, path) {
  return new Promise((resolve, reject) => {
    archive.readdir(path, (err, files) => {
      if (err) reject(err)
      else resolve(files)
    })
  })
}

function getText (archive, path) {
  return new Promise((resolve, reject) => {
    archive.readFile(path, 'utf-8', (err, text) => {
      if (err) reject(err)
      else resolve(text)
    })
  })
}

async function getFileBuffer (archive, path) {
  return new Promise((resolve, reject) => {
    archive.readFile(path, (err, data) => {
      if (err) return reject(err)
      else resolve(data)
    })
  })
}

function asyncToBlobURL (stream, mimeType) {
  return new Promise((resolve, reject) => {
    toBlobURL(stream, mimeType, (err, url) => {
      if (err) reject(err)
      else resolve(url)
    })
  })
}

async function getBlobURL (archive, path, mimeType) {
  const stream = archive.createReadStream(path, {
    encoding: 'buffer'
  })
  const url = await asyncToBlobURL(stream, mimeType)
  return url
}

async function getArchive (url) {
  return new Promise((resolve, reject) => {
    const archive = dat.get(url)

    archive.ready(() => {
      resolve(archive)
    })
  })
}

function resolveDatPath (archive, path) {
  return new Promise((resolve, reject) => {
    resolveDatPathRaw(archive, path, (err, resolved) => {
      if (err) reject(err)
      else resolve(resolved)
    })
  })
}

},{"./SourceRewriter":1,"./XHRPatcher":2,"dat-js":39,"mime/lite":83,"resolve-dat-path":118,"stream-to-blob-url":140}],4:[function(require,module,exports){
const { loadContentToPage } = require('./contentLoader')

const url = new URL(window.location).searchParams.get('url')

console.log('Loading up', url)

if (!url) showInfo()
else loadContentToPage(url)

function showInfo () {
  document.getElementById('loader').classList.add('hidden')
  document.getElementById('info').classList.remove('hidden')
}

},{"./contentLoader":3}],5:[function(require,module,exports){
(function (process){
const assert = require('assert')
const EventEmitter = require('events')
const createSwarm = require('webrtc-swarm')
const pump = require('pump')
const subSignalhub = require('sub-signalhub')
const noop = () => void 0

class DiscoverySwarmWebrtc extends EventEmitter {
  constructor (opts = {}) {
    super()

    assert(typeof opts.stream === 'function', 'A `stream` function prop is required.')
    assert(opts.hub, 'A signalhub `hub` instance is required')

    this.id = opts.id
    this.stream = opts.stream
    this.hub = opts.hub
    this.channels = new Map()
    this.destroyed = false
  }

  join (channelName, opts = {}) {
    assert(channelName, 'A channel name is required.')

    if (this.channels.has(channelName)) {
      // discovery-channel returns if you're already joined, we should to
      return
    }

    // Account for when the channel is a Buffer instance (hyperdrive.discoveryKey)
    if(typeof channelName === 'object') {
      channelName = channelName.toString('hex')
    }

    const hub = subSignalhub(this.hub, channelName)

    const channel = {
      peers: new Map(),
      swarm: createSwarm(hub, Object.assign({}, {
        uuid: this.id.toString('hex')
      }, opts))
    }

    channel.swarm.on('peer', (peer, id) => {
      const info = { id, channel: channelName }
      const conn = this.stream(info)
      this.emit('handshaking', conn, info)
      conn.on('handshake', this._handshake.bind(this, channel, conn, info))
      pump(peer, conn, peer)
    })

    channel.swarm.on('disconnect', (peer, id) => {
      const info = { id, channel: channelName }
      channel.peers.delete(id)
      this.emit('connection-closed', peer, info)
    })

    this.channels.set(channelName, channel)
  }

  leave (channelName) {
    const channel = this.channels.get(channelName)

    if(!channel) return

    channel.close()

    this.channels.delete(channelName)
  }

  close (cb) {
    if (this.destroyed) return process.nextTick(cb || noop)

    this.destroyed = true

    if(cb) this.once('close', cb)

    if (!this.channels.size) return process.nextTick(() => {
      this.emit('close')
    })

    this.channels.forEach((channel, channelName) => {
      channel.swarm.close(() => {
        this.channels.delete(channelName)
        if(!this.channels.size) this.emit('close')
      })
    })
  }

  destroy (cb) {
    this.close(cb)
  }

  _handshake (channel, conn, info) {
    const { id } = info

    if (channel.peers.has(id)) {
      const oldPeer = channel.peers.get(id)
      this.emit('redundant-connection', oldPeer, info)
      channel.peers.delete(id)
      oldPeer.destroy()
    }

    channel.peers.set(id, conn)
    this.emit('connection', conn, info)
  }
}

module.exports = (...args) => new DiscoverySwarmWebrtc(...args)

}).call(this,require('_process'))
},{"_process":94,"assert":12,"events":27,"pump":96,"sub-signalhub":143,"webrtc-swarm":156}],6:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
const indexedDB = exports.indexedDB = window.indexedDB;

},{}],7:[function(require,module,exports){
"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _randomAccessStorage = require("random-access-storage");

var _randomAccessStorage2 = _interopRequireDefault(_randomAccessStorage);

var _IndexedDB = require("./IndexedDB");

var _buffer = require("buffer");

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const promise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

class RandomAccessIDBFileVolume {
  constructor(db, name, version, storeName, options) {
    this.db = db;
    this.name = name;
    this.version = version;
    this.storeName = storeName;
    this.options = options;
  }
  store() {
    const { db, storeName } = this;
    const transaction = db.transaction([storeName], "readwrite");
    return transaction.objectStore(storeName);
  }
  async delete(url) {
    return await promise(this.store().delete(url));
  }
  async save(url, file) {
    return await promise(this.store().put(file, url));
  }
  async open(url, mode) {
    const file = await promise(this.store().get(url));
    if (file) {
      return file;
    } else if (mode === "readwrite") {
      const file = await promise(this.db.createMutableFile(url, "binary/random"));
      await this.save(url, file);
      return file;
    } else {
      throw new RangeError(`File ${url} does not exist`);
    }
  }

  mount(file, options) {
    return new RandomAccessProvider(this, `/${file}`, options);
  }
}

class RandomAccessProvider extends _randomAccessStorage2.default {

  static async mount(options = {}) {
    if (!self.IDBMutableFile) {
      throw Error(`Runtime does not supports IDBMutableFile https://developer.mozilla.org/en-US/docs/Web/API/IDBMutableFile`);
    } else {
      const name = options.name || `RandomAccess`;
      const version = options.version || 1.0;
      const storeName = options.storeName || `IDBMutableFile`;

      const request = _IndexedDB.indexedDB.open(name, version);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      const db = await promise(request);
      const volume = new RandomAccessIDBFileVolume(db, name, version, storeName, options);
      return (path, options) => volume.mount(path, options);
    }
  }
  static async open(self, request) {
    const { options } = self;
    const mode = request.preferReadonly ? "readonly" : "readwrite";
    self.debug && console.log(`>> open ${self.url} ${mode}`);

    if (!self.file || self.mode !== mode && mode === "readwrite") {
      self.mode = mode;
      self.file = await self.volume.open(self.url, mode);
    }

    if (!(mode === "readonly" || !options.truncate)) {
      const file = self.activate();
      await promise(file.truncate(options.size || 0));
    }

    self.debug && console.log(`<< open ${self.url} ${mode}`);
  }
  static async read(self, { data, offset, size }) {
    self.debug && console.log(`>> read ${self.url} <${offset}, ${size}>`);
    const buffer = data || _buffer.Buffer.allocUnsafe(size);
    if (size === 0) {
      return buffer;
    }

    const file = self.activate();
    file.location = offset;
    const chunk = await promise(file.readAsArrayBuffer(size));
    if (chunk.byteLength !== size) {
      throw new Error("Could not satisfy length");
    }

    _buffer.Buffer.from(chunk).copy(buffer);
    self.debug && console.log(`<< read ${self.url} <${offset}, ${size}>`, buffer);
    return buffer;
  }
  static async write(self, { data, offset, size }) {
    self.debug && console.log(`>> write ${self.url} <${offset}, ${size}>`, data);
    const { byteLength, byteOffset } = data;
    const chunk = byteLength === size ? data : data.slice(0, size);

    const file = self.activate();
    file.location = offset;
    const wrote = await promise(file.write(chunk));

    self.debug && console.log(`<< write ${self.url} <${offset}, ${size}>`);

    return wrote;
  }
  static async delete(self, { offset, size }) {
    self.debug && console.log(`>> delete ${self.url} <${offset}, ${size}>`);
    const stat = await this.stat(self);
    if (offset + size >= stat.size) {
      const file = self.activate();
      await promise(file.truncate(offset));
    }

    self.debug && console.log(`<< delete ${self.url} <${offset}, ${size}>`);
  }
  static async stat(self) {
    self.debug && console.log(`>> stat ${self.url}`);
    const file = self.activate();
    const stat = await promise(file.getMetadata());
    self.debug && console.log(`<< stat {size:${stat.size}} ${self.url} `);

    return stat;
  }
  static async close(self) {
    self.debug && console.log(`>> close ${self.url}`);
    const { lockedFile } = self;
    if (lockedFile && lockedFile.active) {
      await promise(lockedFile.flush());
    }
    self.lockedFile = null;
    self.file = null;
    self.debug && console.log(`<< close ${self.url}`);
  }
  static async destroy(self) {
    self.debug && console.log(`>> destroy ${self.url}`);
    await self.volume.delete(self.url);
    self.debug && console.log(`<< destroy ${self.url}`);
  }

  static async awake(self) {
    const { workQueue } = self;
    self.isIdle = false;
    let index = 0;
    while (index < workQueue.length) {
      const request = workQueue[index++];
      await this.perform(self, request);
    }
    workQueue.length = 0;
    self.isIdle = true;
  }
  static schedule(self, request) {
    self.workQueue.push(request);
    if (self.isIdle) {
      this.awake(self);
    }
  }
  static async perform(self, request) {
    try {
      switch (request.type) {
        case RequestType.open:
          {
            return request.callback(null, (await this.open(self, request)));
          }
        case RequestType.read:
          {
            return request.callback(null, (await this.read(self, request)));
          }
        case RequestType.write:
          {
            return request.callback(null, (await this.write(self, request)));
          }
        case RequestType.delete:
          {
            return request.callback(null, (await this.delete(self, request)));
          }
        case RequestType.stat:
          {
            return request.callback(null, (await this.stat(self)));
          }
        case RequestType.close:
          {
            return request.callback(null, (await this.close(self)));
          }
        case RequestType.destroy:
          {
            return request.callback(null, (await this.destroy(self)));
          }
      }
    } catch (error) {
      request.callback(error);
    }
  }
  _open(request) {
    RandomAccessProvider.schedule(this, request);
  }
  _openReadonly(request) {
    RandomAccessProvider.schedule(this, request);
  }
  _write(request) {
    RandomAccessProvider.schedule(this, request);
  }
  _read(request) {
    RandomAccessProvider.schedule(this, request);
  }
  _del(request) {
    RandomAccessProvider.schedule(this, request);
  }
  _stat(request) {
    RandomAccessProvider.perform(this, request);
  }
  _close(request) {
    RandomAccessProvider.schedule(this, request);
  }
  _destroy(request) {
    RandomAccessProvider.schedule(this, request);
  }
  constructor(volume, url, options = {}) {
    super();
    this.volume = volume;
    this.url = url;
    this.options = options;
    this.mode = "readonly";
    this.file = null;
    this.lockedFile = null;

    this.workQueue = [];
    this.isIdle = true;
    this.debug = !!volume.options.debug;
  }
  activate() {
    const { lockedFile, file, mode } = this;
    if (lockedFile && lockedFile.active) {
      return lockedFile;
    } else if (file) {
      const lockedFile = file.open(mode);
      this.lockedFile = lockedFile;
      return lockedFile;
    } else {
      throw new RangeError(`Unable to activate file, likely provider was destroyed`);
    }
  }
}

const RequestType = {
  open: 0,
  read: 1,
  write: 2,
  delete: 3,
  stat: 4,
  close: 5,
  destroy: 6
};

exports.default = RandomAccessProvider;
module.exports = exports["default"];

},{"./IndexedDB":6,"buffer":32,"random-access-storage":103}],8:[function(require,module,exports){
(function (Buffer){
var from = require('from2')
var mutexify = require('mutexify')
var varint = require('varint')
var messages = require('./messages')
var codecs = require('codecs')
var inherits = require('inherits')
var events = require('events')
var cache = require('array-lru')
var nextTick = require('process-nextick-args')

module.exports = Tree

function Tree (feed, opts) {
  if (!(this instanceof Tree)) return new Tree(feed, opts)
  if (!opts) opts = {}

  events.EventEmitter.call(this)

  this._offset = opts.offset || 0
  this._codec = opts.codec || codecs(opts.valueEncoding)
  this._head = typeof opts.checkout === 'number' ? opts.checkout : -1
  this._lock = mutexify()
  this._cache = getCache(opts)
  this._wait = opts.wait !== false
  this._cached = !!opts.cached
  this._asNode = !!opts.node
  this._readonly = !!opts.readonly

  this.feed = feed
  this.version = this._head

  var self = this

  this.ready(function (err) {
    if (!err) self.emit('ready')
  })
}

inherits(Tree, events.EventEmitter)

Tree.prototype.put = function (name, value, cb) {
  var self = this
  var names = split(name)

  this._lock(function (release) {
    self.head(function (err, head, seq) {
      if (err) return done(err)
      if (self._readonly) return done(new Error('Cannot delete on a checkout'))
      if (!head) self._init(names, value, done)
      else self._put(head, seq, names, value, done)
    })

    function done (err) {
      release(cb, err)
    }
  })
}

Tree.prototype._put = function (head, seq, names, value, cb) {
  var self = this
  var i = 0
  var end = names.length + 1
  var index = []
  var len = self.feed.length

  loop(null, null, null)

  function loop (err, nodes, seqs) {
    if (err) return cb(err)

    if (nodes) {
      var result = []

      for (var j = 0; j < nodes.length; j++) {
        if (split(nodes[j].name)[i - 1] !== names[i - 1]) {
          result.push(seqs[j])
        }
      }

      result.push(len)
      index.push(result)
    }

    if (i === end) {
      var node = {
        name: join(names),
        value: self._codec.encode(value),
        paths: self._deflate(len, index)
      }

      self.version = self.feed.length
      self.feed.append(messages.Node.encode(node), cb)
      return
    }

    self._list(head, seq, names.slice(0, i++), null, loop)
  }
}

Tree.prototype.list = function (name, opts, cb) {
  if (typeof opts === 'function') return this.list(name, null, opts)
  opts = this._defaultOpts(opts)

  var self = this
  var names = split(name)
  var ns = !!(opts.node || opts.nodes)

  this.head(opts, function (err, head, seq) {
    if (err) return cb(err)
    if (!head) return cb(notFound(names))

    self._list(head, seq, names, opts, onnodes)

    function onnodes (err, nodes, seqs) {
      if (err) return cb(err)
      if (!nodes.length) return cb(notFound(names))

      var list = []
      for (var i = 0; i < nodes.length; i++) {
        var nodeNames = split(nodes[i].name)
        if (nodeNames.length > names.length) {
          list.push(ns ? self._node(nodes[i], seqs[i]) : nodeNames[names.length])
        }
      }

      cb(null, list)
    }
  })
}

Tree.prototype._list = function (head, seq, names, opts, cb) {
  var headIndex
  try {
    headIndex = this._inflate(seq, head.paths)
  } catch (e) {
    return cb(e)
  }
  var cmp = compare(split(head.name), names)

  var index = cmp < headIndex.length && headIndex[cmp]
  var closest = cmp === names.length

  if (!closest) {
    if (!index || !index.length || (index.length === 1 && index[0] === seq)) return cb(null, [], [])
    this._closer(names, cmp, index, opts, cb)
    return
  }

  if (!index || !index.length) return cb(null, [], [])

  this._getAll(index, opts, cb)
}

Tree.prototype.get = function (name, opts, cb) {
  if (typeof opts === 'function') return this.get(name, null, opts)
  opts = this._defaultOpts(opts)

  var names = split(name)
  var self = this

  this.head(opts, function (err, head, seq) {
    if (err) return cb(err)
    if (!head) return cb(notFound(names))
    self._get(head, seq, names, null, opts, cb)
  })
}

Tree.prototype.path = function (name, opts, cb) {
  if (typeof opts === 'function') return this.path(name, null, opts)
  opts = this._defaultOpts(opts)

  var names = split(name)
  var path = []
  var self = this

  this.head(opts, function (err, head, seq) {
    if (err) return cb(err)
    if (!head) return cb(notFound(names))
    self._get(head, seq, names, path, opts, function (err) {
      if (err && !err.notFound) return cb(err)
      cb(null, path)
    })
  })
}

Tree.prototype.checkout = function (seq, opts) {
  opts = this._defaultOpts(opts)

  return new Tree(this.feed, {
    checkout: seq,
    readonly: true,
    offset: this._offset,
    codec: opts.valueEncoding ? codecs(opts.valueEncoding) : this._codec,
    cache: this._cache || opts.cache || false,
    node: opts.node,
    wait: opts.wait,
    cached: opts.cached
  })
}

Tree.prototype._del = function (head, seq, names, cb) {
  var self = this
  var i = 0
  var end = names.length + 1
  var index = []
  var len = self.feed.length
  var ignore = join(names)

  closest(names.length, function (err, c, cseq) {
    if (err) return cb(err)

    var cnames = c ? split(c.name) : []
    var depth = compare(names, cnames) + 1

    loop(null, null, null)

    function loop (err, nodes, seqs) {
      if (err) return cb(err)

      if (nodes && i <= depth) {
        var result = []

        for (var j = 0; j < nodes.length; j++) {
          if (split(nodes[j].name)[i - 1] !== names[i - 1]) {
            if (nodes[j].name !== ignore) {
              result.push(seqs[j])
            }
          }
        }

        if (i < depth) {
          result.push(len)
        }

        index.push(result)
      }

      if (i === end) {
        var node = {
          name: join(names),
          value: null,
          paths: self._deflate(len, index)
        }

        self.version = self.feed.length
        self.feed.append(messages.Node.encode(node), cb)
        return
      }

      self._list(head, seq, names.slice(0, i++), null, loop)
    }
  })

  function closest (j, cb) {
    self._list(head, seq, names.slice(0, j), null, function (err, nodes, seqs) {
      if (err) return cb(err)

      for (var i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].name !== ignore && nodes[i].value) return cb(null, nodes[i], seqs[i])
      }

      if (j <= 0) {
        return cb(null, null, -1)
      }

      closest(j - 1, cb)
    })
  }
}

Tree.prototype.del = function (name, cb) {
  var self = this
  var names = split(name)

  this._lock(function (release) {
    self.head(function (err, head, seq) {
      if (err) return done(err)
      if (self._readonly) return done(new Error('Cannot delete on a checkout'))
      if (!head) return done(null)
      else self._del(head, seq, names, done)
    })

    function done (err) {
      release(cb, err)
    }
  })
}

Tree.prototype._get = function (head, seq, names, record, opts, cb) {
  var self = this
  var headNames = split(head.name)
  var cmp = compare(names, headNames)

  if (record) record.push(seq)

  if (cmp === headNames.length && cmp === names.length) {
    if (opts.node) return cb(null, this._node(head, seq))
    if (!head.value) return cb(notFound(names))
    return cb(null, this._codec.decode(head.value))
  }

  var inflated
  try {
    inflated = this._inflate(seq, head.paths)
  } catch (e) {
    return cb(e)
  }
  if (cmp >= inflated.length) return cb(notFound(names))

  var index = inflated[cmp]
  var len = index.length
  if (index[len - 1] === seq) len--

  if (!len) return cb(notFound(names))

  var target = cmp < names.length ? names[cmp] : null
  var error = null
  var missing = len

  for (var i = 0; i < len; i++) {
    this._getAndDecode(index[i], opts, onget)
  }

  function onget (err, node, seq) {
    if (err) error = err

    if (node) {
      var nodeNames = split(node.name)
      if ((cmp < nodeNames.length ? nodeNames[cmp] : null) === target) {
        return self._get(node, seq, names, record, opts, cb)
      }
    }

    if (!--missing) cb(error || notFound(names))
  }
}

Tree.prototype._closer = function (names, cmp, index, opts, cb) {
  var self = this
  var target = names[cmp]
  var error = null
  var missing = index.length
  var done = false

  for (var i = 0; i < index.length; i++) {
    this._getAndDecode(index[i], opts, onget)
  }

  function onget (err, node, seq) {
    if (done) return
    if (err) error = err

    if (node && split(node.name)[cmp] === target) {
      self._list(node, seq, names, opts, cb)
      return
    }

    if (!--missing) cb(error, [], [])
  }
}

Tree.prototype.head = function (opts, cb) {
  if (typeof opts === 'function') return this.head(null, opts)
  if (this._head >= this._offset) return this._getAndDecode(this._head, opts, cb)
  if (this._readonly) return cb(null, null, -1)

  var self = this

  this.ready(function (err) {
    if (err) return cb(err)
    if (self.feed.length > self._offset) self._getAndDecode(self.feed.length - 1, opts, cb)
    else cb(null, null, -1)
  })
}

Tree.prototype.ready = function (cb) {
  var self = this

  this.feed.ready(function (err) {
    if (err) return cb(err)
    if ((self.version === -1 || self._head === -1) && self.feed.length > self._offset) self.version = self.feed.length - 1
    cb(null)
  })
}

Tree.prototype.history = function (opts) {
  opts = this._defaultOpts(opts)

  if (this._offset) opts.start = Math.max(opts.start || 0, this._offset)
  if (this._head > -1) opts.end = this._head + 1

  var version = opts.start || 0
  var self = this

  opts.valueEncoding = {
    encode: function () {},
    decode: function (buf) {
      return self._node(messages.Node.decode(buf), version++)
    }
  }

  return this.feed.createReadStream(opts)
}

Tree.prototype.diff = function (toTree, opts) {
  if (typeof toTree === 'number') toTree = this.checkout(toTree)
  opts = this._defaultOpts(opts)

  var fromTree = this
  var diffPuts = opts.puts !== false
  var diffDels = opts.dels !== false
  var queue = ['/']
  var first = true
  var forceVisit = {}

  if (opts.reverse) {
    fromTree = toTree
    toTree = this
  }

  var stream = from.obj(read)
  return stream

  function firstRead (size, cb) {
    first = false
    toTree.head(function (err, head) {
      if (err) return cb(err)
      if (!head || head.value) return read(size, cb)

      var parts = head.name.split('/')
      for (var i = 0; i < parts.length; i++) {
        forceVisit[parts.slice(0, i).join('/') || '/'] = true
      }

      read(size, cb)
    })
  }

  function read (size, cb) {
    if (first) return firstRead(size, cb)
    if (!queue.length) return cb(null, null)
    visit(queue.pop(), function (err, result) {
      if (err) return cb(err)
      if (!result.length) return read(size, cb)
      for (var i = 0; i < result.length - 1; i++) {
        stream.push(result[i])
      }
      cb(null, result[result.length - 1])
    })
  }

  function push (dir, isPut, node, visited, result) {
    if (isPut && !diffPuts) return
    if (!isPut && !diffDels) return

    var name = node.name
    var nameDir = parseDir(dir, node.name)

    if (name === nameDir) {
      result.push({
        type: isPut ? 'put' : 'del',
        name: node.name,
        version: node.version,
        value: node.value
      })
    }

    if (!visited.hasOwnProperty(nameDir)) {
      visited[nameDir] = true
      queue.push(nameDir)
    }
  }

  function parseDir (dir, name) {
    return '/' + split(name).slice(0, split(dir).length + 1).join('/')
  }

  function visit (dir, cb) {
    var visited = {}

    toTree.list(dir, {node: true}, function (err, a) {
      if (err && !err.notFound) return cb(err)
      if (!a) a = []

      fromTree.list(dir, {node: true}, function (err, b) {
        if (err && !err.notFound) return cb(err)
        if (!b) b = []

        var result = []
        var i = 0
        var j = 0

        while (i < a.length && j < b.length) {
          if (a[i].version === b[j].version) {
            var nameDir = parseDir(dir, a[i].name)
            if (forceVisit.hasOwnProperty(nameDir) && !visited[nameDir]) {
              visited[nameDir] = true
              queue.push(nameDir)
            }
            i++
            j++
          } else if (a[i].version < b[j].version) {
            push(dir, true, a[i++], visited, result)
          } else {
            push(dir, false, b[j++], visited, result)
          }
        }

        for (; i < a.length; i++) push(dir, true, a[i], visited, result)
        for (; j < b.length; j++) push(dir, false, b[j], visited, result)

        cb(null, result)
      })
    })
  }
}

Tree.prototype._node = function (node, version) {
  return {
    type: node.value ? 'put' : 'del',
    version: version,
    name: node.name,
    value: node.value && this._codec.decode(node.value)
  }
}

Tree.prototype._init = function (names, value, cb) {
  var index = []

  while (names.length >= index.length) {
    index.push([this.feed.length])
  }

  var node = {
    name: join(names),
    value: this._codec.encode(value),
    paths: this._deflate(this.feed.length, index)
  }

  this.version = this.feed.length
  this.feed.append(messages.Node.encode(node), cb)
}

Tree.prototype._getAndDecode = function (seq, opts, cb) {
  if (opts && opts.cached) opts.wait = false

  var self = this
  var cached = this._cache && this._cache.get(seq)
  if (cached) return nextTick(cb, null, cached, seq)

  this.feed.get(seq, opts, function (err, value) {
    if (err) return cb(err)
    try {
      var node = new Node(messages.Node.decode(value), seq)
    } catch (err) {
      return cb(err)
    }
    if (self._cache) self._cache.set(seq, node)
    cb(null, node, seq)
  })
}

Tree.prototype._getAll = function (seqs, opts, cb) {
  if (opts && opts.cached) seqs = this._onlyCached(seqs)

  var nodes = new Array(seqs.length)
  var missing = seqs.length
  var error = null

  if (!missing) return cb(null, nodes, seqs)
  for (var i = 0; i < seqs.length; i++) this._getAndDecode(seqs[i], opts, get)

  function get (err, node, seq) {
    if (err) error = err
    else nodes[seqs.indexOf(seq)] = node
    if (--missing) return
    if (error) cb(error)
    else cb(null, nodes, seqs)
  }
}

Tree.prototype._onlyCached = function (seqs) {
  var cachedSeqs = []

  for (var i = 0; i < seqs.length; i++) {
    if (this.feed.has(seqs[i])) cachedSeqs.push(seqs[i])
  }

  return cachedSeqs
}

Tree.prototype._deflate = function (seq, index) {
  var endsWithSeq = true
  var lenIsh = 11
  var i = 0
  var idx

  for (i = 0; i < index.length; i++) {
    idx = index[i]

    lenIsh += idx.length * 11 + 11
    if (idx[idx.length - 1] !== seq) endsWithSeq = false
  }

  var header = 0
  if (endsWithSeq) header |= 1

  var buf = new Buffer(lenIsh)
  var offset = 0

  buf[offset++] = header

  for (i = 0; i < index.length; i++) {
    idx = index[i]

    var prev = 0
    var len = endsWithSeq ? idx.length - 1 : idx.length

    varint.encode(len, buf, offset)
    offset += varint.encode.bytes

    for (var j = 0; j < len; j++) {
      varint.encode(idx[j] - prev, buf, offset)
      offset += varint.encode.bytes
      prev = idx[j]
    }
  }

  if (offset > buf.length) throw new Error('Assert error: buffer length too small')
  return buf.slice(0, offset)
}

Tree.prototype._inflate = function (seq, buf) {
  var offset = 0

  var header = varint.decode(buf, offset)
  offset += varint.decode.bytes

  var endsWithSeq = !!(header & 1)
  var index = []

  while (offset < buf.length) {
    var len = varint.decode(buf, offset) // TODO: sanity check this length
    offset += varint.decode.bytes

    var seqs = new Array(endsWithSeq ? len + 1 : len)
    var i = 0

    for (; i < len; i++) {
      if (offset >= buf.length) throw new Error('Invalid index')

      seqs[i] = varint.decode(buf, offset) + (i ? seqs[i - 1] : 0)
      offset += varint.decode.bytes
    }

    if (endsWithSeq) seqs[i] = seq
    index.push(seqs)
  }

  return index
}

Tree.prototype._defaultOpts = function (opts) {
  if (!opts) return {wait: this._wait, cached: this._cached, node: this._asNode}
  if (opts.wait === undefined) opts.wait = this._wait
  if (opts.cached === undefined) opts.cached = this._cached
  if (opts.node === undefined) opts.node = this._asNode
  return opts
}

function join (names) {
  return '/' + names.join('/')
}

function split (name) {
  var list = name.split('/')
  if (list[0] === '') list.shift()
  if (list[list.length - 1] === '') list.pop()
  return list
}

function notFound (names) {
  var err = new Error(join(names) + ' could not be found')
  err.notFound = true
  err.status = 404
  return err
}

function compare (a, b) {
  var idx = 0
  while (idx < a.length && a[idx] === b[idx]) idx++
  return idx
}

function Node (node, seq) {
  this.index = seq
  this.name = node.name
  this.value = node.value
  this.paths = node.paths
}

function getCache (opts) {
  if (opts.cache === false) return null
  if (opts.cache === true || !opts.cache) {
    var cacheSize = opts.cacheSize || 65536
    return cache(cacheSize, {indexedValues: true})
  }
  return opts.cache
}

}).call(this,require("buffer").Buffer)
},{"./messages":9,"array-lru":11,"buffer":32,"codecs":34,"events":27,"from2":51,"inherits":71,"mutexify":86,"process-nextick-args":93,"varint":154}],9:[function(require,module,exports){
(function (Buffer){
// This file is auto generated by the protocol-buffers cli tool

/* eslint-disable quotes */
/* eslint-disable indent */
/* eslint-disable no-redeclare */

// Remember to `npm install --save protocol-buffers-encodings`
var encodings = require('protocol-buffers-encodings')
var varint = encodings.varint
var skip = encodings.skip

var Node = exports.Node = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

defineNode()

function defineNode () {
  var enc = [
    encodings.string,
    encodings.bytes
  ]

  Node.encodingLength = encodingLength
  Node.encode = encode
  Node.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.name)) throw new Error("name is required")
    var len = enc[0].encodingLength(obj.name)
    length += 1 + len
    if (defined(obj.value)) {
      var len = enc[1].encodingLength(obj.value)
      length += 1 + len
    }
    if (defined(obj.paths)) {
      var len = enc[1].encodingLength(obj.paths)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.name)) throw new Error("name is required")
    buf[offset++] = 10
    enc[0].encode(obj.name, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.value)) {
      buf[offset++] = 18
      enc[1].encode(obj.value, buf, offset)
      offset += enc[1].encode.bytes
    }
    if (defined(obj.paths)) {
      buf[offset++] = 26
      enc[1].encode(obj.paths, buf, offset)
      offset += enc[1].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      name: "",
      value: null,
      paths: null
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.name = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.value = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        case 3:
        obj.paths = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defined (val) {
  return val !== null && val !== undefined && (typeof val !== 'number' || !isNaN(val))
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"protocol-buffers-encodings":95}],10:[function(require,module,exports){
// crc16 impl, optimized for numeric inputs

var TABLE = [
  0x0000, 0x1021, 0x2042, 0x3063, 0x4084, 0x50a5, 0x60c6, 0x70e7,
  0x8108, 0x9129, 0xa14a, 0xb16b, 0xc18c, 0xd1ad, 0xe1ce, 0xf1ef,
  0x1231, 0x0210, 0x3273, 0x2252, 0x52b5, 0x4294, 0x72f7, 0x62d6,
  0x9339, 0x8318, 0xb37b, 0xa35a, 0xd3bd, 0xc39c, 0xf3ff, 0xe3de,
  0x2462, 0x3443, 0x0420, 0x1401, 0x64e6, 0x74c7, 0x44a4, 0x5485,
  0xa56a, 0xb54b, 0x8528, 0x9509, 0xe5ee, 0xf5cf, 0xc5ac, 0xd58d,
  0x3653, 0x2672, 0x1611, 0x0630, 0x76d7, 0x66f6, 0x5695, 0x46b4,
  0xb75b, 0xa77a, 0x9719, 0x8738, 0xf7df, 0xe7fe, 0xd79d, 0xc7bc,
  0x48c4, 0x58e5, 0x6886, 0x78a7, 0x0840, 0x1861, 0x2802, 0x3823,
  0xc9cc, 0xd9ed, 0xe98e, 0xf9af, 0x8948, 0x9969, 0xa90a, 0xb92b,
  0x5af5, 0x4ad4, 0x7ab7, 0x6a96, 0x1a71, 0x0a50, 0x3a33, 0x2a12,
  0xdbfd, 0xcbdc, 0xfbbf, 0xeb9e, 0x9b79, 0x8b58, 0xbb3b, 0xab1a,
  0x6ca6, 0x7c87, 0x4ce4, 0x5cc5, 0x2c22, 0x3c03, 0x0c60, 0x1c41,
  0xedae, 0xfd8f, 0xcdec, 0xddcd, 0xad2a, 0xbd0b, 0x8d68, 0x9d49,
  0x7e97, 0x6eb6, 0x5ed5, 0x4ef4, 0x3e13, 0x2e32, 0x1e51, 0x0e70,
  0xff9f, 0xefbe, 0xdfdd, 0xcffc, 0xbf1b, 0xaf3a, 0x9f59, 0x8f78,
  0x9188, 0x81a9, 0xb1ca, 0xa1eb, 0xd10c, 0xc12d, 0xf14e, 0xe16f,
  0x1080, 0x00a1, 0x30c2, 0x20e3, 0x5004, 0x4025, 0x7046, 0x6067,
  0x83b9, 0x9398, 0xa3fb, 0xb3da, 0xc33d, 0xd31c, 0xe37f, 0xf35e,
  0x02b1, 0x1290, 0x22f3, 0x32d2, 0x4235, 0x5214, 0x6277, 0x7256,
  0xb5ea, 0xa5cb, 0x95a8, 0x8589, 0xf56e, 0xe54f, 0xd52c, 0xc50d,
  0x34e2, 0x24c3, 0x14a0, 0x0481, 0x7466, 0x6447, 0x5424, 0x4405,
  0xa7db, 0xb7fa, 0x8799, 0x97b8, 0xe75f, 0xf77e, 0xc71d, 0xd73c,
  0x26d3, 0x36f2, 0x0691, 0x16b0, 0x6657, 0x7676, 0x4615, 0x5634,
  0xd94c, 0xc96d, 0xf90e, 0xe92f, 0x99c8, 0x89e9, 0xb98a, 0xa9ab,
  0x5844, 0x4865, 0x7806, 0x6827, 0x18c0, 0x08e1, 0x3882, 0x28a3,
  0xcb7d, 0xdb5c, 0xeb3f, 0xfb1e, 0x8bf9, 0x9bd8, 0xabbb, 0xbb9a,
  0x4a75, 0x5a54, 0x6a37, 0x7a16, 0x0af1, 0x1ad0, 0x2ab3, 0x3a92,
  0xfd2e, 0xed0f, 0xdd6c, 0xcd4d, 0xbdaa, 0xad8b, 0x9de8, 0x8dc9,
  0x7c26, 0x6c07, 0x5c64, 0x4c45, 0x3ca2, 0x2c83, 0x1ce0, 0x0cc1,
  0xef1f, 0xff3e, 0xcf5d, 0xdf7c, 0xaf9b, 0xbfba, 0x8fd9, 0x9ff8,
  0x6e17, 0x7e36, 0x4e55, 0x5e74, 0x2e93, 0x3eb2, 0x0ed1, 0x1ef0
]

module.exports = crc16

function crc16 (n) {
  var crc = 0
  var r = 0

  for (var i = 0; i < 8; i++) {
    r = n & 0xff
    n = (n - r) / 256
    crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ r) & 0xff]) & 0xffff
  }

  return crc
}

},{}],11:[function(require,module,exports){
var hash = require('./crc16')

module.exports = LRU

function LRU (max, opts) {
  if (!(this instanceof LRU)) return new LRU(max, opts)
  if (!opts) opts = {}

  // how many collisions before evicting (factor of two for fast modulo)
  this.collisions = factorOfTwo(opts.collisions || opts.bucketSize || 4)
  // buckets should be a factor of two for fast modulo as well
  this.buckets = factorOf(max, this.collisions) / this.collisions

  // we use 16bit hashing to bucket index must be <0xffff
  while (this.buckets > 65536) {
    this.buckets >>= 1
    this.collisions <<= 1
  }

  this.size = this.buckets * this.collisions
  this.wrap = !opts.indexedValues
  this.cache = new Array(this.size)
  this.hash = this.buckets === 65536 ? hash : maskedHash(this.buckets - 1)
  this.evict = opts.evict || null
}

LRU.prototype.set = function (index, val) {
  var pageStart = this.collisions * this.hash(index)
  var pageEnd = pageStart + this.collisions
  var ptr = pageStart
  var page = null

  while (ptr < pageEnd) {
    page = this.cache[ptr]

    if (!page) {
      // no exiting version, but we have space to store it
      page = this.cache[ptr] = this.wrap ? new Node(index, val) : val
      move(this.cache, pageStart, ptr, page)
      return
    }

    if (page.index === index) {
      // update existing version and move to head of bucket
      if (this.wrap) page.value = val
      else this.cache[ptr] = val
      move(this.cache, pageStart, ptr, page)
      return
    }

    ptr++
  }

  // bucket is full, update oldest (last element in bucket)
  if (this.wrap) {
    if (this.evict) this.evict(page.index, page.value)
    page.index = index
    page.value = val
  } else {
    if (this.evict) this.evict(page.index, page)
    this.cache[ptr - 1] = val
  }
  move(this.cache, pageStart, ptr - 1, page)
}

LRU.prototype.get = function (index) {
  var pageStart = this.collisions * this.hash(index)
  var pageEnd = pageStart + this.collisions
  var ptr = pageStart

  while (ptr < pageEnd) {
    var page = this.cache[ptr++]

    if (!page) return null
    if (page.index !== index) continue

    // we found it! move to head of bucket and return value
    move(this.cache, pageStart, ptr - 1, page)

    return this.wrap ? page.value : page
  }

  return null
}

function move (list, index, itemIndex, item) {
  while (itemIndex > index) list[itemIndex] = list[--itemIndex]
  list[index] = item
}

function Node (index, value) {
  this.index = index
  this.value = value
}

function factorOf (n, factor) {
  n = factorOfTwo(n)
  while (n & (factor - 1)) n <<= 1
  return n
}

function factorOfTwo (n) {
  if (n && !(n & (n - 1))) return n
  var p = 1
  while (p < n) p <<= 1
  return p
}

function maskedHash (mask) {
  return function (n) {
    return hash(n) & mask
  }
}

},{"./crc16":10}],12:[function(require,module,exports){
(function (global){
'use strict';

// compare and isBuffer taken from https://github.com/feross/buffer/blob/680e9e5e488f22aac27599a57dc844a6315928dd/index.js
// original notice:

/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */
function compare(a, b) {
  if (a === b) {
    return 0;
  }

  var x = a.length;
  var y = b.length;

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i];
      y = b[i];
      break;
    }
  }

  if (x < y) {
    return -1;
  }
  if (y < x) {
    return 1;
  }
  return 0;
}
function isBuffer(b) {
  if (global.Buffer && typeof global.Buffer.isBuffer === 'function') {
    return global.Buffer.isBuffer(b);
  }
  return !!(b != null && b._isBuffer);
}

// based on node assert, original notice:

// http://wiki.commonjs.org/wiki/Unit_Testing/1.0
//
// THIS IS NOT TESTED NOR LIKELY TO WORK OUTSIDE V8!
//
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

var util = require('util/');
var hasOwn = Object.prototype.hasOwnProperty;
var pSlice = Array.prototype.slice;
var functionsHaveNames = (function () {
  return function foo() {}.name === 'foo';
}());
function pToString (obj) {
  return Object.prototype.toString.call(obj);
}
function isView(arrbuf) {
  if (isBuffer(arrbuf)) {
    return false;
  }
  if (typeof global.ArrayBuffer !== 'function') {
    return false;
  }
  if (typeof ArrayBuffer.isView === 'function') {
    return ArrayBuffer.isView(arrbuf);
  }
  if (!arrbuf) {
    return false;
  }
  if (arrbuf instanceof DataView) {
    return true;
  }
  if (arrbuf.buffer && arrbuf.buffer instanceof ArrayBuffer) {
    return true;
  }
  return false;
}
// 1. The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

var assert = module.exports = ok;

// 2. The AssertionError is defined in assert.
// new assert.AssertionError({ message: message,
//                             actual: actual,
//                             expected: expected })

var regex = /\s*function\s+([^\(\s]*)\s*/;
// based on https://github.com/ljharb/function.prototype.name/blob/adeeeec8bfcc6068b187d7d9fb3d5bb1d3a30899/implementation.js
function getName(func) {
  if (!util.isFunction(func)) {
    return;
  }
  if (functionsHaveNames) {
    return func.name;
  }
  var str = func.toString();
  var match = str.match(regex);
  return match && match[1];
}
assert.AssertionError = function AssertionError(options) {
  this.name = 'AssertionError';
  this.actual = options.actual;
  this.expected = options.expected;
  this.operator = options.operator;
  if (options.message) {
    this.message = options.message;
    this.generatedMessage = false;
  } else {
    this.message = getMessage(this);
    this.generatedMessage = true;
  }
  var stackStartFunction = options.stackStartFunction || fail;
  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, stackStartFunction);
  } else {
    // non v8 browsers so we can have a stacktrace
    var err = new Error();
    if (err.stack) {
      var out = err.stack;

      // try to strip useless frames
      var fn_name = getName(stackStartFunction);
      var idx = out.indexOf('\n' + fn_name);
      if (idx >= 0) {
        // once we have located the function frame
        // we need to strip out everything before it (and its line)
        var next_line = out.indexOf('\n', idx + 1);
        out = out.substring(next_line + 1);
      }

      this.stack = out;
    }
  }
};

// assert.AssertionError instanceof Error
util.inherits(assert.AssertionError, Error);

function truncate(s, n) {
  if (typeof s === 'string') {
    return s.length < n ? s : s.slice(0, n);
  } else {
    return s;
  }
}
function inspect(something) {
  if (functionsHaveNames || !util.isFunction(something)) {
    return util.inspect(something);
  }
  var rawname = getName(something);
  var name = rawname ? ': ' + rawname : '';
  return '[Function' +  name + ']';
}
function getMessage(self) {
  return truncate(inspect(self.actual), 128) + ' ' +
         self.operator + ' ' +
         truncate(inspect(self.expected), 128);
}

// At present only the three keys mentioned above are used and
// understood by the spec. Implementations or sub modules can pass
// other keys to the AssertionError's constructor - they will be
// ignored.

// 3. All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided.  All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

function fail(actual, expected, message, operator, stackStartFunction) {
  throw new assert.AssertionError({
    message: message,
    actual: actual,
    expected: expected,
    operator: operator,
    stackStartFunction: stackStartFunction
  });
}

// EXTENSION! allows for well behaved errors defined elsewhere.
assert.fail = fail;

// 4. Pure assertion tests whether a value is truthy, as determined
// by !!guard.
// assert.ok(guard, message_opt);
// This statement is equivalent to assert.equal(true, !!guard,
// message_opt);. To test strictly for the value true, use
// assert.strictEqual(true, guard, message_opt);.

function ok(value, message) {
  if (!value) fail(value, true, message, '==', assert.ok);
}
assert.ok = ok;

// 5. The equality assertion tests shallow, coercive equality with
// ==.
// assert.equal(actual, expected, message_opt);

assert.equal = function equal(actual, expected, message) {
  if (actual != expected) fail(actual, expected, message, '==', assert.equal);
};

// 6. The non-equality assertion tests for whether two objects are not equal
// with != assert.notEqual(actual, expected, message_opt);

assert.notEqual = function notEqual(actual, expected, message) {
  if (actual == expected) {
    fail(actual, expected, message, '!=', assert.notEqual);
  }
};

// 7. The equivalence assertion tests a deep equality relation.
// assert.deepEqual(actual, expected, message_opt);

assert.deepEqual = function deepEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected, false)) {
    fail(actual, expected, message, 'deepEqual', assert.deepEqual);
  }
};

assert.deepStrictEqual = function deepStrictEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected, true)) {
    fail(actual, expected, message, 'deepStrictEqual', assert.deepStrictEqual);
  }
};

function _deepEqual(actual, expected, strict, memos) {
  // 7.1. All identical values are equivalent, as determined by ===.
  if (actual === expected) {
    return true;
  } else if (isBuffer(actual) && isBuffer(expected)) {
    return compare(actual, expected) === 0;

  // 7.2. If the expected value is a Date object, the actual value is
  // equivalent if it is also a Date object that refers to the same time.
  } else if (util.isDate(actual) && util.isDate(expected)) {
    return actual.getTime() === expected.getTime();

  // 7.3 If the expected value is a RegExp object, the actual value is
  // equivalent if it is also a RegExp object with the same source and
  // properties (`global`, `multiline`, `lastIndex`, `ignoreCase`).
  } else if (util.isRegExp(actual) && util.isRegExp(expected)) {
    return actual.source === expected.source &&
           actual.global === expected.global &&
           actual.multiline === expected.multiline &&
           actual.lastIndex === expected.lastIndex &&
           actual.ignoreCase === expected.ignoreCase;

  // 7.4. Other pairs that do not both pass typeof value == 'object',
  // equivalence is determined by ==.
  } else if ((actual === null || typeof actual !== 'object') &&
             (expected === null || typeof expected !== 'object')) {
    return strict ? actual === expected : actual == expected;

  // If both values are instances of typed arrays, wrap their underlying
  // ArrayBuffers in a Buffer each to increase performance
  // This optimization requires the arrays to have the same type as checked by
  // Object.prototype.toString (aka pToString). Never perform binary
  // comparisons for Float*Arrays, though, since e.g. +0 === -0 but their
  // bit patterns are not identical.
  } else if (isView(actual) && isView(expected) &&
             pToString(actual) === pToString(expected) &&
             !(actual instanceof Float32Array ||
               actual instanceof Float64Array)) {
    return compare(new Uint8Array(actual.buffer),
                   new Uint8Array(expected.buffer)) === 0;

  // 7.5 For all other Object pairs, including Array objects, equivalence is
  // determined by having the same number of owned properties (as verified
  // with Object.prototype.hasOwnProperty.call), the same set of keys
  // (although not necessarily the same order), equivalent values for every
  // corresponding key, and an identical 'prototype' property. Note: this
  // accounts for both named and indexed properties on Arrays.
  } else if (isBuffer(actual) !== isBuffer(expected)) {
    return false;
  } else {
    memos = memos || {actual: [], expected: []};

    var actualIndex = memos.actual.indexOf(actual);
    if (actualIndex !== -1) {
      if (actualIndex === memos.expected.indexOf(expected)) {
        return true;
      }
    }

    memos.actual.push(actual);
    memos.expected.push(expected);

    return objEquiv(actual, expected, strict, memos);
  }
}

function isArguments(object) {
  return Object.prototype.toString.call(object) == '[object Arguments]';
}

function objEquiv(a, b, strict, actualVisitedObjects) {
  if (a === null || a === undefined || b === null || b === undefined)
    return false;
  // if one is a primitive, the other must be same
  if (util.isPrimitive(a) || util.isPrimitive(b))
    return a === b;
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b))
    return false;
  var aIsArgs = isArguments(a);
  var bIsArgs = isArguments(b);
  if ((aIsArgs && !bIsArgs) || (!aIsArgs && bIsArgs))
    return false;
  if (aIsArgs) {
    a = pSlice.call(a);
    b = pSlice.call(b);
    return _deepEqual(a, b, strict);
  }
  var ka = objectKeys(a);
  var kb = objectKeys(b);
  var key, i;
  // having the same number of owned properties (keys incorporates
  // hasOwnProperty)
  if (ka.length !== kb.length)
    return false;
  //the same set of keys (although not necessarily the same order),
  ka.sort();
  kb.sort();
  //~~~cheap key test
  for (i = ka.length - 1; i >= 0; i--) {
    if (ka[i] !== kb[i])
      return false;
  }
  //equivalent values for every corresponding key, and
  //~~~possibly expensive deep test
  for (i = ka.length - 1; i >= 0; i--) {
    key = ka[i];
    if (!_deepEqual(a[key], b[key], strict, actualVisitedObjects))
      return false;
  }
  return true;
}

// 8. The non-equivalence assertion tests for any deep inequality.
// assert.notDeepEqual(actual, expected, message_opt);

assert.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (_deepEqual(actual, expected, false)) {
    fail(actual, expected, message, 'notDeepEqual', assert.notDeepEqual);
  }
};

assert.notDeepStrictEqual = notDeepStrictEqual;
function notDeepStrictEqual(actual, expected, message) {
  if (_deepEqual(actual, expected, true)) {
    fail(actual, expected, message, 'notDeepStrictEqual', notDeepStrictEqual);
  }
}


// 9. The strict equality assertion tests strict equality, as determined by ===.
// assert.strictEqual(actual, expected, message_opt);

assert.strictEqual = function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(actual, expected, message, '===', assert.strictEqual);
  }
};

// 10. The strict non-equality assertion tests for strict inequality, as
// determined by !==.  assert.notStrictEqual(actual, expected, message_opt);

assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (actual === expected) {
    fail(actual, expected, message, '!==', assert.notStrictEqual);
  }
};

function expectedException(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  if (Object.prototype.toString.call(expected) == '[object RegExp]') {
    return expected.test(actual);
  }

  try {
    if (actual instanceof expected) {
      return true;
    }
  } catch (e) {
    // Ignore.  The instanceof check doesn't work for arrow functions.
  }

  if (Error.isPrototypeOf(expected)) {
    return false;
  }

  return expected.call({}, actual) === true;
}

function _tryBlock(block) {
  var error;
  try {
    block();
  } catch (e) {
    error = e;
  }
  return error;
}

function _throws(shouldThrow, block, expected, message) {
  var actual;

  if (typeof block !== 'function') {
    throw new TypeError('"block" argument must be a function');
  }

  if (typeof expected === 'string') {
    message = expected;
    expected = null;
  }

  actual = _tryBlock(block);

  message = (expected && expected.name ? ' (' + expected.name + ').' : '.') +
            (message ? ' ' + message : '.');

  if (shouldThrow && !actual) {
    fail(actual, expected, 'Missing expected exception' + message);
  }

  var userProvidedMessage = typeof message === 'string';
  var isUnwantedException = !shouldThrow && util.isError(actual);
  var isUnexpectedException = !shouldThrow && actual && !expected;

  if ((isUnwantedException &&
      userProvidedMessage &&
      expectedException(actual, expected)) ||
      isUnexpectedException) {
    fail(actual, expected, 'Got unwanted exception' + message);
  }

  if ((shouldThrow && actual && expected &&
      !expectedException(actual, expected)) || (!shouldThrow && actual)) {
    throw actual;
  }
}

// 11. Expected to throw an error:
// assert.throws(block, Error_opt, message_opt);

assert.throws = function(block, /*optional*/error, /*optional*/message) {
  _throws(true, block, error, message);
};

// EXTENSION! This is annoying to write outside this module.
assert.doesNotThrow = function(block, /*optional*/error, /*optional*/message) {
  _throws(false, block, error, message);
};

assert.ifError = function(err) { if (err) throw err; };

var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    if (hasOwn.call(obj, key)) keys.push(key);
  }
  return keys;
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"util/":15}],13:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],14:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],15:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":14,"_process":94,"inherits":13}],16:[function(require,module,exports){
module.exports = batcher

function batcher (run) {
  var running = false
  var pendingBatch = null
  var pendingCallbacks = null
  var callbacks = null

  return append

  function done (err) {
    if (callbacks) callAll(callbacks, err)

    running = false
    callbacks = pendingCallbacks
    var nextBatch = pendingBatch

    pendingBatch = null
    pendingCallbacks = null

    if (!nextBatch || !nextBatch.length) {
      if (!callbacks || !callbacks.length) {
        callbacks = null
        return
      }
      if (!nextBatch) nextBatch = []
    }

    running = true
    run(nextBatch, done)
  }

  function append (val, cb) {
    if (running) {
      if (!pendingBatch) {
        pendingBatch = []
        pendingCallbacks = []
      }
      pushAll(pendingBatch, val)
      if (cb) pendingCallbacks.push(cb)
    } else {
      if (cb) callbacks = [cb]
      running = true
      run(Array.isArray(val) ? val : [val], done)
    }
  }
}

function pushAll (list, val) {
  if (Array.isArray(val)) pushArray(list, val)
  else list.push(val)
}

function pushArray (list, val) {
  for (var i = 0; i < val.length; i++) list.push(val[i])
}

function callAll (list, err) {
  for (var i = 0; i < list.length; i++) list[i](err)
}

},{}],17:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  for (var i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(
      uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)
    ))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],18:[function(require,module,exports){
var varint = require('varint')
var alloc = require('buffer-alloc-unsafe')

module.exports = align(1)

function align (n) {
  var exports = {}

  exports.align = align

  exports.encode = encode
  exports.encode.bytes = 0
  exports.encodingLength = encodingLength

  exports.decode = decode
  exports.decode.bytes = 0
  exports.decodingLength = decodingLength

  return exports

  function State (input, output, offset) {
    this.inputOffset = 0
    this.inputLength = input.length
    this.input = input
    this.outputOffset = offset
    this.output = output
  }

  function encode (bitfield, buffer, offset) {
    if (!offset) offset = 0
    if (!buffer) buffer = alloc(encodingLength(bitfield))
    var state = new State(bitfield, buffer, offset)
    rle(state)
    encode.bytes = state.outputOffset - offset
    return buffer
  }

  function encodingLength (bitfield) {
    var state = new State(bitfield, null, 0)
    rle(state)
    return state.outputOffset
  }

  function decode (buffer, offset) {
    if (!offset) offset = 0

    var bitfield = alloc(decodingLength(buffer, offset))
    var ptr = 0

    while (offset < buffer.length) {
      var next = varint.decode(buffer, offset)
      var repeat = next & 1
      var len = repeat ? (next - (next & 3)) / 4 : next / 2

      offset += varint.decode.bytes

      if (repeat) {
        bitfield.fill(next & 2 ? 255 : 0, ptr, ptr + len)
      } else {
        buffer.copy(bitfield, ptr, offset, offset + len)
        offset += len
      }

      ptr += len
    }

    bitfield.fill(0, ptr)
    decode.bytes = buffer.length - offset

    return bitfield
  }

  function decodingLength (buffer, offset) {
    if (!offset) offset = 0

    var len = 0

    while (offset < buffer.length) {
      var next = varint.decode(buffer, offset)
      offset += varint.decode.bytes

      var repeat = next & 1
      var slice = repeat ? (next - (next & 3)) / 4 : next / 2

      len += slice
      if (!repeat) offset += slice
    }

    if (offset > buffer.length) throw new Error('Invalid RLE bitfield')

    if (len & (n - 1)) return len + (n - (len & (n - 1)))

    return len
  }

  function rle (state) {
    var len = 0
    var bits = 0
    var input = state.input

    while (state.inputLength > 0 && !input[state.inputLength - 1]) state.inputLength--

    for (var i = 0; i < state.inputLength; i++) {
      if (input[i] === bits) {
        len++
        continue
      }

      if (len) encodeUpdate(state, i, len, bits)

      if (input[i] === 0 || input[i] === 255) {
        bits = input[i]
        len = 1
      } else {
        len = 0
      }
    }

    if (len) encodeUpdate(state, state.inputLength, len, bits)
    encodeFinal(state)
  }

  function encodeHead (state, end) {
    var headLength = end - state.inputOffset
    varint.encode(2 * headLength, state.output, state.outputOffset)
    state.outputOffset += varint.encode.bytes
    state.input.copy(state.output, state.outputOffset, state.inputOffset, end)
    state.outputOffset += headLength
  }

  function encodeFinal (state) {
    var headLength = state.inputLength - state.inputOffset
    if (!headLength) return

    if (!state.output) {
      state.outputOffset += (headLength + varint.encodingLength(2 * headLength))
    } else {
      encodeHead(state, state.inputLength)
    }

    state.inputOffset = state.inputLength
  }

  function encodeUpdate (state, i, len, bit) {
    var headLength = i - len - state.inputOffset
    var headCost = (headLength ? varint.encodingLength(2 * headLength) + headLength : 0)
    var enc = 4 * len + (bit ? 2 : 0) + 1 // len << 2 | bit << 1 | 1
    var encCost = headCost + varint.encodingLength(enc)
    var baseCost = varint.encodingLength(2 * (i - state.inputOffset)) + i - state.inputOffset

    if (encCost >= baseCost) return

    if (!state.output) {
      state.outputOffset += encCost
      state.inputOffset = i
      return
    }

    if (headLength) encodeHead(state, i - len)

    varint.encode(enc, state.output, state.outputOffset)
    state.outputOffset += varint.encode.bytes
    state.inputOffset = i
  }
}

},{"buffer-alloc-unsafe":28,"varint":21}],19:[function(require,module,exports){
module.exports = read

var MSB = 0x80
  , REST = 0x7F

function read(buf, offset) {
  var res    = 0
    , offset = offset || 0
    , shift  = 0
    , counter = offset
    , b
    , l = buf.length

  do {
    if(counter >= l) {
      read.bytes = 0
      read.bytesRead = 0 // DEPRECATED
      return undefined
    }
    b = buf[counter++]
    res += shift < 28
      ? (b & REST) << shift
      : (b & REST) * Math.pow(2, shift)
    shift += 7
  } while (b >= MSB)

  read.bytes = counter - offset

  return res
}

},{}],20:[function(require,module,exports){
module.exports = encode

var MSB = 0x80
  , REST = 0x7F
  , MSBALL = ~REST
  , INT = Math.pow(2, 31)

function encode(num, out, offset) {
  out = out || []
  offset = offset || 0
  var oldOffset = offset

  while(num >= INT) {
    out[offset++] = (num & 0xFF) | MSB
    num /= 128
  }
  while(num & MSBALL) {
    out[offset++] = (num & 0xFF) | MSB
    num >>>= 7
  }
  out[offset] = num | 0
  
  encode.bytes = offset - oldOffset + 1
  
  return out
}

},{}],21:[function(require,module,exports){
module.exports = {
    encode: require('./encode.js')
  , decode: require('./decode.js')
  , encodingLength: require('./length.js')
}

},{"./decode.js":19,"./encode.js":20,"./length.js":22}],22:[function(require,module,exports){

var N1 = Math.pow(2,  7)
var N2 = Math.pow(2, 14)
var N3 = Math.pow(2, 21)
var N4 = Math.pow(2, 28)
var N5 = Math.pow(2, 35)
var N6 = Math.pow(2, 42)
var N7 = Math.pow(2, 49)
var N8 = Math.pow(2, 56)
var N9 = Math.pow(2, 63)

module.exports = function (value) {
  return (
    value < N1 ? 1
  : value < N2 ? 2
  : value < N3 ? 3
  : value < N4 ? 4
  : value < N5 ? 5
  : value < N6 ? 6
  : value < N7 ? 7
  : value < N8 ? 8
  : value < N9 ? 9
  :              10
  )
}

},{}],23:[function(require,module,exports){

module.exports = loadWebAssembly

loadWebAssembly.supported = typeof WebAssembly !== 'undefined'

function loadWebAssembly (opts) {
  if (!loadWebAssembly.supported) return null

  var imp = opts && opts.imports
  var wasm = toUint8Array('AGFzbQEAAAABEANgAn9/AGADf39/AGABfwADBQQAAQICBQUBAQroBwdNBQZtZW1vcnkCAAxibGFrZTJiX2luaXQAAA5ibGFrZTJiX3VwZGF0ZQABDWJsYWtlMmJfZmluYWwAAhBibGFrZTJiX2NvbXByZXNzAAMK00AElgMAIABCADcDACAAQQhqQgA3AwAgAEEQakIANwMAIABBGGpCADcDACAAQSBqQgA3AwAgAEEoakIANwMAIABBMGpCADcDACAAQThqQgA3AwAgAEHAAGpCADcDACAAQcgAakIANwMAIABB0ABqQgA3AwAgAEHYAGpCADcDACAAQeAAakIANwMAIABB6ABqQgA3AwAgAEHwAGpCADcDACAAQfgAakIANwMAIABBgAFqQoiS853/zPmE6gBBACkDAIU3AwAgAEGIAWpCu86qptjQ67O7f0EIKQMAhTcDACAAQZABakKr8NP0r+68tzxBECkDAIU3AwAgAEGYAWpC8e30+KWn/aelf0EYKQMAhTcDACAAQaABakLRhZrv+s+Uh9EAQSApAwCFNwMAIABBqAFqQp/Y+dnCkdqCm39BKCkDAIU3AwAgAEGwAWpC6/qG2r+19sEfQTApAwCFNwMAIABBuAFqQvnC+JuRo7Pw2wBBOCkDAIU3AwAgAEHAAWpCADcDACAAQcgBakIANwMAIABB0AFqQgA3AwALbQEDfyAAQcABaiEDIABByAFqIQQgBCkDAKchBQJAA0AgASACRg0BIAVBgAFGBEAgAyADKQMAIAWtfDcDAEEAIQUgABADCyAAIAVqIAEtAAA6AAAgBUEBaiEFIAFBAWohAQwACwsgBCAFrTcDAAtkAQN/IABBwAFqIQEgAEHIAWohAiABIAEpAwAgAikDAHw3AwAgAEHQAWpCfzcDACACKQMApyEDAkADQCADQYABRg0BIAAgA2pBADoAACADQQFqIQMMAAsLIAIgA603AwAgABADC+U7AiB+CX8gAEGAAWohISAAQYgBaiEiIABBkAFqISMgAEGYAWohJCAAQaABaiElIABBqAFqISYgAEGwAWohJyAAQbgBaiEoICEpAwAhASAiKQMAIQIgIykDACEDICQpAwAhBCAlKQMAIQUgJikDACEGICcpAwAhByAoKQMAIQhCiJLznf/M+YTqACEJQrvOqqbY0Ouzu38hCkKr8NP0r+68tzwhC0Lx7fT4paf9p6V/IQxC0YWa7/rPlIfRACENQp/Y+dnCkdqCm38hDkLr+obav7X2wR8hD0L5wvibkaOz8NsAIRAgACkDACERIABBCGopAwAhEiAAQRBqKQMAIRMgAEEYaikDACEUIABBIGopAwAhFSAAQShqKQMAIRYgAEEwaikDACEXIABBOGopAwAhGCAAQcAAaikDACEZIABByABqKQMAIRogAEHQAGopAwAhGyAAQdgAaikDACEcIABB4ABqKQMAIR0gAEHoAGopAwAhHiAAQfAAaikDACEfIABB+ABqKQMAISAgDSAAQcABaikDAIUhDSAPIABB0AFqKQMAhSEPIAEgBSARfHwhASANIAGFQiCKIQ0gCSANfCEJIAUgCYVCGIohBSABIAUgEnx8IQEgDSABhUIQiiENIAkgDXwhCSAFIAmFQj+KIQUgAiAGIBN8fCECIA4gAoVCIIohDiAKIA58IQogBiAKhUIYiiEGIAIgBiAUfHwhAiAOIAKFQhCKIQ4gCiAOfCEKIAYgCoVCP4ohBiADIAcgFXx8IQMgDyADhUIgiiEPIAsgD3whCyAHIAuFQhiKIQcgAyAHIBZ8fCEDIA8gA4VCEIohDyALIA98IQsgByALhUI/iiEHIAQgCCAXfHwhBCAQIASFQiCKIRAgDCAQfCEMIAggDIVCGIohCCAEIAggGHx8IQQgECAEhUIQiiEQIAwgEHwhDCAIIAyFQj+KIQggASAGIBl8fCEBIBAgAYVCIIohECALIBB8IQsgBiALhUIYiiEGIAEgBiAafHwhASAQIAGFQhCKIRAgCyAQfCELIAYgC4VCP4ohBiACIAcgG3x8IQIgDSAChUIgiiENIAwgDXwhDCAHIAyFQhiKIQcgAiAHIBx8fCECIA0gAoVCEIohDSAMIA18IQwgByAMhUI/iiEHIAMgCCAdfHwhAyAOIAOFQiCKIQ4gCSAOfCEJIAggCYVCGIohCCADIAggHnx8IQMgDiADhUIQiiEOIAkgDnwhCSAIIAmFQj+KIQggBCAFIB98fCEEIA8gBIVCIIohDyAKIA98IQogBSAKhUIYiiEFIAQgBSAgfHwhBCAPIASFQhCKIQ8gCiAPfCEKIAUgCoVCP4ohBSABIAUgH3x8IQEgDSABhUIgiiENIAkgDXwhCSAFIAmFQhiKIQUgASAFIBt8fCEBIA0gAYVCEIohDSAJIA18IQkgBSAJhUI/iiEFIAIgBiAVfHwhAiAOIAKFQiCKIQ4gCiAOfCEKIAYgCoVCGIohBiACIAYgGXx8IQIgDiAChUIQiiEOIAogDnwhCiAGIAqFQj+KIQYgAyAHIBp8fCEDIA8gA4VCIIohDyALIA98IQsgByALhUIYiiEHIAMgByAgfHwhAyAPIAOFQhCKIQ8gCyAPfCELIAcgC4VCP4ohByAEIAggHnx8IQQgECAEhUIgiiEQIAwgEHwhDCAIIAyFQhiKIQggBCAIIBd8fCEEIBAgBIVCEIohECAMIBB8IQwgCCAMhUI/iiEIIAEgBiASfHwhASAQIAGFQiCKIRAgCyAQfCELIAYgC4VCGIohBiABIAYgHXx8IQEgECABhUIQiiEQIAsgEHwhCyAGIAuFQj+KIQYgAiAHIBF8fCECIA0gAoVCIIohDSAMIA18IQwgByAMhUIYiiEHIAIgByATfHwhAiANIAKFQhCKIQ0gDCANfCEMIAcgDIVCP4ohByADIAggHHx8IQMgDiADhUIgiiEOIAkgDnwhCSAIIAmFQhiKIQggAyAIIBh8fCEDIA4gA4VCEIohDiAJIA58IQkgCCAJhUI/iiEIIAQgBSAWfHwhBCAPIASFQiCKIQ8gCiAPfCEKIAUgCoVCGIohBSAEIAUgFHx8IQQgDyAEhUIQiiEPIAogD3whCiAFIAqFQj+KIQUgASAFIBx8fCEBIA0gAYVCIIohDSAJIA18IQkgBSAJhUIYiiEFIAEgBSAZfHwhASANIAGFQhCKIQ0gCSANfCEJIAUgCYVCP4ohBSACIAYgHXx8IQIgDiAChUIgiiEOIAogDnwhCiAGIAqFQhiKIQYgAiAGIBF8fCECIA4gAoVCEIohDiAKIA58IQogBiAKhUI/iiEGIAMgByAWfHwhAyAPIAOFQiCKIQ8gCyAPfCELIAcgC4VCGIohByADIAcgE3x8IQMgDyADhUIQiiEPIAsgD3whCyAHIAuFQj+KIQcgBCAIICB8fCEEIBAgBIVCIIohECAMIBB8IQwgCCAMhUIYiiEIIAQgCCAefHwhBCAQIASFQhCKIRAgDCAQfCEMIAggDIVCP4ohCCABIAYgG3x8IQEgECABhUIgiiEQIAsgEHwhCyAGIAuFQhiKIQYgASAGIB98fCEBIBAgAYVCEIohECALIBB8IQsgBiALhUI/iiEGIAIgByAUfHwhAiANIAKFQiCKIQ0gDCANfCEMIAcgDIVCGIohByACIAcgF3x8IQIgDSAChUIQiiENIAwgDXwhDCAHIAyFQj+KIQcgAyAIIBh8fCEDIA4gA4VCIIohDiAJIA58IQkgCCAJhUIYiiEIIAMgCCASfHwhAyAOIAOFQhCKIQ4gCSAOfCEJIAggCYVCP4ohCCAEIAUgGnx8IQQgDyAEhUIgiiEPIAogD3whCiAFIAqFQhiKIQUgBCAFIBV8fCEEIA8gBIVCEIohDyAKIA98IQogBSAKhUI/iiEFIAEgBSAYfHwhASANIAGFQiCKIQ0gCSANfCEJIAUgCYVCGIohBSABIAUgGnx8IQEgDSABhUIQiiENIAkgDXwhCSAFIAmFQj+KIQUgAiAGIBR8fCECIA4gAoVCIIohDiAKIA58IQogBiAKhUIYiiEGIAIgBiASfHwhAiAOIAKFQhCKIQ4gCiAOfCEKIAYgCoVCP4ohBiADIAcgHnx8IQMgDyADhUIgiiEPIAsgD3whCyAHIAuFQhiKIQcgAyAHIB18fCEDIA8gA4VCEIohDyALIA98IQsgByALhUI/iiEHIAQgCCAcfHwhBCAQIASFQiCKIRAgDCAQfCEMIAggDIVCGIohCCAEIAggH3x8IQQgECAEhUIQiiEQIAwgEHwhDCAIIAyFQj+KIQggASAGIBN8fCEBIBAgAYVCIIohECALIBB8IQsgBiALhUIYiiEGIAEgBiAXfHwhASAQIAGFQhCKIRAgCyAQfCELIAYgC4VCP4ohBiACIAcgFnx8IQIgDSAChUIgiiENIAwgDXwhDCAHIAyFQhiKIQcgAiAHIBt8fCECIA0gAoVCEIohDSAMIA18IQwgByAMhUI/iiEHIAMgCCAVfHwhAyAOIAOFQiCKIQ4gCSAOfCEJIAggCYVCGIohCCADIAggEXx8IQMgDiADhUIQiiEOIAkgDnwhCSAIIAmFQj+KIQggBCAFICB8fCEEIA8gBIVCIIohDyAKIA98IQogBSAKhUIYiiEFIAQgBSAZfHwhBCAPIASFQhCKIQ8gCiAPfCEKIAUgCoVCP4ohBSABIAUgGnx8IQEgDSABhUIgiiENIAkgDXwhCSAFIAmFQhiKIQUgASAFIBF8fCEBIA0gAYVCEIohDSAJIA18IQkgBSAJhUI/iiEFIAIgBiAWfHwhAiAOIAKFQiCKIQ4gCiAOfCEKIAYgCoVCGIohBiACIAYgGHx8IQIgDiAChUIQiiEOIAogDnwhCiAGIAqFQj+KIQYgAyAHIBN8fCEDIA8gA4VCIIohDyALIA98IQsgByALhUIYiiEHIAMgByAVfHwhAyAPIAOFQhCKIQ8gCyAPfCELIAcgC4VCP4ohByAEIAggG3x8IQQgECAEhUIgiiEQIAwgEHwhDCAIIAyFQhiKIQggBCAIICB8fCEEIBAgBIVCEIohECAMIBB8IQwgCCAMhUI/iiEIIAEgBiAffHwhASAQIAGFQiCKIRAgCyAQfCELIAYgC4VCGIohBiABIAYgEnx8IQEgECABhUIQiiEQIAsgEHwhCyAGIAuFQj+KIQYgAiAHIBx8fCECIA0gAoVCIIohDSAMIA18IQwgByAMhUIYiiEHIAIgByAdfHwhAiANIAKFQhCKIQ0gDCANfCEMIAcgDIVCP4ohByADIAggF3x8IQMgDiADhUIgiiEOIAkgDnwhCSAIIAmFQhiKIQggAyAIIBl8fCEDIA4gA4VCEIohDiAJIA58IQkgCCAJhUI/iiEIIAQgBSAUfHwhBCAPIASFQiCKIQ8gCiAPfCEKIAUgCoVCGIohBSAEIAUgHnx8IQQgDyAEhUIQiiEPIAogD3whCiAFIAqFQj+KIQUgASAFIBN8fCEBIA0gAYVCIIohDSAJIA18IQkgBSAJhUIYiiEFIAEgBSAdfHwhASANIAGFQhCKIQ0gCSANfCEJIAUgCYVCP4ohBSACIAYgF3x8IQIgDiAChUIgiiEOIAogDnwhCiAGIAqFQhiKIQYgAiAGIBt8fCECIA4gAoVCEIohDiAKIA58IQogBiAKhUI/iiEGIAMgByARfHwhAyAPIAOFQiCKIQ8gCyAPfCELIAcgC4VCGIohByADIAcgHHx8IQMgDyADhUIQiiEPIAsgD3whCyAHIAuFQj+KIQcgBCAIIBl8fCEEIBAgBIVCIIohECAMIBB8IQwgCCAMhUIYiiEIIAQgCCAUfHwhBCAQIASFQhCKIRAgDCAQfCEMIAggDIVCP4ohCCABIAYgFXx8IQEgECABhUIgiiEQIAsgEHwhCyAGIAuFQhiKIQYgASAGIB58fCEBIBAgAYVCEIohECALIBB8IQsgBiALhUI/iiEGIAIgByAYfHwhAiANIAKFQiCKIQ0gDCANfCEMIAcgDIVCGIohByACIAcgFnx8IQIgDSAChUIQiiENIAwgDXwhDCAHIAyFQj+KIQcgAyAIICB8fCEDIA4gA4VCIIohDiAJIA58IQkgCCAJhUIYiiEIIAMgCCAffHwhAyAOIAOFQhCKIQ4gCSAOfCEJIAggCYVCP4ohCCAEIAUgEnx8IQQgDyAEhUIgiiEPIAogD3whCiAFIAqFQhiKIQUgBCAFIBp8fCEEIA8gBIVCEIohDyAKIA98IQogBSAKhUI/iiEFIAEgBSAdfHwhASANIAGFQiCKIQ0gCSANfCEJIAUgCYVCGIohBSABIAUgFnx8IQEgDSABhUIQiiENIAkgDXwhCSAFIAmFQj+KIQUgAiAGIBJ8fCECIA4gAoVCIIohDiAKIA58IQogBiAKhUIYiiEGIAIgBiAgfHwhAiAOIAKFQhCKIQ4gCiAOfCEKIAYgCoVCP4ohBiADIAcgH3x8IQMgDyADhUIgiiEPIAsgD3whCyAHIAuFQhiKIQcgAyAHIB58fCEDIA8gA4VCEIohDyALIA98IQsgByALhUI/iiEHIAQgCCAVfHwhBCAQIASFQiCKIRAgDCAQfCEMIAggDIVCGIohCCAEIAggG3x8IQQgECAEhUIQiiEQIAwgEHwhDCAIIAyFQj+KIQggASAGIBF8fCEBIBAgAYVCIIohECALIBB8IQsgBiALhUIYiiEGIAEgBiAYfHwhASAQIAGFQhCKIRAgCyAQfCELIAYgC4VCP4ohBiACIAcgF3x8IQIgDSAChUIgiiENIAwgDXwhDCAHIAyFQhiKIQcgAiAHIBR8fCECIA0gAoVCEIohDSAMIA18IQwgByAMhUI/iiEHIAMgCCAafHwhAyAOIAOFQiCKIQ4gCSAOfCEJIAggCYVCGIohCCADIAggE3x8IQMgDiADhUIQiiEOIAkgDnwhCSAIIAmFQj+KIQggBCAFIBl8fCEEIA8gBIVCIIohDyAKIA98IQogBSAKhUIYiiEFIAQgBSAcfHwhBCAPIASFQhCKIQ8gCiAPfCEKIAUgCoVCP4ohBSABIAUgHnx8IQEgDSABhUIgiiENIAkgDXwhCSAFIAmFQhiKIQUgASAFIBx8fCEBIA0gAYVCEIohDSAJIA18IQkgBSAJhUI/iiEFIAIgBiAYfHwhAiAOIAKFQiCKIQ4gCiAOfCEKIAYgCoVCGIohBiACIAYgH3x8IQIgDiAChUIQiiEOIAogDnwhCiAGIAqFQj+KIQYgAyAHIB18fCEDIA8gA4VCIIohDyALIA98IQsgByALhUIYiiEHIAMgByASfHwhAyAPIAOFQhCKIQ8gCyAPfCELIAcgC4VCP4ohByAEIAggFHx8IQQgECAEhUIgiiEQIAwgEHwhDCAIIAyFQhiKIQggBCAIIBp8fCEEIBAgBIVCEIohECAMIBB8IQwgCCAMhUI/iiEIIAEgBiAWfHwhASAQIAGFQiCKIRAgCyAQfCELIAYgC4VCGIohBiABIAYgEXx8IQEgECABhUIQiiEQIAsgEHwhCyAGIAuFQj+KIQYgAiAHICB8fCECIA0gAoVCIIohDSAMIA18IQwgByAMhUIYiiEHIAIgByAVfHwhAiANIAKFQhCKIQ0gDCANfCEMIAcgDIVCP4ohByADIAggGXx8IQMgDiADhUIgiiEOIAkgDnwhCSAIIAmFQhiKIQggAyAIIBd8fCEDIA4gA4VCEIohDiAJIA58IQkgCCAJhUI/iiEIIAQgBSATfHwhBCAPIASFQiCKIQ8gCiAPfCEKIAUgCoVCGIohBSAEIAUgG3x8IQQgDyAEhUIQiiEPIAogD3whCiAFIAqFQj+KIQUgASAFIBd8fCEBIA0gAYVCIIohDSAJIA18IQkgBSAJhUIYiiEFIAEgBSAgfHwhASANIAGFQhCKIQ0gCSANfCEJIAUgCYVCP4ohBSACIAYgH3x8IQIgDiAChUIgiiEOIAogDnwhCiAGIAqFQhiKIQYgAiAGIBp8fCECIA4gAoVCEIohDiAKIA58IQogBiAKhUI/iiEGIAMgByAcfHwhAyAPIAOFQiCKIQ8gCyAPfCELIAcgC4VCGIohByADIAcgFHx8IQMgDyADhUIQiiEPIAsgD3whCyAHIAuFQj+KIQcgBCAIIBF8fCEEIBAgBIVCIIohECAMIBB8IQwgCCAMhUIYiiEIIAQgCCAZfHwhBCAQIASFQhCKIRAgDCAQfCEMIAggDIVCP4ohCCABIAYgHXx8IQEgECABhUIgiiEQIAsgEHwhCyAGIAuFQhiKIQYgASAGIBN8fCEBIBAgAYVCEIohECALIBB8IQsgBiALhUI/iiEGIAIgByAefHwhAiANIAKFQiCKIQ0gDCANfCEMIAcgDIVCGIohByACIAcgGHx8IQIgDSAChUIQiiENIAwgDXwhDCAHIAyFQj+KIQcgAyAIIBJ8fCEDIA4gA4VCIIohDiAJIA58IQkgCCAJhUIYiiEIIAMgCCAVfHwhAyAOIAOFQhCKIQ4gCSAOfCEJIAggCYVCP4ohCCAEIAUgG3x8IQQgDyAEhUIgiiEPIAogD3whCiAFIAqFQhiKIQUgBCAFIBZ8fCEEIA8gBIVCEIohDyAKIA98IQogBSAKhUI/iiEFIAEgBSAbfHwhASANIAGFQiCKIQ0gCSANfCEJIAUgCYVCGIohBSABIAUgE3x8IQEgDSABhUIQiiENIAkgDXwhCSAFIAmFQj+KIQUgAiAGIBl8fCECIA4gAoVCIIohDiAKIA58IQogBiAKhUIYiiEGIAIgBiAVfHwhAiAOIAKFQhCKIQ4gCiAOfCEKIAYgCoVCP4ohBiADIAcgGHx8IQMgDyADhUIgiiEPIAsgD3whCyAHIAuFQhiKIQcgAyAHIBd8fCEDIA8gA4VCEIohDyALIA98IQsgByALhUI/iiEHIAQgCCASfHwhBCAQIASFQiCKIRAgDCAQfCEMIAggDIVCGIohCCAEIAggFnx8IQQgECAEhUIQiiEQIAwgEHwhDCAIIAyFQj+KIQggASAGICB8fCEBIBAgAYVCIIohECALIBB8IQsgBiALhUIYiiEGIAEgBiAcfHwhASAQIAGFQhCKIRAgCyAQfCELIAYgC4VCP4ohBiACIAcgGnx8IQIgDSAChUIgiiENIAwgDXwhDCAHIAyFQhiKIQcgAiAHIB98fCECIA0gAoVCEIohDSAMIA18IQwgByAMhUI/iiEHIAMgCCAUfHwhAyAOIAOFQiCKIQ4gCSAOfCEJIAggCYVCGIohCCADIAggHXx8IQMgDiADhUIQiiEOIAkgDnwhCSAIIAmFQj+KIQggBCAFIB58fCEEIA8gBIVCIIohDyAKIA98IQogBSAKhUIYiiEFIAQgBSARfHwhBCAPIASFQhCKIQ8gCiAPfCEKIAUgCoVCP4ohBSABIAUgEXx8IQEgDSABhUIgiiENIAkgDXwhCSAFIAmFQhiKIQUgASAFIBJ8fCEBIA0gAYVCEIohDSAJIA18IQkgBSAJhUI/iiEFIAIgBiATfHwhAiAOIAKFQiCKIQ4gCiAOfCEKIAYgCoVCGIohBiACIAYgFHx8IQIgDiAChUIQiiEOIAogDnwhCiAGIAqFQj+KIQYgAyAHIBV8fCEDIA8gA4VCIIohDyALIA98IQsgByALhUIYiiEHIAMgByAWfHwhAyAPIAOFQhCKIQ8gCyAPfCELIAcgC4VCP4ohByAEIAggF3x8IQQgECAEhUIgiiEQIAwgEHwhDCAIIAyFQhiKIQggBCAIIBh8fCEEIBAgBIVCEIohECAMIBB8IQwgCCAMhUI/iiEIIAEgBiAZfHwhASAQIAGFQiCKIRAgCyAQfCELIAYgC4VCGIohBiABIAYgGnx8IQEgECABhUIQiiEQIAsgEHwhCyAGIAuFQj+KIQYgAiAHIBt8fCECIA0gAoVCIIohDSAMIA18IQwgByAMhUIYiiEHIAIgByAcfHwhAiANIAKFQhCKIQ0gDCANfCEMIAcgDIVCP4ohByADIAggHXx8IQMgDiADhUIgiiEOIAkgDnwhCSAIIAmFQhiKIQggAyAIIB58fCEDIA4gA4VCEIohDiAJIA58IQkgCCAJhUI/iiEIIAQgBSAffHwhBCAPIASFQiCKIQ8gCiAPfCEKIAUgCoVCGIohBSAEIAUgIHx8IQQgDyAEhUIQiiEPIAogD3whCiAFIAqFQj+KIQUgASAFIB98fCEBIA0gAYVCIIohDSAJIA18IQkgBSAJhUIYiiEFIAEgBSAbfHwhASANIAGFQhCKIQ0gCSANfCEJIAUgCYVCP4ohBSACIAYgFXx8IQIgDiAChUIgiiEOIAogDnwhCiAGIAqFQhiKIQYgAiAGIBl8fCECIA4gAoVCEIohDiAKIA58IQogBiAKhUI/iiEGIAMgByAafHwhAyAPIAOFQiCKIQ8gCyAPfCELIAcgC4VCGIohByADIAcgIHx8IQMgDyADhUIQiiEPIAsgD3whCyAHIAuFQj+KIQcgBCAIIB58fCEEIBAgBIVCIIohECAMIBB8IQwgCCAMhUIYiiEIIAQgCCAXfHwhBCAQIASFQhCKIRAgDCAQfCEMIAggDIVCP4ohCCABIAYgEnx8IQEgECABhUIgiiEQIAsgEHwhCyAGIAuFQhiKIQYgASAGIB18fCEBIBAgAYVCEIohECALIBB8IQsgBiALhUI/iiEGIAIgByARfHwhAiANIAKFQiCKIQ0gDCANfCEMIAcgDIVCGIohByACIAcgE3x8IQIgDSAChUIQiiENIAwgDXwhDCAHIAyFQj+KIQcgAyAIIBx8fCEDIA4gA4VCIIohDiAJIA58IQkgCCAJhUIYiiEIIAMgCCAYfHwhAyAOIAOFQhCKIQ4gCSAOfCEJIAggCYVCP4ohCCAEIAUgFnx8IQQgDyAEhUIgiiEPIAogD3whCiAFIAqFQhiKIQUgBCAFIBR8fCEEIA8gBIVCEIohDyAKIA98IQogBSAKhUI/iiEFICEgISkDACABIAmFhTcDACAiICIpAwAgAiAKhYU3AwAgIyAjKQMAIAMgC4WFNwMAICQgJCkDACAEIAyFhTcDACAlICUpAwAgBSANhYU3AwAgJiAmKQMAIAYgDoWFNwMAICcgJykDACAHIA+FhTcDACAoICgpAwAgCCAQhYU3AwAL')
  var ready = null

  var mod = {
    buffer: wasm,
    memory: null,
    exports: null,
    realloc: realloc,
    onload: onload
  }

  onload(function () {})

  return mod

  function realloc (size) {
    mod.exports.memory.grow(Math.ceil(Math.abs(size - mod.memory.length) / 65536))
    mod.memory = new Uint8Array(mod.exports.memory.buffer)
  }

  function onload (cb) {
    if (mod.exports) return cb()

    if (ready) {
      ready.then(cb.bind(null, null)).catch(cb)
      return
    }

    try {
      if (opts && opts.async) throw new Error('async')
      setup({instance: new WebAssembly.Instance(new WebAssembly.Module(wasm), imp)})
    } catch (err) {
      ready = WebAssembly.instantiate(wasm, imp).then(setup)
    }

    onload(cb)
  }

  function setup (w) {
    mod.exports = w.instance.exports
    mod.memory = mod.exports.memory && mod.exports.memory.buffer && new Uint8Array(mod.exports.memory.buffer)
  }
}

function toUint8Array (s) {
  if (typeof atob === 'function') return new Uint8Array(atob(s).split('').map(charCodeAt))
  return new (require('buf' + 'fer').Buffer)(s, 'base64')
}

function charCodeAt (c) {
  return c.charCodeAt(0)
}

},{}],24:[function(require,module,exports){
var assert = require('nanoassert')
var wasm = require('./blake2b')()

var head = 64
var freeList = []

module.exports = Blake2b
var BYTES_MIN = module.exports.BYTES_MIN = 16
var BYTES_MAX = module.exports.BYTES_MAX = 64
var BYTES = module.exports.BYTES = 32
var KEYBYTES_MIN = module.exports.KEYBYTES_MIN = 16
var KEYBYTES_MAX = module.exports.KEYBYTES_MAX = 64
var KEYBYTES = module.exports.KEYBYTES = 32
var SALTBYTES = module.exports.SALTBYTES = 16
var PERSONALBYTES = module.exports.PERSONALBYTES = 16

function Blake2b (digestLength, key, salt, personal, noAssert) {
  if (!(this instanceof Blake2b)) return new Blake2b(digestLength, key, salt, personal, noAssert)
  if (!(wasm && wasm.exports)) throw new Error('WASM not loaded. Wait for Blake2b.ready(cb)')
  if (!digestLength) digestLength = 32

  if (noAssert !== true) {
    assert(digestLength >= BYTES_MIN, 'digestLength must be at least ' + BYTES_MIN + ', was given ' + digestLength)
    assert(digestLength <= BYTES_MAX, 'digestLength must be at most ' + BYTES_MAX + ', was given ' + digestLength)
    if (key != null) assert(key.length >= KEYBYTES_MIN, 'key must be at least ' + KEYBYTES_MIN + ', was given ' + key.length)
    if (key != null) assert(key.length <= KEYBYTES_MAX, 'key must be at least ' + KEYBYTES_MAX + ', was given ' + key.length)
    if (salt != null) assert(salt.length === SALTBYTES, 'salt must be exactly ' + SALTBYTES + ', was given ' + salt.length)
    if (personal != null) assert(personal.length === PERSONALBYTES, 'personal must be exactly ' + PERSONALBYTES + ', was given ' + personal.length)
  }

  if (!freeList.length) {
    freeList.push(head)
    head += 216
  }

  this.digestLength = digestLength
  this.finalized = false
  this.pointer = freeList.pop()

  wasm.memory.fill(0, 0, 64)
  wasm.memory[0] = this.digestLength
  wasm.memory[1] = key ? key.length : 0
  wasm.memory[2] = 1 // fanout
  wasm.memory[3] = 1 // depth

  if (salt) wasm.memory.set(salt, 32)
  if (personal) wasm.memory.set(personal, 48)

  if (this.pointer + 216 > wasm.memory.length) wasm.realloc(this.pointer + 216) // we need 216 bytes for the state
  wasm.exports.blake2b_init(this.pointer, this.digestLength)

  if (key) {
    this.update(key)
    wasm.memory.fill(0, head, head + key.length) // whiteout key
    wasm.memory[this.pointer + 200] = 128
  }
}


Blake2b.prototype.update = function (input) {
  assert(this.finalized === false, 'Hash instance finalized')
  assert(input, 'input must be TypedArray or Buffer')

  if (head + input.length > wasm.memory.length) wasm.realloc(head + input.length)
  wasm.memory.set(input, head)
  wasm.exports.blake2b_update(this.pointer, head, head + input.length)
  return this
}

Blake2b.prototype.digest = function (enc) {
  assert(this.finalized === false, 'Hash instance finalized')
  this.finalized = true

  freeList.push(this.pointer)
  wasm.exports.blake2b_final(this.pointer)

  if (!enc || enc === 'binary') {
    return wasm.memory.slice(this.pointer + 128, this.pointer + 128 + this.digestLength)
  }

  if (enc === 'hex') {
    return hexSlice(wasm.memory, this.pointer + 128, this.digestLength)
  }

  assert(enc.length >= this.digestLength, 'input must be TypedArray or Buffer')
  for (var i = 0; i < this.digestLength; i++) {
    enc[i] = wasm.memory[this.pointer + 128 + i]
  }

  return enc
}

// libsodium compat
Blake2b.prototype.final = Blake2b.prototype.digest

Blake2b.WASM = wasm && wasm.buffer
Blake2b.SUPPORTED = typeof WebAssembly !== 'undefined'

Blake2b.ready = function (cb) {
  if (!cb) cb = noop
  if (!wasm) return cb(new Error('WebAssembly not supported'))

  // backwards compat, can be removed in a new major
  var p = new Promise(function (reject, resolve) {
    wasm.onload(function (err) {
      if (err) resolve()
      else reject()
      cb(err)
    })
  })

  return p
}

Blake2b.prototype.ready = Blake2b.ready

function noop () {}

function hexSlice (buf, start, len) {
  var str = ''
  for (var i = 0; i < len; i++) str += toHex(buf[start + i])
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

},{"./blake2b":23,"nanoassert":87}],25:[function(require,module,exports){
var assert = require('nanoassert')
var b2wasm = require('blake2b-wasm')

// 64-bit unsigned addition
// Sets v[a,a+1] += v[b,b+1]
// v should be a Uint32Array
function ADD64AA (v, a, b) {
  var o0 = v[a] + v[b]
  var o1 = v[a + 1] + v[b + 1]
  if (o0 >= 0x100000000) {
    o1++
  }
  v[a] = o0
  v[a + 1] = o1
}

// 64-bit unsigned addition
// Sets v[a,a+1] += b
// b0 is the low 32 bits of b, b1 represents the high 32 bits
function ADD64AC (v, a, b0, b1) {
  var o0 = v[a] + b0
  if (b0 < 0) {
    o0 += 0x100000000
  }
  var o1 = v[a + 1] + b1
  if (o0 >= 0x100000000) {
    o1++
  }
  v[a] = o0
  v[a + 1] = o1
}

// Little-endian byte access
function B2B_GET32 (arr, i) {
  return (arr[i] ^
  (arr[i + 1] << 8) ^
  (arr[i + 2] << 16) ^
  (arr[i + 3] << 24))
}

// G Mixing function
// The ROTRs are inlined for speed
function B2B_G (a, b, c, d, ix, iy) {
  var x0 = m[ix]
  var x1 = m[ix + 1]
  var y0 = m[iy]
  var y1 = m[iy + 1]

  ADD64AA(v, a, b) // v[a,a+1] += v[b,b+1] ... in JS we must store a uint64 as two uint32s
  ADD64AC(v, a, x0, x1) // v[a, a+1] += x ... x0 is the low 32 bits of x, x1 is the high 32 bits

  // v[d,d+1] = (v[d,d+1] xor v[a,a+1]) rotated to the right by 32 bits
  var xor0 = v[d] ^ v[a]
  var xor1 = v[d + 1] ^ v[a + 1]
  v[d] = xor1
  v[d + 1] = xor0

  ADD64AA(v, c, d)

  // v[b,b+1] = (v[b,b+1] xor v[c,c+1]) rotated right by 24 bits
  xor0 = v[b] ^ v[c]
  xor1 = v[b + 1] ^ v[c + 1]
  v[b] = (xor0 >>> 24) ^ (xor1 << 8)
  v[b + 1] = (xor1 >>> 24) ^ (xor0 << 8)

  ADD64AA(v, a, b)
  ADD64AC(v, a, y0, y1)

  // v[d,d+1] = (v[d,d+1] xor v[a,a+1]) rotated right by 16 bits
  xor0 = v[d] ^ v[a]
  xor1 = v[d + 1] ^ v[a + 1]
  v[d] = (xor0 >>> 16) ^ (xor1 << 16)
  v[d + 1] = (xor1 >>> 16) ^ (xor0 << 16)

  ADD64AA(v, c, d)

  // v[b,b+1] = (v[b,b+1] xor v[c,c+1]) rotated right by 63 bits
  xor0 = v[b] ^ v[c]
  xor1 = v[b + 1] ^ v[c + 1]
  v[b] = (xor1 >>> 31) ^ (xor0 << 1)
  v[b + 1] = (xor0 >>> 31) ^ (xor1 << 1)
}

// Initialization Vector
var BLAKE2B_IV32 = new Uint32Array([
  0xF3BCC908, 0x6A09E667, 0x84CAA73B, 0xBB67AE85,
  0xFE94F82B, 0x3C6EF372, 0x5F1D36F1, 0xA54FF53A,
  0xADE682D1, 0x510E527F, 0x2B3E6C1F, 0x9B05688C,
  0xFB41BD6B, 0x1F83D9AB, 0x137E2179, 0x5BE0CD19
])

var SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3
]

// These are offsets into a uint64 buffer.
// Multiply them all by 2 to make them offsets into a uint32 buffer,
// because this is Javascript and we don't have uint64s
var SIGMA82 = new Uint8Array(SIGMA8.map(function (x) { return x * 2 }))

// Compression function. 'last' flag indicates last block.
// Note we're representing 16 uint64s as 32 uint32s
var v = new Uint32Array(32)
var m = new Uint32Array(32)
function blake2bCompress (ctx, last) {
  var i = 0

  // init work variables
  for (i = 0; i < 16; i++) {
    v[i] = ctx.h[i]
    v[i + 16] = BLAKE2B_IV32[i]
  }

  // low 64 bits of offset
  v[24] = v[24] ^ ctx.t
  v[25] = v[25] ^ (ctx.t / 0x100000000)
  // high 64 bits not supported, offset may not be higher than 2**53-1

  // last block flag set ?
  if (last) {
    v[28] = ~v[28]
    v[29] = ~v[29]
  }

  // get little-endian words
  for (i = 0; i < 32; i++) {
    m[i] = B2B_GET32(ctx.b, 4 * i)
  }

  // twelve rounds of mixing
  for (i = 0; i < 12; i++) {
    B2B_G(0, 8, 16, 24, SIGMA82[i * 16 + 0], SIGMA82[i * 16 + 1])
    B2B_G(2, 10, 18, 26, SIGMA82[i * 16 + 2], SIGMA82[i * 16 + 3])
    B2B_G(4, 12, 20, 28, SIGMA82[i * 16 + 4], SIGMA82[i * 16 + 5])
    B2B_G(6, 14, 22, 30, SIGMA82[i * 16 + 6], SIGMA82[i * 16 + 7])
    B2B_G(0, 10, 20, 30, SIGMA82[i * 16 + 8], SIGMA82[i * 16 + 9])
    B2B_G(2, 12, 22, 24, SIGMA82[i * 16 + 10], SIGMA82[i * 16 + 11])
    B2B_G(4, 14, 16, 26, SIGMA82[i * 16 + 12], SIGMA82[i * 16 + 13])
    B2B_G(6, 8, 18, 28, SIGMA82[i * 16 + 14], SIGMA82[i * 16 + 15])
  }

  for (i = 0; i < 16; i++) {
    ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16]
  }
}

// reusable parameter_block
var parameter_block = new Uint8Array([
  0, 0, 0, 0,      //  0: outlen, keylen, fanout, depth
  0, 0, 0, 0,      //  4: leaf length, sequential mode
  0, 0, 0, 0,      //  8: node offset
  0, 0, 0, 0,      // 12: node offset
  0, 0, 0, 0,      // 16: node depth, inner length, rfu
  0, 0, 0, 0,      // 20: rfu
  0, 0, 0, 0,      // 24: rfu
  0, 0, 0, 0,      // 28: rfu
  0, 0, 0, 0,      // 32: salt
  0, 0, 0, 0,      // 36: salt
  0, 0, 0, 0,      // 40: salt
  0, 0, 0, 0,      // 44: salt
  0, 0, 0, 0,      // 48: personal
  0, 0, 0, 0,      // 52: personal
  0, 0, 0, 0,      // 56: personal
  0, 0, 0, 0       // 60: personal
])

// Creates a BLAKE2b hashing context
// Requires an output length between 1 and 64 bytes
// Takes an optional Uint8Array key
function Blake2b (outlen, key, salt, personal) {
  // zero out parameter_block before usage
  parameter_block.fill(0)
  // state, 'param block'

  this.b = new Uint8Array(128)
  this.h = new Uint32Array(16)
  this.t = 0 // input count
  this.c = 0 // pointer within buffer
  this.outlen = outlen // output length in bytes

  parameter_block[0] = outlen
  if (key) parameter_block[1] = key.length
  parameter_block[2] = 1 // fanout
  parameter_block[3] = 1 // depth

  if (salt) parameter_block.set(salt, 32)
  if (personal) parameter_block.set(personal, 48)

  // initialize hash state
  for (var i = 0; i < 16; i++) {
    this.h[i] = BLAKE2B_IV32[i] ^ B2B_GET32(parameter_block, i * 4)
  }

  // key the hash, if applicable
  if (key) {
    blake2bUpdate(this, key)
    // at the end
    this.c = 128
  }
}

Blake2b.prototype.update = function (input) {
  assert(input != null, 'input must be Uint8Array or Buffer')
  blake2bUpdate(this, input)
  return this
}

Blake2b.prototype.digest = function (out) {
  var buf = (!out || out === 'binary' || out === 'hex') ? new Uint8Array(this.outlen) : out
  assert(buf.length >= this.outlen, 'out must have at least outlen bytes of space')
  blake2bFinal(this, buf)
  if (out === 'hex') return hexSlice(buf)
  return buf
}

Blake2b.prototype.final = Blake2b.prototype.digest

Blake2b.ready = function (cb) {
  b2wasm.ready(function () {
    cb() // ignore the error
  })
}

// Updates a BLAKE2b streaming hash
// Requires hash context and Uint8Array (byte array)
function blake2bUpdate (ctx, input) {
  for (var i = 0; i < input.length; i++) {
    if (ctx.c === 128) { // buffer full ?
      ctx.t += ctx.c // add counters
      blake2bCompress(ctx, false) // compress (not last)
      ctx.c = 0 // counter to zero
    }
    ctx.b[ctx.c++] = input[i]
  }
}

// Completes a BLAKE2b streaming hash
// Returns a Uint8Array containing the message digest
function blake2bFinal (ctx, out) {
  ctx.t += ctx.c // mark last block offset

  while (ctx.c < 128) { // fill up with zeros
    ctx.b[ctx.c++] = 0
  }
  blake2bCompress(ctx, true) // final block flag = 1

  for (var i = 0; i < ctx.outlen; i++) {
    out[i] = ctx.h[i >> 2] >> (8 * (i & 3))
  }
  return out
}

function hexSlice (buf) {
  var str = ''
  for (var i = 0; i < buf.length; i++) str += toHex(buf[i])
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

var Proto = Blake2b

module.exports = function createHash (outlen, key, salt, personal, noAssert) {
  if (noAssert !== true) {
    assert(outlen >= BYTES_MIN, 'outlen must be at least ' + BYTES_MIN + ', was given ' + outlen)
    assert(outlen <= BYTES_MAX, 'outlen must be at most ' + BYTES_MAX + ', was given ' + outlen)
    if (key != null) assert(key.length >= KEYBYTES_MIN, 'key must be at least ' + KEYBYTES_MIN + ', was given ' + key.length)
    if (key != null) assert(key.length <= KEYBYTES_MAX, 'key must be at most ' + KEYBYTES_MAX + ', was given ' + key.length)
    if (salt != null) assert(salt.length === SALTBYTES, 'salt must be exactly ' + SALTBYTES + ', was given ' + salt.length)
    if (personal != null) assert(personal.length === PERSONALBYTES, 'personal must be exactly ' + PERSONALBYTES + ', was given ' + personal.length)
  }

  return new Proto(outlen, key, salt, personal)
}

module.exports.ready = function (cb) {
  b2wasm.ready(function () { // ignore errors
    cb()
  })
}

module.exports.WASM_SUPPORTED = b2wasm.SUPPORTED
module.exports.WASM_LOADED = false

var BYTES_MIN = module.exports.BYTES_MIN = 16
var BYTES_MAX = module.exports.BYTES_MAX = 64
var BYTES = module.exports.BYTES = 32
var KEYBYTES_MIN = module.exports.KEYBYTES_MIN = 16
var KEYBYTES_MAX = module.exports.KEYBYTES_MAX = 64
var KEYBYTES = module.exports.KEYBYTES = 32
var SALTBYTES = module.exports.SALTBYTES = 16
var PERSONALBYTES = module.exports.PERSONALBYTES = 16

b2wasm.ready(function (err) {
  if (!err) {
    module.exports.WASM_LOADED = true
    Proto = b2wasm
  }
})

},{"blake2b-wasm":24,"nanoassert":87}],26:[function(require,module,exports){

},{}],27:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var objectCreate = Object.create || objectCreatePolyfill
var objectKeys = Object.keys || objectKeysPolyfill
var bind = Function.prototype.bind || functionBindPolyfill

function EventEmitter() {
  if (!this._events || !Object.prototype.hasOwnProperty.call(this, '_events')) {
    this._events = objectCreate(null);
    this._eventsCount = 0;
  }

  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
var defaultMaxListeners = 10;

var hasDefineProperty;
try {
  var o = {};
  if (Object.defineProperty) Object.defineProperty(o, 'x', { value: 0 });
  hasDefineProperty = o.x === 0;
} catch (err) { hasDefineProperty = false }
if (hasDefineProperty) {
  Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
    enumerable: true,
    get: function() {
      return defaultMaxListeners;
    },
    set: function(arg) {
      // check whether the input is a positive number (whose value is zero or
      // greater and not a NaN).
      if (typeof arg !== 'number' || arg < 0 || arg !== arg)
        throw new TypeError('"defaultMaxListeners" must be a positive number');
      defaultMaxListeners = arg;
    }
  });
} else {
  EventEmitter.defaultMaxListeners = defaultMaxListeners;
}

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  if (typeof n !== 'number' || n < 0 || isNaN(n))
    throw new TypeError('"n" argument must be a positive number');
  this._maxListeners = n;
  return this;
};

function $getMaxListeners(that) {
  if (that._maxListeners === undefined)
    return EventEmitter.defaultMaxListeners;
  return that._maxListeners;
}

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return $getMaxListeners(this);
};

// These standalone emit* functions are used to optimize calling of event
// handlers for fast cases because emit() itself often has a variable number of
// arguments and can be deoptimized because of that. These functions always have
// the same number of arguments and thus do not get deoptimized, so the code
// inside them can execute faster.
function emitNone(handler, isFn, self) {
  if (isFn)
    handler.call(self);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self);
  }
}
function emitOne(handler, isFn, self, arg1) {
  if (isFn)
    handler.call(self, arg1);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1);
  }
}
function emitTwo(handler, isFn, self, arg1, arg2) {
  if (isFn)
    handler.call(self, arg1, arg2);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2);
  }
}
function emitThree(handler, isFn, self, arg1, arg2, arg3) {
  if (isFn)
    handler.call(self, arg1, arg2, arg3);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].call(self, arg1, arg2, arg3);
  }
}

function emitMany(handler, isFn, self, args) {
  if (isFn)
    handler.apply(self, args);
  else {
    var len = handler.length;
    var listeners = arrayClone(handler, len);
    for (var i = 0; i < len; ++i)
      listeners[i].apply(self, args);
  }
}

EventEmitter.prototype.emit = function emit(type) {
  var er, handler, len, args, i, events;
  var doError = (type === 'error');

  events = this._events;
  if (events)
    doError = (doError && events.error == null);
  else if (!doError)
    return false;

  // If there is no 'error' event listener then throw.
  if (doError) {
    if (arguments.length > 1)
      er = arguments[1];
    if (er instanceof Error) {
      throw er; // Unhandled 'error' event
    } else {
      // At least give some kind of context to the user
      var err = new Error('Unhandled "error" event. (' + er + ')');
      err.context = er;
      throw err;
    }
    return false;
  }

  handler = events[type];

  if (!handler)
    return false;

  var isFn = typeof handler === 'function';
  len = arguments.length;
  switch (len) {
      // fast cases
    case 1:
      emitNone(handler, isFn, this);
      break;
    case 2:
      emitOne(handler, isFn, this, arguments[1]);
      break;
    case 3:
      emitTwo(handler, isFn, this, arguments[1], arguments[2]);
      break;
    case 4:
      emitThree(handler, isFn, this, arguments[1], arguments[2], arguments[3]);
      break;
      // slower
    default:
      args = new Array(len - 1);
      for (i = 1; i < len; i++)
        args[i - 1] = arguments[i];
      emitMany(handler, isFn, this, args);
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  var m;
  var events;
  var existing;

  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');

  events = target._events;
  if (!events) {
    events = target._events = objectCreate(null);
    target._eventsCount = 0;
  } else {
    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (events.newListener) {
      target.emit('newListener', type,
          listener.listener ? listener.listener : listener);

      // Re-assign `events` because a newListener handler could have caused the
      // this._events to be assigned to a new object
      events = target._events;
    }
    existing = events[type];
  }

  if (!existing) {
    // Optimize the case of one listener. Don't need the extra array object.
    existing = events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === 'function') {
      // Adding the second element, need to change to array.
      existing = events[type] =
          prepend ? [listener, existing] : [existing, listener];
    } else {
      // If we've already got an array, just append.
      if (prepend) {
        existing.unshift(listener);
      } else {
        existing.push(listener);
      }
    }

    // Check for listener leak
    if (!existing.warned) {
      m = $getMaxListeners(target);
      if (m && m > 0 && existing.length > m) {
        existing.warned = true;
        var w = new Error('Possible EventEmitter memory leak detected. ' +
            existing.length + ' "' + String(type) + '" listeners ' +
            'added. Use emitter.setMaxListeners() to ' +
            'increase limit.');
        w.name = 'MaxListenersExceededWarning';
        w.emitter = target;
        w.type = type;
        w.count = existing.length;
        if (typeof console === 'object' && console.warn) {
          console.warn('%s: %s', w.name, w.message);
        }
      }
    }
  }

  return target;
}

EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener =
    function prependListener(type, listener) {
      return _addListener(this, type, listener, true);
    };

function onceWrapper() {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    switch (arguments.length) {
      case 0:
        return this.listener.call(this.target);
      case 1:
        return this.listener.call(this.target, arguments[0]);
      case 2:
        return this.listener.call(this.target, arguments[0], arguments[1]);
      case 3:
        return this.listener.call(this.target, arguments[0], arguments[1],
            arguments[2]);
      default:
        var args = new Array(arguments.length);
        for (var i = 0; i < args.length; ++i)
          args[i] = arguments[i];
        this.listener.apply(this.target, args);
    }
  }
}

function _onceWrap(target, type, listener) {
  var state = { fired: false, wrapFn: undefined, target: target, type: type, listener: listener };
  var wrapped = bind.call(onceWrapper, state);
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

EventEmitter.prototype.once = function once(type, listener) {
  if (typeof listener !== 'function')
    throw new TypeError('"listener" argument must be a function');
  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener =
    function prependOnceListener(type, listener) {
      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');
      this.prependListener(type, _onceWrap(this, type, listener));
      return this;
    };

// Emits a 'removeListener' event if and only if the listener was removed.
EventEmitter.prototype.removeListener =
    function removeListener(type, listener) {
      var list, events, position, i, originalListener;

      if (typeof listener !== 'function')
        throw new TypeError('"listener" argument must be a function');

      events = this._events;
      if (!events)
        return this;

      list = events[type];
      if (!list)
        return this;

      if (list === listener || list.listener === listener) {
        if (--this._eventsCount === 0)
          this._events = objectCreate(null);
        else {
          delete events[type];
          if (events.removeListener)
            this.emit('removeListener', type, list.listener || listener);
        }
      } else if (typeof list !== 'function') {
        position = -1;

        for (i = list.length - 1; i >= 0; i--) {
          if (list[i] === listener || list[i].listener === listener) {
            originalListener = list[i].listener;
            position = i;
            break;
          }
        }

        if (position < 0)
          return this;

        if (position === 0)
          list.shift();
        else
          spliceOne(list, position);

        if (list.length === 1)
          events[type] = list[0];

        if (events.removeListener)
          this.emit('removeListener', type, originalListener || listener);
      }

      return this;
    };

EventEmitter.prototype.removeAllListeners =
    function removeAllListeners(type) {
      var listeners, events, i;

      events = this._events;
      if (!events)
        return this;

      // not listening for removeListener, no need to emit
      if (!events.removeListener) {
        if (arguments.length === 0) {
          this._events = objectCreate(null);
          this._eventsCount = 0;
        } else if (events[type]) {
          if (--this._eventsCount === 0)
            this._events = objectCreate(null);
          else
            delete events[type];
        }
        return this;
      }

      // emit removeListener for all listeners on all events
      if (arguments.length === 0) {
        var keys = objectKeys(events);
        var key;
        for (i = 0; i < keys.length; ++i) {
          key = keys[i];
          if (key === 'removeListener') continue;
          this.removeAllListeners(key);
        }
        this.removeAllListeners('removeListener');
        this._events = objectCreate(null);
        this._eventsCount = 0;
        return this;
      }

      listeners = events[type];

      if (typeof listeners === 'function') {
        this.removeListener(type, listeners);
      } else if (listeners) {
        // LIFO order
        for (i = listeners.length - 1; i >= 0; i--) {
          this.removeListener(type, listeners[i]);
        }
      }

      return this;
    };

function _listeners(target, type, unwrap) {
  var events = target._events;

  if (!events)
    return [];

  var evlistener = events[type];
  if (!evlistener)
    return [];

  if (typeof evlistener === 'function')
    return unwrap ? [evlistener.listener || evlistener] : [evlistener];

  return unwrap ? unwrapListeners(evlistener) : arrayClone(evlistener, evlistener.length);
}

EventEmitter.prototype.listeners = function listeners(type) {
  return _listeners(this, type, true);
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  return _listeners(this, type, false);
};

EventEmitter.listenerCount = function(emitter, type) {
  if (typeof emitter.listenerCount === 'function') {
    return emitter.listenerCount(type);
  } else {
    return listenerCount.call(emitter, type);
  }
};

EventEmitter.prototype.listenerCount = listenerCount;
function listenerCount(type) {
  var events = this._events;

  if (events) {
    var evlistener = events[type];

    if (typeof evlistener === 'function') {
      return 1;
    } else if (evlistener) {
      return evlistener.length;
    }
  }

  return 0;
}

EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};

// About 1.5x faster than the two-arg version of Array#splice().
function spliceOne(list, index) {
  for (var i = index, k = i + 1, n = list.length; k < n; i += 1, k += 1)
    list[i] = list[k];
  list.pop();
}

function arrayClone(arr, n) {
  var copy = new Array(n);
  for (var i = 0; i < n; ++i)
    copy[i] = arr[i];
  return copy;
}

function unwrapListeners(arr) {
  var ret = new Array(arr.length);
  for (var i = 0; i < ret.length; ++i) {
    ret[i] = arr[i].listener || arr[i];
  }
  return ret;
}

function objectCreatePolyfill(proto) {
  var F = function() {};
  F.prototype = proto;
  return new F;
}
function objectKeysPolyfill(obj) {
  var keys = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) {
    keys.push(k);
  }
  return k;
}
function functionBindPolyfill(context) {
  var fn = this;
  return function () {
    return fn.apply(context, arguments);
  };
}

},{}],28:[function(require,module,exports){
(function (Buffer){
function allocUnsafe (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be a number')
  }

  if (size < 0) {
    throw new RangeError('"size" argument must not be negative')
  }

  if (Buffer.allocUnsafe) {
    return Buffer.allocUnsafe(size)
  } else {
    return new Buffer(size)
  }
}

module.exports = allocUnsafe

}).call(this,require("buffer").Buffer)
},{"buffer":32}],29:[function(require,module,exports){
(function (Buffer){
var bufferFill = require('buffer-fill')
var allocUnsafe = require('buffer-alloc-unsafe')

module.exports = function alloc (size, fill, encoding) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be a number')
  }

  if (size < 0) {
    throw new RangeError('"size" argument must not be negative')
  }

  if (Buffer.alloc) {
    return Buffer.alloc(size, fill, encoding)
  }

  var buffer = allocUnsafe(size)

  if (size === 0) {
    return buffer
  }

  if (fill === undefined) {
    return bufferFill(buffer, 0)
  }

  if (typeof encoding !== 'string') {
    encoding = undefined
  }

  return bufferFill(buffer, fill, encoding)
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"buffer-alloc-unsafe":28,"buffer-fill":30}],30:[function(require,module,exports){
(function (Buffer){
/* Node.js 6.4.0 and up has full support */
var hasFullSupport = (function () {
  try {
    if (!Buffer.isEncoding('latin1')) {
      return false
    }

    var buf = Buffer.alloc ? Buffer.alloc(4) : new Buffer(4)

    buf.fill('ab', 'ucs2')

    return (buf.toString('hex') === '61006200')
  } catch (_) {
    return false
  }
}())

function isSingleByte (val) {
  return (val.length === 1 && val.charCodeAt(0) < 256)
}

function fillWithNumber (buffer, val, start, end) {
  if (start < 0 || end > buffer.length) {
    throw new RangeError('Out of range index')
  }

  start = start >>> 0
  end = end === undefined ? buffer.length : end >>> 0

  if (end > start) {
    buffer.fill(val, start, end)
  }

  return buffer
}

function fillWithBuffer (buffer, val, start, end) {
  if (start < 0 || end > buffer.length) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return buffer
  }

  start = start >>> 0
  end = end === undefined ? buffer.length : end >>> 0

  var pos = start
  var len = val.length
  while (pos <= (end - len)) {
    val.copy(buffer, pos)
    pos += len
  }

  if (pos !== end) {
    val.copy(buffer, pos, 0, end - pos)
  }

  return buffer
}

function fill (buffer, val, start, end, encoding) {
  if (hasFullSupport) {
    return buffer.fill(val, start, end, encoding)
  }

  if (typeof val === 'number') {
    return fillWithNumber(buffer, val, start, end)
  }

  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = buffer.length
    } else if (typeof end === 'string') {
      encoding = end
      end = buffer.length
    }

    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }

    if (encoding === 'latin1') {
      encoding = 'binary'
    }

    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }

    if (val === '') {
      return fillWithNumber(buffer, 0, start, end)
    }

    if (isSingleByte(val)) {
      return fillWithNumber(buffer, val.charCodeAt(0), start, end)
    }

    val = new Buffer(val, encoding)
  }

  if (Buffer.isBuffer(val)) {
    return fillWithBuffer(buffer, val, start, end)
  }

  // Other values (e.g. undefined, boolean, object) results in zero-fill
  return fillWithNumber(buffer, 0, start, end)
}

module.exports = fill

}).call(this,require("buffer").Buffer)
},{"buffer":32}],31:[function(require,module,exports){
(function (Buffer){
var toString = Object.prototype.toString

var isModern = (
  typeof Buffer.alloc === 'function' &&
  typeof Buffer.allocUnsafe === 'function' &&
  typeof Buffer.from === 'function'
)

function isArrayBuffer (input) {
  return toString.call(input).slice(8, -1) === 'ArrayBuffer'
}

function fromArrayBuffer (obj, byteOffset, length) {
  byteOffset >>>= 0

  var maxLength = obj.byteLength - byteOffset

  if (maxLength < 0) {
    throw new RangeError("'offset' is out of bounds")
  }

  if (length === undefined) {
    length = maxLength
  } else {
    length >>>= 0

    if (length > maxLength) {
      throw new RangeError("'length' is out of bounds")
    }
  }

  return isModern
    ? Buffer.from(obj.slice(byteOffset, byteOffset + length))
    : new Buffer(new Uint8Array(obj.slice(byteOffset, byteOffset + length)))
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('"encoding" must be a valid string encoding')
  }

  return isModern
    ? Buffer.from(string, encoding)
    : new Buffer(string, encoding)
}

function bufferFrom (value, encodingOrOffset, length) {
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number')
  }

  if (isArrayBuffer(value)) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  return isModern
    ? Buffer.from(value)
    : new Buffer(value)
}

module.exports = bufferFrom

}).call(this,require("buffer").Buffer)
},{"buffer":32}],32:[function(require,module,exports){
(function (Buffer){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = {__proto__: Uint8Array.prototype, foo: function () { return 42 }}
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  get: function () {
    if (!(this instanceof Buffer)) {
      return undefined
    }
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  get: function () {
    if (!(this instanceof Buffer)) {
      return undefined
    }
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('Invalid typed array length')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new Error(
        'If encoding is specified then the first argument must be a string'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'number') {
    throw new TypeError('"value" argument must not be a number')
  }

  if (isArrayBuffer(value) || (value && isArrayBuffer(value.buffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  return fromObject(value)
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('"size" argument must not be negative')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj) {
    if (ArrayBuffer.isView(obj) || 'length' in obj) {
      if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
        return createBuffer(0)
      }
      return fromArrayLike(obj)
    }

    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
      return fromArrayLike(obj.data)
    }
  }

  throw new TypeError('The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object.')
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true
}

Buffer.compare = function compare (a, b) {
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError('Arguments must be Buffers')
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (ArrayBuffer.isView(buf)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isArrayBuffer(string)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    string = '' + string
  }

  var len = string.length
  if (len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
      case undefined:
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) return utf8ToBytes(string).length // assume utf8
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  if (this.length > 0) {
    str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
    if (this.length > max) str += ' ... '
  }
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (!Buffer.isBuffer(target)) {
    throw new TypeError('Argument must be a Buffer')
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset  // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
      : (firstByte > 0xBF) ? 2
      : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : new Buffer(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffers from another context (i.e. an iframe) do not pass the `instanceof` check
// but they should be treated as valid. See: https://github.com/feross/buffer/issues/166
function isArrayBuffer (obj) {
  return obj instanceof ArrayBuffer ||
    (obj != null && obj.constructor != null && obj.constructor.name === 'ArrayBuffer' &&
      typeof obj.byteLength === 'number')
}

function numberIsNaN (obj) {
  return obj !== obj // eslint-disable-line no-self-compare
}

}).call(this,require("buffer").Buffer)
},{"base64-js":17,"buffer":32,"ieee754":70}],33:[function(require,module,exports){
var stream = require('readable-stream')
var inherits = require('inherits')
var bufferFrom = require('buffer-from')

var SIGNAL_FLUSH = bufferFrom([0])

var Bulk = function (opts, worker, flush) {
  if (!(this instanceof Bulk)) return new Bulk(opts, worker, flush)

  if (typeof opts === 'function') {
    flush = worker
    worker = opts
    opts = {}
  }

  stream.Writable.call(this, opts)
  this._worker = worker
  this._flush = flush
  this.destroyed = false
}

inherits(Bulk, stream.Writable)

Bulk.obj = function (opts, worker, flush) {
  if (typeof opts === 'function') return Bulk.obj(null, opts, worker)
  if (!opts) opts = {}
  opts.objectMode = true
  return new Bulk(opts, worker, flush)
}

Bulk.prototype.end = function (data, enc, cb) {
  if (!this._flush) return stream.Writable.prototype.end.apply(this, arguments)
  if (typeof data === 'function') return this.end(null, null, data)
  if (typeof enc === 'function') return this.end(data, null, enc)
  if (data) this.write(data)
  if (!this._writableState.ending) this.write(SIGNAL_FLUSH)
  return stream.Writable.prototype.end.call(this, cb)
}

Bulk.prototype.destroy = function (err) {
  if (this.destroyed) return
  this.destroyed = true
  if (err) this.emit('error')
  this.emit('close')
}

Bulk.prototype._write = function (data, enc, cb) {
  if (data === SIGNAL_FLUSH) this._flush(cb)
  else this._worker([data], cb)
}

Bulk.prototype._writev = function (batch, cb) {
  var len = batch.length
  if (batch[batch.length - 1].chunk === SIGNAL_FLUSH) {
    cb = this._flusher(cb)
    if (!--len) return cb()
  }
  var arr = new Array(len)
  for (var i = 0; i < len; i++) arr[i] = batch[i].chunk
  this._worker(arr, cb)
}

Bulk.prototype._flusher = function (cb) {
  var self = this
  return function (err) {
    if (err) return cb(err)
    self._flush(cb)
  }
}

module.exports = Bulk

},{"buffer-from":31,"inherits":71,"readable-stream":116}],34:[function(require,module,exports){
(function (Buffer){
module.exports = codecs

var fromBuffer = (Buffer.from && Buffer.from !== Uint8Array.from)
  ? Buffer.from
  : Buffer

codecs.ascii = createString('ascii')
codecs.utf8 = createString('utf-8')
codecs.hex = createString('hex')
codecs.base64 = createString('base64')
codecs.ucs2 = createString('ucs2')
codecs.utf16le = createString('utf16le')
codecs.ndjson = createJSON(true)
codecs.json = createJSON(false)
codecs.binary = {
  encode: function encodeBinary (obj) {
    return typeof obj === 'string' ? fromBuffer(obj, 'utf-8') : obj
  },
  decode: function decodeBinary (buf) {
    return buf
  }
}

function codecs (fmt) {
  if (typeof fmt === 'object' && fmt && fmt.encode && fmt.decode) return fmt

  switch (fmt) {
    case 'ndjson': return codecs.ndjson
    case 'json': return codecs.json
    case 'ascii': return codecs.ascii
    case 'utf-8':
    case 'utf8': return codecs.utf8
    case 'hex': return codecs.hex
    case 'base64': return codecs.base64
    case 'ucs-2':
    case 'ucs2': return codecs.ucs2
    case 'utf16-le':
    case 'utf16le': return codecs.utf16le
  }

  return codecs.binary
}

function createJSON (newline) {
  return {
    encode: newline ? encodeNDJSON : encodeJSON,
    decode: function decodeJSON (buf) {
      return JSON.parse(buf.toString())
    }
  }

  function encodeJSON (val) {
    return new Buffer(JSON.stringify(val))
  }

  function encodeNDJSON (val) {
    return new Buffer(JSON.stringify(val) + '\n')
  }
}

function createString (type) {
  return {
    encode: function encodeString (val) {
      if (typeof val !== 'string') val = val.toString()
      return fromBuffer(val, type)
    },
    decode: function decodeString (buf) {
      return buf.toString(type)
    }
  }
}

}).call(this,require("buffer").Buffer)
},{"buffer":32}],35:[function(require,module,exports){
(function (Buffer){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.

function isArray(arg) {
  if (Array.isArray) {
    return Array.isArray(arg);
  }
  return objectToString(arg) === '[object Array]';
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = Buffer.isBuffer;

function objectToString(o) {
  return Object.prototype.toString.call(o);
}

}).call(this,{"isBuffer":require("../../is-buffer/index.js")})
},{"../../is-buffer/index.js":73}],36:[function(require,module,exports){
module.exports = function(v) {
  var c = 32
  v &= -v
  if (v) c--
  if (v & 0x0000FFFF) c -= 16
  if (v & 0x00FF00FF) c -= 8
  if (v & 0x0F0F0F0F) c -= 4
  if (v & 0x33333333) c -= 2
  if (v & 0x55555555) c -= 1
  return c
}

},{}],37:[function(require,module,exports){
/**
 * cuid.js
 * Collision-resistant UID generator for browsers and node.
 * Sequential for fast db lookups and recency sorting.
 * Safe for element IDs and server-side lookups.
 *
 * Extracted from CLCTR
 *
 * Copyright (c) Eric Elliott 2012
 * MIT License
 */

/*global window, navigator, document, require, process, module */
(function (app) {
  'use strict';
  var namespace = 'cuid',
    c = 0,
    blockSize = 4,
    base = 36,
    discreteValues = Math.pow(base, blockSize),

    pad = function pad(num, size) {
      var s = "000000000" + num;
      return s.substr(s.length-size);
    },

    randomBlock = function randomBlock() {
      return pad((Math.random() *
            discreteValues << 0)
            .toString(base), blockSize);
    },

    safeCounter = function () {
      c = (c < discreteValues) ? c : 0;
      c++; // this is not subliminal
      return c - 1;
    },

    api = function cuid() {
      // Starting with a lowercase letter makes
      // it HTML element ID friendly.
      var letter = 'c', // hard-coded allows for sequential access

        // timestamp
        // warning: this exposes the exact date and time
        // that the uid was created.
        timestamp = (new Date().getTime()).toString(base),

        // Prevent same-machine collisions.
        counter,

        // A few chars to generate distinct ids for different
        // clients (so different computers are far less
        // likely to generate the same id)
        fingerprint = api.fingerprint(),

        // Grab some more chars from Math.random()
        random = randomBlock() + randomBlock();

        counter = pad(safeCounter().toString(base), blockSize);

      return  (letter + timestamp + counter + fingerprint + random);
    };

  api.slug = function slug() {
    var date = new Date().getTime().toString(36),
      counter,
      print = api.fingerprint().slice(0,1) +
        api.fingerprint().slice(-1),
      random = randomBlock().slice(-2);

      counter = safeCounter().toString(36).slice(-4);

    return date.slice(-2) +
      counter + print + random;
  };

  api.globalCount = function globalCount() {
    // We want to cache the results of this
    var cache = (function calc() {
        var i,
          count = 0;

        for (i in window) {
          count++;
        }

        return count;
      }());

    api.globalCount = function () { return cache; };
    return cache;
  };

  api.fingerprint = function browserPrint() {
    return pad((navigator.mimeTypes.length +
      navigator.userAgent.length).toString(36) +
      api.globalCount().toString(36), 4);
  };

  // don't change anything from here down.
  if (app.register) {
    app.register(namespace, api);
  } else if (typeof module !== 'undefined') {
    module.exports = api;
  } else {
    app[namespace] = api;
  }

}(this.applitude || this));

},{}],38:[function(require,module,exports){
'use strict'

var Buffer = require('safe-buffer').Buffer

function encode (buf) {
  if (typeof buf === 'string') return encode(decode(buf))
  if (!Buffer.isBuffer(buf)) throw new Error('Not a buffer')
  if (buf.length !== 32) throw new Error('Invalid buffer')
  return buf.toString('hex')
}

function decode (str) {
  if (Buffer.isBuffer(str)) return decode(encode(str))
  if (typeof str !== 'string') throw new Error('Not a string')
  // looking for an hexa string of 64 or 65 consecutive chars
  var match = /([a-f0-9]{64,65})/i.exec(str)
  // we need exactly 64, so an hexa string with 65 chars (or more) is not allowed
  if (!match || match[1].length !== 64) throw new Error('Invalid key')
  return Buffer.from(match[1], 'hex')
}

exports.encode = exports.toStr = encode
exports.decode = exports.toBuf = decode

},{"safe-buffer":120}],39:[function(require,module,exports){
(function (process){
const EventEmitter = require('events').EventEmitter
const parallel = require('run-parallel')
const encoding = require('dat-encoding')
const RAW = require('random-access-web')
const RAM = require('random-access-memory')
const DiscoverySwarmWeb = require('discovery-swarm-web')
const crypto = require('hypercore-crypto')
const hypercoreProtocol = require('hypercore-protocol')
const hyperdrive = require('hyperdrive')

const DAT_PROTOCOL = 'dat://'
const STORAGE_NAME = 'dats'
const STORAGE_COLLECTION_NAME = `files`

module.exports =

/**
 * The Dat object. Manages multiple archives in
 * a single discovery-swarm-web instance.
 * @param {Object} opts   Default options to use for the dat.
 */
class Dat extends EventEmitter {
  constructor (opts) {
    super()
    this.opts = opts || {}

    if (!this.opts.id) this.opts.id = crypto.randomBytes(32)

    this.archives = []

    const discoveryOpts = Object.assign({
      stream: (info) => this._replicate(info)
    }, this.opts)
    this.swarm = new DiscoverySwarmWeb(discoveryOpts)

    const storageOpts = Object.assign({
      name: STORAGE_NAME,
      storeName: STORAGE_COLLECTION_NAME
    }, this.opts)
    this.persistence = RAW(storageOpts)
  }

  /**
   * Returns a archive with the given url.
   * @param  {url} url      The url of the archive.
   * @return {hyperdrive}  The archive object with the corresponding url.
   */
  get (url, opts) {
    const key = encoding.decode(url)
    const normalizedURL = `dat://${encoding.encode(key)}`
    const archive = this.archives.find((archive) => archive.url === normalizedURL)
    if (archive) return archive
    return this._add(normalizedURL, opts)
  }

  _add (url, opts) {
    if (this.destroyed) throw new Error('client is destroyed')
    if (!opts) opts = {}
    const finalOpts = Object.assign({}, this.opts, opts)

    let key = null

    if (url) key = encoding.decode(url)

    // If no key was provided, generate one
    if (!key) {
      const keyPair = crypto.keyPair()
      key = keyPair.publicKey
      finalOpts.secretKey = keyPair.secretKey
    }

    const keyString = encoding.encode(key)

    const rawStorage = finalOpts.db || (finalOpts.persist ? this.persistence : RAM)
    const storage = (file) => {
      return rawStorage(keyString + '/' + file)
    }
    const archive = hyperdrive(storage, key, Object.assign({
      sparse: true
    }, finalOpts))

    archive.url = DAT_PROTOCOL + keyString

    this.archives.push(archive)

    archive.ready(() => {
      this.swarm.join(archive.discoveryKey)
      this.emit('archive', archive)
    })

    return archive
  }

  create (opts) {
    return this._add(null, opts)
  }

  has (url) {
    const key = encoding.decode(url)
    const normalizedURL = `dat://${encoding.encode(key)}`
    return !!this.archives.find((archive) => archive.url === normalizedURL)
  }

  _replicate (info) {
    console.log('Replicating', info)
    var stream = hypercoreProtocol({
      id: this.opts.id,
      live: true,
      encrypt: true,
    })

    stream.on('feed', (discoveryKey) => this._replicateFeed(stream, discoveryKey))

    stream.on('error', (e) => {
      this.emit('replication-error', e)
    })

    if (info.channel) {
      this._replicateFeed(stream, info.channel)
    }

    return stream
  }

  _replicateFeed (stream, discoveryKey) {
    console.log('Replicating feed', discoveryKey)
    if (this.destroyed) {
      stream.end()
      return
    }
    const stringKey = encoding.encode(discoveryKey)
    const archive = this.archives.find((archive) => {
      return encoding.encode(archive.discoveryKey) === stringKey
    })

    if (!archive) return

    archive.replicate({ stream, live: true })
  }

  /**
   * Closes the the swarm, and all underlying hyperdrive instances.
   */
  close (cb) {
    if (this.destroyed) {
      if (cb) process.nextTick(cb)
      return
    }
    this.destroyed = true
    this.swarm.close()

    if (cb) this.once('close', cb)

    parallel(this.archives.map((archive) => {
      return (cb) => {
        archive.close(cb)
      }
    }), () => {
      this.archives = null
      this.emit('close')
    })
  }

  destroy (cb) {
    this.close(cb)
  }
}

}).call(this,require('_process'))
},{"_process":94,"dat-encoding":38,"discovery-swarm-web":46,"events":27,"hypercore-crypto":53,"hypercore-protocol":55,"hyperdrive":65,"random-access-memory":102,"random-access-web":104,"run-parallel":119}],40:[function(require,module,exports){
(function (process){
/**
 * This is the web browser implementation of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = require('./debug');
exports.log = log;
exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = 'undefined' != typeof chrome
               && 'undefined' != typeof chrome.storage
                  ? chrome.storage.local
                  : localstorage();

/**
 * Colors.
 */

exports.colors = [
  'lightseagreen',
  'forestgreen',
  'goldenrod',
  'dodgerblue',
  'darkorchid',
  'crimson'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

function useColors() {
  // NB: In an Electron preload script, document will be defined but not fully
  // initialized. Since we know we're in Chrome, we'll just detect this case
  // explicitly
  if (typeof window !== 'undefined' && window.process && window.process.type === 'renderer') {
    return true;
  }

  // is webkit? http://stackoverflow.com/a/16459606/376773
  // document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
  return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
    // is firebug? http://stackoverflow.com/a/398120/376773
    (typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
    // is firefox >= v31?
    // https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
    // double check webkit in userAgent just in case we are in a worker
    (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

exports.formatters.j = function(v) {
  try {
    return JSON.stringify(v);
  } catch (err) {
    return '[UnexpectedJSONParseError]: ' + err.message;
  }
};


/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
  var useColors = this.useColors;

  args[0] = (useColors ? '%c' : '')
    + this.namespace
    + (useColors ? ' %c' : ' ')
    + args[0]
    + (useColors ? '%c ' : ' ')
    + '+' + exports.humanize(this.diff);

  if (!useColors) return;

  var c = 'color: ' + this.color;
  args.splice(1, 0, c, 'color: inherit')

  // the final "%c" is somewhat tricky, because there could be other
  // arguments passed either before or after the %c, so we need to
  // figure out the correct index to insert the CSS into
  var index = 0;
  var lastC = 0;
  args[0].replace(/%[a-zA-Z%]/g, function(match) {
    if ('%%' === match) return;
    index++;
    if ('%c' === match) {
      // we only are interested in the *last* %c
      // (the user may have provided their own)
      lastC = index;
    }
  });

  args.splice(lastC, 0, c);
}

/**
 * Invokes `console.log()` when available.
 * No-op when `console.log` is not a "function".
 *
 * @api public
 */

function log() {
  // this hackery is required for IE8/9, where
  // the `console.log` function doesn't have 'apply'
  return 'object' === typeof console
    && console.log
    && Function.prototype.apply.call(console.log, console, arguments);
}

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */

function save(namespaces) {
  try {
    if (null == namespaces) {
      exports.storage.removeItem('debug');
    } else {
      exports.storage.debug = namespaces;
    }
  } catch(e) {}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */

function load() {
  var r;
  try {
    r = exports.storage.debug;
  } catch(e) {}

  // If debug isn't set in LS, and we're in Electron, try to load $DEBUG
  if (!r && typeof process !== 'undefined' && 'env' in process) {
    r = process.env.DEBUG;
  }

  return r;
}

/**
 * Enable namespaces listed in `localStorage.debug` initially.
 */

exports.enable(load());

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
  try {
    return window.localStorage;
  } catch (e) {}
}

}).call(this,require('_process'))
},{"./debug":41,"_process":94}],41:[function(require,module,exports){

/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 *
 * Expose `debug()` as the module.
 */

exports = module.exports = createDebug.debug = createDebug['default'] = createDebug;
exports.coerce = coerce;
exports.disable = disable;
exports.enable = enable;
exports.enabled = enabled;
exports.humanize = require('ms');

/**
 * The currently active debug mode names, and names to skip.
 */

exports.names = [];
exports.skips = [];

/**
 * Map of special "%n" handling functions, for the debug "format" argument.
 *
 * Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
 */

exports.formatters = {};

/**
 * Previous log timestamp.
 */

var prevTime;

/**
 * Select a color.
 * @param {String} namespace
 * @return {Number}
 * @api private
 */

function selectColor(namespace) {
  var hash = 0, i;

  for (i in namespace) {
    hash  = ((hash << 5) - hash) + namespace.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }

  return exports.colors[Math.abs(hash) % exports.colors.length];
}

/**
 * Create a debugger with the given `namespace`.
 *
 * @param {String} namespace
 * @return {Function}
 * @api public
 */

function createDebug(namespace) {

  function debug() {
    // disabled?
    if (!debug.enabled) return;

    var self = debug;

    // set `diff` timestamp
    var curr = +new Date();
    var ms = curr - (prevTime || curr);
    self.diff = ms;
    self.prev = prevTime;
    self.curr = curr;
    prevTime = curr;

    // turn the `arguments` into a proper Array
    var args = new Array(arguments.length);
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i];
    }

    args[0] = exports.coerce(args[0]);

    if ('string' !== typeof args[0]) {
      // anything else let's inspect with %O
      args.unshift('%O');
    }

    // apply any `formatters` transformations
    var index = 0;
    args[0] = args[0].replace(/%([a-zA-Z%])/g, function(match, format) {
      // if we encounter an escaped % then don't increase the array index
      if (match === '%%') return match;
      index++;
      var formatter = exports.formatters[format];
      if ('function' === typeof formatter) {
        var val = args[index];
        match = formatter.call(self, val);

        // now we need to remove `args[index]` since it's inlined in the `format`
        args.splice(index, 1);
        index--;
      }
      return match;
    });

    // apply env-specific formatting (colors, etc.)
    exports.formatArgs.call(self, args);

    var logFn = debug.log || exports.log || console.log.bind(console);
    logFn.apply(self, args);
  }

  debug.namespace = namespace;
  debug.enabled = exports.enabled(namespace);
  debug.useColors = exports.useColors();
  debug.color = selectColor(namespace);

  // env-specific initialization logic for debug instances
  if ('function' === typeof exports.init) {
    exports.init(debug);
  }

  return debug;
}

/**
 * Enables a debug mode by namespaces. This can include modes
 * separated by a colon and wildcards.
 *
 * @param {String} namespaces
 * @api public
 */

function enable(namespaces) {
  exports.save(namespaces);

  exports.names = [];
  exports.skips = [];

  var split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
  var len = split.length;

  for (var i = 0; i < len; i++) {
    if (!split[i]) continue; // ignore empty strings
    namespaces = split[i].replace(/\*/g, '.*?');
    if (namespaces[0] === '-') {
      exports.skips.push(new RegExp('^' + namespaces.substr(1) + '$'));
    } else {
      exports.names.push(new RegExp('^' + namespaces + '$'));
    }
  }
}

/**
 * Disable debug output.
 *
 * @api public
 */

function disable() {
  exports.enable('');
}

/**
 * Returns true if the given mode name is enabled, false otherwise.
 *
 * @param {String} name
 * @return {Boolean}
 * @api public
 */

function enabled(name) {
  var i, len;
  for (i = 0, len = exports.skips.length; i < len; i++) {
    if (exports.skips[i].test(name)) {
      return false;
    }
  }
  for (i = 0, len = exports.names.length; i < len; i++) {
    if (exports.names[i].test(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Coerce `val`.
 *
 * @param {Mixed} val
 * @return {Mixed}
 * @api private
 */

function coerce(val) {
  if (val instanceof Error) return val.stack || val.message;
  return val;
}

},{"ms":85}],42:[function(require,module,exports){
(function (Buffer){
var EventEmitter = require('events')

var DiscoverySwarmStream = require('./')
var ProxyStream = require('./proxystream')

/*
  Create map of [streamid] => [node stream]
  Emit handshaking event when getting the `open` event
  Emit the connection and connection-closed events
  Peer info objects look similar, but use `-1` for the port and use the ID to hex as the host. Initiator is always false. Type is `proxy`
*/

module.exports = class DiscoverySwarmClient extends EventEmitter {
  constructor (options) {
    super()
    var connection = options.connection
    if (!connection) throw new TypeError('Must specify `connection` in options')
    this.connecting = 0
    this.queued = 0
    this.connected = 0

    this._handleOpen = this._handleOpen.bind(this)
    this._handleEnd = this._handleEnd.bind(this)

    if (options.stream) {
      this._replicate = options.stream
    }

    this._channels = new Set()

    this.reconnect(connection)
  }

  reconnect (connection) {
    if (this._protocol) {
      this._protocol.removeListener('close', this._handleEnd)
      this._protocol.end()
    }
    this._protocol = new DiscoverySwarmStream(connection)
    this._protocol.on('swarm:open', this._handleOpen)
    this._protocol.connect()
    this._protocol.once('close', this._handleEnd)

    for (let key of this._channels) {
      this.join(key)
    }
  }

  _handleEnd () {
    this._protocol = null
    this.emit('disconnected')
  }

  _handleOpen (streamid, channel) {
    var stream = new ProxyStream(this._protocol, streamid)
    // Save locally
    var info = {
      type: 'proxy',
      initiator: false,
      id: null,
      host: streamid.toString('hex'),
      port: -1,
      channel: channel
    }

    var replicationStream = this._replicate(info)
    var self = this

    self.emit('handshaking', stream, info)

    replicationStream.once('handshake', function (remoteId) {
      if (remoteId) {
        var remoteIdHex = remoteId.toString('hex')
        info.id = remoteIdHex
      }
      self.emit('connection', stream, info)
    })

    replicationStream.pipe(stream).pipe(replicationStream)
  }

  join (key, options, cb) {
    if (typeof key === 'string') {
      key = Buffer.from(key, 'hex')
    }
    if (!cb && (typeof options === 'function')) {
      cb = options
    }
    this._protocol.join(key)

    this._channels.add(key.toString('hex'))
    if (cb) cb()
  }

  leave (key, cb) {
    if (typeof key === 'string') {
      key = Buffer.from(key, 'hex')
    }

    this._protocol.leave(key)

    this._channels.delete(key.toString('hex'))

    if (cb) cb()
  }

  listen () {
    // No-op, just in case
  }

  close (cb) {
    this._protocol.end(cb)
  }

  _replicate (info) {
    // TODO: Do the default handshake thing for replication
    throw new Error('Missing `stream` in options')
  }
}

}).call(this,require("buffer").Buffer)
},{"./":43,"./proxystream":45,"buffer":32,"events":27}],43:[function(require,module,exports){
var Duplex = require('readable-stream').Duplex
var lps = require('length-prefixed-stream')
var messages = require('./messages')

/*
Events:

`swarm:connect` Emitted when client connects to server, used to verify it's sane
`swarm:join` `(key)` Emitted by the client to get the server to join a swarm for the given key
`swarm:leave` `(key)` Emitted by the client to get the server to leave a swarm for the given key
`swarm:open` `(id, key)` Emitted by the server when a new peer is connected for a given key. The `id` is unique per peer, and `key` is the channel key
`swarm:close` `(id)` Emitted by the server when a peer's connection has closed.
`swarm:data` `(id, data)` Emtited by the server or the client when data is being sent down a stream
*/

module.exports = class DiscoverySwarmStream extends Duplex {
  constructor (stream) {
    super()

    // There's going to be a lot of listeners
    this.setMaxListeners(256)

    stream
      .pipe(lps.decode())
      .pipe(this)
      .pipe(lps.encode())
      .pipe(stream)
  }

  sendEvent (type, id, data) {
    this.push(messages.SwarmEvent.encode({
      type: messages.EventType[type],
      id: id,
      data: data
    }))
  }

  connect () {
    this.sendEvent('CONNECT')
  }

  join (discoveryKey) {
    this.sendEvent('JOIN', discoveryKey)
  }

  leave (discoveryKey) {
    this.sendEvent('LEAVE', discoveryKey)
  }

  openStream (streamId, channel) {
    this.sendEvent('OPEN', streamId, channel)
  }

  closeStream (streamId) {
    this.sendEvent('CLOSE', streamId)
  }

  streamData (streamId, data) {
    this.sendEvent('DATA', streamId, data)
  }

  _write (chunk, encoding, callback) {
    try {
      var decoded = messages.SwarmEvent.decode(chunk)
      switch (decoded.type) {
        case (messages.EventType.CONNECT): this.emit('swarm:connect'); break
        case (messages.EventType.JOIN): this.emit('swarm:join', decoded.id); break
        case (messages.EventType.LEAVE): this.emit('swarm:leave', decoded.id); break
        case (messages.EventType.OPEN): this.emit('swarm:open', decoded.id, decoded.data); break
        case (messages.EventType.CLOSE): this.emit('swarm:close', decoded.id); break
        case (messages.EventType.DATA) : this.emit('swarm:data', decoded.id, decoded.data); break
      }
      callback()
    } catch (e) {
      callback(e)
    }
  }

  _read () {}
}

},{"./messages":44,"length-prefixed-stream":79,"readable-stream":116}],44:[function(require,module,exports){
(function (Buffer){
// This file is auto generated by the protocol-buffers cli tool

/* eslint-disable quotes */
/* eslint-disable indent */
/* eslint-disable no-redeclare */
/* eslint-disable camelcase */

// Remember to `npm install --save protocol-buffers-encodings`
var encodings = require('protocol-buffers-encodings')
var varint = encodings.varint
var skip = encodings.skip

exports.EventType = {
  "CONNECT": 1,
  "JOIN": 2,
  "LEAVE": 3,
  "OPEN": 4,
  "CLOSE": 5,
  "DATA": 6
}

var SwarmEvent = exports.SwarmEvent = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

defineSwarmEvent()

function defineSwarmEvent () {
  var enc = [
    encodings.enum,
    encodings.bytes
  ]

  SwarmEvent.encodingLength = encodingLength
  SwarmEvent.encode = encode
  SwarmEvent.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.type)) throw new Error("type is required")
    var len = enc[0].encodingLength(obj.type)
    length += 1 + len
    if (defined(obj.id)) {
      var len = enc[1].encodingLength(obj.id)
      length += 1 + len
    }
    if (defined(obj.data)) {
      var len = enc[1].encodingLength(obj.data)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.type)) throw new Error("type is required")
    buf[offset++] = 8
    enc[0].encode(obj.type, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.id)) {
      buf[offset++] = 18
      enc[1].encode(obj.id, buf, offset)
      offset += enc[1].encode.bytes
    }
    if (defined(obj.data)) {
      buf[offset++] = 26
      enc[1].encode(obj.data, buf, offset)
      offset += enc[1].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      type: 1,
      id: null,
      data: null
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.type = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.id = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        case 3:
        obj.data = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defined (val) {
  return val !== null && val !== undefined && (typeof val !== 'number' || !isNaN(val))
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"protocol-buffers-encodings":95}],45:[function(require,module,exports){
var Duplex = require('readable-stream').Duplex

module.exports = class ProxyStream extends Duplex {
  constructor (protocol, id) {
    super()
    this._id = id
    this._protocol = protocol
    this._isClosed = false
    this._handle_data = this._handleData.bind(this)
    this._handle_close = this._handleClose.bind(this)

    this._protocol.on('swarm:data', this._handle_data)
    this._protocol.on('swarm:close', this._handle_close)
  }
  _handleData (streamid, data) {
    // See if the event was for this stream
    if (this._isId(streamid)) {
      this.push(data)
    }
  }
  _handleClose (streamid) {
    if (this._isId(streamid)) {
      this.end()
      this.emit('close')
      this._cleanup()
    }
  }
  _cleanup () {
    this._isClosed = true
    this._protocol.removeListener('swarm:data', this._handle_data)
    this._protocol.removeListener('swarm:close', this._handle_close)
  }
  _isId (streamid) {
    return streamid.toString('hex') === this._id.toString('hex')
  }
  _read () { }
  _write (chunk, encoding, callback) {
    this._protocol.streamData(this._id, chunk)
    callback()
  }
  _final (callback) {
    if (!this._isClosed) {
      this._protocol.closeStream(this._id)
      this._cleanup()
    }
    callback()
  }
}

},{"readable-stream":116}],46:[function(require,module,exports){
const signalhubws = require('signalhubws')
const webrtcSwarm = require('@geut/discovery-swarm-webrtc')
const DSS = require('discovery-swarm-stream/client')
const websocket = require('websocket-stream')
const randomBytes = require('randombytes')

const EventEmitter = require('events')

const DEFAULT_SIGNALHUB = ['wss://signalhubws.mauve.moe']
const DEFAULT_DISCOVERY = 'wss://discoveryswarm.mauve.moe'
const LOCALHOST_DISCOVERY = 'ws://localhost:3472'
const APP_NAME = 'discovery-swarm-web'
const DEFAULT_MAX_CONNECTIONS = Infinity
const JOIN_DELAY = 2000
const SYNC_NET_DELAY = 5000

// Check if the page was loaded from HTTPS
const IS_SECURE = self.location.href.startsWith('https')

module.exports = class DiscoverySwarmWeb extends EventEmitter {
  constructor (opts = {}) {
    super()
    const signalhubURL = opts.signalhub || DEFAULT_SIGNALHUB
    const discoveryURL = opts.discovery || DEFAULT_DISCOVERY

    const id = opts.id || randomBytes(32)
    const stream = opts.stream

    this.id = id
    this.stream = stream
    this.maxConnections = opts.maxConnections || DEFAULT_MAX_CONNECTIONS

    const isInstance = (typeof signalhubURL === 'object' && !Array.isArray(signalhubURL))
    const hub = isInstance
      ? signalhubURL : signalhubws(APP_NAME, signalhubURL.map(setSecure))

    this.channels = new Map()

    this.hub = hub

    this.webrtc = webrtcSwarm({
      id,
      stream,
      hub
    })

    this.dss = new DiscoverySwarmStreamWebsocket({
      id,
      stream,
      discovery: setSecure(discoveryURL)
    })

    this.webrtc.on('connection', (conn, info) => this._handleConnection(conn, info))
    this.dss.on('connection', (conn, info) => this._handleConnection(conn, info))
  }

  _handleConnection (connection, info) {
    const channelNameString = info.channel.toString('hex')
    const currentCount = this.channels.get(channelNameString)

    if (currentCount >= this.maxConnections) {
      connection.end()
    } else {
      this.channels.set(channelNameString, currentCount + 1)

      let hasClosed = false
      const handleClose = () => {
        if (hasClosed) return
        hasClosed = true
        if (!this.channels.has(channelNameString)) return
        const count = this.channels.get(channelNameString)
        this.channels.set(channelNameString, count - 1)
        if (!count) {
          this.leave(channelNameString)
          this.join(channelNameString)
        }
      }

      connection.once('close', handleClose)
      connection.once('error', handleClose)

      this.emit('connection', connection, info)
    }
  }

  join (channelName, opts = {}) {
    const channelNameString = channelName.toString('hex')

    if (this.channels.has(channelNameString)) return

    this.channels.set(channelNameString, 0)

    this.webrtc.join(channelName, opts)

    const joinDSS = () => {
      if (!this.channels.has(channelNameString)) return
      this.removeListener('connection', handleJoined)
      this.dss.join(channelName, opts)
    }

    const handleJoined = (connection, info) => {
      if (info.channel.toString('hex') !== channelNameString) return
      this.removeListener('connection', handleJoined)
      clearTimeout(connectTimer)
      connectTimer = setTimeout(joinDSS, SYNC_NET_DELAY)
    }

    // Wait a bit for WebRTC connections to come in before connecting to the gateway
    // This will make it more likely that any initial sync would happen over WebRTC
    let connectTimer = setTimeout(joinDSS, JOIN_DELAY)

    this.on('connection', handleJoined)
  }

  leave (channelName, opts = {}) {
    const channelNameString = channelName.toString('hex')

    if (!this.channels.has(channelNameString)) return

    this.channels.delete(channelNameString)

    this.webrtc.leave(channelName, opts)
    this.dss.leave(channelName, opts)
  }

  close (cb) {
    this.dss.close(() => {
      this.webrtc.close(cb)
    })
  }

  destroy (cb) {
    this.close(cb)
  }
}

class DiscoverySwarmStreamWebsocket extends DSS {
  constructor (opts) {
    const discovery = opts.discovery
    const stream = opts.stream
    const id = opts.id

    let connection = null
    try {
      connection = websocket(LOCALHOST_DISCOVERY)
    } catch(e) {
      console.error('Error creating socket to local discovery server', e)
      connection = websocket(discovery)
    }

    super({
      id,
      connection,
      stream
    })

    this._handleDisconnected = () => {
      this._reconnect()
    }
    this.discoveryURL = discovery

    connection.once('error', this._handleDisconnected)
    this.on('disconnected', this._handleDisconnected)
  }

  _reconnect () {
    const connection = websocket(this.discoveryURL)
    this.reconnect(connection)
  }

  close (cb) {
    this.removeListener('disconnected', this._handleDisconnected)
    super.close(cb)
  }
}

function setSecure (url) {
  if (IS_SECURE) {
    if (url.startsWith('http:')) {
      return 'https:' + url.slice(6)
    } else if (url.startsWith('ws:')) {
      return 'wss:' + url.slice(3)
    } else {
      return url
    }
  } else {
    if (url.startsWith('https:')) {
      return 'http:' + url.slice(7)
    } else if (url.startsWith('wss:')) {
      return 'ws:' + url.slice(4)
    } else {
      return url
    }
  }
}

},{"@geut/discovery-swarm-webrtc":5,"discovery-swarm-stream/client":42,"events":27,"randombytes":106,"signalhubws":121,"websocket-stream":157}],47:[function(require,module,exports){
(function (process,Buffer){
var stream = require('readable-stream')
var eos = require('end-of-stream')
var inherits = require('inherits')
var shift = require('stream-shift')

var SIGNAL_FLUSH = (Buffer.from && Buffer.from !== Uint8Array.from)
  ? Buffer.from([0])
  : new Buffer([0])

var onuncork = function(self, fn) {
  if (self._corked) self.once('uncork', fn)
  else fn()
}

var autoDestroy = function (self, err) {
  if (self._autoDestroy) self.destroy(err)
}

var destroyer = function(self, end) {
  return function(err) {
    if (err) autoDestroy(self, err.message === 'premature close' ? null : err)
    else if (end && !self._ended) self.end()
  }
}

var end = function(ws, fn) {
  if (!ws) return fn()
  if (ws._writableState && ws._writableState.finished) return fn()
  if (ws._writableState) return ws.end(fn)
  ws.end()
  fn()
}

var toStreams2 = function(rs) {
  return new (stream.Readable)({objectMode:true, highWaterMark:16}).wrap(rs)
}

var Duplexify = function(writable, readable, opts) {
  if (!(this instanceof Duplexify)) return new Duplexify(writable, readable, opts)
  stream.Duplex.call(this, opts)

  this._writable = null
  this._readable = null
  this._readable2 = null

  this._autoDestroy = !opts || opts.autoDestroy !== false
  this._forwardDestroy = !opts || opts.destroy !== false
  this._forwardEnd = !opts || opts.end !== false
  this._corked = 1 // start corked
  this._ondrain = null
  this._drained = false
  this._forwarding = false
  this._unwrite = null
  this._unread = null
  this._ended = false

  this.destroyed = false

  if (writable) this.setWritable(writable)
  if (readable) this.setReadable(readable)
}

inherits(Duplexify, stream.Duplex)

Duplexify.obj = function(writable, readable, opts) {
  if (!opts) opts = {}
  opts.objectMode = true
  opts.highWaterMark = 16
  return new Duplexify(writable, readable, opts)
}

Duplexify.prototype.cork = function() {
  if (++this._corked === 1) this.emit('cork')
}

Duplexify.prototype.uncork = function() {
  if (this._corked && --this._corked === 0) this.emit('uncork')
}

Duplexify.prototype.setWritable = function(writable) {
  if (this._unwrite) this._unwrite()

  if (this.destroyed) {
    if (writable && writable.destroy) writable.destroy()
    return
  }

  if (writable === null || writable === false) {
    this.end()
    return
  }

  var self = this
  var unend = eos(writable, {writable:true, readable:false}, destroyer(this, this._forwardEnd))

  var ondrain = function() {
    var ondrain = self._ondrain
    self._ondrain = null
    if (ondrain) ondrain()
  }

  var clear = function() {
    self._writable.removeListener('drain', ondrain)
    unend()
  }

  if (this._unwrite) process.nextTick(ondrain) // force a drain on stream reset to avoid livelocks

  this._writable = writable
  this._writable.on('drain', ondrain)
  this._unwrite = clear

  this.uncork() // always uncork setWritable
}

Duplexify.prototype.setReadable = function(readable) {
  if (this._unread) this._unread()

  if (this.destroyed) {
    if (readable && readable.destroy) readable.destroy()
    return
  }

  if (readable === null || readable === false) {
    this.push(null)
    this.resume()
    return
  }

  var self = this
  var unend = eos(readable, {writable:false, readable:true}, destroyer(this))

  var onreadable = function() {
    self._forward()
  }

  var onend = function() {
    self.push(null)
  }

  var clear = function() {
    self._readable2.removeListener('readable', onreadable)
    self._readable2.removeListener('end', onend)
    unend()
  }

  this._drained = true
  this._readable = readable
  this._readable2 = readable._readableState ? readable : toStreams2(readable)
  this._readable2.on('readable', onreadable)
  this._readable2.on('end', onend)
  this._unread = clear

  this._forward()
}

Duplexify.prototype._read = function() {
  this._drained = true
  this._forward()
}

Duplexify.prototype._forward = function() {
  if (this._forwarding || !this._readable2 || !this._drained) return
  this._forwarding = true

  var data

  while (this._drained && (data = shift(this._readable2)) !== null) {
    if (this.destroyed) continue
    this._drained = this.push(data)
  }

  this._forwarding = false
}

Duplexify.prototype.destroy = function(err) {
  if (this.destroyed) return
  this.destroyed = true

  var self = this
  process.nextTick(function() {
    self._destroy(err)
  })
}

Duplexify.prototype._destroy = function(err) {
  if (err) {
    var ondrain = this._ondrain
    this._ondrain = null
    if (ondrain) ondrain(err)
    else this.emit('error', err)
  }

  if (this._forwardDestroy) {
    if (this._readable && this._readable.destroy) this._readable.destroy()
    if (this._writable && this._writable.destroy) this._writable.destroy()
  }

  this.emit('close')
}

Duplexify.prototype._write = function(data, enc, cb) {
  if (this.destroyed) return cb()
  if (this._corked) return onuncork(this, this._write.bind(this, data, enc, cb))
  if (data === SIGNAL_FLUSH) return this._finish(cb)
  if (!this._writable) return cb()

  if (this._writable.write(data) === false) this._ondrain = cb
  else cb()
}

Duplexify.prototype._finish = function(cb) {
  var self = this
  this.emit('preend')
  onuncork(this, function() {
    end(self._forwardEnd && self._writable, function() {
      // haxx to not emit prefinish twice
      if (self._writableState.prefinished === false) self._writableState.prefinished = true
      self.emit('prefinish')
      onuncork(self, cb)
    })
  })
}

Duplexify.prototype.end = function(data, enc, cb) {
  if (typeof data === 'function') return this.end(null, null, data)
  if (typeof enc === 'function') return this.end(data, null, enc)
  this._ended = true
  if (data) this.write(data)
  if (!this._writableState.ending) this.write(SIGNAL_FLUSH)
  return stream.Writable.prototype.end.call(this, cb)
}

module.exports = Duplexify

}).call(this,require('_process'),require("buffer").Buffer)
},{"_process":94,"buffer":32,"end-of-stream":48,"inherits":71,"readable-stream":116,"stream-shift":139}],48:[function(require,module,exports){
var once = require('once');

var noop = function() {};

var isRequest = function(stream) {
	return stream.setHeader && typeof stream.abort === 'function';
};

var isChildProcess = function(stream) {
	return stream.stdio && Array.isArray(stream.stdio) && stream.stdio.length === 3
};

var eos = function(stream, opts, callback) {
	if (typeof opts === 'function') return eos(stream, null, opts);
	if (!opts) opts = {};

	callback = once(callback || noop);

	var ws = stream._writableState;
	var rs = stream._readableState;
	var readable = opts.readable || (opts.readable !== false && stream.readable);
	var writable = opts.writable || (opts.writable !== false && stream.writable);

	var onlegacyfinish = function() {
		if (!stream.writable) onfinish();
	};

	var onfinish = function() {
		writable = false;
		if (!readable) callback.call(stream);
	};

	var onend = function() {
		readable = false;
		if (!writable) callback.call(stream);
	};

	var onexit = function(exitCode) {
		callback.call(stream, exitCode ? new Error('exited with error code: ' + exitCode) : null);
	};

	var onerror = function(err) {
		callback.call(stream, err);
	};

	var onclose = function() {
		if (readable && !(rs && rs.ended)) return callback.call(stream, new Error('premature close'));
		if (writable && !(ws && ws.ended)) return callback.call(stream, new Error('premature close'));
	};

	var onrequest = function() {
		stream.req.on('finish', onfinish);
	};

	if (isRequest(stream)) {
		stream.on('complete', onfinish);
		stream.on('abort', onclose);
		if (stream.req) onrequest();
		else stream.on('request', onrequest);
	} else if (writable && !ws) { // legacy streams
		stream.on('end', onlegacyfinish);
		stream.on('close', onlegacyfinish);
	}

	if (isChildProcess(stream)) stream.on('exit', onexit);

	stream.on('end', onend);
	stream.on('finish', onfinish);
	if (opts.error !== false) stream.on('error', onerror);
	stream.on('close', onclose);

	return function() {
		stream.removeListener('complete', onfinish);
		stream.removeListener('abort', onclose);
		stream.removeListener('request', onrequest);
		if (stream.req) stream.req.removeListener('finish', onfinish);
		stream.removeListener('end', onlegacyfinish);
		stream.removeListener('close', onlegacyfinish);
		stream.removeListener('finish', onfinish);
		stream.removeListener('exit', onexit);
		stream.removeListener('end', onend);
		stream.removeListener('error', onerror);
		stream.removeListener('close', onclose);
	};
};

module.exports = eos;

},{"once":90}],49:[function(require,module,exports){
'use strict'

const ctz = require('count-trailing-zeros')

module.exports = () => new Bitfield()

class Page {
  constructor (level) {
    const buf = new Uint8Array(level ? 8456 : 4360)
    const b = buf.byteOffset

    this.buffer = buf
    this.bits = level ? null : new Uint32Array(buf.buffer, b, 1024)
    this.children = level ? new Array(32768) : null
    this.level = level

    this.allOne = level
      ? [
        new Uint32Array(buf.buffer, b, 1024),
        new Uint32Array(buf.buffer, b + 4096, 32),
        new Uint32Array(buf.buffer, b + 4224, 1)
      ]
      : [
        this.bits,
        new Uint32Array(buf.buffer, b + 4096, 32),
        new Uint32Array(buf.buffer, b + 4224, 1)
      ]

    this.oneOne = level
      ? [
        new Uint32Array(buf.buffer, b + 4228, 1024),
        new Uint32Array(buf.buffer, b + 8324, 32),
        new Uint32Array(buf.buffer, b + 8452, 1)
      ]
      : [
        this.bits,
        new Uint32Array(buf.buffer, b + 4228, 32),
        new Uint32Array(buf.buffer, b + 4356, 1)
      ]
  }
}

const ZEROS = [new Page(0), new Page(1), new Page(2), new Page(3)]
const MASK = new Uint32Array(32)
const MASK_INCL = new Uint32Array(32)

for (var i = 0; i < 32; i++) {
  MASK[i] = Math.pow(2, 31 - i) - 1
  MASK_INCL[i] = Math.pow(2, 32 - i) - 1
}

const LITTLE_ENDIAN = new Uint8Array(MASK.buffer, MASK.byteOffset, 1)[0] === 0xff

class Bitfield {
  constructor () {
    this.length = 32768
    this.littleEndian = LITTLE_ENDIAN

    this._path = new Uint16Array(5)
    this._offsets = new Uint16Array(this._path.buffer, this._path.byteOffset + 2, 4)
    this._parents = new Array(4).fill(null)
    this._page = new Page(0)
    this._allocs = 1
  }

  last () {
    var page = this._page
    var b = 0

    while (true) {
      for (var i = 2; i >= 0; i--) {
        const c = ctz(page.oneOne[i][b])
        if (c === 32) return -1
        b = (b << 5) + (31 - c)
      }

      this._path[page.level] = b
      if (!page.level) return defactor(this._path)
      page = page.children[b]
      b = 0
    }
  }

  set (index, bit) {
    const page = this._getPage(index, bit)
    if (!page) return false

    const i = this._path[0]
    const r = i & 31
    const b = i >>> 5
    const prev = page.bits[b]

    page.bits[b] = bit
      ? (prev | (0x80000000 >>> r))
      : (prev & ~(0x80000000 >>> r))

    const upd = page.bits[b]
    if (upd === prev) return false

    this._updateAllOne(page, b, upd)
    this._updateOneOne(page, b, upd)

    return true
  }

  get (index) {
    const page = this._getPage(index, false)
    if (!page) return false

    const i = this._path[0]
    const r = i & 31

    return (page.bits[i >>> 5] & (0x80000000 >>> r)) !== 0
  }

  iterator () {
    return new Iterator(this)
  }

  fill (val, start, end) {
    if (!start) start = 0
    if (val === true) return this._fillBit(true, start, end === 0 ? end : (end || this.length))
    if (val === false) return this._fillBit(false, start, end === 0 ? end : (end || this.length))
    this._fillBuffer(val, start, end === 0 ? end : (end || (start + 8 * val.length)))
  }

  grow () {
    if (this._page.level === 3) throw new Error('Cannot grow beyond ' + this.length)
    const page = this._page
    this._page = new Page(page.level + 1)
    this._page.children[0] = page
    if (this._page.level === 3) this.length = Number.MAX_SAFE_INTEGER
    else this.length *= 32768
  }

  _fillBuffer (buf, start, end) {
    if ((start & 7) || (end & 7)) throw new Error('Offsets must be a multiple of 8')

    start /= 8
    while (end > this.length) this.grow()
    end /= 8

    const offset = start
    var page = this._getPage(8 * start, true)

    while (start < end) {
      const delta = end - start < 4096 ? end - start : 4096
      const s = start - offset

      start += this._setPageBuffer(page, buf.subarray(s, s + delta), start & 1023)
      if (start !== end) page = this._nextPage(page, 8 * start)
    }
  }

  _fillBit (bit, start, end) {
    var page = this._getPage(start, bit)

    // TODO: this can be optimised a lot in the case of end - start > 32768
    // in that case clear levels of 32768 ** 2 instead etc

    while (start < end) {
      const delta = end - start < 32768 ? end - start : 32768
      start += this._setPageBits(page, bit, start & 32767, delta)
      if (start !== end) page = this._nextPage(page, start)
    }
  }

  _nextPage (page, start) {
    const i = ++this._offsets[page.level]
    return i === 32768
      ? this._getPage(start, true)
      : this._parents[page.level].children[i] || this._addPage(this._parents[page.level], i)
  }

  _setPageBuffer (page, buf, start) {
    new Uint8Array(page.bits.buffer, page.bits.byteOffset, page.bits.length * 4).set(buf, start)
    start >>>= 2
    this._update(page, start, start + (buf.length >>> 2) + (buf.length & 3 ? 1 : 0))
    return buf.length
  }

  _setPageBits (page, bit, start, end) {
    const s = start >>> 5
    const e = end >>> 5
    const sm = 0xffffffff >>> (start & 31)
    const em = ~(0xffffffff >>> (end & 31))

    if (s === e) {
      page.bits[s] = bit
        ? page.bits[s] | (sm & em)
        : page.bits[s] & ~(sm & em)
      this._update(page, s, s + 1)
      return end - start
    }

    page.bits[s] = bit
      ? page.bits[s] | sm
      : page.bits[s] & (~sm)

    if (e - s > 2) page.bits.fill(bit ? 0xffffffff : 0, s + 1, e - 1)

    if (e === 1024) {
      page.bits[e - 1] = bit ? 0xffffffff : 0
      this._update(page, s, e)
      return end - start
    }

    page.bits[e] = bit
      ? page.bits[e] | em
      : page.bits[e] & (~em)

    this._update(page, s, e + 1)
    return end - start
  }

  _update (page, start, end) {
    for (; start < end; start++) {
      const upd = page.bits[start]
      this._updateAllOne(page, start, upd)
      this._updateOneOne(page, start, upd)
    }
  }

  _updateAllOne (page, b, upd) {
    var i = 1

    do {
      for (; i < 3; i++) {
        const buf = page.allOne[i]
        const r = b & 31
        const prev = buf[b >>>= 5]
        buf[b] = upd === 0xffffffff
          ? (prev | (0x80000000 >>> r))
          : (prev & ~(0x80000000 >>> r))
        upd = buf[b]
        if (upd === prev) return
      }

      b += this._offsets[page.level]
      page = this._parents[page.level]
      i = 0
    } while (page)
  }

  _updateOneOne (page, b, upd) {
    var i = 1

    do {
      for (; i < 3; i++) {
        const buf = page.oneOne[i]
        const r = b & 31
        const prev = buf[b >>>= 5]
        buf[b] = upd !== 0
          ? (prev | (0x80000000 >>> r))
          : (prev & ~(0x80000000 >>> r))
        upd = buf[b]
        if (upd === prev) return
      }

      b += this._offsets[page.level]
      page = this._parents[page.level]
      i = 0

      if (upd === 0 && page) {
        // all zeros, non root -> free page
        page.children[this._offsets[page.level - 1]] = undefined
      }
    } while (page)
  }

  _getPage (index, createIfMissing) {
    factor(index, this._path)

    while (index >= this.length) {
      if (!createIfMissing) return null
      this.grow()
    }

    var page = this._page

    for (var i = page.level; i > 0 && page; i--) {
      const p = this._path[i]
      this._parents[i - 1] = page
      page = page.children[p] || (createIfMissing ? this._addPage(page, p) : null)
    }

    return page
  }

  _addPage (page, i) {
    this._allocs++
    page = page.children[i] = new Page(page.level - 1)
    return page
  }
}

class Iterator {
  constructor (bitfield) {
    this._bitfield = bitfield
    this._path = new Uint16Array(5)
    this._offsets = new Uint16Array(this._path.buffer, this._path.byteOffset + 2, 4)
    this._parents = new Array(4).fill(null)
    this._page = null
    this._allocs = bitfield._allocs

    this.seek(0)
  }

  seek (index) {
    this._allocs = this._bitfield._allocs

    if (index >= this._bitfield.length) {
      this._page = null
      return this
    }

    factor(index, this._path)

    this._page = this._bitfield._page
    for (var i = this._page.level; i > 0; i--) {
      this._parents[i - 1] = this._page
      this._page = this._page.children[this._path[i]] || ZEROS[i - 1]
    }

    return this
  }

  next (bit) {
    return bit ? this.nextTrue() : this.nextFalse()
  }

  nextFalse () {
    if (this._allocs !== this._bitfield._allocs) {
      // If a page has been alloced while we are iterating
      // and we have a zero page in our path we need to reseek
      // in case that page has been overwritten
      this.seek(defactor(this._path))
    }

    var page = this._page
    var b = this._path[0]
    var mask = MASK_INCL

    while (page) {
      for (var i = 0; i < 3; i++) {
        const r = b & 31
        const clz = Math.clz32((~page.allOne[i][b >>>= 5]) & mask[r])
        if (clz !== 32) return this._downLeftFalse(page, i, b, clz)
        mask = MASK
      }

      b = this._offsets[page.level]
      page = this._parents[page.level]
    }

    return -1
  }

  _downLeftFalse (page, i, b, clz) {
    while (true) {
      while (i) {
        b = (b << 5) + clz
        clz = Math.clz32(~page.allOne[--i][b])
      }

      b = (b << 5) + clz

      if (!page.level) break

      this._parents[page.level - 1] = page
      this._path[page.level] = b

      page = page.children[b]
      i = 3
      clz = b = 0
    }

    this._page = page
    this._path[0] = b

    return this._inc()
  }

  nextTrue () {
    var page = this._page
    var b = this._path[0]
    var mask = MASK_INCL

    while (page) {
      for (var i = 0; i < 3; i++) {
        const r = b & 31
        const clz = Math.clz32(page.oneOne[i][b >>>= 5] & mask[r])
        if (clz !== 32) return this._downLeftTrue(page, i, b, clz)
        mask = MASK
      }

      b = this._offsets[page.level]
      page = this._parents[page.level]
    }

    return -1
  }

  _downLeftTrue (page, i, b, clz) {
    while (true) {
      while (i) {
        b = (b << 5) + clz
        clz = Math.clz32(page.oneOne[--i][b])
      }

      b = (b << 5) + clz

      if (!page.level) break

      this._parents[page.level - 1] = page
      this._path[page.level] = b

      page = page.children[b]
      i = 3
      clz = b = 0
    }

    this._page = page
    this._path[0] = b

    return this._inc()
  }

  _inc () {
    const n = defactor(this._path)
    if (this._path[0] < 32767) this._path[0]++
    else this.seek(n + 1)
    return n
  }
}

function defactor (out) {
  return ((((out[3] * 32768 + out[2]) * 32768) + out[1]) * 32768) + out[0]
}

function factor (n, out) {
  n = (n - (out[0] = (n & 32767))) / 32768
  n = (n - (out[1] = (n & 32767))) / 32768
  out[3] = ((n - (out[2] = (n & 32767))) / 32768) & 32767
}

},{"count-trailing-zeros":36}],50:[function(require,module,exports){
exports.fullRoots = function (index, result) {
  if (index & 1) throw new Error('You can only look up roots for depth(0) blocks')
  if (!result) result = []

  index /= 2

  var offset = 0
  var factor = 1

  while (true) {
    if (!index) return result
    while (factor * 2 <= index) factor *= 2
    result.push(offset + factor - 1)
    offset = offset + 2 * factor
    index -= factor
    factor = 1
  }
}

exports.depth = function (index) {
  var depth = 0

  index += 1
  while (!(index & 1)) {
    depth++
    index = rightShift(index)
  }

  return depth
}

exports.sibling = function (index, depth) {
  if (!depth) depth = exports.depth(index)
  var offset = exports.offset(index, depth)

  return exports.index(depth, offset & 1 ? offset - 1 : offset + 1)
}

exports.parent = function (index, depth) {
  if (!depth) depth = exports.depth(index)
  var offset = exports.offset(index, depth)

  return exports.index(depth + 1, rightShift(offset))
}

exports.leftChild = function (index, depth) {
  if (!(index & 1)) return -1
  if (!depth) depth = exports.depth(index)
  return exports.index(depth - 1, exports.offset(index, depth) * 2)
}

exports.rightChild = function (index, depth) {
  if (!(index & 1)) return -1
  if (!depth) depth = exports.depth(index)
  return exports.index(depth - 1, 1 + (exports.offset(index, depth) * 2))
}

exports.children = function (index, depth) {
  if (!(index & 1)) return null

  if (!depth) depth = exports.depth(index)
  var offset = exports.offset(index, depth) * 2

  return [
    exports.index(depth - 1, offset),
    exports.index(depth - 1, offset + 1)
  ]
}

exports.leftSpan = function (index, depth) {
  if (!(index & 1)) return index
  if (!depth) depth = exports.depth(index)
  return exports.offset(index, depth) * twoPow(depth + 1)
}

exports.rightSpan = function (index, depth) {
  if (!(index & 1)) return index
  if (!depth) depth = exports.depth(index)
  return (exports.offset(index, depth) + 1) * twoPow(depth + 1) - 2
}

exports.count = function (index, depth) {
  if (!(index & 1)) return 1
  if (!depth) depth = exports.depth(index)
  return twoPow(depth + 1) - 1
}

exports.spans = function (index, depth) {
  if (!(index & 1)) return [index, index]
  if (!depth) depth = exports.depth(index)

  var offset = exports.offset(index, depth)
  var width = twoPow(depth + 1)

  return [offset * width, (offset + 1) * width - 2]
}

exports.index = function (depth, offset) {
  return (1 + 2 * offset) * twoPow(depth) - 1
}

exports.offset = function (index, depth) {
  if (!(index & 1)) return index / 2
  if (!depth) depth = exports.depth(index)

  return ((index + 1) / twoPow(depth) - 1) / 2
}

exports.iterator = function (index) {
  var ite = new Iterator()
  ite.seek(index || 0)
  return ite
}

function twoPow (n) {
  return n < 31 ? 1 << n : ((1 << 30) * (1 << (n - 30)))
}

function rightShift (n) {
  return (n - (n & 1)) / 2
}

function Iterator (index) {
  this.index = 0
  this.offset = 0
  this.factor = 0
}

Iterator.prototype.seek = function (index) {
  this.index = index
  if (this.index & 1) {
    this.offset = exports.offset(index)
    this.factor = twoPow(exports.depth(index) + 1)
  } else {
    this.offset = index / 2
    this.factor = 2
  }
}

Iterator.prototype.isLeft = function () {
  return !(this.offset & 1)
}

Iterator.prototype.isRight = function () {
  return !this.isLeft()
}

Iterator.prototype.prev = function () {
  if (!this.offset) return this.index
  this.offset--
  this.index -= this.factor
  return this.index
}

Iterator.prototype.next = function () {
  this.offset++
  this.index += this.factor
  return this.index
}

Iterator.prototype.sibling = function () {
  return this.isLeft() ? this.next() : this.prev()
}

Iterator.prototype.parent = function () {
  if (this.offset & 1) {
    this.index -= this.factor / 2
    this.offset = (this.offset - 1) / 2
  } else {
    this.index += this.factor / 2
    this.offset /= 2
  }
  this.factor *= 2
  return this.index
}

Iterator.prototype.leftSpan = function () {
  this.index = this.index - this.factor / 2 + 1
  this.offset = this.index / 2
  this.factor = 2
  return this.index
}

Iterator.prototype.rightSpan = function () {
  this.index = this.index + this.factor / 2 - 1
  this.offset = this.index / 2
  this.factor = 2
  return this.index
}

Iterator.prototype.leftChild = function () {
  if (this.factor === 2) return this.index
  this.factor /= 2
  this.index -= this.factor / 2
  this.offset *= 2
  return this.index
}

Iterator.prototype.rightChild = function () {
  if (this.factor === 2) return this.index
  this.factor /= 2
  this.index += this.factor / 2
  this.offset = 2 * this.offset + 1
  return this.index
}

},{}],51:[function(require,module,exports){
(function (process){
var Readable = require('readable-stream').Readable
var inherits = require('inherits')

module.exports = from2

from2.ctor = ctor
from2.obj = obj

var Proto = ctor()

function toFunction(list) {
  list = list.slice()
  return function (_, cb) {
    var err = null
    var item = list.length ? list.shift() : null
    if (item instanceof Error) {
      err = item
      item = null
    }

    cb(err, item)
  }
}

function from2(opts, read) {
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    read = opts
    opts = {}
  }

  var rs = new Proto(opts)
  rs._from = Array.isArray(read) ? toFunction(read) : (read || noop)
  return rs
}

function ctor(opts, read) {
  if (typeof opts === 'function') {
    read = opts
    opts = {}
  }

  opts = defaults(opts)

  inherits(Class, Readable)
  function Class(override) {
    if (!(this instanceof Class)) return new Class(override)
    this._reading = false
    this._callback = check
    this.destroyed = false
    Readable.call(this, override || opts)

    var self = this
    var hwm = this._readableState.highWaterMark

    function check(err, data) {
      if (self.destroyed) return
      if (err) return self.destroy(err)
      if (data === null) return self.push(null)
      self._reading = false
      if (self.push(data)) self._read(hwm)
    }
  }

  Class.prototype._from = read || noop
  Class.prototype._read = function(size) {
    if (this._reading || this.destroyed) return
    this._reading = true
    this._from(size, this._callback)
  }

  Class.prototype.destroy = function(err) {
    if (this.destroyed) return
    this.destroyed = true

    var self = this
    process.nextTick(function() {
      if (err) self.emit('error', err)
      self.emit('close')
    })
  }

  return Class
}

function obj(opts, read) {
  if (typeof opts === 'function' || Array.isArray(opts)) {
    read = opts
    opts = {}
  }

  opts = defaults(opts)
  opts.objectMode = true
  opts.highWaterMark = 16

  return from2(opts, read)
}

function noop () {}

function defaults(opts) {
  opts = opts || {}
  return opts
}

}).call(this,require('_process'))
},{"_process":94,"inherits":71,"readable-stream":116}],52:[function(require,module,exports){
// originally pulled out of simple-peer

module.exports = function getBrowserRTC () {
  if (typeof window === 'undefined') return null
  var wrtc = {
    RTCPeerConnection: window.RTCPeerConnection || window.mozRTCPeerConnection ||
      window.webkitRTCPeerConnection,
    RTCSessionDescription: window.RTCSessionDescription ||
      window.mozRTCSessionDescription || window.webkitRTCSessionDescription,
    RTCIceCandidate: window.RTCIceCandidate || window.mozRTCIceCandidate ||
      window.webkitRTCIceCandidate
  }
  if (!wrtc.RTCPeerConnection) return null
  return wrtc
}

},{}],53:[function(require,module,exports){
var sodium = require('sodium-universal')
var uint64be = require('uint64be')
var bufferFrom = require('buffer-from')
var bufferAlloc = require('buffer-alloc-unsafe')

// https://en.wikipedia.org/wiki/Merkle_tree#Second_preimage_attack
var LEAF_TYPE = bufferFrom([0])
var PARENT_TYPE = bufferFrom([1])
var ROOT_TYPE = bufferFrom([2])
var HYPERCORE = bufferFrom('hypercore')

exports.keyPair = function (seed) {
  var publicKey = bufferAlloc(sodium.crypto_sign_PUBLICKEYBYTES)
  var secretKey = bufferAlloc(sodium.crypto_sign_SECRETKEYBYTES)

  if (seed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  else sodium.crypto_sign_keypair(publicKey, secretKey)

  return {
    publicKey: publicKey,
    secretKey: secretKey
  }
}

exports.sign = function (message, secretKey) {
  var signature = bufferAlloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(signature, message, secretKey)
  return signature
}

exports.verify = function (message, signature, publicKey) {
  return sodium.crypto_sign_verify_detached(signature, message, publicKey)
}

exports.data = function (data) {
  return blake2b([
    LEAF_TYPE,
    encodeUInt64(data.length),
    data
  ])
}

exports.leaf = function (leaf) {
  return exports.data(leaf.data)
}

exports.parent = function (a, b) {
  if (a.index > b.index) {
    var tmp = a
    a = b
    b = tmp
  }

  return blake2b([
    PARENT_TYPE,
    encodeUInt64(a.size + b.size),
    a.hash,
    b.hash
  ])
}

exports.tree = function (roots) {
  var buffers = new Array(3 * roots.length + 1)
  var j = 0

  buffers[j++] = ROOT_TYPE

  for (var i = 0; i < roots.length; i++) {
    var r = roots[i]
    buffers[j++] = r.hash
    buffers[j++] = encodeUInt64(r.index)
    buffers[j++] = encodeUInt64(r.size)
  }

  return blake2b(buffers)
}

exports.randomBytes = function (n) {
  var buf = bufferAlloc(n)
  sodium.randombytes_buf(buf)
  return buf
}

exports.discoveryKey = function (tree) {
  var digest = bufferAlloc(32)
  sodium.crypto_generichash(digest, HYPERCORE, tree)
  return digest
}

function encodeUInt64 (n) {
  return uint64be.encode(n, bufferAlloc(8))
}

function blake2b (buffers) {
  var digest = bufferAlloc(32)
  sodium.crypto_generichash_batch(digest, buffers)
  return digest
}

},{"buffer-alloc-unsafe":28,"buffer-from":31,"sodium-universal":134,"uint64be":146}],54:[function(require,module,exports){
(function (process){
var events = require('events')
var inherits = require('inherits')
var varint = require('varint')
var messages = require('./messages')
var bufferAlloc = require('buffer-alloc-unsafe')

module.exports = Feed

function Feed (stream) {
  if (!(this instanceof Feed)) return new Feed(stream)
  events.EventEmitter.call(this)

  this.key = null
  this.discoveryKey = null
  this.stream = stream
  this.peer = null // support a peer object to avoid event emitter + closures overhead

  this.id = -1
  this.remoteId = -1
  this.header = 0
  this.headerLength = 0
  this.closed = false

  this._buffer = []
}

inherits(Feed, events.EventEmitter)

Feed.prototype.handshake = function (message) {
  return this._send(1, messages.Handshake, message)
}

Feed.prototype.info = function (message) {
  return this._send(2, messages.Info, message)
}

Feed.prototype.have = function (message) {
  return this._send(3, messages.Have, message)
}

Feed.prototype.unhave = function (message) {
  return this._send(4, messages.Unhave, message)
}

Feed.prototype.want = function (message) {
  return this._send(5, messages.Want, message)
}

Feed.prototype.unwant = function (message) {
  return this._send(6, messages.Unwant, message)
}

Feed.prototype.request = function (message) {
  return this._send(7, messages.Request, message)
}

Feed.prototype.cancel = function (message) {
  return this._send(8, messages.Cancel, message)
}

Feed.prototype.data = function (message) {
  return this._send(9, messages.Data, message)
}

Feed.prototype.extension = function (type, message) {
  var id = this.stream.extensions.indexOf(type)
  if (id === -1) return false

  var header = this.header | 15
  var len = this.headerLength + varint.encodingLength(id) + message.length
  var box = bufferAlloc(varint.encodingLength(len) + len)
  var offset = 0

  varint.encode(len, box, offset)
  offset += varint.encode.bytes

  varint.encode(header, box, offset)
  offset += varint.encode.bytes

  varint.encode(id, box, offset)
  offset += varint.encode.bytes

  message.copy(box, offset)
  return this.stream._push(box)
}

Feed.prototype.remoteSupports = function (name) {
  return this.stream.remoteSupports(name)
}

Feed.prototype.destroy = function (err) {
  this.stream.destroy(err)
}

Feed.prototype.close = function () {
  var i = this.stream.feeds.indexOf(this)

  if (i > -1) {
    this.stream.feeds[i] = this.stream.feeds[this.stream.feeds.length - 1]
    this.stream.feeds.pop()
    this.stream._localFeeds[this.id] = null
    this.id = -1

    if (this.stream.destroyed) return
    if (this.stream.expectedFeeds <= 0 || --this.stream.expectedFeeds) return

    this.stream._prefinalize()
  }
}

Feed.prototype._onclose = function () {
  if (this.closed) return
  this.closed = true

  if (!this.stream.destroyed) {
    this.close()
    if (this.remoteId > -1) this.stream._remoteFeeds[this.remoteId] = null
    var hex = this.discoveryKey.toString('hex')
    if (this.stream._feeds[hex] === this) delete this.stream._feeds[hex]
  }

  if (this.peer) this.peer.onclose()
  else this.emit('close')
}

Feed.prototype._resume = function () {
  var self = this
  process.nextTick(resume)

  function resume () {
    while (self._buffer.length) {
      var next = self._buffer.shift()
      self._emit(next.type, next.message)
    }
    self._buffer = null
  }
}

Feed.prototype._onextension = function (data, start, end) {
  if (end <= start) return

  var id = varint.decode(data, start)
  var r = this.stream.remoteExtensions
  var localId = !r || id >= r.length ? -1 : r[id]

  if (localId === -1) return

  var message = data.slice(start + varint.decode.bytes, end)
  var name = this.stream.extensions[localId]

  if (this.peer && this.peer.onextension) this.peer.onextension(name, message)
  else this.emit('extension', name, message)
}

Feed.prototype._onmessage = function (type, data, start, end) {
  var message = decodeMessage(type, data, start, end)
  if (!message || this.closed) return

  if (type === 1) return this.stream._onhandshake(message)

  if (!this._buffer) {
    this._emit(type, message)
    return
  }

  if (this._buffer.length > 16) {
    this.destroy(new Error('Remote sent too many messages on an unopened feed'))
    return
  }

  this._buffer.push({type: type, message: message})
}

Feed.prototype._emit = function (type, message) {
  if (this.peer) {
    switch (type) {
      case 2: return this.peer.oninfo(message)
      case 3: return this.peer.onhave(message)
      case 4: return this.peer.onunhave(message)
      case 5: return this.peer.onwant(message)
      case 6: return this.peer.onunwant(message)
      case 7: return this.peer.onrequest(message)
      case 8: return this.peer.oncancel(message)
      case 9: return this.peer.ondata(message)
    }
  } else {
    switch (type) {
      case 2: return this.emit('info', message)
      case 3: return this.emit('have', message)
      case 4: return this.emit('unhave', message)
      case 5: return this.emit('want', message)
      case 6: return this.emit('unwant', message)
      case 7: return this.emit('request', message)
      case 8: return this.emit('cancel', message)
      case 9: return this.emit('data', message)
    }
  }
}

Feed.prototype._send = function (type, enc, message) {
  var header = this.header | type
  var len = this.headerLength + enc.encodingLength(message)
  var box = bufferAlloc(varint.encodingLength(len) + len)
  var offset = 0

  varint.encode(len, box, offset)
  offset += varint.encode.bytes

  varint.encode(header, box, offset)
  offset += varint.encode.bytes

  enc.encode(message, box, offset)

  return this.stream._push(box)
}

function decodeMessage (type, data, start, end) {
  switch (type) {
    case 1: return decode(messages.Handshake, data, start, end)
    case 2: return decode(messages.Info, data, start, end)
    case 3: return decode(messages.Have, data, start, end)
    case 4: return decode(messages.Unhave, data, start, end)
    case 5: return decode(messages.Want, data, start, end)
    case 6: return decode(messages.Unwant, data, start, end)
    case 7: return decode(messages.Request, data, start, end)
    case 8: return decode(messages.Cancel, data, start, end)
    case 9: return decode(messages.Data, data, start, end)
  }
}

function decode (enc, data, start, end) {
  try {
    return enc.decode(data, start, end)
  } catch (err) {
    return null
  }
}

}).call(this,require('_process'))
},{"./messages":56,"_process":94,"buffer-alloc-unsafe":28,"events":27,"inherits":71,"varint":154}],55:[function(require,module,exports){
(function (process){
var stream = require('readable-stream')
var inherits = require('inherits')
var varint = require('varint')
var sodium = require('sodium-universal')
var indexOf = require('sorted-indexof')
var feed = require('./feed')
var messages = require('./messages')
var bufferAlloc = require('buffer-alloc-unsafe')
var bufferFrom = require('buffer-from')

module.exports = Protocol

function Protocol (opts) {
  if (!(this instanceof Protocol)) return new Protocol(opts)
  if (!opts) opts = {}

  stream.Duplex.call(this)
  var self = this

  this.id = opts.id || randomBytes(32)
  this.live = !!opts.live
  this.ack = !!opts.ack
  this.userData = opts.userData || null
  this.remoteId = null
  this.remoteLive = false
  this.remoteUserData = null

  this.destroyed = false
  this.encrypted = opts.encrypt !== false
  this.key = null
  this.discoveryKey = null
  this.remoteDiscoveryKey = null
  this.feeds = []
  this.expectedFeeds = opts.expectedFeeds || 0
  this.extensions = opts.extensions || []
  this.remoteExtensions = null
  this.maxFeeds = opts.maxFeeds || 256

  this._localFeeds = []
  this._remoteFeeds = []
  this._feeds = {}

  this._nonce = null
  this._remoteNonce = null
  this._xor = null
  this._remoteXor = null
  this._needsKey = false
  this._length = bufferAlloc(varint.encodingLength(8388608))
  this._missing = 0
  this._buf = null
  this._pointer = 0
  this._data = null
  this._start = 0
  this._cb = null
  this._interval = null
  this._keepAlive = 0
  this._remoteKeepAlive = 0
  this._maybeFinalize = maybeFinalize
  this._utp = null

  if (opts.timeout !== 0 && opts.timeout !== false) this.setTimeout(opts.timeout || 5000, this._ontimeout)
  this.on('finish', this.finalize)
  this.on('pipe', this._onpipe)

  function maybeFinalize (err) {
    if (err) return self.destroy(err)
    if (!self.expectedFeeds) self.finalize()
  }
}

inherits(Protocol, stream.Duplex)

Protocol.prototype._onpipe = function (stream) {
  if (typeof stream.setContentSize === 'function') this._utp = stream
}

Protocol.prototype._prefinalize = function () {
  if (!this.emit('prefinalize', this._maybeFinalize)) this.finalize()
}

Protocol.prototype.setTimeout = function (ms, ontimeout) {
  if (this.destroyed) return
  if (ontimeout) this.once('timeout', ontimeout)

  var self = this

  this._keepAlive = 0
  this._remoteKeepAlive = 0

  clearInterval(this._interval)
  if (!ms) return

  this._interval = setInterval(kick, (ms / 4) | 0)
  if (this._interval.unref) this._interval.unref()

  function kick () {
    self._kick()
  }
}

Protocol.prototype.feed = function (key, opts) {
  if (this.destroyed) return null
  if (!opts) opts = {}

  var dk = opts.discoveryKey || discoveryKey(key)
  var ch = this._feed(dk)

  if (ch.id > -1) {
    if (opts.peer) ch.peer = opts.peer
    return ch
  }

  if (this._localFeeds.length >= this.maxFeeds) {
    this._tooManyFeeds()
    return null
  }

  ch.id = this._localFeeds.push(ch) - 1
  ch.header = ch.id << 4
  ch.headerLength = varint.encodingLength(ch.header)
  ch.key = key
  ch.discoveryKey = dk
  if (opts.peer) ch.peer = opts.peer

  this.feeds.push(ch)

  var first = !this.key
  var feed = {
    discoveryKey: dk,
    nonce: null
  }

  if (first) {
    this.key = key
    this.discoveryKey = dk

    if (!this._sameKey()) return null

    if (this.encrypted) {
      feed.nonce = this._nonce = randomBytes(24)
      this._xor = sodium.crypto_stream_xor_instance(this._nonce, this.key)
      if (this._remoteNonce) {
        this._remoteXor = sodium.crypto_stream_xor_instance(this._remoteNonce, this.key)
      }
    }

    if (this._needsKey) {
      this._needsKey = false
      this._resume()
    }
  }

  var box = encodeFeed(feed, ch.id)
  if (!feed.nonce && this.encrypted) this._xor.update(box, box)
  this._keepAlive = 0
  this.push(box)

  if (this.destroyed) return null

  if (first) {
    ch.handshake({
      id: this.id,
      live: this.live,
      userData: this.userData,
      extensions: this.extensions,
      ack: this.ack
    })
  }

  if (ch._buffer.length) ch._resume()
  else ch._buffer = null

  return ch
}

Protocol.prototype._resume = function () {
  var self = this
  process.nextTick(resume)

  function resume () {
    if (!self._data) return

    var data = self._data
    var start = self._start
    var cb = self._cb

    self._data = null
    self._start = 0
    self._cb = null
    self._parse(data, start, cb)
  }
}

Protocol.prototype._kick = function () {
  if (this._remoteKeepAlive > 4) {
    clearInterval(this._interval)
    this.emit('timeout')
    return
  }

  for (var i = 0; i < this.feeds.length; i++) {
    var ch = this.feeds[i]
    if (ch.peer) ch.peer.ontick()
    else ch.emit('tick')
  }

  this._remoteKeepAlive++

  if (this._keepAlive > 2) {
    this.ping()
    this._keepAlive = 0
  } else {
    this._keepAlive++
  }
}

Protocol.prototype.ping = function () {
  if (!this.key) return true
  var ping = bufferFrom([0])
  if (this._xor) this._xor.update(ping, ping)
  return this.push(ping)
}

Protocol.prototype.destroy = function (err) {
  if (this.destroyed) return
  this.destroyed = true
  if (err) this.emit('error', err)
  this._close()
  this.emit('close')
}

Protocol.prototype.finalize = function () {
  if (this.destroyed) return
  this.destroyed = true
  this._close()
  this.push(null)
}

Protocol.prototype._close = function () {
  clearInterval(this._interval)

  var feeds = this.feeds
  this.feeds = []
  for (var i = 0; i < feeds.length; i++) feeds[i]._onclose()

  if (this._xor) {
    this._xor.final()
    this._xor = null
  }
}

Protocol.prototype._read = function () {
  // do nothing, user back-pressures
}

Protocol.prototype._push = function (data) {
  if (this.destroyed) return
  this._keepAlive = 0
  if (this._xor) this._xor.update(data, data)
  return this.push(data)
}

Protocol.prototype._write = function (data, enc, cb) {
  this._remoteKeepAlive = 0
  this._parse(data, 0, cb)
}

Protocol.prototype._feed = function (dk) {
  var hex = dk.toString('hex')
  var ch = this._feeds[hex]
  if (ch) return ch
  ch = this._feeds[hex] = feed(this)
  return ch
}

Protocol.prototype.remoteSupports = function (name) {
  var i = this.extensions.indexOf(name)
  return i > -1 && !!this.remoteExtensions && this.remoteExtensions.indexOf(i) > -1
}

Protocol.prototype._onhandshake = function (handshake) {
  if (this.remoteId) return

  this.remoteId = handshake.id || randomBytes(32)
  this.remoteLive = handshake.live
  this.remoteUserData = handshake.userData
  this.remoteExtensions = indexOf(this.extensions, handshake.extensions)
  this.remoteAck = handshake.ack

  this.emit('handshake')
}

Protocol.prototype._onopen = function (id, data, start, end) {
  var feed = decodeFeed(data, start, end)

  if (!feed) return this._badFeed()

  if (!this.remoteDiscoveryKey) {
    this.remoteDiscoveryKey = feed.discoveryKey
    if (!this._sameKey()) return

    if (this.encrypted && !this._remoteNonce) {
      if (!feed.nonce) {
        this.destroy(new Error('Remote did not include a nonce'))
        return
      }
      this._remoteNonce = feed.nonce
    }

    if (this.encrypted && this.key && !this._remoteXor) {
      this._remoteXor = sodium.crypto_stream_xor_instance(this._remoteNonce, this.key)
    }
  }

  this._remoteFeeds[id] = this._feed(feed.discoveryKey)
  feed.remoteId = id

  this.emit('feed', feed.discoveryKey)
}

Protocol.prototype._onmessage = function (data, start, end) {
  if (end - start < 2) return

  var header = decodeHeader(data, start)
  if (header === -1) return this.destroy(new Error('Remote sent invalid header'))

  start += varint.decode.bytes

  var id = header >> 4
  var type = header & 15

  if (id >= this.maxFeeds) return this._tooManyFeeds()
  while (this._remoteFeeds.length < id) this._remoteFeeds.push(null)

  var ch = this._remoteFeeds[id]

  if (type === 0) {
    if (ch) ch._onclose()
    return this._onopen(id, data, start, end)
  }

  if (!ch) return this._badFeed()
  if (type === 15) return ch._onextension(data, start, end)
  ch._onmessage(type, data, start, end)
}

Protocol.prototype._parse = function (data, start, cb) {
  var decrypted = !!this._remoteXor

  if (start) {
    data = data.slice(start)
    start = 0
  }

  if (this._remoteXor) this._remoteXor.update(data, data)

  while (start < data.length && !this.destroyed) {
    if (this._missing) start = this._parseMessage(data, start)
    else start = this._parseLength(data, start)

    if (this._needsKey) {
      this._data = data
      this._start = start
      this._cb = cb
      return
    }

    if (!decrypted && this._remoteXor) {
      return this._parse(data, start, cb)
    }
  }

  cb()
}

Protocol.prototype._parseMessage = function (data, start) {
  var end = start + this._missing

  if (end <= data.length) {
    var ret = end

    if (this._buf) {
      data.copy(this._buf, this._pointer, start)
      data = this._buf
      start = 0
      end = data.length
      this._buf = null
    }

    this._missing = 0
    this._pointer = 0
    if (this.encrypted && !this.key) this._needsKey = true
    this._onmessage(data, start, end)

    return ret
  }

  if (!this._buf) {
    this._buf = bufferAlloc(this._missing)
    this._pointer = 0
  }

  var rem = data.length - start

  data.copy(this._buf, this._pointer, start)
  this._pointer += rem
  this._missing -= rem

  return data.length
}

Protocol.prototype._parseLength = function (data, start) {
  while (!this._missing && start < data.length) {
    var byte = this._length[this._pointer++] = data[start++]

    if (!(byte & 0x80)) {
      this._missing = varint.decode(this._length)
      this._pointer = 0
      if (this._missing > 8388608) return this._tooBig(data.length)
      if (this._utp) {
        var reallyMissing = this._missing - (data.length - start)
        if (reallyMissing > 0 && !this._needsKey) this._utp.setContentSize(reallyMissing)
      }
      return start
    }

    if (this._pointer >= this._length.length) return this._tooBig(data.length)
  }

  return start
}

Protocol.prototype._sameKey = function () {
  if (!this.discoveryKey || !this.remoteDiscoveryKey) return true
  if (this.remoteDiscoveryKey.toString('hex') === this.discoveryKey.toString('hex')) return true
  this.destroy(new Error('First shared hypercore must be the same'))
  return false
}

Protocol.prototype._tooManyFeeds = function () {
  this.destroy(new Error('Only ' + this.maxFeeds + ' feeds currently supported. Open a Github issue if you need more'))
}

Protocol.prototype._tooBig = function (len) {
  this.destroy(new Error('Remote message is larger than 8MB (max allowed)'))
  return len
}

Protocol.prototype._badFeed = function () {
  this.destroy(new Error('Remote sent invalid feed message'))
}

Protocol.prototype._ontimeout = function () {
  this.destroy(new Error('Remote timed out'))
}

function decodeHeader (data, start) {
  try {
    return varint.decode(data, start)
  } catch (err) {
    return -1
  }
}

function decodeFeed (data, start, end) {
  var feed = null

  try {
    feed = messages.Feed.decode(data, start, end)
  } catch (err) {
    return null
  }

  if (feed.discoveryKey.length !== 32) return null
  if (feed.nonce && feed.nonce.length !== 24) return null

  return feed
}

function encodeFeed (feed, id) {
  var header = id << 4
  var len = varint.encodingLength(header) + messages.Feed.encodingLength(feed)
  var box = bufferAlloc(varint.encodingLength(len) + len)
  var offset = 0

  varint.encode(len, box, offset)
  offset += varint.encode.bytes

  varint.encode(header, box, offset)
  offset += varint.encode.bytes

  messages.Feed.encode(feed, box, offset)
  return box
}

function discoveryKey (key) {
  var buf = bufferAlloc(32)
  sodium.crypto_generichash(buf, bufferFrom('hypercore'), key)
  return buf
}

function randomBytes (n) {
  var buf = bufferAlloc(n)
  sodium.randombytes_buf(buf)
  return buf
}

}).call(this,require('_process'))
},{"./feed":54,"./messages":56,"_process":94,"buffer-alloc-unsafe":28,"buffer-from":31,"inherits":71,"readable-stream":116,"sodium-universal":134,"sorted-indexof":135,"varint":154}],56:[function(require,module,exports){
(function (Buffer){
// This file is auto generated by the protocol-buffers cli tool

/* eslint-disable quotes */
/* eslint-disable indent */
/* eslint-disable no-redeclare */

// Remember to `npm install --save protocol-buffers-encodings`
var encodings = require('protocol-buffers-encodings')
var varint = encodings.varint
var skip = encodings.skip

var Feed = exports.Feed = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Handshake = exports.Handshake = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Info = exports.Info = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Have = exports.Have = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Unhave = exports.Unhave = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Want = exports.Want = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Unwant = exports.Unwant = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Request = exports.Request = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Cancel = exports.Cancel = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Data = exports.Data = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

defineFeed()
defineHandshake()
defineInfo()
defineHave()
defineUnhave()
defineWant()
defineUnwant()
defineRequest()
defineCancel()
defineData()

function defineFeed () {
  var enc = [
    encodings.bytes
  ]

  Feed.encodingLength = encodingLength
  Feed.encode = encode
  Feed.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.discoveryKey)) throw new Error("discoveryKey is required")
    var len = enc[0].encodingLength(obj.discoveryKey)
    length += 1 + len
    if (defined(obj.nonce)) {
      var len = enc[0].encodingLength(obj.nonce)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.discoveryKey)) throw new Error("discoveryKey is required")
    buf[offset++] = 10
    enc[0].encode(obj.discoveryKey, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.nonce)) {
      buf[offset++] = 18
      enc[0].encode(obj.nonce, buf, offset)
      offset += enc[0].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      discoveryKey: null,
      nonce: null
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.discoveryKey = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.nonce = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineHandshake () {
  var enc = [
    encodings.bytes,
    encodings.bool,
    encodings.string
  ]

  Handshake.encodingLength = encodingLength
  Handshake.encode = encode
  Handshake.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (defined(obj.id)) {
      var len = enc[0].encodingLength(obj.id)
      length += 1 + len
    }
    if (defined(obj.live)) {
      var len = enc[1].encodingLength(obj.live)
      length += 1 + len
    }
    if (defined(obj.userData)) {
      var len = enc[0].encodingLength(obj.userData)
      length += 1 + len
    }
    if (defined(obj.extensions)) {
      for (var i = 0; i < obj.extensions.length; i++) {
        if (!defined(obj.extensions[i])) continue
        var len = enc[2].encodingLength(obj.extensions[i])
        length += 1 + len
      }
    }
    if (defined(obj.ack)) {
      var len = enc[1].encodingLength(obj.ack)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (defined(obj.id)) {
      buf[offset++] = 10
      enc[0].encode(obj.id, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.live)) {
      buf[offset++] = 16
      enc[1].encode(obj.live, buf, offset)
      offset += enc[1].encode.bytes
    }
    if (defined(obj.userData)) {
      buf[offset++] = 26
      enc[0].encode(obj.userData, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.extensions)) {
      for (var i = 0; i < obj.extensions.length; i++) {
        if (!defined(obj.extensions[i])) continue
        buf[offset++] = 34
        enc[2].encode(obj.extensions[i], buf, offset)
        offset += enc[2].encode.bytes
      }
    }
    if (defined(obj.ack)) {
      buf[offset++] = 40
      enc[1].encode(obj.ack, buf, offset)
      offset += enc[1].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      id: null,
      live: false,
      userData: null,
      extensions: [],
      ack: false
    }
    while (true) {
      if (end <= offset) {
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.id = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 2:
        obj.live = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        case 3:
        obj.userData = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 4:
        obj.extensions.push(enc[2].decode(buf, offset))
        offset += enc[2].decode.bytes
        break
        case 5:
        obj.ack = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineInfo () {
  var enc = [
    encodings.bool
  ]

  Info.encodingLength = encodingLength
  Info.encode = encode
  Info.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (defined(obj.uploading)) {
      var len = enc[0].encodingLength(obj.uploading)
      length += 1 + len
    }
    if (defined(obj.downloading)) {
      var len = enc[0].encodingLength(obj.downloading)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (defined(obj.uploading)) {
      buf[offset++] = 8
      enc[0].encode(obj.uploading, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.downloading)) {
      buf[offset++] = 16
      enc[0].encode(obj.downloading, buf, offset)
      offset += enc[0].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      uploading: false,
      downloading: false
    }
    while (true) {
      if (end <= offset) {
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.uploading = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 2:
        obj.downloading = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineHave () {
  var enc = [
    encodings.varint,
    encodings.bytes
  ]

  Have.encodingLength = encodingLength
  Have.encode = encode
  Have.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.start)) throw new Error("start is required")
    var len = enc[0].encodingLength(obj.start)
    length += 1 + len
    if (defined(obj.length)) {
      var len = enc[0].encodingLength(obj.length)
      length += 1 + len
    }
    if (defined(obj.bitfield)) {
      var len = enc[1].encodingLength(obj.bitfield)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.start)) throw new Error("start is required")
    buf[offset++] = 8
    enc[0].encode(obj.start, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.length)) {
      buf[offset++] = 16
      enc[0].encode(obj.length, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.bitfield)) {
      buf[offset++] = 26
      enc[1].encode(obj.bitfield, buf, offset)
      offset += enc[1].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      start: 0,
      length: 1,
      bitfield: null
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.start = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.length = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 3:
        obj.bitfield = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineUnhave () {
  var enc = [
    encodings.varint
  ]

  Unhave.encodingLength = encodingLength
  Unhave.encode = encode
  Unhave.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.start)) throw new Error("start is required")
    var len = enc[0].encodingLength(obj.start)
    length += 1 + len
    if (defined(obj.length)) {
      var len = enc[0].encodingLength(obj.length)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.start)) throw new Error("start is required")
    buf[offset++] = 8
    enc[0].encode(obj.start, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.length)) {
      buf[offset++] = 16
      enc[0].encode(obj.length, buf, offset)
      offset += enc[0].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      start: 0,
      length: 1
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.start = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.length = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineWant () {
  var enc = [
    encodings.varint
  ]

  Want.encodingLength = encodingLength
  Want.encode = encode
  Want.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.start)) throw new Error("start is required")
    var len = enc[0].encodingLength(obj.start)
    length += 1 + len
    if (defined(obj.length)) {
      var len = enc[0].encodingLength(obj.length)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.start)) throw new Error("start is required")
    buf[offset++] = 8
    enc[0].encode(obj.start, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.length)) {
      buf[offset++] = 16
      enc[0].encode(obj.length, buf, offset)
      offset += enc[0].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      start: 0,
      length: 0
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.start = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.length = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineUnwant () {
  var enc = [
    encodings.varint
  ]

  Unwant.encodingLength = encodingLength
  Unwant.encode = encode
  Unwant.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.start)) throw new Error("start is required")
    var len = enc[0].encodingLength(obj.start)
    length += 1 + len
    if (defined(obj.length)) {
      var len = enc[0].encodingLength(obj.length)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.start)) throw new Error("start is required")
    buf[offset++] = 8
    enc[0].encode(obj.start, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.length)) {
      buf[offset++] = 16
      enc[0].encode(obj.length, buf, offset)
      offset += enc[0].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      start: 0,
      length: 0
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.start = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.length = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineRequest () {
  var enc = [
    encodings.varint,
    encodings.bool
  ]

  Request.encodingLength = encodingLength
  Request.encode = encode
  Request.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.index)) throw new Error("index is required")
    var len = enc[0].encodingLength(obj.index)
    length += 1 + len
    if (defined(obj.bytes)) {
      var len = enc[0].encodingLength(obj.bytes)
      length += 1 + len
    }
    if (defined(obj.hash)) {
      var len = enc[1].encodingLength(obj.hash)
      length += 1 + len
    }
    if (defined(obj.nodes)) {
      var len = enc[0].encodingLength(obj.nodes)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.index)) throw new Error("index is required")
    buf[offset++] = 8
    enc[0].encode(obj.index, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.bytes)) {
      buf[offset++] = 16
      enc[0].encode(obj.bytes, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.hash)) {
      buf[offset++] = 24
      enc[1].encode(obj.hash, buf, offset)
      offset += enc[1].encode.bytes
    }
    if (defined(obj.nodes)) {
      buf[offset++] = 32
      enc[0].encode(obj.nodes, buf, offset)
      offset += enc[0].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      index: 0,
      bytes: 0,
      hash: false,
      nodes: 0
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.index = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.bytes = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 3:
        obj.hash = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        case 4:
        obj.nodes = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineCancel () {
  var enc = [
    encodings.varint,
    encodings.bool
  ]

  Cancel.encodingLength = encodingLength
  Cancel.encode = encode
  Cancel.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.index)) throw new Error("index is required")
    var len = enc[0].encodingLength(obj.index)
    length += 1 + len
    if (defined(obj.bytes)) {
      var len = enc[0].encodingLength(obj.bytes)
      length += 1 + len
    }
    if (defined(obj.hash)) {
      var len = enc[1].encodingLength(obj.hash)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.index)) throw new Error("index is required")
    buf[offset++] = 8
    enc[0].encode(obj.index, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.bytes)) {
      buf[offset++] = 16
      enc[0].encode(obj.bytes, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.hash)) {
      buf[offset++] = 24
      enc[1].encode(obj.hash, buf, offset)
      offset += enc[1].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      index: 0,
      bytes: 0,
      hash: false
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.index = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.bytes = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 3:
        obj.hash = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineData () {
  var Node = Data.Node = {
    buffer: true,
    encodingLength: null,
    encode: null,
    decode: null
  }

  defineNode()

  function defineNode () {
    var enc = [
      encodings.varint,
      encodings.bytes
    ]

    Node.encodingLength = encodingLength
    Node.encode = encode
    Node.decode = decode

    function encodingLength (obj) {
      var length = 0
      if (!defined(obj.index)) throw new Error("index is required")
      var len = enc[0].encodingLength(obj.index)
      length += 1 + len
      if (!defined(obj.hash)) throw new Error("hash is required")
      var len = enc[1].encodingLength(obj.hash)
      length += 1 + len
      if (!defined(obj.size)) throw new Error("size is required")
      var len = enc[0].encodingLength(obj.size)
      length += 1 + len
      return length
    }

    function encode (obj, buf, offset) {
      if (!offset) offset = 0
      if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
      var oldOffset = offset
      if (!defined(obj.index)) throw new Error("index is required")
      buf[offset++] = 8
      enc[0].encode(obj.index, buf, offset)
      offset += enc[0].encode.bytes
      if (!defined(obj.hash)) throw new Error("hash is required")
      buf[offset++] = 18
      enc[1].encode(obj.hash, buf, offset)
      offset += enc[1].encode.bytes
      if (!defined(obj.size)) throw new Error("size is required")
      buf[offset++] = 24
      enc[0].encode(obj.size, buf, offset)
      offset += enc[0].encode.bytes
      encode.bytes = offset - oldOffset
      return buf
    }

    function decode (buf, offset, end) {
      if (!offset) offset = 0
      if (!end) end = buf.length
      if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
      var oldOffset = offset
      var obj = {
        index: 0,
        hash: null,
        size: 0
      }
      var found0 = false
      var found1 = false
      var found2 = false
      while (true) {
        if (end <= offset) {
          if (!found0 || !found1 || !found2) throw new Error("Decoded message is not valid")
          decode.bytes = offset - oldOffset
          return obj
        }
        var prefix = varint.decode(buf, offset)
        offset += varint.decode.bytes
        var tag = prefix >> 3
        switch (tag) {
          case 1:
          obj.index = enc[0].decode(buf, offset)
          offset += enc[0].decode.bytes
          found0 = true
          break
          case 2:
          obj.hash = enc[1].decode(buf, offset)
          offset += enc[1].decode.bytes
          found1 = true
          break
          case 3:
          obj.size = enc[0].decode(buf, offset)
          offset += enc[0].decode.bytes
          found2 = true
          break
          default:
          offset = skip(prefix & 7, buf, offset)
        }
      }
    }
  }

  var enc = [
    encodings.varint,
    encodings.bytes,
    Node
  ]

  Data.encodingLength = encodingLength
  Data.encode = encode
  Data.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.index)) throw new Error("index is required")
    var len = enc[0].encodingLength(obj.index)
    length += 1 + len
    if (defined(obj.value)) {
      var len = enc[1].encodingLength(obj.value)
      length += 1 + len
    }
    if (defined(obj.nodes)) {
      for (var i = 0; i < obj.nodes.length; i++) {
        if (!defined(obj.nodes[i])) continue
        var len = enc[2].encodingLength(obj.nodes[i])
        length += varint.encodingLength(len)
        length += 1 + len
      }
    }
    if (defined(obj.signature)) {
      var len = enc[1].encodingLength(obj.signature)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.index)) throw new Error("index is required")
    buf[offset++] = 8
    enc[0].encode(obj.index, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.value)) {
      buf[offset++] = 18
      enc[1].encode(obj.value, buf, offset)
      offset += enc[1].encode.bytes
    }
    if (defined(obj.nodes)) {
      for (var i = 0; i < obj.nodes.length; i++) {
        if (!defined(obj.nodes[i])) continue
        buf[offset++] = 26
        varint.encode(enc[2].encodingLength(obj.nodes[i]), buf, offset)
        offset += varint.encode.bytes
        enc[2].encode(obj.nodes[i], buf, offset)
        offset += enc[2].encode.bytes
      }
    }
    if (defined(obj.signature)) {
      buf[offset++] = 34
      enc[1].encode(obj.signature, buf, offset)
      offset += enc[1].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      index: 0,
      value: null,
      nodes: [],
      signature: null
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.index = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.value = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        case 3:
        var len = varint.decode(buf, offset)
        offset += varint.decode.bytes
        obj.nodes.push(enc[2].decode(buf, offset, offset + len))
        offset += enc[2].decode.bytes
        break
        case 4:
        obj.signature = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defined (val) {
  return val !== null && val !== undefined && (typeof val !== 'number' || !isNaN(val))
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"protocol-buffers-encodings":95}],57:[function(require,module,exports){
(function (Buffer){
var low = require('last-one-wins')
var remove = require('unordered-array-remove')
var set = require('unordered-set')
var merkle = require('merkle-tree-stream/generator')
var flat = require('flat-tree')
var bulk = require('bulk-write-stream')
var from = require('from2')
var codecs = require('codecs')
var thunky = require('thunky')
var batcher = require('atomic-batcher')
var inherits = require('inherits')
var events = require('events')
var raf = require('random-access-file')
var bitfield = require('./lib/bitfield')
var sparseBitfield = require('sparse-bitfield')
var treeIndex = require('./lib/tree-index')
var storage = require('./lib/storage')
var crypto = require('hypercore-crypto')
var nextTick = require('process-nextick-args')
var bufferFrom = require('buffer-from')
var bufferAlloc = require('buffer-alloc-unsafe')
var inspect = require('inspect-custom-symbol')
var pretty = require('pretty-hash')
var safeBufferEquals = require('./lib/safe-buffer-equals')
var replicate = null

module.exports = Feed

function Feed (createStorage, key, opts) {
  if (!(this instanceof Feed)) return new Feed(createStorage, key, opts)
  events.EventEmitter.call(this)

  if (typeof createStorage === 'string') createStorage = defaultStorage(createStorage)
  if (typeof createStorage !== 'function') throw new Error('Storage should be a function or string')

  if (typeof key === 'string') key = bufferFrom(key, 'hex')

  if (!Buffer.isBuffer(key) && !opts) {
    opts = key
    key = null
  }

  if (!opts) opts = {}

  var self = this

  var secretKey = opts.secretKey || null
  if (typeof secretKey === 'string') secretKey = bufferFrom(secretKey, 'hex')

  this.id = opts.id || crypto.randomBytes(32)
  this.live = opts.live !== false
  this.sparse = !!opts.sparse
  this.length = 0
  this.byteLength = 0
  this.maxRequests = opts.maxRequests || 16
  this.key = key || opts.key || null
  this.discoveryKey = this.key && crypto.discoveryKey(this.key)
  this.secretKey = secretKey
  this.bitfield = null
  this.tree = null
  this.writable = !!opts.writable
  this.readable = true
  this.opened = false
  this.closed = false
  this.allowPush = !!opts.allowPush
  this.peers = []

  // hooks
  this._onwrite = opts.onwrite || null

  this._ready = thunky(open) // TODO: if open fails, do not reopen next time
  this._indexing = !!opts.indexing
  this._createIfMissing = opts.createIfMissing !== false
  this._overwrite = !!opts.overwrite
  this._storeSecretKey = opts.storeSecretKey !== false
  this._merkle = null
  this._storage = storage(createStorage, opts.storageCacheSize)
  this._batch = batcher(this._onwrite ? workHook : work)

  this._seq = 0
  this._waiting = []
  this._selections = []
  this._reserved = sparseBitfield()
  this._synced = null

  this._stats = (typeof opts.stats !== 'undefined' && !opts.stats) ? null : {
    downloadedBlocks: 0,
    downloadedBytes: 0,
    uploadedBlocks: 0,
    uploadedBytes: 0
  }

  this._codec = toCodec(opts.valueEncoding)
  this._sync = low(sync)
  if (!this.sparse) this.download({start: 0, end: -1})

  // open it right away. TODO: do not reopen (i.e, set a flag not to retry)
  this._ready(onerror)

  function onerror (err) {
    if (err) self.emit('error', err)
  }

  function workHook (values, cb) {
    if (!self._merkle) return self._reloadMerkleStateBeforeAppend(workHook, values, cb)
    self._appendHook(values, cb)
  }

  function work (values, cb) {
    if (!self._merkle) return self._reloadMerkleStateBeforeAppend(work, values, cb)
    self._append(values, cb)
  }

  function sync (_, cb) {
    self._syncBitfield(cb)
  }

  function open (cb) {
    self._open(cb)
  }
}

inherits(Feed, events.EventEmitter)

Feed.discoveryKey = crypto.discoveryKey

Feed.prototype[inspect] = function (depth, opts) {
  var indent = ''
  if (typeof opts.indentationLvl === 'number') {
    while (indent.length < opts.indentationLvl) indent += ' '
  }
  return 'Hypercore(\n' +
    indent + '  key: ' + opts.stylize((this.key && pretty(this.key)), 'string') + '\n' +
    indent + '  discoveryKey: ' + opts.stylize((this.discoveryKey && pretty(this.discoveryKey)), 'string') + '\n' +
    indent + '  opened: ' + opts.stylize(this.opened, 'boolean') + '\n' +
    indent + '  writable: ' + opts.stylize(this.writable, 'boolean') + '\n' +
    indent + '  length: ' + opts.stylize(this.length, 'number') + '\n' +
    indent + '  byteLength: ' + opts.stylize(this.byteLength, 'number') + '\n' +
    indent + '  peers: ' + opts.stylize(this.peers.length, 'number') + '\n' +
    indent + ')'
}

// TODO: instead of using a getter, update on remote-update/add/remove
Object.defineProperty(Feed.prototype, 'remoteLength', {
  enumerable: true,
  get: function () {
    var len = 0
    for (var i = 0; i < this.peers.length; i++) {
      var remoteLength = this.peers[i].remoteLength
      if (remoteLength > len) len = remoteLength
    }
    return len
  }
})

Object.defineProperty(Feed.prototype, 'stats', {
  enumerable: true,
  get: function () {
    if (!this._stats) return null
    var peerStats = []
    for (var i = 0; i < this.peers.length; i++) {
      var peer = this.peers[i]
      peerStats[i] = peer._stats
    }
    return {
      peers: peerStats,
      totals: this._stats
    }
  }
})

Feed.prototype.replicate = function (opts) {
  // Lazy load replication deps
  if (!replicate) replicate = require('./lib/replicate')

  if ((!this._selections.length || this._selections[0].end !== -1) && !this.sparse && !(opts && opts.live)) {
    // hack!! proper fix is to refactor ./replicate to *not* clear our non-sparse selection
    this.download({start: 0, end: -1})
  }

  opts = opts || {}
  opts.stats = !!this._stats

  return replicate(this, opts)
}

Feed.prototype.ready = function (onready) {
  this._ready(function (err) {
    if (!err) onready()
  })
}

Feed.prototype.update = function (len, cb) {
  if (typeof len === 'function') return this.update(-1, len)
  if (typeof len !== 'number') len = -1
  if (!cb) cb = noop

  var self = this

  this.ready(function (err) {
    if (err) return cb(err)
    if (len === -1) len = self.length + 1
    if (self.length >= len) return cb(null)

    if (self.writable) cb = self._writeStateReloader(cb)

    self._waiting.push({
      hash: true,
      bytes: 0,
      index: len - 1,
      update: true,
      callback: cb
    })

    self._updatePeers()
  })
}

// will reload the writable state. used by .update on a writable peer
Feed.prototype._writeStateReloader = function (cb) {
  var self = this
  return function (err) {
    if (err) return cb(err)
    self._reloadMerkleState(cb)
  }
}

Feed.prototype._reloadMerkleState = function (cb) {
  var self = this

  this._roots(self.length, function (err, roots) {
    if (err) return cb(err)
    self._merkle = merkle(crypto, roots)
    cb(null)
  })
}

Feed.prototype._reloadMerkleStateBeforeAppend = function (work, values, cb) {
  this._reloadMerkleState(function (err) {
    if (err) return cb(err)
    work(values, cb)
  })
}

Feed.prototype._open = function (cb) {
  var self = this
  var generatedKey = false

  // TODO: clean up the duplicate code below ...

  this._storage.openKey(function (_, key) {
    if (key && !self._overwrite && !self.key) self.key = key

    if (!self.key && self.live) {
      var keyPair = crypto.keyPair()
      self.secretKey = keyPair.secretKey
      self.key = keyPair.publicKey
      generatedKey = true
    }

    self.discoveryKey = self.key && crypto.discoveryKey(self.key)
    self._storage.open({key: self.key, discoveryKey: self.discoveryKey}, onopen)
  })

  function onopen (err, state) {
    if (err) return cb(err)

    // if no key but we have data do a bitfield reset since we cannot verify the data.
    if (!state.key && state.bitfield.length) {
      self._overwrite = true
    }

    if (self._overwrite) {
      state.bitfield = []
      state.key = state.secretKey = null
    }

    self.bitfield = bitfield(state.bitfieldPageSize, state.bitfield)
    self.tree = treeIndex(self.bitfield.tree)
    self.length = self.tree.blocks()
    self._seq = self.length

    if (state.key && self.key && Buffer.compare(state.key, self.key) !== 0) {
      return cb(new Error('Another hypercore is stored here'))
    }

    if (state.key) self.key = state.key
    if (state.secretKey) self.secretKey = state.secretKey

    // verify key and secretKey go together
    if (self.key && self.secretKey) {
      var challenge = bufferAlloc(0)
      if (!crypto.verify(challenge, crypto.sign(challenge, self.secretKey), self.key)) {
        return cb(new Error('Key and secret do not match'))
      }
    }

    if (!self.length) return onsignature(null, null)
    self._storage.getSignature(self.length - 1, onsignature)

    function onsignature (_, sig) {
      if (self.length) self.live = !!sig

      if ((generatedKey || !self.key) && !self._createIfMissing) {
        return cb(new Error('No hypercore is stored here'))
      }

      if (!self.key && self.live) {
        var keyPair = crypto.keyPair()
        self.secretKey = keyPair.secretKey
        self.key = keyPair.publicKey
      }

      var writable = !!self.secretKey || self.key === null

      if (!writable && self.writable) return cb(new Error('Feed is not writable'))
      self.writable = writable
      self.discoveryKey = self.key && crypto.discoveryKey(self.key)

      if (self._storeSecretKey && !self.secretKey) {
        self._storeSecretKey = false
      }

      var shouldWriteKey = generatedKey || !safeBufferEquals(self.key, state.key)
      var shouldWriteSecretKey = self._storeSecretKey && (generatedKey || !safeBufferEquals(self.secretKey, state.secretKey))

      var missing = 1 +
        (shouldWriteKey ? 1 : 0) +
        (shouldWriteSecretKey ? 1 : 0) +
        (self._overwrite ? 1 : 0)
      var error = null

      if (shouldWriteKey) self._storage.key.write(0, self.key, done)
      if (shouldWriteSecretKey) self._storage.secretKey.write(0, self.secretKey, done)

      if (self._overwrite) {
        self._storage.bitfield.del(0, Infinity, done)
      }

      done(null)

      function done (err) {
        if (err) error = err
        if (--missing) return
        if (error) return cb(error)
        self._roots(self.length, onroots)
      }

      function onroots (err, roots) {
        if (err) return cb(err)

        self._merkle = merkle(crypto, roots)
        self.byteLength = roots.reduce(addSize, 0)
        self.opened = true
        self.emit('ready')

        cb(null)
      }
    }
  }
}

Feed.prototype.download = function (range, cb) {
  if (typeof range === 'function') return this.download(null, range)
  if (typeof range === 'number') range = {start: range, end: range + 1}
  if (!range) range = {}
  if (!cb) cb = noop
  if (!this.readable) return cb(new Error('Feed is closed'))

  // TODO: if no peers, check if range is already satisfied and nextTick(cb) if so
  // this._updatePeers does this for us when there is a peer though, so not critical

  var sel = {
    _index: this._selections.length,
    hash: !!range.hash,
    iterator: null,
    start: range.start || 0,
    end: range.end || -1,
    want: 0,
    linear: !!range.linear,
    callback: cb
  }

  sel.want = toWantRange(sel.start)

  this._selections.push(sel)
  this._updatePeers()

  return sel
}

Feed.prototype.undownload = function (range) {
  if (typeof range === 'number') range = {start: range, end: range + 1}
  if (!range) range = {}

  if (range.callback && range._index > -1) {
    set.remove(this._selections, range)
    nextTick(range.callback, createError('ECANCELED', -11, 'Download was cancelled'))
    return
  }

  var start = range.start || 0
  var end = range.end || -1
  var hash = !!range.hash
  var linear = !!range.linear

  for (var i = 0; i < this._selections.length; i++) {
    var s = this._selections[i]

    if (s.start === start && s.end === end && s.hash === hash && s.linear === linear) {
      set.remove(this._selections, s)
      nextTick(range.callback, createError('ECANCELED', -11, 'Download was cancelled'))
      return
    }
  }
}

Feed.prototype.digest = function (index) {
  return this.tree.digest(2 * index)
}

Feed.prototype.proof = function (index, opts, cb) {
  if (typeof opts === 'function') return this.proof(index, null, opts)
  if (!this.opened) return this._readyAndProof(index, opts, cb)
  if (!opts) opts = {}

  var proof = this.tree.proof(2 * index, opts)
  if (!proof) return cb(new Error('No proof available for this index'))

  var needsSig = this.live && !!proof.verifiedBy
  var pending = proof.nodes.length + (needsSig ? 1 : 0)
  var error = null
  var signature = null
  var nodes = new Array(proof.nodes.length)

  if (!pending) return cb(null, {nodes: nodes, signature: null})

  for (var i = 0; i < proof.nodes.length; i++) {
    this._storage.getNode(proof.nodes[i], onnode)
  }
  if (needsSig) {
    this._storage.getSignature(proof.verifiedBy / 2 - 1, onsignature)
  }

  function onsignature (err, sig) {
    if (sig) signature = sig
    onnode(err, null)
  }

  function onnode (err, node) {
    if (err) error = err

    if (node) {
      nodes[proof.nodes.indexOf(node.index)] = node
    }

    if (--pending) return
    if (error) return cb(error)
    cb(null, {nodes: nodes, signature: signature})
  }
}

Feed.prototype._readyAndProof = function (index, opts, cb) {
  var self = this
  this._ready(function (err) {
    if (err) return cb(err)
    self.proof(index, opts, cb)
  })
}

Feed.prototype.put = function (index, data, proof, cb) {
  if (!this.opened) return this._readyAndPut(index, data, proof, cb)
  this._putBuffer(index, this._codec.encode(data), proof, null, cb)
}

Feed.prototype.cancel = function (start, end) { // TODO: use same argument scheme as download
  if (!end) end = start + 1

  // cancel these right away as .download does not wait for ready
  for (var i = this._selections.length - 1; i >= 0; i--) {
    var sel = this._selections[i]
    if (start <= sel.start && sel.end <= end) {
      this.undownload(sel)
    }
  }

  // defer the last part until after ready as .get does that as well
  if (this.opened) this._cancel(start, end)
  else this._readyAndCancel(start, end)
}

Feed.prototype._cancel = function (start, end) {
  var i = 0

  for (i = start; i < end; i++) {
    this._reserved.set(i, false) // TODO: send cancel message if set returns true
  }

  for (i = this._waiting.length - 1; i >= 0; i--) {
    var w = this._waiting[i]
    if ((start <= w.start && w.end <= end) || (start <= w.index && w.index < end)) {
      remove(this._waiting, i)
      if (w.callback) nextTick(w.callback, new Error('Request cancelled'))
    }
  }
}

Feed.prototype.clear = function (start, end, opts, cb) { // TODO: use same argument scheme as download
  if (typeof end === 'function') return this.clear(start, start + 1, null, end)
  if (typeof opts === 'function') return this.clear(start, end, null, opts)
  if (!opts) opts = {}
  if (!end) end = start + 1
  if (!cb) cb = noop

  // TODO: this needs some work. fx we can only calc byte offset for blocks we know about
  // so internally we should make sure to only do that. We should use the merkle tree for this

  var self = this
  var byteOffset = start === 0 ? 0 : (typeof opts.byteOffset === 'number' ? opts.byteOffset : -1)
  var byteLength = typeof opts.byteLength === 'number' ? opts.byteLength : -1

  this._ready(function (err) {
    if (err) return cb(err)

    var modified = false

    // TODO: use a buffer.fill thing here to speed this up!

    for (var i = start; i < end; i++) {
      if (self.bitfield.set(i, false)) modified = true
    }

    if (!modified) return nextTick(cb)

    // TODO: write to a tmp/update file that we want to del this incase it crashes will del'ing

    self._unannounce({start: start, length: end - start})
    if (opts.delete === false || self._indexing) return sync()
    if (byteOffset > -1) return onstartbytes(null, byteOffset)
    self._storage.dataOffset(start, [], onstartbytes)

    function sync () {
      self.emit('clear', start, end)
      self._sync(null, cb)
    }

    function onstartbytes (err, offset) {
      if (err) return cb(err)
      byteOffset = offset
      if (byteLength > -1) return onendbytes(null, byteLength + byteOffset)
      if (end === self.length) return onendbytes(null, self.byteLength)
      self._storage.dataOffset(end, [], onendbytes)
    }

    function onendbytes (err, end) {
      if (err) return cb(err)
      if (!self._storage.data.del) return sync() // Not all data storage impls del
      self._storage.data.del(byteOffset, end - byteOffset, sync)
    }
  })
}

Feed.prototype.signature = function (index, cb) {
  if (typeof index === 'function') return this.signature(this.length - 1, index)

  if (index < 0 || index >= this.length) return cb(new Error('No signature available for this index'))

  this._storage.nextSignature(index, cb)
}

Feed.prototype.verify = function (index, signature, cb) {
  var self = this

  this.rootHashes(index, function (err, roots) {
    if (err) return cb(err)

    var checksum = crypto.tree(roots)

    if (!crypto.verify(checksum, signature, self.key)) {
      cb(new Error('Signature verification failed'))
    } else {
      cb(null, true)
    }
  })
}

Feed.prototype.rootHashes = function (index, cb) {
  this._getRootsToVerify(index * 2 + 2, {}, [], cb)
}

Feed.prototype.seek = function (bytes, opts, cb) {
  if (typeof opts === 'function') return this.seek(bytes, null, opts)
  if (!opts) opts = {}
  if (!this.opened) return this._readyAndSeek(bytes, opts, cb)

  var self = this

  this._seek(bytes, function (err, index, offset) {
    if (!err && isBlock(index)) return done(index / 2, offset)
    if (opts.wait === false) return cb(err || new Error('Unable to seek to this offset'))

    var start = opts.start || 0
    var end = opts.end || -1

    if (!err) {
      var left = flat.leftSpan(index) / 2
      var right = flat.rightSpan(index) / 2 + 1

      if (left > start) start = left
      if (right < end || end === -1) end = right
    }

    if (end > -1 && end <= start) return cb(new Error('Unable to seek to this offset'))

    self._waiting.push({
      hash: opts.hash !== false,
      bytes: bytes,
      index: -1,
      start: start,
      end: end,
      want: toWantRange(start),
      callback: cb || noop
    })

    self._updatePeers()
  })

  function done (index, offset) {
    for (var i = 0; i < self.peers.length; i++) {
      self.peers[i].haveBytes(bytes)
    }
    cb(null, index, offset)
  }
}

Feed.prototype._seek = function (offset, cb) {
  if (offset === 0) return cb(null, 0, 0)

  var self = this
  var roots = flat.fullRoots(this.length * 2)
  var nearestRoot = 0

  loop(null, null)

  function onroot (top) {
    if (isBlock(top)) return cb(null, top, offset)

    var left = flat.leftChild(top)
    while (!self.tree.get(left)) {
      if (isBlock(left)) return cb(null, nearestRoot, offset)
      left = flat.leftChild(left)
    }

    self._storage.getNode(left, onleftchild)
  }

  function onleftchild (err, node) {
    if (err) return cb(err)

    if (node.size > offset) {
      nearestRoot = node.index
      onroot(node.index)
    } else {
      offset -= node.size
      onroot(flat.sibling(node.index))
    }
  }

  function loop (err, node) {
    if (err) return cb(err)

    if (node) {
      if (node.size > offset) {
        nearestRoot = node.index
        return onroot(node.index)
      }
      offset -= node.size
    }

    if (!roots.length) return cb(new Error('Out of bounds'))
    self._storage.getNode(roots.shift(), loop)
  }
}

Feed.prototype._readyAndSeek = function (bytes, opts, cb) {
  var self = this
  this._ready(function (err) {
    if (err) return cb(err)
    self.seek(bytes, opts, cb)
  })
}

Feed.prototype._getBuffer = function (index, cb) {
  this._storage.getData(index, cb)
}

Feed.prototype._putBuffer = function (index, data, proof, from, cb) {
  // TODO: this nodes in proof are not instances of our Node prototype
  // but just similar. Check if this has any v8 perf implications.

  // TODO: if the proof contains a valid signature BUT fails, emit a critical error
  // --> feed should be considered dead

  var self = this
  var trusted = -1
  var missing = []
  var next = 2 * index
  var i = data ? 0 : 1

  while (true) {
    if (this.tree.get(next)) {
      trusted = next
      break
    }

    var sib = flat.sibling(next)
    next = flat.parent(next)

    if (i < proof.nodes.length && proof.nodes[i].index === sib) {
      i++
      continue
    }

    if (!this.tree.get(sib)) break
    missing.push(sib)
  }

  if (trusted === -1 && this.tree.get(next)) trusted = next

  var error = null
  var trustedNode = null
  var missingNodes = new Array(missing.length)
  var pending = missing.length + (trusted > -1 ? 1 : 0)

  for (i = 0; i < missing.length; i++) this._storage.getNode(missing[i], onmissing)
  if (trusted > -1) this._storage.getNode(trusted, ontrusted)
  if (!missing.length && trusted === -1) onmissingloaded(null)

  function ontrusted (err, node) {
    if (err) error = err
    if (node) trustedNode = node
    if (!--pending) onmissingloaded(error)
  }

  function onmissing (err, node) {
    if (err) error = err
    if (node) missingNodes[missing.indexOf(node.index)] = node
    if (!--pending) onmissingloaded(error)
  }

  function onmissingloaded (err) {
    if (err) return cb(err)
    self._verifyAndWrite(index, data, proof, missingNodes, trustedNode, from, cb)
  }
}

Feed.prototype._readyAndPut = function (index, data, proof, cb) {
  var self = this
  this._ready(function (err) {
    if (err) return cb(err)
    self.put(index, data, proof, cb)
  })
}

Feed.prototype._write = function (index, data, nodes, sig, from, cb) {
  if (!this._onwrite) return this._writeAfterHook(index, data, nodes, sig, from, cb)
  this._onwrite(index, data, from, writeHookDone(this, index, data, nodes, sig, from, cb))
}

function writeHookDone (self, index, data, nodes, sig, from, cb) {
  return function (err) {
    if (err) return cb(err)
    self._writeAfterHook(index, data, nodes, sig, from, cb)
  }
}

Feed.prototype._writeAfterHook = function (index, data, nodes, sig, from, cb) {
  var self = this
  var pending = nodes.length + 1 + (sig ? 1 : 0)
  var error = null

  for (var i = 0; i < nodes.length; i++) this._storage.putNode(nodes[i].index, nodes[i], ondone)
  if (data) this._storage.putData(index, data, nodes, ondone)
  else ondone()
  if (sig) this._storage.putSignature(sig.index, sig.signature, ondone)

  function ondone (err) {
    if (err) error = err
    if (--pending) return
    if (error) return cb(error)
    self._writeDone(index, data, nodes, from, cb)
  }
}

Feed.prototype._writeDone = function (index, data, nodes, from, cb) {
  for (var i = 0; i < nodes.length; i++) this.tree.set(nodes[i].index)
  this.tree.set(2 * index)

  if (data) {
    if (this.bitfield.set(index, true)) {
      if (this._stats) {
        this._stats.downloadedBlocks += 1
        this._stats.downloadedBytes += data.length
      }
      this.emit('download', index, data, from)
    }
    if (this.peers.length) this._announce({start: index}, from)

    if (!this.writable) {
      if (!this._synced) this._synced = this.bitfield.iterator(0, this.length)
      if (this._synced.next() === -1) {
        this._synced.range(0, this.length)
        this._synced.seek(0)
        if (this._synced.next() === -1) {
          this.emit('sync')
        }
      }
    }
  }

  this._sync(null, cb)
}

Feed.prototype._verifyAndWrite = function (index, data, proof, localNodes, trustedNode, from, cb) {
  var visited = []
  var remoteNodes = proof.nodes
  var top = data ? new storage.Node(2 * index, crypto.data(data), data.length) : remoteNodes.shift()

  // check if we already have the hash for this node
  if (verifyNode(trustedNode, top)) {
    this._write(index, data, visited, null, from, cb)
    return
  }

  // keep hashing with siblings until we reach or trusted node
  while (true) {
    var node = null
    var next = flat.sibling(top.index)

    if (remoteNodes.length && remoteNodes[0].index === next) {
      node = remoteNodes.shift()
      visited.push(node)
    } else if (localNodes.length && localNodes[0].index === next) {
      node = localNodes.shift()
    } else {
      // we cannot create another parent, i.e. these nodes must be roots in the tree
      this._verifyRootsAndWrite(index, data, top, proof, visited, from, cb)
      return
    }

    visited.push(top)
    top = new storage.Node(flat.parent(top.index), crypto.parent(top, node), top.size + node.size)

    // the tree checks out, write the data and the visited nodes
    if (verifyNode(trustedNode, top)) {
      this._write(index, data, visited, null, from, cb)
      return
    }
  }
}

Feed.prototype._verifyRootsAndWrite = function (index, data, top, proof, nodes, from, cb) {
  var remoteNodes = proof.nodes
  var lastNode = remoteNodes.length ? remoteNodes[remoteNodes.length - 1].index : top.index
  var verifiedBy = Math.max(flat.rightSpan(top.index), flat.rightSpan(lastNode)) + 2
  var self = this

  this._getRootsToVerify(verifiedBy, top, remoteNodes, function (err, roots, extraNodes) {
    if (err) return cb(err)

    var checksum = crypto.tree(roots)
    var signature = null

    if (self.length && self.live && !proof.signature) {
      return cb(new Error('Remote did not include a signature'))
    }

    if (proof.signature) { // check signaturex
      if (!crypto.verify(checksum, proof.signature, self.key)) {
        return cb(new Error('Remote signature could not be verified'))
      }

      signature = {index: verifiedBy / 2 - 1, signature: proof.signature}
    } else { // check tree root
      if (Buffer.compare(checksum, self.key) !== 0) {
        return cb(new Error('Remote checksum failed'))
      }
    }

    self.live = !!signature

    var length = verifiedBy / 2
    if (length > self.length) {
      // TODO: only emit this after the info has been flushed to storage
      if (self.writable) self._merkle = null // We need to reload merkle state now
      self.length = length
      self._seq = length
      self.byteLength = roots.reduce(addSize, 0)
      if (self._synced) self._synced.seek(0, self.length)
      self.emit('append')
    }

    self._write(index, data, nodes.concat(extraNodes), signature, from, cb)
  })
}

Feed.prototype._getRootsToVerify = function (verifiedBy, top, remoteNodes, cb) {
  var indexes = flat.fullRoots(verifiedBy)
  var roots = new Array(indexes.length)
  var nodes = []
  var error = null
  var pending = roots.length

  for (var i = 0; i < indexes.length; i++) {
    if (indexes[i] === top.index) {
      nodes.push(top)
      onnode(null, top)
    } else if (remoteNodes.length && indexes[i] === remoteNodes[0].index) {
      nodes.push(remoteNodes[0])
      onnode(null, remoteNodes.shift())
    } else if (this.tree.get(indexes[i])) {
      this._storage.getNode(indexes[i], onnode)
    } else {
      onnode(new Error('Missing tree roots needed for verify'))
    }
  }

  function onnode (err, node) {
    if (err) error = err
    if (node) roots[indexes.indexOf(node.index)] = node
    if (!--pending) done(error)
  }

  function done (err) {
    if (err) return cb(err)

    cb(null, roots, nodes)
  }
}

Feed.prototype._announce = function (message, from) {
  for (var i = 0; i < this.peers.length; i++) {
    var peer = this.peers[i]
    if (peer !== from) peer.have(message)
  }
}

Feed.prototype._unannounce = function (message) {
  for (var i = 0; i < this.peers.length; i++) this.peers[i].unhave(message)
}

Feed.prototype.downloaded = function (start, end) {
  return this.bitfield.total(start, end)
}

Feed.prototype.has = function (start, end) {
  if (end === undefined) return this.bitfield.get(start)
  var total = end - start
  return total === this.bitfield.total(start, end)
}

Feed.prototype.head = function (opts, cb) {
  if (typeof opts === 'function') return this.head({}, opts)
  var self = this
  this._ready(function (err) {
    if (err) return cb(err)
    if (self.length === 0) cb(new Error('feed is empty'))
    else self.get(self.length - 1, cb)
  })
}

Feed.prototype.get = function (index, opts, cb) {
  if (typeof opts === 'function') return this.get(index, null, opts)
  if (!this.opened) return this._readyAndGet(index, opts, cb)
  if (!this.readable) return cb(new Error('Feed is closed'))

  if (opts && opts.timeout) cb = timeoutCallback(cb, opts.timeout)

  if (!this.bitfield.get(index)) {
    if (opts && opts.wait === false) return cb(new Error('Block not downloaded'))

    this._waiting.push({bytes: 0, hash: false, index: index, options: opts, callback: cb})
    this._updatePeers()
    return
  }

  if (opts && opts.valueEncoding) cb = wrapCodec(toCodec(opts.valueEncoding), cb)
  else if (this._codec !== codecs.binary) cb = wrapCodec(this._codec, cb)

  this._getBuffer(index, cb)
}

Feed.prototype._readyAndGet = function (index, opts, cb) {
  var self = this
  this._ready(function (err) {
    if (err) return cb(err)
    self.get(index, opts, cb)
  })
}

Feed.prototype.getBatch = function (start, end, opts, cb) {
  if (typeof opts === 'function') return this.getBatch(start, end, null, opts)
  if (!this.opened) return this._readyAndGetBatch(start, end, opts, cb)

  var self = this
  var wait = !opts || opts.wait !== false

  if (this.has(start, end)) return this._getBatch(start, end, opts, cb)
  if (!wait) return cb(new Error('Block not downloaded'))

  if (opts && opts.timeout) cb = timeoutCallback(cb, opts.timeout)

  this.download({start: start, end: end}, function (err) {
    if (err) return cb(err)
    self._getBatch(start, end, opts, cb)
  })
}

Feed.prototype._getBatch = function (start, end, opts, cb) {
  var enc = opts && opts.valueEncoding
  var codec = enc ? toCodec(enc) : this._codec

  this._storage.getDataBatch(start, end - start, onbatch)

  function onbatch (err, buffers) {
    if (err) return cb(err)

    var batch = new Array(buffers.length)

    for (var i = 0; i < buffers.length; i++) {
      try {
        batch[i] = codec ? codec.decode(buffers[i]) : buffers[i]
      } catch (err) {
        return cb(err)
      }
    }

    cb(null, batch)
  }
}

Feed.prototype._readyAndGetBatch = function (start, end, opts, cb) {
  var self = this
  this._ready(function (err) {
    if (err) return cb(err)
    self.getBatch(start, end, opts, cb)
  })
}

Feed.prototype._updatePeers = function () {
  for (var i = 0; i < this.peers.length; i++) this.peers[i].update()
}

Feed.prototype.createWriteStream = function () {
  var self = this
  return bulk.obj(write)

  function write (batch, cb) {
    self.append(batch, cb)
  }
}

Feed.prototype.createReadStream = function (opts) {
  if (!opts) opts = {}

  var self = this
  var start = opts.start || 0
  var end = typeof opts.end === 'number' ? opts.end : -1
  var live = !!opts.live
  var snapshot = opts.snapshot !== false
  var first = true
  var range = this.download({start: start, end: end, linear: true})

  return from.obj(read).on('end', cleanup).on('close', cleanup)

  function read (size, cb) {
    if (!self.opened) return open(size, cb)
    if (!self.readable) return cb(new Error('Feed is closed'))

    if (first) {
      if (end === -1) {
        if (live) end = Infinity
        else if (snapshot) end = self.length
        if (start > end) return cb(null, null)
      }
      if (opts.tail) start = self.length
      first = false
    }

    if (start === end || (end === -1 && start === self.length)) return cb(null, null)

    range.start++
    if (range.iterator) range.iterator.start++

    self.get(start++, opts, cb)
  }

  function cleanup () {
    if (!range) return
    self.undownload(range)
    range = null
  }

  function open (size, cb) {
    self._ready(function (err) {
      if (err) return cb(err)
      read(size, cb)
    })
  }
}

// TODO: when calling finalize on a live feed write an END_OF_FEED block (length === 0?)
Feed.prototype.finalize = function (cb) {
  if (!this.key) {
    this.key = crypto.tree(this._merkle.roots)
    this.discoveryKey = crypto.discoveryKey(this.key)
  }
  this._storage.key.write(0, this.key, cb)
}

Feed.prototype.append = function (batch, cb) {
  if (!cb) cb = noop

  var self = this
  var list = Array.isArray(batch) ? batch : [batch]
  this._batch(list, onappend)

  function onappend (err) {
    if (err) return cb(err)
    var seq = self._seq
    self._seq += list.length
    cb(null, seq)
  }
}

Feed.prototype.flush = function (cb) {
  this.append([], cb)
}

Feed.prototype.close = function (cb) {
  var self = this

  this._ready(function () {
    self.writable = false
    self.readable = false
    self._storage.close(function (err) {
      if (!self.closed && !err) self._onclose()
      if (cb) cb(err)
    })
  })
}

Feed.prototype._onclose = function () {
  this.closed = true

  while (this._waiting.length) {
    this._waiting.pop().callback(new Error('Feed is closed'))
  }
  while (this._selections.length) {
    this._selections.pop().callback(new Error('Feed is closed'))
  }

  this.emit('close')
}

Feed.prototype._appendHook = function (batch, cb) {
  var self = this
  var missing = batch.length
  var error = null

  if (!missing) return this._append(batch, cb)
  for (var i = 0; i < batch.length; i++) {
    this._onwrite(i + this.length, batch[i], null, done)
  }

  function done (err) {
    if (err) error = err
    if (--missing) return
    if (error) return cb(error)
    self._append(batch, cb)
  }
}

Feed.prototype._append = function (batch, cb) {
  if (!this.opened) return this._readyAndAppend(batch, cb)
  if (!this.writable) return cb(new Error('This feed is not writable. Did you create it?'))

  var self = this
  var pending = 1
  var offset = 0
  var error = null
  var nodeBatch = new Array(batch.length ? batch.length * 2 - 1 : 0)
  var nodeOffset = this.length * 2
  var dataBatch = new Array(batch.length)

  if (!pending) return cb()

  for (var i = 0; i < batch.length; i++) {
    var data = this._codec.encode(batch[i])
    var nodes = this._merkle.next(data)

    if (this.live && i === batch.length - 1) {
      pending++
      var sig = crypto.sign(crypto.tree(this._merkle.roots), this.secretKey)
      this._storage.putSignature(this.length + i, sig, done)
    }

    offset += data.length
    dataBatch[i] = data

    for (var j = 0; j < nodes.length; j++) {
      var node = nodes[j]
      if (node.index >= nodeOffset && node.index - nodeOffset < nodeBatch.length) {
        nodeBatch[node.index - nodeOffset] = node
      } else {
        pending++
        this._storage.putNode(node.index, node, done)
      }
    }
  }

  if (!this._indexing) {
    pending++
    if (dataBatch.length === 1) this._storage.data.write(this.byteLength, dataBatch[0], done)
    else this._storage.data.write(this.byteLength, Buffer.concat(dataBatch), done)
  }

  this._storage.putNodeBatch(nodeOffset, nodeBatch, done)

  function done (err) {
    if (err) error = err
    if (--pending) return
    if (error) return cb(error)

    var start = self.length

    // TODO: only emit append and update length / byteLength after the info has been flushed to storage
    self.byteLength += offset
    for (var i = 0; i < batch.length; i++) {
      self.bitfield.set(self.length, true)
      self.tree.set(2 * self.length++)
    }
    self.emit('append')

    var message = self.length - start > 1 ? {start: start, length: self.length - start} : {start: start}
    if (self.peers.length) self._announce(message)

    self._sync(null, cb)
  }
}

Feed.prototype._readyAndAppend = function (batch, cb) {
  var self = this
  this._ready(function (err) {
    if (err) return cb(err)
    self._append(batch, cb)
  })
}

Feed.prototype._readyAndCancel = function (start, end) {
  var self = this
  this.ready(function () {
    self._cancel(start, end)
  })
}

Feed.prototype._pollWaiting = function () {
  var len = this._waiting.length
  for (var i = 0; i < len; i++) {
    var next = this._waiting[i]
    if (!next.bytes && !this.bitfield.get(next.index)) continue

    remove(this._waiting, i--)
    len--

    if (next.bytes) this.seek(next.bytes, next, next.callback)
    else if (next.update) this.update(next.index + 1, next.callback)
    else this.get(next.index, next.options, next.callback)
  }
}

Feed.prototype._syncBitfield = function (cb) {
  var missing = this.bitfield.pages.updates.length
  var next = null
  var error = null

  // All data / nodes have been written now. We still need to update the bitfields though

  // TODO 1: if the program fails during this write the bitfield might not have been fully written
  // HOWEVER, we can easily recover from this by traversing the tree and checking if the nodes exists
  // on disk. So if a get fails, it should try and recover once.

  // TODO 2: if .writable append bitfield updates into a single buffer for extra perf
  // Added benefit is that if the program exits while flushing the bitfield the feed will only get
  // truncated and not have missing chunks which is what you expect.

  if (!missing) {
    this._pollWaiting()
    return cb(null)
  }

  while ((next = this.bitfield.pages.lastUpdate()) !== null) {
    this._storage.putBitfield(next.offset, next.buffer, ondone)
  }

  this._pollWaiting()

  function ondone (err) {
    if (err) error = err
    if (--missing) return
    cb(error)
  }
}

Feed.prototype._roots = function (index, cb) {
  var roots = flat.fullRoots(2 * index)
  var result = new Array(roots.length)
  var pending = roots.length
  var error = null

  if (!pending) return cb(null, result)

  for (var i = 0; i < roots.length; i++) {
    this._storage.getNode(roots[i], onnode)
  }

  function onnode (err, node) {
    if (err) error = err
    if (node) result[roots.indexOf(node.index)] = node
    if (--pending) return
    if (error) return cb(error)
    cb(null, result)
  }
}

Feed.prototype.audit = function (cb) {
  if (!cb) cb = noop

  var self = this
  var report = {
    valid: 0,
    invalid: 0
  }

  this.ready(function (err) {
    if (err) return cb(err)

    var block = 0
    var max = self.length

    next()

    function onnode (err, node) {
      if (err) return ondata(null, null)
      self._storage.getData(block, ondata)

      function ondata (_, data) {
        var verified = data && crypto.data(data).equals(node.hash)
        if (verified) report.valid++
        else report.invalid++
        self.bitfield.set(block, verified)
        block++
        next()
      }
    }

    function next () {
      while (block < max && !self.bitfield.get(block)) block++
      if (block >= max) return done()
      self._storage.getNode(2 * block, onnode)
    }

    function done () {
      self._sync(null, function (err) {
        if (err) return cb(err)
        cb(null, report)
      })
    }
  })
}

function noop () {}

function verifyNode (trusted, node) {
  return trusted && trusted.index === node.index && Buffer.compare(trusted.hash, node.hash) === 0
}

function addSize (size, node) {
  return size + node.size
}

function isBlock (index) {
  return (index & 1) === 0
}

function defaultStorage (dir) {
  return function (name) {
    try {
      var lock = name === 'bitfield' ? require('fd-lock') : null
    } catch (err) {}
    return raf(name, {directory: dir, lock: lock})
  }
}

function toCodec (enc) {
  // Switch to ndjson encoding if JSON is used. That way data files parse like ndjson \o/
  return codecs(enc === 'json' ? 'ndjson' : enc)
}

function wrapCodec (enc, cb) {
  return function (err, buf) {
    if (err) return cb(err)
    try {
      buf = enc.decode(buf)
    } catch (err) {
      return cb(err)
    }
    cb(null, buf)
  }
}

function timeoutCallback (cb, timeout) {
  var failed = false
  var id = setTimeout(ontimeout, timeout)
  return done

  function ontimeout () {
    failed = true
    // TODO: make libs/errors for all this stuff
    var err = new Error('ETIMEDOUT')
    err.code = 'ETIMEDOUT'
    cb(err)
  }

  function done (err, val) {
    if (failed) return
    clearTimeout(id)
    cb(err, val)
  }
}

function toWantRange (i) {
  return Math.floor(i / 1024 / 1024) * 1024 * 1024
}

function createError (code, errno, msg) {
  var err = new Error(msg)
  err.code = code
  err.errno = errno
  return err
}

}).call(this,require("buffer").Buffer)
},{"./lib/bitfield":58,"./lib/replicate":59,"./lib/safe-buffer-equals":60,"./lib/storage":61,"./lib/tree-index":62,"atomic-batcher":16,"buffer":32,"buffer-alloc-unsafe":28,"buffer-from":31,"bulk-write-stream":33,"codecs":34,"events":27,"fd-lock":26,"flat-tree":50,"from2":51,"hypercore-crypto":53,"inherits":71,"inspect-custom-symbol":72,"last-one-wins":76,"merkle-tree-stream/generator":81,"pretty-hash":92,"process-nextick-args":93,"random-access-file":98,"sparse-bitfield":136,"thunky":63,"unordered-array-remove":148,"unordered-set":64}],58:[function(require,module,exports){
(function (Buffer){
var flat = require('flat-tree')
var rle = require('bitfield-rle')
var pager = require('memory-pager')
var bitfield = require('sparse-bitfield')
var allocUnsafe = require('buffer-alloc-unsafe')

var INDEX_UPDATE_MASK = [63, 207, 243, 252]
var INDEX_ITERATE_MASK = [0, 192, 240, 252]
var DATA_ITERATE_MASK = [128, 192, 224, 240, 248, 252, 254, 255]
var DATA_UPDATE_MASK = [127, 191, 223, 239, 247, 251, 253, 254]
var MAP_PARENT_RIGHT = new Array(256)
var MAP_PARENT_LEFT = new Array(256)
var NEXT_DATA_0_BIT = new Array(256)
var NEXT_INDEX_0_BIT = new Array(256)
var TOTAL_1_BITS = new Array(256)

for (var i = 0; i < 256; i++) {
  var a = (i & (15 << 4)) >> 4
  var b = i & 15
  var nibble = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]
  MAP_PARENT_RIGHT[i] = ((a === 15 ? 3 : a === 0 ? 0 : 1) << 2) | (b === 15 ? 3 : b === 0 ? 0 : 1)
  MAP_PARENT_LEFT[i] = MAP_PARENT_RIGHT[i] << 4
  NEXT_DATA_0_BIT[i] = i === 255 ? -1 : (8 - Math.ceil(Math.log(256 - i) / Math.log(2)))
  NEXT_INDEX_0_BIT[i] = i === 255 ? -1 : Math.floor(NEXT_DATA_0_BIT[i] / 2)
  TOTAL_1_BITS[i] = nibble[i >> 4] + nibble[i & 0x0F]
}

module.exports = Bitfield

function Bitfield (pageSize, pages) {
  if (!(this instanceof Bitfield)) return new Bitfield(pageSize, pages)
  if (!pageSize) pageSize = 2048 + 1024 + 512

  var deduplicate = allocUnsafe(pageSize)
  deduplicate.fill(255)

  this.indexSize = pageSize - 2048 - 1024
  this.pages = pager(pageSize, { deduplicate })

  if (pages) {
    for (var i = 0; i < pages.length; i++) {
      this.pages.set(i, pages[i])
    }
  }

  this.data = bitfield({
    pageSize: 1024,
    pageOffset: 0,
    pages: this.pages,
    trackUpdates: true
  })

  this.tree = bitfield({
    pageSize: 2048,
    pageOffset: 1024,
    pages: this.pages,
    trackUpdates: true
  })

  this.index = bitfield({
    pageSize: this.indexSize,
    pageOffset: 1024 + 2048,
    pages: this.pages,
    trackUpdates: true
  })

  this.length = this.data.length
  this._iterator = flat.iterator(0)
}

Bitfield.prototype.set = function (i, value) {
  var o = i & 7
  i = (i - o) / 8
  var v = value ? this.data.getByte(i) | (128 >> o) : this.data.getByte(i) & DATA_UPDATE_MASK[o]

  if (!this.data.setByte(i, v)) return false
  this.length = this.data.length
  this._setIndex(i, v)
  return true
}

Bitfield.prototype.get = function (i) {
  return this.data.get(i)
}

Bitfield.prototype.total = function (start, end) {
  if (!start || start < 0) start = 0
  if (!end) end = this.data.length
  if (end < start) return 0
  if (end > this.data.length) {
    this._expand(end)
  }
  var o = start & 7
  var e = end & 7
  var pos = (start - o) / 8
  var last = (end - e) / 8
  var leftMask = (255 - (o ? DATA_ITERATE_MASK[o - 1] : 0))
  var rightMask = (e ? DATA_ITERATE_MASK[e - 1] : 0)
  var byte = this.data.getByte(pos)
  if (pos === last) {
    return TOTAL_1_BITS[byte & leftMask & rightMask]
  }
  var total = TOTAL_1_BITS[byte & leftMask]
  for (var i = pos + 1; i < last; i++) {
    total += TOTAL_1_BITS[this.data.getByte(i)]
  }
  total += TOTAL_1_BITS[this.data.getByte(last) & rightMask]
  return total
}

// TODO: use the index to speed this up *a lot*
Bitfield.prototype.compress = function (start, length) {
  if (!start && !length) return rle.encode(this.data.toBuffer())

  var buf = Buffer.alloc(length)
  var p = start / this.data.pageSize / 8
  var end = p + length / this.data.pageSize / 8
  var offset = p * this.data.pageSize

  for (; p < end; p++) {
    var page = this.data.pages.get(p, true)
    if (!page || !page.buffer) continue
    page.buffer.copy(buf, p * this.data.pageSize - offset, this.data.pageOffset, this.data.pageOffset + this.data.pageSize)
  }

  return rle.encode(buf)
}

Bitfield.prototype._setIndex = function (i, value) {
  //                    (a + b | c + d | e + f | g + h)
  // -> (a | b | c | d)                                (e | f | g | h)
  //

  var o = i & 3
  i = (i - o) / 4

  var bitfield = this.index
  var ite = this._iterator
  var start = 2 * i
  var byte = (bitfield.getByte(start) & INDEX_UPDATE_MASK[o]) | (getIndexValue(value) >> (2 * o))
  var len = bitfield.length
  var maxLength = this.pages.length * this.indexSize

  ite.seek(start)

  while (ite.index < maxLength && bitfield.setByte(ite.index, byte)) {
    if (ite.isLeft()) {
      byte = MAP_PARENT_LEFT[byte] | MAP_PARENT_RIGHT[bitfield.getByte(ite.sibling())]
    } else {
      byte = MAP_PARENT_RIGHT[byte] | MAP_PARENT_LEFT[bitfield.getByte(ite.sibling())]
    }
    ite.parent()
  }

  if (len !== bitfield.length) this._expand(len)

  return ite.index !== start
}

Bitfield.prototype._expand = function (len) {
  var roots = flat.fullRoots(2 * len)
  var bitfield = this.index
  var ite = this._iterator
  var byte = 0

  for (var i = 0; i < roots.length; i++) {
    ite.seek(roots[i])
    byte = bitfield.getByte(ite.index)

    do {
      if (ite.isLeft()) {
        byte = MAP_PARENT_LEFT[byte] | MAP_PARENT_RIGHT[bitfield.getByte(ite.sibling())]
      } else {
        byte = MAP_PARENT_RIGHT[byte] | MAP_PARENT_LEFT[bitfield.getByte(ite.sibling())]
      }
    } while (setByteNoAlloc(bitfield, ite.parent(), byte))
  }
}

function setByteNoAlloc (bitfield, i, b) {
  if (8 * i >= bitfield.length) return false
  return bitfield.setByte(i, b)
}

Bitfield.prototype.iterator = function (start, end) {
  var ite = new Iterator(this)

  ite.range(start || 0, end || this.length)
  ite.seek(0)

  return ite
}

function Iterator (bitfield) {
  this.start = 0
  this.end = 0

  this._indexEnd = 0
  this._pos = 0
  this._byte = 0
  this._bitfield = bitfield
}

Iterator.prototype.range = function (start, end) {
  this.start = start
  this.end = end
  this._indexEnd = 2 * Math.ceil(end / 32)

  if (this.end > this._bitfield.length) {
    this._bitfield._expand(this.end)
  }

  return this
}

Iterator.prototype.seek = function (offset) {
  offset += this.start
  if (offset < this.start) offset = this.start

  if (offset >= this.end) {
    this._pos = -1
    return this
  }

  var o = offset & 7

  this._pos = (offset - o) / 8
  this._byte = this._bitfield.data.getByte(this._pos) | (o ? DATA_ITERATE_MASK[o - 1] : 0)

  return this
}

Iterator.prototype.random = function () {
  var i = this.seek(Math.floor(Math.random() * (this.end - this.start))).next()
  return i === -1 ? this.seek(0).next() : i
}

Iterator.prototype.next = function () {
  if (this._pos === -1) return -1

  var dataBitfield = this._bitfield.data
  var free = NEXT_DATA_0_BIT[this._byte]

  while (free === -1) {
    this._byte = dataBitfield.getByte(++this._pos)
    free = NEXT_DATA_0_BIT[this._byte]

    if (free === -1) {
      this._pos = this._skipAhead(this._pos)
      if (this._pos === -1) return -1

      this._byte = dataBitfield.getByte(this._pos)
      free = NEXT_DATA_0_BIT[this._byte]
    }
  }

  this._byte |= DATA_ITERATE_MASK[free]

  var n = 8 * this._pos + free
  return n < this.end ? n : -1
}

Iterator.prototype.peek = function () {
  if (this._pos === -1) return -1

  var free = NEXT_DATA_0_BIT[this._byte]
  var n = 8 * this._pos + free
  return n < this.end ? n : -1
}

Iterator.prototype._skipAhead = function (start) {
  var indexBitfield = this._bitfield.index
  var treeEnd = this._indexEnd
  var ite = this._bitfield._iterator
  var o = start & 3

  ite.seek(2 * ((start - o) / 4))

  var treeByte = indexBitfield.getByte(ite.index) | INDEX_ITERATE_MASK[o]

  while (NEXT_INDEX_0_BIT[treeByte] === -1) {
    if (ite.isLeft()) {
      ite.next()
    } else {
      ite.next()
      ite.parent()
    }

    if (rightSpan(ite) >= treeEnd) {
      while (rightSpan(ite) >= treeEnd && isParent(ite)) ite.leftChild()
      if (rightSpan(ite) >= treeEnd) return -1
    }

    treeByte = indexBitfield.getByte(ite.index)
  }

  while (ite.factor > 2) {
    if (NEXT_INDEX_0_BIT[treeByte] < 2) ite.leftChild()
    else ite.rightChild()

    treeByte = indexBitfield.getByte(ite.index)
  }

  var free = NEXT_INDEX_0_BIT[treeByte]
  if (free === -1) free = 4

  var next = ite.index * 2 + free

  return next <= start ? start + 1 : next
}

function rightSpan (ite) {
  return ite.index + ite.factor / 2 - 1
}

function isParent (ite) {
  return ite.index & 1
}

function getIndexValue (n) {
  switch (n) {
    case 255: return 192
    case 0: return 0
    default: return 64
  }
}

}).call(this,require("buffer").Buffer)
},{"bitfield-rle":18,"buffer":32,"buffer-alloc-unsafe":28,"flat-tree":50,"memory-pager":80,"sparse-bitfield":136}],59:[function(require,module,exports){
var protocol = require('hypercore-protocol')
var bitfield = require('fast-bitfield')
var set = require('unordered-set')
var rle = require('bitfield-rle').align(4)
var safeBufferEquals = require('./safe-buffer-equals')
var treeIndex = require('./tree-index')

var EMPTY = new Uint8Array(1024)

module.exports = replicate

function replicate (feed, opts) {
  var stream = opts.stream

  if (!stream) {
    if (!opts.expectedFeeds) opts.expectedFeeds = 1
    if (!opts.id) opts.id = feed.id
    stream = protocol(opts)
  }

  feed.ready(function (err) {
    if (err) return stream.destroy(err)
    if (stream.destroyed) return

    var peer = new Peer(feed, opts)
    peer.feed = feed
    peer.stream = stream.feed(feed.key, {peer: peer})

    peer.remoteId = stream.remoteId
    stream.setMaxListeners(0)
    stream.on('handshake', function () {
      if (safeBufferEquals(peer.remoteId, stream.remoteId)) {
        return
      }
      peer.remoteId = stream.remoteId
      if (!triggerReady()) {
        peer.feed.emit('remote-update', peer)
      }
    })
    var firstTime = true

    triggerReady()

    function triggerReady () {
      if (firstTime && peer.remoteId) {
        firstTime = false

        // stream might get destroyed on feed init in case of conf errors
        if (stream.destroyed) return false

        peer.ready()
        return true
      }
      return false
    }
  })

  return stream
}

function Peer (feed, opts) {
  this.feed = feed
  this.stream = null // set by replicate just after creation
  this.remoteId = null
  this.wants = bitfield()
  this.remoteBitfield = bitfield()
  this.remoteLength = 0
  this.remoteWant = false
  this.remoteTree = null
  this.live = !!opts.live
  this.sparse = feed.sparse

  this.remoteDownloading = true
  this.downloading = typeof opts.download === 'boolean' ? opts.download : !feed.writable
  this.uploading = true

  this.maxRequests = opts.maxRequests || feed.maxRequests || 16
  this.inflightRequests = []
  this.inflightWants = 0

  this._index = -1
  this._lastBytes = 0
  this._first = true
  this._closed = false
  this._destroyed = false
  this._defaultDownloading = this.downloading
  this._iterator = this.remoteBitfield.iterator()

  this._stats = !opts.stats ? null : {
    uploadedBytes: 0,
    uploadedBlocks: 0,
    downloadedBytes: 0,
    downloadedBlocks: 0
  }
}

Peer.prototype.onwant = function (want) {
  if ((want.start & 8191) || (want.length & 8191)) return
  if (!this.remoteWant && this.feed.length && this.feed.bitfield.get(this.feed.length - 1)) {
    // Eagerly send the length of the feed to the otherside
    // TODO: only send this if the remote is not wanting a region
    // where this is contained in
    this.stream.have({ start: this.feed.length - 1 })
  }
  this.remoteWant = true
  var rle = this.feed.bitfield.compress(want.start, want.length)
  this.stream.have({start: want.start, length: want.length, bitfield: rle})
}

Peer.prototype.ondata = function (data) {
  var self = this

  // Ignore unrequested messages unless we allow push
  // TODO: would be better to check if the byte range was requested instead, but this works fine
  var allowPush = this.feed.allowPush || !data.value
  if (!allowPush && !this.feed._reserved.get(data.index)) {
    // If we do not have this block, send back unhave message for this index,
    // to let the remote know we rejected it.
    // TODO: we might want to have some "unwanted push" threshold to punish spammers
    if (!self.feed.bitfield.get(data.index)) self.unhave({start: data.index})
    self._clear(data.index, !data.value)
    return
  }

  this.feed._putBuffer(data.index, data.value, data, this, function (err) {
    if (err) return self.destroy(err)
    if (data.value) self.remoteBitfield.set(data.index, false)
    if (self._stats && data.value) {
      self._stats.downloadedBlocks += 1
      self._stats.downloadedBytes += data.value.length
    }
    self._clear(data.index, !data.value)
  })
}

Peer.prototype._clear = function (index, hash) {
  // TODO: optimize me (no splice and do not run through all ...)
  for (var i = 0; i < this.inflightRequests.length; i++) {
    if (this.inflightRequests[i].index === index) {
      this.inflightRequests.splice(i, 1)
      i--
    }
  }

  this.feed._reserved.set(index, false)
  // TODO: only update all if we have overlapping selections
  this.feed._updatePeers()
}

Peer.prototype.onrequest = function (request) {
  if (request.bytes) return this._onbytes(request)

  // lazily instantiate the remote tree
  if (!this.remoteTree) this.remoteTree = treeIndex()

  var self = this
  var opts = {digest: request.nodes, hash: request.hash, tree: this.remoteTree}

  this.feed.proof(request.index, opts, onproof)

  function onproof (err, proof) {
    if (err) return self.destroy(err)
    if (request.hash) onvalue(null, null)
    else if (self.feed.bitfield.get(request.index)) self.feed._getBuffer(request.index, onvalue)

    function onvalue (err, value) {
      if (err) return self.destroy(err)

      if (value) {
        if (self._stats) {
          self._stats.uploadedBlocks += 1
          self._stats.uploadedBytes += value.length
          self.feed._stats.uploadedBlocks += 1
          self.feed._stats.uploadedBytes += value.length
        }
        self.feed.emit('upload', request.index, value, self)
      }

      // TODO: prob not needed with new bitfield
      if (request.index + 1 > self.remoteLength) {
        self.remoteLength = request.index + 1
        self._updateEnd()
      }

      self.stream.data({
        index: request.index,
        value: value,
        nodes: proof.nodes,
        signature: proof.signature
      })
    }
  }
}

Peer.prototype._onbytes = function (request) {
  var self = this

  this.feed.seek(request.bytes, {wait: false}, function (err, index) {
    if (err) {
      request.bytes = 0
      self.onrequest(request)
      return
    }

    // quick'n'dirty filter for parallel bytes requests
    // it does not matter that this doesn't catch ALL parallel requests - just a bandwidth optimization
    if (self._lastBytes === request.bytes) return
    self._lastBytes = request.bytes

    request.bytes = 0
    request.index = index
    request.nodes = 0

    self.onrequest(request)
  })
}

Peer.prototype.ontick = function () {
  if (!this.inflightRequests.length) return

  var first = this.inflightRequests[0]
  if (--first.tick) return

  if (first.hash ? this.feed.tree.get(2 * first.index) : this.feed.bitfield.get(first.index)) {
    // prob a bytes response
    this.inflightRequests.shift()
    this.feed._reserved.set(first.index, false)
    return
  }

  this.destroy(new Error('Request timeout'))
}

Peer.prototype.onhave = function (have) {
  var updated = this._first
  if (this._first) this._first = false

  if (have.length === 1024 * 1024) {
    this.inflightWants--
  }

  if (have.bitfield) { // TODO: handle start !== 0
    if (have.length === 0 || have.length === 1) { // length === 1 is for backwards compat
      this.wants = null // we are in backwards compat mode where we subscribe everything
    }
    var buf = rle.decode(have.bitfield)
    var bits = buf.length * 8
    remoteAndNotLocal(this.feed.bitfield, buf, this.remoteBitfield.littleEndian, have.start)
    this.remoteBitfield.fill(buf, have.start)
    if (bits > this.remoteLength) {
      this.remoteLength = this.remoteBitfield.last() + 1
      updated = true
    }
  } else {
    // TODO: if len > something simply copy a 0b1111... buffer to the bitfield

    var start = have.start
    var len = have.length || 1

    while (len--) this.remoteBitfield.set(start, !this.feed.bitfield.get(start++))
    if (start > this.remoteLength) {
      this.remoteLength = start
      updated = true
    }
  }

  if (updated) {
    this.feed.emit('remote-update', this)
  }

  this._updateEnd()
  this.update()
}

Peer.prototype._updateEnd = function () {
  if (this.live || this.feed.sparse || !this.feed._selections.length) return

  var sel = this.feed._selections[0]
  var remoteLength = this.feed.length || -1

  for (var i = 0; i < this.feed.peers.length; i++) {
    if (this.feed.peers[i].remoteLength > remoteLength) {
      remoteLength = this.feed.peers[i].remoteLength
    }
  }

  sel.end = remoteLength
}

Peer.prototype.oninfo = function (info) {
  this.remoteDownloading = info.downloading
  if (info.downloading || this.live) return
  this.update()
  if (this.feed._selections.length && this.downloading) return
  this.end()
}

Peer.prototype.onunhave = function (unhave) {
  var start = unhave.start
  var len = unhave.length || 1

  while (len--) this.remoteBitfield.set(start++, false)
}

Peer.prototype.onunwant =
Peer.prototype.oncancel = function () {
  // TODO: impl all of me
}

Peer.prototype.onclose = function () {
  this.destroy()
}

Peer.prototype.have = function (have) { // called by feed
  if (this.stream && this.remoteWant) this.stream.have(have)
  var start = have.start
  var len = have.length
  while (len--) this.remoteBitfield.set(start++, false)
}

Peer.prototype.unhave = function (unhave) { // called by feed
  if (this.stream && this.remoteWant) this.stream.unhave(unhave)
}

Peer.prototype.haveBytes = function (bytes) { // called by feed
  for (var i = 0; i < this.inflightRequests.length; i++) {
    if (this.inflightRequests[i].bytes === bytes) {
      this.feed._reserved.set(this.inflightRequests[i].index, false)
      this.inflightRequests.splice(i, 1)
      i--
    }
  }

  this.update()
}

Peer.prototype.update = function () {
  // do nothing
  while (this._update()) {}
  this._sendWantsMaybe()
}

Peer.prototype._update = function () {
  // should return true if mutated false if not
  if (!this.downloading) return false

  var selections = this.feed._selections
  var waiting = this.feed._waiting
  var wlen = waiting.length
  var slen = selections.length
  var inflight = this.inflightRequests.length
  var offset = 0
  var i = 0

  // TODO: less duplicate code here
  // TODO: re-add priority levels

  while (inflight < this.maxRequests) {
    offset = Math.floor(Math.random() * waiting.length)

    for (i = 0; i < waiting.length; i++) {
      var w = waiting[offset++]
      if (offset === waiting.length) offset = 0

      this._downloadWaiting(w)
      if (waiting.length !== wlen) return true // mutated
      if (this.inflightRequests.length >= this.maxRequests) return false
    }
    if (inflight === this.inflightRequests.length) break
    inflight = this.inflightRequests.length
  }

  while (inflight < this.maxRequests) {
    offset = Math.floor(Math.random() * selections.length)

    for (i = 0; i < selections.length; i++) {
      var s = selections[offset++]
      if (offset === selections.length) offset = 0

      if (!s.iterator) s.iterator = this.feed.bitfield.iterator(s.start, s.end)
      this._downloadRange(s)
      if (selections.length !== slen) return true // mutated
      if (this.inflightRequests.length >= this.maxRequests) return false
    }

    if (inflight === this.inflightRequests.length) return false
    inflight = this.inflightRequests.length
  }

  return false
}

Peer.prototype.ready = function () {
  set.add(this.feed.peers, this)
  this._sendWants()
  this.feed.emit('peer-add', this)
}

Peer.prototype.end = function () {
  if (!this.downloading && !this.remoteDownloading && !this.live) {
    if (!this._defaultDownloading) {
      this.stream.info({downloading: false, uploading: false})
    }
    this._close()
    return
  }
  if (!this._closed) {
    this._closed = true
    this.downloading = false
    this.stream.info({downloading: false, uploading: true})
  } else {
    if (!this.live) this._close()
  }
}

Peer.prototype._close = function () {
  if (this._index === -1) return
  if (!this._destroyed) {
    this.stream.close()
    this._destroyed = true
  }
  set.remove(this.feed.peers, this)
  this._index = -1
  for (var i = 0; i < this.inflightRequests.length; i++) {
    this.feed._reserved.set(this.inflightRequests[i].index, false)
  }
  this._updateEnd()
  this.remoteWant = false
  this.feed._updatePeers()
  this.feed.emit('peer-remove', this)
}

Peer.prototype.destroy = function (err) {
  if (this._index === -1 || this._destroyed) return
  this.stream.destroy(err)
  this._destroyed = true
  this._close()
}

Peer.prototype._sendWantsMaybe = function () {
  if (this.inflightRequests.length < this.maxRequests) this._sendWants()
}

Peer.prototype._sendWants = function () {
  if (!this.wants || !this.downloading) return
  if (this.inflightWants >= 16) return

  var i

  for (i = 0; i < this.feed._waiting.length; i++) {
    var w = this.feed._waiting[i]
    if (w.index === -1) this._sendWantRange(w)
    else this._sendWant(w.index)
    if (this.inflightWants >= 16) return
  }

  for (i = 0; i < this.feed._selections.length; i++) {
    var s = this.feed._selections[i]
    this._sendWantRange(s)
    if (this.inflightWants >= 16) return
  }

  // always sub to the first range for now, usually what you want
  this._sendWant(0)
}

Peer.prototype._sendWantRange = function (s) {
  var want = 0

  while (true) {
    if (want >= this.remoteLength) return
    if (s.end !== -1 && want >= s.end) return

    if (this._sendWant(want)) return

    // check if region is already selected - if so try next one
    if (!this.wants.get(Math.floor(want / 1024 / 1024))) return
    want += 1024 * 1024
  }
}

Peer.prototype._sendWant = function (index) {
  var len = 1024 * 1024
  var j = Math.floor(index / len)
  if (this.wants.get(j)) return false
  this.wants.set(j, true)
  this.inflightWants++
  this.stream.want({start: j * len, length: len})
  return true
}

Peer.prototype._downloadWaiting = function (wait) {
  if (!wait.bytes) {
    if (!this.remoteBitfield.get(wait.index) || !this.feed._reserved.set(wait.index, true)) return
    this._request(wait.index, 0, false)
    return
  }

  this._downloadRange(wait)
}

Peer.prototype._downloadRange = function (range) {
  if (!range.iterator) range.iterator = this.feed.bitfield.iterator(range.start, range.end)

  var reserved = this.feed._reserved
  var ite = this._iterator
  var wantedEnd = Math.min(range.end === -1 ? this.remoteLength : range.end, this.remoteLength)

  var i = range.linear ? ite.seek(range.start).next(true) : nextRandom(ite, range.start, wantedEnd)
  var start = i

  if (i === -1 || i >= wantedEnd) {
    if (!range.bytes && range.end > -1 && this.feed.length >= range.end && range.iterator.seek(0).next() === -1) {
      set.remove(this.feed._selections, range)
      range.callback(null)
      if (!this.live && !this.sparse && !this.feed._selections.length) this.end()
    }
    return
  }

  while ((range.hash && this.feed.tree.get(2 * i)) || !reserved.set(i, true)) {
    i = ite.next(true)

    if (i > -1 && i < wantedEnd) {
      // check this index
      continue
    }

    if (!range.linear && start !== 0) {
      // retry from the beginning since we are iterating randomly and started !== 0
      i = ite.seek(range.start).next(true)
      start = 0
      if (i > -1 && i < wantedEnd) continue
    }

    // we have checked all indexes.
    // if we are looking for hashes we should check if we have all now (first check only checks blocks)
    if (range.hash) {
      // quick'n'dirty check if have all hashes - can be optimized be checking only tree roots
      // but we don't really request long ranges of hashes so yolo
      for (var j = range.start; j < wantedEnd; j++) {
        if (!this.feed.tree.get(2 * j)) return
      }
      if (!range.bytes) {
        set.remove(this.feed._selections, range)
        range.callback(null)
      }
    }

    // exit the update loop - nothing to do
    return
  }

  this._request(i, range.bytes || 0, range.hash)
}

Peer.prototype._request = function (index, bytes, hash) {
  var request = {
    tick: 6,
    bytes: bytes,
    index: index,
    hash: hash,
    nodes: this.feed.digest(index)
  }

  this.inflightRequests.push(request)
  this.stream.request(request)
}

function createView (page) {
  var buf = page ? page.buffer : EMPTY
  return new DataView(buf.buffer, buf.byteOffset, 1024)
}

function remoteAndNotLocal (local, buf, le, start) {
  var remote = new DataView(buf.buffer, buf.byteOffset)
  var len = Math.floor(buf.length / 4)
  var arr = new Uint32Array(buf.buffer, buf.byteOffset, len)
  var p = start / 8192 // 8192 is bits per bitfield page
  var l = 0
  var page = createView(local.pages.get(p++, true))

  for (var i = 0; i < len; i++) {
    arr[i] = remote.getUint32(4 * i, !le) & ~page.getUint32(4 * (l++), !le)

    if (l === 256) {
      page = createView(local.pages.get(p++, true))
      l = 0
    }
  }
}

function nextRandom (ite, start, end) {
  var len = end - start
  var i = ite.seek(Math.floor(Math.random() * len) + start).next(true)
  return i === -1 || i >= end ? ite.seek(start).next(true) : i
}

},{"./safe-buffer-equals":60,"./tree-index":62,"bitfield-rle":18,"fast-bitfield":49,"hypercore-protocol":55,"unordered-set":64}],60:[function(require,module,exports){
(function (Buffer){
// buffer-equals, but handle 'null' buffer parameters.
module.exports = function safeBufferEquals (a, b) {
  if (!a) return !b
  if (!b) return !a
  return Buffer.compare(a, b) === 0
}

}).call(this,require("buffer").Buffer)
},{"buffer":32}],61:[function(require,module,exports){
var uint64be = require('uint64be')
var flat = require('flat-tree')
var alru = require('array-lru')
var bufferAlloc = require('buffer-alloc-unsafe')
var bufferAllocSafe = require('buffer-alloc')

module.exports = Storage

var noarr = []

function Storage (create, cacheSize) {
  if (!(this instanceof Storage)) return new Storage(create, cacheSize)
  cacheSize = typeof cacheSize === 'undefined' ? 65536 : cacheSize

  this.cache = cacheSize > 0 ? alru(cacheSize, {indexedValues: true}) : null
  this.key = null
  this.secretKey = null
  this.tree = null
  this.data = null
  this.bitfield = null
  this.signatures = null
  this.create = create
}

Storage.prototype.putData = function (index, data, nodes, cb) {
  if (!cb) cb = noop
  var self = this
  if (!data.length) return cb(null)
  this.dataOffset(index, nodes, function (err, offset, size) {
    if (err) return cb(err)
    if (size !== data.length) return cb(new Error('Unexpected data size'))
    self.data.write(offset, data, cb)
  })
}

Storage.prototype.getData = function (index, cb) {
  var self = this
  this.dataOffset(index, noarr, function (err, offset, size) {
    if (err) return cb(err)
    self.data.read(offset, size, cb)
  })
}

Storage.prototype.nextSignature = function (index, cb) {
  var self = this

  this._getSignature(index, function (err, signature) {
    if (err) return cb(err)
    if (isBlank(signature)) return self.nextSignature(index + 1, cb)
    cb(null, { index: index, signature: signature })
  })
}

Storage.prototype.getSignature = function (index, cb) {
  this._getSignature(index, function (err, signature) {
    if (err) return cb(err)
    if (isBlank(signature)) return cb(new Error('No signature found'))
    cb(null, signature)
  })
}

Storage.prototype._getSignature = function (index, cb) {
  this.signatures.read(32 + 64 * index, 64, cb)
}

Storage.prototype.putSignature = function (index, signature, cb) {
  this.signatures.write(32 + 64 * index, signature, cb)
}

Storage.prototype.dataOffset = function (index, cachedNodes, cb) {
  var roots = flat.fullRoots(2 * index)
  var self = this
  var offset = 0
  var pending = roots.length
  var error = null
  var blk = 2 * index

  if (!pending) {
    pending = 1
    onnode(null, null)
    return
  }

  for (var i = 0; i < roots.length; i++) {
    var node = findNode(cachedNodes, roots[i])
    if (node) onnode(null, node)
    else this.getNode(roots[i], onnode)
  }

  function onlast (err, node) {
    if (err) return cb(err)
    cb(null, offset, node.size)
  }

  function onnode (err, node) {
    if (err) error = err
    if (node) offset += node.size
    if (--pending) return

    if (error) return cb(error)

    var last = findNode(cachedNodes, blk)
    if (last) onlast(null, last)
    else self.getNode(blk, onlast)
  }
}

Storage.prototype.getDataBatch = function (start, n, cb) {
  var result = new Array(n)
  var sizes = new Array(n)
  var self = this

  this.dataOffset(start, noarr, function (err, offset, size) {
    if (err) return cb(err)

    start++
    n--

    if (n <= 0) return ontree(null, null)
    self.tree.read(32 + 80 * start, 80 * n - 40, ontree)

    function ontree (err, buf) {
      if (err) return cb(err)

      var total = sizes[0] = size

      if (buf) {
        for (var i = 1; i < sizes.length; i++) {
          sizes[i] = uint64be.decode(buf, 32 + (i - 1) * 80)
          total += sizes[i]
        }
      }

      self.data.read(offset, total, ondata)
    }

    function ondata (err, buf) {
      if (err) return cb(err)
      var total = 0
      for (var i = 0; i < result.length; i++) {
        result[i] = buf.slice(total, total += sizes[i])
      }

      cb(null, result)
    }
  })
}

Storage.prototype.getNode = function (index, cb) {
  if (this.cache) {
    var cached = this.cache.get(index)
    if (cached) return cb(null, cached)
  }

  var self = this

  this.tree.read(32 + 40 * index, 40, function (err, buf) {
    if (err) return cb(err)

    var hash = buf.slice(0, 32)
    var size = uint64be.decode(buf, 32)

    if (!size && isBlank(hash)) return cb(new Error('No node found'))

    var val = new Node(index, hash, size, null)
    if (self.cache) self.cache.set(index, val)
    cb(null, val)
  })
}

Storage.prototype.putNodeBatch = function (index, nodes, cb) {
  if (!cb) cb = noop

  var buf = bufferAllocSafe(nodes.length * 40)

  for (var i = 0; i < nodes.length; i++) {
    var offset = i * 40
    var node = nodes[i]
    if (!node) continue
    node.hash.copy(buf, offset)
    uint64be.encode(node.size, buf, 32 + offset)
  }

  this.tree.write(32 + 40 * index, buf, cb)
}

Storage.prototype.putNode = function (index, node, cb) {
  if (!cb) cb = noop

  // TODO: re-enable put cache. currently this causes a memleak
  // because node.hash is a slice of the big data buffer on replicate
  // if (this.cache) this.cache.set(index, node)

  var buf = bufferAlloc(40)

  node.hash.copy(buf, 0)
  uint64be.encode(node.size, buf, 32)
  this.tree.write(32 + 40 * index, buf, cb)
}

Storage.prototype.putBitfield = function (offset, data, cb) {
  this.bitfield.write(32 + offset, data, cb)
}

Storage.prototype.close = function (cb) {
  if (!cb) cb = noop
  var missing = 6
  var error = null

  close(this.bitfield, done)
  close(this.tree, done)
  close(this.data, done)
  close(this.key, done)
  close(this.secretKey, done)
  close(this.signatures, done)

  function done (err) {
    if (err) error = err
    if (--missing) return
    cb(error)
  }
}

Storage.prototype.openKey = function (opts, cb) {
  if (typeof opts === 'function') return this.openKey({}, opts)
  if (!this.key) this.key = this.create('key', opts)
  this.key.read(0, 32, cb)
}

Storage.prototype.open = function (opts, cb) {
  if (typeof opts === 'function') return this.open({}, opts)

  var self = this
  var error = null
  var missing = 5

  if (!this.key) this.key = this.create('key', opts)
  if (!this.secretKey) this.secretKey = this.create('secret_key', opts)
  if (!this.tree) this.tree = this.create('tree', opts)
  if (!this.data) this.data = this.create('data', opts)
  if (!this.bitfield) this.bitfield = this.create('bitfield', opts)
  if (!this.signatures) this.signatures = this.create('signatures', opts)

  var result = {
    bitfield: [],
    bitfieldPageSize: 3584, // we upgraded the page size to fix a bug
    secretKey: null,
    key: null
  }

  this.bitfield.read(0, 32, function (_, h) {
    if (h) result.bitfieldPageSize = h.readUInt16BE(5)
    self.bitfield.write(0, header(0, result.bitfieldPageSize, null), function (err) {
      if (err) return cb(err)
      readAll(self.bitfield, 32, result.bitfieldPageSize, function (err, pages) {
        if (pages) result.bitfield = pages
        done(err)
      })
    })
  })

  this.signatures.write(0, header(1, 64, 'Ed25519'), done)
  this.tree.write(0, header(2, 40, 'BLAKE2b'), done)

  // TODO: Improve the error handling here.
  // I.e. if secretKey length === 64 and it fails, error

  this.secretKey.read(0, 64, function (_, data) {
    if (data) result.secretKey = data
    done(null)
  })

  this.key.read(0, 32, function (_, data) {
    if (data) result.key = data
    done(null)
  })

  function done (err) {
    if (err) error = err
    if (--missing) return
    if (error) cb(error)
    else cb(null, result)
  }
}

Storage.Node = Node

function noop () {}

function header (type, size, name) {
  var buf = bufferAlloc(32)
  buf.fill(0)

  // magic number
  buf[0] = 5
  buf[1] = 2
  buf[2] = 87
  buf[3] = type

  // version
  buf[4] = 0

  // block size
  buf.writeUInt16BE(size, 5)

  if (name) {
    // algo name
    buf[7] = name.length
    buf.write(name, 8)
  }

  return buf
}

function Node (index, hash, size) {
  this.index = index
  this.hash = hash
  this.size = size
}

function findNode (nodes, index) {
  for (var i = 0; i < nodes.length; i++) {
    if (nodes[i].index === index) return nodes[i]
  }
  return null
}

function isBlank (buf) {
  for (var i = 0; i < buf.length; i++) {
    if (buf[i]) return false
  }
  return true
}

function close (st, cb) {
  if (st.close) st.close(cb)
  else cb()
}

function statAndReadAll (st, offset, pageSize, cb) {
  st.stat(function (err, stat) {
    if (err) return cb(null, [])

    var result = []

    loop(null, null)

    function loop (err, batch) {
      if (err) return cb(err)

      if (batch) {
        offset += batch.length
        for (var i = 0; i < batch.length; i += pageSize) {
          result.push(batch.slice(i, i + pageSize))
        }
      }

      var next = Math.min(stat.size - offset, 32 * pageSize)
      if (!next) return cb(null, result)

      st.read(offset, next, loop)
    }
  })
}

function readAll (st, offset, pageSize, cb) {
  if (st.statable === true) return statAndReadAll(st, offset, pageSize, cb)

  var bufs = []

  st.read(offset, pageSize, loop)

  function loop (err, buf) {
    if (err) return cb(null, bufs)
    bufs.push(buf)
    st.read(offset + bufs.length * pageSize, pageSize, loop)
  }
}

},{"array-lru":11,"buffer-alloc":29,"buffer-alloc-unsafe":28,"flat-tree":50,"uint64be":146}],62:[function(require,module,exports){
var flat = require('flat-tree')
var bitfield = require('sparse-bitfield')

module.exports = TreeIndex

function TreeIndex (bits) {
  if (!(this instanceof TreeIndex)) return new TreeIndex(bits)
  this.bitfield = bits || bitfield()
}

TreeIndex.prototype.proof = function (index, opts) {
  if (!opts) opts = {}

  var nodes = []
  var remoteTree = opts.tree || new TreeIndex()
  var digest = opts.digest || 0

  if (!this.get(index)) return null
  if (opts.hash) nodes.push(index) // always return hash - no matter what the digest says
  if (digest === 1) return {nodes: nodes, verifiedBy: 0}

  var roots = null
  var sibling = index
  var next = index
  var hasRoot = digest & 1
  digest = rightShift(digest)

  while (digest) {
    if (digest === 1 && hasRoot) {
      if (this.get(next)) remoteTree.set(next)

      // having a root implies having prev roots as well
      // TODO: this can be optimized away be only sending "newer" roots,
      // when sending roots
      if (flat.sibling(next) < next) next = flat.sibling(next)
      roots = flat.fullRoots(flat.rightSpan(next) + 2)
      for (var i = 0; i < roots.length; i++) {
        if (this.get(roots[i])) remoteTree.set(roots[i])
      }
      break
    }

    sibling = flat.sibling(next)
    if (digest & 1) {
      if (this.get(sibling)) remoteTree.set(sibling)
    }
    next = flat.parent(next)
    digest = rightShift(digest)
  }

  next = index

  while (!remoteTree.get(next)) {
    sibling = flat.sibling(next)
    if (!this.get(sibling)) {
      // next is a local root
      var verifiedBy = this.verifiedBy(next)
      addFullRoots(verifiedBy, nodes, next, remoteTree)
      return {nodes: nodes, verifiedBy: verifiedBy}
    } else {
      if (!remoteTree.get(sibling)) nodes.push(sibling)
    }

    next = flat.parent(next)
  }

  return {nodes: nodes, verifiedBy: 0}
}

TreeIndex.prototype.digest = function (index) {
  if (this.get(index)) return 1

  var digest = 0
  var next = flat.sibling(index)
  var max = Math.max(next + 2, this.bitfield.length) // TODO: make this less ... hacky

  var bit = 2
  var depth = flat.depth(index)
  var parent = flat.parent(next, depth++)

  while (flat.rightSpan(next) < max || flat.leftSpan(parent) > 0) {
    if (this.get(next)) {
      digest += bit // + cause in this case it's the same as | but works for large nums
    }
    if (this.get(parent)) {
      digest += 2 * bit
      if (!(digest & 1)) digest += 1
      if (digest + 1 === 4 * bit) return 1
      return digest
    }
    next = flat.sibling(parent)
    parent = flat.parent(next, depth++)
    bit *= 2
  }

  return digest
}

TreeIndex.prototype.blocks = function () {
  var top = 0
  var next = 0
  var max = this.bitfield.length

  while (flat.rightSpan(next) < max) {
    next = flat.parent(next)
    if (this.get(next)) top = next
  }

  return (this.get(top) ? this.verifiedBy(top) : 0) / 2
}

TreeIndex.prototype.roots = function () {
  return flat.fullRoots(2 * this.blocks())
}

TreeIndex.prototype.verifiedBy = function (index, nodes) {
  var hasIndex = this.get(index)
  if (!hasIndex) return 0

  // find root of current tree

  var depth = flat.depth(index)
  var top = index
  var parent = flat.parent(top, depth++)
  while (this.get(parent) && this.get(flat.sibling(top))) {
    top = parent
    parent = flat.parent(top, depth++)
  }

  // expand right down

  depth--
  while (depth) {
    top = flat.leftChild(flat.index(depth, flat.offset(top, depth) + 1), depth)
    depth--

    while (!this.get(top) && depth) top = flat.leftChild(top, depth--)
    if (nodes && this.get(top)) nodes.push(top)
  }

  return this.get(top) ? top + 2 : top
}

TreeIndex.prototype.get = function (index) {
  return this.bitfield.get(index)
}

TreeIndex.prototype.set = function (index) {
  if (!this.bitfield.set(index, true)) return false
  while (this.bitfield.get(flat.sibling(index))) {
    index = flat.parent(index)
    if (!this.bitfield.set(index, true)) break
  }
  return true
}

function rightShift (n) {
  return (n - (n & 1)) / 2
}

function addFullRoots (verifiedBy, nodes, root, remoteTree) {
  var roots = flat.fullRoots(verifiedBy)
  for (var i = 0; i < roots.length; i++) {
    if (roots[i] !== root && !remoteTree.get(roots[i])) nodes.push(roots[i])
  }
}

},{"flat-tree":50,"sparse-bitfield":136}],63:[function(require,module,exports){
(function (process){
'use strict'

var nextTick = nextTickArgs
process.nextTick(upgrade, 42) // pass 42 and see if upgrade is called with it

module.exports = thunky

function thunky (fn) {
  var state = run
  return thunk

  function thunk (callback) {
    state(callback || noop)
  }

  function run (callback) {
    var stack = [callback]
    state = wait
    fn(done)

    function wait (callback) {
      stack.push(callback)
    }

    function done (err) {
      var args = arguments
      state = isError(err) ? run : finished
      while (stack.length) finished(stack.shift())

      function finished (callback) {
        nextTick(apply, callback, args)
      }
    }
  }
}

function isError (err) { // inlined from util so this works in the browser
  return Object.prototype.toString.call(err) === '[object Error]'
}

function noop () {}

function apply (callback, args) {
  callback.apply(null, args)
}

function upgrade (val) {
  if (val === 42) nextTick = process.nextTick
}

function nextTickArgs (fn, a, b) {
  process.nextTick(function () {
    fn(a, b)
  })
}

}).call(this,require('_process'))
},{"_process":94}],64:[function(require,module,exports){
exports.add = add
exports.has = has
exports.remove = remove
exports.swap = swap

function add (list, item) {
  if (has(list, item)) return item
  item._index = list.length
  list.push(item)
  return item
}

function has (list, item) {
  return item._index < list.length && list[item._index] === item
}

function remove (list, item) {
  if (!has(list, item)) return null

  var last = list.pop()
  if (last !== item) {
    list[item._index] = last
    last._index = item._index
  }

  return item
}

function swap (list, a, b) {
  if (!has(list, a) || !has(list, b)) return
  var tmp = a._index
  a._index = b._index
  list[a._index] = a
  b._index = tmp
  list[b._index] = b
}

},{}],65:[function(require,module,exports){
(function (process,Buffer){
var hypercore = require('hypercore')
var mutexify = require('mutexify')
var raf = require('random-access-file')
var thunky = require('thunky')
var tree = require('append-tree')
var collect = require('stream-collector')
var sodium = require('sodium-universal')
var inherits = require('inherits')
var events = require('events')
var duplexify = require('duplexify')
var from = require('from2')
var each = require('stream-each')
var uint64be = require('uint64be')
var unixify = require('unixify')
var path = require('path')
var messages = require('./lib/messages')
var stat = require('./lib/stat')
var cursor = require('./lib/cursor')

var DEFAULT_FMODE = (4 | 2 | 0) << 6 | ((4 | 0 | 0) << 3) | (4 | 0 | 0) // rw-r--r--
var DEFAULT_DMODE = (4 | 2 | 1) << 6 | ((4 | 0 | 1) << 3) | (4 | 0 | 1) // rwxr-xr-x

module.exports = Hyperdrive

function Hyperdrive (storage, key, opts) {
  if (!(this instanceof Hyperdrive)) return new Hyperdrive(storage, key, opts)
  events.EventEmitter.call(this)

  if (isObject(key)) {
    opts = key
    key = null
  }

  if (!opts) opts = {}

  this.key = null
  this.discoveryKey = null
  this.live = true
  this.latest = !!opts.latest

  this._storages = defaultStorage(this, storage, opts)

  this.metadata = opts.metadata || hypercore(this._storages.metadata, key, {
    secretKey: opts.secretKey,
    sparse: opts.sparseMetadata,
    createIfMissing: opts.createIfMissing,
    storageCacheSize: opts.metadataStorageCacheSize
  })
  this.content = opts.content || null
  this.maxRequests = opts.maxRequests || 16
  this.readable = true

  this.storage = storage
  this.tree = tree(this.metadata, {
    offset: 1,
    valueEncoding: messages.Stat,
    cache: opts.treeCacheSize !== 0,
    cacheSize: opts.treeCacheSize
  })
  if (typeof opts.version === 'number') this.tree = this.tree.checkout(opts.version)
  this.sparse = !!opts.sparse
  this.sparseMetadata = !!opts.sparseMetadata
  this.indexing = !!opts.indexing
  this.contentStorageCacheSize = opts.contentStorageCacheSize

  this._latestSynced = 0
  this._latestVersion = 0
  this._latestStorage = this.latest ? this._storages.metadata('latest') : null
  this._checkout = opts._checkout
  this._lock = mutexify()

  this._openFiles = []
  this._emittedContent = false
  this._closed = false

  var self = this

  this.metadata.on('append', update)
  this.metadata.on('error', onerror)
  this.ready = thunky(open)
  this.ready(onready)

  function onready (err) {
    if (err) return onerror(err)
    self.emit('ready')
    self._oncontent()
    if (self.latest && !self.metadata.writable) {
      self._trackLatest(function (err) {
        if (self._closed) return
        onerror(err)
      })
    }
  }

  function onerror (err) {
    if (err) self.emit('error', err)
  }

  function update () {
    self.emit('update')
  }

  function open (cb) {
    self._open(cb)
  }
}

inherits(Hyperdrive, events.EventEmitter)

Object.defineProperty(Hyperdrive.prototype, 'version', {
  enumerable: true,
  get: function () {
    return this._checkout ? this.tree.version : (this.metadata.length ? this.metadata.length - 1 : 0)
  }
})

Object.defineProperty(Hyperdrive.prototype, 'writable', {
  enumerable: true,
  get: function () {
    return this.metadata.writable
  }
})

Hyperdrive.prototype._oncontent = function () {
  if (!this.content || this._emittedContent) return
  this._emittedContent = true
  this.emit('content')
}

Hyperdrive.prototype._trackLatest = function (cb) {
  var self = this

  this.ready(function (err) {
    if (err) return cb(err)

    self._latestStorage.read(0, 8, function (_, data) {
      self._latestVersion = data ? uint64be.decode(data) : 0
      loop()
    })
  })

  function loop (err) {
    if (err) return cb(err)

    if (stableVersion()) return fetch()

    // TODO: lock downloading while doing this
    self._clearDangling(self._latestVersion, self.version, onclear)
  }

  function fetch () {
    if (self.sparse) {
      if (stableVersion()) return self.metadata.update(loop)
      return loop(null)
    }

    self.emit('syncing')
    self._fetchVersion(self._latestSynced, function (err, fullySynced) {
      if (err) return cb(err)

      if (fullySynced) {
        self._latestSynced = self._latestVersion
        self.emit('sync')
        if (!self._checkout) self.metadata.update(loop) // TODO: only if live
        return
      }

      loop(null)
    })
  }

  function onclear (err, version) {
    if (err) return cb(err)
    self._latestVersion = version
    self._latestStorage.write(0, uint64be.encode(self._latestVersion), loop)
  }

  function stableVersion () {
    var latest = self.version
    return latest < 0 || self._latestVersion === latest
  }
}

Hyperdrive.prototype._fetchVersion = function (prev, cb) {
  var self = this
  var version = self.version
  var updated = false
  var done = false
  var error = null
  var stream = null
  var queued = 0
  var maxQueued = 64

  var waitingData = null
  var waitingCallback = null

  this.metadata.update(function () {
    updated = true
    if (queued > 0) queued = 0
    if (stream) stream.destroy()
    kick()
  })

  this._ensureContent(function (err) {
    if (err) return cb(err)
    if (updated) return cb(null, false)

    // var snapshot = self.checkout(version)
    stream = self.tree.checkout(prev).diff(version, {puts: true, dels: false})
    each(stream, ondata, ondone)
  })

  function ondata (data, next) {
    if (updated || error) return callAndKick(next, new Error('Out of date'))

    if (queued >= maxQueued) {
      waitingData = data
      waitingCallback = next
      return
    }

    var start = data.value.offset
    var end = start + data.value.blocks

    if (start === end) return callAndKick(next, null)

    queued++
    self.content.download({start: start, end: end}, function (err) {
      if (updated && !waitingCallback) return kick()
      if (!updated) queued--

      if (waitingCallback) {
        data = waitingData
        waitingData = null
        next = waitingCallback
        waitingCallback = null
        return ondata(data, next)
      }

      if (err) {
        stream.destroy(err)
        error = err
      }

      kick()
    })

    process.nextTick(next)
  }

  function callAndKick (next, err) {
    next(err)
    kick()
  }

  function kick () {
    if (!done || queued) return
    queued = -1 // so we don't enter this twice

    if (updated) return cb(null, false)
    if (error) return cb(error)

    cb(null, version === self.version)
  }

  function ondone (err) {
    if (err) error = err
    done = true
    kick()
  }
}

Hyperdrive.prototype._clearDangling = function (a, b, cb) {
  var current = this.tree.checkout(a, {cached: true})
  var latest = this.tree.checkout(b)
  var stream = current.diff(latest, {dels: true, puts: false})
  var self = this

  this._ensureContent(oncontent)

  function done (err) {
    if (err) return cb(err)
    cb(null, b)
  }

  function oncontent (err) {
    if (err) return cb(err)
    each(stream, ondata, done)
  }

  function ondata (data, next) {
    var st = data.value
    self.content.cancel(st.offset, st.offset + st.blocks)
    self.content.clear(st.offset, st.offset + st.blocks, {byteOffset: st.byteOffset, byteLength: st.size}, next)
  }
}

Hyperdrive.prototype.replicate = function (opts) {
  if (!opts) opts = {}

  opts.expectedFeeds = 2

  var self = this
  var stream = this.metadata.replicate(opts)

  this._ensureContent(function (err) {
    if (err) return stream.destroy(err)
    if (stream.destroyed) return
    self.content.replicate({
      live: opts.live,
      download: opts.download,
      upload: opts.upload,
      stream: stream
    })
  })

  return stream
}

Hyperdrive.prototype.checkout = function (version, opts) {
  if (!opts) opts = {}
  opts._checkout = this._checkout || this
  opts.metadata = this.metadata
  opts.version = version
  return Hyperdrive(null, null, opts)
}

Hyperdrive.prototype.createDiffStream = function (version, opts) {
  if (!version) version = 0
  if (typeof version === 'number') version = this.checkout(version)
  return this.tree.diff(version.tree, opts)
}

Hyperdrive.prototype.download = function (dir, cb) {
  if (typeof dir === 'function') return this.download('/', dir)

  var downloadCount = 1
  var self = this

  download(dir || '/')

  function download (entry) {
    self.stat(entry, function (err, stat) {
      if (err) {
        if (cb) cb(err)
        return
      }
      if (stat.isDirectory()) return downloadDir(entry, stat)
      if (stat.isFile()) return downloadFile(entry, stat)
    })
  }

  function downloadDir (dirname, stat) {
    self.readdir(dirname, function (err, entries) {
      if (err) {
        if (cb) cb(err)
        return
      }
      downloadCount -= 1
      downloadCount += entries.length
      entries.forEach(function (entry) {
        download(path.join(dirname, entry))
      })
      if (downloadCount <= 0 && cb) cb()
    })
  }

  function downloadFile (entry, stat) {
    var start = stat.offset
    var end = stat.offset + stat.blocks
    if (start === 0 && end === 0) return
    self.content.download({start, end}, function () {
      downloadCount -= 1
      if (downloadCount <= 0 && cb) cb()
    })
  }
}

Hyperdrive.prototype.history = function (opts) {
  return this.tree.history(opts)
}

Hyperdrive.prototype.createCursor = function (name, opts) {
  return cursor(this, name, opts)
}

// open -> fd
Hyperdrive.prototype.open = function (name, flags, mode, opts, cb) {
  if (typeof mode === 'object' && mode) return this.open(name, flags, 0, mode, opts)
  if (typeof mode === 'function') return this.open(name, flags, 0, mode)
  if (typeof opts === 'function') return this.open(name, flags, mode, null, opts)

  // TODO: use flags, only readable cursors are supported atm
  var cursor = this.createCursor(name, opts)
  var self = this

  cursor.open(function (err) {
    if (err) return cb(err)

    var fd = self._openFiles.indexOf(null)
    if (fd === -1) fd = self._openFiles.push(null) - 1

    self._openFiles[fd] = cursor
    cb(null, fd + 20) // offset all fds with 20, unsure what the actual good offset is
  })
}

Hyperdrive.prototype.read = function (fd, buf, offset, len, pos, cb) {
  var cursor = this._openFiles[fd - 20]
  if (!cursor) return cb(new Error('Bad file descriptor'))

  if (pos !== null) cursor.seek(pos)

  cursor.next(function (err, next) {
    if (err) return cb(err)

    if (!next) return cb(null, 0, buf)

    // if we read too much
    if (next.length > len) {
      next = next.slice(0, len)
      cursor.seek(pos + len)
    }

    next.copy(buf, offset, 0, len)
    cb(null, next.length, buf)
  })
}

// TODO: move to ./lib
Hyperdrive.prototype.createReadStream = function (name, opts) {
  if (!opts) opts = {}

  name = normalizePath(name)

  var self = this
  var downloaded = false
  var first = true
  var start = 0
  var end = 0
  var offset = 0
  var length = typeof opts.end === 'number' ? 1 + opts.end - (opts.start || 0) : typeof opts.length === 'number' ? opts.length : -1
  var range = null
  var ended = false
  var stream = from(read)
  var cached = opts && !!opts.cached

  stream.on('close', cleanup)
  stream.on('end', cleanup)

  return stream

  function cleanup () {
    if (range) self.content.undownload(range, noop)
    range = null
    ended = true
  }

  function read (size, cb) {
    if (first) return open(size, cb)
    if (start === end || length === 0) return cb(null, null)

    self.content.get(start++, {wait: !downloaded && !cached}, function (err, data) {
      if (err) return cb(err)
      if (offset) data = data.slice(offset)
      offset = 0
      if (length > -1) {
        if (length < data.length) data = data.slice(0, length)
        length -= data.length
      }
      cb(null, data)
    })
  }

  function open (size, cb) {
    first = false
    self._ensureContent(function (err) {
      if (err) return cb(err)

      // if running latest === true and a delete happens while getting the tree data, the tree.get
      // should finish before the delete so there shouldn't be an rc. we should test this though.
      self.tree.get(name, ontree)

      function ontree (err, stat) {
        if (err) return cb(err)
        if (ended || stream.destroyed) return

        start = stat.offset
        end = stat.offset + stat.blocks

        var byteOffset = stat.byteOffset
        var missing = 1

        if (opts.start) self.content.seek(byteOffset + opts.start, {start: start, end: end}, onstart)
        else onstart(null, start, 0)

        function onend (err, index) {
          if (err || !range) return
          if (ended || stream.destroyed) return

          missing++
          self.content.undownload(range)
          range = self.content.download({start: start, end: index, linear: true}, ondownload)
        }

        function onstart (err, index, off) {
          if (err) return cb(err)
          if (ended || stream.destroyed) return

          offset = off
          start = index
          range = self.content.download({start: start, end: end, linear: true}, ondownload)

          if (length > -1 && length < stat.size) {
            self.content.seek(byteOffset + length, {start: start, end: end}, onend)
          }

          read(size, cb)
        }

        function ondownload (err) {
          if (--missing) return
          if (err && !ended && !downloaded) stream.destroy(err)
          else downloaded = true
        }
      }
    })
  }
}

Hyperdrive.prototype.readFile = function (name, opts, cb) {
  if (typeof opts === 'function') return this.readFile(name, null, opts)
  if (typeof opts === 'string') opts = {encoding: opts}
  if (!opts) opts = {}

  name = normalizePath(name)

  collect(this.createReadStream(name, opts), function (err, bufs) {
    if (err) return cb(err)
    var buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs)
    cb(null, opts.encoding && opts.encoding !== 'binary' ? buf.toString(opts.encoding) : buf)
  })
}

Hyperdrive.prototype.createWriteStream = function (name, opts) {
  if (!opts) opts = {}

  name = normalizePath(name)

  var self = this
  var proxy = duplexify()

  // TODO: support piping through a "split" stream like rabin

  proxy.setReadable(false)
  this._ensureContent(function (err) {
    if (err) return proxy.destroy(err)
    if (self._checkout) return proxy.destroy(new Error('Cannot write to a checkout'))
    if (proxy.destroyed) return

    self._lock(function (release) {
      if (!self.latest || proxy.destroyed) return append(null)

      self.tree.get(name, function (err, st) {
        if (err && err.notFound) return append(null)
        if (err) return append(err)
        if (!st.size) return append(null)
        self.content.clear(st.offset, st.offset + st.blocks, append)
      })

      function append (err) {
        if (err) proxy.destroy(err)
        if (proxy.destroyed) return release()

        // No one should mutate the content other than us
        var byteOffset = self.content.byteLength
        var offset = self.content.length

        self.emit('appending', name, opts)

        // TODO: revert the content feed if this fails!!!! (add an option to the write stream for this (atomic: true))
        var stream = self.content.createWriteStream()

        proxy.on('close', done)
        proxy.on('finish', done)

        proxy.setWritable(stream)
        proxy.on('prefinish', function () {
          var st = {
            mode: (opts.mode || DEFAULT_FMODE) | stat.IFREG,
            uid: opts.uid || 0,
            gid: opts.gid || 0,
            size: self.content.byteLength - byteOffset,
            blocks: self.content.length - offset,
            offset: offset,
            byteOffset: byteOffset,
            mtime: getTime(opts.mtime),
            ctime: getTime(opts.ctime)
          }

          proxy.cork()
          self.tree.put(name, st, function (err) {
            if (err) return proxy.destroy(err)
            self.emit('append', name, opts)
            proxy.uncork()
          })
        })
      }

      function done () {
        proxy.removeListener('close', done)
        proxy.removeListener('finish', done)
        release()
      }
    })
  })

  return proxy
}

Hyperdrive.prototype.writeFile = function (name, buf, opts, cb) {
  if (typeof opts === 'function') return this.writeFile(name, buf, null, opts)
  if (typeof opts === 'string') opts = {encoding: opts}
  if (!opts) opts = {}
  if (typeof buf === 'string') buf = new Buffer(buf, opts.encoding || 'utf-8')
  if (!cb) cb = noop

  name = normalizePath(name)

  var bufs = split(buf) // split the input incase it is a big buffer.
  var stream = this.createWriteStream(name, opts)
  stream.on('error', cb)
  stream.on('finish', cb)
  for (var i = 0; i < bufs.length; i++) stream.write(bufs[i])
  stream.end()
}

Hyperdrive.prototype.mkdir = function (name, opts, cb) {
  if (typeof opts === 'function') return this.mkdir(name, null, opts)
  if (typeof opts === 'number') opts = {mode: opts}
  if (!opts) opts = {}
  if (!cb) cb = noop

  name = normalizePath(name)

  var self = this

  this.ready(function (err) {
    if (err) return cb(err)
    if (self._checkout) return cb(new Error('Cannot write to a checkout'))

    self._lock(function (release) {
      var st = {
        mode: (opts.mode || DEFAULT_DMODE) | stat.IFDIR,
        uid: opts.uid,
        gid: opts.gid,
        mtime: getTime(opts.mtime),
        ctime: getTime(opts.ctime),
        offset: self.content.length,
        byteOffset: self.content.byteLength
      }

      self.tree.put(name, st, function (err) {
        release(cb, err)
      })
    })
  })
}

Hyperdrive.prototype._statDirectory = function (name, opts, cb) {
  this.tree.list(name, opts, function (err, list) {
    if (name !== '/' && (err || !list.length)) return cb(err || new Error(name + ' could not be found'))
    var st = stat()
    st.mode = stat.IFDIR | DEFAULT_DMODE
    cb(null, st)
  })
}

Hyperdrive.prototype.access = function (name, opts, cb) {
  if (typeof opts === 'function') return this.access(name, null, opts)
  if (!opts) opts = {}
  name = normalizePath(name)
  this.stat(name, opts, function (err) {
    cb(err)
  })
}

Hyperdrive.prototype.exists = function (name, opts, cb) {
  if (typeof opts === 'function') return this.exists(name, null, opts)
  if (!opts) opts = {}
  this.access(name, opts, function (err) {
    cb(!err)
  })
}

Hyperdrive.prototype.lstat = function (name, opts, cb) {
  if (typeof opts === 'function') return this.lstat(name, null, opts)
  if (!opts) opts = {}
  var self = this

  name = normalizePath(name)

  this.tree.get(name, opts, function (err, st) {
    if (err) return self._statDirectory(name, opts, cb)
    cb(null, stat(st))
  })
}

Hyperdrive.prototype.stat = function (name, opts, cb) {
  if (typeof opts === 'function') return this.stat(name, null, opts)
  if (!opts) opts = {}
  this.lstat(name, opts, cb)
}

Hyperdrive.prototype.readdir = function (name, opts, cb) {
  if (typeof opts === 'function') return this.readdir(name, null, opts)

  name = normalizePath(name)

  if (name === '/') return this._readdirRoot(opts, cb) // TODO: should be an option in append-tree prob
  this.tree.list(name, opts, function (err, list) {
    if (err) return cb(err)
    cb(null, sanitizeDirs(list))
  })
}

Hyperdrive.prototype._readdirRoot = function (opts, cb) {
  this.tree.list('/', opts, function (_, list) {
    if (list) return cb(null, sanitizeDirs(list))
    cb(null, [])
  })
}

Hyperdrive.prototype.unlink = function (name, cb) {
  name = normalizePath(name)
  this._del(name, cb || noop)
}

Hyperdrive.prototype.rmdir = function (name, cb) {
  if (!cb) cb = noop

  name = normalizePath(name)

  var self = this

  this.readdir(name, function (err, list) {
    if (err) return cb(err)
    if (list.length) return cb(new Error('Directory is not empty'))
    self._del(name, cb)
  })
}

Hyperdrive.prototype._del = function (name, cb) {
  var self = this

  this._ensureContent(function (err) {
    if (err) return cb(err)

    self._lock(function (release) {
      if (!self.latest) return del(null)
      self.tree.get(name, function (err, value) {
        if (err) return done(err)
        self.content.clear(value.offset, value.offset + value.blocks, del)
      })

      function del (err) {
        if (err) return done(err)
        self.tree.del(name, done)
      }

      function done (err) {
        release(cb, err)
      }
    })
  })
}

Hyperdrive.prototype._closeFile = function (fd, cb) {
  var cursor = this._openFiles[fd - 20]
  if (!cursor) return cb(new Error('Bad file descriptor'))
  this._openFiles[fd - 20] = null
  cursor.close(cb)
}

Hyperdrive.prototype.close = function (fd, cb) {
  if (typeof fd === 'number') return this._closeFile(fd, cb || noop)
  else cb = fd
  if (!cb) cb = noop

  var self = this
  this.ready(function (err) {
    if (err) return cb(err)
    self._closed = true
    self.metadata.close(function (err) {
      if (!self.content) return cb(err)
      self.content.close(cb)
    })
  })
}

Hyperdrive.prototype._ensureContent = function (cb) {
  var self = this

  this.ready(function (err) {
    if (err) return cb(err)
    if (!self.content) return self._loadIndex(cb)
    cb(null)
  })
}

Hyperdrive.prototype._loadIndex = function (cb) {
  var self = this

  if (this._checkout) this._checkout._loadIndex(done)
  else this.metadata.get(0, {valueEncoding: messages.Index}, done)

  function done (err, index) {
    if (err) return cb(err)
    if (self.content) return self.content.ready(cb)

    var keyPair = self.metadata.writable && contentKeyPair(self.metadata.secretKey)
    var opts = contentOptions(self, keyPair && keyPair.secretKey)
    self.content = self._checkout ? self._checkout.content : hypercore(self._storages.content, index.content, opts)
    self.content.on('error', function (err) {
      self.emit('error', err)
    })
    self.content.ready(function (err) {
      if (err) return cb(err)
      self._oncontent()
      cb()
    })
  }
}

Hyperdrive.prototype._open = function (cb) {
  var self = this

  this.tree.ready(function (err) {
    if (err) return cb(err)
    self.metadata.ready(function (err) {
      if (err) return cb(err)
      if (self.content) return cb(null)

      self.key = self.metadata.key
      self.discoveryKey = self.metadata.discoveryKey

      if (!self.metadata.writable || self._checkout) onnotwriteable()
      else onwritable()
    })
  })

  function onnotwriteable () {
    if (self.metadata.has(0)) return self._loadIndex(cb)
    self._loadIndex(noop)
    cb()
  }

  function onwritable () {
    var wroteIndex = self.metadata.has(0)
    if (wroteIndex) return self._loadIndex(cb)

    if (!self.content) {
      var keyPair = contentKeyPair(self.metadata.secretKey)
      var opts = contentOptions(self, keyPair.secretKey)
      self.content = hypercore(self._storages.content, keyPair.publicKey, opts)
      self.content.on('error', function (err) {
        self.emit('error', err)
      })
    }

    self.content.ready(function () {
      if (self.metadata.has(0)) return cb(new Error('Index already written'))
      self.metadata.append(messages.Index.encode({type: 'hyperdrive', content: self.content.key}), cb)
    })
  }
}

function contentOptions (self, secretKey) {
  return {
    sparse: self.sparse || self.latest,
    maxRequests: self.maxRequests,
    secretKey: secretKey,
    storeSecretKey: false,
    indexing: self.metadata.writable && self.indexing,
    storageCacheSize: self.contentStorageCacheSize
  }
}

function isObject (val) {
  return !!val && typeof val !== 'string' && !Buffer.isBuffer(val)
}

function wrap (self, storage) {
  return {
    metadata: function (name, opts) {
      return storage.metadata(name, opts, self)
    },
    content: function (name, opts) {
      return storage.content(name, opts, self)
    }
  }
}

function defaultStorage (self, storage, opts) {
  var folder = ''

  if (typeof storage === 'object' && storage) return wrap(self, storage)

  if (typeof storage === 'string') {
    folder = storage
    storage = raf
  }

  return {
    metadata: function (name) {
      return storage(path.join(folder, 'metadata', name))
    },
    content: function (name) {
      return storage(path.join(folder, 'content', name))
    }
  }
}

function noop () {}

function split (buf) {
  var list = []
  for (var i = 0; i < buf.length; i += 65536) {
    list.push(buf.slice(i, i + 65536))
  }
  return list
}

function getTime (date) {
  if (typeof date === 'number') return date
  if (!date) return Date.now()
  return date.getTime()
}

function normalizePath (p) {
  return unixify(path.resolve('/', p))
}

function sanitizeDirs (list) {
  for (var i = 0; i < list.length; i++) {
    if (!noDots(list[i])) return list.filter(noDots)
  }
  return list
}

function noDots (entry) {
  return entry !== '..' && entry !== '.'
}

function contentKeyPair (secretKey) {
  var seed = new Buffer(sodium.crypto_sign_SEEDBYTES)
  var context = new Buffer('hyperdri') // 8 byte context
  var keyPair = {
    publicKey: new Buffer(sodium.crypto_sign_PUBLICKEYBYTES),
    secretKey: new Buffer(sodium.crypto_sign_SECRETKEYBYTES)
  }

  sodium.crypto_kdf_derive_from_key(seed, 1, context, secretKey)
  sodium.crypto_sign_seed_keypair(keyPair.publicKey, keyPair.secretKey, seed)
  if (seed.fill) seed.fill(0)

  return keyPair
}

}).call(this,require('_process'),require("buffer").Buffer)
},{"./lib/cursor":66,"./lib/messages":67,"./lib/stat":68,"_process":94,"append-tree":8,"buffer":32,"duplexify":47,"events":27,"from2":51,"hypercore":57,"inherits":71,"mutexify":86,"path":91,"random-access-file":98,"sodium-universal":134,"stream-collector":137,"stream-each":138,"thunky":69,"uint64be":146,"unixify":147}],66:[function(require,module,exports){
var thunky = require('thunky')

module.exports = Cursor

function Cursor (archive, name, opts) {
  if (!(this instanceof Cursor)) return new Cursor(archive, name, opts)

  var self = this

  this.name = name
  this.opened = false
  this.position = 0
  this.index = 0
  this.offset = 0
  this.open = thunky(open)

  this._content = null
  this._stat = null
  this._seekTo = 0
  this._seeking = true
  this._start = 0
  this._end = 0
  this._range = null
  this._download = !opts || opts.download !== false

  this.open()

  function open (cb) {
    archive.stat(name, function (err, st) {
      if (err) return cb(err)
      archive._ensureContent(function (err) {
        if (err) return cb(err)
        if (!st.isFile()) return cb(new Error('Not a file'))

        self._content = archive.content
        self._stat = st
        self._start = st.offset
        self._end = st.offset + st.blocks

        if (self._seekTo === 0 && self._download) {
          self._range = self._content.download({start: self._start, end: self._end, linear: true})
        }

        cb(null)
      })
    })
  }
}

Cursor.prototype.seek = function (pos) {
  if (pos === this.position && this._seekTo === -1) return this
  this._seeking = true
  this._seekTo = pos
  return this
}

Cursor.prototype._seek = function (bytes, cb) {
  var self = this

  this.open(function (err) {
    if (err) return cb(err)

    if (bytes < 0) bytes += self._stat.size
    if (bytes < 0) bytes = 0
    if (bytes > self._stat.size) bytes = self._stat.size

    var st = self._stat
    var opts = {start: self._start, end: self._end}

    if (bytes === 0) return onseek(null, self._start, 0)
    if (bytes === self._stat.size) return onseek(self._end, 0)

    self._content.seek(st.byteOffset + bytes, opts, onseek)
  })

  function onseek (err, index, offset) {
    if (err) return cb(err)
    cb(null, bytes, index, offset)
  }
}

Cursor.prototype.next = function (cb) {
  if (this._seeking) this._seekAndNext(cb)
  else this._next(this.position, this.index, this.offset, cb)
}

Cursor.prototype.close = function (cb) {
  if (!cb) cb = noop

  var self = this
  this.open(function (err) {
    if (err) return cb(err)
    if (self._range) self._content.undownload(self._range)
    cb()
  })
}

Cursor.prototype._next = function (pos, index, offset, cb) {
  if (index < this._start || index >= this._end) return cb(null, null)

  var self = this

  this._content.get(this.index, function (err, data) {
    if (err) return cb(err)

    if (offset) {
      data = data.slice(offset)
    }

    self.position = pos + data.length
    self.offset = 0
    self.index++

    cb(null, data)
  })
}

Cursor.prototype._seekAndNext = function (cb) {
  var self = this
  var seekTo = this._seekTo

  this._seek(seekTo, function (err, pos, index, offset) {
    if (err) return cb(err)

    if (seekTo === self._seekTo) {
      self._seeking = false
      self._seekTo = -1
      self.position = pos
      self.index = index
      self.offset = offset

      if (self._download) {
        if (self._range) self._content.undownload(self._range)
        self._range = self._content.download({start: self.index, end: self._end, linear: true})
      }
    }

    self._next(pos, index, offset, cb)
  })
}

function noop () {}

},{"thunky":69}],67:[function(require,module,exports){
(function (Buffer){
// This file is auto generated by the protocol-buffers cli tool

/* eslint-disable quotes */
/* eslint-disable indent */
/* eslint-disable no-redeclare */

// Remember to `npm install --save protocol-buffers-encodings`
var encodings = require('protocol-buffers-encodings')
var varint = encodings.varint
var skip = encodings.skip

var Index = exports.Index = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

var Stat = exports.Stat = {
  buffer: true,
  encodingLength: null,
  encode: null,
  decode: null
}

defineIndex()
defineStat()

function defineIndex () {
  var enc = [
    encodings.string,
    encodings.bytes
  ]

  Index.encodingLength = encodingLength
  Index.encode = encode
  Index.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.type)) throw new Error("type is required")
    var len = enc[0].encodingLength(obj.type)
    length += 1 + len
    if (defined(obj.content)) {
      var len = enc[1].encodingLength(obj.content)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.type)) throw new Error("type is required")
    buf[offset++] = 10
    enc[0].encode(obj.type, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.content)) {
      buf[offset++] = 18
      enc[1].encode(obj.content, buf, offset)
      offset += enc[1].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      type: "",
      content: null
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.type = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.content = enc[1].decode(buf, offset)
        offset += enc[1].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defineStat () {
  var enc = [
    encodings.varint
  ]

  Stat.encodingLength = encodingLength
  Stat.encode = encode
  Stat.decode = decode

  function encodingLength (obj) {
    var length = 0
    if (!defined(obj.mode)) throw new Error("mode is required")
    var len = enc[0].encodingLength(obj.mode)
    length += 1 + len
    if (defined(obj.uid)) {
      var len = enc[0].encodingLength(obj.uid)
      length += 1 + len
    }
    if (defined(obj.gid)) {
      var len = enc[0].encodingLength(obj.gid)
      length += 1 + len
    }
    if (defined(obj.size)) {
      var len = enc[0].encodingLength(obj.size)
      length += 1 + len
    }
    if (defined(obj.blocks)) {
      var len = enc[0].encodingLength(obj.blocks)
      length += 1 + len
    }
    if (defined(obj.offset)) {
      var len = enc[0].encodingLength(obj.offset)
      length += 1 + len
    }
    if (defined(obj.byteOffset)) {
      var len = enc[0].encodingLength(obj.byteOffset)
      length += 1 + len
    }
    if (defined(obj.mtime)) {
      var len = enc[0].encodingLength(obj.mtime)
      length += 1 + len
    }
    if (defined(obj.ctime)) {
      var len = enc[0].encodingLength(obj.ctime)
      length += 1 + len
    }
    return length
  }

  function encode (obj, buf, offset) {
    if (!offset) offset = 0
    if (!buf) buf = Buffer.allocUnsafe(encodingLength(obj))
    var oldOffset = offset
    if (!defined(obj.mode)) throw new Error("mode is required")
    buf[offset++] = 8
    enc[0].encode(obj.mode, buf, offset)
    offset += enc[0].encode.bytes
    if (defined(obj.uid)) {
      buf[offset++] = 16
      enc[0].encode(obj.uid, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.gid)) {
      buf[offset++] = 24
      enc[0].encode(obj.gid, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.size)) {
      buf[offset++] = 32
      enc[0].encode(obj.size, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.blocks)) {
      buf[offset++] = 40
      enc[0].encode(obj.blocks, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.offset)) {
      buf[offset++] = 48
      enc[0].encode(obj.offset, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.byteOffset)) {
      buf[offset++] = 56
      enc[0].encode(obj.byteOffset, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.mtime)) {
      buf[offset++] = 64
      enc[0].encode(obj.mtime, buf, offset)
      offset += enc[0].encode.bytes
    }
    if (defined(obj.ctime)) {
      buf[offset++] = 72
      enc[0].encode(obj.ctime, buf, offset)
      offset += enc[0].encode.bytes
    }
    encode.bytes = offset - oldOffset
    return buf
  }

  function decode (buf, offset, end) {
    if (!offset) offset = 0
    if (!end) end = buf.length
    if (!(end <= buf.length && offset <= buf.length)) throw new Error("Decoded message is not valid")
    var oldOffset = offset
    var obj = {
      mode: 0,
      uid: 0,
      gid: 0,
      size: 0,
      blocks: 0,
      offset: 0,
      byteOffset: 0,
      mtime: 0,
      ctime: 0
    }
    var found0 = false
    while (true) {
      if (end <= offset) {
        if (!found0) throw new Error("Decoded message is not valid")
        decode.bytes = offset - oldOffset
        return obj
      }
      var prefix = varint.decode(buf, offset)
      offset += varint.decode.bytes
      var tag = prefix >> 3
      switch (tag) {
        case 1:
        obj.mode = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        found0 = true
        break
        case 2:
        obj.uid = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 3:
        obj.gid = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 4:
        obj.size = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 5:
        obj.blocks = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 6:
        obj.offset = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 7:
        obj.byteOffset = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 8:
        obj.mtime = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        case 9:
        obj.ctime = enc[0].decode(buf, offset)
        offset += enc[0].decode.bytes
        break
        default:
        offset = skip(prefix & 7, buf, offset)
      }
    }
  }
}

function defined (val) {
  return val !== null && val !== undefined && (typeof val !== 'number' || !isNaN(val))
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"protocol-buffers-encodings":95}],68:[function(require,module,exports){
// http://man7.org/linux/man-pages/man2/stat.2.html

module.exports = Stat

function Stat (data) {
  if (!(this instanceof Stat)) return new Stat(data)

  this.dev = 0
  this.nlink = 1
  this.rdev = 0
  this.blksize = 0
  this.ino = 0

  this.mode = data ? data.mode : 0
  this.uid = data ? data.uid : 0
  this.gid = data ? data.gid : 0
  this.size = data ? data.size : 0
  this.offset = data ? data.offset : 0
  this.byteOffset = data ? data.byteOffset : 0
  this.blocks = data ? data.blocks : 0
  this.atime = new Date(data ? data.mtime : 0) // we just set this to mtime ...
  this.mtime = new Date(data ? data.mtime : 0)
  this.ctime = new Date(data ? data.ctime : 0)

  this.linkname = data ? data.linkname : null
}

Stat.IFSOCK = 49152 // 0b1100...
Stat.IFLNK = 40960 // 0b1010...
Stat.IFREG = 32768 // 0b1000...
Stat.IFBLK = 24576 // 0b0110...
Stat.IFDIR = 16384 // 0b0100...
Stat.IFCHR = 8192 // 0b0010...
Stat.IFIFO = 4096 // 0b0001...

Stat.prototype.isSocket = check(Stat.IFSOCK)
Stat.prototype.isSymbolicLink = check(Stat.IFLNK)
Stat.prototype.isFile = check(Stat.IFREG)
Stat.prototype.isBlockDevice = check(Stat.IFBLK)
Stat.prototype.isDirectory = check(Stat.IFDIR)
Stat.prototype.isCharacterDevice = check(Stat.IFCHR)
Stat.prototype.isFIFO = check(Stat.IFIFO)

function check (mask) {
  return function () {
    return (mask & this.mode) === mask
  }
}

},{}],69:[function(require,module,exports){
arguments[4][63][0].apply(exports,arguments)
},{"_process":94,"dup":63}],70:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],71:[function(require,module,exports){
arguments[4][13][0].apply(exports,arguments)
},{"dup":13}],72:[function(require,module,exports){
module.exports = Symbol.for('util.inspect.custom')

},{}],73:[function(require,module,exports){
/*!
 * Determine if an object is a Buffer
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */

// The _isBuffer check is for Safari 5-7 support, because it's missing
// Object.prototype.constructor. Remove this eventually
module.exports = function (obj) {
  return obj != null && (isBuffer(obj) || isSlowBuffer(obj) || !!obj._isBuffer)
}

function isBuffer (obj) {
  return !!obj.constructor && typeof obj.constructor.isBuffer === 'function' && obj.constructor.isBuffer(obj)
}

// For Node v0.10 support. Remove this eventually.
function isSlowBuffer (obj) {
  return typeof obj.readFloatLE === 'function' && typeof obj.slice === 'function' && isBuffer(obj.slice(0, 0))
}

},{}],74:[function(require,module,exports){
(function (Buffer){
module.exports = isOptions

function isOptions (opts) {
  return typeof opts === 'object' && opts && !Buffer.isBuffer(opts)
}

}).call(this,{"isBuffer":require("../is-buffer/index.js")})
},{"../is-buffer/index.js":73}],75:[function(require,module,exports){
var toString = {}.toString;

module.exports = Array.isArray || function (arr) {
  return toString.call(arr) == '[object Array]';
};

},{}],76:[function(require,module,exports){
module.exports = function (work) {
  var pending = null
  var callback = null
  var callbacks = null
  var next = null

  return function (val, cb) {
    next = val
    update(cb || noop)
  }

  function update (cb) {
    if (callback) {
      if (!pending) pending = []
      pending.push(cb)
      return
    }

    var val = next
    next = null
    callback = cb
    work(val, done)
  }

  function done (err) {
    var cb = callback
    var cbs = callbacks
    callbacks = null
    callback = null

    if (pending) {
      callbacks = pending
      pending = null
      update(noop)
    }

    if (cbs) {
      for (var i = 0; i < cbs.length; i++) cbs[i](err)
    }
    cb(err)
  }
}

function noop (_) {}

},{}],77:[function(require,module,exports){
var varint = require('varint')
var stream = require('readable-stream')
var util = require('util')
var bufferAlloc = require('buffer-alloc-unsafe')

var Decoder = function (opts) {
  if (!(this instanceof Decoder)) return new Decoder(opts)
  stream.Transform.call(this)

  this._destroyed = false
  this._missing = 0
  this._message = null
  this._limit = opts && opts.limit || 0
  this._allowEmpty = !!(opts && opts.allowEmpty)
  this._prefix = bufferAlloc(this._limit ? varint.encodingLength(this._limit) : 100)
  this._ptr = 0

  if (this._allowEmpty) {
    this._readableState.highWaterMark = 16
    this._readableState.objectMode = true
  }
}

util.inherits(Decoder, stream.Transform)

Decoder.prototype._push = function (message) {
  this._ptr = 0
  this._missing = 0
  this._message = null
  this.push(message)
}

Decoder.prototype._parseLength = function (data, offset) {
  for (offset; offset < data.length; offset++) {
    if (this._ptr >= this._prefix.length) return this._prefixError(data)
    this._prefix[this._ptr++] = data[offset]
    if (!(data[offset] & 0x80)) {
      this._missing = varint.decode(this._prefix)
      if (this._limit && this._missing > this._limit) return this._prefixError(data)
      if (!this._missing && this._allowEmpty) this._push(bufferAlloc(0))
      this._ptr = 0
      return offset + 1
    }
  }
  return data.length
}

Decoder.prototype._prefixError = function (data) {
  this.destroy(new Error('Message is larger than max length'))
  return data.length
}

Decoder.prototype._parseMessage = function (data, offset) {
  var free = data.length - offset
  var missing = this._missing

  if (!this._message) {
    if (missing <= free) { // fast track - no copy
      this._push(data.slice(offset, offset + missing))
      return offset + missing
    }
    this._message = bufferAlloc(missing)
  }

  // TODO: add opt-in "partial mode" to completely avoid copys
  data.copy(this._message, this._ptr, offset, offset + missing)

  if (missing <= free) {
    this._push(this._message)
    return offset + missing
  }

  this._missing -= free
  this._ptr += free

  return data.length
}

Decoder.prototype._transform = function (data, enc, cb) {
  var offset = 0

  while (!this._destroyed && offset < data.length) {
    if (this._missing) offset = this._parseMessage(data, offset)
    else offset = this._parseLength(data, offset)
  }

  cb()
}

Decoder.prototype.destroy = function (err) {
  if (this._destroyed) return
  this._destroyed = true
  if (err) this.emit('error', err)
  this.emit('close')
}

module.exports = Decoder

},{"buffer-alloc-unsafe":28,"readable-stream":116,"util":151,"varint":154}],78:[function(require,module,exports){
var varint = require('varint')
var stream = require('readable-stream')
var util = require('util')
var bufferAlloc = require('buffer-alloc-unsafe')

var pool = bufferAlloc(10 * 1024)
var used = 0

var Encoder = function () {
  if (!(this instanceof Encoder)) return new Encoder()
  stream.Transform.call(this)
  this._destroyed = false
}

util.inherits(Encoder, stream.Transform)

Encoder.prototype._transform = function (data, enc, cb) {
  if (this._destroyed) return cb()

  varint.encode(data.length, pool, used)
  used += varint.encode.bytes

  this.push(pool.slice(used - varint.encode.bytes, used))
  this.push(data)

  if (pool.length - used < 100) {
    pool = bufferAlloc(10 * 1024)
    used = 0
  }

  cb()
}

Encoder.prototype.destroy = function (err) {
  if (this._destroyed) return
  this._destroyed = true
  if (err) this.emit('error', err)
  this.emit('close')
}

module.exports = Encoder

},{"buffer-alloc-unsafe":28,"readable-stream":116,"util":151,"varint":154}],79:[function(require,module,exports){
exports.encode = require('./encode')
exports.decode = require('./decode')

},{"./decode":77,"./encode":78}],80:[function(require,module,exports){
(function (Buffer){
module.exports = Pager

function Pager (pageSize, opts) {
  if (!(this instanceof Pager)) return new Pager(pageSize, opts)

  this.length = 0
  this.updates = []
  this.path = new Uint16Array(4)
  this.pages = new Array(32768)
  this.maxPages = this.pages.length
  this.level = 0
  this.pageSize = pageSize || 1024
  this.deduplicate = opts ? opts.deduplicate : null
  this.zeros = this.deduplicate ? alloc(this.deduplicate.length) : null
}

Pager.prototype.updated = function (page) {
  while (this.deduplicate && page.buffer[page.deduplicate] === this.deduplicate[page.deduplicate]) {
    page.deduplicate++
    if (page.deduplicate === this.deduplicate.length) {
      page.deduplicate = 0
      if (page.buffer.equals && page.buffer.equals(this.deduplicate)) page.buffer = this.deduplicate
      break
    }
  }
  if (page.updated || !this.updates) return
  page.updated = true
  this.updates.push(page)
}

Pager.prototype.lastUpdate = function () {
  if (!this.updates || !this.updates.length) return null
  var page = this.updates.pop()
  page.updated = false
  return page
}

Pager.prototype._array = function (i, noAllocate) {
  if (i >= this.maxPages) {
    if (noAllocate) return
    grow(this, i)
  }

  factor(i, this.path)

  var arr = this.pages

  for (var j = this.level; j > 0; j--) {
    var p = this.path[j]
    var next = arr[p]

    if (!next) {
      if (noAllocate) return
      next = arr[p] = new Array(32768)
    }

    arr = next
  }

  return arr
}

Pager.prototype.get = function (i, noAllocate) {
  var arr = this._array(i, noAllocate)
  var first = this.path[0]
  var page = arr && arr[first]

  if (!page && !noAllocate) {
    page = arr[first] = new Page(i, alloc(this.pageSize))
    if (i >= this.length) this.length = i + 1
  }

  if (page && page.buffer === this.deduplicate && this.deduplicate && !noAllocate) {
    page.buffer = copy(page.buffer)
    page.deduplicate = 0
  }

  return page
}

Pager.prototype.set = function (i, buf) {
  var arr = this._array(i, false)
  var first = this.path[0]

  if (i >= this.length) this.length = i + 1

  if (!buf || (this.zeros && buf.equals && buf.equals(this.zeros))) {
    arr[first] = undefined
    return
  }

  if (this.deduplicate && buf.equals && buf.equals(this.deduplicate)) {
    buf = this.deduplicate
  }

  var page = arr[first]
  var b = truncate(buf, this.pageSize)

  if (page) page.buffer = b
  else arr[first] = new Page(i, b)
}

Pager.prototype.toBuffer = function () {
  var list = new Array(this.length)
  var empty = alloc(this.pageSize)
  var ptr = 0

  while (ptr < list.length) {
    var arr = this._array(ptr, true)
    for (var i = 0; i < 32768 && ptr < list.length; i++) {
      list[ptr++] = (arr && arr[i]) ? arr[i].buffer : empty
    }
  }

  return Buffer.concat(list)
}

function grow (pager, index) {
  while (pager.maxPages < index) {
    var old = pager.pages
    pager.pages = new Array(32768)
    pager.pages[0] = old
    pager.level++
    pager.maxPages *= 32768
  }
}

function truncate (buf, len) {
  if (buf.length === len) return buf
  if (buf.length > len) return buf.slice(0, len)
  var cpy = alloc(len)
  buf.copy(cpy)
  return cpy
}

function alloc (size) {
  if (Buffer.alloc) return Buffer.alloc(size)
  var buf = new Buffer(size)
  buf.fill(0)
  return buf
}

function copy (buf) {
  var cpy = Buffer.allocUnsafe ? Buffer.allocUnsafe(buf.length) : new Buffer(buf.length)
  buf.copy(cpy)
  return cpy
}

function Page (i, buf) {
  this.offset = i * buf.length
  this.buffer = buf
  this.updated = false
  this.deduplicate = 0
}

function factor (n, out) {
  n = (n - (out[0] = (n & 32767))) / 32768
  n = (n - (out[1] = (n & 32767))) / 32768
  out[3] = ((n - (out[2] = (n & 32767))) / 32768) & 32767
}

}).call(this,require("buffer").Buffer)
},{"buffer":32}],81:[function(require,module,exports){
(function (Buffer){
// a more low level interface to the merkle tree stream.
// useful for certain applications the require non-streamy access to the algos.
// versioned by the same semver as the stream interface.

var flat = require('flat-tree')

module.exports = MerkleGenerator

function MerkleGenerator (opts, roots) {
  if (!(this instanceof MerkleGenerator)) return new MerkleGenerator(opts, roots)
  if (!opts || !opts.leaf || !opts.parent) throw new Error('opts.leaf and opts.parent required')

  this.roots = roots || opts.roots || []
  this.blocks = this.roots.length ? 1 + flat.rightSpan(this.roots[this.roots.length - 1].index) / 2 : 0

  for (var i = 0; i < this.roots.length; i++) {
    var r = this.roots[i]
    if (r && !r.parent) r.parent = flat.parent(r.index)
  }

  this._leaf = opts.leaf
  this._parent = opts.parent
}

MerkleGenerator.prototype.next = function (data, nodes) {
  if (!Buffer.isBuffer(data)) data = new Buffer(data)
  if (!nodes) nodes = []

  var index = 2 * this.blocks++

  var leaf = {
    index: index,
    parent: flat.parent(index),
    hash: null,
    size: data.length,
    data: data
  }

  leaf.hash = this._leaf(leaf, this.roots)
  this.roots.push(leaf)
  nodes.push(leaf)

  while (this.roots.length > 1) {
    var left = this.roots[this.roots.length - 2]
    var right = this.roots[this.roots.length - 1]

    if (left.parent !== right.parent) break

    this.roots.pop()
    this.roots[this.roots.length - 1] = leaf = {
      index: left.parent,
      parent: flat.parent(left.parent),
      hash: this._parent(left, right),
      size: left.size + right.size,
      data: null
    }
    nodes.push(leaf)
  }

  return nodes
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"flat-tree":50}],82:[function(require,module,exports){
'use strict';

/**
 * @param typeMap [Object] Map of MIME type -> Array[extensions]
 * @param ...
 */
function Mime() {
  this._types = Object.create(null);
  this._extensions = Object.create(null);

  for (var i = 0; i < arguments.length; i++) {
    this.define(arguments[i]);
  }

  this.define = this.define.bind(this);
  this.getType = this.getType.bind(this);
  this.getExtension = this.getExtension.bind(this);
}

/**
 * Define mimetype -> xtension mappings.  Each key is a mime-type that maps
 * to an array of extensions associated with the type.  The first extension is
 * used as the default extension for the type.
 *
 * e.g. mime.define({'audio/ogg', ['oga', 'ogg', 'spx']});
 *
 * If a type declares an extension that has already been defined, an error will
 * be thrown.  To suppress this error and force the extension to be associated
 * with the new type, pass `force`=true.  Alternatively, you may prefix the
 * extension with "*" to map the type to extension, without mapping the
 * extension to the type.
 *
 * e.g. mime.define({'audio/wav', ['wav']}, {'audio/x-wav', ['*wav']});
 *
 *
 * @param map (Object) type definitions
 * @param force (Boolean) if true, force overriding of existing definitions
 */
Mime.prototype.define = function(typeMap, force) {
  for (var type in typeMap) {
    var extensions = typeMap[type];
    for (var i = 0; i < extensions.length; i++) {
      var ext = extensions[i];

      // '*' prefix = not the preferred type for this extension.  So fixup the
      // extension, and skip it.
      if (ext[0] == '*') {
        continue;
      }

      if (!force && (ext in this._types)) {
        throw new Error(
          'Attempt to change mapping for "' + ext +
          '" extension from "' + this._types[ext] + '" to "' + type +
          '". Pass `force=true` to allow this, otherwise remove "' + ext +
          '" from the list of extensions for "' + type + '".'
        );
      }

      this._types[ext] = type;
    }

    // Use first extension as default
    if (force || !this._extensions[type]) {
      var ext = extensions[0];
      this._extensions[type] = (ext[0] != '*') ? ext : ext.substr(1)
    }
  }
};

/**
 * Lookup a mime type based on extension
 */
Mime.prototype.getType = function(path) {
  path = String(path);
  var last = path.replace(/^.*[/\\]/, '').toLowerCase();
  var ext = last.replace(/^.*\./, '').toLowerCase();

  var hasPath = last.length < path.length;
  var hasDot = ext.length < last.length - 1;

  return (hasDot || !hasPath) && this._types[ext] || null;
};

/**
 * Return file extension associated with a mime type
 */
Mime.prototype.getExtension = function(type) {
  type = /^\s*([^;\s]*)/.test(type) && RegExp.$1;
  return type && this._extensions[type.toLowerCase()] || null;
};

module.exports = Mime;

},{}],83:[function(require,module,exports){
'use strict';

var Mime = require('./Mime');
module.exports = new Mime(require('./types/standard'));

},{"./Mime":82,"./types/standard":84}],84:[function(require,module,exports){
module.exports={"application/andrew-inset":["ez"],"application/applixware":["aw"],"application/atom+xml":["atom"],"application/atomcat+xml":["atomcat"],"application/atomsvc+xml":["atomsvc"],"application/bdoc":["bdoc"],"application/ccxml+xml":["ccxml"],"application/cdmi-capability":["cdmia"],"application/cdmi-container":["cdmic"],"application/cdmi-domain":["cdmid"],"application/cdmi-object":["cdmio"],"application/cdmi-queue":["cdmiq"],"application/cu-seeme":["cu"],"application/dash+xml":["mpd"],"application/davmount+xml":["davmount"],"application/docbook+xml":["dbk"],"application/dssc+der":["dssc"],"application/dssc+xml":["xdssc"],"application/ecmascript":["ecma","es"],"application/emma+xml":["emma"],"application/epub+zip":["epub"],"application/exi":["exi"],"application/font-tdpfr":["pfr"],"application/geo+json":["geojson"],"application/gml+xml":["gml"],"application/gpx+xml":["gpx"],"application/gxf":["gxf"],"application/gzip":["gz"],"application/hjson":["hjson"],"application/hyperstudio":["stk"],"application/inkml+xml":["ink","inkml"],"application/ipfix":["ipfix"],"application/java-archive":["jar","war","ear"],"application/java-serialized-object":["ser"],"application/java-vm":["class"],"application/javascript":["js","mjs"],"application/json":["json","map"],"application/json5":["json5"],"application/jsonml+json":["jsonml"],"application/ld+json":["jsonld"],"application/lost+xml":["lostxml"],"application/mac-binhex40":["hqx"],"application/mac-compactpro":["cpt"],"application/mads+xml":["mads"],"application/manifest+json":["webmanifest"],"application/marc":["mrc"],"application/marcxml+xml":["mrcx"],"application/mathematica":["ma","nb","mb"],"application/mathml+xml":["mathml"],"application/mbox":["mbox"],"application/mediaservercontrol+xml":["mscml"],"application/metalink+xml":["metalink"],"application/metalink4+xml":["meta4"],"application/mets+xml":["mets"],"application/mods+xml":["mods"],"application/mp21":["m21","mp21"],"application/mp4":["mp4s","m4p"],"application/msword":["doc","dot"],"application/mxf":["mxf"],"application/octet-stream":["bin","dms","lrf","mar","so","dist","distz","pkg","bpk","dump","elc","deploy","exe","dll","deb","dmg","iso","img","msi","msp","msm","buffer"],"application/oda":["oda"],"application/oebps-package+xml":["opf"],"application/ogg":["ogx"],"application/omdoc+xml":["omdoc"],"application/onenote":["onetoc","onetoc2","onetmp","onepkg"],"application/oxps":["oxps"],"application/patch-ops-error+xml":["xer"],"application/pdf":["pdf"],"application/pgp-encrypted":["pgp"],"application/pgp-signature":["asc","sig"],"application/pics-rules":["prf"],"application/pkcs10":["p10"],"application/pkcs7-mime":["p7m","p7c"],"application/pkcs7-signature":["p7s"],"application/pkcs8":["p8"],"application/pkix-attr-cert":["ac"],"application/pkix-cert":["cer"],"application/pkix-crl":["crl"],"application/pkix-pkipath":["pkipath"],"application/pkixcmp":["pki"],"application/pls+xml":["pls"],"application/postscript":["ai","eps","ps"],"application/pskc+xml":["pskcxml"],"application/raml+yaml":["raml"],"application/rdf+xml":["rdf","owl"],"application/reginfo+xml":["rif"],"application/relax-ng-compact-syntax":["rnc"],"application/resource-lists+xml":["rl"],"application/resource-lists-diff+xml":["rld"],"application/rls-services+xml":["rs"],"application/rpki-ghostbusters":["gbr"],"application/rpki-manifest":["mft"],"application/rpki-roa":["roa"],"application/rsd+xml":["rsd"],"application/rss+xml":["rss"],"application/rtf":["rtf"],"application/sbml+xml":["sbml"],"application/scvp-cv-request":["scq"],"application/scvp-cv-response":["scs"],"application/scvp-vp-request":["spq"],"application/scvp-vp-response":["spp"],"application/sdp":["sdp"],"application/set-payment-initiation":["setpay"],"application/set-registration-initiation":["setreg"],"application/shf+xml":["shf"],"application/smil+xml":["smi","smil"],"application/sparql-query":["rq"],"application/sparql-results+xml":["srx"],"application/srgs":["gram"],"application/srgs+xml":["grxml"],"application/sru+xml":["sru"],"application/ssdl+xml":["ssdl"],"application/ssml+xml":["ssml"],"application/tei+xml":["tei","teicorpus"],"application/thraud+xml":["tfi"],"application/timestamped-data":["tsd"],"application/voicexml+xml":["vxml"],"application/wasm":["wasm"],"application/widget":["wgt"],"application/winhlp":["hlp"],"application/wsdl+xml":["wsdl"],"application/wspolicy+xml":["wspolicy"],"application/xaml+xml":["xaml"],"application/xcap-diff+xml":["xdf"],"application/xenc+xml":["xenc"],"application/xhtml+xml":["xhtml","xht"],"application/xml":["xml","xsl","xsd","rng"],"application/xml-dtd":["dtd"],"application/xop+xml":["xop"],"application/xproc+xml":["xpl"],"application/xslt+xml":["xslt"],"application/xspf+xml":["xspf"],"application/xv+xml":["mxml","xhvml","xvml","xvm"],"application/yang":["yang"],"application/yin+xml":["yin"],"application/zip":["zip"],"audio/3gpp":["*3gpp"],"audio/adpcm":["adp"],"audio/basic":["au","snd"],"audio/midi":["mid","midi","kar","rmi"],"audio/mp3":["*mp3"],"audio/mp4":["m4a","mp4a"],"audio/mpeg":["mpga","mp2","mp2a","mp3","m2a","m3a"],"audio/ogg":["oga","ogg","spx"],"audio/s3m":["s3m"],"audio/silk":["sil"],"audio/wav":["wav"],"audio/wave":["*wav"],"audio/webm":["weba"],"audio/xm":["xm"],"font/collection":["ttc"],"font/otf":["otf"],"font/ttf":["ttf"],"font/woff":["woff"],"font/woff2":["woff2"],"image/aces":["exr"],"image/apng":["apng"],"image/bmp":["bmp"],"image/cgm":["cgm"],"image/dicom-rle":["drle"],"image/emf":["emf"],"image/fits":["fits"],"image/g3fax":["g3"],"image/gif":["gif"],"image/heic":["heic"],"image/heic-sequence":["heics"],"image/heif":["heif"],"image/heif-sequence":["heifs"],"image/ief":["ief"],"image/jls":["jls"],"image/jp2":["jp2","jpg2"],"image/jpeg":["jpeg","jpg","jpe"],"image/jpm":["jpm"],"image/jpx":["jpx","jpf"],"image/ktx":["ktx"],"image/png":["png"],"image/sgi":["sgi"],"image/svg+xml":["svg","svgz"],"image/t38":["t38"],"image/tiff":["tif","tiff"],"image/tiff-fx":["tfx"],"image/webp":["webp"],"image/wmf":["wmf"],"message/disposition-notification":["disposition-notification"],"message/global":["u8msg"],"message/global-delivery-status":["u8dsn"],"message/global-disposition-notification":["u8mdn"],"message/global-headers":["u8hdr"],"message/rfc822":["eml","mime"],"model/gltf+json":["gltf"],"model/gltf-binary":["glb"],"model/iges":["igs","iges"],"model/mesh":["msh","mesh","silo"],"model/vrml":["wrl","vrml"],"model/x3d+binary":["x3db","x3dbz"],"model/x3d+vrml":["x3dv","x3dvz"],"model/x3d+xml":["x3d","x3dz"],"text/cache-manifest":["appcache","manifest"],"text/calendar":["ics","ifb"],"text/coffeescript":["coffee","litcoffee"],"text/css":["css"],"text/csv":["csv"],"text/html":["html","htm","shtml"],"text/jade":["jade"],"text/jsx":["jsx"],"text/less":["less"],"text/markdown":["markdown","md"],"text/mathml":["mml"],"text/n3":["n3"],"text/plain":["txt","text","conf","def","list","log","in","ini"],"text/richtext":["rtx"],"text/rtf":["*rtf"],"text/sgml":["sgml","sgm"],"text/shex":["shex"],"text/slim":["slim","slm"],"text/stylus":["stylus","styl"],"text/tab-separated-values":["tsv"],"text/troff":["t","tr","roff","man","me","ms"],"text/turtle":["ttl"],"text/uri-list":["uri","uris","urls"],"text/vcard":["vcard"],"text/vtt":["vtt"],"text/xml":["*xml"],"text/yaml":["yaml","yml"],"video/3gpp":["3gp","3gpp"],"video/3gpp2":["3g2"],"video/h261":["h261"],"video/h263":["h263"],"video/h264":["h264"],"video/jpeg":["jpgv"],"video/jpm":["*jpm","jpgm"],"video/mj2":["mj2","mjp2"],"video/mp2t":["ts"],"video/mp4":["mp4","mp4v","mpg4"],"video/mpeg":["mpeg","mpg","mpe","m1v","m2v"],"video/ogg":["ogv"],"video/quicktime":["qt","mov"],"video/webm":["webm"]}
},{}],85:[function(require,module,exports){
/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isNaN(val) === false) {
    return options.long ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^((?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  if (ms >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (ms >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (ms >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (ms >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  return plural(ms, d, 'day') ||
    plural(ms, h, 'hour') ||
    plural(ms, m, 'minute') ||
    plural(ms, s, 'second') ||
    ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, n, name) {
  if (ms < n) {
    return;
  }
  if (ms < n * 1.5) {
    return Math.floor(ms / n) + ' ' + name;
  }
  return Math.ceil(ms / n) + ' ' + name + 's';
}

},{}],86:[function(require,module,exports){
(function (process){
var mutexify = function() {
  var queue = []
  var used = null

  var call = function () {
    used(release)
  }

  var acquire = function (fn) {
    if (used) return queue.push(fn)
    used = fn
    acquire.locked = true
    process.nextTick(call)
    return 0
  }

  acquire.locked = false

  var release = function (fn, err, value) {
    used = null
    acquire.locked = false
    if (queue.length) acquire(queue.shift())
    if (fn) fn(err, value)
  }

  return acquire
}

module.exports = mutexify

}).call(this,require('_process'))
},{"_process":94}],87:[function(require,module,exports){
assert.notEqual = notEqual
assert.notOk = notOk
assert.equal = equal
assert.ok = assert

module.exports = assert

function equal (a, b, m) {
  assert(a == b, m) // eslint-disable-line eqeqeq
}

function notEqual (a, b, m) {
  assert(a != b, m) // eslint-disable-line eqeqeq
}

function notOk (t, m) {
  assert(!t, m)
}

function assert (t, m) {
  if (!t) throw new Error(m || 'AssertionError')
}

},{}],88:[function(require,module,exports){
(function (process,setImmediate){
'use strict';

var callable, byObserver;

callable = function (fn) {
	if (typeof fn !== 'function') throw new TypeError(fn + " is not a function");
	return fn;
};

byObserver = function (Observer) {
	var node = document.createTextNode(''), queue, currentQueue, i = 0;
	new Observer(function () {
		var callback;
		if (!queue) {
			if (!currentQueue) return;
			queue = currentQueue;
		} else if (currentQueue) {
			queue = currentQueue.concat(queue);
		}
		currentQueue = queue;
		queue = null;
		if (typeof currentQueue === 'function') {
			callback = currentQueue;
			currentQueue = null;
			callback();
			return;
		}
		node.data = (i = ++i % 2); // Invoke other batch, to handle leftover callbacks in case of crash
		while (currentQueue) {
			callback = currentQueue.shift();
			if (!currentQueue.length) currentQueue = null;
			callback();
		}
	}).observe(node, { characterData: true });
	return function (fn) {
		callable(fn);
		if (queue) {
			if (typeof queue === 'function') queue = [queue, fn];
			else queue.push(fn);
			return;
		}
		queue = fn;
		node.data = (i = ++i % 2);
	};
};

module.exports = (function () {
	// Node.js
	if ((typeof process === 'object') && process && (typeof process.nextTick === 'function')) {
		return process.nextTick;
	}

	// MutationObserver
	if ((typeof document === 'object') && document) {
		if (typeof MutationObserver === 'function') return byObserver(MutationObserver);
		if (typeof WebKitMutationObserver === 'function') return byObserver(WebKitMutationObserver);
	}

	// W3C Draft
	// http://dvcs.w3.org/hg/webperf/raw-file/tip/specs/setImmediate/Overview.html
	if (typeof setImmediate === 'function') {
		return function (cb) { setImmediate(callable(cb)); };
	}

	// Wide available standard
	if ((typeof setTimeout === 'function') || (typeof setTimeout === 'object')) {
		return function (cb) { setTimeout(callable(cb), 0); };
	}

	return null;
}());

}).call(this,require('_process'),require("timers").setImmediate)
},{"_process":94,"timers":145}],89:[function(require,module,exports){
/*!
 * normalize-path <https://github.com/jonschlinkert/normalize-path>
 *
 * Copyright (c) 2014-2017, Jon Schlinkert.
 * Released under the MIT License.
 */

var removeTrailingSeparator = require('remove-trailing-separator');

module.exports = function normalizePath(str, stripTrailing) {
  if (typeof str !== 'string') {
    throw new TypeError('expected a string');
  }
  str = str.replace(/[\\\/]+/g, '/');
  if (stripTrailing !== false) {
    str = removeTrailingSeparator(str);
  }
  return str;
};

},{"remove-trailing-separator":117}],90:[function(require,module,exports){
var wrappy = require('wrappy')
module.exports = wrappy(once)
module.exports.strict = wrappy(onceStrict)

once.proto = once(function () {
  Object.defineProperty(Function.prototype, 'once', {
    value: function () {
      return once(this)
    },
    configurable: true
  })

  Object.defineProperty(Function.prototype, 'onceStrict', {
    value: function () {
      return onceStrict(this)
    },
    configurable: true
  })
})

function once (fn) {
  var f = function () {
    if (f.called) return f.value
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  f.called = false
  return f
}

function onceStrict (fn) {
  var f = function () {
    if (f.called)
      throw new Error(f.onceError)
    f.called = true
    return f.value = fn.apply(this, arguments)
  }
  var name = fn.name || 'Function wrapped with `once`'
  f.onceError = name + " shouldn't be called more than once"
  f.called = false
  return f
}

},{"wrappy":159}],91:[function(require,module,exports){
(function (process){
// .dirname, .basename, and .extname methods are extracted from Node.js v8.11.1,
// backported and transplited with Babel, with backwards-compat fixes

// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// resolves . and .. elements in a path array with directory names there
// must be no slashes, empty elements, or device names (c:\) in the array
// (so also no leading and trailing slashes - it does not distinguish
// relative and absolute paths)
function normalizeArray(parts, allowAboveRoot) {
  // if the path tries to go above the root, `up` ends up > 0
  var up = 0;
  for (var i = parts.length - 1; i >= 0; i--) {
    var last = parts[i];
    if (last === '.') {
      parts.splice(i, 1);
    } else if (last === '..') {
      parts.splice(i, 1);
      up++;
    } else if (up) {
      parts.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (allowAboveRoot) {
    for (; up--; up) {
      parts.unshift('..');
    }
  }

  return parts;
}

// path.resolve([from ...], to)
// posix version
exports.resolve = function() {
  var resolvedPath = '',
      resolvedAbsolute = false;

  for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    var path = (i >= 0) ? arguments[i] : process.cwd();

    // Skip empty and invalid entries
    if (typeof path !== 'string') {
      throw new TypeError('Arguments to path.resolve must be strings');
    } else if (!path) {
      continue;
    }

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charAt(0) === '/';
  }

  // At this point the path should be resolved to a full absolute path, but
  // handle relative paths to be safe (might happen when process.cwd() fails)

  // Normalize the path
  resolvedPath = normalizeArray(filter(resolvedPath.split('/'), function(p) {
    return !!p;
  }), !resolvedAbsolute).join('/');

  return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
};

// path.normalize(path)
// posix version
exports.normalize = function(path) {
  var isAbsolute = exports.isAbsolute(path),
      trailingSlash = substr(path, -1) === '/';

  // Normalize the path
  path = normalizeArray(filter(path.split('/'), function(p) {
    return !!p;
  }), !isAbsolute).join('/');

  if (!path && !isAbsolute) {
    path = '.';
  }
  if (path && trailingSlash) {
    path += '/';
  }

  return (isAbsolute ? '/' : '') + path;
};

// posix version
exports.isAbsolute = function(path) {
  return path.charAt(0) === '/';
};

// posix version
exports.join = function() {
  var paths = Array.prototype.slice.call(arguments, 0);
  return exports.normalize(filter(paths, function(p, index) {
    if (typeof p !== 'string') {
      throw new TypeError('Arguments to path.join must be strings');
    }
    return p;
  }).join('/'));
};


// path.relative(from, to)
// posix version
exports.relative = function(from, to) {
  from = exports.resolve(from).substr(1);
  to = exports.resolve(to).substr(1);

  function trim(arr) {
    var start = 0;
    for (; start < arr.length; start++) {
      if (arr[start] !== '') break;
    }

    var end = arr.length - 1;
    for (; end >= 0; end--) {
      if (arr[end] !== '') break;
    }

    if (start > end) return [];
    return arr.slice(start, end - start + 1);
  }

  var fromParts = trim(from.split('/'));
  var toParts = trim(to.split('/'));

  var length = Math.min(fromParts.length, toParts.length);
  var samePartsLength = length;
  for (var i = 0; i < length; i++) {
    if (fromParts[i] !== toParts[i]) {
      samePartsLength = i;
      break;
    }
  }

  var outputParts = [];
  for (var i = samePartsLength; i < fromParts.length; i++) {
    outputParts.push('..');
  }

  outputParts = outputParts.concat(toParts.slice(samePartsLength));

  return outputParts.join('/');
};

exports.sep = '/';
exports.delimiter = ':';

exports.dirname = function (path) {
  if (typeof path !== 'string') path = path + '';
  if (path.length === 0) return '.';
  var code = path.charCodeAt(0);
  var hasRoot = code === 47 /*/*/;
  var end = -1;
  var matchedSlash = true;
  for (var i = path.length - 1; i >= 1; --i) {
    code = path.charCodeAt(i);
    if (code === 47 /*/*/) {
        if (!matchedSlash) {
          end = i;
          break;
        }
      } else {
      // We saw the first non-path separator
      matchedSlash = false;
    }
  }

  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) {
    // return '//';
    // Backwards-compat fix:
    return '/';
  }
  return path.slice(0, end);
};

function basename(path) {
  if (typeof path !== 'string') path = path + '';

  var start = 0;
  var end = -1;
  var matchedSlash = true;
  var i;

  for (i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47 /*/*/) {
        // If we reached a path separator that was not part of a set of path
        // separators at the end of the string, stop now
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // path component
      matchedSlash = false;
      end = i + 1;
    }
  }

  if (end === -1) return '';
  return path.slice(start, end);
}

// Uses a mixed approach for backwards-compatibility, as ext behavior changed
// in new Node.js versions, so only basename() above is backported here
exports.basename = function (path, ext) {
  var f = basename(path);
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
};

exports.extname = function (path) {
  if (typeof path !== 'string') path = path + '';
  var startDot = -1;
  var startPart = 0;
  var end = -1;
  var matchedSlash = true;
  // Track the state of characters (if any) we see before our first dot and
  // after any path separator we find
  var preDotState = 0;
  for (var i = path.length - 1; i >= 0; --i) {
    var code = path.charCodeAt(i);
    if (code === 47 /*/*/) {
        // If we reached a path separator that was not part of a set of path
        // separators at the end of the string, stop now
        if (!matchedSlash) {
          startPart = i + 1;
          break;
        }
        continue;
      }
    if (end === -1) {
      // We saw the first non-path separator, mark this as the end of our
      // extension
      matchedSlash = false;
      end = i + 1;
    }
    if (code === 46 /*.*/) {
        // If this is our first dot, mark it as the start of our extension
        if (startDot === -1)
          startDot = i;
        else if (preDotState !== 1)
          preDotState = 1;
    } else if (startDot !== -1) {
      // We saw a non-dot and non-path separator before our dot, so we should
      // have a good chance at having a non-empty extension
      preDotState = -1;
    }
  }

  if (startDot === -1 || end === -1 ||
      // We saw a non-dot character immediately before the dot
      preDotState === 0 ||
      // The (right-most) trimmed path component is exactly '..'
      preDotState === 1 && startDot === end - 1 && startDot === startPart + 1) {
    return '';
  }
  return path.slice(startDot, end);
};

function filter (xs, f) {
    if (xs.filter) return xs.filter(f);
    var res = [];
    for (var i = 0; i < xs.length; i++) {
        if (f(xs[i], i, xs)) res.push(xs[i]);
    }
    return res;
}

// String.prototype.substr - negative index don't work in IE8
var substr = 'ab'.substr(-1) === 'b'
    ? function (str, start, len) { return str.substr(start, len) }
    : function (str, start, len) {
        if (start < 0) start = str.length + start;
        return str.substr(start, len);
    }
;

}).call(this,require('_process'))
},{"_process":94}],92:[function(require,module,exports){
(function (Buffer){

module.exports = function prettyHash (buf) {
  if (Buffer.isBuffer(buf)) buf = buf.toString('hex')
  if (typeof buf === 'string' && buf.length > 8) {
    return buf.slice(0, 6) + '..' + buf.slice(-2)
  }
  return buf
}
}).call(this,{"isBuffer":require("../is-buffer/index.js")})
},{"../is-buffer/index.js":73}],93:[function(require,module,exports){
(function (process){
'use strict';

if (!process.version ||
    process.version.indexOf('v0.') === 0 ||
    process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
  module.exports = nextTick;
} else {
  module.exports = process.nextTick;
}

function nextTick(fn, arg1, arg2, arg3) {
  if (typeof fn !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }
  var len = arguments.length;
  var args, i;
  switch (len) {
  case 0:
  case 1:
    return process.nextTick(fn);
  case 2:
    return process.nextTick(function afterTickOne() {
      fn.call(null, arg1);
    });
  case 3:
    return process.nextTick(function afterTickTwo() {
      fn.call(null, arg1, arg2);
    });
  case 4:
    return process.nextTick(function afterTickThree() {
      fn.call(null, arg1, arg2, arg3);
    });
  default:
    args = new Array(len - 1);
    i = 0;
    while (i < args.length) {
      args[i++] = arguments[i];
    }
    return process.nextTick(function afterTick() {
      fn.apply(null, args);
    });
  }
}

}).call(this,require('_process'))
},{"_process":94}],94:[function(require,module,exports){
// shim for using process in browser
var process = module.exports = {};

// cached from whatever global is present so that test runners that stub it
// don't break things.  But we need to wrap it in a try catch in case it is
// wrapped in strict mode code which doesn't define any globals.  It's inside a
// function because try/catches deoptimize in certain engines.

var cachedSetTimeout;
var cachedClearTimeout;

function defaultSetTimout() {
    throw new Error('setTimeout has not been defined');
}
function defaultClearTimeout () {
    throw new Error('clearTimeout has not been defined');
}
(function () {
    try {
        if (typeof setTimeout === 'function') {
            cachedSetTimeout = setTimeout;
        } else {
            cachedSetTimeout = defaultSetTimout;
        }
    } catch (e) {
        cachedSetTimeout = defaultSetTimout;
    }
    try {
        if (typeof clearTimeout === 'function') {
            cachedClearTimeout = clearTimeout;
        } else {
            cachedClearTimeout = defaultClearTimeout;
        }
    } catch (e) {
        cachedClearTimeout = defaultClearTimeout;
    }
} ())
function runTimeout(fun) {
    if (cachedSetTimeout === setTimeout) {
        //normal enviroments in sane situations
        return setTimeout(fun, 0);
    }
    // if setTimeout wasn't available but was latter defined
    if ((cachedSetTimeout === defaultSetTimout || !cachedSetTimeout) && setTimeout) {
        cachedSetTimeout = setTimeout;
        return setTimeout(fun, 0);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedSetTimeout(fun, 0);
    } catch(e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't trust the global object when called normally
            return cachedSetTimeout.call(null, fun, 0);
        } catch(e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error
            return cachedSetTimeout.call(this, fun, 0);
        }
    }


}
function runClearTimeout(marker) {
    if (cachedClearTimeout === clearTimeout) {
        //normal enviroments in sane situations
        return clearTimeout(marker);
    }
    // if clearTimeout wasn't available but was latter defined
    if ((cachedClearTimeout === defaultClearTimeout || !cachedClearTimeout) && clearTimeout) {
        cachedClearTimeout = clearTimeout;
        return clearTimeout(marker);
    }
    try {
        // when when somebody has screwed with setTimeout but no I.E. maddness
        return cachedClearTimeout(marker);
    } catch (e){
        try {
            // When we are in I.E. but the script has been evaled so I.E. doesn't  trust the global object when called normally
            return cachedClearTimeout.call(null, marker);
        } catch (e){
            // same as above but when it's a version of I.E. that must have the global object for 'this', hopfully our context correct otherwise it will throw a global error.
            // Some versions of I.E. have different rules for clearTimeout vs setTimeout
            return cachedClearTimeout.call(this, marker);
        }
    }



}
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    if (!draining || !currentQueue) {
        return;
    }
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = runTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            if (currentQueue) {
                currentQueue[queueIndex].run();
            }
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    runClearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        runTimeout(drainQueue);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;
process.prependListener = noop;
process.prependOnceListener = noop;

process.listeners = function (name) { return [] }

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],95:[function(require,module,exports){
(function (Buffer){
var varint = require('varint')
var svarint = require('signed-varint')

exports.make = encoder

exports.name = function (enc) {
  var keys = Object.keys(exports)
  for (var i = 0; i < keys.length; i++) {
    if (exports[keys[i]] === enc) return keys[i]
  }
  return null
}

exports.skip = function (type, buffer, offset) {
  switch (type) {
    case 0:
      varint.decode(buffer, offset)
      return offset + varint.decode.bytes

    case 1:
      return offset + 8

    case 2:
      var len = varint.decode(buffer, offset)
      return offset + varint.decode.bytes + len

    case 3:
    case 4:
      throw new Error('Groups are not supported')

    case 5:
      return offset + 4
  }

  throw new Error('Unknown wire type: ' + type)
}

exports.bytes = encoder(2,
  function encode (val, buffer, offset) {
    var oldOffset = offset
    var len = bufferLength(val)

    varint.encode(len, buffer, offset)
    offset += varint.encode.bytes

    if (Buffer.isBuffer(val)) val.copy(buffer, offset)
    else buffer.write(val, offset, len)
    offset += len

    encode.bytes = offset - oldOffset
    return buffer
  },
  function decode (buffer, offset) {
    var oldOffset = offset

    var len = varint.decode(buffer, offset)
    offset += varint.decode.bytes

    var val = buffer.slice(offset, offset + len)
    offset += val.length

    decode.bytes = offset - oldOffset
    return val
  },
  function encodingLength (val) {
    var len = bufferLength(val)
    return varint.encodingLength(len) + len
  }
)

exports.string = encoder(2,
  function encode (val, buffer, offset) {
    var oldOffset = offset
    var len = Buffer.byteLength(val)

    varint.encode(len, buffer, offset, 'utf-8')
    offset += varint.encode.bytes

    buffer.write(val, offset, len)
    offset += len

    encode.bytes = offset - oldOffset
    return buffer
  },
  function decode (buffer, offset) {
    var oldOffset = offset

    var len = varint.decode(buffer, offset)
    offset += varint.decode.bytes

    var val = buffer.toString('utf-8', offset, offset + len)
    offset += len

    decode.bytes = offset - oldOffset
    return val
  },
  function encodingLength (val) {
    var len = Buffer.byteLength(val)
    return varint.encodingLength(len) + len
  }
)

exports.bool = encoder(0,
  function encode (val, buffer, offset) {
    buffer[offset] = val ? 1 : 0
    encode.bytes = 1
    return buffer
  },
  function decode (buffer, offset) {
    var bool = buffer[offset] > 0
    decode.bytes = 1
    return bool
  },
  function encodingLength () {
    return 1
  }
)

exports.int32 = encoder(0,
  function encode (val, buffer, offset) {
    varint.encode(val < 0 ? val + 4294967296 : val, buffer, offset)
    encode.bytes = varint.encode.bytes
    return buffer
  },
  function decode (buffer, offset) {
    var val = varint.decode(buffer, offset)
    decode.bytes = varint.decode.bytes
    return val > 2147483647 ? val - 4294967296 : val
  },
  function encodingLength (val) {
    return varint.encodingLength(val < 0 ? val + 4294967296 : val)
  }
)

exports.int64 = encoder(0,
  function encode (val, buffer, offset) {
    if (val < 0) {
      var last = offset + 9
      varint.encode(val * -1, buffer, offset)
      offset += varint.encode.bytes - 1
      buffer[offset] = buffer[offset] | 0x80
      while (offset < last - 1) {
        offset++
        buffer[offset] = 0xff
      }
      buffer[last] = 0x01
      encode.bytes = 10
    } else {
      varint.encode(val, buffer, offset)
      encode.bytes = varint.encode.bytes
    }
    return buffer
  },
  function decode (buffer, offset) {
    var val = varint.decode(buffer, offset)
    if (val >= Math.pow(2, 63)) {
      var limit = 9
      while (buffer[offset + limit - 1] === 0xff) limit--
      limit = limit || 9
      var subset = Buffer.allocUnsafe(limit)
      buffer.copy(subset, 0, offset, offset + limit)
      subset[limit - 1] = subset[limit - 1] & 0x7f
      val = -1 * varint.decode(subset, 0)
      decode.bytes = 10
    } else {
      decode.bytes = varint.decode.bytes
    }
    return val
  },
  function encodingLength (val) {
    return val < 0 ? 10 : varint.encodingLength(val)
  }
)

exports.sint32 =
exports.sint64 = encoder(0,
  svarint.encode,
  svarint.decode,
  svarint.encodingLength
)

exports.uint32 =
exports.uint64 =
exports.enum =
exports.varint = encoder(0,
  varint.encode,
  varint.decode,
  varint.encodingLength
)

// we cannot represent these in javascript so we just use buffers
exports.fixed64 =
exports.sfixed64 = encoder(1,
  function encode (val, buffer, offset) {
    val.copy(buffer, offset)
    encode.bytes = 8
    return buffer
  },
  function decode (buffer, offset) {
    var val = buffer.slice(offset, offset + 8)
    decode.bytes = 8
    return val
  },
  function encodingLength () {
    return 8
  }
)

exports.double = encoder(1,
  function encode (val, buffer, offset) {
    buffer.writeDoubleLE(val, offset)
    encode.bytes = 8
    return buffer
  },
  function decode (buffer, offset) {
    var val = buffer.readDoubleLE(offset)
    decode.bytes = 8
    return val
  },
  function encodingLength () {
    return 8
  }
)

exports.fixed32 = encoder(5,
  function encode (val, buffer, offset) {
    buffer.writeUInt32LE(val, offset)
    encode.bytes = 4
    return buffer
  },
  function decode (buffer, offset) {
    var val = buffer.readUInt32LE(offset)
    decode.bytes = 4
    return val
  },
  function encodingLength () {
    return 4
  }
)

exports.sfixed32 = encoder(5,
  function encode (val, buffer, offset) {
    buffer.writeInt32LE(val, offset)
    encode.bytes = 4
    return buffer
  },
  function decode (buffer, offset) {
    var val = buffer.readInt32LE(offset)
    decode.bytes = 4
    return val
  },
  function encodingLength () {
    return 4
  }
)

exports.float = encoder(5,
  function encode (val, buffer, offset) {
    buffer.writeFloatLE(val, offset)
    encode.bytes = 4
    return buffer
  },
  function decode (buffer, offset) {
    var val = buffer.readFloatLE(offset)
    decode.bytes = 4
    return val
  },
  function encodingLength () {
    return 4
  }
)

function encoder (type, encode, decode, encodingLength) {
  encode.bytes = decode.bytes = 0

  return {
    type: type,
    encode: encode,
    decode: decode,
    encodingLength: encodingLength
  }
}

function bufferLength (val) {
  return Buffer.isBuffer(val) ? val.length : Buffer.byteLength(val)
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"signed-varint":123,"varint":154}],96:[function(require,module,exports){
(function (process){
var once = require('once')
var eos = require('end-of-stream')
var fs = require('fs') // we only need fs to get the ReadStream and WriteStream prototypes

var noop = function () {}
var ancient = /^v?\.0/.test(process.version)

var isFn = function (fn) {
  return typeof fn === 'function'
}

var isFS = function (stream) {
  if (!ancient) return false // newer node version do not need to care about fs is a special way
  if (!fs) return false // browser
  return (stream instanceof (fs.ReadStream || noop) || stream instanceof (fs.WriteStream || noop)) && isFn(stream.close)
}

var isRequest = function (stream) {
  return stream.setHeader && isFn(stream.abort)
}

var destroyer = function (stream, reading, writing, callback) {
  callback = once(callback)

  var closed = false
  stream.on('close', function () {
    closed = true
  })

  eos(stream, {readable: reading, writable: writing}, function (err) {
    if (err) return callback(err)
    closed = true
    callback()
  })

  var destroyed = false
  return function (err) {
    if (closed) return
    if (destroyed) return
    destroyed = true

    if (isFS(stream)) return stream.close(noop) // use close for fs streams to avoid fd leaks
    if (isRequest(stream)) return stream.abort() // request.destroy just do .end - .abort is what we want

    if (isFn(stream.destroy)) return stream.destroy()

    callback(err || new Error('stream was destroyed'))
  }
}

var call = function (fn) {
  fn()
}

var pipe = function (from, to) {
  return from.pipe(to)
}

var pump = function () {
  var streams = Array.prototype.slice.call(arguments)
  var callback = isFn(streams[streams.length - 1] || noop) && streams.pop() || noop

  if (Array.isArray(streams[0])) streams = streams[0]
  if (streams.length < 2) throw new Error('pump requires two streams per minimum')

  var error
  var destroys = streams.map(function (stream, i) {
    var reading = i < streams.length - 1
    var writing = i > 0
    return destroyer(stream, reading, writing, function (err) {
      if (!error) error = err
      if (err) destroys.forEach(call)
      if (reading) return
      destroys.forEach(call)
      callback(error)
    })
  })

  return streams.reduce(pipe)
}

module.exports = pump

}).call(this,require('_process'))
},{"_process":94,"end-of-stream":48,"fs":26,"once":90}],97:[function(require,module,exports){
(function (Buffer){
const ras = require('random-access-storage')

const TYPE = {type: 'octet/stream'}
const requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem
const persistentStorage = navigator.persistentStorage || navigator.webkitPersistentStorage
const FileReader = window.FileReader
const Blob = window.Blob

createFile.DEFAULT_MAX_SIZE = Number.MAX_SAFE_INTEGER
createFile.requestQuota = requestQuota

module.exports = createFile

function requestQuota (n, force, cb) {
  if (typeof force === 'function') return requestQuota(n, true, force)
  persistentStorage.queryUsageAndQuota(function (used, quota) {
    if (quota && !force) return cb(null, quota)
    persistentStorage.requestQuota(n, function (quota) {
      cb(null, quota)
    }, cb)
  }, cb)
}

function createFile (name, opts) {
  if (!opts) opts = {}

  const maxSize = opts.maxSize || createFile.DEFAULT_MAX_SIZE
  const mutex = new Mutex()

  var fs = null
  var file = null
  var entry = null
  var toDestroy = null
  var readers = []
  var writers = []

  return ras({read, write, open, stat, close, destroy})

  function read (req) {
    const r = readers.pop() || new ReadRequest(readers, file, entry, mutex)
    r.run(req)
  }

  function write (req) {
    const w = writers.pop() || new WriteRequest(writers, file, entry, mutex)
    w.run(req)
  }

  function close (req) {
    readers = writers = entry = file = fs = null
    req.callback(null)
  }

  function stat (req) {
    req.callback(null, file)
  }

  function destroy (req) {
    toDestroy.remove(ondone, onerror)

    function ondone () {
      toDestroy = null
      req.callback(null, null)
    }

    function onerror (err) {
      toDestroy = null
      req.callback(err, null)
    }
  }

  function open (req) {
    requestQuota(maxSize, false, function (err, granted) {
      if (err) return onerror(err)
      requestFileSystem(window.PERSISTENT, granted, function (res) {
        fs = res
        mkdirp(parentFolder(name), function () {
          fs.root.getFile(name, {create: true}, function (e) {
            entry = toDestroy = e
            entry.file(function (f) {
              file = f
              req.callback(null)
            }, onerror)
          }, onerror)
        })
      }, onerror)
    })

    function mkdirp (name, ondone) {
      if (!name) return ondone()
      fs.root.getDirectory(name, {create: true}, ondone, function () {
        mkdirp(parentFolder(name), function () {
          fs.root.getDirectory(name, {create: true}, ondone, ondone)
        })
      })
    }

    function onerror (err) {
      fs = file = entry = null
      req.callback(err)
    }
  }
}

function parentFolder (path) {
  const i = path.lastIndexOf('/')
  const j = path.lastIndexOf('\\')
  const p = path.slice(0, Math.max(0, i, j))
  return /^\w:$/.test(p) ? '' : p
}

function WriteRequest (pool, file, entry, mutex) {
  this.writer = null
  this.entry = entry
  this.file = file
  this.req = null
  this.pool = pool
  this.mutex = mutex
  this.locked = false
  this.truncating = false
}

WriteRequest.prototype.makeWriter = function () {
  const self = this
  this.entry.createWriter(function (writer) {
    self.writer = writer

    writer.onwriteend = function () {
      self.onwrite(null)
    }

    writer.onerror = function (err) {
      self.onwrite(err)
    }

    self.run(self.req)
  })
}

WriteRequest.prototype.onwrite = function (err) {
  const req = this.req
  this.req = null

  if (this.locked) {
    this.locked = false
    this.mutex.release()
  }

  if (this.truncating) {
    this.truncating = false
    if (!err) return this.run(req)
  }

  this.pool.push(this)
  req.callback(err, null)
}

WriteRequest.prototype.truncate = function () {
  this.truncating = true
  this.writer.truncate(this.req.offset)
}

WriteRequest.prototype.lock = function () {
  if (this.locked) return true
  this.locked = this.mutex.lock(this)
  return this.locked
}

WriteRequest.prototype.run = function (req) {
  this.req = req
  if (!this.writer || this.writer.length !== this.file.size) return this.makeWriter()

  const end = req.offset + req.size
  if (end > this.file.size && !this.lock()) return

  if (req.offset > this.writer.length) {
    if (req.offset > this.file.size) return this.truncate()
    return this.makeWriter()
  }

  this.writer.seek(req.offset)
  this.writer.write(new Blob([req.data], TYPE))
}

function Mutex () {
  this.queued = null
}

Mutex.prototype.release = function () {
  const queued = this.queued
  this.queued = null
  for (var i = 0; i < queued.length; i++) {
    queued[i].run(queued[i].req)
  }
}

Mutex.prototype.lock = function (req) {
  if (this.queued) {
    this.queued.push(req)
    return false
  }
  this.queued = []
  return true
}

function ReadRequest (pool, file, entry, mutex) {
  this.reader = new FileReader()
  this.file = file
  this.req = null
  this.pool = pool
  this.retry = true
  this.mutex = mutex
  this.locked = false

  const self = this

  this.reader.onerror = function () {
    self.onread(this.error, null)
  }

  this.reader.onload = function () {
    const buf = Buffer.from(this.result)
    self.onread(null, buf)
  }
}

ReadRequest.prototype.lock = function () {
  if (this.locked) return true
  this.locked = this.mutex.lock(this)
  return this.locked
}

ReadRequest.prototype.onread = function (err, buf) {
  const req = this.req

  if (err && this.retry) {
    this.retry = false
    if (this.lock(this)) this.run(req)
    return
  }

  this.req = null
  this.pool.push(this)
  this.retry = true

  if (this.locked) {
    this.locked = false
    this.mutex.release()
  }

  req.callback(err, buf)
}

ReadRequest.prototype.run = function (req) {
  const end = req.offset + req.size
  this.req = req
  if (end > this.file.size) return this.onread(new Error('Could not satisfy length'), null)
  this.reader.readAsArrayBuffer(this.file.slice(req.offset, end))
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"random-access-storage":103}],98:[function(require,module,exports){
module.exports = function () {
  throw new Error('random-access-file is not supported in the browser')
}

},{}],99:[function(require,module,exports){
(function (Buffer){
var RandomAccess = require('random-access-storage')
var inherits = require('inherits')
var nextTick = require('next-tick')
var once = require('once')
var blocks = require('./lib/blocks.js')
var bufferFrom = require('buffer-from')
var bufferAlloc = require('buffer-alloc')

var DELIM = '\0'
var win = typeof window !== 'undefined' ? window
  : (typeof self !== 'undefined' ? self : {})

module.exports = function (dbname, xopts) {
  if (!xopts) xopts = {}
  var idb = xopts.idb || (typeof win !== 'undefined'
    ? win.indexedDB || win.mozIndexedDB
      || win.webkitIndexedDB || win.msIndexedDB
    : null)
  if (!idb) throw new Error('indexedDB not present and not given')
  var db = null, dbqueue = []
  if (typeof idb.open === 'function') {
    var req = idb.open(dbname)
    req.addEventListener('upgradeneeded', function () {
      db = req.result
      db.createObjectStore('data')
    })
    req.addEventListener('success', function () {
      db = req.result
      dbqueue.forEach(function (cb) { cb(db) })
      dbqueue = null
    })
  } else {
    db = idb
  }
  return function (name, opts) {
    if (typeof name === 'object') {
      opts = name
      name = opts.name
    }

    if (!opts) opts = {}
    opts.name = name

    return new Store(Object.assign({ db: getdb }, xopts, opts))
  }
  function getdb (cb) {
    if (db) nextTick(function () { cb(db) })
    else dbqueue.push(cb)
  }
}

function Store (opts) {
  if (!(this instanceof Store)) return new Store(opts)
  RandomAccess.call(this)
  if (!opts) opts = {}
  if (typeof opts === 'string') opts = { name: opts }
  this.size = opts.size || 4096
  this.name = opts.name
  this.length = opts.length || 0
  this._getdb = opts.db
}
inherits(Store, RandomAccess)

Store.prototype._blocks = function (i, j) {
  return blocks(this.size, i, j)
}

Store.prototype._read = function (req) {
  var self = this
  var buffers = []
  self._store('readonly', function (err, store) {
    if ((self.length || 0) < req.offset+req.size) {
      return req.callback(new Error('Could not satisfy length'))
    }
    if (err) return req.callback(err)
    var offsets = self._blocks(req.offset, req.offset+req.size)
    var pending = offsets.length + 1
    var firstBlock = offsets.length > 0 ? offsets[0].block : 0
    var j = 0
    for (var i = 0; i < offsets.length; i++) (function (o) {
      var key = self.name + DELIM + o.block
      backify(store.get(key), function (err, ev) {
        if (err) return req.callback(err)
        buffers[o.block-firstBlock] = ev.target.result
          ? bufferFrom(ev.target.result.subarray(o.start,o.end))
          : bufferAlloc(o.end-o.start)
        if (--pending === 0) req.callback(null, Buffer.concat(buffers))
      })
    })(offsets[i])
    if (--pending === 0) req.callback(null, Buffer.concat(buffers))
  })
}

Store.prototype._write = function (req) {
  var self = this
  self._store('readwrite', function (err, store) {
    if (err) return req.callback(err)
    var offsets = self._blocks(req.offset, req.offset + req.data.length)
    var pending = 1
    var buffers = {}
    for (var i = 0; i < offsets.length; i++) (function (o,i) {
      if (o.end-o.start === self.size) return
      pending++
      var key = self.name + DELIM + o.block
      backify(store.get(key), function (err, ev) {
        if (err) return req.callback(err)
        buffers[i] = bufferFrom(ev.target.result || bufferAlloc(self.size))
        if (--pending === 0) write(store, offsets, buffers)
      })
    })(offsets[i],i)
    if (--pending === 0) write(store, offsets, buffers)
  })
  function write (store, offsets, buffers) {
    for (var i = 0, j = 0; i < offsets.length; i++) {
      var o = offsets[i]
      var len = o.end - o.start
      if (len === self.size) {
        block = bufferFrom(req.data.slice(j, j+len))
      } else {
        block = buffers[i]
        req.data.copy(block, o.start, j, j+len)
      }
      store.put(block,self.name + DELIM + o.block)
      j += len
    }
    var length = Math.max(self.length || 0, req.offset + req.data.length)
    store.put(length, self.name + DELIM + 'length')
    store.transaction.addEventListener('complete', function () {
      self.length = length
      req.callback(null)
    })
    store.transaction.addEventListener('error', function (err) {
      req.callback(err)
    })
  }
}

Store.prototype._store = function (mode, cb) {
  cb = once(cb)
  var self = this
  self._getdb(function (db) {
    var tx = db.transaction(['data'], mode)
    var store = tx.objectStore('data')
    tx.addEventListener('error', cb)
    cb(null, store)
  })
}

Store.prototype._open = function (req) {
  var self = this
  this._getdb(function(db) {
    self._store('readonly', function (err, store) {
      backify(store.get(self.name + DELIM + "length"), function(err, ev) {
        self.length = ev.target.result || 0
        req.callback(null)
      })
    })
  })
}

Store.prototype._close = function (req) {
  this._getdb(function (db) {
    db.close()
    req.callback()
  })
}

Store.prototype._stat = function (req) {
  var self = this
  nextTick(function () {
    req.callback(null, { size: self.length })
  })
}

function backify (r, cb) {
  r.addEventListener('success', function (ev) { cb(null, ev) })
  r.addEventListener('error', cb)
}

}).call(this,require("buffer").Buffer)
},{"./lib/blocks.js":100,"buffer":32,"buffer-alloc":29,"buffer-from":101,"inherits":71,"next-tick":88,"once":90,"random-access-storage":103}],100:[function(require,module,exports){
module.exports = function (size, start, end) {
  var result = []
  for (var n = Math.floor(start/size)*size; n < end; n += size) {
    result.push({
      block: Math.floor(n/size),
      start: Math.max(n,start) % size,
      end: Math.min(n+size,end) % size || size
    })
  }
  return result
}

},{}],101:[function(require,module,exports){
arguments[4][31][0].apply(exports,arguments)
},{"buffer":32,"dup":31}],102:[function(require,module,exports){
(function (Buffer){
var nextTick = require('process-nextick-args')

module.exports = RAM

function RAM (length, opts) {
  if (!(this instanceof RAM)) return new RAM(length, opts)

  if (Buffer.isBuffer(length)) {
    if (!opts) opts = {}
    opts.buffer = length
    length = opts.buffer.length
  }

  if (typeof length === 'object') {
    opts = length
    length = 0
  }

  if (!opts) opts = {}
  if (typeof length !== 'number') length = 0

  this.pageSize = length || opts.pageSize || 1024 * 1024
  this.length = length || 0
  this.buffers = []

  if (opts.buffer) this.buffers.push(opts.buffer)
}

RAM.prototype.open = function (cb) {
  if (cb) nextTick(cb)
}

RAM.prototype.write = function (offset, data, cb) {
  if (offset + data.length > this.length) this.length = data.length + offset

  var i = Math.floor(offset / this.pageSize)
  var rel = offset - (i * this.pageSize)

  while (data.length) {
    var next = (rel + data.length) > this.pageSize ? data.slice(0, this.pageSize - rel) : data
    var buf = this.buffers[i]

    if (!buf) {
      buf = rel === 0 && next.length === this.pageSize ? next : calloc(this.pageSize)
      this.buffers[i] = buf
    }

    if (buf !== next) next.copy(buf, rel)
    if (next === data) break

    i++
    rel = 0
    data = data.slice(next.length)
  }

  if (cb) nextTick(cb)
}

RAM.prototype.read = function (offset, length, cb) {
  if (offset + length > this.length) return nextTick(cb, new Error('Could not satisfy length'))

  var data = new Buffer(length)
  var ptr = 0
  var i = Math.floor(offset / this.pageSize)
  var rel = offset - (i * this.pageSize)

  while (ptr < data.length) {
    var buf = this.buffers[i]
    var len = this.pageSize - rel

    if (!buf) data.fill(0, ptr, Math.min(data.length, ptr + len))
    else buf.copy(data, ptr, rel)

    ptr += len
    i++
    rel = 0
  }

  nextTick(cb, null, data)
}

RAM.prototype.del = function (offset, length, cb) {
  var overflow = offset % this.pageSize
  var inc = overflow && this.pageSize - overflow

  if (inc < length) {
    offset += inc
    length -= overflow

    var end = offset + length
    var i = offset / this.pageSize

    while (offset + this.pageSize <= end && i < this.buffers.length) {
      this.buffers[i++] = undefined
      offset += this.pageSize
    }
  }

  if (cb) nextTick(cb)
}

RAM.prototype.close = function (cb) {
  if (cb) nextTick(cb)
}

RAM.prototype.destroy = function (cb) {
  this.buffers = []
  if (cb) nextTick(cb)
}

RAM.prototype.toBuffer = function () {
  var buf = this.buffers.length === 1 ? this.buffers[0] : Buffer.concat(this.buffers)
  return buf.length === this.length ? buf : buf.slice(0, this.length)
}

function calloc (len) {
  if (Buffer.alloc) return Buffer.alloc(len)
  var buf = new Buffer(len)
  buf.fill(0)
  return buf
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"process-nextick-args":93}],103:[function(require,module,exports){
(function (process){
var events = require('events')
var inherits = require('inherits')

var NOT_READABLE = defaultImpl(new Error('Not readable'))
var NOT_WRITABLE = defaultImpl(new Error('Not writable'))
var NOT_DELETABLE = defaultImpl(new Error('Not deletable'))
var NOT_STATABLE = defaultImpl(new Error('Not statable'))
var NO_OPEN_READABLE = defaultImpl(new Error('No readonly open'))

module.exports = RandomAccess

function RandomAccess (opts) {
  if (!(this instanceof RandomAccess)) return new RandomAccess(opts)
  events.EventEmitter.call(this)

  this._queued = []
  this._pending = 0
  this._needsOpen = true

  this.opened = false
  this.closed = false
  this.destroyed = false

  if (opts) {
    if (opts.openReadonly) this._openReadonly = opts.openReadonly
    if (opts.open) this._open = opts.open
    if (opts.read) this._read = opts.read
    if (opts.write) this._write = opts.write
    if (opts.del) this._del = opts.del
    if (opts.stat) this._stat = opts.stat
    if (opts.close) this._close = opts.close
    if (opts.destroy) this._destroy = opts.destroy
  }

  this.preferReadonly = this._openReadonly !== NO_OPEN_READABLE
  this.readable = this._read !== NOT_READABLE
  this.writable = this._write !== NOT_WRITABLE
  this.deletable = this._del !== NOT_DELETABLE
  this.statable = this._stat !== NOT_STATABLE
}

inherits(RandomAccess, events.EventEmitter)

RandomAccess.prototype.open = function (cb) {
  if (!cb) cb = noop
  if (this.opened && !this._needsOpen) return process.nextTick(cb, null)
  queueAndRun(this, new Request(this, 0, 0, 0, null, cb))
}

RandomAccess.prototype._open = defaultImpl(null)
RandomAccess.prototype._openReadonly = NO_OPEN_READABLE

RandomAccess.prototype.read = function (offset, size, cb) {
  this.run(new Request(this, 1, offset, size, null, cb))
}

RandomAccess.prototype._read = NOT_READABLE

RandomAccess.prototype.write = function (offset, data, cb) {
  if (!cb) cb = noop
  openWritable(this)
  this.run(new Request(this, 2, offset, data.length, data, cb))
}

RandomAccess.prototype._write = NOT_WRITABLE

RandomAccess.prototype.del = function (offset, size, cb) {
  if (!cb) cb = noop
  openWritable(this)
  this.run(new Request(this, 3, offset, size, null, cb))
}

RandomAccess.prototype._del = NOT_DELETABLE

RandomAccess.prototype.stat = function (cb) {
  this.run(new Request(this, 4, 0, 0, null, cb))
}

RandomAccess.prototype._stat = NOT_STATABLE

RandomAccess.prototype.close = function (cb) {
  if (!cb) cb = noop
  if (this.closed) return process.nextTick(cb, null)
  queueAndRun(this, new Request(this, 5, 0, 0, null, cb))
}

RandomAccess.prototype._close = defaultImpl(null)

RandomAccess.prototype.destroy = function (cb) {
  if (!cb) cb = noop
  if (!this.closed) this.close(noop)
  queueAndRun(this, new Request(this, 6, 0, 0, null, cb))
}

RandomAccess.prototype._destroy = defaultImpl(null)

RandomAccess.prototype.run = function (req) {
  if (this._needsOpen) this.open(noop)
  if (this._queued.length) this._queued.push(req)
  else req._run()
}

function noop () {}

function Request (self, type, offset, size, data, cb) {
  this.type = type
  this.offset = offset
  this.data = data
  this.size = size
  this.storage = self

  this._sync = false
  this._callback = cb
  this._openError = null
}

Request.prototype._maybeOpenError = function (err) {
  if (this.type !== 0) return
  var queued = this.storage._queued
  for (var i = 0; i < queued.length; i++) queued[i]._openError = err
}

Request.prototype._unqueue = function (err) {
  var ra = this.storage
  var queued = ra._queued

  if (!err) {
    switch (this.type) {
      case 0:
        if (!ra.opened) {
          ra.opened = true
          ra.emit('open')
        }
        break

      case 5:
        if (!ra.closed) {
          ra.closed = true
          ra.emit('close')
        }
        break

      case 6:
        if (!ra.destroyed) {
          ra.destroyed = true
          ra.emit('destroy')
        }
        break
    }
  } else {
    this._maybeOpenError(err)
  }

  if (queued.length && queued[0] === this) queued.shift()
  if (!--ra._pending && queued.length) queued[0]._run()
}

Request.prototype.callback = function (err, val) {
  if (this._sync) return nextTick(this, err, val)
  this._unqueue(err)
  this._callback(err, val)
}

Request.prototype._openAndNotClosed = function () {
  var ra = this.storage
  if (ra.opened && !ra.closed) return true
  if (!ra.opened) nextTick(this, this._openError || new Error('Not opened'))
  else if (ra.closed) nextTick(this, new Error('Closed'))
  return false
}

Request.prototype._open = function () {
  var ra = this.storage

  if (ra.opened && !ra._needsOpen) return nextTick(this, null)
  if (ra.closed) return nextTick(this, new Error('Closed'))

  ra._needsOpen = false
  if (ra.preferReadonly) ra._openReadonly(this)
  else ra._open(this)
}

Request.prototype._run = function () {
  var ra = this.storage
  ra._pending++

  this._sync = true

  switch (this.type) {
    case 0:
      this._open()
      break

    case 1:
      if (this._openAndNotClosed()) ra._read(this)
      break

    case 2:
      if (this._openAndNotClosed()) ra._write(this)
      break

    case 3:
      if (this._openAndNotClosed()) ra._del(this)
      break

    case 4:
      if (this._openAndNotClosed()) ra._stat(this)
      break

    case 5:
      if (ra.closed || !ra.opened) nextTick(this, null)
      else ra._close(this)
      break

    case 6:
      if (ra.destroyed) nextTick(this, null)
      else ra._destroy(this)
      break
  }

  this._sync = false
}

function queueAndRun (self, req) {
  self._queued.push(req)
  if (!self._pending) req._run()
}

function openWritable (self) {
  if (self.preferReadonly) {
    self._needsOpen = true
    self.preferReadonly = false
  }
}

function defaultImpl (err) {
  return overridable

  function overridable (req) {
    nextTick(req, err)
  }
}

function nextTick (req, err, val) {
  process.nextTick(nextTickCallback, req, err, val)
}

function nextTickCallback (req, err, val) {
  req.callback(err, val)
}

}).call(this,require('_process'))
},{"_process":94,"events":27,"inherits":71}],104:[function(require,module,exports){
/* global self */
const global = (typeof window !== 'undefined') ? window : self

const requestFileSystem = global.requestFileSystem || global.webkitRequestFileSystem
const mutableFile = global.IDBMutableFile
const idb = global.indexedDB

const DEFAULT_DB_NAME = 'random-access-web'

let storage = () => require('random-access-memory')

if (requestFileSystem) {
  storage = (options) => {
    const RACF = require('random-access-chrome-file')
    if ((typeof options === 'object') && options.maxSize) {
      RACF.DEFAULT_MAX_SIZE = options.maxSize
    }

    return RACF
  }
} else if (mutableFile) {
  storage = (options = {}) => {
    if (typeof options === 'string') options = { name: options }
    return mutableStorage(options)
  }
} else if (idb) {
  storage = (options = {}) => {
    if (typeof options === 'string') options = { name: options }
    const name = options.name || DEFAULT_DB_NAME
    return require('random-access-idb')(name, options)
  }
}

module.exports = storage

function mutableStorage (options) {
  const randomAccess = require('random-access-storage')
  const mutableAccess = require('@sammacbeth/random-access-idb-mutable-file')

  let mounted = null
  let loading = null

  function doMount () {
    return mutableAccess.mount(options).then((requestFile) => {
      mounted = requestFile
      loading = null
    })
  }

  return (name) => {
    let file = null

    return randomAccess({
      open: function (req) {
        if (!mounted) {
          loading = doMount()
        }
        if(loading) {
          loading.then(() => {
            this._open(req)
          }, (err) => {
            req.callback(err)
          })
          return
        }

        file = mounted(name)

        file._open(req)
      },
      openReadonly: function (req) {
        if (!mounted) {
          loading = doMount()
        }
        if(loading) {
          loading.then(() => {
            this._openReadonly(req)
          }, (err) => {
            req.callback(err)
          })
          return
        }

        file = mounted(name)

        file._openReadonly(req)
      },
      write: function (req) {
        file._write(req)
      },
      read: function (req) {
        file._read(req)
      },
      del: function (req) {
        file._del(req)
      },
      stat: function (req) {
        file._stat(req)
      },
      close: function (req) {
        file._close(req)
      },
      destroy: function (req) {
        file._destroy(req)
      }
    })
  }
}

},{"@sammacbeth/random-access-idb-mutable-file":7,"random-access-chrome-file":97,"random-access-idb":99,"random-access-memory":105,"random-access-storage":103}],105:[function(require,module,exports){
(function (process,Buffer){
const RandomAccess = require('random-access-storage')
const isOptions = require('is-options')
const inherits = require('inherits')

const DEFAULT_PAGE_SIZE = 1024 * 1024

module.exports = RAM

function RAM (opts) {
  if (!(this instanceof RAM)) return new RAM(opts)
  if (typeof opts === 'number') opts = {length: opts}
  if (!opts) opts = {}

  RandomAccess.call(this)

  if (Buffer.isBuffer(opts)) {
    opts = {length: opts.length, buffer: opts}
  }
  if (!isOptions(opts)) opts = {}

  this.length = opts.length || 0
  this.pageSize = opts.length || opts.pageSize || DEFAULT_PAGE_SIZE
  this.buffers = []

  if (opts.buffer) this.buffers.push(opts.buffer)
}

inherits(RAM, RandomAccess)

RAM.prototype._stat = function (req) {
  callback(req, null, {size: this.length})
}

RAM.prototype._write = function (req) {
  var i = Math.floor(req.offset / this.pageSize)
  var rel = req.offset - i * this.pageSize
  var start = 0

  const len = req.offset + req.size
  if (len > this.length) this.length = len

  while (start < req.size) {
    const page = this._page(i++, true)
    const free = this.pageSize - rel
    const end = free < (req.size - start)
      ? start + free
      : req.size

    req.data.copy(page, rel, start, end)
    start = end
    rel = 0
  }

  callback(req, null, null)
}

RAM.prototype._read = function (req) {
  var i = Math.floor(req.offset / this.pageSize)
  var rel = req.offset - i * this.pageSize
  var start = 0

  if (req.offset + req.size > this.length) {
    return callback(req, new Error('Could not satisfy length'), null)
  }

  const data = Buffer.alloc(req.size)

  while (start < req.size) {
    const page = this._page(i++, false)
    const avail = this.pageSize - rel
    const wanted = req.size - start
    const len = avail < wanted ? avail : wanted

    if (page) page.copy(data, start, rel, rel + len)
    start += len
    rel = 0
  }

  callback(req, null, data)
}

RAM.prototype._del = function (req) {
  var i = Math.floor(req.offset / this.pageSize)
  var rel = req.offset - i * this.pageSize
  var start = 0

  if (req.offset + req.size > this.length) {
    req.size = Math.max(0, this.length - req.offset)
  }

  while (start < req.size) {
    if (rel === 0 && req.size - start >= this.pageSize) {
      this.buffers[i++] = undefined
    }

    rel = 0
    start += this.pageSize - rel
  }

  if (req.offset + req.size >= this.length) {
    this.length = req.offset
  }

  callback(req, null, null)
}

RAM.prototype._destroy = function (req) {
  this._buffers = []
  this.length = 0
  callback(req, null, null)
}

RAM.prototype._page = function (i, upsert) {
  var page = this.buffers[i]
  if (page || !upsert) return page
  page = this.buffers[i] = Buffer.alloc(this.pageSize)
  return page
}

RAM.prototype.toBuffer = function () {
  const buf = Buffer.alloc(this.length)

  for (var i = 0; i < this.buffers.length; i++) {
    if (this.buffers[i]) this.buffers[i].copy(buf, i * this.pageSize)
  }

  return buf
}

function callback (req, err, data) {
  process.nextTick(callbackNT, req, err, data)
}

function callbackNT (req, err, data) {
  req.callback(err, data)
}

}).call(this,require('_process'),require("buffer").Buffer)
},{"_process":94,"buffer":32,"inherits":71,"is-options":74,"random-access-storage":103}],106:[function(require,module,exports){
(function (process,global){
'use strict'

// limit of Crypto.getRandomValues()
// https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues
var MAX_BYTES = 65536

// Node supports requesting up to this number of bytes
// https://github.com/nodejs/node/blob/master/lib/internal/crypto/random.js#L48
var MAX_UINT32 = 4294967295

function oldBrowser () {
  throw new Error('Secure random number generation is not supported by this browser.\nUse Chrome, Firefox or Internet Explorer 11')
}

var Buffer = require('safe-buffer').Buffer
var crypto = global.crypto || global.msCrypto

if (crypto && crypto.getRandomValues) {
  module.exports = randomBytes
} else {
  module.exports = oldBrowser
}

function randomBytes (size, cb) {
  // phantomjs needs to throw
  if (size > MAX_UINT32) throw new RangeError('requested too many random bytes')

  var bytes = Buffer.allocUnsafe(size)

  if (size > 0) {  // getRandomValues fails on IE if size == 0
    if (size > MAX_BYTES) { // this is the max bytes crypto.getRandomValues
      // can do at once see https://developer.mozilla.org/en-US/docs/Web/API/window.crypto.getRandomValues
      for (var generated = 0; generated < size; generated += MAX_BYTES) {
        // buffer.slice automatically checks if the end is past the end of
        // the buffer so we don't have to here
        crypto.getRandomValues(bytes.slice(generated, generated + MAX_BYTES))
      }
    } else {
      crypto.getRandomValues(bytes)
    }
  }

  if (typeof cb === 'function') {
    return process.nextTick(function () {
      cb(null, bytes)
    })
  }

  return bytes
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"_process":94,"safe-buffer":120}],107:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a duplex stream is just a stream that is both readable and writable.
// Since JS doesn't have multiple prototypal inheritance, this class
// prototypally inherits from Readable, and then parasitically from
// Writable.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

/*<replacement>*/
var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    keys.push(key);
  }return keys;
};
/*</replacement>*/

module.exports = Duplex;

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

var Readable = require('./_stream_readable');
var Writable = require('./_stream_writable');

util.inherits(Duplex, Readable);

{
  // avoid scope creep, the keys array can then be collected
  var keys = objectKeys(Writable.prototype);
  for (var v = 0; v < keys.length; v++) {
    var method = keys[v];
    if (!Duplex.prototype[method]) Duplex.prototype[method] = Writable.prototype[method];
  }
}

function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options);

  Readable.call(this, options);
  Writable.call(this, options);

  if (options && options.readable === false) this.readable = false;

  if (options && options.writable === false) this.writable = false;

  this.allowHalfOpen = true;
  if (options && options.allowHalfOpen === false) this.allowHalfOpen = false;

  this.once('end', onend);
}

Object.defineProperty(Duplex.prototype, 'writableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._writableState.highWaterMark;
  }
});

// the no-half-open enforcer
function onend() {
  // if we allow half-open state, or if the writable side ended,
  // then we're ok.
  if (this.allowHalfOpen || this._writableState.ended) return;

  // no more data can be written.
  // But allow more writes to happen in this tick.
  pna.nextTick(onEndNT, this);
}

function onEndNT(self) {
  self.end();
}

Object.defineProperty(Duplex.prototype, 'destroyed', {
  get: function () {
    if (this._readableState === undefined || this._writableState === undefined) {
      return false;
    }
    return this._readableState.destroyed && this._writableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (this._readableState === undefined || this._writableState === undefined) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._readableState.destroyed = value;
    this._writableState.destroyed = value;
  }
});

Duplex.prototype._destroy = function (err, cb) {
  this.push(null);
  this.end();

  pna.nextTick(cb, err);
};
},{"./_stream_readable":109,"./_stream_writable":111,"core-util-is":35,"inherits":71,"process-nextick-args":115}],108:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a passthrough stream.
// basically just the most minimal sort of Transform stream.
// Every written chunk gets output as-is.

'use strict';

module.exports = PassThrough;

var Transform = require('./_stream_transform');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(PassThrough, Transform);

function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options);

  Transform.call(this, options);
}

PassThrough.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk);
};
},{"./_stream_transform":110,"core-util-is":35,"inherits":71}],109:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

module.exports = Readable;

/*<replacement>*/
var isArray = require('isarray');
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Readable.ReadableState = ReadableState;

/*<replacement>*/
var EE = require('events').EventEmitter;

var EElistenerCount = function (emitter, type) {
  return emitter.listeners(type).length;
};
/*</replacement>*/

/*<replacement>*/
var Stream = require('./internal/streams/stream');
/*</replacement>*/

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
var OurUint8Array = global.Uint8Array || function () {};
function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk);
}
function _isUint8Array(obj) {
  return Buffer.isBuffer(obj) || obj instanceof OurUint8Array;
}

/*</replacement>*/

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

/*<replacement>*/
var debugUtil = require('util');
var debug = void 0;
if (debugUtil && debugUtil.debuglog) {
  debug = debugUtil.debuglog('stream');
} else {
  debug = function () {};
}
/*</replacement>*/

var BufferList = require('./internal/streams/BufferList');
var destroyImpl = require('./internal/streams/destroy');
var StringDecoder;

util.inherits(Readable, Stream);

var kProxyEvents = ['error', 'close', 'destroy', 'pause', 'resume'];

function prependListener(emitter, event, fn) {
  // Sadly this is not cacheable as some libraries bundle their own
  // event emitter implementation with them.
  if (typeof emitter.prependListener === 'function') return emitter.prependListener(event, fn);

  // This is a hack to make sure that our error handler is attached before any
  // userland ones.  NEVER DO THIS. This is here only because this code needs
  // to continue to work with older versions of Node.js that do not include
  // the prependListener() method. The goal is to eventually remove this hack.
  if (!emitter._events || !emitter._events[event]) emitter.on(event, fn);else if (isArray(emitter._events[event])) emitter._events[event].unshift(fn);else emitter._events[event] = [fn, emitter._events[event]];
}

function ReadableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

  options = options || {};

  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  var isDuplex = stream instanceof Duplex;

  // object stream flag. Used to make read(n) ignore n and to
  // make all the buffer merging and length checks go away
  this.objectMode = !!options.objectMode;

  if (isDuplex) this.objectMode = this.objectMode || !!options.readableObjectMode;

  // the point at which it stops calling _read() to fill the buffer
  // Note: 0 is a valid value, means "don't call _read preemptively ever"
  var hwm = options.highWaterMark;
  var readableHwm = options.readableHighWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;

  if (hwm || hwm === 0) this.highWaterMark = hwm;else if (isDuplex && (readableHwm || readableHwm === 0)) this.highWaterMark = readableHwm;else this.highWaterMark = defaultHwm;

  // cast to ints.
  this.highWaterMark = Math.floor(this.highWaterMark);

  // A linked list is used to store data chunks instead of an array because the
  // linked list can remove elements from the beginning faster than
  // array.shift()
  this.buffer = new BufferList();
  this.length = 0;
  this.pipes = null;
  this.pipesCount = 0;
  this.flowing = null;
  this.ended = false;
  this.endEmitted = false;
  this.reading = false;

  // a flag to be able to tell if the event 'readable'/'data' is emitted
  // immediately, or on a later tick.  We set this to true at first, because
  // any actions that shouldn't happen until "later" should generally also
  // not happen before the first read call.
  this.sync = true;

  // whenever we return null, then we set a flag to say
  // that we're awaiting a 'readable' event emission.
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;

  // has it been destroyed
  this.destroyed = false;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // the number of writers that are awaiting a drain event in .pipe()s
  this.awaitDrain = 0;

  // if true, a maybeReadMore has been scheduled
  this.readingMore = false;

  this.decoder = null;
  this.encoding = null;
  if (options.encoding) {
    if (!StringDecoder) StringDecoder = require('string_decoder/').StringDecoder;
    this.decoder = new StringDecoder(options.encoding);
    this.encoding = options.encoding;
  }
}

function Readable(options) {
  Duplex = Duplex || require('./_stream_duplex');

  if (!(this instanceof Readable)) return new Readable(options);

  this._readableState = new ReadableState(options, this);

  // legacy
  this.readable = true;

  if (options) {
    if (typeof options.read === 'function') this._read = options.read;

    if (typeof options.destroy === 'function') this._destroy = options.destroy;
  }

  Stream.call(this);
}

Object.defineProperty(Readable.prototype, 'destroyed', {
  get: function () {
    if (this._readableState === undefined) {
      return false;
    }
    return this._readableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (!this._readableState) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._readableState.destroyed = value;
  }
});

Readable.prototype.destroy = destroyImpl.destroy;
Readable.prototype._undestroy = destroyImpl.undestroy;
Readable.prototype._destroy = function (err, cb) {
  this.push(null);
  cb(err);
};

// Manually shove something into the read() buffer.
// This returns true if the highWaterMark has not been hit yet,
// similar to how Writable.write() returns true if you should
// write() some more.
Readable.prototype.push = function (chunk, encoding) {
  var state = this._readableState;
  var skipChunkCheck;

  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      encoding = encoding || state.defaultEncoding;
      if (encoding !== state.encoding) {
        chunk = Buffer.from(chunk, encoding);
        encoding = '';
      }
      skipChunkCheck = true;
    }
  } else {
    skipChunkCheck = true;
  }

  return readableAddChunk(this, chunk, encoding, false, skipChunkCheck);
};

// Unshift should *always* be something directly out of read()
Readable.prototype.unshift = function (chunk) {
  return readableAddChunk(this, chunk, null, true, false);
};

function readableAddChunk(stream, chunk, encoding, addToFront, skipChunkCheck) {
  var state = stream._readableState;
  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
  } else {
    var er;
    if (!skipChunkCheck) er = chunkInvalid(state, chunk);
    if (er) {
      stream.emit('error', er);
    } else if (state.objectMode || chunk && chunk.length > 0) {
      if (typeof chunk !== 'string' && !state.objectMode && Object.getPrototypeOf(chunk) !== Buffer.prototype) {
        chunk = _uint8ArrayToBuffer(chunk);
      }

      if (addToFront) {
        if (state.endEmitted) stream.emit('error', new Error('stream.unshift() after end event'));else addChunk(stream, state, chunk, true);
      } else if (state.ended) {
        stream.emit('error', new Error('stream.push() after EOF'));
      } else {
        state.reading = false;
        if (state.decoder && !encoding) {
          chunk = state.decoder.write(chunk);
          if (state.objectMode || chunk.length !== 0) addChunk(stream, state, chunk, false);else maybeReadMore(stream, state);
        } else {
          addChunk(stream, state, chunk, false);
        }
      }
    } else if (!addToFront) {
      state.reading = false;
    }
  }

  return needMoreData(state);
}

function addChunk(stream, state, chunk, addToFront) {
  if (state.flowing && state.length === 0 && !state.sync) {
    stream.emit('data', chunk);
    stream.read(0);
  } else {
    // update the buffer info.
    state.length += state.objectMode ? 1 : chunk.length;
    if (addToFront) state.buffer.unshift(chunk);else state.buffer.push(chunk);

    if (state.needReadable) emitReadable(stream);
  }
  maybeReadMore(stream, state);
}

function chunkInvalid(state, chunk) {
  var er;
  if (!_isUint8Array(chunk) && typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  return er;
}

// if it's past the high water mark, we can push in some more.
// Also, if we have no data yet, we can stand some
// more bytes.  This is to work around cases where hwm=0,
// such as the repl.  Also, if the push() triggered a
// readable event, and the user called read(largeNumber) such that
// needReadable was set, then we ought to push more, so that another
// 'readable' event will be triggered.
function needMoreData(state) {
  return !state.ended && (state.needReadable || state.length < state.highWaterMark || state.length === 0);
}

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
};

// backwards compatibility.
Readable.prototype.setEncoding = function (enc) {
  if (!StringDecoder) StringDecoder = require('string_decoder/').StringDecoder;
  this._readableState.decoder = new StringDecoder(enc);
  this._readableState.encoding = enc;
  return this;
};

// Don't raise the hwm > 8MB
var MAX_HWM = 0x800000;
function computeNewHighWaterMark(n) {
  if (n >= MAX_HWM) {
    n = MAX_HWM;
  } else {
    // Get the next highest power of 2 to prevent increasing hwm excessively in
    // tiny amounts
    n--;
    n |= n >>> 1;
    n |= n >>> 2;
    n |= n >>> 4;
    n |= n >>> 8;
    n |= n >>> 16;
    n++;
  }
  return n;
}

// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function howMuchToRead(n, state) {
  if (n <= 0 || state.length === 0 && state.ended) return 0;
  if (state.objectMode) return 1;
  if (n !== n) {
    // Only flow one buffer at a time
    if (state.flowing && state.length) return state.buffer.head.data.length;else return state.length;
  }
  // If we're asking for more than the current hwm, then raise the hwm.
  if (n > state.highWaterMark) state.highWaterMark = computeNewHighWaterMark(n);
  if (n <= state.length) return n;
  // Don't have enough
  if (!state.ended) {
    state.needReadable = true;
    return 0;
  }
  return state.length;
}

// you can override either this method, or the async _read(n) below.
Readable.prototype.read = function (n) {
  debug('read', n);
  n = parseInt(n, 10);
  var state = this._readableState;
  var nOrig = n;

  if (n !== 0) state.emittedReadable = false;

  // if we're doing read(0) to trigger a readable event, but we
  // already have a bunch of data in the buffer, then just trigger
  // the 'readable' event and move on.
  if (n === 0 && state.needReadable && (state.length >= state.highWaterMark || state.ended)) {
    debug('read: emitReadable', state.length, state.ended);
    if (state.length === 0 && state.ended) endReadable(this);else emitReadable(this);
    return null;
  }

  n = howMuchToRead(n, state);

  // if we've ended, and we're now clear, then finish it up.
  if (n === 0 && state.ended) {
    if (state.length === 0) endReadable(this);
    return null;
  }

  // All the actual chunk generation logic needs to be
  // *below* the call to _read.  The reason is that in certain
  // synthetic stream cases, such as passthrough streams, _read
  // may be a completely synchronous operation which may change
  // the state of the read buffer, providing enough data when
  // before there was *not* enough.
  //
  // So, the steps are:
  // 1. Figure out what the state of things will be after we do
  // a read from the buffer.
  //
  // 2. If that resulting state will trigger a _read, then call _read.
  // Note that this may be asynchronous, or synchronous.  Yes, it is
  // deeply ugly to write APIs this way, but that still doesn't mean
  // that the Readable class should behave improperly, as streams are
  // designed to be sync/async agnostic.
  // Take note if the _read call is sync or async (ie, if the read call
  // has returned yet), so that we know whether or not it's safe to emit
  // 'readable' etc.
  //
  // 3. Actually pull the requested chunks out of the buffer and return.

  // if we need a readable event, then we need to do some reading.
  var doRead = state.needReadable;
  debug('need readable', doRead);

  // if we currently have less than the highWaterMark, then also read some
  if (state.length === 0 || state.length - n < state.highWaterMark) {
    doRead = true;
    debug('length less than watermark', doRead);
  }

  // however, if we've ended, then there's no point, and if we're already
  // reading, then it's unnecessary.
  if (state.ended || state.reading) {
    doRead = false;
    debug('reading or ended', doRead);
  } else if (doRead) {
    debug('do read');
    state.reading = true;
    state.sync = true;
    // if the length is currently zero, then we *need* a readable event.
    if (state.length === 0) state.needReadable = true;
    // call internal read method
    this._read(state.highWaterMark);
    state.sync = false;
    // If _read pushed data synchronously, then `reading` will be false,
    // and we need to re-evaluate how much data we can return to the user.
    if (!state.reading) n = howMuchToRead(nOrig, state);
  }

  var ret;
  if (n > 0) ret = fromList(n, state);else ret = null;

  if (ret === null) {
    state.needReadable = true;
    n = 0;
  } else {
    state.length -= n;
  }

  if (state.length === 0) {
    // If we have nothing in the buffer, then we want to know
    // as soon as we *do* get something into the buffer.
    if (!state.ended) state.needReadable = true;

    // If we tried to read() past the EOF, then emit end on the next tick.
    if (nOrig !== n && state.ended) endReadable(this);
  }

  if (ret !== null) this.emit('data', ret);

  return ret;
};

function onEofChunk(stream, state) {
  if (state.ended) return;
  if (state.decoder) {
    var chunk = state.decoder.end();
    if (chunk && chunk.length) {
      state.buffer.push(chunk);
      state.length += state.objectMode ? 1 : chunk.length;
    }
  }
  state.ended = true;

  // emit 'readable' now to make sure it gets picked up.
  emitReadable(stream);
}

// Don't emit readable right away in sync mode, because this can trigger
// another read() call => stack overflow.  This way, it might trigger
// a nextTick recursion warning, but that's not so bad.
function emitReadable(stream) {
  var state = stream._readableState;
  state.needReadable = false;
  if (!state.emittedReadable) {
    debug('emitReadable', state.flowing);
    state.emittedReadable = true;
    if (state.sync) pna.nextTick(emitReadable_, stream);else emitReadable_(stream);
  }
}

function emitReadable_(stream) {
  debug('emit readable');
  stream.emit('readable');
  flow(stream);
}

// at this point, the user has presumably seen the 'readable' event,
// and called read() to consume some data.  that may have triggered
// in turn another _read(n) call, in which case reading = true if
// it's in progress.
// However, if we're not ended, or reading, and the length < hwm,
// then go ahead and try to read some more preemptively.
function maybeReadMore(stream, state) {
  if (!state.readingMore) {
    state.readingMore = true;
    pna.nextTick(maybeReadMore_, stream, state);
  }
}

function maybeReadMore_(stream, state) {
  var len = state.length;
  while (!state.reading && !state.flowing && !state.ended && state.length < state.highWaterMark) {
    debug('maybeReadMore read 0');
    stream.read(0);
    if (len === state.length)
      // didn't get any data, stop spinning.
      break;else len = state.length;
  }
  state.readingMore = false;
}

// abstract method.  to be overridden in specific implementation classes.
// call cb(er, data) where data is <= n in length.
// for virtual (non-string, non-buffer) streams, "length" is somewhat
// arbitrary, and perhaps not very meaningful.
Readable.prototype._read = function (n) {
  this.emit('error', new Error('_read() is not implemented'));
};

Readable.prototype.pipe = function (dest, pipeOpts) {
  var src = this;
  var state = this._readableState;

  switch (state.pipesCount) {
    case 0:
      state.pipes = dest;
      break;
    case 1:
      state.pipes = [state.pipes, dest];
      break;
    default:
      state.pipes.push(dest);
      break;
  }
  state.pipesCount += 1;
  debug('pipe count=%d opts=%j', state.pipesCount, pipeOpts);

  var doEnd = (!pipeOpts || pipeOpts.end !== false) && dest !== process.stdout && dest !== process.stderr;

  var endFn = doEnd ? onend : unpipe;
  if (state.endEmitted) pna.nextTick(endFn);else src.once('end', endFn);

  dest.on('unpipe', onunpipe);
  function onunpipe(readable, unpipeInfo) {
    debug('onunpipe');
    if (readable === src) {
      if (unpipeInfo && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        cleanup();
      }
    }
  }

  function onend() {
    debug('onend');
    dest.end();
  }

  // when the dest drains, it reduces the awaitDrain counter
  // on the source.  This would be more elegant with a .once()
  // handler in flow(), but adding and removing repeatedly is
  // too slow.
  var ondrain = pipeOnDrain(src);
  dest.on('drain', ondrain);

  var cleanedUp = false;
  function cleanup() {
    debug('cleanup');
    // cleanup event handlers once the pipe is broken
    dest.removeListener('close', onclose);
    dest.removeListener('finish', onfinish);
    dest.removeListener('drain', ondrain);
    dest.removeListener('error', onerror);
    dest.removeListener('unpipe', onunpipe);
    src.removeListener('end', onend);
    src.removeListener('end', unpipe);
    src.removeListener('data', ondata);

    cleanedUp = true;

    // if the reader is waiting for a drain event from this
    // specific writer, then it would cause it to never start
    // flowing again.
    // So, if this is awaiting a drain, then we just call it now.
    // If we don't know, then assume that we are waiting for one.
    if (state.awaitDrain && (!dest._writableState || dest._writableState.needDrain)) ondrain();
  }

  // If the user pushes more data while we're writing to dest then we'll end up
  // in ondata again. However, we only want to increase awaitDrain once because
  // dest will only emit one 'drain' event for the multiple writes.
  // => Introduce a guard on increasing awaitDrain.
  var increasedAwaitDrain = false;
  src.on('data', ondata);
  function ondata(chunk) {
    debug('ondata');
    increasedAwaitDrain = false;
    var ret = dest.write(chunk);
    if (false === ret && !increasedAwaitDrain) {
      // If the user unpiped during `dest.write()`, it is possible
      // to get stuck in a permanently paused state if that write
      // also returned false.
      // => Check whether `dest` is still a piping destination.
      if ((state.pipesCount === 1 && state.pipes === dest || state.pipesCount > 1 && indexOf(state.pipes, dest) !== -1) && !cleanedUp) {
        debug('false write response, pause', src._readableState.awaitDrain);
        src._readableState.awaitDrain++;
        increasedAwaitDrain = true;
      }
      src.pause();
    }
  }

  // if the dest has an error, then stop piping into it.
  // however, don't suppress the throwing behavior for this.
  function onerror(er) {
    debug('onerror', er);
    unpipe();
    dest.removeListener('error', onerror);
    if (EElistenerCount(dest, 'error') === 0) dest.emit('error', er);
  }

  // Make sure our error handler is attached before userland ones.
  prependListener(dest, 'error', onerror);

  // Both close and finish should trigger unpipe, but only once.
  function onclose() {
    dest.removeListener('finish', onfinish);
    unpipe();
  }
  dest.once('close', onclose);
  function onfinish() {
    debug('onfinish');
    dest.removeListener('close', onclose);
    unpipe();
  }
  dest.once('finish', onfinish);

  function unpipe() {
    debug('unpipe');
    src.unpipe(dest);
  }

  // tell the dest that it's being piped to
  dest.emit('pipe', src);

  // start the flow if it hasn't been started already.
  if (!state.flowing) {
    debug('pipe resume');
    src.resume();
  }

  return dest;
};

function pipeOnDrain(src) {
  return function () {
    var state = src._readableState;
    debug('pipeOnDrain', state.awaitDrain);
    if (state.awaitDrain) state.awaitDrain--;
    if (state.awaitDrain === 0 && EElistenerCount(src, 'data')) {
      state.flowing = true;
      flow(src);
    }
  };
}

Readable.prototype.unpipe = function (dest) {
  var state = this._readableState;
  var unpipeInfo = { hasUnpiped: false };

  // if we're not piping anywhere, then do nothing.
  if (state.pipesCount === 0) return this;

  // just one destination.  most common case.
  if (state.pipesCount === 1) {
    // passed in one, but it's not the right one.
    if (dest && dest !== state.pipes) return this;

    if (!dest) dest = state.pipes;

    // got a match.
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;
    if (dest) dest.emit('unpipe', this, unpipeInfo);
    return this;
  }

  // slow case. multiple pipe destinations.

  if (!dest) {
    // remove all.
    var dests = state.pipes;
    var len = state.pipesCount;
    state.pipes = null;
    state.pipesCount = 0;
    state.flowing = false;

    for (var i = 0; i < len; i++) {
      dests[i].emit('unpipe', this, unpipeInfo);
    }return this;
  }

  // try to find the right one.
  var index = indexOf(state.pipes, dest);
  if (index === -1) return this;

  state.pipes.splice(index, 1);
  state.pipesCount -= 1;
  if (state.pipesCount === 1) state.pipes = state.pipes[0];

  dest.emit('unpipe', this, unpipeInfo);

  return this;
};

// set up data events if they are asked for
// Ensure readable listeners eventually get something
Readable.prototype.on = function (ev, fn) {
  var res = Stream.prototype.on.call(this, ev, fn);

  if (ev === 'data') {
    // Start flowing on next tick if stream isn't explicitly paused
    if (this._readableState.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    var state = this._readableState;
    if (!state.endEmitted && !state.readableListening) {
      state.readableListening = state.needReadable = true;
      state.emittedReadable = false;
      if (!state.reading) {
        pna.nextTick(nReadingNextTick, this);
      } else if (state.length) {
        emitReadable(this);
      }
    }
  }

  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

function nReadingNextTick(self) {
  debug('readable nexttick read 0');
  self.read(0);
}

// pause() and resume() are remnants of the legacy readable stream API
// If the user uses them, then switch into old mode.
Readable.prototype.resume = function () {
  var state = this._readableState;
  if (!state.flowing) {
    debug('resume');
    state.flowing = true;
    resume(this, state);
  }
  return this;
};

function resume(stream, state) {
  if (!state.resumeScheduled) {
    state.resumeScheduled = true;
    pna.nextTick(resume_, stream, state);
  }
}

function resume_(stream, state) {
  if (!state.reading) {
    debug('resume read 0');
    stream.read(0);
  }

  state.resumeScheduled = false;
  state.awaitDrain = 0;
  stream.emit('resume');
  flow(stream);
  if (state.flowing && !state.reading) stream.read(0);
}

Readable.prototype.pause = function () {
  debug('call pause flowing=%j', this._readableState.flowing);
  if (false !== this._readableState.flowing) {
    debug('pause');
    this._readableState.flowing = false;
    this.emit('pause');
  }
  return this;
};

function flow(stream) {
  var state = stream._readableState;
  debug('flow', state.flowing);
  while (state.flowing && stream.read() !== null) {}
}

// wrap an old-style stream as the async data source.
// This is *not* part of the readable stream interface.
// It is an ugly unfortunate mess of history.
Readable.prototype.wrap = function (stream) {
  var _this = this;

  var state = this._readableState;
  var paused = false;

  stream.on('end', function () {
    debug('wrapped end');
    if (state.decoder && !state.ended) {
      var chunk = state.decoder.end();
      if (chunk && chunk.length) _this.push(chunk);
    }

    _this.push(null);
  });

  stream.on('data', function (chunk) {
    debug('wrapped data');
    if (state.decoder) chunk = state.decoder.write(chunk);

    // don't skip over falsy values in objectMode
    if (state.objectMode && (chunk === null || chunk === undefined)) return;else if (!state.objectMode && (!chunk || !chunk.length)) return;

    var ret = _this.push(chunk);
    if (!ret) {
      paused = true;
      stream.pause();
    }
  });

  // proxy all the other methods.
  // important when wrapping filters and duplexes.
  for (var i in stream) {
    if (this[i] === undefined && typeof stream[i] === 'function') {
      this[i] = function (method) {
        return function () {
          return stream[method].apply(stream, arguments);
        };
      }(i);
    }
  }

  // proxy certain important events.
  for (var n = 0; n < kProxyEvents.length; n++) {
    stream.on(kProxyEvents[n], this.emit.bind(this, kProxyEvents[n]));
  }

  // when we try to consume some more bytes, simply unpause the
  // underlying stream.
  this._read = function (n) {
    debug('wrapped _read', n);
    if (paused) {
      paused = false;
      stream.resume();
    }
  };

  return this;
};

Object.defineProperty(Readable.prototype, 'readableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._readableState.highWaterMark;
  }
});

// exposed for testing purposes only.
Readable._fromList = fromList;

// Pluck off n bytes from an array of buffers.
// Length is the combined lengths of all the buffers in the list.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromList(n, state) {
  // nothing buffered
  if (state.length === 0) return null;

  var ret;
  if (state.objectMode) ret = state.buffer.shift();else if (!n || n >= state.length) {
    // read it all, truncate the list
    if (state.decoder) ret = state.buffer.join('');else if (state.buffer.length === 1) ret = state.buffer.head.data;else ret = state.buffer.concat(state.length);
    state.buffer.clear();
  } else {
    // read part of list
    ret = fromListPartial(n, state.buffer, state.decoder);
  }

  return ret;
}

// Extracts only enough buffered data to satisfy the amount requested.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function fromListPartial(n, list, hasStrings) {
  var ret;
  if (n < list.head.data.length) {
    // slice is the same for buffers and strings
    ret = list.head.data.slice(0, n);
    list.head.data = list.head.data.slice(n);
  } else if (n === list.head.data.length) {
    // first chunk is a perfect match
    ret = list.shift();
  } else {
    // result spans more than one buffer
    ret = hasStrings ? copyFromBufferString(n, list) : copyFromBuffer(n, list);
  }
  return ret;
}

// Copies a specified amount of characters from the list of buffered data
// chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBufferString(n, list) {
  var p = list.head;
  var c = 1;
  var ret = p.data;
  n -= ret.length;
  while (p = p.next) {
    var str = p.data;
    var nb = n > str.length ? str.length : n;
    if (nb === str.length) ret += str;else ret += str.slice(0, n);
    n -= nb;
    if (n === 0) {
      if (nb === str.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = str.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

// Copies a specified amount of bytes from the list of buffered data chunks.
// This function is designed to be inlinable, so please take care when making
// changes to the function body.
function copyFromBuffer(n, list) {
  var ret = Buffer.allocUnsafe(n);
  var p = list.head;
  var c = 1;
  p.data.copy(ret);
  n -= p.data.length;
  while (p = p.next) {
    var buf = p.data;
    var nb = n > buf.length ? buf.length : n;
    buf.copy(ret, ret.length - n, 0, nb);
    n -= nb;
    if (n === 0) {
      if (nb === buf.length) {
        ++c;
        if (p.next) list.head = p.next;else list.head = list.tail = null;
      } else {
        list.head = p;
        p.data = buf.slice(nb);
      }
      break;
    }
    ++c;
  }
  list.length -= c;
  return ret;
}

function endReadable(stream) {
  var state = stream._readableState;

  // If we get here before consuming all the bytes, then that is a
  // bug in node.  Should never happen.
  if (state.length > 0) throw new Error('"endReadable()" called on non-empty stream');

  if (!state.endEmitted) {
    state.ended = true;
    pna.nextTick(endReadableNT, state, stream);
  }
}

function endReadableNT(state, stream) {
  // Check that we didn't get one last unshift.
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    stream.emit('end');
  }
}

function indexOf(xs, x) {
  for (var i = 0, l = xs.length; i < l; i++) {
    if (xs[i] === x) return i;
  }
  return -1;
}
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./_stream_duplex":107,"./internal/streams/BufferList":112,"./internal/streams/destroy":113,"./internal/streams/stream":114,"_process":94,"core-util-is":35,"events":27,"inherits":71,"isarray":75,"process-nextick-args":115,"safe-buffer":120,"string_decoder/":142,"util":26}],110:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// a transform stream is a readable/writable stream where you do
// something with the data.  Sometimes it's called a "filter",
// but that's not a great name for it, since that implies a thing where
// some bits pass through, and others are simply ignored.  (That would
// be a valid example of a transform, of course.)
//
// While the output is causally related to the input, it's not a
// necessarily symmetric or synchronous transformation.  For example,
// a zlib stream might take multiple plain-text writes(), and then
// emit a single compressed chunk some time in the future.
//
// Here's how this works:
//
// The Transform stream has all the aspects of the readable and writable
// stream classes.  When you write(chunk), that calls _write(chunk,cb)
// internally, and returns false if there's a lot of pending writes
// buffered up.  When you call read(), that calls _read(n) until
// there's enough pending readable data buffered up.
//
// In a transform stream, the written data is placed in a buffer.  When
// _read(n) is called, it transforms the queued up data, calling the
// buffered _write cb's as it consumes chunks.  If consuming a single
// written chunk would result in multiple output chunks, then the first
// outputted bit calls the readcb, and subsequent chunks just go into
// the read buffer, and will cause it to emit 'readable' if necessary.
//
// This way, back-pressure is actually determined by the reading side,
// since _read has to be called to start processing a new chunk.  However,
// a pathological inflate type of transform can cause excessive buffering
// here.  For example, imagine a stream where every byte of input is
// interpreted as an integer from 0-255, and then results in that many
// bytes of output.  Writing the 4 bytes {ff,ff,ff,ff} would result in
// 1kb of data being output.  In this case, you could write a very small
// amount of input, and end up with a very large amount of output.  In
// such a pathological inflating mechanism, there'd be no way to tell
// the system to stop doing the transform.  A single 4MB write could
// cause the system to run out of memory.
//
// However, even in such a pathological case, only a single written chunk
// would be consumed, and then the rest would wait (un-transformed) until
// the results of the previous transformed chunk were consumed.

'use strict';

module.exports = Transform;

var Duplex = require('./_stream_duplex');

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

util.inherits(Transform, Duplex);

function afterTransform(er, data) {
  var ts = this._transformState;
  ts.transforming = false;

  var cb = ts.writecb;

  if (!cb) {
    return this.emit('error', new Error('write callback called multiple times'));
  }

  ts.writechunk = null;
  ts.writecb = null;

  if (data != null) // single equals check for both `null` and `undefined`
    this.push(data);

  cb(er);

  var rs = this._readableState;
  rs.reading = false;
  if (rs.needReadable || rs.length < rs.highWaterMark) {
    this._read(rs.highWaterMark);
  }
}

function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);

  Duplex.call(this, options);

  this._transformState = {
    afterTransform: afterTransform.bind(this),
    needTransform: false,
    transforming: false,
    writecb: null,
    writechunk: null,
    writeencoding: null
  };

  // start out asking for a readable event once data is transformed.
  this._readableState.needReadable = true;

  // we have implemented the _read method, and done the other things
  // that Readable wants before the first _read call, so unset the
  // sync guard flag.
  this._readableState.sync = false;

  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;

    if (typeof options.flush === 'function') this._flush = options.flush;
  }

  // When the writable side finishes, then flush out anything remaining.
  this.on('prefinish', prefinish);
}

function prefinish() {
  var _this = this;

  if (typeof this._flush === 'function') {
    this._flush(function (er, data) {
      done(_this, er, data);
    });
  } else {
    done(this, null, null);
  }
}

Transform.prototype.push = function (chunk, encoding) {
  this._transformState.needTransform = false;
  return Duplex.prototype.push.call(this, chunk, encoding);
};

// This is the part where you do stuff!
// override this function in implementation classes.
// 'chunk' is an input chunk.
//
// Call `push(newChunk)` to pass along transformed output
// to the readable side.  You may call 'push' zero or more times.
//
// Call `cb(err)` when you are done with this chunk.  If you pass
// an error, then that'll put the hurt on the whole operation.  If you
// never call cb(), then you'll never get another chunk.
Transform.prototype._transform = function (chunk, encoding, cb) {
  throw new Error('_transform() is not implemented');
};

Transform.prototype._write = function (chunk, encoding, cb) {
  var ts = this._transformState;
  ts.writecb = cb;
  ts.writechunk = chunk;
  ts.writeencoding = encoding;
  if (!ts.transforming) {
    var rs = this._readableState;
    if (ts.needTransform || rs.needReadable || rs.length < rs.highWaterMark) this._read(rs.highWaterMark);
  }
};

// Doesn't matter what the args are here.
// _transform does all the work.
// That we got here means that the readable side wants more data.
Transform.prototype._read = function (n) {
  var ts = this._transformState;

  if (ts.writechunk !== null && ts.writecb && !ts.transforming) {
    ts.transforming = true;
    this._transform(ts.writechunk, ts.writeencoding, ts.afterTransform);
  } else {
    // mark that we need a transform, so that any data that comes in
    // will get processed, now that we've asked for it.
    ts.needTransform = true;
  }
};

Transform.prototype._destroy = function (err, cb) {
  var _this2 = this;

  Duplex.prototype._destroy.call(this, err, function (err2) {
    cb(err2);
    _this2.emit('close');
  });
};

function done(stream, er, data) {
  if (er) return stream.emit('error', er);

  if (data != null) // single equals check for both `null` and `undefined`
    stream.push(data);

  // if there's nothing in the write buffer, then that means
  // that nothing more will ever be provided
  if (stream._writableState.length) throw new Error('Calling transform done when ws.length != 0');

  if (stream._transformState.transforming) throw new Error('Calling transform done when still transforming');

  return stream.push(null);
}
},{"./_stream_duplex":107,"core-util-is":35,"inherits":71}],111:[function(require,module,exports){
(function (process,global,setImmediate){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// A bit simpler than readable streams.
// Implement an async ._write(chunk, encoding, cb), and it'll handle all
// the drain event emission and buffering.

'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

module.exports = Writable;

/* <replacement> */
function WriteReq(chunk, encoding, cb) {
  this.chunk = chunk;
  this.encoding = encoding;
  this.callback = cb;
  this.next = null;
}

// It seems a linked list but it is not
// there will be only 2 of these for each stream
function CorkedRequest(state) {
  var _this = this;

  this.next = null;
  this.entry = null;
  this.finish = function () {
    onCorkedFinish(_this, state);
  };
}
/* </replacement> */

/*<replacement>*/
var asyncWrite = !process.browser && ['v0.10', 'v0.9.'].indexOf(process.version.slice(0, 5)) > -1 ? setImmediate : pna.nextTick;
/*</replacement>*/

/*<replacement>*/
var Duplex;
/*</replacement>*/

Writable.WritableState = WritableState;

/*<replacement>*/
var util = require('core-util-is');
util.inherits = require('inherits');
/*</replacement>*/

/*<replacement>*/
var internalUtil = {
  deprecate: require('util-deprecate')
};
/*</replacement>*/

/*<replacement>*/
var Stream = require('./internal/streams/stream');
/*</replacement>*/

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
var OurUint8Array = global.Uint8Array || function () {};
function _uint8ArrayToBuffer(chunk) {
  return Buffer.from(chunk);
}
function _isUint8Array(obj) {
  return Buffer.isBuffer(obj) || obj instanceof OurUint8Array;
}

/*</replacement>*/

var destroyImpl = require('./internal/streams/destroy');

util.inherits(Writable, Stream);

function nop() {}

function WritableState(options, stream) {
  Duplex = Duplex || require('./_stream_duplex');

  options = options || {};

  // Duplex streams are both readable and writable, but share
  // the same options object.
  // However, some cases require setting options to different
  // values for the readable and the writable sides of the duplex stream.
  // These options can be provided separately as readableXXX and writableXXX.
  var isDuplex = stream instanceof Duplex;

  // object stream flag to indicate whether or not this stream
  // contains buffers or objects.
  this.objectMode = !!options.objectMode;

  if (isDuplex) this.objectMode = this.objectMode || !!options.writableObjectMode;

  // the point at which write() starts returning false
  // Note: 0 is a valid value, means that we always return false if
  // the entire buffer is not flushed immediately on write()
  var hwm = options.highWaterMark;
  var writableHwm = options.writableHighWaterMark;
  var defaultHwm = this.objectMode ? 16 : 16 * 1024;

  if (hwm || hwm === 0) this.highWaterMark = hwm;else if (isDuplex && (writableHwm || writableHwm === 0)) this.highWaterMark = writableHwm;else this.highWaterMark = defaultHwm;

  // cast to ints.
  this.highWaterMark = Math.floor(this.highWaterMark);

  // if _final has been called
  this.finalCalled = false;

  // drain event flag.
  this.needDrain = false;
  // at the start of calling end()
  this.ending = false;
  // when end() has been called, and returned
  this.ended = false;
  // when 'finish' is emitted
  this.finished = false;

  // has it been destroyed
  this.destroyed = false;

  // should we decode strings into buffers before passing to _write?
  // this is here so that some node-core streams can optimize string
  // handling at a lower level.
  var noDecode = options.decodeStrings === false;
  this.decodeStrings = !noDecode;

  // Crypto is kind of old and crusty.  Historically, its default string
  // encoding is 'binary' so we have to make this configurable.
  // Everything else in the universe uses 'utf8', though.
  this.defaultEncoding = options.defaultEncoding || 'utf8';

  // not an actual buffer we keep track of, but a measurement
  // of how much we're waiting to get pushed to some underlying
  // socket or file.
  this.length = 0;

  // a flag to see when we're in the middle of a write.
  this.writing = false;

  // when true all writes will be buffered until .uncork() call
  this.corked = 0;

  // a flag to be able to tell if the onwrite cb is called immediately,
  // or on a later tick.  We set this to true at first, because any
  // actions that shouldn't happen until "later" should generally also
  // not happen before the first write call.
  this.sync = true;

  // a flag to know if we're processing previously buffered items, which
  // may call the _write() callback in the same tick, so that we don't
  // end up in an overlapped onwrite situation.
  this.bufferProcessing = false;

  // the callback that's passed to _write(chunk,cb)
  this.onwrite = function (er) {
    onwrite(stream, er);
  };

  // the callback that the user supplies to write(chunk,encoding,cb)
  this.writecb = null;

  // the amount that is being written when _write is called.
  this.writelen = 0;

  this.bufferedRequest = null;
  this.lastBufferedRequest = null;

  // number of pending user-supplied write callbacks
  // this must be 0 before 'finish' can be emitted
  this.pendingcb = 0;

  // emit prefinish if the only thing we're waiting for is _write cbs
  // This is relevant for synchronous Transform streams
  this.prefinished = false;

  // True if the error was already emitted and should not be thrown again
  this.errorEmitted = false;

  // count buffered requests
  this.bufferedRequestCount = 0;

  // allocate the first CorkedRequest, there is always
  // one allocated and free to use, and we maintain at most two
  this.corkedRequestsFree = new CorkedRequest(this);
}

WritableState.prototype.getBuffer = function getBuffer() {
  var current = this.bufferedRequest;
  var out = [];
  while (current) {
    out.push(current);
    current = current.next;
  }
  return out;
};

(function () {
  try {
    Object.defineProperty(WritableState.prototype, 'buffer', {
      get: internalUtil.deprecate(function () {
        return this.getBuffer();
      }, '_writableState.buffer is deprecated. Use _writableState.getBuffer ' + 'instead.', 'DEP0003')
    });
  } catch (_) {}
})();

// Test _writableState for inheritance to account for Duplex streams,
// whose prototype chain only points to Readable.
var realHasInstance;
if (typeof Symbol === 'function' && Symbol.hasInstance && typeof Function.prototype[Symbol.hasInstance] === 'function') {
  realHasInstance = Function.prototype[Symbol.hasInstance];
  Object.defineProperty(Writable, Symbol.hasInstance, {
    value: function (object) {
      if (realHasInstance.call(this, object)) return true;
      if (this !== Writable) return false;

      return object && object._writableState instanceof WritableState;
    }
  });
} else {
  realHasInstance = function (object) {
    return object instanceof this;
  };
}

function Writable(options) {
  Duplex = Duplex || require('./_stream_duplex');

  // Writable ctor is applied to Duplexes, too.
  // `realHasInstance` is necessary because using plain `instanceof`
  // would return false, as no `_writableState` property is attached.

  // Trying to use the custom `instanceof` for Writable here will also break the
  // Node.js LazyTransform implementation, which has a non-trivial getter for
  // `_writableState` that would lead to infinite recursion.
  if (!realHasInstance.call(Writable, this) && !(this instanceof Duplex)) {
    return new Writable(options);
  }

  this._writableState = new WritableState(options, this);

  // legacy.
  this.writable = true;

  if (options) {
    if (typeof options.write === 'function') this._write = options.write;

    if (typeof options.writev === 'function') this._writev = options.writev;

    if (typeof options.destroy === 'function') this._destroy = options.destroy;

    if (typeof options.final === 'function') this._final = options.final;
  }

  Stream.call(this);
}

// Otherwise people can pipe Writable streams, which is just wrong.
Writable.prototype.pipe = function () {
  this.emit('error', new Error('Cannot pipe, not readable'));
};

function writeAfterEnd(stream, cb) {
  var er = new Error('write after end');
  // TODO: defer error events consistently everywhere, not just the cb
  stream.emit('error', er);
  pna.nextTick(cb, er);
}

// Checks that a user-supplied chunk is valid, especially for the particular
// mode the stream is in. Currently this means that `null` is never accepted
// and undefined/non-string values are only allowed in object mode.
function validChunk(stream, state, chunk, cb) {
  var valid = true;
  var er = false;

  if (chunk === null) {
    er = new TypeError('May not write null values to stream');
  } else if (typeof chunk !== 'string' && chunk !== undefined && !state.objectMode) {
    er = new TypeError('Invalid non-string/buffer chunk');
  }
  if (er) {
    stream.emit('error', er);
    pna.nextTick(cb, er);
    valid = false;
  }
  return valid;
}

Writable.prototype.write = function (chunk, encoding, cb) {
  var state = this._writableState;
  var ret = false;
  var isBuf = !state.objectMode && _isUint8Array(chunk);

  if (isBuf && !Buffer.isBuffer(chunk)) {
    chunk = _uint8ArrayToBuffer(chunk);
  }

  if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (isBuf) encoding = 'buffer';else if (!encoding) encoding = state.defaultEncoding;

  if (typeof cb !== 'function') cb = nop;

  if (state.ended) writeAfterEnd(this, cb);else if (isBuf || validChunk(this, state, chunk, cb)) {
    state.pendingcb++;
    ret = writeOrBuffer(this, state, isBuf, chunk, encoding, cb);
  }

  return ret;
};

Writable.prototype.cork = function () {
  var state = this._writableState;

  state.corked++;
};

Writable.prototype.uncork = function () {
  var state = this._writableState;

  if (state.corked) {
    state.corked--;

    if (!state.writing && !state.corked && !state.finished && !state.bufferProcessing && state.bufferedRequest) clearBuffer(this, state);
  }
};

Writable.prototype.setDefaultEncoding = function setDefaultEncoding(encoding) {
  // node::ParseEncoding() requires lower case.
  if (typeof encoding === 'string') encoding = encoding.toLowerCase();
  if (!(['hex', 'utf8', 'utf-8', 'ascii', 'binary', 'base64', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'raw'].indexOf((encoding + '').toLowerCase()) > -1)) throw new TypeError('Unknown encoding: ' + encoding);
  this._writableState.defaultEncoding = encoding;
  return this;
};

function decodeChunk(state, chunk, encoding) {
  if (!state.objectMode && state.decodeStrings !== false && typeof chunk === 'string') {
    chunk = Buffer.from(chunk, encoding);
  }
  return chunk;
}

Object.defineProperty(Writable.prototype, 'writableHighWaterMark', {
  // making it explicit this property is not enumerable
  // because otherwise some prototype manipulation in
  // userland will fail
  enumerable: false,
  get: function () {
    return this._writableState.highWaterMark;
  }
});

// if we're already writing something, then just put this
// in the queue, and wait our turn.  Otherwise, call _write
// If we return false, then we need a drain event, so set that flag.
function writeOrBuffer(stream, state, isBuf, chunk, encoding, cb) {
  if (!isBuf) {
    var newChunk = decodeChunk(state, chunk, encoding);
    if (chunk !== newChunk) {
      isBuf = true;
      encoding = 'buffer';
      chunk = newChunk;
    }
  }
  var len = state.objectMode ? 1 : chunk.length;

  state.length += len;

  var ret = state.length < state.highWaterMark;
  // we must ensure that previous needDrain will not be reset to false.
  if (!ret) state.needDrain = true;

  if (state.writing || state.corked) {
    var last = state.lastBufferedRequest;
    state.lastBufferedRequest = {
      chunk: chunk,
      encoding: encoding,
      isBuf: isBuf,
      callback: cb,
      next: null
    };
    if (last) {
      last.next = state.lastBufferedRequest;
    } else {
      state.bufferedRequest = state.lastBufferedRequest;
    }
    state.bufferedRequestCount += 1;
  } else {
    doWrite(stream, state, false, len, chunk, encoding, cb);
  }

  return ret;
}

function doWrite(stream, state, writev, len, chunk, encoding, cb) {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  if (writev) stream._writev(chunk, state.onwrite);else stream._write(chunk, encoding, state.onwrite);
  state.sync = false;
}

function onwriteError(stream, state, sync, er, cb) {
  --state.pendingcb;

  if (sync) {
    // defer the callback if we are being called synchronously
    // to avoid piling up things on the stack
    pna.nextTick(cb, er);
    // this can emit finish, and it will always happen
    // after error
    pna.nextTick(finishMaybe, stream, state);
    stream._writableState.errorEmitted = true;
    stream.emit('error', er);
  } else {
    // the caller expect this to happen before if
    // it is async
    cb(er);
    stream._writableState.errorEmitted = true;
    stream.emit('error', er);
    // this can emit finish, but finish must
    // always follow error
    finishMaybe(stream, state);
  }
}

function onwriteStateUpdate(state) {
  state.writing = false;
  state.writecb = null;
  state.length -= state.writelen;
  state.writelen = 0;
}

function onwrite(stream, er) {
  var state = stream._writableState;
  var sync = state.sync;
  var cb = state.writecb;

  onwriteStateUpdate(state);

  if (er) onwriteError(stream, state, sync, er, cb);else {
    // Check if we're actually ready to finish, but don't emit yet
    var finished = needFinish(state);

    if (!finished && !state.corked && !state.bufferProcessing && state.bufferedRequest) {
      clearBuffer(stream, state);
    }

    if (sync) {
      /*<replacement>*/
      asyncWrite(afterWrite, stream, state, finished, cb);
      /*</replacement>*/
    } else {
      afterWrite(stream, state, finished, cb);
    }
  }
}

function afterWrite(stream, state, finished, cb) {
  if (!finished) onwriteDrain(stream, state);
  state.pendingcb--;
  cb();
  finishMaybe(stream, state);
}

// Must force callback to be called on nextTick, so that we don't
// emit 'drain' before the write() consumer gets the 'false' return
// value, and has a chance to attach a 'drain' listener.
function onwriteDrain(stream, state) {
  if (state.length === 0 && state.needDrain) {
    state.needDrain = false;
    stream.emit('drain');
  }
}

// if there's something in the buffer waiting, then process it
function clearBuffer(stream, state) {
  state.bufferProcessing = true;
  var entry = state.bufferedRequest;

  if (stream._writev && entry && entry.next) {
    // Fast case, write everything using _writev()
    var l = state.bufferedRequestCount;
    var buffer = new Array(l);
    var holder = state.corkedRequestsFree;
    holder.entry = entry;

    var count = 0;
    var allBuffers = true;
    while (entry) {
      buffer[count] = entry;
      if (!entry.isBuf) allBuffers = false;
      entry = entry.next;
      count += 1;
    }
    buffer.allBuffers = allBuffers;

    doWrite(stream, state, true, state.length, buffer, '', holder.finish);

    // doWrite is almost always async, defer these to save a bit of time
    // as the hot path ends with doWrite
    state.pendingcb++;
    state.lastBufferedRequest = null;
    if (holder.next) {
      state.corkedRequestsFree = holder.next;
      holder.next = null;
    } else {
      state.corkedRequestsFree = new CorkedRequest(state);
    }
    state.bufferedRequestCount = 0;
  } else {
    // Slow case, write chunks one-by-one
    while (entry) {
      var chunk = entry.chunk;
      var encoding = entry.encoding;
      var cb = entry.callback;
      var len = state.objectMode ? 1 : chunk.length;

      doWrite(stream, state, false, len, chunk, encoding, cb);
      entry = entry.next;
      state.bufferedRequestCount--;
      // if we didn't call the onwrite immediately, then
      // it means that we need to wait until it does.
      // also, that means that the chunk and cb are currently
      // being processed, so move the buffer counter past them.
      if (state.writing) {
        break;
      }
    }

    if (entry === null) state.lastBufferedRequest = null;
  }

  state.bufferedRequest = entry;
  state.bufferProcessing = false;
}

Writable.prototype._write = function (chunk, encoding, cb) {
  cb(new Error('_write() is not implemented'));
};

Writable.prototype._writev = null;

Writable.prototype.end = function (chunk, encoding, cb) {
  var state = this._writableState;

  if (typeof chunk === 'function') {
    cb = chunk;
    chunk = null;
    encoding = null;
  } else if (typeof encoding === 'function') {
    cb = encoding;
    encoding = null;
  }

  if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);

  // .end() fully uncorks
  if (state.corked) {
    state.corked = 1;
    this.uncork();
  }

  // ignore unnecessary end() calls.
  if (!state.ending && !state.finished) endWritable(this, state, cb);
};

function needFinish(state) {
  return state.ending && state.length === 0 && state.bufferedRequest === null && !state.finished && !state.writing;
}
function callFinal(stream, state) {
  stream._final(function (err) {
    state.pendingcb--;
    if (err) {
      stream.emit('error', err);
    }
    state.prefinished = true;
    stream.emit('prefinish');
    finishMaybe(stream, state);
  });
}
function prefinish(stream, state) {
  if (!state.prefinished && !state.finalCalled) {
    if (typeof stream._final === 'function') {
      state.pendingcb++;
      state.finalCalled = true;
      pna.nextTick(callFinal, stream, state);
    } else {
      state.prefinished = true;
      stream.emit('prefinish');
    }
  }
}

function finishMaybe(stream, state) {
  var need = needFinish(state);
  if (need) {
    prefinish(stream, state);
    if (state.pendingcb === 0) {
      state.finished = true;
      stream.emit('finish');
    }
  }
  return need;
}

function endWritable(stream, state, cb) {
  state.ending = true;
  finishMaybe(stream, state);
  if (cb) {
    if (state.finished) pna.nextTick(cb);else stream.once('finish', cb);
  }
  state.ended = true;
  stream.writable = false;
}

function onCorkedFinish(corkReq, state, err) {
  var entry = corkReq.entry;
  corkReq.entry = null;
  while (entry) {
    var cb = entry.callback;
    state.pendingcb--;
    cb(err);
    entry = entry.next;
  }
  if (state.corkedRequestsFree) {
    state.corkedRequestsFree.next = corkReq;
  } else {
    state.corkedRequestsFree = corkReq;
  }
}

Object.defineProperty(Writable.prototype, 'destroyed', {
  get: function () {
    if (this._writableState === undefined) {
      return false;
    }
    return this._writableState.destroyed;
  },
  set: function (value) {
    // we ignore the value if the stream
    // has not been initialized yet
    if (!this._writableState) {
      return;
    }

    // backward compatibility, the user is explicitly
    // managing destroyed
    this._writableState.destroyed = value;
  }
});

Writable.prototype.destroy = destroyImpl.destroy;
Writable.prototype._undestroy = destroyImpl.undestroy;
Writable.prototype._destroy = function (err, cb) {
  this.end();
  cb(err);
};
}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {},require("timers").setImmediate)
},{"./_stream_duplex":107,"./internal/streams/destroy":113,"./internal/streams/stream":114,"_process":94,"core-util-is":35,"inherits":71,"process-nextick-args":115,"safe-buffer":120,"timers":145,"util-deprecate":149}],112:[function(require,module,exports){
'use strict';

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var Buffer = require('safe-buffer').Buffer;
var util = require('util');

function copyBuffer(src, target, offset) {
  src.copy(target, offset);
}

module.exports = function () {
  function BufferList() {
    _classCallCheck(this, BufferList);

    this.head = null;
    this.tail = null;
    this.length = 0;
  }

  BufferList.prototype.push = function push(v) {
    var entry = { data: v, next: null };
    if (this.length > 0) this.tail.next = entry;else this.head = entry;
    this.tail = entry;
    ++this.length;
  };

  BufferList.prototype.unshift = function unshift(v) {
    var entry = { data: v, next: this.head };
    if (this.length === 0) this.tail = entry;
    this.head = entry;
    ++this.length;
  };

  BufferList.prototype.shift = function shift() {
    if (this.length === 0) return;
    var ret = this.head.data;
    if (this.length === 1) this.head = this.tail = null;else this.head = this.head.next;
    --this.length;
    return ret;
  };

  BufferList.prototype.clear = function clear() {
    this.head = this.tail = null;
    this.length = 0;
  };

  BufferList.prototype.join = function join(s) {
    if (this.length === 0) return '';
    var p = this.head;
    var ret = '' + p.data;
    while (p = p.next) {
      ret += s + p.data;
    }return ret;
  };

  BufferList.prototype.concat = function concat(n) {
    if (this.length === 0) return Buffer.alloc(0);
    if (this.length === 1) return this.head.data;
    var ret = Buffer.allocUnsafe(n >>> 0);
    var p = this.head;
    var i = 0;
    while (p) {
      copyBuffer(p.data, ret, i);
      i += p.data.length;
      p = p.next;
    }
    return ret;
  };

  return BufferList;
}();

if (util && util.inspect && util.inspect.custom) {
  module.exports.prototype[util.inspect.custom] = function () {
    var obj = util.inspect({ length: this.length });
    return this.constructor.name + ' ' + obj;
  };
}
},{"safe-buffer":120,"util":26}],113:[function(require,module,exports){
'use strict';

/*<replacement>*/

var pna = require('process-nextick-args');
/*</replacement>*/

// undocumented cb() API, needed for core, not for public API
function destroy(err, cb) {
  var _this = this;

  var readableDestroyed = this._readableState && this._readableState.destroyed;
  var writableDestroyed = this._writableState && this._writableState.destroyed;

  if (readableDestroyed || writableDestroyed) {
    if (cb) {
      cb(err);
    } else if (err && (!this._writableState || !this._writableState.errorEmitted)) {
      pna.nextTick(emitErrorNT, this, err);
    }
    return this;
  }

  // we set destroyed to true before firing error callbacks in order
  // to make it re-entrance safe in case destroy() is called within callbacks

  if (this._readableState) {
    this._readableState.destroyed = true;
  }

  // if this is a duplex stream mark the writable part as destroyed as well
  if (this._writableState) {
    this._writableState.destroyed = true;
  }

  this._destroy(err || null, function (err) {
    if (!cb && err) {
      pna.nextTick(emitErrorNT, _this, err);
      if (_this._writableState) {
        _this._writableState.errorEmitted = true;
      }
    } else if (cb) {
      cb(err);
    }
  });

  return this;
}

function undestroy() {
  if (this._readableState) {
    this._readableState.destroyed = false;
    this._readableState.reading = false;
    this._readableState.ended = false;
    this._readableState.endEmitted = false;
  }

  if (this._writableState) {
    this._writableState.destroyed = false;
    this._writableState.ended = false;
    this._writableState.ending = false;
    this._writableState.finished = false;
    this._writableState.errorEmitted = false;
  }
}

function emitErrorNT(self, err) {
  self.emit('error', err);
}

module.exports = {
  destroy: destroy,
  undestroy: undestroy
};
},{"process-nextick-args":115}],114:[function(require,module,exports){
module.exports = require('events').EventEmitter;

},{"events":27}],115:[function(require,module,exports){
(function (process){
'use strict';

if (!process.version ||
    process.version.indexOf('v0.') === 0 ||
    process.version.indexOf('v1.') === 0 && process.version.indexOf('v1.8.') !== 0) {
  module.exports = { nextTick: nextTick };
} else {
  module.exports = process
}

function nextTick(fn, arg1, arg2, arg3) {
  if (typeof fn !== 'function') {
    throw new TypeError('"callback" argument must be a function');
  }
  var len = arguments.length;
  var args, i;
  switch (len) {
  case 0:
  case 1:
    return process.nextTick(fn);
  case 2:
    return process.nextTick(function afterTickOne() {
      fn.call(null, arg1);
    });
  case 3:
    return process.nextTick(function afterTickTwo() {
      fn.call(null, arg1, arg2);
    });
  case 4:
    return process.nextTick(function afterTickThree() {
      fn.call(null, arg1, arg2, arg3);
    });
  default:
    args = new Array(len - 1);
    i = 0;
    while (i < args.length) {
      args[i++] = arguments[i];
    }
    return process.nextTick(function afterTick() {
      fn.apply(null, args);
    });
  }
}


}).call(this,require('_process'))
},{"_process":94}],116:[function(require,module,exports){
exports = module.exports = require('./lib/_stream_readable.js');
exports.Stream = exports;
exports.Readable = exports;
exports.Writable = require('./lib/_stream_writable.js');
exports.Duplex = require('./lib/_stream_duplex.js');
exports.Transform = require('./lib/_stream_transform.js');
exports.PassThrough = require('./lib/_stream_passthrough.js');

},{"./lib/_stream_duplex.js":107,"./lib/_stream_passthrough.js":108,"./lib/_stream_readable.js":109,"./lib/_stream_transform.js":110,"./lib/_stream_writable.js":111}],117:[function(require,module,exports){
(function (process){
var isWin = process.platform === 'win32';

module.exports = function (str) {
	var i = str.length - 1;
	if (i < 2) {
		return str;
	}
	while (isSeparator(str, i)) {
		i--;
	}
	return str.substr(0, i + 1);
};

function isSeparator(str, i) {
	var char = str[i];
	return i > 0 && (char === '/' || (isWin && char === '\\'));
}

}).call(this,require('_process'))
},{"_process":94}],118:[function(require,module,exports){
const MANIFEST_LOCATION = '/dat.json'

const CHECK_PATHS = [
  (path) => path,
  (path) => path + `index.html`,
  (path) => path + `index.md`,
  (path) => path + `/index.html`,
  (path) => path + `/index.md`,
  (path) => path + `.html`,
  (path) => path + `.md`
]

// Based on algorithm used by hashbase and beaker
// https://github.com/beakerbrowser/hashbase/blob/master/lib/apis/archive-files.js#L80

/*
  Get the manifest
  Try to redirect to public dir
  Detect if it's a folder based on whether there is a trailing slash
  If there's no trailing slash, see if adding a trailing slash resolves to a folder
  If it's a folder
    Try loading the folder + `index.html`
  Else
    Try loading the file
    Try loading the file + html
    Try loading the file + md
  If it was a folder and no file was found
    Render out the directory
  If a file was found
    Render out the file
  If there is a fallback_page in the manifest
    Try to load it
  If nothing was able to load, show a 404 page
*/

module.exports = function resolveFileInArchive (archive, path, cb) {
  getManifest(archive, (manifest) => {
    const prefix = manifest.web_root || ''
    if (!path.startsWith('/')) path = `/${path}`
    let index = 0
    next()

    function next () {
      const makePath = CHECK_PATHS[index++]
      if (makePath) {
        const checkPath = makePath(prefix + path)
        checkExistsFile(archive, checkPath, cb, next)
      } else {
        checkExistsDirectory(archive, prefix + path, cb, try404)
      }
    }

    function try404 () {
      let fallback = manifest.fallback_page

      if (fallback) {
        if (!fallback.startsWith('/')) fallback = `/${fallback}`
        checkExistsFile(archive, fallback, cb, () => {
          checkExistsFile(archive, prefix + fallback, cb, notFound)
        })
      } else notFound()
    }

    function notFound () {
      cb(new Error('Not Found'))
    }
  })
}

function checkExistsDirectory (archive, path, onYes, onNo) {
  archive.stat(path, (err, stat) => {
    if (err) onNo()
    else if (stat.isDirectory()) {
      onYes(null, {
        type: 'directory',
        path: path
      })
    } else onNo()
  })
}

function checkExistsFile (archive, path, onYes, onNo) {
  archive.stat(path, (err, stat) => {
    if (err) onNo()
    else if (stat.isFile()) {
      onYes(null, {
        type: 'file',
        path: path
      })
    } else onNo()
  })
}

function getManifest (archive, cb) {
  archive.readFile(MANIFEST_LOCATION, 'utf-8', (err, rawManifest) => {
    let manifest = {}
    if (err) return cb(manifest)
    try {
      manifest = JSON.parse(rawManifest)
    } catch (e) {
      // Oh well
    }
    cb(manifest || {})
  })
}

},{}],119:[function(require,module,exports){
(function (process){
module.exports = runParallel

function runParallel (tasks, cb) {
  var results, pending, keys
  var isSync = true

  if (Array.isArray(tasks)) {
    results = []
    pending = tasks.length
  } else {
    keys = Object.keys(tasks)
    results = {}
    pending = keys.length
  }

  function done (err) {
    function end () {
      if (cb) cb(err, results)
      cb = null
    }
    if (isSync) process.nextTick(end)
    else end()
  }

  function each (i, err, result) {
    results[i] = result
    if (--pending === 0 || err) {
      done(err)
    }
  }

  if (!pending) {
    // empty
    done(null)
  } else if (keys) {
    // object
    keys.forEach(function (key) {
      tasks[key](function (err, result) { each(key, err, result) })
    })
  } else {
    // array
    tasks.forEach(function (task, i) {
      task(function (err, result) { each(i, err, result) })
    })
  }

  isSync = false
}

}).call(this,require('_process'))
},{"_process":94}],120:[function(require,module,exports){
/* eslint-disable node/no-deprecated-api */
var buffer = require('buffer')
var Buffer = buffer.Buffer

// alternative to using Object.keys for old browsers
function copyProps (src, dst) {
  for (var key in src) {
    dst[key] = src[key]
  }
}
if (Buffer.from && Buffer.alloc && Buffer.allocUnsafe && Buffer.allocUnsafeSlow) {
  module.exports = buffer
} else {
  // Copy properties from require('buffer')
  copyProps(buffer, exports)
  exports.Buffer = SafeBuffer
}

function SafeBuffer (arg, encodingOrOffset, length) {
  return Buffer(arg, encodingOrOffset, length)
}

// Copy static methods from Buffer
copyProps(Buffer, SafeBuffer)

SafeBuffer.from = function (arg, encodingOrOffset, length) {
  if (typeof arg === 'number') {
    throw new TypeError('Argument must not be a number')
  }
  return Buffer(arg, encodingOrOffset, length)
}

SafeBuffer.alloc = function (size, fill, encoding) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  var buf = Buffer(size)
  if (fill !== undefined) {
    if (typeof encoding === 'string') {
      buf.fill(fill, encoding)
    } else {
      buf.fill(fill)
    }
  } else {
    buf.fill(0)
  }
  return buf
}

SafeBuffer.allocUnsafe = function (size) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  return Buffer(size)
}

SafeBuffer.allocUnsafeSlow = function (size) {
  if (typeof size !== 'number') {
    throw new TypeError('Argument must be a number')
  }
  return buffer.SlowBuffer(size)
}

},{"buffer":32}],121:[function(require,module,exports){
(function (process){
const events = require('events')
const through2 = require('through2')
const inherits = require('inherits')
const WebSocket = (typeof window !== 'undefined' && window.WebSocket) ? window.WebSocket : null

function SignalhubWs (app, urls, WebSocketClass) {
  this.opened = false
  this.sockets = []
  this.app = app
  const channels = this.channels = new Map()
  this.subscribers = {
    get length () {
      return channels.size
    }
  }

  if (!Array.isArray(urls)) {
    urls = [urls]
  }

  urls = urls.map(function (url) {
    url = url.replace(/\/$/, '')
    return url.indexOf('://') === -1 ? 'ws://' + url : url
  })

  let countOpen = 0

  for (let index = 0; index < urls.length; index++) {
    const socket = new WebSocketClass(`${urls[index]}/${app}`)

    this.sockets.push(socket)

    socket.addEventListener('open', () => {
      if (++countOpen === urls.length) {
        this.opened = true
        this.emit('open')
        for (let channel of this.channels.values()) {
          channel.emit('open')
        }
      }
    })

    socket.addEventListener('message', (message) => {
      this.onMessage(message)
    })
  }
}

inherits(SignalhubWs, events.EventEmitter)

SignalhubWs.prototype.subscribe = function (channel) {
  if (this.closed) {
    throw new Error('Cannot subscribe after close')
  }

  if (this.channels.has(channel)) {
    return this.channels.get(channel)
  }

  // use a stream for channel
  this.channels.set(channel, through2.obj())

  this.channels.get(channel).on('close', () => {
    this.channels.delete(channel)
  })

  if (this.opened) {
    process.nextTick(() => {
      if (this.channels.has(channel)) {
        this.channels.get(channel).emit('open')
      }
    })
  }

  return this.channels.get(channel)
}

SignalhubWs.prototype.broadcast = function (channel, message, cb) {
  if (this.closed) {
    throw new Error('Cannot broadcast after close')
  }

  const data = {
    app: this.app,
    channel: channel,
    message: message
  }

  this.sockets.forEach((socket) => {
    socket.send(JSON.stringify(data))
  })

  cb && cb()
}

SignalhubWs.prototype.onMessage = function (message) {
  message = JSON.parse(message.data)

  for (let key of this.channels.keys()) {
    if (message.channel === key) {
      this.channels.get(key).write(message.message)
      continue
    }

    if (!Array.isArray(key)) {
      continue
    }

    for (let i = 0; i < key.length; i++) {
      if (key[i] === message.channel) {
        this.channels.get(key).write(message.message)
      }
    }
  }
}

SignalhubWs.prototype.close = function (cb) {
  if (this.closed) {
    if (cb) process.nextTick(cb)
    return
  }

  this.once('close:socket', () => {
    this._closeChannels(cb)
  })

  const len = this.sockets.length
  if (len === 0) {
    this.emit('close')
    return
  }

  let closed = 0
  this.sockets.forEach((socket) => {
    socket.addEventListener('close', () => {
      if (++closed === len) {
        this.emit('close:socket')
      }
    })

    process.nextTick(function () {
      socket.close()
    })
  })
}

SignalhubWs.prototype._closeChannels = function (cb) {
  if (this.closed) {
    if (cb) process.nextTick(cb)
    return
  }
  this.closed = true

  if (cb) {
    this.on('close', cb)
  }

  const len = this.channels.size
  if (len === 0) {
    this.emit('close')
    return
  }

  let closed = 0
  for (let channel of this.channels.values()) {
    process.nextTick(() => {
      channel.end(() => {
        if (++closed === len) {
          this.channels.clear()
          this.emit('close')
        }
      })
    })
  }
}

module.exports = function (app, urls, WebSocketClass = WebSocket) {
  if (!WebSocketClass) {
    throw TypeError('No WebSocket class given.')
  }
  return new SignalhubWs(app, urls, WebSocketClass)
}

}).call(this,require('_process'))
},{"_process":94,"events":27,"inherits":71,"through2":122}],122:[function(require,module,exports){
(function (process){
var Transform = require('readable-stream').Transform
  , inherits  = require('util').inherits

function DestroyableTransform(opts) {
  Transform.call(this, opts)
  this._destroyed = false
}

inherits(DestroyableTransform, Transform)

DestroyableTransform.prototype.destroy = function(err) {
  if (this._destroyed) return
  this._destroyed = true
  
  var self = this
  process.nextTick(function() {
    if (err)
      self.emit('error', err)
    self.emit('close')
  })
}

// a noop _transform function
function noop (chunk, enc, callback) {
  callback(null, chunk)
}


// create a new export function, used by both the main export and
// the .ctor export, contains common logic for dealing with arguments
function through2 (construct) {
  return function (options, transform, flush) {
    if (typeof options == 'function') {
      flush     = transform
      transform = options
      options   = {}
    }

    if (typeof transform != 'function')
      transform = noop

    if (typeof flush != 'function')
      flush = null

    return construct(options, transform, flush)
  }
}


// main export, just make me a transform stream!
module.exports = through2(function (options, transform, flush) {
  var t2 = new DestroyableTransform(options)

  t2._transform = transform

  if (flush)
    t2._flush = flush

  return t2
})


// make me a reusable prototype that I can `new`, or implicitly `new`
// with a constructor call
module.exports.ctor = through2(function (options, transform, flush) {
  function Through2 (override) {
    if (!(this instanceof Through2))
      return new Through2(override)

    this.options = Object.assign({}, options, override)

    DestroyableTransform.call(this, this.options)
  }

  inherits(Through2, DestroyableTransform)

  Through2.prototype._transform = transform

  if (flush)
    Through2.prototype._flush = flush

  return Through2
})


module.exports.obj = through2(function (options, transform, flush) {
  var t2 = new DestroyableTransform(Object.assign({ objectMode: true, highWaterMark: 16 }, options))

  t2._transform = transform

  if (flush)
    t2._flush = flush

  return t2
})

}).call(this,require('_process'))
},{"_process":94,"readable-stream":116,"util":151}],123:[function(require,module,exports){
var varint = require('varint')
exports.encode = function encode (v, b, o) {
  v = v >= 0 ? v*2 : v*-2 - 1
  var r = varint.encode(v, b, o)
  encode.bytes = varint.encode.bytes
  return r
}
exports.decode = function decode (b, o) {
  var v = varint.decode(b, o)
  decode.bytes = varint.decode.bytes
  return v & 1 ? (v+1) / -2 : v / 2
}

exports.encodingLength = function (v) {
  return varint.encodingLength(v >= 0 ? v*2 : v*-2 - 1)
}

},{"varint":154}],124:[function(require,module,exports){
(function (Buffer){
module.exports = Peer

var debug = require('debug')('simple-peer')
var getBrowserRTC = require('get-browser-rtc')
var inherits = require('inherits')
var randombytes = require('randombytes')
var stream = require('readable-stream')

var MAX_BUFFERED_AMOUNT = 64 * 1024

inherits(Peer, stream.Duplex)

/**
 * WebRTC peer connection. Same API as node core `net.Socket`, plus a few extra methods.
 * Duplex stream.
 * @param {Object} opts
 */
function Peer (opts) {
  var self = this
  if (!(self instanceof Peer)) return new Peer(opts)

  self._id = randombytes(4).toString('hex').slice(0, 7)
  self._debug('new peer %o', opts)

  opts = Object.assign({
    allowHalfOpen: false
  }, opts)

  stream.Duplex.call(self, opts)

  self.channelName = opts.initiator
    ? opts.channelName || randombytes(20).toString('hex')
    : null

  // Needed by _transformConstraints, so set this early
  self._isChromium = typeof window !== 'undefined' && !!window.webkitRTCPeerConnection

  self.initiator = opts.initiator || false
  self.channelConfig = opts.channelConfig || Peer.channelConfig
  self.config = opts.config || Peer.config
  self.constraints = self._transformConstraints(opts.constraints || Peer.constraints)
  self.offerConstraints = self._transformConstraints(opts.offerConstraints || {})
  self.answerConstraints = self._transformConstraints(opts.answerConstraints || {})
  self.reconnectTimer = opts.reconnectTimer || false
  self.sdpTransform = opts.sdpTransform || function (sdp) { return sdp }
  self.stream = opts.stream || false
  self.trickle = opts.trickle !== undefined ? opts.trickle : true

  self.destroyed = false
  self.connected = false

  self.remoteAddress = undefined
  self.remoteFamily = undefined
  self.remotePort = undefined
  self.localAddress = undefined
  self.localPort = undefined

  self._wrtc = (opts.wrtc && typeof opts.wrtc === 'object')
    ? opts.wrtc
    : getBrowserRTC()

  if (!self._wrtc) {
    if (typeof window === 'undefined') {
      throw new Error('No WebRTC support: Specify `opts.wrtc` option in this environment')
    } else {
      throw new Error('No WebRTC support: Not a supported browser')
    }
  }

  self._pcReady = false
  self._channelReady = false
  self._iceComplete = false // ice candidate trickle done (got null candidate)
  self._channel = null
  self._pendingCandidates = []
  self._previousStreams = []

  self._chunk = null
  self._cb = null
  self._interval = null
  self._reconnectTimeout = null

  self._pc = new (self._wrtc.RTCPeerConnection)(self.config, self.constraints)

  // We prefer feature detection whenever possible, but sometimes that's not
  // possible for certain implementations.
  self._isWrtc = Array.isArray(self._pc.RTCIceConnectionStates)
  self._isReactNativeWebrtc = typeof self._pc._peerConnectionId === 'number'

  self._pc.oniceconnectionstatechange = function () {
    self._onIceConnectionStateChange()
  }
  self._pc.onsignalingstatechange = function () {
    self._onSignalingStateChange()
  }
  self._pc.onicecandidate = function (event) {
    self._onIceCandidate(event)
  }

  if (self.initiator) {
    var createdOffer = false
    self._pc.onnegotiationneeded = function () {
      if (!createdOffer) self._createOffer()
      createdOffer = true
    }

    self._setupData({
      channel: self._pc.createDataChannel(self.channelName, self.channelConfig)
    })
  } else {
    self._pc.ondatachannel = function (event) {
      self._setupData(event)
    }
  }

  if ('addTrack' in self._pc) {
    // WebRTC Spec, Firefox
    if (self.stream) {
      self.stream.getTracks().forEach(function (track) {
        self._pc.addTrack(track, self.stream)
      })
    }
    self._pc.ontrack = function (event) {
      self._onTrack(event)
    }
  } else {
    // Chrome, etc. This can be removed once all browsers support `ontrack`
    if (self.stream) self._pc.addStream(self.stream)
    self._pc.onaddstream = function (event) {
      self._onAddStream(event)
    }
  }

  // HACK: wrtc doesn't fire the 'negotionneeded' event
  if (self.initiator && self._isWrtc) {
    self._pc.onnegotiationneeded()
  }

  self._onFinishBound = function () {
    self._onFinish()
  }
  self.once('finish', self._onFinishBound)
}

Peer.WEBRTC_SUPPORT = !!getBrowserRTC()

/**
 * Expose config, constraints, and data channel config for overriding all Peer
 * instances. Otherwise, just set opts.config, opts.constraints, or opts.channelConfig
 * when constructing a Peer.
 */
Peer.config = {
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302'
    },
    {
      urls: 'stun:global.stun.twilio.com:3478?transport=udp'
    }
  ]
}
Peer.constraints = {}
Peer.channelConfig = {}

Object.defineProperty(Peer.prototype, 'bufferSize', {
  get: function () {
    var self = this
    return (self._channel && self._channel.bufferedAmount) || 0
  }
})

Peer.prototype.address = function () {
  var self = this
  return { port: self.localPort, family: 'IPv4', address: self.localAddress }
}

Peer.prototype.signal = function (data) {
  var self = this
  if (self.destroyed) throw new Error('cannot signal after peer is destroyed')
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (err) {
      data = {}
    }
  }
  self._debug('signal()')

  if (data.candidate) {
    if (self._pc.remoteDescription) self._addIceCandidate(data.candidate)
    else self._pendingCandidates.push(data.candidate)
  }
  if (data.sdp) {
    self._pc.setRemoteDescription(new (self._wrtc.RTCSessionDescription)(data), function () {
      if (self.destroyed) return

      self._pendingCandidates.forEach(function (candidate) {
        self._addIceCandidate(candidate)
      })
      self._pendingCandidates = []

      if (self._pc.remoteDescription.type === 'offer') self._createAnswer()
    }, function (err) { self._onError(err) })
  }
  if (!data.sdp && !data.candidate) {
    self._destroy(new Error('signal() called with invalid signal data'))
  }
}

Peer.prototype._addIceCandidate = function (candidate) {
  var self = this
  try {
    self._pc.addIceCandidate(
      new self._wrtc.RTCIceCandidate(candidate),
      noop,
      function (err) { self._onError(err) }
    )
  } catch (err) {
    self._destroy(new Error('error adding candidate: ' + err.message))
  }
}

/**
 * Send text/binary data to the remote peer.
 * @param {TypedArrayView|ArrayBuffer|Buffer|string|Blob|Object} chunk
 */
Peer.prototype.send = function (chunk) {
  var self = this

  // HACK: `wrtc` module crashes on Node.js Buffer, so convert to Uint8Array
  // See: https://github.com/feross/simple-peer/issues/60
  if (self._isWrtc && Buffer.isBuffer(chunk)) {
    chunk = new Uint8Array(chunk)
  }

  self._channel.send(chunk)
}

Peer.prototype.destroy = function (onclose) {
  var self = this
  self._destroy(null, onclose)
}

Peer.prototype._destroy = function (err, onclose) {
  var self = this
  if (self.destroyed) return
  if (onclose) self.once('close', onclose)

  self._debug('destroy (error: %s)', err && err.message)

  self.readable = self.writable = false

  if (!self._readableState.ended) self.push(null)
  if (!self._writableState.finished) self.end()

  self.destroyed = true
  self.connected = false
  self._pcReady = false
  self._channelReady = false
  self._previousStreams = null

  clearInterval(self._interval)
  clearTimeout(self._reconnectTimeout)
  self._interval = null
  self._reconnectTimeout = null
  self._chunk = null
  self._cb = null

  if (self._onFinishBound) self.removeListener('finish', self._onFinishBound)
  self._onFinishBound = null

  if (self._pc) {
    try {
      self._pc.close()
    } catch (err) {}

    self._pc.oniceconnectionstatechange = null
    self._pc.onsignalingstatechange = null
    self._pc.onicecandidate = null
    if ('addTrack' in self._pc) {
      self._pc.ontrack = null
    } else {
      self._pc.onaddstream = null
    }
    self._pc.onnegotiationneeded = null
    self._pc.ondatachannel = null
  }

  if (self._channel) {
    try {
      self._channel.close()
    } catch (err) {}

    self._channel.onmessage = null
    self._channel.onopen = null
    self._channel.onclose = null
  }
  self._pc = null
  self._channel = null

  if (err) self.emit('error', err)
  self.emit('close')
}

Peer.prototype._setupData = function (event) {
  var self = this
  self._channel = event.channel
  self._channel.binaryType = 'arraybuffer'

  if (typeof self._channel.bufferedAmountLowThreshold === 'number') {
    self._channel.bufferedAmountLowThreshold = MAX_BUFFERED_AMOUNT
  }

  self.channelName = self._channel.label

  self._channel.onmessage = function (event) {
    self._onChannelMessage(event)
  }
  self._channel.onbufferedamountlow = function () {
    self._onChannelBufferedAmountLow()
  }
  self._channel.onopen = function () {
    self._onChannelOpen()
  }
  self._channel.onclose = function () {
    self._onChannelClose()
  }
}

Peer.prototype._read = function () {}

Peer.prototype._write = function (chunk, encoding, cb) {
  var self = this
  if (self.destroyed) return cb(new Error('cannot write after peer is destroyed'))

  if (self.connected) {
    try {
      self.send(chunk)
    } catch (err) {
      return self._onError(err)
    }
    if (self._channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      self._debug('start backpressure: bufferedAmount %d', self._channel.bufferedAmount)
      self._cb = cb
    } else {
      cb(null)
    }
  } else {
    self._debug('write before connect')
    self._chunk = chunk
    self._cb = cb
  }
}

// When stream finishes writing, close socket. Half open connections are not
// supported.
Peer.prototype._onFinish = function () {
  var self = this
  if (self.destroyed) return

  if (self.connected) {
    destroySoon()
  } else {
    self.once('connect', destroySoon)
  }

  // Wait a bit before destroying so the socket flushes.
  // TODO: is there a more reliable way to accomplish this?
  function destroySoon () {
    setTimeout(function () {
      self._destroy()
    }, 100)
  }
}

Peer.prototype._createOffer = function () {
  var self = this
  if (self.destroyed) return

  self._pc.createOffer(function (offer) {
    if (self.destroyed) return
    offer.sdp = self.sdpTransform(offer.sdp)
    self._pc.setLocalDescription(offer, noop, function (err) { self._onError(err) })
    var sendOffer = function () {
      var signal = self._pc.localDescription || offer
      self._debug('signal')
      self.emit('signal', {
        type: signal.type,
        sdp: signal.sdp
      })
    }
    if (self.trickle || self._iceComplete) sendOffer()
    else self.once('_iceComplete', sendOffer) // wait for candidates
  }, function (err) { self._onError(err) }, self.offerConstraints)
}

Peer.prototype._createAnswer = function () {
  var self = this
  if (self.destroyed) return

  self._pc.createAnswer(function (answer) {
    if (self.destroyed) return
    answer.sdp = self.sdpTransform(answer.sdp)
    self._pc.setLocalDescription(answer, noop, function (err) { self._onError(err) })
    if (self.trickle || self._iceComplete) sendAnswer()
    else self.once('_iceComplete', sendAnswer)

    function sendAnswer () {
      var signal = self._pc.localDescription || answer
      self._debug('signal')
      self.emit('signal', {
        type: signal.type,
        sdp: signal.sdp
      })
    }
  }, function (err) { self._onError(err) }, self.answerConstraints)
}

Peer.prototype._onIceConnectionStateChange = function () {
  var self = this
  if (self.destroyed) return
  var iceGatheringState = self._pc.iceGatheringState
  var iceConnectionState = self._pc.iceConnectionState
  self._debug('iceConnectionStateChange %s %s', iceGatheringState, iceConnectionState)
  self.emit('iceConnectionStateChange', iceGatheringState, iceConnectionState)
  if (iceConnectionState === 'connected' || iceConnectionState === 'completed') {
    clearTimeout(self._reconnectTimeout)
    self._pcReady = true
    self._maybeReady()
  }
  if (iceConnectionState === 'disconnected') {
    if (self.reconnectTimer) {
      // If user has set `opt.reconnectTimer`, allow time for ICE to attempt a reconnect
      clearTimeout(self._reconnectTimeout)
      self._reconnectTimeout = setTimeout(function () {
        self._destroy()
      }, self.reconnectTimer)
    } else {
      self._destroy()
    }
  }
  if (iceConnectionState === 'failed') {
    self._destroy(new Error('Ice connection failed.'))
  }
  if (iceConnectionState === 'closed') {
    self._destroy()
  }
}

Peer.prototype.getStats = function (cb) {
  var self = this

  // Promise-based getStats() (standard)
  if (self._pc.getStats.length === 0) {
    self._pc.getStats().then(function (res) {
      var reports = []
      res.forEach(function (report) {
        reports.push(report)
      })
      cb(reports)
    }, function (err) { self._onError(err) })

  // Two-parameter callback-based getStats() (deprecated, former standard)
  } else if (self._isReactNativeWebrtc) {
    self._pc.getStats(null, function (res) {
      var reports = []
      res.forEach(function (report) {
        reports.push(report)
      })
      cb(reports)
    }, function (err) { self._onError(err) })

  // Single-parameter callback-based getStats() (non-standard)
  } else if (self._pc.getStats.length > 0) {
    self._pc.getStats(function (res) {
      var reports = []
      res.result().forEach(function (result) {
        var report = {}
        result.names().forEach(function (name) {
          report[name] = result.stat(name)
        })
        report.id = result.id
        report.type = result.type
        report.timestamp = result.timestamp
        reports.push(report)
      })
      cb(reports)
    }, function (err) { self._onError(err) })

  // Unknown browser, skip getStats() since it's anyone's guess which style of
  // getStats() they implement.
  } else {
    cb([])
  }
}

Peer.prototype._maybeReady = function () {
  var self = this
  self._debug('maybeReady pc %s channel %s', self._pcReady, self._channelReady)
  if (self.connected || self._connecting || !self._pcReady || !self._channelReady) return
  self._connecting = true

  self.getStats(function (items) {
    self._connecting = false
    self.connected = true

    var remoteCandidates = {}
    var localCandidates = {}
    var candidatePairs = {}

    items.forEach(function (item) {
      // TODO: Once all browsers support the hyphenated stats report types, remove
      // the non-hypenated ones
      if (item.type === 'remotecandidate' || item.type === 'remote-candidate') {
        remoteCandidates[item.id] = item
      }
      if (item.type === 'localcandidate' || item.type === 'local-candidate') {
        localCandidates[item.id] = item
      }
      if (item.type === 'candidatepair' || item.type === 'candidate-pair') {
        candidatePairs[item.id] = item
      }
    })

    items.forEach(function (item) {
      // Spec-compliant
      if (item.type === 'transport') {
        setSelectedCandidatePair(candidatePairs[item.selectedCandidatePairId])
      }

      // Old implementations
      if (
        (item.type === 'googCandidatePair' && item.googActiveConnection === 'true') ||
        ((item.type === 'candidatepair' || item.type === 'candidate-pair') && item.selected)
      ) {
        setSelectedCandidatePair(item)
      }
    })

    function setSelectedCandidatePair (selectedCandidatePair) {
      var local = localCandidates[selectedCandidatePair.localCandidateId]

      if (local && local.ip) {
        // Spec
        self.localAddress = local.ip
        self.localPort = Number(local.port)
      } else if (local && local.ipAddress) {
        // Firefox
        self.localAddress = local.ipAddress
        self.localPort = Number(local.portNumber)
      } else if (typeof selectedCandidatePair.googLocalAddress === 'string') {
        // TODO: remove this once Chrome 58 is released
        local = selectedCandidatePair.googLocalAddress.split(':')
        self.localAddress = local[0]
        self.localPort = Number(local[1])
      }

      var remote = remoteCandidates[selectedCandidatePair.remoteCandidateId]

      if (remote && remote.ip) {
        // Spec
        self.remoteAddress = remote.ip
        self.remotePort = Number(remote.port)
      } else if (remote && remote.ipAddress) {
        // Firefox
        self.remoteAddress = remote.ipAddress
        self.remotePort = Number(remote.portNumber)
      } else if (typeof selectedCandidatePair.googRemoteAddress === 'string') {
        // TODO: remove this once Chrome 58 is released
        remote = selectedCandidatePair.googRemoteAddress.split(':')
        self.remoteAddress = remote[0]
        self.remotePort = Number(remote[1])
      }
      self.remoteFamily = 'IPv4'

      self._debug(
        'connect local: %s:%s remote: %s:%s',
        self.localAddress, self.localPort, self.remoteAddress, self.remotePort
      )
    }

    if (self._chunk) {
      try {
        self.send(self._chunk)
      } catch (err) {
        return self._onError(err)
      }
      self._chunk = null
      self._debug('sent chunk from "write before connect"')

      var cb = self._cb
      self._cb = null
      cb(null)
    }

    // If `bufferedAmountLowThreshold` and 'onbufferedamountlow' are unsupported,
    // fallback to using setInterval to implement backpressure.
    if (typeof self._channel.bufferedAmountLowThreshold !== 'number') {
      self._interval = setInterval(function () { self._onInterval() }, 150)
      if (self._interval.unref) self._interval.unref()
    }

    self._debug('connect')
    self.emit('connect')
  })
}

Peer.prototype._onInterval = function () {
  if (!this._cb || !this._channel || this._channel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
    return
  }
  this._onChannelBufferedAmountLow()
}

Peer.prototype._onSignalingStateChange = function () {
  var self = this
  if (self.destroyed) return
  self._debug('signalingStateChange %s', self._pc.signalingState)
  self.emit('signalingStateChange', self._pc.signalingState)
}

Peer.prototype._onIceCandidate = function (event) {
  var self = this
  if (self.destroyed) return
  if (event.candidate && self.trickle) {
    self.emit('signal', {
      candidate: {
        candidate: event.candidate.candidate,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        sdpMid: event.candidate.sdpMid
      }
    })
  } else if (!event.candidate) {
    self._iceComplete = true
    self.emit('_iceComplete')
  }
}

Peer.prototype._onChannelMessage = function (event) {
  var self = this
  if (self.destroyed) return
  var data = event.data
  if (data instanceof ArrayBuffer) data = new Buffer(data)
  self.push(data)
}

Peer.prototype._onChannelBufferedAmountLow = function () {
  var self = this
  if (self.destroyed || !self._cb) return
  self._debug('ending backpressure: bufferedAmount %d', self._channel.bufferedAmount)
  var cb = self._cb
  self._cb = null
  cb(null)
}

Peer.prototype._onChannelOpen = function () {
  var self = this
  if (self.connected || self.destroyed) return
  self._debug('on channel open')
  self._channelReady = true
  self._maybeReady()
}

Peer.prototype._onChannelClose = function () {
  var self = this
  if (self.destroyed) return
  self._debug('on channel close')
  self._destroy()
}

Peer.prototype._onAddStream = function (event) {
  var self = this
  if (self.destroyed) return
  self._debug('on add stream')
  self.emit('stream', event.stream)
}

Peer.prototype._onTrack = function (event) {
  var self = this
  if (self.destroyed) return
  self._debug('on track')
  var id = event.streams[0].id
  if (self._previousStreams.indexOf(id) !== -1) return // Only fire one 'stream' event, even though there may be multiple tracks per stream
  self._previousStreams.push(id)
  self.emit('stream', event.streams[0])
}

Peer.prototype._onError = function (err) {
  var self = this
  if (self.destroyed) return
  self._debug('error %s', err.message || err)
  self._destroy(err)
}

Peer.prototype._debug = function () {
  var self = this
  var args = [].slice.call(arguments)
  args[0] = '[' + self._id + '] ' + args[0]
  debug.apply(null, args)
}

// Transform constraints objects into the new format (unless Chromium)
// TODO: This can be removed when Chromium supports the new format
Peer.prototype._transformConstraints = function (constraints) {
  var self = this

  if (Object.keys(constraints).length === 0) {
    return constraints
  }

  if ((constraints.mandatory || constraints.optional) && !self._isChromium) {
    // convert to new format

    // Merge mandatory and optional objects, prioritizing mandatory
    var newConstraints = Object.assign({}, constraints.optional, constraints.mandatory)

    // fix casing
    if (newConstraints.OfferToReceiveVideo !== undefined) {
      newConstraints.offerToReceiveVideo = newConstraints.OfferToReceiveVideo
      delete newConstraints['OfferToReceiveVideo']
    }

    if (newConstraints.OfferToReceiveAudio !== undefined) {
      newConstraints.offerToReceiveAudio = newConstraints.OfferToReceiveAudio
      delete newConstraints['OfferToReceiveAudio']
    }

    return newConstraints
  } else if (!constraints.mandatory && !constraints.optional && self._isChromium) {
    // convert to old format

    // fix casing
    if (constraints.offerToReceiveVideo !== undefined) {
      constraints.OfferToReceiveVideo = constraints.offerToReceiveVideo
      delete constraints['offerToReceiveVideo']
    }

    if (constraints.offerToReceiveAudio !== undefined) {
      constraints.OfferToReceiveAudio = constraints.offerToReceiveAudio
      delete constraints['offerToReceiveAudio']
    }

    return {
      mandatory: constraints // NOTE: All constraints are upgraded to mandatory
    }
  }

  return constraints
}

function noop () {}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"debug":40,"get-browser-rtc":52,"inherits":71,"randombytes":106,"readable-stream":116}],125:[function(require,module,exports){
module.exports = fallback

function _add (a, b) {
  var rl = a.l + b.l
  var a2 = {
    h: a.h + b.h + (rl / 2 >>> 31) >>> 0,
    l: rl >>> 0
  }
  a.h = a2.h
  a.l = a2.l
}

function _xor (a, b) {
  a.h ^= b.h
  a.h >>>= 0
  a.l ^= b.l
  a.l >>>= 0
}

function _rotl (a, n) {
  var a2 = {
    h: a.h << n | a.l >>> (32 - n),
    l: a.l << n | a.h >>> (32 - n)
  }
  a.h = a2.h
  a.l = a2.l
}

function _rotl32 (a) {
  var al = a.l
  a.l = a.h
  a.h = al
}

function _compress (v0, v1, v2, v3) {
  _add(v0, v1)
  _add(v2, v3)
  _rotl(v1, 13)
  _rotl(v3, 16)
  _xor(v1, v0)
  _xor(v3, v2)
  _rotl32(v0)
  _add(v2, v1)
  _add(v0, v3)
  _rotl(v1, 17)
  _rotl(v3, 21)
  _xor(v1, v2)
  _xor(v3, v0)
  _rotl32(v2)
}

function _get_int (a, offset) {
  return (a[offset + 3] << 24) | (a[offset + 2] << 16) | (a[offset + 1] << 8) | a[offset]
}

function fallback (out, m, key) { // modified from https://github.com/jedisct1/siphash-js to use uint8arrays
  var k0 = {h: _get_int(key, 4), l: _get_int(key, 0)}
  var k1 = {h: _get_int(key, 12), l: _get_int(key, 8)}
  var v0 = {h: k0.h, l: k0.l}
  var v2 = k0
  var v1 = {h: k1.h, l: k1.l}
  var v3 = k1
  var mi
  var mp = 0
  var ml = m.length
  var ml7 = ml - 7
  var buf = new Uint8Array(new ArrayBuffer(8))

  _xor(v0, {h: 0x736f6d65, l: 0x70736575})
  _xor(v1, {h: 0x646f7261, l: 0x6e646f6d})
  _xor(v2, {h: 0x6c796765, l: 0x6e657261})
  _xor(v3, {h: 0x74656462, l: 0x79746573})

  while (mp < ml7) {
    mi = {h: _get_int(m, mp + 4), l: _get_int(m, mp)}
    _xor(v3, mi)
    _compress(v0, v1, v2, v3)
    _compress(v0, v1, v2, v3)
    _xor(v0, mi)
    mp += 8
  }

  buf[7] = ml
  var ic = 0
  while (mp < ml) {
    buf[ic++] = m[mp++]
  }
  while (ic < 7) {
    buf[ic++] = 0
  }

  mi = {
    h: buf[7] << 24 | buf[6] << 16 | buf[5] << 8 | buf[4],
    l: buf[3] << 24 | buf[2] << 16 | buf[1] << 8 | buf[0]
  }

  _xor(v3, mi)
  _compress(v0, v1, v2, v3)
  _compress(v0, v1, v2, v3)
  _xor(v0, mi)
  _xor(v2, { h: 0, l: 0xff })
  _compress(v0, v1, v2, v3)
  _compress(v0, v1, v2, v3)
  _compress(v0, v1, v2, v3)
  _compress(v0, v1, v2, v3)

  var h = v0
  _xor(h, v1)
  _xor(h, v2)
  _xor(h, v3)

  out[0] = h.l & 0xff
  out[1] = (h.l >> 8) & 0xff
  out[2] = (h.l >> 16) & 0xff
  out[3] = (h.l >> 24) & 0xff
  out[4] = h.h & 0xff
  out[5] = (h.h >> 8) & 0xff
  out[6] = (h.h >> 16) & 0xff
  out[7] = (h.h >> 24) & 0xff
}

},{}],126:[function(require,module,exports){
var wasm = require('./siphash24')
var fallback = require('./fallback')
var assert = require('nanoassert')

module.exports = siphash24

var BYTES = siphash24.BYTES = 8
var KEYBYTES = siphash24.KEYBYTES = 16
var mod = wasm()

siphash24.WASM_SUPPORTED = typeof WebAssembly !== 'undefined'
siphash24.WASM_LOADED = false

if (mod) {
  mod.onload(function (err) {
    siphash24.WASM_LOADED = !err
  })
}

function siphash24 (data, key, out, noAssert) {
  if (!out) out = new Uint8Array(8)

  if (noAssert !== true) {
    assert(out.length >= BYTES, 'output must be at least ' + BYTES)
    assert(key.length >= KEYBYTES, 'key must be at least ' + KEYBYTES)
  }

  if (mod && mod.exports) {
    if (data.length + 24 > mod.memory.length) mod.realloc(data.length + 24)
    mod.memory.set(key, 8)
    mod.memory.set(data, 24)
    mod.exports.siphash(24, data.length)
    out.set(mod.memory.subarray(0, 8))
  } else {
    fallback(out, data, key)
  }

  return out
}

},{"./fallback":125,"./siphash24":127,"nanoassert":87}],127:[function(require,module,exports){

module.exports = loadWebAssembly

loadWebAssembly.supported = typeof WebAssembly !== 'undefined'

function loadWebAssembly (opts) {
  if (!loadWebAssembly.supported) return null

  var imp = opts && opts.imports
  var wasm = toUint8Array('AGFzbQEAAAABBgFgAn9/AAMCAQAFBQEBCpBOBxQCBm1lbW9yeQIAB3NpcGhhc2gAAArdCAHaCAIIfgJ/QvXKzYPXrNu38wAhAkLt3pHzlszct+QAIQNC4eSV89bs2bzsACEEQvPK0cunjNmy9AAhBUEIKQMAIQdBECkDACEIIAGtQjiGIQYgAUEHcSELIAAgAWogC2shCiAFIAiFIQUgBCAHhSEEIAMgCIUhAyACIAeFIQICQANAIAAgCkYNASAAKQMAIQkgBSAJhSEFIAIgA3whAiADQg2JIQMgAyAChSEDIAJCIIkhAiAEIAV8IQQgBUIQiSEFIAUgBIUhBSACIAV8IQIgBUIViSEFIAUgAoUhBSAEIAN8IQQgA0IRiSEDIAMgBIUhAyAEQiCJIQQgAiADfCECIANCDYkhAyADIAKFIQMgAkIgiSECIAQgBXwhBCAFQhCJIQUgBSAEhSEFIAIgBXwhAiAFQhWJIQUgBSAChSEFIAQgA3whBCADQhGJIQMgAyAEhSEDIARCIIkhBCACIAmFIQIgAEEIaiEADAALCwJAAkACQAJAAkACQAJAAkAgCw4HBwYFBAMCAQALIAYgADEABkIwhoQhBgsgBiAAMQAFQiiGhCEGCyAGIAAxAARCIIaEIQYLIAYgADEAA0IYhoQhBgsgBiAAMQACQhCGhCEGCyAGIAAxAAFCCIaEIQYLIAYgADEAAIQhBgsgBSAGhSEFIAIgA3whAiADQg2JIQMgAyAChSEDIAJCIIkhAiAEIAV8IQQgBUIQiSEFIAUgBIUhBSACIAV8IQIgBUIViSEFIAUgAoUhBSAEIAN8IQQgA0IRiSEDIAMgBIUhAyAEQiCJIQQgAiADfCECIANCDYkhAyADIAKFIQMgAkIgiSECIAQgBXwhBCAFQhCJIQUgBSAEhSEFIAIgBXwhAiAFQhWJIQUgBSAChSEFIAQgA3whBCADQhGJIQMgAyAEhSEDIARCIIkhBCACIAaFIQIgBEL/AYUhBCACIAN8IQIgA0INiSEDIAMgAoUhAyACQiCJIQIgBCAFfCEEIAVCEIkhBSAFIASFIQUgAiAFfCECIAVCFYkhBSAFIAKFIQUgBCADfCEEIANCEYkhAyADIASFIQMgBEIgiSEEIAIgA3whAiADQg2JIQMgAyAChSEDIAJCIIkhAiAEIAV8IQQgBUIQiSEFIAUgBIUhBSACIAV8IQIgBUIViSEFIAUgAoUhBSAEIAN8IQQgA0IRiSEDIAMgBIUhAyAEQiCJIQQgAiADfCECIANCDYkhAyADIAKFIQMgAkIgiSECIAQgBXwhBCAFQhCJIQUgBSAEhSEFIAIgBXwhAiAFQhWJIQUgBSAChSEFIAQgA3whBCADQhGJIQMgAyAEhSEDIARCIIkhBCACIAN8IQIgA0INiSEDIAMgAoUhAyACQiCJIQIgBCAFfCEEIAVCEIkhBSAFIASFIQUgAiAFfCECIAVCFYkhBSAFIAKFIQUgBCADfCEEIANCEYkhAyADIASFIQMgBEIgiSEEQQAgAiADIAQgBYWFhTcDAAs=')
  var ready = null

  var mod = {
    buffer: wasm,
    memory: null,
    exports: null,
    realloc: realloc,
    onload: onload
  }

  onload(function () {})

  return mod

  function realloc (size) {
    mod.exports.memory.grow(Math.max(0, Math.ceil(Math.abs(size - mod.memory.length) / 65536)))
    mod.memory = new Uint8Array(mod.exports.memory.buffer)
  }

  function onload (cb) {
    if (mod.exports) return cb()

    if (ready) {
      ready.then(cb.bind(null, null)).catch(cb)
      return
    }

    try {
      if (opts && opts.async) throw new Error('async')
      setup({instance: new WebAssembly.Instance(new WebAssembly.Module(wasm), imp)})
    } catch (err) {
      ready = WebAssembly.instantiate(wasm, imp).then(setup)
    }

    onload(cb)
  }

  function setup (w) {
    mod.exports = w.instance.exports
    mod.memory = mod.exports.memory && mod.exports.memory.buffer && new Uint8Array(mod.exports.memory.buffer)
  }
}

function toUint8Array (s) {
  if (typeof atob === 'function') return new Uint8Array(atob(s).split('').map(charCodeAt))
  return new (require('buf' + 'fer').Buffer)(s, 'base64')
}

function charCodeAt (c) {
  return c.charCodeAt(0)
}

},{}],128:[function(require,module,exports){
var blake2b = require('blake2b')

module.exports.crypto_generichash_PRIMITIVE = 'blake2b'
module.exports.crypto_generichash_BYTES_MIN = blake2b.BYTES_MIN
module.exports.crypto_generichash_BYTES_MAX = blake2b.BYTES_MAX
module.exports.crypto_generichash_BYTES = blake2b.BYTES
module.exports.crypto_generichash_KEYBYTES_MIN = blake2b.KEYBYTES_MIN
module.exports.crypto_generichash_KEYBYTES_MAX = blake2b.KEYBYTES_MAX
module.exports.crypto_generichash_KEYBYTES = blake2b.KEYBYTES
module.exports.crypto_generichash_WASM_SUPPORTED = blake2b.WASM_SUPPORTED
module.exports.crypto_generichash_WASM_LOADED = false

module.exports.crypto_generichash = function (output, input, key) {
  blake2b(output.length, key).update(input).final(output)
}

module.exports.crypto_generichash_ready = blake2b.ready

module.exports.crypto_generichash_batch = function (output, inputArray, key) {
  var ctx = blake2b(output.length, key)
  for (var i = 0; i < inputArray.length; i++) {
    ctx.update(inputArray[i])
  }
  ctx.final(output)
}

module.exports.crypto_generichash_instance = function (key, outlen) {
  if (outlen == null) outlen = module.exports.crypto_generichash_BYTES
  return blake2b(outlen, key)
}

blake2b.ready(function (err) {
  module.exports.crypto_generichash_WASM_LOADED = blake2b.WASM_LOADED
})

},{"blake2b":25}],129:[function(require,module,exports){
var assert = require('nanoassert')
var randombytes_buf = require('./randombytes').randombytes_buf
var blake2b = require('blake2b')

module.exports.crypto_kdf_PRIMITIVE = 'blake2b'
module.exports.crypto_kdf_BYTES_MIN = 16
module.exports.crypto_kdf_BYTES_MAX = 64
module.exports.crypto_kdf_CONTEXTBYTES = 8
module.exports.crypto_kdf_KEYBYTES = 32

function STORE64_LE(dest, int) {
  var mul = 1
  var i = 0
  dest[0] = int & 0xFF
  while (++i < 8 && (mul *= 0x100)) {
    dest[i] = (int / mul) & 0xFF
  }
}

module.exports.crypto_kdf_derive_from_key = function crypto_kdf_derive_from_key (subkey, subkey_id, ctx, key) {
  assert(subkey.length >= module.exports.crypto_kdf_BYTES_MIN, 'subkey must be at least crypto_kdf_BYTES_MIN')
  assert(subkey_id >= 0 && subkey_id <= 0x1fffffffffffff, 'subkey_id must be safe integer')
  assert(ctx.length >= module.exports.crypto_kdf_CONTEXTBYTES, 'context must be at least crypto_kdf_CONTEXTBYTES')

  var ctx_padded = new Uint8Array(blake2b.PERSONALBYTES)
  var salt = new Uint8Array(blake2b.SALTBYTES)

  ctx_padded.set(ctx, 0, module.exports.crypto_kdf_CONTEXTBYTES)
  STORE64_LE(salt, subkey_id)

  var outlen = Math.min(subkey.length, module.exports.crypto_kdf_BYTES_MAX)
  blake2b(outlen, key.subarray(0, module.exports.crypto_kdf_KEYBYTES), salt, ctx_padded, true)
    .final(subkey)
}

module.exports.crypto_kdf_keygen = function crypto_kdf_keygen (out) {
  assert(out.length >= module.exports.crypto_kdf_KEYBYTES, 'out.length must be crypto_kdf_KEYBYTES')
  randombytes_buf(out.subarray(0, module.exports.crypto_kdf_KEYBYTES))
}

},{"./randombytes":133,"blake2b":25,"nanoassert":87}],130:[function(require,module,exports){
var siphash = require('siphash24')

exports.crypto_shorthash_PRIMITIVE = 'siphash24'
exports.crypto_shorthash_BYTES = siphash.BYTES
exports.crypto_shorthash_KEYBYTES = siphash.KEYBYTES
exports.crypto_shorthash_WASM_SUPPORTED = siphash.WASM_SUPPORTED
exports.crypto_shorthash_WASM_LOADED = siphash.WASM_LOADED
exports.crypto_shorthash = shorthash

function shorthash (out, data, key, noAssert) {
  siphash(data, key, out, noAssert)
}

},{"siphash24":126}],131:[function(require,module,exports){
var xsalsa20 = require('xsalsa20')

exports.crypto_stream_KEYBYTES = 32
exports.crypto_stream_NONCEBYTES = 24
exports.crypto_stream_PRIMITIVE = 'xsalsa20'

exports.crypto_stream = function (out, nonce, key) {
  out.fill(0)
  exports.crypto_stream_xor(out, out, nonce, key)
}

exports.crypto_stream_xor = function (out, inp, nonce, key) {
  var xor = xsalsa20(nonce, key)
  xor.update(inp, out)
  xor.final()
}

exports.crypto_stream_xor_instance = function (nonce, key) {
  return new XOR(nonce, key)
}

function XOR (nonce, key) {
  this._instance = xsalsa20(nonce, key)
}

XOR.prototype.update = function (out, inp) {
  this._instance.update(inp, out)
}

XOR.prototype.final = function () {
  this._instance.finalize()
  this._instance = null
}

},{"xsalsa20":160}],132:[function(require,module,exports){
'use strict';

// Based on https://github.com/dchest/tweetnacl-js/blob/6dcbcaf5f5cbfd313f2dcfe763db35c828c8ff5b/nacl-fast.js.

var sodium = module.exports
var cs = require('./crypto_stream')

// Ported in 2014 by Dmitry Chestnykh and Devi Mandiri.
// Public domain.
//
// Implementation derived from TweetNaCl version 20140427.
// See for details: http://tweetnacl.cr.yp.to/

var gf = function(init) {
  var i, r = new Float64Array(16);
  if (init) for (i = 0; i < init.length; i++) r[i] = init[i];
  return r;
};

// also forwarded at the bottom but randombytes is non-enumerable
var randombytes = require('./randombytes').randombytes

var _0 = new Uint8Array(16);
var _9 = new Uint8Array(32); _9[0] = 9;

var gf0 = gf(),
    gf1 = gf([1]),
    _121665 = gf([0xdb41, 1]),
    D = gf([0x78a3, 0x1359, 0x4dca, 0x75eb, 0xd8ab, 0x4141, 0x0a4d, 0x0070, 0xe898, 0x7779, 0x4079, 0x8cc7, 0xfe73, 0x2b6f, 0x6cee, 0x5203]),
    D2 = gf([0xf159, 0x26b2, 0x9b94, 0xebd6, 0xb156, 0x8283, 0x149a, 0x00e0, 0xd130, 0xeef3, 0x80f2, 0x198e, 0xfce7, 0x56df, 0xd9dc, 0x2406]),
    X = gf([0xd51a, 0x8f25, 0x2d60, 0xc956, 0xa7b2, 0x9525, 0xc760, 0x692c, 0xdc5c, 0xfdd6, 0xe231, 0xc0a4, 0x53fe, 0xcd6e, 0x36d3, 0x2169]),
    Y = gf([0x6658, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666, 0x6666]),
    I = gf([0xa0b0, 0x4a0e, 0x1b27, 0xc4ee, 0xe478, 0xad2f, 0x1806, 0x2f43, 0xd7a7, 0x3dfb, 0x0099, 0x2b4d, 0xdf0b, 0x4fc1, 0x2480, 0x2b83]);

function ts64(x, i, h, l) {
  x[i]   = (h >> 24) & 0xff;
  x[i+1] = (h >> 16) & 0xff;
  x[i+2] = (h >>  8) & 0xff;
  x[i+3] = h & 0xff;
  x[i+4] = (l >> 24)  & 0xff;
  x[i+5] = (l >> 16)  & 0xff;
  x[i+6] = (l >>  8)  & 0xff;
  x[i+7] = l & 0xff;
}

function vn(x, xi, y, yi, n) {
  var i,d = 0;
  for (i = 0; i < n; i++) d |= x[xi+i]^y[yi+i];
  return (1 & ((d - 1) >>> 8)) - 1;
}

function crypto_verify_16(x, xi, y, yi) {
  return vn(x,xi,y,yi,16);
}

function crypto_verify_32(x, xi, y, yi) {
  return vn(x,xi,y,yi,32);
}

/*
* Port of Andrew Moon's Poly1305-donna-16. Public domain.
* https://github.com/floodyberry/poly1305-donna
*/

var poly1305 = function(key) {
  this.buffer = new Uint8Array(16);
  this.r = new Uint16Array(10);
  this.h = new Uint16Array(10);
  this.pad = new Uint16Array(8);
  this.leftover = 0;
  this.fin = 0;

  var t0, t1, t2, t3, t4, t5, t6, t7;

  t0 = key[ 0] & 0xff | (key[ 1] & 0xff) << 8; this.r[0] = ( t0                     ) & 0x1fff;
  t1 = key[ 2] & 0xff | (key[ 3] & 0xff) << 8; this.r[1] = ((t0 >>> 13) | (t1 <<  3)) & 0x1fff;
  t2 = key[ 4] & 0xff | (key[ 5] & 0xff) << 8; this.r[2] = ((t1 >>> 10) | (t2 <<  6)) & 0x1f03;
  t3 = key[ 6] & 0xff | (key[ 7] & 0xff) << 8; this.r[3] = ((t2 >>>  7) | (t3 <<  9)) & 0x1fff;
  t4 = key[ 8] & 0xff | (key[ 9] & 0xff) << 8; this.r[4] = ((t3 >>>  4) | (t4 << 12)) & 0x00ff;
  this.r[5] = ((t4 >>>  1)) & 0x1ffe;
  t5 = key[10] & 0xff | (key[11] & 0xff) << 8; this.r[6] = ((t4 >>> 14) | (t5 <<  2)) & 0x1fff;
  t6 = key[12] & 0xff | (key[13] & 0xff) << 8; this.r[7] = ((t5 >>> 11) | (t6 <<  5)) & 0x1f81;
  t7 = key[14] & 0xff | (key[15] & 0xff) << 8; this.r[8] = ((t6 >>>  8) | (t7 <<  8)) & 0x1fff;
  this.r[9] = ((t7 >>>  5)) & 0x007f;

  this.pad[0] = key[16] & 0xff | (key[17] & 0xff) << 8;
  this.pad[1] = key[18] & 0xff | (key[19] & 0xff) << 8;
  this.pad[2] = key[20] & 0xff | (key[21] & 0xff) << 8;
  this.pad[3] = key[22] & 0xff | (key[23] & 0xff) << 8;
  this.pad[4] = key[24] & 0xff | (key[25] & 0xff) << 8;
  this.pad[5] = key[26] & 0xff | (key[27] & 0xff) << 8;
  this.pad[6] = key[28] & 0xff | (key[29] & 0xff) << 8;
  this.pad[7] = key[30] & 0xff | (key[31] & 0xff) << 8;
};

poly1305.prototype.blocks = function(m, mpos, bytes) {
  var hibit = this.fin ? 0 : (1 << 11);
  var t0, t1, t2, t3, t4, t5, t6, t7, c;
  var d0, d1, d2, d3, d4, d5, d6, d7, d8, d9;

  var h0 = this.h[0],
      h1 = this.h[1],
      h2 = this.h[2],
      h3 = this.h[3],
      h4 = this.h[4],
      h5 = this.h[5],
      h6 = this.h[6],
      h7 = this.h[7],
      h8 = this.h[8],
      h9 = this.h[9];

  var r0 = this.r[0],
      r1 = this.r[1],
      r2 = this.r[2],
      r3 = this.r[3],
      r4 = this.r[4],
      r5 = this.r[5],
      r6 = this.r[6],
      r7 = this.r[7],
      r8 = this.r[8],
      r9 = this.r[9];

  while (bytes >= 16) {
    t0 = m[mpos+ 0] & 0xff | (m[mpos+ 1] & 0xff) << 8; h0 += ( t0                     ) & 0x1fff;
    t1 = m[mpos+ 2] & 0xff | (m[mpos+ 3] & 0xff) << 8; h1 += ((t0 >>> 13) | (t1 <<  3)) & 0x1fff;
    t2 = m[mpos+ 4] & 0xff | (m[mpos+ 5] & 0xff) << 8; h2 += ((t1 >>> 10) | (t2 <<  6)) & 0x1fff;
    t3 = m[mpos+ 6] & 0xff | (m[mpos+ 7] & 0xff) << 8; h3 += ((t2 >>>  7) | (t3 <<  9)) & 0x1fff;
    t4 = m[mpos+ 8] & 0xff | (m[mpos+ 9] & 0xff) << 8; h4 += ((t3 >>>  4) | (t4 << 12)) & 0x1fff;
    h5 += ((t4 >>>  1)) & 0x1fff;
    t5 = m[mpos+10] & 0xff | (m[mpos+11] & 0xff) << 8; h6 += ((t4 >>> 14) | (t5 <<  2)) & 0x1fff;
    t6 = m[mpos+12] & 0xff | (m[mpos+13] & 0xff) << 8; h7 += ((t5 >>> 11) | (t6 <<  5)) & 0x1fff;
    t7 = m[mpos+14] & 0xff | (m[mpos+15] & 0xff) << 8; h8 += ((t6 >>>  8) | (t7 <<  8)) & 0x1fff;
    h9 += ((t7 >>> 5)) | hibit;

    c = 0;

    d0 = c;
    d0 += h0 * r0;
    d0 += h1 * (5 * r9);
    d0 += h2 * (5 * r8);
    d0 += h3 * (5 * r7);
    d0 += h4 * (5 * r6);
    c = (d0 >>> 13); d0 &= 0x1fff;
    d0 += h5 * (5 * r5);
    d0 += h6 * (5 * r4);
    d0 += h7 * (5 * r3);
    d0 += h8 * (5 * r2);
    d0 += h9 * (5 * r1);
    c += (d0 >>> 13); d0 &= 0x1fff;

    d1 = c;
    d1 += h0 * r1;
    d1 += h1 * r0;
    d1 += h2 * (5 * r9);
    d1 += h3 * (5 * r8);
    d1 += h4 * (5 * r7);
    c = (d1 >>> 13); d1 &= 0x1fff;
    d1 += h5 * (5 * r6);
    d1 += h6 * (5 * r5);
    d1 += h7 * (5 * r4);
    d1 += h8 * (5 * r3);
    d1 += h9 * (5 * r2);
    c += (d1 >>> 13); d1 &= 0x1fff;

    d2 = c;
    d2 += h0 * r2;
    d2 += h1 * r1;
    d2 += h2 * r0;
    d2 += h3 * (5 * r9);
    d2 += h4 * (5 * r8);
    c = (d2 >>> 13); d2 &= 0x1fff;
    d2 += h5 * (5 * r7);
    d2 += h6 * (5 * r6);
    d2 += h7 * (5 * r5);
    d2 += h8 * (5 * r4);
    d2 += h9 * (5 * r3);
    c += (d2 >>> 13); d2 &= 0x1fff;

    d3 = c;
    d3 += h0 * r3;
    d3 += h1 * r2;
    d3 += h2 * r1;
    d3 += h3 * r0;
    d3 += h4 * (5 * r9);
    c = (d3 >>> 13); d3 &= 0x1fff;
    d3 += h5 * (5 * r8);
    d3 += h6 * (5 * r7);
    d3 += h7 * (5 * r6);
    d3 += h8 * (5 * r5);
    d3 += h9 * (5 * r4);
    c += (d3 >>> 13); d3 &= 0x1fff;

    d4 = c;
    d4 += h0 * r4;
    d4 += h1 * r3;
    d4 += h2 * r2;
    d4 += h3 * r1;
    d4 += h4 * r0;
    c = (d4 >>> 13); d4 &= 0x1fff;
    d4 += h5 * (5 * r9);
    d4 += h6 * (5 * r8);
    d4 += h7 * (5 * r7);
    d4 += h8 * (5 * r6);
    d4 += h9 * (5 * r5);
    c += (d4 >>> 13); d4 &= 0x1fff;

    d5 = c;
    d5 += h0 * r5;
    d5 += h1 * r4;
    d5 += h2 * r3;
    d5 += h3 * r2;
    d5 += h4 * r1;
    c = (d5 >>> 13); d5 &= 0x1fff;
    d5 += h5 * r0;
    d5 += h6 * (5 * r9);
    d5 += h7 * (5 * r8);
    d5 += h8 * (5 * r7);
    d5 += h9 * (5 * r6);
    c += (d5 >>> 13); d5 &= 0x1fff;

    d6 = c;
    d6 += h0 * r6;
    d6 += h1 * r5;
    d6 += h2 * r4;
    d6 += h3 * r3;
    d6 += h4 * r2;
    c = (d6 >>> 13); d6 &= 0x1fff;
    d6 += h5 * r1;
    d6 += h6 * r0;
    d6 += h7 * (5 * r9);
    d6 += h8 * (5 * r8);
    d6 += h9 * (5 * r7);
    c += (d6 >>> 13); d6 &= 0x1fff;

    d7 = c;
    d7 += h0 * r7;
    d7 += h1 * r6;
    d7 += h2 * r5;
    d7 += h3 * r4;
    d7 += h4 * r3;
    c = (d7 >>> 13); d7 &= 0x1fff;
    d7 += h5 * r2;
    d7 += h6 * r1;
    d7 += h7 * r0;
    d7 += h8 * (5 * r9);
    d7 += h9 * (5 * r8);
    c += (d7 >>> 13); d7 &= 0x1fff;

    d8 = c;
    d8 += h0 * r8;
    d8 += h1 * r7;
    d8 += h2 * r6;
    d8 += h3 * r5;
    d8 += h4 * r4;
    c = (d8 >>> 13); d8 &= 0x1fff;
    d8 += h5 * r3;
    d8 += h6 * r2;
    d8 += h7 * r1;
    d8 += h8 * r0;
    d8 += h9 * (5 * r9);
    c += (d8 >>> 13); d8 &= 0x1fff;

    d9 = c;
    d9 += h0 * r9;
    d9 += h1 * r8;
    d9 += h2 * r7;
    d9 += h3 * r6;
    d9 += h4 * r5;
    c = (d9 >>> 13); d9 &= 0x1fff;
    d9 += h5 * r4;
    d9 += h6 * r3;
    d9 += h7 * r2;
    d9 += h8 * r1;
    d9 += h9 * r0;
    c += (d9 >>> 13); d9 &= 0x1fff;

    c = (((c << 2) + c)) | 0;
    c = (c + d0) | 0;
    d0 = c & 0x1fff;
    c = (c >>> 13);
    d1 += c;

    h0 = d0;
    h1 = d1;
    h2 = d2;
    h3 = d3;
    h4 = d4;
    h5 = d5;
    h6 = d6;
    h7 = d7;
    h8 = d8;
    h9 = d9;

    mpos += 16;
    bytes -= 16;
  }
  this.h[0] = h0;
  this.h[1] = h1;
  this.h[2] = h2;
  this.h[3] = h3;
  this.h[4] = h4;
  this.h[5] = h5;
  this.h[6] = h6;
  this.h[7] = h7;
  this.h[8] = h8;
  this.h[9] = h9;
};

poly1305.prototype.finish = function(mac, macpos) {
  var g = new Uint16Array(10);
  var c, mask, f, i;

  if (this.leftover) {
    i = this.leftover;
    this.buffer[i++] = 1;
    for (; i < 16; i++) this.buffer[i] = 0;
    this.fin = 1;
    this.blocks(this.buffer, 0, 16);
  }

  c = this.h[1] >>> 13;
  this.h[1] &= 0x1fff;
  for (i = 2; i < 10; i++) {
    this.h[i] += c;
    c = this.h[i] >>> 13;
    this.h[i] &= 0x1fff;
  }
  this.h[0] += (c * 5);
  c = this.h[0] >>> 13;
  this.h[0] &= 0x1fff;
  this.h[1] += c;
  c = this.h[1] >>> 13;
  this.h[1] &= 0x1fff;
  this.h[2] += c;

  g[0] = this.h[0] + 5;
  c = g[0] >>> 13;
  g[0] &= 0x1fff;
  for (i = 1; i < 10; i++) {
    g[i] = this.h[i] + c;
    c = g[i] >>> 13;
    g[i] &= 0x1fff;
  }
  g[9] -= (1 << 13);

  mask = (c ^ 1) - 1;
  for (i = 0; i < 10; i++) g[i] &= mask;
  mask = ~mask;
  for (i = 0; i < 10; i++) this.h[i] = (this.h[i] & mask) | g[i];

  this.h[0] = ((this.h[0]       ) | (this.h[1] << 13)                    ) & 0xffff;
  this.h[1] = ((this.h[1] >>>  3) | (this.h[2] << 10)                    ) & 0xffff;
  this.h[2] = ((this.h[2] >>>  6) | (this.h[3] <<  7)                    ) & 0xffff;
  this.h[3] = ((this.h[3] >>>  9) | (this.h[4] <<  4)                    ) & 0xffff;
  this.h[4] = ((this.h[4] >>> 12) | (this.h[5] <<  1) | (this.h[6] << 14)) & 0xffff;
  this.h[5] = ((this.h[6] >>>  2) | (this.h[7] << 11)                    ) & 0xffff;
  this.h[6] = ((this.h[7] >>>  5) | (this.h[8] <<  8)                    ) & 0xffff;
  this.h[7] = ((this.h[8] >>>  8) | (this.h[9] <<  5)                    ) & 0xffff;

  f = this.h[0] + this.pad[0];
  this.h[0] = f & 0xffff;
  for (i = 1; i < 8; i++) {
    f = (((this.h[i] + this.pad[i]) | 0) + (f >>> 16)) | 0;
    this.h[i] = f & 0xffff;
  }

  mac[macpos+ 0] = (this.h[0] >>> 0) & 0xff;
  mac[macpos+ 1] = (this.h[0] >>> 8) & 0xff;
  mac[macpos+ 2] = (this.h[1] >>> 0) & 0xff;
  mac[macpos+ 3] = (this.h[1] >>> 8) & 0xff;
  mac[macpos+ 4] = (this.h[2] >>> 0) & 0xff;
  mac[macpos+ 5] = (this.h[2] >>> 8) & 0xff;
  mac[macpos+ 6] = (this.h[3] >>> 0) & 0xff;
  mac[macpos+ 7] = (this.h[3] >>> 8) & 0xff;
  mac[macpos+ 8] = (this.h[4] >>> 0) & 0xff;
  mac[macpos+ 9] = (this.h[4] >>> 8) & 0xff;
  mac[macpos+10] = (this.h[5] >>> 0) & 0xff;
  mac[macpos+11] = (this.h[5] >>> 8) & 0xff;
  mac[macpos+12] = (this.h[6] >>> 0) & 0xff;
  mac[macpos+13] = (this.h[6] >>> 8) & 0xff;
  mac[macpos+14] = (this.h[7] >>> 0) & 0xff;
  mac[macpos+15] = (this.h[7] >>> 8) & 0xff;
};

poly1305.prototype.update = function(m, mpos, bytes) {
  var i, want;

  if (this.leftover) {
    want = (16 - this.leftover);
    if (want > bytes)
      want = bytes;
    for (i = 0; i < want; i++)
      this.buffer[this.leftover + i] = m[mpos+i];
    bytes -= want;
    mpos += want;
    this.leftover += want;
    if (this.leftover < 16)
      return;
    this.blocks(this.buffer, 0, 16);
    this.leftover = 0;
  }

  if (bytes >= 16) {
    want = bytes - (bytes % 16);
    this.blocks(m, mpos, want);
    mpos += want;
    bytes -= want;
  }

  if (bytes) {
    for (i = 0; i < bytes; i++)
      this.buffer[this.leftover + i] = m[mpos+i];
    this.leftover += bytes;
  }
};

function crypto_stream_xor (c, cpos, m, mpos, clen, n, k) {
  cs.crypto_stream_xor(c, m, n, k)
}

function crypto_stream (c, cpos, clen, n, k) {
  cs.crypto_stream(c, n, k)
}

function crypto_onetimeauth(out, outpos, m, mpos, n, k) {
  var s = new poly1305(k);
  s.update(m, mpos, n);
  s.finish(out, outpos);
  return 0;
}

function crypto_onetimeauth_verify(h, hpos, m, mpos, n, k) {
  var x = new Uint8Array(16);
  crypto_onetimeauth(x,0,m,mpos,n,k);
  return crypto_verify_16(h,hpos,x,0);
}

function crypto_secretbox(c,m,d,n,k) {
  var i;
  if (d < 32) return -1;
  crypto_stream_xor(c,0,m,0,d,n,k);
  crypto_onetimeauth(c, 16, c, 32, d - 32, c);
  for (i = 0; i < 16; i++) c[i] = 0;
  return 0;
}

function crypto_secretbox_open(m,c,d,n,k) {
  var i;
  var x = new Uint8Array(32);
  if (d < 32) return -1;
  crypto_stream(x,0,32,n,k);
  if (crypto_onetimeauth_verify(c, 16,c, 32,d - 32,x) !== 0) return -1;
  crypto_stream_xor(m,0,c,0,d,n,k);
  for (i = 0; i < 32; i++) m[i] = 0;
  return 0;
}

function set25519(r, a) {
  var i;
  for (i = 0; i < 16; i++) r[i] = a[i]|0;
}

function car25519(o) {
  var i, v, c = 1;
  for (i = 0; i < 16; i++) {
    v = o[i] + c + 65535;
    c = Math.floor(v / 65536);
    o[i] = v - c * 65536;
  }
  o[0] += c-1 + 37 * (c-1);
}

function sel25519(p, q, b) {
  var t, c = ~(b-1);
  for (var i = 0; i < 16; i++) {
    t = c & (p[i] ^ q[i]);
    p[i] ^= t;
    q[i] ^= t;
  }
}

function pack25519(o, n) {
  var i, j, b;
  var m = gf(), t = gf();
  for (i = 0; i < 16; i++) t[i] = n[i];
  car25519(t);
  car25519(t);
  car25519(t);
  for (j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i-1]>>16) & 1);
      m[i-1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14]>>16) & 1);
    b = (m[15]>>16) & 1;
    m[14] &= 0xffff;
    sel25519(t, m, 1-b);
  }
  for (i = 0; i < 16; i++) {
    o[2*i] = t[i] & 0xff;
    o[2*i+1] = t[i]>>8;
  }
}

function neq25519(a, b) {
  var c = new Uint8Array(32), d = new Uint8Array(32);
  pack25519(c, a);
  pack25519(d, b);
  return crypto_verify_32(c, 0, d, 0);
}

function par25519(a) {
  var d = new Uint8Array(32);
  pack25519(d, a);
  return d[0] & 1;
}

function unpack25519(o, n) {
  var i;
  for (i = 0; i < 16; i++) o[i] = n[2*i] + (n[2*i+1] << 8);
  o[15] &= 0x7fff;
}

function A(o, a, b) {
  for (var i = 0; i < 16; i++) o[i] = a[i] + b[i];
}

function Z(o, a, b) {
  for (var i = 0; i < 16; i++) o[i] = a[i] - b[i];
}

function M(o, a, b) {
  var v, c,
     t0 = 0,  t1 = 0,  t2 = 0,  t3 = 0,  t4 = 0,  t5 = 0,  t6 = 0,  t7 = 0,
     t8 = 0,  t9 = 0, t10 = 0, t11 = 0, t12 = 0, t13 = 0, t14 = 0, t15 = 0,
    t16 = 0, t17 = 0, t18 = 0, t19 = 0, t20 = 0, t21 = 0, t22 = 0, t23 = 0,
    t24 = 0, t25 = 0, t26 = 0, t27 = 0, t28 = 0, t29 = 0, t30 = 0,
    b0 = b[0],
    b1 = b[1],
    b2 = b[2],
    b3 = b[3],
    b4 = b[4],
    b5 = b[5],
    b6 = b[6],
    b7 = b[7],
    b8 = b[8],
    b9 = b[9],
    b10 = b[10],
    b11 = b[11],
    b12 = b[12],
    b13 = b[13],
    b14 = b[14],
    b15 = b[15];

  v = a[0];
  t0 += v * b0;
  t1 += v * b1;
  t2 += v * b2;
  t3 += v * b3;
  t4 += v * b4;
  t5 += v * b5;
  t6 += v * b6;
  t7 += v * b7;
  t8 += v * b8;
  t9 += v * b9;
  t10 += v * b10;
  t11 += v * b11;
  t12 += v * b12;
  t13 += v * b13;
  t14 += v * b14;
  t15 += v * b15;
  v = a[1];
  t1 += v * b0;
  t2 += v * b1;
  t3 += v * b2;
  t4 += v * b3;
  t5 += v * b4;
  t6 += v * b5;
  t7 += v * b6;
  t8 += v * b7;
  t9 += v * b8;
  t10 += v * b9;
  t11 += v * b10;
  t12 += v * b11;
  t13 += v * b12;
  t14 += v * b13;
  t15 += v * b14;
  t16 += v * b15;
  v = a[2];
  t2 += v * b0;
  t3 += v * b1;
  t4 += v * b2;
  t5 += v * b3;
  t6 += v * b4;
  t7 += v * b5;
  t8 += v * b6;
  t9 += v * b7;
  t10 += v * b8;
  t11 += v * b9;
  t12 += v * b10;
  t13 += v * b11;
  t14 += v * b12;
  t15 += v * b13;
  t16 += v * b14;
  t17 += v * b15;
  v = a[3];
  t3 += v * b0;
  t4 += v * b1;
  t5 += v * b2;
  t6 += v * b3;
  t7 += v * b4;
  t8 += v * b5;
  t9 += v * b6;
  t10 += v * b7;
  t11 += v * b8;
  t12 += v * b9;
  t13 += v * b10;
  t14 += v * b11;
  t15 += v * b12;
  t16 += v * b13;
  t17 += v * b14;
  t18 += v * b15;
  v = a[4];
  t4 += v * b0;
  t5 += v * b1;
  t6 += v * b2;
  t7 += v * b3;
  t8 += v * b4;
  t9 += v * b5;
  t10 += v * b6;
  t11 += v * b7;
  t12 += v * b8;
  t13 += v * b9;
  t14 += v * b10;
  t15 += v * b11;
  t16 += v * b12;
  t17 += v * b13;
  t18 += v * b14;
  t19 += v * b15;
  v = a[5];
  t5 += v * b0;
  t6 += v * b1;
  t7 += v * b2;
  t8 += v * b3;
  t9 += v * b4;
  t10 += v * b5;
  t11 += v * b6;
  t12 += v * b7;
  t13 += v * b8;
  t14 += v * b9;
  t15 += v * b10;
  t16 += v * b11;
  t17 += v * b12;
  t18 += v * b13;
  t19 += v * b14;
  t20 += v * b15;
  v = a[6];
  t6 += v * b0;
  t7 += v * b1;
  t8 += v * b2;
  t9 += v * b3;
  t10 += v * b4;
  t11 += v * b5;
  t12 += v * b6;
  t13 += v * b7;
  t14 += v * b8;
  t15 += v * b9;
  t16 += v * b10;
  t17 += v * b11;
  t18 += v * b12;
  t19 += v * b13;
  t20 += v * b14;
  t21 += v * b15;
  v = a[7];
  t7 += v * b0;
  t8 += v * b1;
  t9 += v * b2;
  t10 += v * b3;
  t11 += v * b4;
  t12 += v * b5;
  t13 += v * b6;
  t14 += v * b7;
  t15 += v * b8;
  t16 += v * b9;
  t17 += v * b10;
  t18 += v * b11;
  t19 += v * b12;
  t20 += v * b13;
  t21 += v * b14;
  t22 += v * b15;
  v = a[8];
  t8 += v * b0;
  t9 += v * b1;
  t10 += v * b2;
  t11 += v * b3;
  t12 += v * b4;
  t13 += v * b5;
  t14 += v * b6;
  t15 += v * b7;
  t16 += v * b8;
  t17 += v * b9;
  t18 += v * b10;
  t19 += v * b11;
  t20 += v * b12;
  t21 += v * b13;
  t22 += v * b14;
  t23 += v * b15;
  v = a[9];
  t9 += v * b0;
  t10 += v * b1;
  t11 += v * b2;
  t12 += v * b3;
  t13 += v * b4;
  t14 += v * b5;
  t15 += v * b6;
  t16 += v * b7;
  t17 += v * b8;
  t18 += v * b9;
  t19 += v * b10;
  t20 += v * b11;
  t21 += v * b12;
  t22 += v * b13;
  t23 += v * b14;
  t24 += v * b15;
  v = a[10];
  t10 += v * b0;
  t11 += v * b1;
  t12 += v * b2;
  t13 += v * b3;
  t14 += v * b4;
  t15 += v * b5;
  t16 += v * b6;
  t17 += v * b7;
  t18 += v * b8;
  t19 += v * b9;
  t20 += v * b10;
  t21 += v * b11;
  t22 += v * b12;
  t23 += v * b13;
  t24 += v * b14;
  t25 += v * b15;
  v = a[11];
  t11 += v * b0;
  t12 += v * b1;
  t13 += v * b2;
  t14 += v * b3;
  t15 += v * b4;
  t16 += v * b5;
  t17 += v * b6;
  t18 += v * b7;
  t19 += v * b8;
  t20 += v * b9;
  t21 += v * b10;
  t22 += v * b11;
  t23 += v * b12;
  t24 += v * b13;
  t25 += v * b14;
  t26 += v * b15;
  v = a[12];
  t12 += v * b0;
  t13 += v * b1;
  t14 += v * b2;
  t15 += v * b3;
  t16 += v * b4;
  t17 += v * b5;
  t18 += v * b6;
  t19 += v * b7;
  t20 += v * b8;
  t21 += v * b9;
  t22 += v * b10;
  t23 += v * b11;
  t24 += v * b12;
  t25 += v * b13;
  t26 += v * b14;
  t27 += v * b15;
  v = a[13];
  t13 += v * b0;
  t14 += v * b1;
  t15 += v * b2;
  t16 += v * b3;
  t17 += v * b4;
  t18 += v * b5;
  t19 += v * b6;
  t20 += v * b7;
  t21 += v * b8;
  t22 += v * b9;
  t23 += v * b10;
  t24 += v * b11;
  t25 += v * b12;
  t26 += v * b13;
  t27 += v * b14;
  t28 += v * b15;
  v = a[14];
  t14 += v * b0;
  t15 += v * b1;
  t16 += v * b2;
  t17 += v * b3;
  t18 += v * b4;
  t19 += v * b5;
  t20 += v * b6;
  t21 += v * b7;
  t22 += v * b8;
  t23 += v * b9;
  t24 += v * b10;
  t25 += v * b11;
  t26 += v * b12;
  t27 += v * b13;
  t28 += v * b14;
  t29 += v * b15;
  v = a[15];
  t15 += v * b0;
  t16 += v * b1;
  t17 += v * b2;
  t18 += v * b3;
  t19 += v * b4;
  t20 += v * b5;
  t21 += v * b6;
  t22 += v * b7;
  t23 += v * b8;
  t24 += v * b9;
  t25 += v * b10;
  t26 += v * b11;
  t27 += v * b12;
  t28 += v * b13;
  t29 += v * b14;
  t30 += v * b15;

  t0  += 38 * t16;
  t1  += 38 * t17;
  t2  += 38 * t18;
  t3  += 38 * t19;
  t4  += 38 * t20;
  t5  += 38 * t21;
  t6  += 38 * t22;
  t7  += 38 * t23;
  t8  += 38 * t24;
  t9  += 38 * t25;
  t10 += 38 * t26;
  t11 += 38 * t27;
  t12 += 38 * t28;
  t13 += 38 * t29;
  t14 += 38 * t30;
  // t15 left as is

  // first car
  c = 1;
  v =  t0 + c + 65535; c = Math.floor(v / 65536);  t0 = v - c * 65536;
  v =  t1 + c + 65535; c = Math.floor(v / 65536);  t1 = v - c * 65536;
  v =  t2 + c + 65535; c = Math.floor(v / 65536);  t2 = v - c * 65536;
  v =  t3 + c + 65535; c = Math.floor(v / 65536);  t3 = v - c * 65536;
  v =  t4 + c + 65535; c = Math.floor(v / 65536);  t4 = v - c * 65536;
  v =  t5 + c + 65535; c = Math.floor(v / 65536);  t5 = v - c * 65536;
  v =  t6 + c + 65535; c = Math.floor(v / 65536);  t6 = v - c * 65536;
  v =  t7 + c + 65535; c = Math.floor(v / 65536);  t7 = v - c * 65536;
  v =  t8 + c + 65535; c = Math.floor(v / 65536);  t8 = v - c * 65536;
  v =  t9 + c + 65535; c = Math.floor(v / 65536);  t9 = v - c * 65536;
  v = t10 + c + 65535; c = Math.floor(v / 65536); t10 = v - c * 65536;
  v = t11 + c + 65535; c = Math.floor(v / 65536); t11 = v - c * 65536;
  v = t12 + c + 65535; c = Math.floor(v / 65536); t12 = v - c * 65536;
  v = t13 + c + 65535; c = Math.floor(v / 65536); t13 = v - c * 65536;
  v = t14 + c + 65535; c = Math.floor(v / 65536); t14 = v - c * 65536;
  v = t15 + c + 65535; c = Math.floor(v / 65536); t15 = v - c * 65536;
  t0 += c-1 + 37 * (c-1);

  // second car
  c = 1;
  v =  t0 + c + 65535; c = Math.floor(v / 65536);  t0 = v - c * 65536;
  v =  t1 + c + 65535; c = Math.floor(v / 65536);  t1 = v - c * 65536;
  v =  t2 + c + 65535; c = Math.floor(v / 65536);  t2 = v - c * 65536;
  v =  t3 + c + 65535; c = Math.floor(v / 65536);  t3 = v - c * 65536;
  v =  t4 + c + 65535; c = Math.floor(v / 65536);  t4 = v - c * 65536;
  v =  t5 + c + 65535; c = Math.floor(v / 65536);  t5 = v - c * 65536;
  v =  t6 + c + 65535; c = Math.floor(v / 65536);  t6 = v - c * 65536;
  v =  t7 + c + 65535; c = Math.floor(v / 65536);  t7 = v - c * 65536;
  v =  t8 + c + 65535; c = Math.floor(v / 65536);  t8 = v - c * 65536;
  v =  t9 + c + 65535; c = Math.floor(v / 65536);  t9 = v - c * 65536;
  v = t10 + c + 65535; c = Math.floor(v / 65536); t10 = v - c * 65536;
  v = t11 + c + 65535; c = Math.floor(v / 65536); t11 = v - c * 65536;
  v = t12 + c + 65535; c = Math.floor(v / 65536); t12 = v - c * 65536;
  v = t13 + c + 65535; c = Math.floor(v / 65536); t13 = v - c * 65536;
  v = t14 + c + 65535; c = Math.floor(v / 65536); t14 = v - c * 65536;
  v = t15 + c + 65535; c = Math.floor(v / 65536); t15 = v - c * 65536;
  t0 += c-1 + 37 * (c-1);

  o[ 0] = t0;
  o[ 1] = t1;
  o[ 2] = t2;
  o[ 3] = t3;
  o[ 4] = t4;
  o[ 5] = t5;
  o[ 6] = t6;
  o[ 7] = t7;
  o[ 8] = t8;
  o[ 9] = t9;
  o[10] = t10;
  o[11] = t11;
  o[12] = t12;
  o[13] = t13;
  o[14] = t14;
  o[15] = t15;
}

function S(o, a) {
  M(o, a, a);
}

function inv25519(o, i) {
  var c = gf();
  var a;
  for (a = 0; a < 16; a++) c[a] = i[a];
  for (a = 253; a >= 0; a--) {
    S(c, c);
    if(a !== 2 && a !== 4) M(c, c, i);
  }
  for (a = 0; a < 16; a++) o[a] = c[a];
}

function pow2523(o, i) {
  var c = gf();
  var a;
  for (a = 0; a < 16; a++) c[a] = i[a];
  for (a = 250; a >= 0; a--) {
      S(c, c);
      if(a !== 1) M(c, c, i);
  }
  for (a = 0; a < 16; a++) o[a] = c[a];
}

function crypto_scalarmult(q, n, p) {
  check(q, crypto_scalarmult_BYTES)
  check(n, crypto_scalarmult_SCALARBYTES)
  check(p, crypto_scalarmult_BYTES)
  var z = new Uint8Array(32);
  var x = new Float64Array(80), r, i;
  var a = gf(), b = gf(), c = gf(),
      d = gf(), e = gf(), f = gf();
  for (i = 0; i < 31; i++) z[i] = n[i];
  z[31]=(n[31]&127)|64;
  z[0]&=248;
  unpack25519(x,p);
  for (i = 0; i < 16; i++) {
    b[i]=x[i];
    d[i]=a[i]=c[i]=0;
  }
  a[0]=d[0]=1;
  for (i=254; i>=0; --i) {
    r=(z[i>>>3]>>>(i&7))&1;
    sel25519(a,b,r);
    sel25519(c,d,r);
    A(e,a,c);
    Z(a,a,c);
    A(c,b,d);
    Z(b,b,d);
    S(d,e);
    S(f,a);
    M(a,c,a);
    M(c,b,e);
    A(e,a,c);
    Z(a,a,c);
    S(b,a);
    Z(c,d,f);
    M(a,c,_121665);
    A(a,a,d);
    M(c,c,a);
    M(a,d,f);
    M(d,b,x);
    S(b,e);
    sel25519(a,b,r);
    sel25519(c,d,r);
  }
  for (i = 0; i < 16; i++) {
    x[i+16]=a[i];
    x[i+32]=c[i];
    x[i+48]=b[i];
    x[i+64]=d[i];
  }
  var x32 = x.subarray(32);
  var x16 = x.subarray(16);
  inv25519(x32,x32);
  M(x16,x16,x32);
  pack25519(q,x16);
  return 0;
}

function crypto_scalarmult_base(q, n) {
  return crypto_scalarmult(q, n, _9);
}

var K = [
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd,
  0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019,
  0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
  0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1,
  0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3,
  0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483,
  0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210,
  0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
  0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926,
  0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8,
  0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001,
  0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910,
  0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
  0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb,
  0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60,
  0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9,
  0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207,
  0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
  0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493,
  0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a,
  0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817
];

function crypto_hashblocks_hl(hh, hl, m, n) {
  var wh = new Int32Array(16), wl = new Int32Array(16),
      bh0, bh1, bh2, bh3, bh4, bh5, bh6, bh7,
      bl0, bl1, bl2, bl3, bl4, bl5, bl6, bl7,
      th, tl, i, j, h, l, a, b, c, d;

  var ah0 = hh[0],
      ah1 = hh[1],
      ah2 = hh[2],
      ah3 = hh[3],
      ah4 = hh[4],
      ah5 = hh[5],
      ah6 = hh[6],
      ah7 = hh[7],

      al0 = hl[0],
      al1 = hl[1],
      al2 = hl[2],
      al3 = hl[3],
      al4 = hl[4],
      al5 = hl[5],
      al6 = hl[6],
      al7 = hl[7];

  var pos = 0;
  while (n >= 128) {
    for (i = 0; i < 16; i++) {
      j = 8 * i + pos;
      wh[i] = (m[j+0] << 24) | (m[j+1] << 16) | (m[j+2] << 8) | m[j+3];
      wl[i] = (m[j+4] << 24) | (m[j+5] << 16) | (m[j+6] << 8) | m[j+7];
    }
    for (i = 0; i < 80; i++) {
      bh0 = ah0;
      bh1 = ah1;
      bh2 = ah2;
      bh3 = ah3;
      bh4 = ah4;
      bh5 = ah5;
      bh6 = ah6;
      bh7 = ah7;

      bl0 = al0;
      bl1 = al1;
      bl2 = al2;
      bl3 = al3;
      bl4 = al4;
      bl5 = al5;
      bl6 = al6;
      bl7 = al7;

      // add
      h = ah7;
      l = al7;

      a = l & 0xffff; b = l >>> 16;
      c = h & 0xffff; d = h >>> 16;

      // Sigma1
      h = ((ah4 >>> 14) | (al4 << (32-14))) ^ ((ah4 >>> 18) | (al4 << (32-18))) ^ ((al4 >>> (41-32)) | (ah4 << (32-(41-32))));
      l = ((al4 >>> 14) | (ah4 << (32-14))) ^ ((al4 >>> 18) | (ah4 << (32-18))) ^ ((ah4 >>> (41-32)) | (al4 << (32-(41-32))));

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      // Ch
      h = (ah4 & ah5) ^ (~ah4 & ah6);
      l = (al4 & al5) ^ (~al4 & al6);

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      // K
      h = K[i*2];
      l = K[i*2+1];

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      // w
      h = wh[i%16];
      l = wl[i%16];

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      b += a >>> 16;
      c += b >>> 16;
      d += c >>> 16;

      th = c & 0xffff | d << 16;
      tl = a & 0xffff | b << 16;

      // add
      h = th;
      l = tl;

      a = l & 0xffff; b = l >>> 16;
      c = h & 0xffff; d = h >>> 16;

      // Sigma0
      h = ((ah0 >>> 28) | (al0 << (32-28))) ^ ((al0 >>> (34-32)) | (ah0 << (32-(34-32)))) ^ ((al0 >>> (39-32)) | (ah0 << (32-(39-32))));
      l = ((al0 >>> 28) | (ah0 << (32-28))) ^ ((ah0 >>> (34-32)) | (al0 << (32-(34-32)))) ^ ((ah0 >>> (39-32)) | (al0 << (32-(39-32))));

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      // Maj
      h = (ah0 & ah1) ^ (ah0 & ah2) ^ (ah1 & ah2);
      l = (al0 & al1) ^ (al0 & al2) ^ (al1 & al2);

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      b += a >>> 16;
      c += b >>> 16;
      d += c >>> 16;

      bh7 = (c & 0xffff) | (d << 16);
      bl7 = (a & 0xffff) | (b << 16);

      // add
      h = bh3;
      l = bl3;

      a = l & 0xffff; b = l >>> 16;
      c = h & 0xffff; d = h >>> 16;

      h = th;
      l = tl;

      a += l & 0xffff; b += l >>> 16;
      c += h & 0xffff; d += h >>> 16;

      b += a >>> 16;
      c += b >>> 16;
      d += c >>> 16;

      bh3 = (c & 0xffff) | (d << 16);
      bl3 = (a & 0xffff) | (b << 16);

      ah1 = bh0;
      ah2 = bh1;
      ah3 = bh2;
      ah4 = bh3;
      ah5 = bh4;
      ah6 = bh5;
      ah7 = bh6;
      ah0 = bh7;

      al1 = bl0;
      al2 = bl1;
      al3 = bl2;
      al4 = bl3;
      al5 = bl4;
      al6 = bl5;
      al7 = bl6;
      al0 = bl7;

      if (i%16 === 15) {
        for (j = 0; j < 16; j++) {
          // add
          h = wh[j];
          l = wl[j];

          a = l & 0xffff; b = l >>> 16;
          c = h & 0xffff; d = h >>> 16;

          h = wh[(j+9)%16];
          l = wl[(j+9)%16];

          a += l & 0xffff; b += l >>> 16;
          c += h & 0xffff; d += h >>> 16;

          // sigma0
          th = wh[(j+1)%16];
          tl = wl[(j+1)%16];
          h = ((th >>> 1) | (tl << (32-1))) ^ ((th >>> 8) | (tl << (32-8))) ^ (th >>> 7);
          l = ((tl >>> 1) | (th << (32-1))) ^ ((tl >>> 8) | (th << (32-8))) ^ ((tl >>> 7) | (th << (32-7)));

          a += l & 0xffff; b += l >>> 16;
          c += h & 0xffff; d += h >>> 16;

          // sigma1
          th = wh[(j+14)%16];
          tl = wl[(j+14)%16];
          h = ((th >>> 19) | (tl << (32-19))) ^ ((tl >>> (61-32)) | (th << (32-(61-32)))) ^ (th >>> 6);
          l = ((tl >>> 19) | (th << (32-19))) ^ ((th >>> (61-32)) | (tl << (32-(61-32)))) ^ ((tl >>> 6) | (th << (32-6)));

          a += l & 0xffff; b += l >>> 16;
          c += h & 0xffff; d += h >>> 16;

          b += a >>> 16;
          c += b >>> 16;
          d += c >>> 16;

          wh[j] = (c & 0xffff) | (d << 16);
          wl[j] = (a & 0xffff) | (b << 16);
        }
      }
    }

    // add
    h = ah0;
    l = al0;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[0];
    l = hl[0];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[0] = ah0 = (c & 0xffff) | (d << 16);
    hl[0] = al0 = (a & 0xffff) | (b << 16);

    h = ah1;
    l = al1;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[1];
    l = hl[1];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[1] = ah1 = (c & 0xffff) | (d << 16);
    hl[1] = al1 = (a & 0xffff) | (b << 16);

    h = ah2;
    l = al2;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[2];
    l = hl[2];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[2] = ah2 = (c & 0xffff) | (d << 16);
    hl[2] = al2 = (a & 0xffff) | (b << 16);

    h = ah3;
    l = al3;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[3];
    l = hl[3];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[3] = ah3 = (c & 0xffff) | (d << 16);
    hl[3] = al3 = (a & 0xffff) | (b << 16);

    h = ah4;
    l = al4;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[4];
    l = hl[4];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[4] = ah4 = (c & 0xffff) | (d << 16);
    hl[4] = al4 = (a & 0xffff) | (b << 16);

    h = ah5;
    l = al5;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[5];
    l = hl[5];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[5] = ah5 = (c & 0xffff) | (d << 16);
    hl[5] = al5 = (a & 0xffff) | (b << 16);

    h = ah6;
    l = al6;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[6];
    l = hl[6];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[6] = ah6 = (c & 0xffff) | (d << 16);
    hl[6] = al6 = (a & 0xffff) | (b << 16);

    h = ah7;
    l = al7;

    a = l & 0xffff; b = l >>> 16;
    c = h & 0xffff; d = h >>> 16;

    h = hh[7];
    l = hl[7];

    a += l & 0xffff; b += l >>> 16;
    c += h & 0xffff; d += h >>> 16;

    b += a >>> 16;
    c += b >>> 16;
    d += c >>> 16;

    hh[7] = ah7 = (c & 0xffff) | (d << 16);
    hl[7] = al7 = (a & 0xffff) | (b << 16);

    pos += 128;
    n -= 128;
  }

  return n;
}

function crypto_hash(out, m, n) {
  var hh = new Int32Array(8),
      hl = new Int32Array(8),
      x = new Uint8Array(256),
      i, b = n;

  hh[0] = 0x6a09e667;
  hh[1] = 0xbb67ae85;
  hh[2] = 0x3c6ef372;
  hh[3] = 0xa54ff53a;
  hh[4] = 0x510e527f;
  hh[5] = 0x9b05688c;
  hh[6] = 0x1f83d9ab;
  hh[7] = 0x5be0cd19;

  hl[0] = 0xf3bcc908;
  hl[1] = 0x84caa73b;
  hl[2] = 0xfe94f82b;
  hl[3] = 0x5f1d36f1;
  hl[4] = 0xade682d1;
  hl[5] = 0x2b3e6c1f;
  hl[6] = 0xfb41bd6b;
  hl[7] = 0x137e2179;

  crypto_hashblocks_hl(hh, hl, m, n);
  n %= 128;

  for (i = 0; i < n; i++) x[i] = m[b-n+i];
  x[n] = 128;

  n = 256-128*(n<112?1:0);
  x[n-9] = 0;
  ts64(x, n-8,  (b / 0x20000000) | 0, b << 3);
  crypto_hashblocks_hl(hh, hl, x, n);

  for (i = 0; i < 8; i++) ts64(out, 8*i, hh[i], hl[i]);

  return 0;
}

function add(p, q) {
  var a = gf(), b = gf(), c = gf(),
      d = gf(), e = gf(), f = gf(),
      g = gf(), h = gf(), t = gf();

  Z(a, p[1], p[0]);
  Z(t, q[1], q[0]);
  M(a, a, t);
  A(b, p[0], p[1]);
  A(t, q[0], q[1]);
  M(b, b, t);
  M(c, p[3], q[3]);
  M(c, c, D2);
  M(d, p[2], q[2]);
  A(d, d, d);
  Z(e, b, a);
  Z(f, d, c);
  A(g, d, c);
  A(h, b, a);

  M(p[0], e, f);
  M(p[1], h, g);
  M(p[2], g, f);
  M(p[3], e, h);
}

function cswap(p, q, b) {
  var i;
  for (i = 0; i < 4; i++) {
    sel25519(p[i], q[i], b);
  }
}

function pack(r, p) {
  var tx = gf(), ty = gf(), zi = gf();
  inv25519(zi, p[2]);
  M(tx, p[0], zi);
  M(ty, p[1], zi);
  pack25519(r, ty);
  r[31] ^= par25519(tx) << 7;
}

function scalarmult(p, q, s) {
  var b, i;
  set25519(p[0], gf0);
  set25519(p[1], gf1);
  set25519(p[2], gf1);
  set25519(p[3], gf0);
  for (i = 255; i >= 0; --i) {
    b = (s[(i/8)|0] >> (i&7)) & 1;
    cswap(p, q, b);
    add(q, p);
    add(p, p);
    cswap(p, q, b);
  }
}

function scalarbase(p, s) {
  var q = [gf(), gf(), gf(), gf()];
  set25519(q[0], X);
  set25519(q[1], Y);
  set25519(q[2], gf1);
  M(q[3], X, Y);
  scalarmult(p, q, s);
}

function crypto_sign_keypair(pk, sk, seeded) {
  check(pk, sodium.crypto_sign_PUBLICKEYBYTES)
  check(sk, sodium.crypto_sign_SECRETKEYBYTES)

  var d = new Uint8Array(64);
  var p = [gf(), gf(), gf(), gf()];
  var i;

  if (!seeded) randombytes(sk, 32);
  crypto_hash(d, sk, 32);
  d[0] &= 248;
  d[31] &= 127;
  d[31] |= 64;

  scalarbase(p, d);
  pack(pk, p);

  for (i = 0; i < 32; i++) sk[i+32] = pk[i];
  return 0;
}

function crypto_sign_seed_keypair (pk, sk, seed) {
  check(seed, sodium.crypto_sign_SEEDBYTES)
  seed.copy(sk)
  crypto_sign_keypair(pk, sk, true)
}

var L = new Float64Array([0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]);

function modL(r, x) {
  var carry, i, j, k;
  for (i = 63; i >= 32; --i) {
    carry = 0;
    for (j = i - 32, k = i - 12; j < k; ++j) {
      x[j] += carry - 16 * x[i] * L[j - (i - 32)];
      carry = (x[j] + 128) >> 8;
      x[j] -= carry * 256;
    }
    x[j] += carry;
    x[i] = 0;
  }
  carry = 0;
  for (j = 0; j < 32; j++) {
    x[j] += carry - (x[31] >> 4) * L[j];
    carry = x[j] >> 8;
    x[j] &= 255;
  }
  for (j = 0; j < 32; j++) x[j] -= carry * L[j];
  for (i = 0; i < 32; i++) {
    x[i+1] += x[i] >> 8;
    r[i] = x[i] & 255;
  }
}

function reduce(r) {
  var x = new Float64Array(64), i;
  for (i = 0; i < 64; i++) x[i] = r[i];
  for (i = 0; i < 64; i++) r[i] = 0;
  modL(r, x);
}

// Note: difference from C - smlen returned, not passed as argument.
function crypto_sign(sm, m, sk) {
  check(sm, crypto_sign_BYTES + m.length)
  check(m, 0)
  check(sk, crypto_sign_SECRETKEYBYTES)
  var n = m.length

  var d = new Uint8Array(64), h = new Uint8Array(64), r = new Uint8Array(64);
  var i, j, x = new Float64Array(64);
  var p = [gf(), gf(), gf(), gf()];

  crypto_hash(d, sk, 32);
  d[0] &= 248;
  d[31] &= 127;
  d[31] |= 64;

  var smlen = n + 64;
  for (i = 0; i < n; i++) sm[64 + i] = m[i];
  for (i = 0; i < 32; i++) sm[32 + i] = d[32 + i];

  crypto_hash(r, sm.subarray(32), n+32);
  reduce(r);
  scalarbase(p, r);
  pack(sm, p);

  for (i = 32; i < 64; i++) sm[i] = sk[i];
  crypto_hash(h, sm, n + 64);
  reduce(h);

  for (i = 0; i < 64; i++) x[i] = 0;
  for (i = 0; i < 32; i++) x[i] = r[i];
  for (i = 0; i < 32; i++) {
    for (j = 0; j < 32; j++) {
      x[i+j] += h[i] * d[j];
    }
  }

  modL(sm.subarray(32), x);
}

function crypto_sign_detached(sig, m, sk) {
  var sm = new Uint8Array(m.length + crypto_sign_BYTES)
  crypto_sign(sm, m, sk)
  for (var i = 0; i < crypto_sign_BYTES; i++) sig[i] = sm[i]
}

function unpackneg(r, p) {
  var t = gf(), chk = gf(), num = gf(),
      den = gf(), den2 = gf(), den4 = gf(),
      den6 = gf();

  set25519(r[2], gf1);
  unpack25519(r[1], p);
  S(num, r[1]);
  M(den, num, D);
  Z(num, num, r[2]);
  A(den, r[2], den);

  S(den2, den);
  S(den4, den2);
  M(den6, den4, den2);
  M(t, den6, num);
  M(t, t, den);

  pow2523(t, t);
  M(t, t, num);
  M(t, t, den);
  M(t, t, den);
  M(r[0], t, den);

  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) M(r[0], r[0], I);

  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) return -1;

  if (par25519(r[0]) === (p[31]>>7)) Z(r[0], gf0, r[0]);

  M(r[3], r[0], r[1]);
  return 0;
}

function crypto_sign_open(msg, sm, pk) {
  check(msg, sm.length - crypto_sign_BYTES)
  check(sm, crypto_sign_BYTES)
  check(pk, crypto_sign_PUBLICKEYBYTES)
  var n = sm.length
  var m = new Uint8Array(sm.length)

  var i, mlen;
  var t = new Uint8Array(32), h = new Uint8Array(64);
  var p = [gf(), gf(), gf(), gf()],
      q = [gf(), gf(), gf(), gf()];

  mlen = -1;
  if (n < 64) return false;

  if (unpackneg(q, pk)) return false;

  for (i = 0; i < n; i++) m[i] = sm[i];
  for (i = 0; i < 32; i++) m[i+32] = pk[i];
  crypto_hash(h, m, n);
  reduce(h);
  scalarmult(p, q, h);

  scalarbase(q, sm.subarray(32));
  add(p, q);
  pack(t, p);

  n -= 64;
  if (crypto_verify_32(sm, 0, t, 0)) {
    for (i = 0; i < n; i++) m[i] = 0;
    return false;
  }

  for (i = 0; i < n; i++) msg[i] = sm[i + 64];
  mlen = n;
  return true;
}

function crypto_sign_verify_detached (sig, m, pk) {
  check(sig, crypto_sign_BYTES)
  var sm = new Uint8Array(m.length + crypto_sign_BYTES)
  var i = 0
  for (i = 0; i < crypto_sign_BYTES; i++) sm[i] = sig[i]
  for (i = 0; i < m.length; i++) sm[i + crypto_sign_BYTES] = m[i]
  return crypto_sign_open(m, sm, pk)
}

function crypto_secretbox_detached (o, mac, msg, n, k) {
  check(mac, sodium.crypto_secretbox_MACBYTES)
  var tmp = new Uint8Array(msg.length + mac.length)
  crypto_secretbox_easy(tmp, msg, n, k)
  o.set(tmp.subarray(0, msg.length))
  mac.set(tmp.subarray(msg.length))
}

function crypto_secretbox_open_detached (msg, o, mac, n, k) {
  check(mac, sodium.crypto_secretbox_MACBYTES)
  var tmp = new Uint8Array(o.length + mac.length)
  tmp.set(o)
  tmp.set(mac, msg.length)
  return crypto_secretbox_open_easy(msg, tmp, n, k)
}

function crypto_secretbox_easy(o, msg, n, k) {
  check(msg, 0)
  check(o, msg.length + sodium.crypto_secretbox_MACBYTES)
  check(n, crypto_secretbox_NONCEBYTES)
  check(k, crypto_secretbox_KEYBYTES)

  var i
  var m = new Uint8Array(crypto_secretbox_ZEROBYTES + msg.length);
  var c = new Uint8Array(m.length);
  for (i = 0; i < msg.length; i++) m[i+crypto_secretbox_ZEROBYTES] = msg[i];
  crypto_secretbox(c, m, m.length, n, k);
  for (i = crypto_secretbox_BOXZEROBYTES; i < c.length; i++) o[i - crypto_secretbox_BOXZEROBYTES] = c[i]
}

function crypto_secretbox_open_easy(msg, box, n, k) {
  check(box, sodium.crypto_secretbox_MACBYTES)
  check(msg, box.length - sodium.crypto_secretbox_MACBYTES)
  check(n, crypto_secretbox_NONCEBYTES)
  check(k, crypto_secretbox_KEYBYTES)

  var i
  var c = new Uint8Array(crypto_secretbox_BOXZEROBYTES + box.length);
  var m = new Uint8Array(c.length);
  for (i = 0; i < box.length; i++) c[i+crypto_secretbox_BOXZEROBYTES] = box[i];
  if (c.length < 32) return false;
  if (crypto_secretbox_open(m, c, c.length, n, k) !== 0) return false;

  for (i = crypto_secretbox_ZEROBYTES; i < m.length; i++) msg[i - crypto_secretbox_ZEROBYTES] = m[i]
  return true
}

var crypto_secretbox_KEYBYTES = 32,
    crypto_secretbox_NONCEBYTES = 24,
    crypto_secretbox_ZEROBYTES = 32,
    crypto_secretbox_BOXZEROBYTES = 16,
    crypto_scalarmult_BYTES = 32,
    crypto_scalarmult_SCALARBYTES = 32,
    crypto_box_PUBLICKEYBYTES = 32,
    crypto_box_SECRETKEYBYTES = 32,
    crypto_box_BEFORENMBYTES = 32,
    crypto_box_NONCEBYTES = crypto_secretbox_NONCEBYTES,
    crypto_box_ZEROBYTES = crypto_secretbox_ZEROBYTES,
    crypto_box_BOXZEROBYTES = crypto_secretbox_BOXZEROBYTES,
    crypto_sign_BYTES = 64,
    crypto_sign_PUBLICKEYBYTES = 32,
    crypto_sign_SECRETKEYBYTES = 64,
    crypto_sign_SEEDBYTES = 32,
    crypto_hash_BYTES = 64;

sodium.memzero = function (len, offset) {
  for (var i = offset; i < len; i++) arr[i] = 0;
}

sodium.crypto_sign_BYTES = crypto_sign_BYTES
sodium.crypto_sign_PUBLICKEYBYTES = crypto_sign_PUBLICKEYBYTES
sodium.crypto_sign_SECRETKEYBYTES = crypto_sign_SECRETKEYBYTES
sodium.crypto_sign_SEEDBYTES = crypto_sign_SEEDBYTES
sodium.crypto_sign_keypair = crypto_sign_keypair
sodium.crypto_sign_seed_keypair = crypto_sign_seed_keypair
sodium.crypto_sign = crypto_sign
sodium.crypto_sign_open = crypto_sign_open
sodium.crypto_sign_detached = crypto_sign_detached
sodium.crypto_sign_verify_detached = crypto_sign_verify_detached

forward(require('./crypto_generichash'))
forward(require('./crypto_kdf'))
forward(require('./crypto_shorthash'))
forward(require('./randombytes'))
forward(require('./crypto_stream'))

sodium.crypto_scalarmult_BYTES = crypto_scalarmult_BYTES
sodium.crypto_scalarmult_SCALARBYTES = crypto_scalarmult_SCALARBYTES
sodium.crypto_scalarmult_base = crypto_scalarmult_base
sodium.crypto_scalarmult = crypto_scalarmult

sodium.crypto_secretbox_KEYBYTES = crypto_secretbox_KEYBYTES,
sodium.crypto_secretbox_NONCEBYTES = crypto_secretbox_NONCEBYTES,
sodium.crypto_secretbox_MACBYTES = 16
sodium.crypto_secretbox_easy = crypto_secretbox_easy
sodium.crypto_secretbox_open_easy = crypto_secretbox_open_easy
sodium.crypto_secretbox_detached = crypto_secretbox_detached
sodium.crypto_secretbox_open_detached = crypto_secretbox_open_detached

function cleanup(arr) {
  for (var i = 0; i < arr.length; i++) arr[i] = 0;
}

function check (buf, len) {
  if (!buf || (len && buf.length < len)) throw new Error('Argument must be a buffer' + (len ? ' of length ' + len : ''))
}

function forward (submodule) {
  Object.keys(submodule).forEach(function (prop) {
    module.exports[prop] = submodule[prop]
  })
}

},{"./crypto_generichash":128,"./crypto_kdf":129,"./crypto_shorthash":130,"./crypto_stream":131,"./randombytes":133}],133:[function(require,module,exports){
(function (global){
var assert = require('nanoassert')
var randombytes = (function () {
  var QUOTA = 65536 // limit for QuotaExceededException
  var crypto = typeof global !== 'undefined' ? crypto = (global.crypto || global.msCrypto) : null

  function browserBytes (out, n) {
    for (var i = 0; i < n; i += QUOTA) {
      crypto.getRandomValues(out.subarray(i, i + Math.min(n - i, QUOTA)))
    }
  }

  function nodeBytes (out, n) {
    out.set(crypto.randomBytes(n))
  }

  function noImpl () {
    throw new Error('No secure random number generator available')
  }

  if (crypto && crypto.getRandomValues) {
    return browserBytes
  } else if (typeof require !== 'undefined') {
    // Node.js.
    crypto = require('crypto')
    if (crypto && crypto.randomBytes) {
      return nodeBytes
    }
  }

  return noImpl
})()

Object.defineProperty(module.exports, 'randombytes', {
  value: randombytes
})

module.exports.randombytes_buf = function (out) {
  assert(out, 'out must be given')
  randombytes(out, out.length)
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"crypto":26,"nanoassert":87}],134:[function(require,module,exports){
module.exports = require('sodium-javascript')

},{"sodium-javascript":132}],135:[function(require,module,exports){
module.exports = indexOf

function indexOf (left, right) {
  var result = new Array(right.length)
  var i = 0
  var j = 0

  while (i < left.length && j < right.length) {
    var a = left[i]
    var b = right[j]

    if (a === b) {
      result[j++] = i
      continue
    }

    if (a < b) {
      i++
      continue
    }

    result[j++] = -1
    continue
  }

  for (; j < right.length; j++) result[j] = -1

  return result
}

},{}],136:[function(require,module,exports){
(function (Buffer){
var pager = require('memory-pager')

module.exports = Bitfield

function Bitfield (opts) {
  if (!(this instanceof Bitfield)) return new Bitfield(opts)
  if (!opts) opts = {}
  if (Buffer.isBuffer(opts)) opts = {buffer: opts}

  this.pageOffset = opts.pageOffset || 0
  this.pageSize = opts.pageSize || 1024
  this.pages = opts.pages || pager(this.pageSize)

  this.byteLength = this.pages.length * this.pageSize
  this.length = 8 * this.byteLength

  if (!powerOfTwo(this.pageSize)) throw new Error('The page size should be a power of two')

  this._trackUpdates = !!opts.trackUpdates
  this._pageMask = this.pageSize - 1

  if (opts.buffer) {
    for (var i = 0; i < opts.buffer.length; i += this.pageSize) {
      this.pages.set(i / this.pageSize, opts.buffer.slice(i, i + this.pageSize))
    }
    this.byteLength = opts.buffer.length
    this.length = 8 * this.byteLength
  }
}

Bitfield.prototype.get = function (i) {
  var o = i & 7
  var j = (i - o) / 8

  return !!(this.getByte(j) & (128 >> o))
}

Bitfield.prototype.getByte = function (i) {
  var o = i & this._pageMask
  var j = (i - o) / this.pageSize
  var page = this.pages.get(j, true)

  return page ? page.buffer[o + this.pageOffset] : 0
}

Bitfield.prototype.set = function (i, v) {
  var o = i & 7
  var j = (i - o) / 8
  var b = this.getByte(j)

  return this.setByte(j, v ? b | (128 >> o) : b & (255 ^ (128 >> o)))
}

Bitfield.prototype.toBuffer = function () {
  var all = alloc(this.pages.length * this.pageSize)

  for (var i = 0; i < this.pages.length; i++) {
    var next = this.pages.get(i, true)
    var allOffset = i * this.pageSize
    if (next) next.buffer.copy(all, allOffset, this.pageOffset, this.pageOffset + this.pageSize)
  }

  return all
}

Bitfield.prototype.setByte = function (i, b) {
  var o = i & this._pageMask
  var j = (i - o) / this.pageSize
  var page = this.pages.get(j, false)

  o += this.pageOffset

  if (page.buffer[o] === b) return false
  page.buffer[o] = b

  if (i >= this.byteLength) {
    this.byteLength = i + 1
    this.length = this.byteLength * 8
  }

  if (this._trackUpdates) this.pages.updated(page)

  return true
}

function alloc (n) {
  if (Buffer.alloc) return Buffer.alloc(n)
  var b = new Buffer(n)
  b.fill(0)
  return b
}

function powerOfTwo (x) {
  return !(x & (x - 1))
}

}).call(this,require("buffer").Buffer)
},{"buffer":32,"memory-pager":80}],137:[function(require,module,exports){
var once = require('once')

module.exports = function(stream, cb) {
  if (!cb) return stream

  var list = []

  cb = once(cb)

  stream.on('data', function(data) {
    list.push(data)
  })

  stream.on('end', function() {
    cb(null, list)
  })

  stream.on('close', function() {
    cb(new Error('Premature close'))
  })

  stream.on('error', cb)

  return stream
}
},{"once":90}],138:[function(require,module,exports){
var eos = require('end-of-stream')
var shift = require('stream-shift')

module.exports = each

function each (stream, fn, cb) {
  var want = true
  var error = null
  var ended = false
  var running = false
  var calling = false

  stream.on('readable', onreadable)
  onreadable()

  if (cb) eos(stream, {readable: true, writable: false}, done)
  return stream

  function done (err) {
    if (!error) error = err
    ended = true
    if (!running) cb(error)
  }

  function onreadable () {
    if (want) read()
  }

  function afterRead (err) {
    running = false

    if (err) {
      error = err
      if (ended) return cb(error)
      stream.destroy(err)
      return
    }
    if (ended) return cb(error)
    if (!calling) read()
  }

  function read () {
    while (!running && !ended) {
      want = false

      var data = shift(stream)
      if (ended) return
      if (data === null) {
        want = true
        return
      }

      running = true
      calling = true
      fn(data, afterRead)
      calling = false
    }
  }
}

},{"end-of-stream":48,"stream-shift":139}],139:[function(require,module,exports){
module.exports = shift

function shift (stream) {
  var rs = stream._readableState
  if (!rs) return null
  return rs.objectMode ? stream.read() : stream.read(getStateLength(rs))
}

function getStateLength (state) {
  if (state.buffer.length) {
    // Since node 6.3.0 state.buffer is a BufferList not an array
    if (state.buffer.head) {
      return state.buffer.head.data.length
    }

    return state.buffer[0].length
  }

  return state.length
}

},{}],140:[function(require,module,exports){
/* global URL */

var getBlob = require('stream-to-blob')

module.exports = function getBlobURL (stream, mimeType, cb) {
  if (typeof mimeType === 'function') return getBlobURL(stream, null, mimeType)
  getBlob(stream, mimeType, function (err, blob) {
    if (err) return cb(err)
    var url = URL.createObjectURL(blob)
    cb(null, url)
  })
}

},{"stream-to-blob":141}],141:[function(require,module,exports){
/* global Blob */

var once = require('once')

module.exports = function getBlob (stream, mimeType, cb) {
  if (typeof mimeType === 'function') return getBlob(stream, null, mimeType)
  cb = once(cb)
  var chunks = []
  stream
    .on('data', function (chunk) {
      chunks.push(chunk)
    })
    .on('end', function () {
      var blob = mimeType
        ? new Blob(chunks, { type: mimeType })
        : new Blob(chunks)
      cb(null, blob)
    })
    .on('error', cb)
}

},{"once":90}],142:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

/*<replacement>*/

var Buffer = require('safe-buffer').Buffer;
/*</replacement>*/

var isEncoding = Buffer.isEncoding || function (encoding) {
  encoding = '' + encoding;
  switch (encoding && encoding.toLowerCase()) {
    case 'hex':case 'utf8':case 'utf-8':case 'ascii':case 'binary':case 'base64':case 'ucs2':case 'ucs-2':case 'utf16le':case 'utf-16le':case 'raw':
      return true;
    default:
      return false;
  }
};

function _normalizeEncoding(enc) {
  if (!enc) return 'utf8';
  var retried;
  while (true) {
    switch (enc) {
      case 'utf8':
      case 'utf-8':
        return 'utf8';
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return 'utf16le';
      case 'latin1':
      case 'binary':
        return 'latin1';
      case 'base64':
      case 'ascii':
      case 'hex':
        return enc;
      default:
        if (retried) return; // undefined
        enc = ('' + enc).toLowerCase();
        retried = true;
    }
  }
};

// Do not cache `Buffer.isEncoding` when checking encoding names as some
// modules monkey-patch it to support additional encodings
function normalizeEncoding(enc) {
  var nenc = _normalizeEncoding(enc);
  if (typeof nenc !== 'string' && (Buffer.isEncoding === isEncoding || !isEncoding(enc))) throw new Error('Unknown encoding: ' + enc);
  return nenc || enc;
}

// StringDecoder provides an interface for efficiently splitting a series of
// buffers into a series of JS strings without breaking apart multi-byte
// characters.
exports.StringDecoder = StringDecoder;
function StringDecoder(encoding) {
  this.encoding = normalizeEncoding(encoding);
  var nb;
  switch (this.encoding) {
    case 'utf16le':
      this.text = utf16Text;
      this.end = utf16End;
      nb = 4;
      break;
    case 'utf8':
      this.fillLast = utf8FillLast;
      nb = 4;
      break;
    case 'base64':
      this.text = base64Text;
      this.end = base64End;
      nb = 3;
      break;
    default:
      this.write = simpleWrite;
      this.end = simpleEnd;
      return;
  }
  this.lastNeed = 0;
  this.lastTotal = 0;
  this.lastChar = Buffer.allocUnsafe(nb);
}

StringDecoder.prototype.write = function (buf) {
  if (buf.length === 0) return '';
  var r;
  var i;
  if (this.lastNeed) {
    r = this.fillLast(buf);
    if (r === undefined) return '';
    i = this.lastNeed;
    this.lastNeed = 0;
  } else {
    i = 0;
  }
  if (i < buf.length) return r ? r + this.text(buf, i) : this.text(buf, i);
  return r || '';
};

StringDecoder.prototype.end = utf8End;

// Returns only complete characters in a Buffer
StringDecoder.prototype.text = utf8Text;

// Attempts to complete a partial non-UTF-8 character using bytes from a Buffer
StringDecoder.prototype.fillLast = function (buf) {
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
  this.lastNeed -= buf.length;
};

// Checks the type of a UTF-8 byte, whether it's ASCII, a leading byte, or a
// continuation byte. If an invalid byte is detected, -2 is returned.
function utf8CheckByte(byte) {
  if (byte <= 0x7F) return 0;else if (byte >> 5 === 0x06) return 2;else if (byte >> 4 === 0x0E) return 3;else if (byte >> 3 === 0x1E) return 4;
  return byte >> 6 === 0x02 ? -1 : -2;
}

// Checks at most 3 bytes at the end of a Buffer in order to detect an
// incomplete multi-byte UTF-8 character. The total number of bytes (2, 3, or 4)
// needed to complete the UTF-8 character (if applicable) are returned.
function utf8CheckIncomplete(self, buf, i) {
  var j = buf.length - 1;
  if (j < i) return 0;
  var nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 1;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 2;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) {
      if (nb === 2) nb = 0;else self.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
}

// Validates as many continuation bytes for a multi-byte UTF-8 character as
// needed or are available. If we see a non-continuation byte where we expect
// one, we "replace" the validated continuation bytes we've seen so far with
// a single UTF-8 replacement character ('\ufffd'), to match v8's UTF-8 decoding
// behavior. The continuation byte check is included three times in the case
// where all of the continuation bytes for a character exist in the same buffer.
// It is also done this way as a slight performance increase instead of using a
// loop.
function utf8CheckExtraBytes(self, buf, p) {
  if ((buf[0] & 0xC0) !== 0x80) {
    self.lastNeed = 0;
    return '\ufffd';
  }
  if (self.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 0xC0) !== 0x80) {
      self.lastNeed = 1;
      return '\ufffd';
    }
    if (self.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 0xC0) !== 0x80) {
        self.lastNeed = 2;
        return '\ufffd';
      }
    }
  }
}

// Attempts to complete a multi-byte UTF-8 character using bytes from a Buffer.
function utf8FillLast(buf) {
  var p = this.lastTotal - this.lastNeed;
  var r = utf8CheckExtraBytes(this, buf, p);
  if (r !== undefined) return r;
  if (this.lastNeed <= buf.length) {
    buf.copy(this.lastChar, p, 0, this.lastNeed);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  buf.copy(this.lastChar, p, 0, buf.length);
  this.lastNeed -= buf.length;
}

// Returns all complete UTF-8 characters in a Buffer. If the Buffer ended on a
// partial character, the character's bytes are buffered until the required
// number of bytes are available.
function utf8Text(buf, i) {
  var total = utf8CheckIncomplete(this, buf, i);
  if (!this.lastNeed) return buf.toString('utf8', i);
  this.lastTotal = total;
  var end = buf.length - (total - this.lastNeed);
  buf.copy(this.lastChar, 0, end);
  return buf.toString('utf8', i, end);
}

// For UTF-8, a replacement character is added when ending on a partial
// character.
function utf8End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) return r + '\ufffd';
  return r;
}

// UTF-16LE typically needs two bytes per character, but even if we have an even
// number of bytes available, we need to check if we end on a leading/high
// surrogate. In that case, we need to wait for the next two bytes in order to
// decode the last character properly.
function utf16Text(buf, i) {
  if ((buf.length - i) % 2 === 0) {
    var r = buf.toString('utf16le', i);
    if (r) {
      var c = r.charCodeAt(r.length - 1);
      if (c >= 0xD800 && c <= 0xDBFF) {
        this.lastNeed = 2;
        this.lastTotal = 4;
        this.lastChar[0] = buf[buf.length - 2];
        this.lastChar[1] = buf[buf.length - 1];
        return r.slice(0, -1);
      }
    }
    return r;
  }
  this.lastNeed = 1;
  this.lastTotal = 2;
  this.lastChar[0] = buf[buf.length - 1];
  return buf.toString('utf16le', i, buf.length - 1);
}

// For UTF-16LE we do not explicitly append special replacement characters if we
// end on a partial character, we simply let v8 handle that.
function utf16End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) {
    var end = this.lastTotal - this.lastNeed;
    return r + this.lastChar.toString('utf16le', 0, end);
  }
  return r;
}

function base64Text(buf, i) {
  var n = (buf.length - i) % 3;
  if (n === 0) return buf.toString('base64', i);
  this.lastNeed = 3 - n;
  this.lastTotal = 3;
  if (n === 1) {
    this.lastChar[0] = buf[buf.length - 1];
  } else {
    this.lastChar[0] = buf[buf.length - 2];
    this.lastChar[1] = buf[buf.length - 1];
  }
  return buf.toString('base64', i, buf.length - n);
}

function base64End(buf) {
  var r = buf && buf.length ? this.write(buf) : '';
  if (this.lastNeed) return r + this.lastChar.toString('base64', 0, 3 - this.lastNeed);
  return r;
}

// Pass bytes on through for single-byte encodings (e.g. ascii, latin1, hex)
function simpleWrite(buf) {
  return buf.toString(this.encoding);
}

function simpleEnd(buf) {
  return buf && buf.length ? this.write(buf) : '';
}
},{"safe-buffer":120}],143:[function(require,module,exports){
module.exports = function (instance, prefix) {
  return new SubSignalhub(instance, prefix)
}

class SubSignalhub {
  constructor(instance, prefix) {
    this._instance = instance
    this._prefix = prefix
    this.app = instance.app + this._prefix;
  }

  subscribe(channel) {
    return this._instance.subscribe(this._prefix + channel)
  }

  broadcast(channel, message, cb) {
    return this._instance.broadcast(this._prefix + channel, message, cb)
  }

  close (cb) {
    return this._instance.close(cb)
  }
}

},{}],144:[function(require,module,exports){
(function (process){
var Transform = require('readable-stream').Transform
  , inherits  = require('util').inherits
  , xtend     = require('xtend')

function DestroyableTransform(opts) {
  Transform.call(this, opts)
  this._destroyed = false
}

inherits(DestroyableTransform, Transform)

DestroyableTransform.prototype.destroy = function(err) {
  if (this._destroyed) return
  this._destroyed = true
  
  var self = this
  process.nextTick(function() {
    if (err)
      self.emit('error', err)
    self.emit('close')
  })
}

// a noop _transform function
function noop (chunk, enc, callback) {
  callback(null, chunk)
}


// create a new export function, used by both the main export and
// the .ctor export, contains common logic for dealing with arguments
function through2 (construct) {
  return function (options, transform, flush) {
    if (typeof options == 'function') {
      flush     = transform
      transform = options
      options   = {}
    }

    if (typeof transform != 'function')
      transform = noop

    if (typeof flush != 'function')
      flush = null

    return construct(options, transform, flush)
  }
}


// main export, just make me a transform stream!
module.exports = through2(function (options, transform, flush) {
  var t2 = new DestroyableTransform(options)

  t2._transform = transform

  if (flush)
    t2._flush = flush

  return t2
})


// make me a reusable prototype that I can `new`, or implicitly `new`
// with a constructor call
module.exports.ctor = through2(function (options, transform, flush) {
  function Through2 (override) {
    if (!(this instanceof Through2))
      return new Through2(override)

    this.options = xtend(options, override)

    DestroyableTransform.call(this, this.options)
  }

  inherits(Through2, DestroyableTransform)

  Through2.prototype._transform = transform

  if (flush)
    Through2.prototype._flush = flush

  return Through2
})


module.exports.obj = through2(function (options, transform, flush) {
  var t2 = new DestroyableTransform(xtend({ objectMode: true, highWaterMark: 16 }, options))

  t2._transform = transform

  if (flush)
    t2._flush = flush

  return t2
})

}).call(this,require('_process'))
},{"_process":94,"readable-stream":116,"util":151,"xtend":162}],145:[function(require,module,exports){
(function (setImmediate,clearImmediate){
var nextTick = require('process/browser.js').nextTick;
var apply = Function.prototype.apply;
var slice = Array.prototype.slice;
var immediateIds = {};
var nextImmediateId = 0;

// DOM APIs, for completeness

exports.setTimeout = function() {
  return new Timeout(apply.call(setTimeout, window, arguments), clearTimeout);
};
exports.setInterval = function() {
  return new Timeout(apply.call(setInterval, window, arguments), clearInterval);
};
exports.clearTimeout =
exports.clearInterval = function(timeout) { timeout.close(); };

function Timeout(id, clearFn) {
  this._id = id;
  this._clearFn = clearFn;
}
Timeout.prototype.unref = Timeout.prototype.ref = function() {};
Timeout.prototype.close = function() {
  this._clearFn.call(window, this._id);
};

// Does not start the time, just sets up the members needed.
exports.enroll = function(item, msecs) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = msecs;
};

exports.unenroll = function(item) {
  clearTimeout(item._idleTimeoutId);
  item._idleTimeout = -1;
};

exports._unrefActive = exports.active = function(item) {
  clearTimeout(item._idleTimeoutId);

  var msecs = item._idleTimeout;
  if (msecs >= 0) {
    item._idleTimeoutId = setTimeout(function onTimeout() {
      if (item._onTimeout)
        item._onTimeout();
    }, msecs);
  }
};

// That's not how node.js implements it but the exposed api is the same.
exports.setImmediate = typeof setImmediate === "function" ? setImmediate : function(fn) {
  var id = nextImmediateId++;
  var args = arguments.length < 2 ? false : slice.call(arguments, 1);

  immediateIds[id] = true;

  nextTick(function onNextTick() {
    if (immediateIds[id]) {
      // fn.call() is faster so we optimize for the common use-case
      // @see http://jsperf.com/call-apply-segu
      if (args) {
        fn.apply(null, args);
      } else {
        fn.call(null);
      }
      // Prevent ids from leaking
      exports.clearImmediate(id);
    }
  });

  return id;
};

exports.clearImmediate = typeof clearImmediate === "function" ? clearImmediate : function(id) {
  delete immediateIds[id];
};
}).call(this,require("timers").setImmediate,require("timers").clearImmediate)
},{"process/browser.js":94,"timers":145}],146:[function(require,module,exports){
var bufferAlloc = require('buffer-alloc')

var UINT_32_MAX = Math.pow(2, 32)

exports.encodingLength = function () {
  return 8
}

exports.encode = function (num, buf, offset) {
  if (!buf) buf = bufferAlloc(8)
  if (!offset) offset = 0

  var top = Math.floor(num / UINT_32_MAX)
  var rem = num - top * UINT_32_MAX

  buf.writeUInt32BE(top, offset)
  buf.writeUInt32BE(rem, offset + 4)
  return buf
}

exports.decode = function (buf, offset) {
  if (!offset) offset = 0

  var top = buf.readUInt32BE(offset)
  var rem = buf.readUInt32BE(offset + 4)

  return top * UINT_32_MAX + rem
}

exports.encode.bytes = 8
exports.decode.bytes = 8

},{"buffer-alloc":29}],147:[function(require,module,exports){
/*!
 * unixify <https://github.com/jonschlinkert/unixify>
 *
 * Copyright (c) 2014, 2017, Jon Schlinkert.
 * Released under the MIT License.
 */

'use strict';

var normalizePath = require('normalize-path');

module.exports = function unixify(filepath, stripTrailing) {
  filepath = normalizePath(filepath, stripTrailing);
  return filepath.replace(/^([a-zA-Z]+:|\.\/)/, '');
};

},{"normalize-path":89}],148:[function(require,module,exports){
module.exports = remove

function remove (arr, i) {
  if (i >= arr.length || i < 0) return
  var last = arr.pop()
  if (i < arr.length) {
    var tmp = arr[i]
    arr[i] = last
    return tmp
  }
  return last
}

},{}],149:[function(require,module,exports){
(function (global){

/**
 * Module exports.
 */

module.exports = deprecate;

/**
 * Mark that a method should not be used.
 * Returns a modified function which warns once by default.
 *
 * If `localStorage.noDeprecation = true` is set, then it is a no-op.
 *
 * If `localStorage.throwDeprecation = true` is set, then deprecated functions
 * will throw an Error when invoked.
 *
 * If `localStorage.traceDeprecation = true` is set, then deprecated functions
 * will invoke `console.trace()` instead of `console.error()`.
 *
 * @param {Function} fn - the function to deprecate
 * @param {String} msg - the string to print to the console when `fn` is invoked
 * @returns {Function} a new "deprecated" version of `fn`
 * @api public
 */

function deprecate (fn, msg) {
  if (config('noDeprecation')) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (config('throwDeprecation')) {
        throw new Error(msg);
      } else if (config('traceDeprecation')) {
        console.trace(msg);
      } else {
        console.warn(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
}

/**
 * Checks `localStorage` for boolean values for the given `name`.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api private
 */

function config (name) {
  // accessing global.localStorage can trigger a DOMException in sandboxed iframes
  try {
    if (!global.localStorage) return false;
  } catch (_) {
    return false;
  }
  var val = global.localStorage[name];
  if (null == val) return false;
  return String(val).toLowerCase() === 'true';
}

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{}],150:[function(require,module,exports){
arguments[4][14][0].apply(exports,arguments)
},{"dup":14}],151:[function(require,module,exports){
arguments[4][15][0].apply(exports,arguments)
},{"./support/isBuffer":150,"_process":94,"dup":15,"inherits":71}],152:[function(require,module,exports){
module.exports = read

var MSB = 0x80
  , REST = 0x7F

function read(buf, offset) {
  var res    = 0
    , offset = offset || 0
    , shift  = 0
    , counter = offset
    , b
    , l = buf.length

  do {
    if (counter >= l) {
      read.bytes = 0
      throw new RangeError('Could not decode varint')
    }
    b = buf[counter++]
    res += shift < 28
      ? (b & REST) << shift
      : (b & REST) * Math.pow(2, shift)
    shift += 7
  } while (b >= MSB)

  read.bytes = counter - offset

  return res
}

},{}],153:[function(require,module,exports){
arguments[4][20][0].apply(exports,arguments)
},{"dup":20}],154:[function(require,module,exports){
arguments[4][21][0].apply(exports,arguments)
},{"./decode.js":152,"./encode.js":153,"./length.js":155,"dup":21}],155:[function(require,module,exports){
arguments[4][22][0].apply(exports,arguments)
},{"dup":22}],156:[function(require,module,exports){
(function (process){
var SimplePeer = require('simple-peer')
var inherits = require('inherits')
var events = require('events')
var through = require('through2')
var cuid = require('cuid')
var once = require('once')
var debug = require('debug')('webrtc-swarm')

module.exports = WebRTCSwarm

function WebRTCSwarm (hub, opts) {
  if (!(this instanceof WebRTCSwarm)) return new WebRTCSwarm(hub, opts)
  if (!hub) throw new Error('SignalHub instance required')
  if (!opts) opts = {}

  events.EventEmitter.call(this)
  this.setMaxListeners(0)

  this.hub = hub
  this.wrtc = opts.wrtc
  this.channelConfig = opts.channelConfig
  this.config = opts.config
  this.stream = opts.stream
  this.wrap = opts.wrap || function (data) { return data }
  this.unwrap = opts.unwrap || function (data) { return data }
  this.offerConstraints = opts.offerConstraints || {}
  this.maxPeers = opts.maxPeers || Infinity
  this.me = opts.uuid || cuid()
  debug('my uuid:', this.me)

  this.remotes = {}
  this.peers = []
  this.closed = false

  subscribe(this, hub)
}

inherits(WebRTCSwarm, events.EventEmitter)

WebRTCSwarm.WEBRTC_SUPPORT = SimplePeer.WEBRTC_SUPPORT

WebRTCSwarm.prototype.close = function (cb) {
  if (this.closed) return
  this.closed = true

  if (cb) this.once('close', cb)

  var self = this
  this.hub.close(function () {
    var len = self.peers.length
    if (len > 0) {
      var closed = 0
      self.peers.forEach(function (peer) {
        peer.once('close', function () {
          if (++closed === len) {
            self.emit('close')
          }
        })
        process.nextTick(function () {
          peer.destroy()
        })
      })
    } else {
      self.emit('close')
    }
  })
}

function setup (swarm, peer, id) {
  peer.on('connect', function () {
    debug('connected to peer', id)
    swarm.peers.push(peer)
    swarm.emit('peer', peer, id)
    swarm.emit('connect', peer, id)
  })

  var onclose = once(function (err) {
    debug('disconnected from peer', id, err)
    if (swarm.remotes[id] === peer) delete swarm.remotes[id]
    var i = swarm.peers.indexOf(peer)
    if (i > -1) swarm.peers.splice(i, 1)
    swarm.emit('disconnect', peer, id)
  })

  var signals = []
  var sending = false

  function kick () {
    if (swarm.closed || sending || !signals.length) return
    sending = true
    var data = {from: swarm.me, signal: signals.shift()}
    data = swarm.wrap(data, id)
    swarm.hub.broadcast(id, data, function () {
      sending = false
      kick()
    })
  }

  peer.on('signal', function (sig) {
    signals.push(sig)
    kick()
  })

  peer.on('error', onclose)
  peer.once('close', onclose)
}

function subscribe (swarm, hub) {
  hub.subscribe('all').pipe(through.obj(function (data, enc, cb) {
    data = swarm.unwrap(data, 'all')
    if (swarm.closed || !data) return cb()

    debug('/all', data)
    if (data.from === swarm.me) {
      debug('skipping self', data.from)
      return cb()
    }

    if (data.type === 'connect') {
      if (swarm.peers.length >= swarm.maxPeers) {
        debug('skipping because maxPeers is met', data.from)
        return cb()
      }
      if (swarm.remotes[data.from]) {
        debug('skipping existing remote', data.from)
        return cb()
      }

      debug('connecting to new peer (as initiator)', data.from)
      var peer = new SimplePeer({
        wrtc: swarm.wrtc,
        initiator: true,
        channelConfig: swarm.channelConfig,
        config: swarm.config,
        stream: swarm.stream,
        offerConstraints: swarm.offerConstraints
      })

      setup(swarm, peer, data.from)
      swarm.remotes[data.from] = peer
    }

    cb()
  }))

  hub.subscribe(swarm.me).once('open', connect.bind(null, swarm, hub)).pipe(through.obj(function (data, enc, cb) {
    data = swarm.unwrap(data, swarm.me)
    if (swarm.closed || !data) return cb()

    var peer = swarm.remotes[data.from]
    if (!peer) {
      if (!data.signal || data.signal.type !== 'offer') {
        debug('skipping non-offer', data)
        return cb()
      }

      debug('connecting to new peer (as not initiator)', data.from)
      peer = swarm.remotes[data.from] = new SimplePeer({
        wrtc: swarm.wrtc,
        channelConfig: swarm.channelConfig,
        config: swarm.config,
        stream: swarm.stream,
        offerConstraints: swarm.offerConstraints
      })

      setup(swarm, peer, data.from)
    }

    debug('signalling', data.from, data.signal)
    peer.signal(data.signal)
    cb()
  }))
}

function connect (swarm, hub) {
  if (swarm.closed || swarm.peers.length >= swarm.maxPeers) return
  var data = {type: 'connect', from: swarm.me}
  data = swarm.wrap(data, 'all')
  hub.broadcast('all', data, function () {
    setTimeout(connect.bind(null, swarm, hub), Math.floor(Math.random() * 2000) + (swarm.peers.length ? 13000 : 3000))
  })
}

}).call(this,require('_process'))
},{"_process":94,"cuid":37,"debug":40,"events":27,"inherits":71,"once":90,"simple-peer":124,"through2":144}],157:[function(require,module,exports){
(function (process,global){
'use strict'

var Transform = require('readable-stream').Transform
var duplexify = require('duplexify')
var WS = require('ws')
var Buffer = require('safe-buffer').Buffer

module.exports = WebSocketStream

function buildProxy (options, socketWrite, socketEnd) {
  var proxy = new Transform({
    objectMode: options.objectMode
  })

  proxy._write = socketWrite
  proxy._flush = socketEnd

  return proxy
}

function WebSocketStream(target, protocols, options) {
  var stream, socket

  var isBrowser = process.title === 'browser'
  var isNative = !!global.WebSocket
  var socketWrite = isBrowser ? socketWriteBrowser : socketWriteNode

  if (protocols && !Array.isArray(protocols) && 'object' === typeof protocols) {
    // accept the "options" Object as the 2nd argument
    options = protocols
    protocols = null

    if (typeof options.protocol === 'string' || Array.isArray(options.protocol)) {
      protocols = options.protocol;
    }
  }

  if (!options) options = {}

  if (options.objectMode === undefined) {
    options.objectMode = !(options.binary === true || options.binary === undefined)
  }

  var proxy = buildProxy(options, socketWrite, socketEnd)

  if (!options.objectMode) {
    proxy._writev = writev
  }

  // browser only: sets the maximum socket buffer size before throttling
  var bufferSize = options.browserBufferSize || 1024 * 512

  // browser only: how long to wait when throttling
  var bufferTimeout = options.browserBufferTimeout || 1000

  // use existing WebSocket object that was passed in
  if (typeof target === 'object') {
    socket = target
  // otherwise make a new one
  } else {
    // special constructor treatment for native websockets in browsers, see
    // https://github.com/maxogden/websocket-stream/issues/82
    if (isNative && isBrowser) {
      socket = new WS(target, protocols)
    } else {
      socket = new WS(target, protocols, options)
    }

    socket.binaryType = 'arraybuffer'
  }

  // was already open when passed in
  if (socket.readyState === socket.OPEN) {
    stream = proxy
  } else {
    stream = stream = duplexify(undefined, undefined, options)
    if (!options.objectMode) {
      stream._writev = writev
    }
    socket.onopen = onopen
  }

  stream.socket = socket

  socket.onclose = onclose
  socket.onerror = onerror
  socket.onmessage = onmessage

  proxy.on('close', destroy)

  var coerceToBuffer = !options.objectMode

  function socketWriteNode(chunk, enc, next) {
    // avoid errors, this never happens unless
    // destroy() is called
    if (socket.readyState !== socket.OPEN) {
      next()
      return
    }

    if (coerceToBuffer && typeof chunk === 'string') {
      chunk = Buffer.from(chunk, 'utf8')
    }
    socket.send(chunk, next)
  }

  function socketWriteBrowser(chunk, enc, next) {
    if (socket.bufferedAmount > bufferSize) {
      setTimeout(socketWriteBrowser, bufferTimeout, chunk, enc, next)
      return
    }

    if (coerceToBuffer && typeof chunk === 'string') {
      chunk = Buffer.from(chunk, 'utf8')
    }

    try {
      socket.send(chunk)
    } catch(err) {
      return next(err)
    }

    next()
  }

  function socketEnd(done) {
    socket.close()
    done()
  }

  function onopen() {
    stream.setReadable(proxy)
    stream.setWritable(proxy)
    stream.emit('connect')
  }

  function onclose() {
    stream.end()
    stream.destroy()
  }

  function onerror(err) {
    stream.destroy(err)
  }

  function onmessage(event) {
    var data = event.data
    if (data instanceof ArrayBuffer) data = Buffer.from(data)
    else data = Buffer.from(data, 'utf8')
    proxy.push(data)
  }

  function destroy() {
    socket.close()
  }

  // this is to be enabled only if objectMode is false
  function writev (chunks, cb) {
    var buffers = new Array(chunks.length)
    for (var i = 0; i < chunks.length; i++) {
      if (typeof chunks[i].chunk === 'string') {
        buffers[i] = Buffer.from(chunks[i], 'utf8')
      } else {
        buffers[i] = chunks[i].chunk
      }
    }

    this._write(Buffer.concat(buffers), 'binary', cb)
  }

  return stream
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"_process":94,"duplexify":47,"readable-stream":116,"safe-buffer":120,"ws":158}],158:[function(require,module,exports){

var ws = null

if (typeof WebSocket !== 'undefined') {
  ws = WebSocket
} else if (typeof MozWebSocket !== 'undefined') {
  ws = MozWebSocket
} else if (typeof window !== 'undefined') {
  ws = window.WebSocket || window.MozWebSocket
}

module.exports = ws

},{}],159:[function(require,module,exports){
// Returns a wrapper function that returns a wrapped callback
// The wrapper function should do some stuff, and return a
// presumably different callback function.
// This makes sure that own properties are retained, so that
// decorations and such are not lost along the way.
module.exports = wrappy
function wrappy (fn, cb) {
  if (fn && cb) return wrappy(fn)(cb)

  if (typeof fn !== 'function')
    throw new TypeError('need wrapper function')

  Object.keys(fn).forEach(function (k) {
    wrapper[k] = fn[k]
  })

  return wrapper

  function wrapper() {
    var args = new Array(arguments.length)
    for (var i = 0; i < args.length; i++) {
      args[i] = arguments[i]
    }
    var ret = fn.apply(this, args)
    var cb = args[args.length-1]
    if (typeof ret === 'function' && ret !== cb) {
      Object.keys(cb).forEach(function (k) {
        ret[k] = cb[k]
      })
    }
    return ret
  }
}

},{}],160:[function(require,module,exports){
var xsalsa20 = require('./xsalsa20')()

var SIGMA = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107])
var head = 144
var top = head
var free = []

module.exports = XSalsa20

XSalsa20.NONCEBYTES = 24
XSalsa20.KEYBYTES = 32

function XSalsa20 (nonce, key) {
  if (!(this instanceof XSalsa20)) return new XSalsa20(nonce, key)
  if (!nonce || nonce.length < 24) throw new Error('nonce must be at least 24 bytes')
  if (!key || key.length < 32) throw new Error('key must be at least 32 bytes')
  this._xor = xsalsa20 && xsalsa20.exports ? new WASM(nonce, key) : new Fallback(nonce, key)
}

XSalsa20.prototype.update = function (input, output) {
  if (!input) throw new Error('input must be Uint8Array or Buffer')
  if (!output) output = new Uint8Array(input.length)
  if (input.length) this._xor.update(input, output)
  return output
}

XSalsa20.prototype.final =
XSalsa20.prototype.finalize = function () {
  this._xor.finalize()
  this._xor = null
}

function WASM (nonce, key) {
  if (!free.length) {
    free.push(head)
    head += 64
  }

  this._pointer = free.pop()
  this._nonce = this._pointer + 8
  this._key = this._nonce + 24
  this._overflow = 0

  xsalsa20.memory.fill(0, this._pointer, this._pointer + 8)
  xsalsa20.memory.set(nonce, this._nonce)
  xsalsa20.memory.set(key, this._key)
}

WASM.prototype.update = function (input, output) {
  var len = this._overflow + input.length
  var start = head + this._overflow

  top = head + len
  if (top >= xsalsa20.memory.length) xsalsa20.realloc(top)

  xsalsa20.memory.set(input, start)
  xsalsa20.exports.xsalsa20_xor(this._pointer, head, head, len, this._nonce, this._key)
  output.set(xsalsa20.memory.subarray(start, head + len))

  this._overflow = len & 63
}

WASM.prototype.finalize = function () {
  xsalsa20.memory.fill(0, this._pointer, this._key + 32)
  if (top > head) {
    xsalsa20.memory.fill(0, head, top)
    top = 0
  }
  free.push(this._pointer)
}

function Fallback (nonce, key) {
  this._s = new Uint8Array(32)
  this._z = new Uint8Array(16)
  this._overflow = 0
  core_hsalsa20(this._s, nonce, key, SIGMA)
  for (var i = 0; i < 8; i++) this._z[i] = nonce[i + 16]
}

Fallback.prototype.update = function (input, output) {
  var x = new Uint8Array(64)
  var u = 0
  var i = this._overflow
  var b = input.length + this._overflow
  var z = this._z
  var mpos = -this._overflow
  var cpos = -this._overflow

  while (b >= 64) {
    core_salsa20(x, z, this._s, SIGMA)
    for (; i < 64; i++) output[cpos + i] = input[mpos + i] ^ x[i]
    u = 1
    for (i = 8; i < 16; i++) {
      u += (z[i] & 0xff) | 0
      z[i] = u & 0xff
      u >>>= 8
    }
    b -= 64
    cpos += 64
    mpos += 64
    i = 0
  }
  if (b > 0) {
    core_salsa20(x, z, this._s, SIGMA)
    for (; i < b; i++) output[cpos + i] = input[mpos + i] ^ x[i]
  }

  this._overflow = b & 63
}

Fallback.prototype.finalize = function () {
  this._s.fill(0)
  this._z.fill(0)
}

// below methods are ported from tweet nacl

function core_salsa20(o, p, k, c) {
  var j0  = c[ 0] & 0xff | (c[ 1] & 0xff) << 8 | (c[ 2] & 0xff) << 16 | (c[ 3] & 0xff) << 24,
      j1  = k[ 0] & 0xff | (k[ 1] & 0xff) << 8 | (k[ 2] & 0xff) << 16 | (k[ 3] & 0xff) << 24,
      j2  = k[ 4] & 0xff | (k[ 5] & 0xff) << 8 | (k[ 6] & 0xff) << 16 | (k[ 7] & 0xff) << 24,
      j3  = k[ 8] & 0xff | (k[ 9] & 0xff) << 8 | (k[10] & 0xff) << 16 | (k[11] & 0xff) << 24,
      j4  = k[12] & 0xff | (k[13] & 0xff) << 8 | (k[14] & 0xff) << 16 | (k[15] & 0xff) << 24,
      j5  = c[ 4] & 0xff | (c[ 5] & 0xff) << 8 | (c[ 6] & 0xff) << 16 | (c[ 7] & 0xff) << 24,
      j6  = p[ 0] & 0xff | (p[ 1] & 0xff) << 8 | (p[ 2] & 0xff) << 16 | (p[ 3] & 0xff) << 24,
      j7  = p[ 4] & 0xff | (p[ 5] & 0xff) << 8 | (p[ 6] & 0xff) << 16 | (p[ 7] & 0xff) << 24,
      j8  = p[ 8] & 0xff | (p[ 9] & 0xff) << 8 | (p[10] & 0xff) << 16 | (p[11] & 0xff) << 24,
      j9  = p[12] & 0xff | (p[13] & 0xff) << 8 | (p[14] & 0xff) << 16 | (p[15] & 0xff) << 24,
      j10 = c[ 8] & 0xff | (c[ 9] & 0xff) << 8 | (c[10] & 0xff) << 16 | (c[11] & 0xff) << 24,
      j11 = k[16] & 0xff | (k[17] & 0xff) << 8 | (k[18] & 0xff) << 16 | (k[19] & 0xff) << 24,
      j12 = k[20] & 0xff | (k[21] & 0xff) << 8 | (k[22] & 0xff) << 16 | (k[23] & 0xff) << 24,
      j13 = k[24] & 0xff | (k[25] & 0xff) << 8 | (k[26] & 0xff) << 16 | (k[27] & 0xff) << 24,
      j14 = k[28] & 0xff | (k[29] & 0xff) << 8 | (k[30] & 0xff) << 16 | (k[31] & 0xff) << 24,
      j15 = c[12] & 0xff | (c[13] & 0xff) << 8 | (c[14] & 0xff) << 16 | (c[15] & 0xff) << 24

  var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7,
      x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14,
      x15 = j15, u

  for (var i = 0; i < 20; i += 2) {
    u = x0 + x12 | 0
    x4 ^= u << 7 | u >>> 25
    u = x4 + x0 | 0
    x8 ^= u << 9 | u >>> 23
    u = x8 + x4 | 0
    x12 ^= u << 13 | u >>> 19
    u = x12 + x8 | 0
    x0 ^= u << 18 | u >>> 14

    u = x5 + x1 | 0
    x9 ^= u << 7 | u >>> 25
    u = x9 + x5 | 0
    x13 ^= u << 9 | u >>> 23
    u = x13 + x9 | 0
    x1 ^= u << 13 | u >>> 19
    u = x1 + x13 | 0
    x5 ^= u << 18 | u >>> 14

    u = x10 + x6 | 0
    x14 ^= u << 7 | u >>> 25
    u = x14 + x10 | 0
    x2 ^= u << 9 | u >>> 23
    u = x2 + x14 | 0
    x6 ^= u << 13 | u >>> 19
    u = x6 + x2 | 0
    x10 ^= u << 18 | u >>> 14

    u = x15 + x11 | 0
    x3 ^= u << 7 | u >>> 25
    u = x3 + x15 | 0
    x7 ^= u << 9 | u >>> 23
    u = x7 + x3 | 0
    x11 ^= u << 13 | u >>> 19
    u = x11 + x7 | 0
    x15 ^= u << 18 | u >>> 14

    u = x0 + x3 | 0
    x1 ^= u << 7 | u >>> 25
    u = x1 + x0 | 0
    x2 ^= u << 9 | u >>> 23
    u = x2 + x1 | 0
    x3 ^= u << 13 | u >>> 19
    u = x3 + x2 | 0
    x0 ^= u << 18 | u >>> 14

    u = x5 + x4 | 0
    x6 ^= u << 7 | u >>> 25
    u = x6 + x5 | 0
    x7 ^= u << 9 | u >>> 23
    u = x7 + x6 | 0
    x4 ^= u << 13 | u >>> 19
    u = x4 + x7 | 0
    x5 ^= u << 18 | u >>> 14

    u = x10 + x9 | 0
    x11 ^= u << 7 | u >>> 25
    u = x11 + x10 | 0
    x8 ^= u << 9 | u >>> 23
    u = x8 + x11 | 0
    x9 ^= u << 13 | u >>> 19
    u = x9 + x8 | 0
    x10 ^= u << 18 | u >>> 14

    u = x15 + x14 | 0
    x12 ^= u << 7 | u >>> 25
    u = x12 + x15 | 0
    x13 ^= u << 9 | u >>> 23
    u = x13 + x12 | 0
    x14 ^= u << 13 | u >>> 19
    u = x14 + x13 | 0
    x15 ^= u << 18 | u >>> 14
  }
   x0 =  x0 +  j0 | 0
   x1 =  x1 +  j1 | 0
   x2 =  x2 +  j2 | 0
   x3 =  x3 +  j3 | 0
   x4 =  x4 +  j4 | 0
   x5 =  x5 +  j5 | 0
   x6 =  x6 +  j6 | 0
   x7 =  x7 +  j7 | 0
   x8 =  x8 +  j8 | 0
   x9 =  x9 +  j9 | 0
  x10 = x10 + j10 | 0
  x11 = x11 + j11 | 0
  x12 = x12 + j12 | 0
  x13 = x13 + j13 | 0
  x14 = x14 + j14 | 0
  x15 = x15 + j15 | 0

  o[ 0] = x0 >>>  0 & 0xff
  o[ 1] = x0 >>>  8 & 0xff
  o[ 2] = x0 >>> 16 & 0xff
  o[ 3] = x0 >>> 24 & 0xff

  o[ 4] = x1 >>>  0 & 0xff
  o[ 5] = x1 >>>  8 & 0xff
  o[ 6] = x1 >>> 16 & 0xff
  o[ 7] = x1 >>> 24 & 0xff

  o[ 8] = x2 >>>  0 & 0xff
  o[ 9] = x2 >>>  8 & 0xff
  o[10] = x2 >>> 16 & 0xff
  o[11] = x2 >>> 24 & 0xff

  o[12] = x3 >>>  0 & 0xff
  o[13] = x3 >>>  8 & 0xff
  o[14] = x3 >>> 16 & 0xff
  o[15] = x3 >>> 24 & 0xff

  o[16] = x4 >>>  0 & 0xff
  o[17] = x4 >>>  8 & 0xff
  o[18] = x4 >>> 16 & 0xff
  o[19] = x4 >>> 24 & 0xff

  o[20] = x5 >>>  0 & 0xff
  o[21] = x5 >>>  8 & 0xff
  o[22] = x5 >>> 16 & 0xff
  o[23] = x5 >>> 24 & 0xff

  o[24] = x6 >>>  0 & 0xff
  o[25] = x6 >>>  8 & 0xff
  o[26] = x6 >>> 16 & 0xff
  o[27] = x6 >>> 24 & 0xff

  o[28] = x7 >>>  0 & 0xff
  o[29] = x7 >>>  8 & 0xff
  o[30] = x7 >>> 16 & 0xff
  o[31] = x7 >>> 24 & 0xff

  o[32] = x8 >>>  0 & 0xff
  o[33] = x8 >>>  8 & 0xff
  o[34] = x8 >>> 16 & 0xff
  o[35] = x8 >>> 24 & 0xff

  o[36] = x9 >>>  0 & 0xff
  o[37] = x9 >>>  8 & 0xff
  o[38] = x9 >>> 16 & 0xff
  o[39] = x9 >>> 24 & 0xff

  o[40] = x10 >>>  0 & 0xff
  o[41] = x10 >>>  8 & 0xff
  o[42] = x10 >>> 16 & 0xff
  o[43] = x10 >>> 24 & 0xff

  o[44] = x11 >>>  0 & 0xff
  o[45] = x11 >>>  8 & 0xff
  o[46] = x11 >>> 16 & 0xff
  o[47] = x11 >>> 24 & 0xff

  o[48] = x12 >>>  0 & 0xff
  o[49] = x12 >>>  8 & 0xff
  o[50] = x12 >>> 16 & 0xff
  o[51] = x12 >>> 24 & 0xff

  o[52] = x13 >>>  0 & 0xff
  o[53] = x13 >>>  8 & 0xff
  o[54] = x13 >>> 16 & 0xff
  o[55] = x13 >>> 24 & 0xff

  o[56] = x14 >>>  0 & 0xff
  o[57] = x14 >>>  8 & 0xff
  o[58] = x14 >>> 16 & 0xff
  o[59] = x14 >>> 24 & 0xff

  o[60] = x15 >>>  0 & 0xff
  o[61] = x15 >>>  8 & 0xff
  o[62] = x15 >>> 16 & 0xff
  o[63] = x15 >>> 24 & 0xff
}

function core_hsalsa20(o,p,k,c) {
  var j0  = c[ 0] & 0xff | (c[ 1] & 0xff) << 8 | (c[ 2] & 0xff) << 16 | (c[ 3] & 0xff) << 24,
      j1  = k[ 0] & 0xff | (k[ 1] & 0xff) << 8 | (k[ 2] & 0xff) << 16 | (k[ 3] & 0xff) << 24,
      j2  = k[ 4] & 0xff | (k[ 5] & 0xff) << 8 | (k[ 6] & 0xff) << 16 | (k[ 7] & 0xff) << 24,
      j3  = k[ 8] & 0xff | (k[ 9] & 0xff) << 8 | (k[10] & 0xff) << 16 | (k[11] & 0xff) << 24,
      j4  = k[12] & 0xff | (k[13] & 0xff) << 8 | (k[14] & 0xff) << 16 | (k[15] & 0xff) << 24,
      j5  = c[ 4] & 0xff | (c[ 5] & 0xff) << 8 | (c[ 6] & 0xff) << 16 | (c[ 7] & 0xff) << 24,
      j6  = p[ 0] & 0xff | (p[ 1] & 0xff) << 8 | (p[ 2] & 0xff) << 16 | (p[ 3] & 0xff) << 24,
      j7  = p[ 4] & 0xff | (p[ 5] & 0xff) << 8 | (p[ 6] & 0xff) << 16 | (p[ 7] & 0xff) << 24,
      j8  = p[ 8] & 0xff | (p[ 9] & 0xff) << 8 | (p[10] & 0xff) << 16 | (p[11] & 0xff) << 24,
      j9  = p[12] & 0xff | (p[13] & 0xff) << 8 | (p[14] & 0xff) << 16 | (p[15] & 0xff) << 24,
      j10 = c[ 8] & 0xff | (c[ 9] & 0xff) << 8 | (c[10] & 0xff) << 16 | (c[11] & 0xff) << 24,
      j11 = k[16] & 0xff | (k[17] & 0xff) << 8 | (k[18] & 0xff) << 16 | (k[19] & 0xff) << 24,
      j12 = k[20] & 0xff | (k[21] & 0xff) << 8 | (k[22] & 0xff) << 16 | (k[23] & 0xff) << 24,
      j13 = k[24] & 0xff | (k[25] & 0xff) << 8 | (k[26] & 0xff) << 16 | (k[27] & 0xff) << 24,
      j14 = k[28] & 0xff | (k[29] & 0xff) << 8 | (k[30] & 0xff) << 16 | (k[31] & 0xff) << 24,
      j15 = c[12] & 0xff | (c[13] & 0xff) << 8 | (c[14] & 0xff) << 16 | (c[15] & 0xff) << 24

  var x0 = j0, x1 = j1, x2 = j2, x3 = j3, x4 = j4, x5 = j5, x6 = j6, x7 = j7,
      x8 = j8, x9 = j9, x10 = j10, x11 = j11, x12 = j12, x13 = j13, x14 = j14,
      x15 = j15, u

  for (var i = 0; i < 20; i += 2) {
    u = x0 + x12 | 0
    x4 ^= u << 7 | u >>> 25
    u = x4 + x0 | 0
    x8 ^= u << 9 | u >>> 23
    u = x8 + x4 | 0
    x12 ^= u << 13 | u >>> 19
    u = x12 + x8 | 0
    x0 ^= u << 18 | u >>> 14

    u = x5 + x1 | 0
    x9 ^= u << 7 | u >>> 25
    u = x9 + x5 | 0
    x13 ^= u << 9 | u >>> 23
    u = x13 + x9 | 0
    x1 ^= u << 13 | u >>> 19
    u = x1 + x13 | 0
    x5 ^= u << 18 | u >>> 14

    u = x10 + x6 | 0
    x14 ^= u << 7 | u >>> 25
    u = x14 + x10 | 0
    x2 ^= u << 9 | u >>> 23
    u = x2 + x14 | 0
    x6 ^= u << 13 | u >>> 19
    u = x6 + x2 | 0
    x10 ^= u << 18 | u >>> 14

    u = x15 + x11 | 0
    x3 ^= u << 7 | u >>> 25
    u = x3 + x15 | 0
    x7 ^= u << 9 | u >>> 23
    u = x7 + x3 | 0
    x11 ^= u << 13 | u >>> 19
    u = x11 + x7 | 0
    x15 ^= u << 18 | u >>> 14

    u = x0 + x3 | 0
    x1 ^= u << 7 | u >>> 25
    u = x1 + x0 | 0
    x2 ^= u << 9 | u >>> 23
    u = x2 + x1 | 0
    x3 ^= u << 13 | u >>> 19
    u = x3 + x2 | 0
    x0 ^= u << 18 | u >>> 14

    u = x5 + x4 | 0
    x6 ^= u << 7 | u >>> 25
    u = x6 + x5 | 0
    x7 ^= u << 9 | u >>> 23
    u = x7 + x6 | 0
    x4 ^= u << 13 | u >>> 19
    u = x4 + x7 | 0
    x5 ^= u << 18 | u >>> 14

    u = x10 + x9 | 0
    x11 ^= u << 7 | u >>> 25
    u = x11 + x10 | 0
    x8 ^= u << 9 | u >>> 23
    u = x8 + x11 | 0
    x9 ^= u << 13 | u >>> 19
    u = x9 + x8 | 0
    x10 ^= u << 18 | u >>> 14

    u = x15 + x14 | 0
    x12 ^= u << 7 | u >>> 25
    u = x12 + x15 | 0
    x13 ^= u << 9 | u >>> 23
    u = x13 + x12 | 0
    x14 ^= u << 13 | u >>> 19
    u = x14 + x13 | 0
    x15 ^= u << 18 | u >>> 14
  }

  o[ 0] = x0 >>>  0 & 0xff
  o[ 1] = x0 >>>  8 & 0xff
  o[ 2] = x0 >>> 16 & 0xff
  o[ 3] = x0 >>> 24 & 0xff

  o[ 4] = x5 >>>  0 & 0xff
  o[ 5] = x5 >>>  8 & 0xff
  o[ 6] = x5 >>> 16 & 0xff
  o[ 7] = x5 >>> 24 & 0xff

  o[ 8] = x10 >>>  0 & 0xff
  o[ 9] = x10 >>>  8 & 0xff
  o[10] = x10 >>> 16 & 0xff
  o[11] = x10 >>> 24 & 0xff

  o[12] = x15 >>>  0 & 0xff
  o[13] = x15 >>>  8 & 0xff
  o[14] = x15 >>> 16 & 0xff
  o[15] = x15 >>> 24 & 0xff

  o[16] = x6 >>>  0 & 0xff
  o[17] = x6 >>>  8 & 0xff
  o[18] = x6 >>> 16 & 0xff
  o[19] = x6 >>> 24 & 0xff

  o[20] = x7 >>>  0 & 0xff
  o[21] = x7 >>>  8 & 0xff
  o[22] = x7 >>> 16 & 0xff
  o[23] = x7 >>> 24 & 0xff

  o[24] = x8 >>>  0 & 0xff
  o[25] = x8 >>>  8 & 0xff
  o[26] = x8 >>> 16 & 0xff
  o[27] = x8 >>> 24 & 0xff

  o[28] = x9 >>>  0 & 0xff
  o[29] = x9 >>>  8 & 0xff
  o[30] = x9 >>> 16 & 0xff
  o[31] = x9 >>> 24 & 0xff
}

},{"./xsalsa20":161}],161:[function(require,module,exports){

module.exports = loadWebAssembly

loadWebAssembly.supported = typeof WebAssembly !== 'undefined'

function loadWebAssembly (opts) {
  if (!loadWebAssembly.supported) return null

  var imp = opts && opts.imports
  var wasm = toUint8Array('AGFzbQEAAAABGgNgBn9/f39/fwBgBn9/f39+fwF+YAN/f38AAwcGAAEBAgICBQUBAQroBwcoAwZtZW1vcnkCAAx4c2Fsc2EyMF94b3IAAAxjb3JlX3NhbHNhMjAABArqEQYYACAAIAEgAiADIAQgACkDACAFEAE3AwALPQBB8AAgAyAFEAMgACABIAIgA0EQaiAEQfAAEAJB8ABCADcDAEH4AEIANwMAQYABQgA3AwBBiAFCADcDAAuHBQEBfyACQQBGBEBCAA8LQdAAIAUpAwA3AwBB2AAgBUEIaikDADcDAEHgACAFQRBqKQMANwMAQegAIAVBGGopAwA3AwBBACADKQMANwMAQQggBDcDAAJAA0AgAkHAAEkNAUEQQQBB0AAQBSAAIAEpAwBBECkDAIU3AwAgAEEIaiABQQhqKQMAQRgpAwCFNwMAIABBEGogAUEQaikDAEEgKQMAhTcDACAAQRhqIAFBGGopAwBBKCkDAIU3AwAgAEEgaiABQSBqKQMAQTApAwCFNwMAIABBKGogAUEoaikDAEE4KQMAhTcDACAAQTBqIAFBMGopAwBBwAApAwCFNwMAIABBOGogAUE4aikDAEHIACkDAIU3AwBBCEEIKQMAQgF8NwMAIABBwABqIQAgAUHAAGohASACQcAAayECDAALC0EIKQMAIQQgAkEASwRAQRBBAEHQABAFAkACQAJAAkACQAJAAkACQCACQQhuDgcHBgUEAwIBAAsgAEE4aiABQThqKQMAQcgAKQMAhTcDAAsgAEEwaiABQTBqKQMAQcAAKQMAhTcDAAsgAEEoaiABQShqKQMAQTgpAwCFNwMACyAAQSBqIAFBIGopAwBBMCkDAIU3AwALIABBGGogAUEYaikDAEEoKQMAhTcDAAsgAEEQaiABQRBqKQMAQSApAwCFNwMACyAAQQhqIAFBCGopAwBBGCkDAIU3AwALIAAgASkDAEEQKQMAhTcDAAtBEEIANwMAQRhCADcDAEEgQgA3AwBBKEIANwMAQTBCADcDAEE4QgA3AwBBwABCADcDAEHIAEIANwMAQdAAQgA3AwBB2ABCADcDAEHgAEIANwMAQegAQgA3AwAgBA8LnQUBEX9B5fDBiwYhA0HuyIGZAyEIQbLaiMsHIQ1B9MqB2QYhEiACKAIAIQQgAkEEaigCACEFIAJBCGooAgAhBiACQQxqKAIAIQcgAkEQaigCACEOIAJBFGooAgAhDyACQRhqKAIAIRAgAkEcaigCACERIAEoAgAhCSABQQRqKAIAIQogAUEIaigCACELIAFBDGooAgAhDEEUIRMCQANAIBNBAEYNASAHIAMgD2pBB3dzIQcgCyAHIANqQQl3cyELIA8gCyAHakENd3MhDyADIA8gC2pBEndzIQMgDCAIIARqQQd3cyEMIBAgDCAIakEJd3MhECAEIBAgDGpBDXdzIQQgCCAEIBBqQRJ3cyEIIBEgDSAJakEHd3MhESAFIBEgDWpBCXdzIQUgCSAFIBFqQQ13cyEJIA0gCSAFakESd3MhDSAGIBIgDmpBB3dzIQYgCiAGIBJqQQl3cyEKIA4gCiAGakENd3MhDiASIA4gCmpBEndzIRIgBCADIAZqQQd3cyEEIAUgBCADakEJd3MhBSAGIAUgBGpBDXdzIQYgAyAGIAVqQRJ3cyEDIAkgCCAHakEHd3MhCSAKIAkgCGpBCXdzIQogByAKIAlqQQ13cyEHIAggByAKakESd3MhCCAOIA0gDGpBB3dzIQ4gCyAOIA1qQQl3cyELIAwgCyAOakENd3MhDCANIAwgC2pBEndzIQ0gDyASIBFqQQd3cyEPIBAgDyASakEJd3MhECARIBAgD2pBDXdzIREgEiARIBBqQRJ3cyESIBNBAmshEwwACwsgACADNgIAIABBBGogCDYCACAAQQhqIA02AgAgAEEMaiASNgIAIABBEGogCTYCACAAQRRqIAo2AgAgAEEYaiALNgIAIABBHGogDDYCAAsKACAAIAEgAhAFC90GASF/QeXwwYsGIQNB7siBmQMhCEGy2ojLByENQfTKgdkGIRIgAigCACEEIAJBBGooAgAhBSACQQhqKAIAIQYgAkEMaigCACEHIAJBEGooAgAhDiACQRRqKAIAIQ8gAkEYaigCACEQIAJBHGooAgAhESABKAIAIQkgAUEEaigCACEKIAFBCGooAgAhCyABQQxqKAIAIQwgAyETIAQhFCAFIRUgBiEWIAchFyAIIRggCSEZIAohGiALIRsgDCEcIA0hHSAOIR4gDyEfIBAhICARISEgEiEiQRQhIwJAA0AgI0EARg0BIAcgAyAPakEHd3MhByALIAcgA2pBCXdzIQsgDyALIAdqQQ13cyEPIAMgDyALakESd3MhAyAMIAggBGpBB3dzIQwgECAMIAhqQQl3cyEQIAQgECAMakENd3MhBCAIIAQgEGpBEndzIQggESANIAlqQQd3cyERIAUgESANakEJd3MhBSAJIAUgEWpBDXdzIQkgDSAJIAVqQRJ3cyENIAYgEiAOakEHd3MhBiAKIAYgEmpBCXdzIQogDiAKIAZqQQ13cyEOIBIgDiAKakESd3MhEiAEIAMgBmpBB3dzIQQgBSAEIANqQQl3cyEFIAYgBSAEakENd3MhBiADIAYgBWpBEndzIQMgCSAIIAdqQQd3cyEJIAogCSAIakEJd3MhCiAHIAogCWpBDXdzIQcgCCAHIApqQRJ3cyEIIA4gDSAMakEHd3MhDiALIA4gDWpBCXdzIQsgDCALIA5qQQ13cyEMIA0gDCALakESd3MhDSAPIBIgEWpBB3dzIQ8gECAPIBJqQQl3cyEQIBEgECAPakENd3MhESASIBEgEGpBEndzIRIgI0ECayEjDAALCyAAIAMgE2o2AgAgAEEEaiAEIBRqNgIAIABBCGogBSAVajYCACAAQQxqIAYgFmo2AgAgAEEQaiAHIBdqNgIAIABBFGogCCAYajYCACAAQRhqIAkgGWo2AgAgAEEcaiAKIBpqNgIAIABBIGogCyAbajYCACAAQSRqIAwgHGo2AgAgAEEoaiANIB1qNgIAIABBLGogDiAeajYCACAAQTBqIA8gH2o2AgAgAEE0aiAQICBqNgIAIABBOGogESAhajYCACAAQTxqIBIgImo2AgAL')
  var ready = null

  var mod = {
    buffer: wasm,
    memory: null,
    exports: null,
    realloc: realloc,
    onload: onload
  }

  onload(function () {})

  return mod

  function realloc (size) {
    mod.exports.memory.grow(Math.ceil(Math.abs(size - mod.memory.length) / 65536))
    mod.memory = new Uint8Array(mod.exports.memory.buffer)
  }

  function onload (cb) {
    if (mod.exports) return cb()

    if (ready) {
      ready.then(cb.bind(null, null)).catch(cb)
      return
    }

    try {
      if (opts && opts.async) throw new Error('async')
      setup({instance: new WebAssembly.Instance(new WebAssembly.Module(wasm), imp)})
    } catch (err) {
      ready = WebAssembly.instantiate(wasm, imp).then(setup)
    }

    onload(cb)
  }

  function setup (w) {
    mod.exports = w.instance.exports
    mod.memory = mod.exports.memory && mod.exports.memory.buffer && new Uint8Array(mod.exports.memory.buffer)
  }
}

function toUint8Array (s) {
  if (typeof atob === 'function') return new Uint8Array(atob(s).split('').map(charCodeAt))
  return new (require('buf' + 'fer').Buffer)(s, 'base64')
}

function charCodeAt (c) {
  return c.charCodeAt(0)
}

},{}],162:[function(require,module,exports){
module.exports = extend

var hasOwnProperty = Object.prototype.hasOwnProperty;

function extend() {
    var target = {}

    for (var i = 0; i < arguments.length; i++) {
        var source = arguments[i]

        for (var key in source) {
            if (hasOwnProperty.call(source, key)) {
                target[key] = source[key]
            }
        }
    }

    return target
}

},{}]},{},[4]);
