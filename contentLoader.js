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
