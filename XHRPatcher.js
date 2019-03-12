module.exports = class XMLPatcher {
  constructor(loadBuffer) {
    this._loadBuffer = loadBuffer
  }

  patch() {
    this._open = XMLHttpRequest.prototype.open
    this._send = XMLHttpRequest.prototype.send
    this._addEventListener = XMLHttpRequest.prototype.addEventListener

    const loadBuffer = this._loadBuffer
    const _open = this._open
    const _send = this._send
    const _addEventListener = this._addEventListener

    XMLHttpRequest.prototype.open = function(method, url) {
      if(url.startsWith('dat://')) {
        this.__isDat = url
      } else {
        this.__isDat = null
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
        this.dispatchEvent(new CustomEvent('error', {}))
      })
    }

    XMLHttpRequest.prototype.addEventListener = function (name, listener) {
      if(name === 'load') this.__loadHandler = listener
      return _addEventListener.apply(this, arguments)
    }
  }

  unpatch() {
    XMLHttpRequest.prototype.open = this._open
    XMLHttpRequest.prototype.send = this._send
    XMLHttpRequest.prototype.addEventListener = this._addEventListener
  }
}
