# load-dat-page
Load a dat webpage in a regular browser using [dat-js](https://github.com/datproject/dat-js/).

[Try it out!](https://ranger.mauve.moe/load-dat-page/)

- Loads pages off the [Dat](https://datproject.org/) network
- Fully client-side single page application
- Use `?url=someurl` in the address bar to load a `dat://` URL
- Automatically rewrites links to `dat://` URLs to load through the page
- Detects images and loads them from Dat as `blob:` URLs

## TODO:

- [x] Intercept `XMLHTTPRequest.prototype.open`
  - [ ] Intercept `fetch()``
  - [ ] Support arraybuffer responseType
- [ ] DatArchive API
- [ ] `experimental.datPeers` API
- [ ] Use streaming for resource rewriting
