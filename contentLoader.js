const DatJs = require('dat-js')
const mimelite = require('mime/lite')
var toBlobURL = require('stream-to-blob-url')

const SourceRewriter = require('./SourceRewriter')
const XHRPatcher = require('./XHRPatcher')

const DAT_REGEX = /dat:\/\/([^/]+)\/?([^#?]*)?/i
const REWRITE_DELAY = 1000

const injectStyle = `
<style>
${document.getElementById('transferrable-styles').innerHTML}
</style>
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

function startPatching(url) {
  const patcher = new XHRPatcher((toLoadURL) => {
    if (!toLoadURL.startsWith('dat://')) toLoadURL = resolveRelative(url, toLoadURL)

    return loadDatBuffer(toLoadURL)
  })

  patcher.patch()
}

async function loadDatBuffer(url) {
  const archive = await getArchive(url)
  const { path } = parseDatURL(url)

  const found = await resolveFileInArchive(archive, path)

  return getFileBuffer(archive, found.path)
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

  console.log('resolved in archive', found)

  if (found.type === 'file') {
    await renderFile(archive, found.path)
  } else if (found.type === 'folder') {
    await renderFolder(archive, found.path)
  }
}

async function renderFolder (archive, path) {
  const files = await getDirFiles(archive, path)

  const url = `dat://${archive.key.toString('hex')}`
  const parent = getParentDir(path)
  if (!path.endsWith('/')) path += '/'
  if(!path.startsWith('/')) path = '/' + path

  console.log('Rendering files for', url, path, files)

  setContent(`
    <title>${path.split('/').pop()}</title>
    ${injectStyle}
    <ul>
      <li>
        <a href="?url=${url}">/</a>
      </li>
      <li >
        <a href="?url=${url}/${parent}">../</a>
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

async function getFileBuffer (archive, path) {
  return new Promise((resolve, reject) => {
    archive.stat(path, console.log.bind(console, 'Stat:', path))
    archive.readFile(path, (err, data) => {
      console.log('Read file', path, err, data)
      if (err) return reject(err)
      else resolve(data)
    })
  });
}

function asyncToBlobURL(stream, mimeType) {
  return new Promise((resolve, reject) => {
    toBlobURL(stream, mimeType, (err, url) => {
      if(err) reject(err)
      else resolve(url)
    })
  })
}

async function getBlobURL (archive, path, mimeType) {
  const stream = archive.createReadStream(path)
  console.log('Loading blob', path, mimeType)
  const url = await asyncToBlobURL(stream, mimeType)
  console.log('Loaded blob', path, mimeType)
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
