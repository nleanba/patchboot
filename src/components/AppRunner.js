/* provides a web-component to execute a PatchBoot app. It is passed the app msg rather than the blob to support 
 * different app formats in future.
 */

import { default as pull, paraMap, collect } from 'pull-stream'
import MRPC from 'muxrpc'
import fetch from 'isomorphic-fetch'

class AppRunner extends HTMLElement {
  constructor() {
    super();
  }
  connectedCallback() {
    const runnerArea = this.attachShadow({ mode: 'open' })
    const iFrame = document.createElement('iframe')
    iFrame.style = "width: 100%; height: 100%; border: none;"
    const getBlob = (blobId) => {
      return new Promise((resolve, reject) => {
        this.sbot.blobs.want(blobId).then(() => {
          pull(
            this.sbot.blobs.get(blobId),
            pull.collect((err, values) => {
              if (err) reject(err)
              const code = values.join('')
              resolve(code)
            })
          )
        })
      })
    }
    const dereferenceUriOrSigil = (uriOrSigil) => {
      if (uriOrSigil.startsWith('&')) {
        return getBlob(uriOrSigil)
      } else {
        return fetch(uriOrSigil).then(response => response.text())
      }
    }
    const getFramecontent = () => {
        if (this.app.type === 'patchboot-app') {
          const blobId = this.app.link
          return dereferenceUriOrSigil(blobId).then(code => {
                function utf8_to_b64(str) {
                  return btoa(unescape(encodeURIComponent(str)));
                }
                return `
              <!DOCTYPE html>
              <html>
              <head>
              <title>Patchboot app</title>
              </head>
              <body>
    
                <div id="patchboot-app" style="padding-right: 8px; min-width: min-content;"></div>
    
                <script type="module">
                  import {default as ssbConnect, pull} from './scuttle-shell-browser-consumer.js'
                  ssbConnect().then(sbot => {
                    window.sbot = sbot
                    window.root = document.getElementById('patchboot-app')
                    window.pull = pull
                    window.root.innerHTML = ''
                    const script = document.createElement('script')
                    script.defer = true
                    script.src = 'data:text/javascript;base64,${utf8_to_b64(code)}'
                    document.head.append(script)
                  },
                  error => {
                    console.log('An error occured', error)
                  })
    
                </script>
    
              </body>
              </html>
              `
              })
        } else if (this.app.type === 'patchboot-app') {
          return dereferenceUriOrSigil(this.app.link)
        } else {
          throw new Error('unsupported: '+this.app.type)
        }
    }
    getFramecontent().then(iFrameContent => {
      this.dispatchEvent(new Event('loaded'))
      //console.log(iFrameContent)
      runnerArea.appendChild(iFrame)
      iFrame.contentWindow.document.open();
      iFrame.contentWindow.document.write(iFrameContent);
      iFrame.contentWindow.document.close();

      let messageDataCallback = null
      let messageDataBuffer = []

      const fromPage = function read(abort, cb) {
        if (messageDataBuffer.length > 0) {
          const data = messageDataBuffer[0]
          messageDataBuffer = messageDataBuffer.splice(1)
          cb(null, data)
        } else {
          messageDataCallback = cb
        }

      }

      function ping() {
        iFrame.contentWindow.postMessage({
          direction: "from-content-script",
          action: 'ping'
        }, '*');
      }

      iFrame.contentWindow.addEventListener("message", (event) => {
        if (event.data && event.data.direction === "from-page-script") {
          if (event.data.action === "ping") {
            ping()
          } else {
            //new Uint8Array(event.data.message) is not accepted by muxrpc
            const asBuffer = Buffer.from(event.data.message)
            if (messageDataCallback) {
              const _messageDataCallback = messageDataCallback
              messageDataCallback = null
              _messageDataCallback(null, asBuffer)
            } else {
              console.log('buffering....')
              messageDataBuffer.push(asBuffer)
            }
          }
        }
      })
      const toPage = function (source) {
        source(null, function more(end, data) {
          iFrame.contentWindow.postMessage({
            direction: "from-content-script",
            message: data
          }, '*');
          source(null, more)
        })
      }
      iFrame.contentWindow.addEventListener('load', () => this.dispatchEvent(new CustomEvent('ready')))
      /*function logger(text) {
        return pull.map((v) => {
          console.log(text,v)
          console.log(new TextDecoder("utf-8").decode(v))
          return v
        })
      }*/
      this.sbot.manifest().then(manifest => {
        //console.log('manifest', JSON.stringify(manifest))
        const asyncManifest = asyncifyManifest(manifest)
        const server = MRPC(null, asyncManifest)(this.sbot)
        const serverStream = server.createStream(() => { console.log('closed') })
        pull(fromPage, serverStream, toPage)
      })
    })
    
  }  
}

function asyncifyManifest(manifest) {
  if (typeof manifest !== 'object') return manifest
  let asyncified = {}
  for (let k in manifest) {
    var value = manifest[k]
    // Rewrite re-exported sync methods as async,
    if (value === 'sync') {
      value = 'async'
    }
    asyncified[k] = value
  }
  return asyncified
}

customElements.define("app-runner", AppRunner)