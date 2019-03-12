const DatJs = require('dat-js')
const randomAccessIdb = require('random-access-idb')
const mimelite = require('mime/lite')

const SourceRewriter = require('./SourceRewriter')

const DAT_REGEX = /dat:\/\/([^/]+)\/?([^#?]*)?/i
const REWRITE_DELAY = 1000

const injectStyle = `
<style>
${document.getElementById('transferrable-styles').innerHTML}
</style>
`
var db = randomAccessIdb('dats')

const dat = new DatJs({
  db: db,
  gateway: 'wss://gateway.mauve.moe'
})

module.exports = {
  loadContentToPage
}

async function loadContentToPage (url) {
  const { path } = parseDatURL(url)

  const archive = await getArchive(url)
  await renderContent(archive, path || '')
  startRewriting(url)
}

function startRewriting (url) {
  const rewriter = new SourceRewriter({
    delay: REWRITE_DELAY,
    loadDatURL: (toLoadURL) => {
      if (!toLoadURL.startsWith('dat://')) toLoadURL = resolveRelative(url, toLoadURL)

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

async function loadDatURL (url) {
  const archive = await getArchive(url)

  const { path } = parseDatURL(url)

  const found = await resolveFileInArchive(archive, path)

  var mimeType = mimelite.getType(path)

  return getBlobURL(archive, found.path, mimeType)
}

async function renderContent (archive, path) {
  const found = await resolveFileInArchive(archive, path || '/')

  if (found.type === 'file') {
    await renderFile(archive, found.path)
  } else if (found.type === 'folder') {
    await renderFolder(archive, found.path)
  }
}

async function renderFolder (archive, path) {
  const files = await getDirFiles(archive, path)

  const url = `dat://${archive.key.toString('hex')}/`
  const parent = getParentDir(path)
  if (!path.endsWith('/')) path += '/'

  setContent(`
    <title>${path.split('/').pop()}</title>
    ${injectStyle}
    <ul>
      <li>
        <a href="?url=${url}">/</a>
      </li>
      <li >
        <a href="?url=${url}${parent}">../</a>
      </li>
    ${files.map((file) => `
      <li>
        <a href="?url=${url}${path}${file}">./${file}</a>
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
      ${injectStyle}
      <img src="${blobURL}" />
    `)
  } else if (mimeType.match('video')) {
    const blobURL = await getBlobURL(archive, path, mimeType)
    setContent(`
      <title>${path.split('/').pop()}</title>
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
  let [, key, path] = url.match(DAT_REGEX)
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
  return pathParts.join('/') + '/'
}

function setContent (content) {
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

function getStat (archive, path) {
  return new Promise((resolve, reject) => {
    archive.stat(path, (err, stat) => {
      if (err) reject(err)
      else resolve(stat)
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

async function existsFile (archive, path) {
  try {
    const stat = await getStat(archive, path)
    return stat.isFile()
  } catch (e) {
    return false
  }
}

async function existsFolder (archive, path) {
  try {
    const stat = await getStat(archive, path)
    return stat.isDirectory()
  } catch (e) {
    return false
  }
}

async function getBlobURL (archive, path, mimeType) {
  return new Promise((resolve, reject) => {
    archive.readFile(path, (err, data) => {
      if (err) return reject(err)
      const Blob = window.Blob
      const blob = new Blob([data.buffer], { type: mimeType })
      const url = URL.createObjectURL(blob)
      resolve(url)
    })
  })
}

function getArchive (url) {
  return new Promise((resolve, reject) => {
    const repo = dat.get(url)

    repo.ready(() => {
      resolve(repo.archive)
    })
  })
}

// Based on algorythm used by hashbase and beaker
// https://github.com/beakerbrowser/hashbase/blob/master/lib/apis/archive-files.js#L80
async function resolveFileInArchive (archive, path) {
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

  let manifest = {}
  try {
    manifest = JSON.parse(await getText(archive, '/dat.json'))
  } catch (e) {
    // Oh well
  }

  const prefix = manifest.web_root || ''
  if (!path.startsWith('/')) path = `/${path}`

  for (let makePath of CHECK_PATHS) {
    const checkPath = makePath(prefix + path)
    if (await existsFile(archive, checkPath)) {
      return {
        path: checkPath,
        type: 'file'
      }
    }
  }

  if (await existsFolder(archive, prefix + path)) {
    return {
      path: prefix + path,
      type: 'folder'
    }
  }

  const fallback = manifest.fallback_page

  if (fallback) {
    if (await existsFile(archive, fallback)) {
      return {
        path: fallback,
        type: 'file'
      }
    }
    if (await existsFile(archive, prefix + fallback)) {
      return {
        path: prefix + fallback,
        type: 'file'
      }
    }
  }

  throw new Error('Not Found')
}

const CHECK_PATHS = [
  (path) => path,
  (path) => path + `index.html`,
  (path) => path + `index.md`,
  (path) => path + `/index.html`,
  (path) => path + `/index.md`,
  (path) => path + `.html`,
  (path) => path + `.md`
]
