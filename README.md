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
- Geocode Worker: `http://localhost:8799`

The frontend stores saved places in `localStorage` under `locus_v1`.

## Workers

- `workers/place/` is the public API Worker. It sends the submitted URL to an OpenAI model with structured output and the `web_search` tool, extracts `name`, `address`, `city`, `state`, `country`, a model-chosen `type`, `description`, `tags`, canonical URL, optional coordinates, and relevance status, then asks the geocode Worker for coordinates only when the model did not return usable lat/lng values. It also exposes `/api/geocode` so manual address edits can be geocoded without making the geocode Worker public.
- `workers/geocode/` is the Nominatim Worker. It geocodes a normalized place query and caches results at the Worker boundary.

Test the ingest path locally with:

```sh
curl -s http://localhost:8797/api/places \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.labattoir.ca/"}'
```

## Secrets

Do not put an OpenAI API key in localStorage or client-side code. Put it in the place Worker environment.

For local development, set `MOCK_LLM="true"` in `workers/place/.dev.vars` when you want the default app flow to run without OpenAI. To test real extraction locally, set these in `workers/place/.dev.vars`:

```sh
MOCK_LLM="false"
OPENAI_API_KEY="..."
OPENAI_MODEL="gpt-5"
OPENAI_REASONING_EFFORT="low"
```

For production, configure Cloudflare Worker secrets instead of committing them:

```sh
npx wrangler secret put OPENAI_API_KEY --config workers/place/wrangler.toml
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

The workflow deploys `locus-geocode`, then `locus-place`, because the place Worker has a service binding to the geocode Worker.

You can also deploy manually:

```sh
npm run deploy:workers
```

## Prototype

`prototype.html` remains as the original visual and interaction reference.
