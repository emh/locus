# Locus

A small personal app for saving places from URLs, extracting place metadata, geocoding addresses, and browsing the saved places in list and map views.

## Local Development

Install dependencies:

```sh
npm install
```

Start the frontend and all local Workers:

```sh
npm run dev
```

The default local URLs are:

- Web app: `http://localhost:8020`
- Place Worker: `http://localhost:8797`
- Metadata Worker: `http://localhost:8798`
- Web Metadata Worker: `http://localhost:8800`
- Geocode Worker: `http://localhost:8799`

The frontend stores saved places in `localStorage` under `locus_v1`.

## Workers

- `workers/place/` is the public API Worker. It fetches the submitted page, extracts text and JSON-LD hints, asks the metadata Worker for place details, asks the geocode Worker for coordinates, and returns a normalized place object. It also exposes `/api/geocode` so manual address edits can be geocoded without making the geocode Worker public.
- `workers/metadata/` is the LLM-facing Worker. It extracts `name`, `address`, `city`, `country`, `type`, `description`, `tags`, optional coordinates, and relevance status. The OpenAI key belongs here only.
- `workers/metadata-web/` is an experimental LLM-facing Worker. It sends the submitted URL to an OpenAI model with the `web_search` tool and asks it to visit the URL, follow redirects, navigate further within the supplied website when useful, and return the same metadata shape. The place Worker uses it only for `/api/places/web` or requests with `metadataMode: "web"`.
- `workers/geocode/` is the Nominatim Worker. It geocodes a normalized place query and caches results at the Worker boundary.

Test the experimental path locally with:

```sh
curl -s http://localhost:8797/api/places/web \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.labattoir.ca/"}'
```

## Secrets

Do not put an OpenAI API key in localStorage or client-side code. Put it in the metadata Worker environment.

For local development, `workers/metadata/.dev.vars` is already present with `MOCK_LLM="true"` so the default app flow can run without OpenAI. To test real extraction locally, set these in `workers/metadata/.dev.vars`:

```sh
MOCK_LLM="false"
OPENAI_API_KEY="..."
OPENAI_MODEL="gpt-5.4-nano"
```

To test the experimental web-search metadata Worker locally, set these in `workers/metadata-web/.dev.vars`:

```sh
OPENAI_API_KEY="..."
OPENAI_MODEL="gpt-5"
OPENAI_REASONING_EFFORT="low"
```

For production, configure Cloudflare Worker secrets instead of committing them:

```sh
npx wrangler secret put OPENAI_API_KEY --config workers/metadata/wrangler.toml
npx wrangler secret put OPENAI_API_KEY --config workers/metadata-web/wrangler.toml
```

## Production

The frontend is static and can publish to GitHub Pages. Set the public place Worker URL in `app/config.js`:

```js
globalThis.LOCUS_CONFIG = {
  apiBaseUrl: "https://locus-place.YOUR_WORKERS_SUBDOMAIN.workers.dev"
};
```

The Worker deploy workflow lives at `.github/workflows/deploy-workers.yml`. Add these GitHub repository secrets before relying on it:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The workflow deploys `locus-metadata`, `locus-metadata-web`, `locus-geocode`, then `locus-place`, because the place Worker has service bindings to the other Workers.

You can also deploy manually:

```sh
npm run deploy:workers
```

## Prototype

`prototype.html` remains as the original visual and interaction reference.
