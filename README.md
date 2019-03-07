# load-date-page
Load a dat webpage in a regular browser using [dat-js](https://github.com/datproject/dat-js/).

[Try it out!](https://ranger.mauve.moe/load-dat-page/)

- Loads pages off the [Dat](https://datproject.org/) network
- Fully client-side single page application
- Use `?url=someurl` in the address bar to load a `dat://` URL
- Automatically rewrites links to `dat://` URLs to load through the page
- Detects images and loads them from Dat as `blob:` URLs

## Usage

Add in the dependencies:

```html
<script type="text/javascript" src="https://bundle.run/dat-js@7"></script>
<script type="text/javascript" src="https://wzrd.in/standalone/mime%2flite@latest"></script>
<script type="text/javascript" src="https://bundle.run/random-access-idb"></script>
```

```html
<script type="module">
import { loadContentToPage } from 'https://ranger.mauve.moe/load-dat-page/contentLoader.js'


const datprojectURL = 'dat://60c525b5589a5099aa3610a8ee550dcd454c3e118f7ac93b7d41b6b850272330/about'

// Load the current page, set up URL rewriting
loadContentToPage(datprojectURL)
</script>
```

## TODO:

- [ ] Intercept XMLHTTPRequest.prototype.open
  - [ ] Support arraybuffer responseType
- [ ] DatArchive API
- [ ] `experimental.datPeers` API
- [ ] Use streaming for resource rewriting
