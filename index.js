const DAT_REGEX = /dat:\/\/([^/]+)\/?(.*)?/i

const injectStyle = `
<style>
body {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto",
    "Oxygen", "Ubuntu", "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji",
    "Segoe UI Emoji", "Segoe UI Symbol";
  background: #2ACA4B;
  color: #293648;
  font-size: larger;
}
a:visited {
  font-weight: bold;
}
a {
  color: #293648;
}
</style>
`

var db = randomAccessIdb('dats')

const dat = new datJs({
  db: db,
  gateway: 'wss://gateway.mauve.moe'
})

const url = new URL(window.location).searchParams.get('url')

console.log('Loading up', url)

if(!url) showInfo()
else loadContent(url)

function showInfo() {
  document.getElementById('loader').classList.add('hidden')
  document.getElementById("info").classList.remove('hidden')
}

function loadContent(url) {
  const repo = dat.get(url)

  const [_, key, path] = url.match(DAT_REGEX)

  repo.archive.ready(() => {
    console.log('ready')
      console.log('go!')
      renderContent(repo.archive, path || '')
  })
}

function renderContent(archive, path) {
	archive.stat(path || '/', (err, stat) => {
		if(stat.isFile()) {
			renderFile(archive, path)
		} else {
			renderFolder(archive, path)
		}
	})
}

function renderFolder(archive, path) {
	archive.readdir(path || '/', (err, files) => {
		console.log("Listing", files)
    const url = `dat://${archive.key.toString('hex')}/`
    const pathParts = path.split('/')
    pathParts.pop()
    const parent = pathParts.join('/')
    if(!path.endsWith('/')) path += '/'

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
	})
}

function renderFile (archive, path) {
  var mimeType = mimelite.getType(path)

  if (mimeType.match('image')) {
    getBlobURL(archive, path, mimeType, (err, blobURL) => {
      if (err) return setContent(err.message)
      setContent(`
        <title>${path.split('/').pop()}</title>
        ${injectStyle}
        <img src="${blobURL}" />
      `)
    })
  } else if (mimeType.match('video')) {
    getBlobURL(archive, path, mimeType, (err, blobURL) => {
      if (err) return setContent(err.message)
      setContent(`
        <title>${path.split('/').pop()}</title>
        ${injectStyle}
        <video controls>
          <source src="${blobURL}" type="${mimeType}">
        </video>
      `)
    })
  } else if (mimeType.match('html')) {
    getText(archive, path, (err, text) => {
      if (err) setContent(err.message)
      else setContent(text)
    })
  } else {
    getText(archive, path, (err, text) => {
      if (err) setContent(err.message)
      else {
        setContent(`
          <title>${path.split('/').pop()}</title>
          ${injectStyle}
          <main style="white-space: pre-wrap;">${text}</main>
        `)
      }
    })
  }
}

function setContent(content) {
  document.open()
  document.write(content)
  document.close()
}

function getText (archive, path, cb) {
  archive.readFile(path, 'utf-8', cb)
}

function getBlobURL (archive, path, mimeType, cb) {
  archive.readFile(path, (err, data) => {
    if (err) return cb(err)
    const blob = new Blob([data.buffer], { type: mimeType })
    console.log(blob)
    const url = URL.createObjectURL(blob)
    cb(null, url)
  })
}
