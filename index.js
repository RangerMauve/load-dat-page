const { loadContentToPage } = require('./contentLoader')

const url = new URL(window.location).searchParams.get('url')

console.log('Loading up', url)

if (!url) showInfo()
else loadContentToPage(url)

function showInfo () {
  document.getElementById('loader').classList.add('hidden')
  document.getElementById('info').classList.remove('hidden')
}
