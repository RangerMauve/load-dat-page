const OBSERVATION_OPTIONS = {
  attributes: true,
  childList: true,
  subtree: true,
  attributeFilter: ['src', 'href']
}

export default class SourceRewriter {
  constructor ({ loadDatURL, makeLink, delay }) {
    this.delay = delay
    this.loadDatURL = loadDatURL
    this.makeLink = makeLink
    this.lastRewrote = 0
    this.observer = new window.MutationObserver(() => this.tryRewrite())
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

    console.log({ srcItems, anchorItems, linkItems })
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
