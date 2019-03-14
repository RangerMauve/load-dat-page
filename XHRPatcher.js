const IS_RELATIVE = /^\.\/|^\.\.\/|^\//

module.exports = class XMLPatcher {
  constructor(loadBuffer) {
    this._loadBuffer = loadBuffer
  }

  patch() {
    this._open = XMLHttpRequest.prototype.open
    this._send = XMLHttpRequest.prototype.send
    this._addEventListener = XMLHttpRequest.prototype.addEventListener
    this._fetch = window.fetch

    const loadBuffer = this._loadBuffer
    const _open = this._open
    const _send = this._send
    const _addEventListener = this._addEventListener
    const fetch = this._fetch

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__isDat = shouldInterceptURL(url)
      if(!__isDat) {
        return _open.apply(this, arguments)
      }
    }

    XMLHttpRequest.prototype.send = function () {
      if(!this.__isDat) return _send.apply(this, arguments)
      loadBuffer(this.__isDat).then((buffer) => {
        let response = null
        const { responseType } = this
        if(responseType === "arraybuffer") {
          response = buffer.buffer
        } else if (responseType === "blob") {

        } else if(responseType === "json") {
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
      if(name === 'load') this.__loadHandler = listener
      return _addEventListener.apply(this, arguments)
    }

    window.fetch = function (url) {
      const isDat = shouldInterceptURL(url)

      if(!isDat) return _fetch.apply(this, arguments)
      console.log('intercepting fetch', url)

      return loadBuffer(isDat).then((buffer) => {
        return new FakeResponse(buffer, url)
      })
    }
  }

  unpatch() {
    XMLHttpRequest.prototype.open = this._open
    XMLHttpRequest.prototype.send = this._send
    XMLHttpRequest.prototype.addEventListener = this._addEventListener
    window.fetch = this._fetch
  }
}

class FakeResponse {
  constructor(buffer, url) {
    this.body = new FakeBody(buffer)
    this.url = url
  }
  get headers() {
    return {}
  }
  get ok() {
    return true
  }
  get status() {
    return 200
  }
  get statusText() {
    return "OK"
  }
  get useFinalURL() {
    return true
  }
}

class FakeBody {
  constructor(buffer) {
    this._buffer = buffer
  }
  async arrayBuffer() {
    return this._buffer.buffer
  }
  async text() {
    return this.buffer.toString('utf-8')
  }
  async json() {
    return JSON.parse(await this.text())
  }
}

function shouldInterceptURL(url) {
  if(!(url.startsWith('http:') || url.startsWith('https:'))) {
    if(!url.match(IS_RELATIVE) && !url.startsWith('dat://')) {
      url = './' + url
    }
    return url
  } else return ''
}
